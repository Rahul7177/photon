import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksLikeNarration,
  selectToolSpecs,
} from "../../src/core/intelligence/policy";
import { buildPlan } from "../../src/core/adaptive/orchestrator";
import { buildSystemPrompt } from "../../src/core/prompts/system";
import { buildCloudSystemPrompt } from "../../src/core/prompts/cloudSystem";
import { renderToolInstructions } from "../../src/core/protocol/serialize";
import {
  cloudTools,
  classifyCloudToolPolicy,
} from "../../src/core/tools/cloud/cloudTools";
import { builtinTools } from "../../src/core/tools/builtin";
import { ToolPipeline } from "../../src/photon-core/tools/pipeline";
import {
  runUnifiedTurn,
  type UnifiedEmitter,
  type UnifiedEngineDeps,
} from "../../src/core/agent/unifiedEngine";
import {
  runCloudTurn,
  cloudHistoryFromSession,
  type CloudEmitter,
} from "../../src/core/agent/cloudEngine";
import { fitToWindow } from "../../src/core/agent/contextManager";
import type { LLMChatChunk, LLMChatRequest, LLMMessage, LLMProvider } from "../../src/core/llm/types";
import type { Tool } from "../../src/core/tools/types";
import type { AdaptivePlan, ChatMessage, ModelInfo, ToolCall } from "../../src/shared/types";

function makeRecorder() {
  const contents: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolUpdates: ToolCall[] = [];
  const errors: string[] = [];

  const emitter: UnifiedEmitter & CloudEmitter = {
    onAssistantStart() {},
    onDelta(_id, delta) {
      contents.push(delta);
    },
    onContent(_id, content) {
      contents.push(content);
    },
    onAssistantCancel() {},
    onPhase() {},
    onToolCall(_id, call) {
      toolCalls.push(call);
    },
    onToolUpdate(_id, call) {
      toolUpdates.push(call);
    },
    onUsage() {},
    onGenerationStats() {},
    onDone() {},
    onError(msg) {
      errors.push(msg);
    },
  };

  return { emitter, contents, toolCalls, toolUpdates, errors };
}

function makePlan(mode: "chat" | "plan" | "agent", overrides: Partial<AdaptivePlan> = {}): AdaptivePlan {
  const model: ModelInfo = {
    name: "qwen2.5-coder:7b",
    provider: "ollama",
    contextLength: 32768,
    paramsB: 7,
    tier: "small",
    toolTrained: true,
  };
  return {
    ...buildPlan({
      model,
      machine: null,
      mode,
      prompt: "test prompt",
      intelligence: "high",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
    }),
    ...overrides,
    mode,
  };
}

