import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCloudTurn, cloudHistoryFromSession, normalizeCloudToolCall, type PendingCall, type CloudEmitter } from "../../src/core/agent/cloudEngine";
import { cloudTools } from "../../src/core/tools/cloud/cloudTools";
import { buildCloudSystemPrompt } from "../../src/core/prompts/cloudSystem";
import { CloudUsageTracker } from "../../src/core/telemetry/cloudUsage";
import { redactSecretsFromError, classifyRuntimeError } from "../../src/core/agent/errorRecovery";
import type { Tool } from "../../src/core/tools/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import type { ChatMessage } from "../../src/shared/types";

describe("Cloud Model Optimization & Native Speed", () => {
  describe("normalizeCloudToolCall transparent aliasing & argument normalization", () => {
    it("maps edit_file and str_replace_editor to replace_in_file with normalized args", () => {
      const call1: PendingCall = {
        id: "call-1",
        name: "edit_file",
        args: {
          file_path: "src/server.ts",
          old_str: "const port = 3000;",
          new_str: "const port = 8080;",
        },
      };
      const norm1 = normalizeCloudToolCall(call1);
      assert.equal(norm1.name, "replace_in_file");
      assert.equal(norm1.args.path, "src/server.ts");
      assert.equal(norm1.args.find, "const port = 3000;");
      assert.equal(norm1.args.replace, "const port = 8080;");

      const call2: PendingCall = {
        id: "call-2",
        name: "str_replace_editor",
        args: {
          path: "src/server.ts",
          target: "hello",
          replacement: "world",
          replaceAll: true,
        },
      };
      const norm2 = normalizeCloudToolCall(call2);
      assert.equal(norm2.name, "replace_in_file");
      assert.equal(norm2.args.find, "hello");
      assert.equal(norm2.args.replace, "world");
      assert.equal(norm2.args.replace_all, true);
    });

    it("maps whole-file edit_file without find/old_str to write_to_file", () => {
      const call: PendingCall = {
        id: "call-3",
        name: "edit_file",
        args: {
          file_path: "src/newFile.ts",
          content: "export const x = 1;",
        },
      };
      const norm = normalizeCloudToolCall(call);
      assert.equal(norm.name, "write_to_file");
      assert.equal(norm.args.path, "src/newFile.ts");
      assert.equal(norm.args.content, "export const x = 1;");
    });

    it("maps write_file, create_file, writeFile to write_to_file with normalized args", () => {
      const call: PendingCall = {
        id: "call-4",
        name: "create_file",
        args: {
          filePath: "src/app.tsx",
          contents: "export default function App() {}",
        },
      };
      const norm = normalizeCloudToolCall(call);
      assert.equal(norm.name, "write_to_file");
      assert.equal(norm.args.path, "src/app.tsx");
      assert.equal(norm.args.content, "export default function App() {}");
    });

    it("maps bash, run_command, terminal to execute_command with normalized args", () => {
      const call1: PendingCall = {
        id: "call-5",
        name: "bash",
        args: { cmd: "npm test", timeout: 60000 },
      };
      const norm1 = normalizeCloudToolCall(call1);
      assert.equal(norm1.name, "execute_command");
      assert.equal(norm1.args.command, "npm test");
      assert.equal(norm1.args.timeout_ms, 60000);

      const call2: PendingCall = {
        id: "call-6",
        name: "run_command",
        args: { script: "git status" },
      };
      const norm2 = normalizeCloudToolCall(call2);
      assert.equal(norm2.name, "execute_command");
      assert.equal(norm2.args.command, "git status");
    });

    it("maps list_dir, ls, dir to list_files with normalized args", () => {
      const call: PendingCall = {
        id: "call-7",
        name: "list_dir",
        args: { dir: "src/core", recursive: true },
      };
      const norm = normalizeCloudToolCall(call);
      assert.equal(norm.name, "list_files");
      assert.equal(norm.args.path, "src/core");
      assert.equal(norm.args.recursive, true);
    });

    it("maps search_code, grep, ripgrep to search_files with normalized args", () => {
      const call: PendingCall = {
        id: "call-8",
        name: "search_code",
        args: { pattern: "interface State", dir: "src" },
      };
      const norm = normalizeCloudToolCall(call);
      assert.equal(norm.name, "search_files");
      assert.equal(norm.args.query, "interface State");
      assert.equal(norm.args.path, "src");
    });

    it("maps view, cat, readFile to read_file with line bounds normalization", () => {
      const call: PendingCall = {
        id: "call-9",
        name: "cat",
        args: {
          file_path: "README.md",
          line_start: 10,
          line_end: 25,
        },
      };
      const norm = normalizeCloudToolCall(call);
      assert.equal(norm.name, "read_file");
      assert.equal(norm.args.path, "README.md");
      assert.equal(norm.args.start_line, 10);
      assert.equal(norm.args.end_line, 25);
    });

    it("maps diagnostics to get_diagnostics with normalized path", () => {
      const call: PendingCall = {
        id: "call-10",
        name: "diagnostics",
        args: { file_path: "src/index.ts" },
      };
      const norm = normalizeCloudToolCall(call);
      assert.equal(norm.name, "get_diagnostics");
      assert.equal(norm.args.path, "src/index.ts");
    });

    it("normalizes argument aliases when exact tool name is already used", () => {
      const exactRead: PendingCall = {
        id: "call-11",
        name: "read_file",
        args: { file_path: "src/main.ts", line_start: 5, line_end: 15 },
      };
      const normRead = normalizeCloudToolCall(exactRead);
      assert.equal(normRead.args.path, "src/main.ts");
      assert.equal(normRead.args.start_line, 5);
      assert.equal(normRead.args.end_line, 15);

      const exactReplace: PendingCall = {
        id: "call-12",
        name: "replace_in_file",
        args: { file: "src/main.ts", old_str: "foo", new_str: "bar" },
      };
      const normReplace = normalizeCloudToolCall(exactReplace);
      assert.equal(normReplace.args.path, "src/main.ts");
      assert.equal(normReplace.args.find, "foo");
      assert.equal(normReplace.args.replace, "bar");
    });
  });

  describe("cloudTools mode scoping & removal of pseudo-tools", () => {
    it("omits pseudo-tools (attempt_completion, ask_followup_question, todo_write) in Agent mode", () => {
      const tools = cloudTools("agent");
      const names = tools.map((t) => t.spec.name);

      assert.ok(!names.includes("attempt_completion"), "attempt_completion should not clog tool schemas");
      assert.ok(!names.includes("ask_followup_question"), "ask_followup_question should not clog tool schemas");
      assert.ok(!names.includes("todo_write"), "todo_write should not clog cloud tool schemas");
      assert.ok(!names.includes("query_project_context"), "query_project_context should not clog tool schemas");
      assert.ok(!names.includes("update_project_context"), "update_project_context should not clog tool schemas");

      // Core workspace and web tools must be available
      assert.ok(names.includes("read_file"));
      assert.ok(names.includes("write_to_file"));
      assert.ok(names.includes("replace_in_file"));
      assert.ok(names.includes("execute_command"));
      assert.ok(names.includes("web_search"));
      assert.ok(names.includes("web_fetch"));
    });

    it("restricts Chat mode to read-only workspace and web tools", () => {
      const tools = cloudTools("chat");
      const names = tools.map((t) => t.spec.name);

      assert.ok(names.includes("read_file"));
      assert.ok(names.includes("web_search"));
      assert.ok(!names.includes("write_to_file"), "Chat mode must not include write tools");
      assert.ok(!names.includes("replace_in_file"), "Chat mode must not include write tools");
      assert.ok(!names.includes("execute_command"), "Chat mode must not include execute_command");
    });

    it("restricts Plan mode to read-only tools without pseudo-tools", () => {
      const tools = cloudTools("plan");
      const names = tools.map((t) => t.spec.name);

      assert.ok(names.includes("read_file"));
      assert.ok(!names.includes("attempt_completion"), "Plan mode should not require attempt_completion tool");
      assert.ok(!names.includes("write_to_file"), "Plan mode must not include write tools");
    });
  });

  describe("buildCloudSystemPrompt ceremony elimination", () => {
    it("does not demand attempt_completion or pseudo-tools in Agent and Plan prompts", () => {
      const agentPrompt = buildCloudSystemPrompt({
        mode: "agent",
        workspaceName: "MyWorkspace",
      });
      assert.ok(!agentPrompt.includes("attempt_completion"), "Agent prompt should not mandate attempt_completion");
      assert.ok(!agentPrompt.includes("update_project_context"), "Agent prompt should not mandate update_project_context");
      assert.ok(agentPrompt.includes("Direct Execution"), "Agent prompt promotes direct execution");
      assert.ok(agentPrompt.includes("summarize what was done directly in clear, concise Markdown"));

      const planPrompt = buildCloudSystemPrompt({
        mode: "plan",
        workspaceName: "MyWorkspace",
      });
      assert.ok(!planPrompt.includes("attempt_completion"), "Plan prompt should not mandate attempt_completion");
      assert.ok(planPrompt.includes("present a clear, structured implementation plan directly in Markdown"));
    });
  });

  describe("Phase 3.2: Cloud Engine Execution Integrity & Secret Hygiene", () => {
    it("redacts secret tokens, API keys, and Authorization headers in runtime errors", () => {
      const errorWithSecret = "Invalid request to https://api.anthropic.com: apiKey=sk-ant-api03-abcdef1234567890abcdef and Bearer sk-proj-1234567890abcdef";
      const sanitized = redactSecretsFromError(errorWithSecret);
      assert.ok(!sanitized.includes("sk-ant-api03-abcdef1234567890abcdef"));
      assert.ok(!sanitized.includes("sk-proj-1234567890abcdef"));
      assert.ok(sanitized.includes("[REDACTED"));

      const classified = classifyRuntimeError(new Error("Unauthorized: incorrect api key sk-1234567890abcdef1234"));
      assert.ok(!classified.userMessage.includes("sk-1234567890abcdef1234"));
      assert.ok(!classified.rawMessage.includes("sk-1234567890abcdef1234"));
    });

    it("cloudHistoryFromSession pairs tool calls and eliminates duplicates", () => {
      const messages: ChatMessage[] = [
        { id: "u1", role: "user", content: "read file", createdAt: Date.now() },
        {
          id: "a1",
          role: "assistant",
          content: "reading...",
          toolCalls: [
            { id: "call_1", name: "read_file", args: { path: "a.ts" }, status: "done", result: "file A content" },
            { id: "call_2", name: "read_file", args: { path: "b.ts" }, status: "error", error: "not found" },
          ],
          createdAt: Date.now(),
        },
        // Explicit tool message already in session for call_1
        {
          id: "t1",
          role: "tool",
          content: "file A content",
          toolCallId: "call_1",
          name: "read_file",
          createdAt: Date.now(),
        } as any,
      ];

      const history = cloudHistoryFromSession(messages);
      // Verify tool call 1 has exactly one tool response, not two
      const call1Responses = history.filter((m) => m.role === "tool" && m.tool_call_id === "call_1");
      assert.equal(call1Responses.length, 1, "call_1 should have exactly one response");
      // Verify tool call 2 has its synthesized failure response
      const call2Responses = history.filter((m) => m.role === "tool" && m.tool_call_id === "call_2");
      assert.equal(call2Responses.length, 1, "call_2 should have exactly one response");
      assert.ok(call2Responses[0].content.includes("not found"));
    });

    it("CloudUsageTracker resetSession resets session counters while preserving historical totals", () => {
      const tracker = new CloudUsageTracker();
      tracker.recordStep({
        model: "claude-3-5-sonnet",
        inputTokens: 1000,
        outputTokens: 500,
      });

      const before = tracker.getSummary();
      assert.equal(before.sessionInputTokens, 1000);
      assert.equal(before.totalInputTokens, 1000);

      tracker.resetSession();

      const after = tracker.getSummary();
      assert.equal(after.sessionInputTokens, 0, "session tokens must reset");
      assert.equal(after.sessionOutputTokens, 0);
      assert.equal(after.sessionEstimatedCostUsd, 0);
      assert.equal(after.totalInputTokens, 1000, "total tokens must be preserved");
    });

    it("runCloudTurn safely assembles partial tool calls and executes them", async () => {
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
          return { ok: true, output: "file content" };
        },
      };

      // Mock streaming chunks with partial tool call assembly (string JSON args)
      const mockProvider: LLMProvider = {
        id: "mock-cloud",
        label: "Mock Cloud",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
          if (callCount === 0) {
            yield {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_part_1",
                    function: { name: "read_file", arguments: '{"path": "test.' as any },
                  },
                ],
              },
              done: false,
            };
            yield {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_part_1",
                    function: { name: "read_file", arguments: 'ts"}' as any },
                  },
                ],
              },
              done: false,
            };
            yield {
              message: { role: "assistant", content: "" },
              done: true,
              done_reason: "tool_calls",
              prompt_eval_count: 50,
              eval_count: 30,
            };
          } else {
            yield {
              message: { role: "assistant", content: "File read successfully." },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 80,
              eval_count: 10,
            };
          }
        },
      };

      const events: any[] = [];
      const emitter: CloudEmitter = {
        onAssistantStart: (id) => events.push({ type: "start", id }),
        onDelta: () => {},
        onContent: () => {},
        onAssistantCancel: () => {},
        onToolCall: (id, call) => events.push({ type: "call", call }),
        onToolUpdate: (id, call) => events.push({ type: "update", call }),
        onPhase: () => {},
        onUsage: () => {},
        onGenerationStats: () => {},
        onDone: (id) => events.push({ type: "done", id }),
        onError: (err) => events.push({ type: "error", err }),
      };

      const usageRecorded: any[] = [];
      await runCloudTurn({
        provider: mockProvider,
        model: "claude-3-5-sonnet",
        system: "You are an assistant.",
        history: [{ role: "user", content: "Read test.ts" }],
        tools: [mockRead],
        contextWindow: 128_000,
        ctx: { capability: "high", todos: [], signal: new AbortController().signal, log: () => {} } as any,
        emitter,
        signal: new AbortController().signal,
        onStepUsage: (u) => usageRecorded.push(u),
      });

      assert.equal(callCount, 1, "Tool should have executed once");
      assert.equal(usageRecorded.length, 2, "Exact usage recorded for each step");
      assert.equal(usageRecorded[0].inputTokens, 50);
      assert.equal(usageRecorded[0].outputTokens, 30);
    });

    it("runCloudTurn cancels safely and marks remaining calls as cancelled", async () => {
      const abortCtrl = new AbortController();
      let firstExecuted = false;

      const mockTool1: Tool = {
        spec: {
          name: "write_1",
          summary: "write 1",
          params: [],
          sideEffecting: true,
          priority: 1,
        },
        execute: async () => {
          firstExecuted = true;
          abortCtrl.abort();
          return { ok: true, output: "done 1" };
        },
      };

      let secondExecuted = false;
      const mockTool2: Tool = {
        spec: {
          name: "write_2",
          summary: "write 2",
          params: [],
          sideEffecting: true,
          priority: 2,
        },
        execute: async () => {
          secondExecuted = true;
          return { ok: true, output: "done 2" };
        },
      };

      const mockProvider: LLMProvider = {
        id: "mock-cloud",
        label: "Mock Cloud",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(): AsyncGenerator<LLMChatChunk> {
          yield {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "call_w1", function: { name: "write_1", arguments: {} } },
                { id: "call_w2", function: { name: "write_2", arguments: {} } },
              ],
            },
            done: true,
          };
        },
      };

      const events: any[] = [];
      const emitter: CloudEmitter = {
        onAssistantStart: () => {},
        onDelta: () => {},
        onContent: () => {},
        onAssistantCancel: () => {},
        onToolCall: (id, call) => events.push({ type: "call", call }),
        onToolUpdate: (id, call) => events.push({ type: "update", call }),
        onPhase: () => {},
        onUsage: () => {},
        onGenerationStats: () => {},
        onDone: (id, notice) => events.push({ type: "done", notice }),
        onError: () => {},
      };

      await runCloudTurn({
        provider: mockProvider,
        model: "gpt-4o",
        system: "You are an assistant.",
        history: [{ role: "user", content: "Run writes" }],
        tools: [mockTool1, mockTool2],
        contextWindow: 128_000,
        ctx: { capability: "high", todos: [], signal: abortCtrl.signal, log: () => {} } as any,
        emitter,
        signal: abortCtrl.signal,
      });

      assert.ok(firstExecuted, "First tool executed");
      assert.ok(!secondExecuted, "Second tool must NOT execute after abort");
      const doneEvent = events.find((e) => e.type === "done");
      assert.ok(doneEvent);
      assert.equal(doneEvent.notice, "Stopped.");
      // Second tool must be marked as error/cancelled
      const call2Updates = events.filter((e) => e.type === "update" && e.call.id === "call_w2");
      assert.ok(call2Updates.some((u) => u.call.status === "error" && u.call.error === "Operation cancelled."));
    });
  });
});

