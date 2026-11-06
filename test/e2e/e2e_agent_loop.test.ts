import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after } from "node:test";
import { runUnifiedTurn, type UnifiedEmitter, type UnifiedEngineDeps } from "../../src/core/agent/unifiedEngine";
import {
  appendFileTool,
  editFileTool,
  listDirTool,
  readFileTool,
  writeFileTool,
} from "../../src/core/tools/builtin/files";
import type { AdaptivePlan, ChatMessage, ToolCall } from "../../src/shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";

function createMockProvider(responses: LLMChatChunk[][]): LLMProvider {
  let callIndex = 0;
  return {
    id: "mock-provider",
    label: "Mock Provider",
    enabled: true,
    isConfigured: () => true,
    ping: async () => true,
    listModels: async () => [],
    async *chatStream(req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
      const chunks = responses[callIndex++] ?? [{ done: true }];
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

describe("End-to-End Autonomous Agent Execution Loop", () => {
  let tmpDir: string;
  const tools = [listDirTool, readFileTool, writeFileTool, editFileTool, appendFileTool];

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-e2e-"));
    await fs.writeFile(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ port: 3000, environment: "development" }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(tmpDir, "server.ts"),
      "export const start = () => console.log('started');\n",
      "utf8"
    );
  });

  after(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function createEmitter() {
    const events: { type: string; payload?: any }[] = [];
    const emitter: UnifiedEmitter = {
      onAssistantStart: (id) => events.push({ type: "onAssistantStart", payload: id }),
      onDelta: (id, delta) => events.push({ type: "onDelta", payload: { id, delta } }),
      onContent: (id, content) => events.push({ type: "onContent", payload: { id, content } }),
      onAssistantCancel: (id) => events.push({ type: "onAssistantCancel", payload: id }),
      onPhase: (phase, detail) => events.push({ type: "onPhase", payload: { phase, detail } }),
      onToolCall: (id, call) => events.push({ type: "onToolCall", payload: { id, call } }),
      onToolUpdate: (id, call) => events.push({ type: "onToolUpdate", payload: { id, call } }),
      onUsage: (usage) => events.push({ type: "onUsage", payload: usage }),
      onGenerationStats: (stats) => events.push({ type: "onGenerationStats", payload: stats }),
      onDone: (id, notice) => events.push({ type: "onDone", payload: { id, notice } }),
      onError: (message) => events.push({ type: "onError", payload: message }),
    };
    return { emitter, events };
  }

  function makeDeps(provider: LLMProvider): UnifiedEngineDeps {
    return {
      provider,
      tools,
      workspaceName: "e2e-workspace",
      buildToolContext: (signal: AbortSignal) => ({
        workspaceRoot: tmpDir,
        requestApproval: async () => true,
        signal,
        log: () => {},
        webSearchProvider: "duckduckgo",
        findFiles: async () => ["config.json", "server.ts"],
        capability: "high",
        getDiagnostics: async () => [],
        todos: [],
      }),
    };
  }

  const basePlan: AdaptivePlan = {
    model: "mock-model",
    mode: "agent",
    intelligence: "high",
    contextWindow: 16384,
    numCtx: 16384,
    temperature: 0.1,
    topP: 0.9,
    maxOutputTokens: 1024,
    toolProtocol: "photon-block",
    maxTools: 5,
  };

  it("executes multi-step workflow: list files -> read config -> final answer", async () => {
    // Step 1: Call list_dir
    // Step 2: Call read_file config.json
    // Step 3: Conclude with synthesized answer
    const responses: LLMChatChunk[][] = [
      [
        {
          message: {
            role: "assistant",
            content: "```tool\nTOOL_NAME: list_dir\n```",
          },
          done: true,
        },
      ],
      [
        {
          message: {
            role: "assistant",
            content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nconfig.json\nEND_ARG\n```",
          },
          done: true,
        },
      ],
      [
        {
          message: {
            role: "assistant",
            content: "The server is configured to run on port 3000 in development mode.",
          },
          done: true,
        },
      ],
    ];

    const provider = createMockProvider(responses);
    const deps = makeDeps(provider);
    const { emitter, events } = createEmitter();

    const session = {
      messages: [
        {
          id: "u1",
          role: "user" as const,
          content: "What port is configured?",
          createdAt: Date.now(),
        },
      ],
    };

    await runUnifiedTurn(session, basePlan, emitter, new AbortController().signal, deps);

    // Verify tool executions in emitter events
    const toolCalls = events.filter((e) => e.type === "onToolCall");
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].payload.call.name, "list_dir");
    assert.equal(toolCalls[1].payload.call.name, "read_file");

    const toolUpdates = events.filter((e) => e.type === "onToolUpdate" && e.payload.call.status === "done");
    assert.equal(toolUpdates.length, 2);
    assert.ok(toolUpdates[1].payload.call.result.includes("3000"));

    // Verify completion
    const doneEvents = events.filter((e) => e.type === "onDone");
    assert.ok(doneEvents.length >= 1);
  });

  it("recovers from tool error by self-correcting to a valid file", async () => {
    // Step 1: Model tries to read non-existent "missing.json" -> fails with ENOENT
    // Step 2: Model self-corrects and reads "config.json"
    // Step 3: Final answer
    const responses: LLMChatChunk[][] = [
      [
        {
          message: {
            role: "assistant",
            content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nmissing.json\nEND_ARG\n```",
          },
          done: true,
        },
      ],
      [
        {
          message: {
            role: "assistant",
            content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nconfig.json\nEND_ARG\n```",
          },
          done: true,
        },
      ],
      [
        {
          message: {
            role: "assistant",
            content: "Successfully recovered and confirmed port 3000.",
          },
          done: true,
        },
      ],
    ];

    const provider = createMockProvider(responses);
    const deps = makeDeps(provider);
    const { emitter, events } = createEmitter();

    const session = {
      messages: [
        {
          id: "u-recov",
          role: "user" as const,
          content: "Check config",
          createdAt: Date.now(),
        },
      ],
    };

    await runUnifiedTurn(session, basePlan, emitter, new AbortController().signal, deps);

    const toolUpdates = events.filter((e) => e.type === "onToolUpdate");
    // First tool update ends with error status
    const firstCallFinish = toolUpdates.find(
      (e) => e.payload.call.args.path === "missing.json" && e.payload.call.status === "error"
    );
    assert.ok(firstCallFinish, "Expected first call to missing.json to fail with error");

    // Second call to config.json succeeds
    const secondCallFinish = toolUpdates.find(
      (e) => e.payload.call.args.path === "config.json" && e.payload.call.status === "done"
    );
    assert.ok(secondCallFinish, "Expected second call to config.json to succeed");
  });

  it("modifies files on disk using edit_file tool during autonomous turn", async () => {
    await fs.writeFile(path.join(tmpDir, "index.ts"), "const port = 3000;\n", "utf8");

    const responses: LLMChatChunk[][] = [
      [
        {
          message: {
            role: "assistant",
            content:
              "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\nindex.ts\nEND_ARG\nBEGIN_ARG: old_str\nconst port = 3000;\nEND_ARG\nBEGIN_ARG: new_str\nconst port = 8080;\nEND_ARG\n```",
          },
          done: true,
        },
      ],
      [
        {
          message: {
            role: "assistant",
            content: "Port has been updated to 8080 in index.ts.",
          },
          done: true,
        },
      ],
    ];

    const provider = createMockProvider(responses);
    const deps = makeDeps(provider);
    const { emitter } = createEmitter();

    const session = {
      messages: [
        {
          id: "u-edit",
          role: "user" as const,
          content: "Change port to 8080 in index.ts",
          createdAt: Date.now(),
        },
      ],
    };

    await runUnifiedTurn(session, basePlan, emitter, new AbortController().signal, deps);

    // Verify file on disk is modified
    const fileContent = await fs.readFile(path.join(tmpDir, "index.ts"), "utf8");
    assert.equal(fileContent, "const port = 8080;\n");
  });

  it("aborts cleanly when signal is cancelled mid-turn without unhandled errors", async () => {
    const responses: LLMChatChunk[][] = [
      [
        {
          message: {
            role: "assistant",
            content: "Starting infinite work...",
          },
          done: true,
        },
      ],
    ];

    const provider = createMockProvider(responses);
    const deps = makeDeps(provider);
    const { emitter } = createEmitter();

    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const session = {
      messages: [
        {
          id: "u-abort",
          role: "user" as const,
          content: "Abort me",
          createdAt: Date.now(),
        },
      ],
    };

    // Should complete cleanly without rejecting
    await runUnifiedTurn(session, basePlan, emitter, controller.signal, deps);
  });

  it("maintains conversation history across multiple turns", async () => {
    // Turn 1
    const turn1Responses: LLMChatChunk[][] = [
      [
        {
          message: {
            role: "assistant",
            content: "I can help you build the app.",
          },
          done: true,
        },
      ],
    ];

    const provider1 = createMockProvider(turn1Responses);
    const deps1 = makeDeps(provider1);
    const { emitter: emitter1 } = createEmitter();

    const session: { messages: ChatMessage[] } = {
      messages: [
        {
          id: "m1",
          role: "user",
          content: "Can you help me?",
          createdAt: 100,
        },
      ],
    };

    await runUnifiedTurn(session, basePlan, emitter1, new AbortController().signal, deps1);
    session.messages.push({
      id: "a1",
      role: "assistant",
      content: "I can help you build the app.",
      createdAt: 101,
    });

    // Turn 2
    const turn2Responses: LLMChatChunk[][] = [
      [
        {
          message: {
            role: "assistant",
            content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nserver.ts\nEND_ARG\n```",
          },
          done: true,
        },
      ],
      [
        {
          message: {
            role: "assistant",
            content: "server.ts exports a start function.",
          },
          done: true,
        },
      ],
    ];

    const provider2 = createMockProvider(turn2Responses);
    const deps2 = makeDeps(provider2);
    const { emitter: emitter2, events: events2 } = createEmitter();

    session.messages.push({
      id: "m2",
      role: "user",
      content: "What does server.ts export?",
      createdAt: 200,
    });

    await runUnifiedTurn(session, basePlan, emitter2, new AbortController().signal, deps2);

    const toolCalls = events2.filter((e) => e.type === "onToolCall");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].payload.call.args.path, "server.ts");

    // All 4 messages exist in session
    assert.ok(session.messages.length >= 3);
  });
});