describe("Modes Verification: Chat, Plan, Agent Boundaries & Cross-Mode Context Continuity", () => {
  describe("Chat Mode: Read-Only & Web Search, Never Mutates Workspace", () => {
    it("allows read-only workspace and web tools while excluding all write/exec tools", () => {
      const mcpTool: Tool = {
        spec: {
          name: "mcp_custom_writer",
          summary: "External MCP mutating tool",
          params: [],
          sideEffecting: true,
          priority: 1,
          tags: ["mcp"],
        },
        execute: async () => ({ ok: true, output: "mutated" }),
      };

      const allSpecs = [...builtinTools(), mcpTool].map((t) => t.spec);
      const localChatSpecs = selectToolSpecs(allSpecs, makePlan("chat"), "orient", false);
      const localNames = localChatSpecs.map((s) => s.name);

      assert.ok(localNames.includes("read_file"));
      assert.ok(localNames.includes("list_dir"));
      assert.ok(localNames.includes("find_files"));
      assert.ok(localNames.includes("search_code"));
      assert.ok(localNames.includes("web_search"));
      assert.ok(localNames.includes("web_fetch"));
      assert.ok(localNames.includes("query_project_context"));

      assert.ok(!localNames.includes("edit_file"));
      assert.ok(!localNames.includes("write_file"));
      assert.ok(!localNames.includes("append_file"));
      assert.ok(!localNames.includes("move_path"));
      assert.ok(!localNames.includes("run_command"));
      assert.ok(!localNames.includes("todo_write"));
      assert.ok(!localNames.includes("update_project_context"));
      assert.ok(!localNames.includes("mcp_custom_writer"));

      const cloudChatTools = cloudTools("chat", [mcpTool]).map((t) => t.spec.name);
      assert.ok(cloudChatTools.includes("read_file"));
      assert.ok(cloudChatTools.includes("web_search"));
      assert.ok(cloudChatTools.includes("web_fetch"));
      assert.ok(!cloudChatTools.includes("write_to_file"));
      assert.ok(!cloudChatTools.includes("replace_in_file"));
      assert.ok(!cloudChatTools.includes("execute_command"));
      assert.ok(!cloudChatTools.includes("mcp_custom_writer"));
    });

    it("instructs both Local and Cloud Chat prompts to refuse edits politely, explain manual steps, and suggest Agent mode", () => {
      const localPlan = makePlan("chat");
      const localPrompt = buildSystemPrompt({
        mode: "chat",
        plan: localPlan,
        toolInstructions: renderToolInstructions(
          selectToolSpecs(builtinTools().map((t) => t.spec), localPlan, "orient"),
          localPlan
        ),
        workspaceName: "Photon",
      });
      assert.ok(localPrompt.includes("manual"));
      assert.ok(localPrompt.includes("Agent"));
      assert.ok(localPrompt.includes("Read-Only Mode (chat)"));

      const cloudPrompt = buildCloudSystemPrompt({
        mode: "chat",
        workspaceName: "Photon",
        toolPolicy: "all",
      });
      assert.ok(cloudPrompt.includes("Strict Read-Only Boundary"));
      assert.ok(cloudPrompt.includes("manual"));
      assert.ok(cloudPrompt.includes("Agent"));
    });

    it("blocks mutating tool execution in runUnifiedTurn Chat mode and guides model to give manual edit instructions + Agent suggestion", async () => {
      let writeExecuted = false;
      const writeTool: Tool = {
        spec: {
          name: "write_file",
          summary: "Write file",
          params: [
            { name: "path", type: "string", required: true, description: "path" },
            { name: "content", type: "string", required: true, description: "content" },
          ],
          sideEffecting: true,
          priority: 1,
        },
        execute: async () => {
          writeExecuted = true;
          return { ok: true, output: "wrote" };
        },
      };

      const readTool: Tool = {
        spec: {
          name: "read_file",
          summary: "Read file",
          params: [{ name: "path", type: "string", required: true, description: "path" }],
          sideEffecting: false,
          priority: 1,
        },
        execute: async () => ({ ok: true, output: "const x = 1;" }),
      };

      const seenRequests: LLMChatRequest[] = [];
      let step = 0;
      const provider: LLMProvider = {
        id: "mock",
        label: "Mock",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(req): AsyncGenerator<LLMChatChunk> {
          seenRequests.push(req);
          if (step++ === 0) {
            yield {
              message: {
                role: "assistant",
                content:
                  '```tool\nTOOL_NAME: write_file\nBEGIN_ARG: path\nsrc/demo.ts\nEND_ARG\nBEGIN_ARG: content\nexport const x = 2;\nEND_ARG\n```',
              },
              done: true,
            };
          } else {
            yield {
              message: {
                role: "assistant",
                content:
                  "I can't modify files in Chat mode. Manually update `src/demo.ts` to `export const x = 2;`, or switch to **Agent** mode so I can apply it for you.",
              },
              done: true,
            };
          }
        },
      };

      const { emitter, contents } = makeRecorder();
      const session = {
        messages: [
          {
            id: "u1",
            role: "user" as const,
            content: "Please edit src/demo.ts to export x = 2",
            createdAt: Date.now(),
          },
        ],
      };

      const deps: UnifiedEngineDeps = {
        provider,
        tools: [readTool, writeTool],
        buildToolContext: (signal) => ({
          capability: "high",
          todos: [],
          signal,
          log: () => {},
          workspaceRoot: "B:/repo",
          requestApproval: async () => true,
          findFiles: async () => [],
          webSearchProvider: "duckduckgo",
          getDiagnostics: async () => [],
        }),
        reserveOutputTokens: 1024,
      };

      await runUnifiedTurn(session, makePlan("chat"), emitter, new AbortController().signal, deps);

      assert.equal(writeExecuted, false, "write_file must NEVER execute in Chat mode");
      assert.ok(
        seenRequests[1]?.messages.some((m) =>
          m.content.includes("Chat mode is strictly read-only") && m.content.includes("Agent")
        ),
        "Engine should nudge model to give manual instructions and suggest Agent mode"
      );
      assert.ok(contents.join("\n").includes("Agent"));
    });

    it("enforces mode boundaries at ToolPipeline execution layer for chat and plan modes", async () => {
      const writeTool: Tool = {
        spec: {
          name: "write_file",
          summary: "Write",
          params: [{ name: "path", type: "string", required: true, description: "p" }],
          sideEffecting: true,
          priority: 1,
          risk: "workspace_write",
        },
        execute: async () => ({ ok: true, output: "wrote" }),
      };

      const pipeline = new ToolPipeline();
      pipeline.register(writeTool);

      const chatRes = await pipeline.execute(
        { id: "c1", name: "write_file", args: { path: "a.ts" }, status: "proposed" },
        {
          mode: "chat",
          workspaceRoot: "B:/repo",
          signal: new AbortController().signal,
          log: () => {},
          webSearchProvider: "duckduckgo",
          findFiles: async () => [],
          capability: "high",
          getDiagnostics: async () => [],
          todos: [],
          requestApproval: async () => true,
        }
      );
      assert.equal(chatRes.ok, false);
      assert.equal(chatRes.status, "permission_denied");

      const planRes = await pipeline.execute(
        { id: "c2", name: "write_file", args: { path: "a.ts" }, status: "proposed" },
        {
          mode: "plan",
          workspaceRoot: "B:/repo",
          signal: new AbortController().signal,
          log: () => {},
          webSearchProvider: "duckduckgo",
          findFiles: async () => [],
          capability: "high",
          getDiagnostics: async () => [],
          todos: [],
          requestApproval: async () => true,
        }
      );
      assert.equal(planRes.ok, false);
      assert.equal(planRes.status, "permission_denied");
    });
  });

  describe("Plan Mode: Interactive Clarification (Bounded Questions) & Read-Only Boundaries", () => {
    it("configures Local and Cloud Plan prompts to clarify doubts conversationally without too many questions", () => {
      const localPlan = makePlan("plan");
      const localPrompt = buildSystemPrompt({
        mode: "plan",
        plan: localPlan,
        toolInstructions: renderToolInstructions(
          selectToolSpecs(builtinTools().map((t) => t.spec), localPlan, "orient"),
          localPlan
        ),
        workspaceName: "Photon",
      });

      assert.ok(localPrompt.includes("at most 2–4 focused"));
      assert.ok(localPrompt.includes("Never edit or create files in Plan mode."));
      assert.ok(!localPrompt.includes("Structured Engineering Workflow"));

      const cloudPrompt = buildCloudSystemPrompt({
        mode: "plan",
        workspaceName: "Photon",
        toolPolicy: "all",
      });
      assert.ok(cloudPrompt.includes("Interactive Discovery & Clarification"));
      assert.ok(cloudPrompt.includes("2–4 focused, concise clarifying questions"));
      assert.ok(cloudPrompt.includes("present a clear, structured implementation plan directly in Markdown"));
    });

    it("does not mistake interactive clarifying questions in Plan mode for tool narration", () => {
      assert.equal(
        looksLikeNarration(
          "Before I finalize the plan, I will need to check one quick detail with you: should refresh tokens rotate on every request?"
        ),
        false
      );
      assert.equal(
        looksLikeNarration(
          "I inspected auth.ts. Which database driver do you prefer for storing sessions?"
        ),
        false
      );
    });

    it("blocks side-effecting write attempts in Cloud Plan mode", async () => {
      let executed = false;
      const replaceTool: Tool = {
        spec: {
          name: "replace_in_file",
          summary: "Edit file",
          params: [],
          sideEffecting: true,
          priority: 1,
        },
        execute: async () => {
          executed = true;
          return { ok: true, output: "edited" };
        },
      };

      let step = 0;
      const provider: LLMProvider = {
        id: "cloud",
        label: "Cloud",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(): AsyncGenerator<LLMChatChunk> {
          if (step++ === 0) {
            yield {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "tc1", function: { name: "edit_file", arguments: { path: "a.ts", old_str: "a", new_str: "b" } } }],
              },
              done: true,
            };
          } else {
            yield {
              message: { role: "assistant", content: "Here is the plan — switch to Agent mode when ready." },
              done: true,
            };
          }
        },
      };

      const { emitter, toolUpdates } = makeRecorder();
      await runCloudTurn({
        provider,
        model: "claude-3-5-sonnet",
        system: buildCloudSystemPrompt({ mode: "plan" }),
        history: [{ role: "user", content: "Plan an update to a.ts" }],
        tools: [replaceTool],
        contextWindow: 100_000,
        ctx: {
          workspaceRoot: "B:/repo",
          signal: new AbortController().signal,
          log: () => {},
          webSearchProvider: "duckduckgo",
          findFiles: async () => [],
          capability: "high",
          getDiagnostics: async () => [],
          todos: [],
          requestApproval: async () => true,
        },
        emitter,
        signal: new AbortController().signal,
        mode: "plan",
      });

      assert.equal(executed, false);
      assert.ok(toolUpdates.some((u) => u.status === "error" && u.error?.includes('forbidden in "plan" mode')));
    });
  });

  describe("Agent Mode: Full Tool Access (Built-ins + MCP)", () => {
    it("exposes all built-in tools plus connected MCP tools in both Local and Cloud Agent modes", () => {
      const mcpTools: Tool[] = [1, 2, 3, 4, 5].map((n) => ({
        spec: {
          name: `mcp_srv_tool${n}`,
          summary: `MCP tool ${n}`,
          params: [],
          sideEffecting: false,
          priority: 20,
          tags: ["mcp"],
        },
        execute: async () => ({ ok: true, output: "ok" }),
      }));

      const allSpecs = [...builtinTools(), ...mcpTools].map((t) => t.spec);
      const agentPlan = makePlan("agent");
      const selected = selectToolSpecs(allSpecs, agentPlan, "orient");
      const names = selected.map((s) => s.name);

      // All core write, read, command, web tools + all 5 MCP tools must fit
      for (const expected of ["read_file", "edit_file", "append_file", "write_file", "move_path", "run_command", "web_search", "todo_write", "mcp_srv_tool1", "mcp_srv_tool5"]) {
        assert.ok(names.includes(expected), `Expected ${expected} in Agent tool specs`);
      }

      const cloudAgentNames = cloudTools("agent", mcpTools).map((t) => t.spec.name);
      assert.ok(cloudAgentNames.includes("replace_in_file"));
      assert.ok(cloudAgentNames.includes("write_to_file"));
      assert.ok(cloudAgentNames.includes("execute_command"));
      assert.ok(cloudAgentNames.includes("mcp_srv_tool1"));
      assert.ok(cloudAgentNames.includes("mcp_srv_tool5"));
    });
  });

  describe("Cross-Mode Context Continuity (Chat -> Plan -> Agent, Local <-> Cloud)", () => {
    it("retains Chat & Plan discussion and agreed plan in fitToWindow by clamping prior <tool_result> wrappers first", () => {
      const hugeRead = `<tool_result tool="read_file" status="ok">\n${"const line = 1;\n".repeat(450)}\n</tool_result>`;
      const history: LLMMessage[] = [
        { role: "user", content: "Explain our auth setup in auth.ts" },
        { role: "assistant", content: "Calling read_file" },
        { role: "user", content: hugeRead },
        { role: "assistant", content: "Your auth uses session cookies right now." },
        { role: "user", content: "Let's plan switching to JWT with 15m TTL and Redis blacklist." },
        { role: "assistant", content: "Implementation Plan:\n1. Add signJwt in src/auth.ts\n2. Check Redis blacklist in middleware.ts" },
        { role: "user", content: "Implement the agreed plan in Agent mode now." },
      ];

      const fitted = fitToWindow("System prompt", history, 2200, 3200, undefined, {
        preserveFirstUser: true,
        reserveOutputTokens: 400,
      });

      const joined = fitted.messages.map((m) => m.content).join("\n");
      assert.ok(joined.includes("JWT with 15m TTL"), "Earlier Chat/Plan decision must survive");
      assert.ok(joined.includes("Implementation Plan:"), "Drafted Plan must survive into Agent mode");
      assert.ok(joined.includes("Implement the agreed plan"), "Active Agent instruction must survive");
    });

    it("does not drop mode context or tools on 'ok'/'great' confirmations in ongoing sessions", () => {
      assert.equal(classifyCloudToolPolicy("chat", "hi", false), "none");
      assert.equal(classifyCloudToolPolicy("plan", "ok", false), "all");
      assert.equal(classifyCloudToolPolicy("agent", "great", false), "all");
      assert.equal(classifyCloudToolPolicy("plan", "hi", true), "all");
      assert.equal(classifyCloudToolPolicy("chat", "ok", true), "all");
    });

    it("preserves prior Chat & Plan turns, text attachments, and 'ok' confirmation when running Agent turn locally", async () => {
      let capturedRequests: LLMChatRequest[] = [];
      let editExecuted = false;

      const editTool: Tool = {
        spec: {
          name: "edit_file",
          summary: "Edit file",
          params: [
            { name: "path", type: "string", required: true, description: "p" },
            { name: "old_str", type: "string", required: true, description: "o" },
            { name: "new_str", type: "string", required: true, description: "n" },
          ],
          sideEffecting: true,
          priority: 1,
        },
        execute: async () => {
          editExecuted = true;
          return { ok: true, output: "Updated src/auth.ts" };
        },
      };

      let step = 0;
      const provider: LLMProvider = {
        id: "mock",
        label: "Mock",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(req): AsyncGenerator<LLMChatChunk> {
          capturedRequests.push(req);
          if (step++ === 0) {
            yield {
              message: {
                role: "assistant",
                content:
                  '```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\nsrc/auth.ts\nEND_ARG\nBEGIN_ARG: old_str\nold\nEND_ARG\nBEGIN_ARG: new_str\nnew\nEND_ARG\n```',
              },
              done: true,
            };
          } else {
            yield {
              message: { role: "assistant", content: "Implemented JWT as discussed in Chat/Plan modes." },
              done: true,
            };
          }
        },
      };

      const session: { messages: ChatMessage[] } = {
        messages: [
          {
            id: "u1",
            role: "user",
            content: "Here is our config in Chat mode.",
            attachments: [
              { id: "att1", kind: "text", name: "auth.config.json", mime: "application/json", size: 20, text: '{"ttl":"15m"}' },
            ],
            createdAt: 1,
          },
          { id: "a1", role: "assistant", content: "Got it, ttl is 15m.", createdAt: 2 },
          // Stale internal coaching nudge from an earlier turn must be stripped cleanly
          { id: "n1", role: "user", content: "Your previous reply arrived empty.", hidden: true, createdAt: 3 },
          { id: "u2", role: "user", content: "In Plan mode: let's add Redis blacklist.", createdAt: 4 },
          { id: "a2", role: "assistant", content: "Plan: update src/auth.ts with Redis blacklist. Proceed?", createdAt: 5 },
          // Switching to Agent mode and confirming with "ok" MUST keep all history and execute!
          { id: "u3", role: "user", content: "ok", createdAt: 6 },
        ],
      };

      const { emitter } = makeRecorder();
      await runUnifiedTurn(
        session,
        makePlan("agent"),
        emitter,
        new AbortController().signal,
        {
          provider,
          tools: [editTool],
          buildToolContext: (signal) => ({
            capability: "high",
            todos: [],
            signal,
            log: () => {},
            workspaceRoot: "B:/repo",
            requestApproval: async () => true,
            findFiles: async () => [],
            webSearchProvider: "duckduckgo",
            getDiagnostics: async () => [],
          }),
          reserveOutputTokens: 1024,
        }
      );

      assert.equal(editExecuted, true, '"ok" confirmation in ongoing session must NOT be swallowed as a standalone greeting');
      const sentMsgs = capturedRequests[0].messages;
      const fullSent = sentMsgs.map((m) => m.content).join("\n");
      assert.ok(fullSent.includes("Here is our config in Chat mode."));
      assert.ok(fullSent.includes('{"ttl":"15m"}'), "Text attachment from Chat mode must persist to Agent mode");
      assert.ok(fullSent.includes("Plan: update src/auth.ts with Redis blacklist."));
      assert.ok(!fullSent.includes("Your previous reply arrived empty."), "Stale hidden coaching nudges from prior turns must not pollute future turns");
    });

    it("cleans local hidden <tool_result> duplicates when transitioning from Local Chat/Plan to Cloud Agent", () => {
      const sessionMessages: ChatMessage[] = [
        { id: "u1", role: "user", content: "Read config.ts in Local Plan mode", createdAt: 1 },
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "tc1", name: "read_file", args: { path: "config.ts" }, status: "done", result: "export const port = 3000;" },
          ],
          createdAt: 2,
        },
        {
          id: "h1",
          role: "user",
          content: '<tool_result tool="read_file" status="ok">\nexport const port = 3000;\n</tool_result>',
          hidden: true,
          createdAt: 3,
        },
        { id: "a2", role: "assistant", content: "Plan: update port in config.ts to 8080.", createdAt: 4 },
        { id: "u2", role: "user", content: "Implement the plan in Cloud Agent mode", createdAt: 5 },
      ];

      const cloudMsgs = cloudHistoryFromSession(sessionMessages);
      const toolMsgs = cloudMsgs.filter((m) => m.role === "tool");
      const userMsgs = cloudMsgs.filter((m) => m.role === "user");

      assert.equal(toolMsgs.length, 1);
      assert.ok(toolMsgs[0].content.includes("export const port = 3000;"));
      assert.equal(userMsgs.length, 2, "Duplicate hidden <tool_result> user wrapper must be omitted in cloudHistoryFromSession");
      assert.ok(cloudMsgs.some((m) => m.role === "assistant" && m.content.includes("Plan: update port in config.ts")));
    });
  });

  describe("Cloud Engine Step Completion, Narration Recovery & Spin Guards", () => {
    it("completes multi-step Cloud Chat >6 steps without spurious cutOff re-prompt when done_reason is omitted", async () => {
      const capturedRequests: LLMChatRequest[] = [];
      let step = 0;

      const provider: LLMProvider = {
        id: "nvidia",
        name: "NVIDIA",
        chat: async () => ({ content: "" }),
        async *chatStream(req): AsyncIterable<LLMChatChunk> {
          capturedRequests.push({
            ...req,
            messages: req.messages.map((m) => ({ ...m })),
          });
          step++;
          if (step <= 8) {
            yield {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: `tc-${step}`, function: { name: "read_file", arguments: { path: `doc-${step}.md` } } }],
              },
              done: true,
              done_reason: "tool_calls",
            };
            return;
          }
          // Simulates gateway sending [DONE] without finish_reason delta -> done_reason undefined
          yield {
            message: {
              role: "assistant",
              content: "Here are the recommended improvements across all 8 files.\n\n1. Clarify the quickstart.\n2. Update links.",
            },
            done: true,
          };
        },
      };

      const readTool: Tool = {
        spec: {
          name: "read_file",
          summary: "Read file",
          params: [{ name: "path", type: "string", required: true, description: "p" }],
          sideEffecting: false,
          priority: 1,
        },
        execute: async (args) => ({ ok: true, output: `content of ${args.path}` }),
      };

      const rec = makeRecorder();
      let errorMsg = "";
      await runCloudTurn({
        provider,
        model: "nvidia/nemotron-3.5-light",
        system: "sys",
        history: [{ role: "user", content: "improve README" }],
        tools: [readTool],
        contextWindow: 128000,
        ctx: {
          mode: "chat",
          workspaceRoot: "B:/repo",
          signal: new AbortController().signal,
          log: () => {},
          webSearchProvider: "duckduckgo",
          findFiles: async () => [],
          capability: "high",
          getDiagnostics: async () => [],
          todos: [],
          requestApproval: async () => true,
        },
        emitter: {
          onAssistantStart: () => {},
          onDelta: (_, t) => rec.contents.push(t),
          onContent: (_, c) => rec.contents.push(c),
          onAssistantCancel: () => {},
          onPhase: () => {},
          onToolCall: (id, c) => rec.toolCalls.push(c),
          onToolUpdate: () => {},
          onUsage: () => {},
          onGenerationStats: () => {},
          onDone: () => {},
          onError: (e) => { errorMsg = e; },
        },
        signal: new AbortController().signal,
        mode: "chat",
      });

      assert.equal(errorMsg, "", "Should not hit 6-step limit or throw error");
      assert.equal(step, 9, "Should finish 8 reads + 1 final answer with NO spurious continuation loop");
      assert.equal(capturedRequests.length, 9);
      assert.ok(rec.contents.join("").includes("Here are the recommended improvements"));
    });

    it("recovers from narration-only stops in Cloud Chat mode cleanly while preserving role alternation", async () => {
      const capturedRequests: LLMChatRequest[] = [];
      let callNum = 0;

      const provider: LLMProvider = {
        id: "nvidia",
        name: "NVIDIA",
        chat: async () => ({ content: "" }),
        async *chatStream(req): AsyncIterable<LLMChatChunk> {
          capturedRequests.push({
            ...req,
            messages: req.messages.map((m) => ({ ...m })),
          });
          callNum++;
          if (callNum === 1) {
            yield {
              message: {
                role: "assistant",
                content: "Now I have a thorough understanding of the project. Let me create an improved README that showcases Photon.",
              },
              done: true,
              done_reason: "stop",
            };
            return;
          }
          yield {
            message: {
              role: "assistant",
              content: "I cannot directly write files in read-only Chat mode. Here is the improved README you can apply manually, or switch to Agent mode so I can apply it:\n\n```markdown\n# Photon\n```",
            },
            done: true,
            done_reason: "stop",
          };
        },
      };

      const streamed: string[] = [];
      let cancelled = 0;
      await runCloudTurn({
        provider,
        model: "nvidia/nemotron-3.5-light",
        system: "sys",
        history: [{ role: "user", content: "improve readme" }],
        tools: [],
        contextWindow: 128000,
        ctx: {
          mode: "chat",
          workspaceRoot: "B:/repo",
          signal: new AbortController().signal,
          log: () => {},
          webSearchProvider: "duckduckgo",
          findFiles: async () => [],
          capability: "high",
          getDiagnostics: async () => [],
          todos: [],
          requestApproval: async () => true,
        },
        emitter: {
          onAssistantStart: () => {},
          onDelta: (_, t) => streamed.push(t),
          onContent: (_, c) => streamed.push(c),
          onAssistantCancel: () => { cancelled++; },
          onPhase: () => {},
          onToolCall: () => {},
          onToolUpdate: () => {},
          onUsage: () => {},
          onGenerationStats: () => {},
          onDone: () => {},
          onError: () => {},
        },
        signal: new AbortController().signal,
        mode: "chat",
      });

      assert.equal(callNum, 2, "Narration-only teaser should trigger 1 recovery nudge");
      assert.equal(cancelled, 1, "Incomplete narration teaser bubble should be replaced");
      assert.ok(capturedRequests[1].messages.some((m) => m.role === "assistant" && m.content.includes("Let me create an improved README")));
      assert.ok(capturedRequests[1].messages.some((m) => m.role === "user" && m.content.includes("read-only Chat mode")));
      assert.ok(streamed.join("").includes("switch to Agent mode"));
    });

    it("stops runaway repeated identical tool calls with duplicate-call guard", async () => {
      let step = 0;
      const toolUpdates: ToolCall[] = [];
      let errorMsg = "";

      const provider: LLMProvider = {
        id: "mock",
        name: "mock",
        chat: async () => ({ content: "" }),
        async *chatStream(): AsyncIterable<LLMChatChunk> {
          step++;
          yield {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: `call-${step}`, function: { name: "read_file", arguments: { path: "same.ts" } } }],
            },
            done: true,
            done_reason: "tool_calls",
          };
        },
      };

      const readTool: Tool = {
        spec: {
          name: "read_file",
          summary: "Read file",
          params: [{ name: "path", type: "string", required: true, description: "p" }],
          sideEffecting: false,
          priority: 1,
        },
        execute: async () => ({ ok: true, output: "same content" }),
      };

      await runCloudTurn({
        provider,
        model: "gpt-4o",
        system: "sys",
        history: [{ role: "user", content: "read same.ts" }],
        tools: [readTool],
        contextWindow: 128000,
        ctx: {
          mode: "chat",
          workspaceRoot: "B:/repo",
          signal: new AbortController().signal,
          log: () => {},
          webSearchProvider: "duckduckgo",
          findFiles: async () => [],
          capability: "high",
          getDiagnostics: async () => [],
          todos: [],
          requestApproval: async () => true,
        },
        emitter: {
          onAssistantStart: () => {},
          onDelta: () => {},
          onContent: () => {},
          onAssistantCancel: () => {},
          onPhase: () => {},
          onToolCall: () => {},
          onToolUpdate: (_, tc) => toolUpdates.push(tc),
          onUsage: () => {},
          onGenerationStats: () => {},
          onDone: () => {},
          onError: (e) => { errorMsg = e; },
        },
        signal: new AbortController().signal,
        mode: "chat",
      });

      assert.equal(step, 4, "Should try 1 toolless fallback turn before breaking a stateless spin loop");
      assert.ok(toolUpdates.some((u) => u.error?.includes("Already executed read_file")));
      assert.ok(errorMsg.includes("repeated the exact same"));
    });

    it("handles blocked write attempts in Cloud Chat by disabling tools and delivering file content + manual/Agent guidance", async () => {
      const requests: LLMChatRequest[] = [];
      let callCount = 0;
      let writeExecuted = false;
      const emittedChunks: string[] = [];
      let cancelledCount = 0;
      let errorMsg = "";

      const provider: LLMProvider = {
        id: "nvidia",
        name: "NVIDIA",
        chat: async () => ({ content: "" }),
        async *chatStream(req): AsyncIterable<LLMChatChunk> {
          requests.push({
            ...req,
            messages: req.messages.map((m) => ({ ...m })),
          });
          callCount++;
          if (callCount === 1) {
            yield {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "r1", function: { name: "read_file", arguments: { path: "README.md" } } }],
              },
              done: true,
              done_reason: "tool_calls",
            };
            return;
          }
          if (callCount === 2) {
            yield {
              message: {
                role: "assistant",
                content: "Now I have a thorough understanding of the project. Let me create an improved README.md.",
                tool_calls: [
                  {
                    id: "w1",
                    function: {
                      name: "write_to_file",
                      arguments: { path: "README.md", content: "# Photon IDE\n\nUpdated README content." },
                    },
                  },
                ],
              },
              done: true,
              done_reason: "tool_calls",
            };
            return;
          }
          // Step 3 has tools disabled (req.tools undefined) and flattened messages (no role:"tool")
          yield {
            message: {
              role: "assistant",
              content:
                "Chat mode is read-only and does not have file-write access. You can copy and paste this improved `README.md` manually, or switch to **Agent** mode so I can apply it directly:\n\n```markdown\n# Photon IDE\n\nUpdated README content.\n```",
            },
            done: true,
            done_reason: "stop",
          };
        },
      };

      const readTool: Tool = {
        spec: {
          name: "read_file",
          summary: "Read file",
          params: [{ name: "path", type: "string", required: true, description: "p" }],
          sideEffecting: false,
          priority: 1,
        },
        execute: async () => ({ ok: true, output: "# Old README" }),
      };

      const writeTool: Tool = {
        spec: {
          name: "write_to_file",
          summary: "Write file",
          params: [
            { name: "path", type: "string", required: true, description: "p" },
            { name: "content", type: "string", required: true, description: "c" },
          ],
          sideEffecting: true,
          priority: 2,
        },
        execute: async () => {
          writeExecuted = true;
          return { ok: true, output: "wrote" };
        },
      };

      await runCloudTurn({
        provider,
        model: "nvidia/nemotron-3.5-light",
        system: "sys",
        history: [{ role: "user", content: "can you improve the readme file of this ?" }],
        tools: [readTool, writeTool],
        contextWindow: 128000,
        ctx: {
          mode: "chat",
          workspaceRoot: "B:/repo",
          signal: new AbortController().signal,
          log: () => {},
          webSearchProvider: "duckduckgo",
          findFiles: async () => [],
          capability: "high",
          getDiagnostics: async () => [],
          todos: [],
          requestApproval: async () => true,
        },
        emitter: {
          onAssistantStart: () => {},
          onDelta: (_, d) => emittedChunks.push(d),
          onContent: (_, c) => emittedChunks.push(c),
          onAssistantCancel: () => { cancelledCount++; },
          onPhase: () => {},
          onToolCall: () => {},
          onToolUpdate: () => {},
          onUsage: () => {},
          onGenerationStats: () => {},
          onDone: () => {},
          onError: (e) => { errorMsg = e; },
        },
        signal: new AbortController().signal,
        mode: "chat",
      });

      assert.equal(writeExecuted, false, "write_to_file must never execute in Chat mode");
      assert.equal(errorMsg, "", "Must never crash with repeated/blocked tool call error");
      assert.equal(callCount, 3);
      assert.equal(cancelledCount, 1, "Teaser narration alongside blocked write should be replaced cleanly");
      assert.equal(requests[2].tools, undefined, "Recovery turn must omit tools so model cannot attempt another edit");
      assert.equal(
        requests[2].messages.some((m) => m.role === "tool" || Boolean(m.tool_calls?.length)),
        false,
        "Flattened fallback turn must omit tool/tool_calls roles for strict gateway compatibility"
      );
      const output = emittedChunks.join("");
      assert.ok(output.includes("Updated README content."));
      assert.ok(output.includes("Agent"));
    });

    it("falls back to drafted write_to_file content in Cloud Chat even if stubborn model refuses to drop tools", async () => {
      let callCount = 0;
      const emittedChunks: string[] = [];
      let errorMsg = "";

      const provider: LLMProvider = {
        id: "nvidia",
        name: "NVIDIA",
        chat: async () => ({ content: "" }),
        async *chatStream(): AsyncIterable<LLMChatChunk> {
          callCount++;
          yield {
            message: {
              role: "assistant",
              content: "Let me create the improved version:",
              tool_calls: [
                {
                  id: `w-${callCount}`,
                  function: {
                    name: "write_to_file",
                    arguments: { path: "README.md", content: "# Fallback README\n\nReady to paste." },
                  },
                },
              ],
            },
            done: true,
            done_reason: "tool_calls",
          };
        },
      };

      await runCloudTurn({
        provider,
        model: "nvidia/nemotron-3.5-light",
        system: "sys",
        history: [{ role: "user", content: "improve readme" }],
        tools: [],
        contextWindow: 128000,
        ctx: {
          mode: "chat",
          workspaceRoot: "B:/repo",
          signal: new AbortController().signal,
          log: () => {},
          webSearchProvider: "duckduckgo",
          findFiles: async () => [],
          capability: "high",
          getDiagnostics: async () => [],
          todos: [],
          requestApproval: async () => true,
        },
        emitter: {
          onAssistantStart: () => {},
          onDelta: (_, d) => emittedChunks.push(d),
          onContent: (_, c) => emittedChunks.push(c),
          onAssistantCancel: () => {},
          onPhase: () => {},
          onToolCall: () => {},
          onToolUpdate: () => {},
          onUsage: () => {},
          onGenerationStats: () => {},
          onDone: () => {},
          onError: (e) => { errorMsg = e; },
        },
        signal: new AbortController().signal,
        mode: "chat",
      });

      assert.equal(errorMsg, "", "Should deliver captured content cleanly instead of failing with error");
      assert.equal(callCount, 2);
      const finalOut = emittedChunks.join("");
      assert.ok(finalOut.includes("# Fallback README"));
      assert.ok(finalOut.includes("copy and paste it manually"));
      assert.ok(finalOut.includes("Agent"));
    });
  });
});

