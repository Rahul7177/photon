import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AgentEngine, type TurnEmitter } from "../../src/core/agent/engine";
import { runCloudTurn, type CloudEmitter } from "../../src/core/agent/cloudEngine";
import { classifyRuntimeError, formatNativeToolOutcome, sanitizeToolPairing } from "../../src/core/agent/errorRecovery";
import { compactSessionMessages, shouldAutoCompact } from "../../src/core/agent/compactor";
import { ToolRegistry } from "../../src/core/tools/registry";
import { builtinTools } from "../../src/core/tools/builtin";
import { runCommandTool } from "../../src/core/tools/builtin/terminal";
import { reducer, initial } from "../../webview-ui/src/state/store";
import { isLocalModel, type AdaptivePlan, type ChatMessage, type SessionState, type ToolCall } from "../../src/shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider, LLMMessage } from "../../src/core/llm/types";
import { ApprovalService } from "../../src/host/approvalService";
import type { ToolContext } from "../../src/core/tools/types";

function makePlan(overrides: Partial<AdaptivePlan> = {}): AdaptivePlan {
  return {
    model: "qwen2.5-coder:7b",
    mode: "agent",
    contextWindow: 16384,
    numCtx: 16384,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 2048,
    toolProtocol: "photon-block",
    maxTools: 12,
    allowParallelTools: false,
    intelligence: "medium",
    intelligenceAuto: true,
    rationale: ["Test plan"],
    ...overrides,
  };
}

function makeRecorderEmitter(session: SessionState): TurnEmitter & CloudEmitter & {
  events: string[];
  errors: string[];
  toolUpdates: ToolCall[];
  thinkingDeltas: string[];
} {
  const events: string[] = [];
  const errors: string[] = [];
  const toolUpdates: ToolCall[] = [];
  const thinkingDeltas: string[] = [];

  return {
    events,
    errors,
    toolUpdates,
    thinkingDeltas,
    onAssistantStart(id: string) {
      events.push(`start:${id}`);
      if (!session.messages.some((m) => m.id === id)) {
        session.messages.push({
          id,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          streaming: true,
        });
      }
    },
    onDelta(id: string, delta: string) {
      const m = session.messages.find((x) => x.id === id);
      if (m) m.content += delta;
    },
    onThinkingDelta(_id: string, delta: string) {
      thinkingDeltas.push(delta);
    },
    onThinkingEnd(_id: string, _elapsedMs: number) {
      events.push("thinkingEnd");
    },
    onContent(id: string, content: string) {
      const m = session.messages.find((x) => x.id === id);
      if (m) m.content = content;
    },
    onAssistantCancel(id: string) {
      events.push(`cancel:${id}`);
      session.messages = session.messages.filter((m) => m.id !== id);
    },
    onPhase(phase: "thinking" | "working", detail?: string) {
      events.push(`phase:${phase}${detail ? `:${detail}` : ""}`);
    },
    onToolCall(id: string, call: ToolCall) {
      events.push(`toolCall:${call.name}`);
      const m = session.messages.find((x) => x.id === id);
      if (m) {
        m.toolCalls = [...(m.toolCalls ?? []), call];
      }
    },
    onToolUpdate(id: string, call: ToolCall) {
      toolUpdates.push(call);
      const m = session.messages.find((x) => x.id === id);
      if (m && m.toolCalls) {
        const idx = m.toolCalls.findIndex((c) => c.id === call.id);
        if (idx >= 0) m.toolCalls[idx] = call;
        else m.toolCalls.push(call);
      }
    },
    onUsage() {},
    onGenerationStats() {},
    onDone(id: string, notice?: string) {
      events.push(`done:${id}`);
      const m = session.messages.find((x) => x.id === id);
      if (m) {
        m.streaming = false;
        if (notice) m.notice = notice;
      }
    },
    onError(message: string) {
      events.push(`error:${message}`);
      errors.push(message);
    },
  };
}

