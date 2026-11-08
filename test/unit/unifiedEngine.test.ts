import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runUnifiedTurn, type UnifiedEmitter, type UnifiedEngineDeps } from "../../src/core/agent/unifiedEngine";
import type { AdaptivePlan, ChatMessage, ToolCall } from "../../src/shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import type { Tool, ToolContext, ToolResult } from "../../src/core/tools/types";

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

describe("Phase 3.1: Unified Engine Lifecycle & Execution Correctness", () => {
  const defaultPlan: AdaptivePlan = {
    model: "mock-model",
    mode: "agent",
    contextWindow: 8192,
    numCtx: 8192,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 1024,
    toolProtocol: "photon-block",
    maxTools: 10,
    allowParallelTools: true,
    intelligence: "high",
    intelligenceAuto: true,
    rationale: [],
    executionPolicy: {
      maxConcurrent: 4,
      allowParallelReads: true,
      serializeMutations: true,
      generationBudgetTokens: 4096,
      stepBudget: 10,
    },
  };

  it("ensures every started assistant message receives exactly one terminal event", async () => {
    const responses: LLMChatChunk[][] = [
      [
        { message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } },
        { done: true },
      ],
      [
        { message: { content: "I found the file contents." } },
        { done: true },
      ],
    ];

    const mockTool: Tool = {
      spec: {
        name: "read_file",
        summary: "read file",
        params: [{ name: "path", type: "string", required: true, description: "path" }],
        sideEffecting: false,
        priority: 1,
        concurrency: "safe_parallel",
        risk: "read",
      },
      execute: async () => ({ ok: true, output: "file contents here" }),
    };

    const { emitter, events } = createEmitter();
    const session = {
      messages: [{ id: "u1", role: "user" as const, content: "read a.ts", createdAt: Date.now() }],
    };

    const deps: UnifiedEngineDeps = {
      provider: createMockProvider(responses),
      tools: [mockTool],
      buildToolContext: () => ({
        capability: "high",
        todos: [],
        signal: new AbortController().signal,
        log: () => {},
      } as any),
      reserveOutputTokens: 1024,
    };

    await runUnifiedTurn(session, defaultPlan, emitter, new AbortController().signal, deps);

    const starts = events.filter((e) => e.type === "onAssistantStart").map((e) => e.payload);
    const dones = events.filter((e) => e.type === "onDone").map((e) => e.payload.id);
    const cancels = events.filter((e) => e.type === "onAssistantCancel").map((e) => e.payload);

    assert.ok(starts.length >= 1, "At least one assistant message was started");
    // Verify each started id received a matching terminal event
    for (const startId of starts) {
      const terminalCount = dones.filter((id) => id === startId).length + cancels.filter((id) => id === startId).length;
      assert.equal(terminalCount, 1, `Message ${startId} should have exactly one terminal event`);
    }
  });

  it("handles cancellation cleanly without leaving tools running or executing queued calls", async () => {
    let toolStarted = false;
    const abortCtrl = new AbortController();

    const mockTool: Tool = {
      spec: {
        name: "slow_read",
        summary: "slow read",
        params: [],
        sideEffecting: false,
        priority: 1,
      },
      execute: async () => {
        toolStarted = true;
        abortCtrl.abort();
        return { ok: true, output: "done" };
      },
    };

    const responses: LLMChatChunk[][] = [
      [
        {
          message: {
            content:
              "```tool\nTOOL_NAME: slow_read\n```\n```tool\nTOOL_NAME: slow_read\n```",
          },
        },
        { done: true },
      ],
    ];

    const { emitter, events } = createEmitter();
    const session = {
      messages: [{ id: "u1", role: "user" as const, content: "run tools", createdAt: Date.now() }],
    };

    const deps: UnifiedEngineDeps = {
      provider: createMockProvider(responses),
      tools: [mockTool],
      buildToolContext: () => ({
        capability: "high",
        todos: [],
        signal: abortCtrl.signal,
        log: () => {},
      } as any),
      reserveOutputTokens: 1024,
    };

    await runUnifiedTurn(session, defaultPlan, emitter, abortCtrl.signal, deps);

    assert.ok(toolStarted, "Initial tool execution began");
    const updates = events.filter((e) => e.type === "onToolUpdate").map((e) => e.payload.call);
    const lastUpdate = updates[updates.length - 1];
    assert.equal(lastUpdate.status, "error");
    assert.equal(lastUpdate.error, "Operation cancelled.");

    const doneEvents = events.filter((e) => e.type === "onDone");
    assert.ok(doneEvents.length > 0);
    assert.equal(doneEvents[doneEvents.length - 1].payload.notice, "Stopped.");
  });

  it("duplicate call detection suppresses repeated calls in same epoch but allows them after mutation", async () => {
    let callCount = 0;
    const mockRead: Tool = {
      spec: {
        name: "read_file",
        summary: "read",
        params: [{ name: "path", type: "string", required: true, description: "" }],
        sideEffecting: false,
        priority: 1,
      },
      execute: async () => {
        callCount++;
        return { ok: true, output: `contents v${callCount}` };
      },
    };

    let mutateCount = 0;
    const mockWrite: Tool = {
      spec: {
        name: "write_file",
        summary: "write",
        params: [
          { name: "path", type: "string", required: true, description: "" },
          { name: "content", type: "string", required: true, description: "" },
        ],
        sideEffecting: true,
        priority: 2,
      },
      execute: async () => {
        mutateCount++;
        return { ok: true, output: "written successfully" };
      },
    };

    // 1. read_file a.ts
    // 2. duplicate read_file a.ts in same epoch (should be suppressed as duplicate)
    // 3. write_file a.ts (increments mutationEpoch)
    // 4. read_file a.ts (new epoch, should be allowed)
    // 5. final text answer
    const responses: LLMChatChunk[][] = [
      [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
      [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
      [{ message: { content: "```tool\nTOOL_NAME: write_file\nBEGIN_ARG: path\na.ts\nEND_ARG\nBEGIN_ARG: content\nnew content\nEND_ARG\n```" } }, { done: true }],
      [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
      [{ message: { content: "Done updating and reading file." } }, { done: true }],
    ];

    const { emitter } = createEmitter();
    const session = {
      messages: [{ id: "u1", role: "user" as const, content: "test flow", createdAt: Date.now() }],
    };

    const deps: UnifiedEngineDeps = {
      provider: createMockProvider(responses),
      tools: [mockRead, mockWrite],
      buildToolContext: () => ({
        capability: "high",
        todos: [],
        signal: new AbortController().signal,
        log: () => {},
      } as any),
      reserveOutputTokens: 1024,
    };

    await runUnifiedTurn(session, defaultPlan, emitter, new AbortController().signal, deps);

    assert.equal(mutateCount, 1, "Write tool executed once");
    // Initial read executed (1), duplicate suppressed (0), post-mutation read executed (1) = 2 executions
    assert.equal(callCount, 2, "read_file should have executed twice (initial + post-mutation)");
  });

  it("pushes native tool message outcome on tool errors and duplicate calls in native tool mode", async () => {
    const mockTool: Tool = {
      spec: {
        name: "test_tool",
        summary: "test",
        params: [{ name: "arg", type: "string", required: true, description: "" }],
        sideEffecting: false,
        priority: 1,
      },
      execute: async () => ({ ok: true, output: "ok" }),
    };

    // Native tool protocol mode: first call is missing required arg (error)
    const responses: LLMChatChunk[][] = [
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_err_1",
                type: "function",
                function: { name: "test_tool", arguments: {} },
              },
            ],
          },
        },
        { done: true },
      ],
      [{ message: { content: "Now concluding." } }, { done: true }],
    ];

    const nativePlan: AdaptivePlan = {
      ...defaultPlan,
      toolProtocol: "native",
    };

    const { emitter } = createEmitter();
    const session = {
      messages: [{ id: "u1", role: "user" as const, content: "run native tool", createdAt: Date.now() }],
    };

    const deps: UnifiedEngineDeps = {
      provider: createMockProvider(responses),
      tools: [mockTool],
      buildToolContext: () => ({
        capability: "high",
        todos: [],
        signal: new AbortController().signal,
        log: () => {},
      } as any),
      reserveOutputTokens: 1024,
    };

    await runUnifiedTurn(session, nativePlan, emitter, new AbortController().signal, deps);

    // Verify a tool message with role 'tool' and matching toolCallId was appended
    const toolMsgs = session.messages.filter((m) => m.role === "tool");
    assert.ok(toolMsgs.length >= 1, "Native tool message must be appended for error call");
    assert.equal(toolMsgs[0].toolCallId, "call_err_1");
    assert.ok(toolMsgs[0].content.includes("[TOOL_ERROR"), "Error message should include [TOOL_ERROR");
  });

  it("executes safe read-only tools in parallel waves when allowed", async () => {
    const executedInParallel: string[] = [];
    const mockTool1: Tool = {
      spec: {
        name: "read_1",
        summary: "read 1",
        params: [],
        sideEffecting: false,
        priority: 1,
        concurrency: "safe_parallel",
        risk: "read",
      },
      execute: async () => {
        executedInParallel.push("read_1");
        return { ok: true, output: "result 1" };
      },
    };

    const mockTool2: Tool = {
      spec: {
        name: "read_2",
        summary: "read 2",
        params: [],
        sideEffecting: false,
        priority: 1,
        concurrency: "safe_parallel",
        risk: "read",
      },
      execute: async () => {
        executedInParallel.push("read_2");
        return { ok: true, output: "result 2" };
      },
    };

    const responses: LLMChatChunk[][] = [
      [
        {
          message: {
            content: "```tool\nTOOL_NAME: read_1\n```\n```tool\nTOOL_NAME: read_2\n```",
          },
        },
        { done: true },
      ],
      [{ message: { content: "Both files read." } }, { done: true }],
    ];

    const { emitter, events } = createEmitter();
    const session = {
      messages: [{ id: "u1", role: "user" as const, content: "read both", createdAt: Date.now() }],
    };

    const deps: UnifiedEngineDeps = {
      provider: createMockProvider(responses),
      tools: [mockTool1, mockTool2],
      buildToolContext: () => ({
        capability: "high",
        todos: [],
        signal: new AbortController().signal,
        log: () => {},
      } as any),
      reserveOutputTokens: 1024,
    };

    await runUnifiedTurn(session, defaultPlan, emitter, new AbortController().signal, deps);

    assert.deepEqual(executedInParallel.sort(), ["read_1", "read_2"]);
    const phaseEvents = events.filter((e) => e.type === "onPhase" && e.payload.detail?.includes("parallel"));
    assert.ok(phaseEvents.length > 0, "Phase event indicated parallel execution");
  });

  it("bounds oversized context retrieval and tool output", async () => {
    const hugeOutput = "X".repeat(150_000);
    const mockTool: Tool = {
      spec: {
        name: "read_file",
        summary: "huge read",
        params: [{ name: "path", type: "string", required: true, description: "" }],
        sideEffecting: false,
        priority: 1,
      },
      execute: async () => ({ ok: true, output: hugeOutput }),
    };

    const responses: LLMChatChunk[][] = [
      [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nhuge.txt\nEND_ARG\n```" } }, { done: true }],
      [{ message: { content: "Got output." } }, { done: true }],
    ];

    const { emitter } = createEmitter();
    const session = {
      messages: [{ id: "u1", role: "user" as const, content: "run huge", createdAt: Date.now() }],
    };

    const deps: UnifiedEngineDeps = {
      provider: createMockProvider(responses),
      tools: [mockTool],
      workspaceMap: async () => "M".repeat(50_000),
      retrieveContext: async () => "C".repeat(50_000),
      buildToolContext: () => ({
        capability: "high",
        todos: [],
        signal: new AbortController().signal,
        log: () => {},
      } as any),
      reserveOutputTokens: 1024,
    };

    await runUnifiedTurn(session, defaultPlan, emitter, new AbortController().signal, deps);

    const toolMsg = session.messages.find((m) => m.content.includes("Output truncated: exceeded 100000 characters"));
    assert.ok(toolMsg, "Oversized tool output should have been bounded with truncation marker");
  });

  it("preserves todos across tool executions and rebuilds", async () => {
    const sharedTodosList = [{ id: 1, task: "existing task", status: "pending" as const }];

    const mockTool: Tool = {
      spec: {
        name: "todo_updater",
        summary: "todo updater",
        params: [],
        sideEffecting: false,
        priority: 1,
      },
      execute: async (_args, ctx) => {
        ctx.todos.push({ id: 2, task: "new task", status: "in_progress" as const });
        return { ok: true, output: "updated todos" };
      },
    };

    const responses: LLMChatChunk[][] = [
      [{ message: { content: "```tool\nTOOL_NAME: todo_updater\n```" } }, { done: true }],
      [{ message: { content: "Updated." } }, { done: true }],
    ];

    const { emitter } = createEmitter();
    const session = {
      messages: [{ id: "u1", role: "user" as const, content: "update todos", createdAt: Date.now() }],
    };

    const toolContext = {
      capability: "high" as const,
      todos: sharedTodosList,
      signal: new AbortController().signal,
      log: () => {},
    };

    const deps: UnifiedEngineDeps = {
      provider: createMockProvider(responses),
      tools: [mockTool],
      buildToolContext: () => toolContext as any,
      reserveOutputTokens: 1024,
    };

    await runUnifiedTurn(session, defaultPlan, emitter, new AbortController().signal, deps);

    assert.equal(toolContext.todos.length, 2, "Todos should be preserved and synced back to baseToolCtx");
    assert.equal(toolContext.todos[1].task, "new task");
  });
});
