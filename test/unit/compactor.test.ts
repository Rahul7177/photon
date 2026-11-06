import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shouldAutoCompact,
  extractCompactionCandidates,
  buildNativeCompactionSummary,
  summarizeWithProviderModel,
  compactSessionMessages,
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  MIN_MESSAGES_FOR_COMPACTION,
} from "../../src/core/agent/compactor";
import type { ChatMessage, ToolCall } from "../../src/shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";

function makeUserMsg(id: string, content: string): ChatMessage {
  return { id, role: "user", content, createdAt: Date.now() };
}

function makeAssistantMsg(id: string, content: string, toolCalls?: ToolCall[]): ChatMessage {
  return { id, role: "assistant", content, toolCalls, createdAt: Date.now() };
}

describe("Context Compaction Engine (Copilot & Claude Code Inspired)", () => {
  describe("shouldAutoCompact", () => {
    it("returns false for short conversations below minimum messages limit", () => {
      const msgs = [
        makeUserMsg("1", "Hello"),
        makeAssistantMsg("2", "Hi! How can I help?"),
      ];
      assert.equal(shouldAutoCompact(msgs, 4096), false);
    });

    it("returns false when token fill ratio is below threshold", () => {
      const msgs = [
        makeUserMsg("1", "First task"),
        makeAssistantMsg("2", "Working on it"),
        makeUserMsg("3", "Next step"),
        makeAssistantMsg("4", "Done"),
      ];
      // 4 messages is ~60 tokens, well below 75% of 4096
      assert.equal(shouldAutoCompact(msgs, 4096, undefined, 0.75), false);
    });

    it("returns true when token fill ratio reaches or exceeds threshold", () => {
      // Create a conversation with large content to exceed 75% of 1000 tokens (750 tokens)
      const largeText = "const data = ".repeat(300); // ~1000 tokens
      const msgs = [
        makeUserMsg("1", "Initial prompt: refactor the codebase"),
        makeAssistantMsg("2", largeText),
        makeUserMsg("3", "Follow-up instruction"),
        makeAssistantMsg("4", "Final status update"),
      ];
      assert.equal(shouldAutoCompact(msgs, 1000, undefined, 0.75), true);
    });

    it("respects custom threshold", () => {
      const text = "word ".repeat(150); // ~150-200 tokens
      const msgs = [
        makeUserMsg("1", "Task anchor"),
        makeAssistantMsg("2", text),
        makeUserMsg("3", "Step 2"),
        makeAssistantMsg("4", text),
      ];
      // ~400 tokens / 1000 = ~40%
      assert.equal(shouldAutoCompact(msgs, 1000, undefined, 0.5), false);
      assert.equal(shouldAutoCompact(msgs, 1000, undefined, 0.3), true);
    });
  });

  describe("extractCompactionCandidates", () => {
    it("partitions conversation into anchor, middle toCompact, and recent turns", () => {
      const msgs = [
        makeUserMsg("1", "Original task: refactor database queries"), // Anchor
        makeAssistantMsg("2", "Examining files..."),
        makeUserMsg("3", "Make sure indexes are preserved"),
        makeAssistantMsg("4", "Indexes preserved."),
        makeUserMsg("5", "Now optimize cache"), // Recent turn 1
        makeAssistantMsg("6", "Cache optimized."), // Recent turn 2
      ];

      const { anchor, toCompact, recent, canCompact } = extractCompactionCandidates(msgs, 1);
      assert.equal(canCompact, true);
      assert.ok(anchor);
      assert.equal(anchor?.id, "1");
      assert.equal(toCompact.length, 3); // msgs 2, 3, 4
      assert.equal(recent.length, 2); // msgs 5, 6
    });

    it("handles short histories gracefully without corrupting messages", () => {
      const msgs = [
        makeUserMsg("1", "One"),
        makeAssistantMsg("2", "Two"),
      ];
      const result = extractCompactionCandidates(msgs);
      assert.equal(result.canCompact, false);
    });
  });

  describe("buildNativeCompactionSummary", () => {
    it("deterministically extracts user directives, modified files, inspected files, and commands", () => {
      const msgs: ChatMessage[] = [
        makeUserMsg("1", "Refactor user authentication service to use JWT tokens"),
        makeAssistantMsg("2", "I will inspect the existing auth files.", [
          {
            id: "tc1",
            name: "read_file",
            args: { path: "src/services/auth.ts" },
            status: "done",
            result: "export class AuthService { login() {} }",
          },
        ]),
        makeUserMsg("3", "Do not break existing session storage"),
        makeAssistantMsg("4", "Implemented JWT token creation and preserved session compatibility.", [
          {
            id: "tc2",
            name: "replace_in_file",
            args: { path: "src/services/auth.ts", find: "login() {}", replace: "login() { signJwt(); }" },
            status: "done",
          },
          {
            id: "tc3",
            name: "execute_command",
            args: { command: "npm test test/auth.test.ts" },
            status: "done",
          },
        ]),
      ];

      const summary = buildNativeCompactionSummary(msgs, "Focus on auth security", "Primary goal: Auth JWT refactor");

      // Verify all structured sections are present and accurate
      assert.ok(summary.includes("### 🎯 Task Objective & Scope"));
      assert.ok(summary.includes("Primary goal: Auth JWT refactor"));
      assert.ok(summary.includes("### 📌 Compaction Focus"));
      assert.ok(summary.includes("Focus on auth security"));
      assert.ok(summary.includes("### 📝 User Directives & Constraints"));
      assert.ok(summary.includes("Do not break existing session storage"));
      assert.ok(summary.includes("### 🛠️ Files Modified & Created"));
      assert.ok(summary.includes("`src/services/auth.ts`"));
      assert.ok(summary.includes("### 🔍 Key Files & Searches Inspected"));
      assert.ok(summary.includes("`src/services/auth.ts`"));
      assert.ok(summary.includes("### 💻 Commands & Validations"));
      assert.ok(summary.includes("`npm test test/auth.test.ts` → ✓ Success"));
    });

    it("rolls over previous compaction summaries across successive compaction rounds", () => {
      const msgs: ChatMessage[] = [
        {
          id: "c1",
          role: "assistant",
          content: "⚡ **[Context Compaction Summary]**\n\n### 🛠️ Files Modified & Created\n- `src/db.ts`: Updated query pool",
          createdAt: Date.now() - 10000,
          notice: "⚡ Context compacted: 8 messages compressed",
        },
        makeUserMsg("2", "Now add caching"),
        makeAssistantMsg("3", "Implemented Redis cache layer.", [
          {
            id: "tc4",
            name: "write_to_file",
            args: { path: "src/cache.ts", content: "export class Cache {}" },
            status: "done",
          },
        ]),
      ];

      const summary = buildNativeCompactionSummary(msgs, undefined, "Full stack modernization");
      assert.ok(summary.includes("### 📜 Previous Conversation History"));
      assert.ok(summary.includes("`src/db.ts`: Updated query pool"));
      assert.ok(summary.includes("`src/cache.ts`: Created / overwritten file"));
    });
  });

  describe("compactSessionMessages", () => {
    it("returns not_needed when below threshold and not forced", async () => {
      const msgs = [
        makeUserMsg("1", "Hello"),
        makeAssistantMsg("2", "Hi!"),
        makeUserMsg("3", "What is 2+2?"),
        makeAssistantMsg("4", "4"),
      ];

      const result = await compactSessionMessages({
        messages: msgs,
        contextWindow: 16384,
        force: false,
      });

      assert.equal(result.compacted, false);
      assert.equal(result.reason, "not_needed");
      assert.equal(result.newMessages.length, msgs.length);
    });

    it("compacts successfully when forced (manual command)", async () => {
      const msgs = [
        makeUserMsg("1", "Anchor: Build a REST API"),
        makeAssistantMsg("2", "Reading existing router...", [
          { id: "c1", name: "read_file", args: { path: "routes.ts" }, status: "done" },
        ]),
        makeUserMsg("3", "Add rate limiting"),
        makeAssistantMsg("4", "Added rate limiter middleware", [
          { id: "c2", name: "edit_file", args: { path: "limiter.ts" }, status: "done" },
        ]),
        makeUserMsg("5", "Recent: Now run tests"),
        makeAssistantMsg("6", "Recent: Tests pass."),
      ];

      const result = await compactSessionMessages({
        messages: msgs,
        contextWindow: 8192,
        force: true,
      });

      assert.equal(result.compacted, true);
      assert.equal(result.reason, "manual");
      assert.ok(result.tokensSaved >= 0);
      assert.ok(result.newMessages.length < msgs.length);

      // Verify anchor is preserved
      assert.equal(result.newMessages[0].id, "1");

      // Verify compaction summary message is present
      const compMsg = result.newMessages[1];
      assert.ok(compMsg.content.includes("[Context Compaction Summary]"));
      assert.equal(compMsg.isCompacted, true);
      assert.ok(compMsg.compactStats);
      assert.ok(compMsg.compactStats.messagesCount > 0);

      // Verify role alternation (recent[0] is user "5", so compMsg must be assistant)
      assert.equal(compMsg.role, "assistant");

      // Verify recent turns are preserved verbatim
      assert.equal(result.newMessages[result.newMessages.length - 2].id, "5");
      assert.equal(result.newMessages[result.newMessages.length - 1].id, "6");
    });

    it("uses provider-model compaction when provider succeeds, and falls back to native if it fails", async () => {
      // Mock working provider
      const workingProvider: LLMProvider = {
        id: "gemini",
        label: "Google Gemini",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(_req: LLMChatRequest, _signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
          yield { done: false, message: { role: "assistant", content: "### 🎯 Model Summary\n- Compacted auth and cache steps cleanly." } };
        },
      };

      const msgs = [
        makeUserMsg("1", "Goal: Deploy microservice"),
        makeAssistantMsg("2", "Step 1"),
        makeUserMsg("3", "Step 2"),
        makeAssistantMsg("4", "Step 3"),
        makeUserMsg("5", "Recent turn"),
        makeAssistantMsg("6", "Recent turn done"),
      ];

      const resWorking = await compactSessionMessages({
        messages: msgs,
        contextWindow: 4096,
        model: "gemini:gemini-3.1-flash-lite-preview",
        provider: workingProvider,
        force: true,
      });

      assert.equal(resWorking.compacted, true);
      assert.equal(resWorking.strategy, "provider-model");
      assert.ok(resWorking.summary?.includes("Model Summary"));

      // Mock failing provider (simulates network failure or timeout)
      const failingProvider: LLMProvider = {
        id: "claude",
        label: "Anthropic Claude",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(): AsyncGenerator<LLMChatChunk> {
          throw new Error("Network timeout 504 Gateway Timeout");
        },
      };

      const resFailing = await compactSessionMessages({
        messages: msgs,
        contextWindow: 4096,
        model: "claude:claude-3-5-haiku",
        provider: failingProvider,
        force: true,
      });

      // Seamlessly falls back to native heuristic
      assert.equal(resFailing.compacted, true);
      assert.equal(resFailing.strategy, "native-heuristic");
      assert.ok(resFailing.summary?.includes("Task Objective & Scope"));
    });
  });
});
