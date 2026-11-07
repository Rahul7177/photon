import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shouldAutoCompact,
  extractCompactionCandidates,
  extractStructuredCompactionData,
  buildNativeCompactionSummary,
  compactSessionMessages,
  isToolResultMessage,
  isUsableProviderSummary,
} from "../../src/core/agent/compactor";
import type { ChatMessage, ToolCall } from "../../src/shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";

function makeUserMsg(id: string, content: string): ChatMessage {
  return { id, role: "user", content, createdAt: Date.now() };
}

function makeAssistantMsg(id: string, content: string, toolCalls?: ToolCall[]): ChatMessage {
  return { id, role: "assistant", content, toolCalls, createdAt: Date.now() };
}

describe("Context Compaction Engine (P1 Item 4)", () => {
  describe("shouldAutoCompact", () => {
    it("returns false for short conversations below minimum messages limit", () => {
      const msgs = [
        makeUserMsg("1", "Hello"),
        makeAssistantMsg("2", "Hi! How can I help?"),
      ];
      assert.equal(shouldAutoCompact(msgs, 4096), false);
    });

    it("returns false when token fill ratio is below 75% of active model's context limit", () => {
      const msgs = [
        makeUserMsg("1", "First task"),
        makeAssistantMsg("2", "Working on it"),
        makeUserMsg("3", "Next step"),
        makeAssistantMsg("4", "Done"),
      ];
      assert.equal(shouldAutoCompact(msgs, 4096, "qwen2.5-coder:7b", 0.75), false);
    });

    it("triggers at 75% of the active model's actual context limit", () => {
      const largeText = "const data = ".repeat(300); // ~1000 tokens
      const msgs = [
        makeUserMsg("1", "Initial prompt: refactor the codebase"),
        makeAssistantMsg("2", largeText),
        makeUserMsg("3", "Follow-up instruction"),
        makeAssistantMsg("4", "Final status update"),
      ];
      // Exceeds 75% of 1000 token window, but is well below 75% of 32768 token window
      assert.equal(shouldAutoCompact(msgs, 1000, "llama3:8b", 0.75), true);
      assert.equal(shouldAutoCompact(msgs, 32768, "gemini:gemini-2.5-pro", 0.75), false);
    });

    it("respects custom threshold", () => {
      const text = "word ".repeat(150);
      const msgs = [
        makeUserMsg("1", "Task anchor"),
        makeAssistantMsg("2", text),
        makeUserMsg("3", "Step 2"),
        makeAssistantMsg("4", text),
      ];
      assert.equal(shouldAutoCompact(msgs, 1000, undefined, 0.5), false);
      assert.equal(shouldAutoCompact(msgs, 1000, undefined, 0.3), true);
    });
  });

  describe("extractCompactionCandidates & Tool-Call/Tool-Result Pairing", () => {
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

    it("identifies synthetic tool-result messages and never splits tool calls from their tool results", () => {
      const toolResultMsg = makeUserMsg(
        "4",
        '<photon:result name="read_file" status="ok">\nexport const x = 1;\n</photon:result>'
      );
      assert.equal(isToolResultMessage(toolResultMsg), true);

      const msgs: ChatMessage[] = [
        makeUserMsg("1", "Original task: fix parser bug"),
        makeAssistantMsg("2", "Let me check the files."),
        makeUserMsg("3", "Please inspect parse.ts"),
        makeAssistantMsg("4", "Reading parse.ts...", [
          { id: "tc1", name: "read_file", args: { path: "src/parse.ts" }, status: "done" },
        ]),
        // Synthetic user message carrying tool output followed by assistant response:
        toolResultMsg,
        makeAssistantMsg("5", "Found the bug in parse.ts."),
        makeUserMsg("6", "Great, now run tests"),
        makeAssistantMsg("7", "Tests passed."),
      ];

      // Even if we request keeping 2 recent user turns, the boundary must not land on `toolResultMsg`
      // without also keeping the preceding assistant tool-call message `4` (or keeping genuine user turn `3`).
      const { toCompact, recent, canCompact } = extractCompactionCandidates(msgs, 1);
      assert.equal(canCompact, true);
      // Verify recent starts with a genuine user turn, never an orphaned tool result
      assert.equal(recent[0].role, "user");
      assert.equal(isToolResultMessage(recent[0]), false);

      // Now test when recent window encompasses the tool call turn:
      const cand2 = extractCompactionCandidates(msgs, 2);
      assert.equal(cand2.canCompact, true);
      assert.equal(cand2.recent[0].id, "3");
      // Assistant message 4 (with toolCalls) and toolResultMsg stay paired together in `recent`
      const recentIds = cand2.recent.map((m) => m.id);
      assert.ok(recentIds.includes("4"));
    });

    it("shifts split index back if an assistant tool-call message precedes a tool-result at the boundary", () => {
      const msgs: ChatMessage[] = [
        makeUserMsg("1", "Anchor task"),
        makeAssistantMsg("2", "Step 1 done"),
        makeUserMsg("3", "Run check"),
        makeAssistantMsg("4", "Calling tool", [
          { id: "tc1", name: "read_file", args: { path: "a.ts" }, status: "done" },
        ]),
        { id: "5", role: "tool", content: "file content", createdAt: Date.now() },
        makeUserMsg("6", "Latest prompt"),
        makeAssistantMsg("7", "Latest answer"),
      ];

      const { toCompact, recent } = extractCompactionCandidates(msgs, 1);
      // `4` and `5` must both be in `toCompact` (not split across `toCompact` and `recent`)
      assert.ok(toCompact.some((m) => m.id === "4"));
      assert.ok(toCompact.some((m) => m.id === "5"));
      assert.equal(recent[0].id, "6");
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

  describe("buildNativeCompactionSummary & Ground-Truth Separation", () => {
    it("distinguishes verified repository facts from model decisions/assumptions and preserves unresolved items", () => {
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
        makeAssistantMsg(
          "4",
          "We decided to use HS256 signing for backward compatibility because legacy clients expect symmetric tokens.\nTODO: Need to rotate the JWT secret in staging.",
          [
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
              result: "12 passing (45ms)",
            },
            {
              id: "tc4",
              name: "execute_command",
              args: { command: "npm run lint" },
              status: "error",
              error: "ESLint found 1 unused variable in src/services/auth.ts",
            },
          ]
        ),
      ];

      const summary = buildNativeCompactionSummary(msgs, "Focus on auth security", "Primary goal: Auth JWT refactor");
      const structured = extractStructuredCompactionData(msgs);

      // Verify all structured sections are present and distinguish facts vs assumptions
      assert.ok(summary.includes("### 🎯 Original Task & Objective"));
      assert.ok(summary.includes("Primary goal: Auth JWT refactor"));
      assert.ok(summary.includes("### 📌 Compaction Focus"));
      assert.ok(summary.includes("Focus on auth security"));
      assert.ok(summary.includes("### 📝 User Instructions & Constraints"));
      assert.ok(summary.includes("Do not break existing session storage"));
      assert.ok(summary.includes("### ✅ Verified Repository Facts (Ground Truth)"));
      assert.ok(summary.includes("`src/services/auth.ts`"));
      assert.ok(summary.includes("`npm test test/auth.test.ts` → ✓ Completed"));
      assert.ok(summary.includes("### 🧠 Model Decisions & Assumptions (Unverified Claims / Rationale)"));
      assert.ok(summary.includes("HS256 signing"));
      assert.ok(summary.includes("### ⚠️ Unresolved Issues & Pending Items"));
      assert.ok(summary.includes("ESLint found 1 unused variable"));
      assert.ok(summary.includes("TODO: Need to rotate the JWT secret"));

      // Check retained item counters
      assert.equal(structured.retainedItems.taskPreserved, true);
      assert.ok(structured.retainedItems.constraintsCount >= 2);
      assert.equal(structured.retainedItems.modifiedFilesCount, 1);
      assert.equal(structured.retainedItems.inspectedFilesCount, 1);
      assert.equal(structured.retainedItems.commandsCount, 2);
      assert.ok(structured.retainedItems.unresolvedCount >= 2);
    });

    it("rolls over previous compaction summaries across successive compaction rounds", () => {
      const msgs: ChatMessage[] = [
        {
          id: "c1",
          role: "assistant",
          content:
            "⚡ **[Context Compaction Summary]**\n\n### ✅ Verified Repository Facts (Ground Truth)\n- `src/db.ts`: Updated query pool",
          createdAt: Date.now() - 10000,
          notice: "Context compacted: 8 messages compressed",
          isCompacted: true,
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
      assert.ok(summary.includes("### 📜 Prior Compacted History"));
      assert.ok(summary.includes("`src/db.ts`: Updated query pool"));
      assert.ok(summary.includes("`src/cache.ts`: Created / overwritten file"));
    });

    it("maps command statuses explicitly and never reports unfinished commands as successful", () => {
      const msgs: ChatMessage[] = [
        makeUserMsg("1", "Deploy and test the service"),
        makeAssistantMsg("2", "Running deployment steps...", [
          {
            id: "tc1",
            name: "execute_command",
            args: { command: "git pull origin main" },
            status: "done",
          },
          {
            id: "tc2",
            name: "execute_command",
            args: { command: "npm test" },
            status: "error",
            error: "2 tests failed",
          },
          {
            id: "tc3",
            name: "execute_command",
            args: { command: "docker build -t app ." },
            status: "running",
          },
          {
            id: "tc4",
            name: "execute_command",
            args: { command: "kubectl apply -f k8s/" },
            status: "pending" as any,
          },
          {
            id: "tc5",
            name: "execute_command",
            args: { command: "terraform apply" },
            status: "proposed",
          },
          {
            id: "tc6",
            name: "execute_command",
            args: { command: "rm -rf /tmp/data" },
            status: "denied",
          },
          {
            id: "tc7",
            name: "execute_command",
            args: { command: "curl http://localhost:8080" },
            status: "unknown_status" as any,
          },
        ]),
      ];

      const data = extractStructuredCompactionData(msgs);
      assert.equal(data.commandsRun.length, 7);

      const statusMap = Object.fromEntries(
        data.commandsRun.map((c) => [c.command, c.status])
      );
      assert.equal(statusMap["git pull origin main"], "completed");
      assert.equal(statusMap["npm test"], "failed");
      assert.equal(statusMap["docker build -t app ."], "in_progress");
      assert.equal(statusMap["kubectl apply -f k8s/"], "awaiting_approval");
      assert.equal(statusMap["terraform apply"], "not_executed");
      assert.equal(statusMap["rm -rf /tmp/data"], "denied");
      assert.equal(statusMap["curl http://localhost:8080"], "unknown");

      const summary = buildNativeCompactionSummary(msgs);
      assert.ok(summary.includes("`git pull origin main` → ✓ Completed"));
      assert.ok(summary.includes("`npm test` → ✗ Failed (2 tests failed)"));
      assert.ok(summary.includes("`docker build -t app .` → ▶ In progress"));
      assert.ok(summary.includes("`kubectl apply -f k8s/` → ⏳ Awaiting approval"));
      assert.ok(summary.includes("`terraform apply` → ⏸ Not executed"));
      assert.ok(summary.includes("`rm -rf /tmp/data` → ⛔ Denied"));
      assert.ok(summary.includes("`curl http://localhost:8080` → ❓ Outcome unknown"));

      // Unfinished/error tools should be recorded in unresolved items
      assert.ok(summary.includes("### ⚠️ Unresolved Issues & Pending Items"));
      assert.ok(summary.includes("was left in progress"));
      assert.ok(summary.includes("was left awaiting approval"));
      assert.ok(summary.includes("was left not executed"));
      assert.ok(summary.includes("was denied by user"));
    });
  });

  describe("Provider Summary Validation & Fallback Handling", () => {
    it("rejects empty, overly short, or refusal/error provider outputs", () => {
      assert.equal(isUsableProviderSummary(null), false);
      assert.equal(isUsableProviderSummary(""), false);
      assert.equal(isUsableProviderSummary("Too short."), false);
      assert.equal(
        isUsableProviderSummary("I cannot fulfill this request because of safety guidelines and policy restrictions."),
        false
      );
      assert.equal(
        isUsableProviderSummary(
          "### 🎯 Original Task\n- Refactor auth module\n### ✅ Verified Repository Facts\n- Updated `src/auth.ts` and ran unit tests."
        ),
        true
      );
    });

    it("uses provider-model compaction when usable, appends omitted modified files, and falls back on unusable/failing output", async () => {
      // Provider that omits the modified file path from its prose summary
      const partialProvider: LLMProvider = {
        id: "gemini",
        label: "Google Gemini",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(_req: LLMChatRequest, _signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
          yield {
            done: false,
            message: {
              role: "assistant",
              content:
                "### 🎯 Model Summary\n- Refactored authentication logic and verified session persistence across endpoints.",
            },
          };
        },
      };

      const msgs = [
        makeUserMsg("1", "Goal: Deploy microservice"),
        makeAssistantMsg("2", "Step 1: edited service file", [
          { id: "tc1", name: "edit_file", args: { path: "src/criticalService.ts" }, status: "done" },
        ]),
        makeUserMsg("3", "Step 2: keep backward compatibility"),
        makeAssistantMsg("4", "Step 3: verified config"),
        makeUserMsg("5", "Recent turn"),
        makeAssistantMsg("6", "Recent turn done"),
      ];

      const resWorking = await compactSessionMessages({
        messages: msgs,
        contextWindow: 4096,
        model: "gemini:gemini-3.1-flash-lite-preview",
        provider: partialProvider,
        force: true,
      });

      assert.equal(resWorking.compacted, true);
      assert.equal(resWorking.strategy, "provider-model");
      assert.ok(resWorking.summary?.includes("Model Summary"));
      // Modified file path is guaranteed to be preserved even if provider omitted it!
      assert.ok(resWorking.summary?.includes("src/criticalService.ts"));
      assert.ok(resWorking.compactionNotice?.includes("1 modified file"));

      // Provider returning unusable refusal output -> falls back to native-heuristic
      const refusalProvider: LLMProvider = {
        id: "openai",
        label: "OpenAI",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(): AsyncGenerator<LLMChatChunk> {
          yield { done: false, message: { role: "assistant", content: "I'm sorry, I cannot summarize this conversation." } };
        },
      };

      const resRefusal = await compactSessionMessages({
        messages: msgs,
        contextWindow: 4096,
        model: "openai:gpt-4o-mini",
        provider: refusalProvider,
        force: true,
      });

      assert.equal(resRefusal.compacted, true);
      assert.equal(resRefusal.strategy, "native-heuristic");
      assert.ok(resRefusal.summary?.includes("src/criticalService.ts"));

      // Failing provider (network error) -> falls back to native-heuristic
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

      assert.equal(resFailing.compacted, true);
      assert.equal(resFailing.strategy, "native-heuristic");
      assert.ok(resFailing.summary?.includes("Original Task & Objective"));
    });
  });

  describe("Long-Session Multi-Step Compaction", () => {
    it("maintains valid message ordering, task continuity, and cumulative file tracking across multiple compactions", async () => {
      let messages: ChatMessage[] = [
        makeUserMsg("u1", "Build a complete payment processing module with Stripe and webhook verification"),
        makeAssistantMsg("a1", "Created payment types.", [
          { id: "t1", name: "write_file", args: { path: "src/payments/types.ts" }, status: "done" },
        ]),
        makeUserMsg("u2", "Constraint: All amounts must be stored in integer cents, never floating point"),
        makeAssistantMsg("a2", "Implemented Stripe client using integer cents.", [
          { id: "t2", name: "write_file", args: { path: "src/payments/stripeClient.ts" }, status: "done" },
        ]),
        makeUserMsg("u3", "Now implement the webhook handler"),
        makeAssistantMsg("a3", "Created webhook handler.", [
          { id: "t3", name: "write_file", args: { path: "src/payments/webhook.ts" }, status: "done" },
        ]),
        makeUserMsg("u4", "Add signature validation tests"),
        makeAssistantMsg("a4", "Added unit tests for webhook signature validation.", [
          { id: "t4", name: "execute_command", args: { command: "npm test test/webhook.test.ts" }, status: "done", result: "4 passing" },
        ]),
      ];

      // First compaction round
      const round1 = await compactSessionMessages({
        messages,
        contextWindow: 4096,
        force: true,
        keepRecentUserTurns: 1,
      });
      assert.equal(round1.compacted, true);
      messages = round1.newMessages;

      // Verify valid role alternation after Round 1
      for (let i = 1; i < messages.length; i++) {
        if (messages[i - 1].role === "user") {
          assert.equal(messages[i].role, "assistant", `Expected assistant after user at index ${i}`);
        }
      }

      // Append more turns in the long session
      messages.push(
        makeUserMsg("u5", "Add idempotency key tracking to prevent duplicate charges"),
        makeAssistantMsg("a5", "Added idempotency store.", [
          { id: "t5", name: "edit_file", args: { path: "src/payments/idempotency.ts" }, status: "done" },
        ]),
        makeUserMsg("u6", "Run full payment test suite"),
        makeAssistantMsg("a6", "One test failed due to missing mock secret.", [
          {
            id: "t6",
            name: "execute_command",
            args: { command: "npm test" },
            status: "error",
            error: "Missing STRIPE_WEBHOOK_SECRET in test env",
          },
        ]),
        makeUserMsg("u7", "Fix the test env secret"),
        makeAssistantMsg("a7", "Updated test setup with mock secret.")
      );

      // Second compaction round
      const round2 = await compactSessionMessages({
        messages,
        contextWindow: 4096,
        force: true,
        keepRecentUserTurns: 1,
      });
      assert.equal(round2.compacted, true);
      const finalMsgs = round2.newMessages;

      // Original anchor task is still message[0]
      assert.equal(finalMsgs[0].id, "u1");
      assert.ok(finalMsgs[0].content.includes("payment processing module"));

      // Compacted summary retains Round 1 files AND Round 2 files & unresolved test error
      const summaryMsg = finalMsgs.find((m) => m.isCompacted);
      assert.ok(summaryMsg);
      assert.ok(summaryMsg.content.includes("src/payments/types.ts"));
      assert.ok(summaryMsg.content.includes("src/payments/stripeClient.ts"));
      assert.ok(summaryMsg.content.includes("src/payments/idempotency.ts"));
      assert.ok(summaryMsg.content.includes("Missing STRIPE_WEBHOOK_SECRET"));
      assert.ok(summaryMsg.notice?.includes("Context compacted"));
      assert.ok(summaryMsg.notice?.includes("Retained task"));
    });
  });
});