describe("Consolidated Agent Runtime, Failure Recovery & Long Sessions (P1 Items 5, 6, 7)", () => {
  describe("P1 Item 6: Error Classification & Tool Outcome Formatting", () => {
    it("classifies transient vs permanent runtime errors accurately", () => {
      // 1. User cancellation
      const abortCtrl = new AbortController();
      abortCtrl.abort();
      const cancelled = classifyRuntimeError(new Error("Request aborted"), abortCtrl.signal);
      assert.equal(cancelled.category, "cancelled");
      assert.equal(cancelled.retryable, false);

      // 2. Permanent authentication failure (HTTP 401/403)
      const authErr = classifyRuntimeError(new Error("HTTP 401 Unauthorized: Invalid API Key"));
      assert.equal(authErr.category, "auth");
      assert.equal(authErr.retryable, false);
      assert.ok(authErr.userMessage.includes("API key"));

      // 3. Permanent configuration/model-not-found error (HTTP 404/400)
      const configErr = classifyRuntimeError(new Error("HTTP 404: model 'foo-bar' not found"));
      assert.equal(configErr.category, "config_or_validation");
      assert.equal(configErr.retryable, false);

      // 4. Transient rate limit (HTTP 429) vs permanent quota exhaustion
      const rateLimit = classifyRuntimeError(new Error("HTTP 429 Too Many Requests: rate_limit_exceeded"));
      assert.equal(rateLimit.category, "rate_limit");
      assert.equal(rateLimit.retryable, true);

      const billingLimit = classifyRuntimeError(
        new Error("HTTP 429: You exceeded your current quota, please check your plan and billing details")
      );
      assert.equal(billingLimit.category, "rate_limit");
      assert.equal(billingLimit.retryable, false);

      // 5. Timeout & stalled connection
      const timeoutErr = classifyRuntimeError(
        new Error("No output from the provider for 300s — connection stalled.")
      );
      assert.equal(timeoutErr.category, "timeout");
      assert.equal(timeoutErr.retryable, true);

      // 6. Network & gateway errors (502/503/ECONNRESET)
      const netErr = classifyRuntimeError(new Error("fetch failed: ECONNRESET"));
      assert.equal(netErr.category, "network");
      assert.equal(netErr.retryable, true);

      // 7. Local runtime crash vs OOM
      const crashErr = classifyRuntimeError(new Error("llama runner process has terminated: exit status 2"));
      assert.equal(crashErr.category, "local_runtime_crash");
      assert.equal(crashErr.retryable, true);

      const oomErr = classifyRuntimeError(new Error("CUDA error: out of memory when allocating KV cache"));
      assert.equal(oomErr.category, "local_runtime_crash");
      assert.equal(oomErr.retryable, false);
    });

    it("marks failed native/cloud tool outcomes with explicit [TOOL_ERROR] guardrails", () => {
      const okOut = formatNativeToolOutcome("write_file", "Wrote 120 bytes to a.ts", true);
      assert.equal(okOut, "Wrote 120 bytes to a.ts");

      const failOut = formatNativeToolOutcome("write_file", "Permission denied", false);
      assert.ok(failOut.startsWith('[TOOL_ERROR: "write_file" FAILED'));
      assert.ok(failOut.includes("was NOT completed"));
      assert.ok(failOut.includes("Permission denied"));
    });
  });

  describe("P1 Item 5 & 6: Local Unified Engine & Cloud Engine Parity", () => {
    it("retries transient network/503 failure once when safe, and never retries permanent 401 auth errors", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-parity-"));
      try {
        const registry = new ToolRegistry();
        registry.registerAll(builtinTools());

        const buildCtx = (signal: AbortSignal): ToolContext => ({
          workspaceRoot: tmpDir,
          signal,
          capability: "medium",
          todos: [],
          requestApproval: async () => true,
          log: () => {},
          getDiagnostics: async () => [],
          findFiles: async () => [],
        });

        // Case A: Transient 503 on attempt 1 -> succeeds on attempt 2 in Local AgentEngine
        let localCalls = 0;
        const transientProvider: LLMProvider = {
          id: "ollama",
          label: "Ollama",
          enabled: true,
          isConfigured: () => true,
          ping: async () => true,
          listModels: async () => [],
          async *chatStream(): AsyncGenerator<LLMChatChunk> {
            localCalls++;
            if (localCalls === 1) {
              throw new Error("HTTP 503 Service Unavailable");
            }
            yield {
              done: true,
              done_reason: "stop",
              message: { role: "assistant", content: "Recovered after transient 503." },
            };
          },
        };

        const sessionA: SessionState = {
          id: "s-transient",
          title: "Test",
          mode: "agent",
          model: "qwen2.5-coder:7b",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [{ id: "u1", role: "user", content: "Explain the architecture", createdAt: Date.now() }],
        };
        const emitterA = makeRecorderEmitter(sessionA);
        const engineA = new AgentEngine({
          client: transientProvider,
          registry,
          workspaceName: "test",
          workspaceMap: async () => undefined,
          toolContext: buildCtx,
          reserveOutputTokens: 1024,
        });

        await engineA.runTurn(sessionA, makePlan(), emitterA, new AbortController().signal);
        assert.equal(localCalls, 2);
        assert.equal(emitterA.errors.length, 0);
        assert.ok(sessionA.messages.some((m) => m.content.includes("Recovered after transient 503.")));

        // Case B: Permanent 401 Auth Error -> fails immediately on attempt 1 (zero retries) in both Local & Cloud
        let authCalls = 0;
        const authFailProvider: LLMProvider = {
          id: "openai",
          label: "OpenAI",
          enabled: true,
          isConfigured: () => true,
          ping: async () => true,
          listModels: async () => [],
          async *chatStream(): AsyncGenerator<LLMChatChunk> {
            authCalls++;
            throw new Error("HTTP 401 Unauthorized: Incorrect API key provided");
          },
        };

        const sessionB: SessionState = {
          id: "s-auth",
          title: "Test",
          mode: "agent",
          model: "openai:gpt-4o",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [{ id: "u1", role: "user", content: "Hello", createdAt: Date.now() }],
        };
        const emitterB = makeRecorderEmitter(sessionB);
        await runCloudTurn({
          provider: authFailProvider,
          model: "openai:gpt-4o",
          system: "System prompt",
          history: [{ role: "user", content: "Hello" }],
          tools: [],
          contextWindow: 128000,
          ctx: buildCtx(new AbortController().signal),
          emitter: emitterB,
          signal: new AbortController().signal,
        });

        assert.equal(authCalls, 1, "Permanent 401 error must never be retried");
        assert.equal(emitterB.errors.length, 1);
        assert.ok(emitterB.errors[0].includes("Authentication error"));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("never mistakes a failed tool call for a completed action when model returns empty follow-up", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-toolfail-"));
      try {
        const registry = new ToolRegistry();
        registry.registerAll(builtinTools());

        const promptsSeenByModel: string[] = [];
        let step = 0;
        const mockProvider: LLMProvider = {
          id: "ollama",
          label: "Ollama",
          enabled: true,
          isConfigured: () => true,
          ping: async () => true,
          listModels: async () => [],
          async *chatStream(req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
            step++;
            const lastMsg = req.messages[req.messages.length - 1]?.content ?? "";
            promptsSeenByModel.push(lastMsg);
            if (step === 1) {
              // Call read_file on a non-existent file -> tool will fail
              yield {
                done: true,
                done_reason: "stop",
                message: {
                  role: "assistant",
                  content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\ndoes_not_exist.ts\nEND_ARG\n```",
                },
              };
            } else if (step === 2) {
              // Model returns empty completion after tool failure
              yield {
                done: true,
                done_reason: "stop",
                message: { role: "assistant", content: "" },
              };
            } else {
              yield {
                done: true,
                done_reason: "stop",
                message: {
                  role: "assistant",
                  content: "The file `does_not_exist.ts` was not found, so the read operation could not be completed.",
                },
              };
            }
          },
        };

        const session: SessionState = {
          id: "s-fail-nudge",
          title: "Test",
          mode: "agent",
          model: "qwen2.5-coder:7b",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [{ id: "u1", role: "user", content: "Read does_not_exist.ts", createdAt: Date.now() }],
        };
        const emitter = makeRecorderEmitter(session);
        const engine = new AgentEngine({
          client: mockProvider,
          registry,
          workspaceName: "test",
          workspaceMap: async () => undefined,
          toolContext: (signal) => ({
            workspaceRoot: tmpDir,
            signal,
            capability: "medium",
            todos: [],
            requestApproval: async () => true,
            log: () => {},
            getDiagnostics: async () => [],
            findFiles: async () => [],
          }),
          reserveOutputTokens: 1024,
        });

        await engine.runTurn(session, makePlan(), emitter, new AbortController().signal);

        // Verify that the nudge sent on step 3 explicitly told the model the tool FAILED, not succeeded!
        assert.ok(
          promptsSeenByModel.some((p) => p.includes("previous tool call failed") && p.includes("NOT completed")),
          "Engine must tell the model that the previous tool call failed, never that it succeeded"
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("propagates cancellation to running commands and aborts cleanly", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-cancel-"));
      try {
        const abortCtrl = new AbortController();
        // Cancel 150ms after command starts
        setTimeout(() => abortCtrl.abort(), 150);

        const start = Date.now();
        const res = await runCommandTool.execute(
          { command: 'node -e "setTimeout(() => {}, 10000)"' },
          {
            workspaceRoot: tmpDir,
            signal: abortCtrl.signal,
            capability: "medium",
            todos: [],
            requestApproval: async () => true,
            log: () => {},
            getDiagnostics: async () => [],
            findFiles: async () => [],
          }
        );
        const elapsed = Date.now() - start;

        assert.equal(res.ok, false);
        assert.ok(res.output.includes("cancelled"), `Expected cancelled output, got: ${res.output}`);
        assert.ok(elapsed < 5000, `Command should abort promptly on signal, took ${elapsed}ms`);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe("P1 Item 7: Long-Running Session Stability & UI State Hygiene", () => {
    it("handles multi-turn sessions with repeated tool calls, model switching, and auto-compaction", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-long-session-"));
      try {
        await fs.writeFile(path.join(tmpDir, "config.json"), '{"version": 1}\n', "utf8");
        const registry = new ToolRegistry();
        registry.registerAll(builtinTools());

        let turnIndex = 0;
        const provider: LLMProvider = {
          id: "ollama",
          label: "Ollama",
          enabled: true,
          isConfigured: () => true,
          ping: async () => true,
          listModels: async () => [],
          async *chatStream(): AsyncGenerator<LLMChatChunk> {
            turnIndex++;
            if (turnIndex === 1) {
              yield {
                done: true,
                done_reason: "stop",
                message: {
                  role: "assistant",
                  content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nconfig.json\nEND_ARG\n```",
                },
              };
            } else if (turnIndex === 2) {
              yield {
                done: true,
                done_reason: "stop",
                message: {
                  role: "assistant",
                  content: "Read `config.json` (version 1). " + "Detail ".repeat(200),
                },
              };
            } else if (turnIndex === 3) {
              yield {
                done: true,
                done_reason: "stop",
                message: {
                  role: "assistant",
                  content:
                    "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\nconfig.json\nEND_ARG\nBEGIN_ARG: old_str\n\"version\": 1\nEND_ARG\nBEGIN_ARG: new_str\n\"version\": 2\nEND_ARG\n```",
                },
              };
            } else {
              yield {
                done: true,
                done_reason: "stop",
                message: {
                  role: "assistant",
                  content: "Updated `config.json` to version 2.",
                },
              };
            }
          },
        };

        const session: SessionState = {
          id: "long-session-1",
          title: "Long Session",
          mode: "agent",
          model: "qwen2.5-coder:7b",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        };

        const engine = new AgentEngine({
          client: provider,
          registry,
          workspaceName: "long-session",
          workspaceMap: async () => undefined,
          toolContext: (signal) => ({
            workspaceRoot: tmpDir,
            signal,
            capability: "medium",
            todos: [],
            requestApproval: async () => true,
            log: () => {},
            getDiagnostics: async () => [],
            findFiles: async () => ["config.json"],
          }),
          reserveOutputTokens: 512,
        });

        // Turn 1 (Model A: qwen2.5-coder:7b)
        session.messages.push({
          id: "u1",
          role: "user",
          content: "Inspect config.json and upgrade its version to 2",
          createdAt: Date.now(),
        });
        const emitter1 = makeRecorderEmitter(session);
        await engine.runTurn(session, makePlan({ model: "qwen2.5-coder:7b" }), emitter1, new AbortController().signal);

        // Turn 2 (Switch model to deepseek-coder:6.7b)
        session.messages.push({
          id: "u2",
          role: "user",
          content: "Now edit config.json to version 2",
          createdAt: Date.now(),
        });
        const emitter2 = makeRecorderEmitter(session);
        await engine.runTurn(session, makePlan({ model: "deepseek-coder:6.7b" }), emitter2, new AbortController().signal);

        const updatedFile = await fs.readFile(path.join(tmpDir, "config.json"), "utf8");
        assert.ok(updatedFile.includes('"version": 2'));

        // Trigger compaction on the accumulated session history
        assert.equal(shouldAutoCompact(session.messages, 400, "deepseek-coder:6.7b", 0.75), true);
        const compacted = await compactSessionMessages({
          messages: session.messages,
          contextWindow: 400,
          model: "deepseek-coder:6.7b",
          force: false,
          threshold: 0.75,
        });
        assert.equal(compacted.compacted, true);
        session.messages = compacted.newMessages;

        // Verify no message is left in streaming state
        assert.equal(session.messages.some((m) => m.streaming), false);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("ensures webview reducer never stays stuck in streaming, running, or approval state after error or idle transition", () => {
      let state = {
        ...initial,
        status: "running" as const,
        isCompacting: true,
        pendingApproval: {
          id: "call-1",
          name: "run_command",
          args: { command: "npm test" },
          status: "proposed" as const,
          sideEffecting: true,
        },
        messages: [
          { id: "u1", role: "user" as const, content: "Run tests", createdAt: 1 },
          { id: "a1", role: "assistant" as const, content: "Partial stream...", createdAt: 2, streaming: true },
        ],
      };

      // Dispatch an error event mid-stream
      state = reducer(state, {
        type: "error",
        payload: { message: "Network connection lost" },
      });

      assert.equal(state.status, "idle");
      assert.equal(state.pendingApproval, null);
      assert.equal(state.isCompacting, false);
      assert.equal(
        state.messages.some((m) => m.streaming),
        false,
        "All messages must have streaming=false after error"
      );

      // Also verify that sessionLoaded with streaming: false clears an existing streaming bubble
      const streamingState = {
        ...initial,
        activeSessionId: "sess-1",
        status: "running" as const,
        messages: [
          { id: "m1", role: "assistant" as const, content: "Still streaming", createdAt: 1, streaming: true },
        ],
      };
      const afterSessionLoad = reducer(streamingState, {
        type: "sessionLoaded",
        payload: {
          id: "sess-1",
          title: "Test",
          mode: "agent",
          model: "qwen2.5-coder:7b",
          createdAt: 1,
          updatedAt: 2,
          messages: [
            { id: "m1", role: "assistant", content: "Still streaming", notice: "Stopped.", createdAt: 1, streaming: false },
          ],
        },
      });
      assert.equal(afterSessionLoad.messages[0].streaming, false);

      const afterIdleStatus = reducer(streamingState, {
        type: "status",
        payload: { kind: "idle" },
      });
      assert.equal(afterIdleStatus.status, "idle");
      assert.equal(afterIdleStatus.messages[0].streaming, false);
    });

    it("sanitizeToolPairing preserves paired tool calls and eliminates orphaned/unanswered calls", () => {
      // 1. Empty input
      assert.deepEqual(sanitizeToolPairing([]), []);

      // 2. Orphaned tool message with no preceding assistant
      const orphaned: LLMMessage[] = [
        { role: "user", content: "Hello" },
        { role: "tool", tool_call_id: "call_orphan", content: "Result" },
      ];
      const sanitizedOrphan = sanitizeToolPairing(orphaned);
      assert.equal(sanitizedOrphan.length, 1);
      assert.equal(sanitizedOrphan[0].role, "user");

      // 3. Assistant with un-responded tool call (e.g. truncated history)
      const unresponded: LLMMessage[] = [
        {
          role: "assistant",
          content: "Let me check that file",
          tool_calls: [
            {
              id: "call_123",
              function: { name: "read_file", arguments: { path: "package.json" } },
            },
          ],
        },
      ];
      const sanitizedUnresponded = sanitizeToolPairing(unresponded);
      assert.equal(sanitizedUnresponded.length, 2);
      assert.equal(sanitizedUnresponded[0].role, "assistant");
      assert.equal(sanitizedUnresponded[1].role, "tool");
      assert.equal(sanitizedUnresponded[1].tool_call_id, "call_123");
      assert.ok(sanitizedUnresponded[1].content.includes("package.json") || sanitizedUnresponded[1].content.includes("read_file"));

      // 4. Properly paired tool call remains unchanged
      const paired: LLMMessage[] = [
        { role: "user", content: "Search for tests" },
        {
          role: "assistant",
          content: "Searching...",
          tool_calls: [
            { id: "call_abc", function: { name: "search", arguments: { query: "test" } } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_abc",
          name: "search",
          content: "Found 3 files",
        },
      ];
      const sanitizedPaired = sanitizeToolPairing(paired);
      assert.equal(sanitizedPaired.length, 3);
      assert.equal(sanitizedPaired[1].tool_calls?.[0].id, "call_abc");
      assert.equal(sanitizedPaired[2].tool_call_id, "call_abc");
      assert.equal(sanitizedPaired[2].content, "Found 3 files");

      // 5. Multi-tool calls where only 1 is answered: missing tool call is synthesized
      const partial: LLMMessage[] = [
        {
          role: "assistant",
          content: "Running checks",
          tool_calls: [
            { id: "c1", function: { name: "read_file", arguments: { path: "a.ts" } } },
            { id: "c2", function: { name: "read_file", arguments: { path: "b.ts" } } },
          ],
        },
        { role: "tool", tool_call_id: "c1", name: "read_file", content: "content of a.ts" },
      ];
      const sanitizedPartial = sanitizeToolPairing(partial);
      assert.equal(sanitizedPartial.length, 3);
      assert.equal(sanitizedPartial[1].tool_call_id, "c1");
      assert.equal(sanitizedPartial[1].content, "content of a.ts");
      assert.equal(sanitizedPartial[2].tool_call_id, "c2");
      assert.ok(sanitizedPartial[2].content.includes("read_file"));
    });

    it("isLocalModel accurately classifies models across local runtimes and cloud prefixes", () => {
      // Local models
      assert.equal(isLocalModel({ name: "qwen2.5-coder:7b", provider: "ollama" }), true);
      assert.equal(isLocalModel({ name: "deepseek-r1:8b" }), true);
      assert.equal(isLocalModel({ name: "llamacpp:my-model.gguf", provider: "llamacpp" }), true);
      assert.equal(isLocalModel(null), true);
      assert.equal(isLocalModel(undefined), true);

      // Cloud models without explicit provider field (using model name prefix)
      assert.equal(isLocalModel({ name: "nvidia:meta/llama-3.1-70b-instruct" }), false);
      assert.equal(isLocalModel({ name: "gemini:gemini-1.5-pro" }), false);
      assert.equal(isLocalModel({ name: "anthropic:claude-3-5-sonnet" }), false);
      assert.equal(isLocalModel({ name: "openai:gpt-4o" }), false);
      assert.equal(isLocalModel({ name: "groq:llama-3.1-70b" }), false);
      assert.equal(isLocalModel({ name: "custom-provider:mistral-large" }), false);
    });

    it("ApprovalService remembers approvals by tool name when remember=true is specified", async () => {
      const approvals = new ApprovalService(false);
      assert.equal(approvals.autoApprove, false);

      const call1: ToolCall = {
        id: "call-cmd-1",
        name: "run_command",
        args: { command: "npm test" },
        status: "proposed",
        sideEffecting: true,
      };

      let posted = false;
      const p1 = approvals.requestApproval(call1, () => {
        posted = true;
      });
      assert.equal(posted, true);
      assert.equal(approvals.pendingCount, 1);

      // Resolve with remember = true and toolName = "run_command"
      approvals.resolveApproval(call1.id, true, true, "run_command");
      const res1 = await p1;
      assert.equal(res1, true);

      // Next call with run_command should be auto-approved without posting
      const call2: ToolCall = {
        id: "call-cmd-2",
        name: "run_command",
        args: { command: "git status" },
        status: "proposed",
        sideEffecting: true,
      };

      let posted2 = false;
      const res2 = await approvals.requestApproval(call2, () => {
        posted2 = true;
      });
      assert.equal(posted2, false, "Should not post approval request for remembered tool");
      assert.equal(res2, true);

      // An unapproved tool name (e.g. "write_file") still requires approval
      const call3: ToolCall = {
        id: "call-write-1",
        name: "write_file",
        args: { path: "test.txt", content: "data" },
        status: "proposed",
        sideEffecting: true,
      };
      // Note: when remember=true was passed above, autoApprove is also enabled as session-wide allow.
      // Reset autoApprove to verify tool name memory independently:
      approvals.autoApprove = false;
      let posted3 = false;
      const p3 = approvals.requestApproval(call3, () => {
        posted3 = true;
      });
      assert.equal(posted3, true, "Unremembered tool must prompt when autoApprove is false");
      approvals.resolveApproval(call3.id, false);
      const res3 = await p3;
      assert.equal(res3, false);
    });

    it("store reducer _setModel updates config.autoSelectModel safely without root pollution", () => {
      let state = {
        ...initial,
        selectedModel: "qwen2.5-coder:7b",
        config: {
          ...initial.config,
          autoSelectModel: true,
        },
      };

      state = reducer(state, {
        type: "_setModel",
        model: "deepseek-coder:14b",
      });

      assert.equal(state.selectedModel, "deepseek-coder:14b");
      assert.equal(state.config.autoSelectModel, false);
      assert.equal((state as any).autoSelectModel, undefined, "Root AppState must not have autoSelectModel");
    });
  });
});
