import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shouldAutoCompact,
  extractCompactionCandidates,
  extractStructuredCompactionData,
  buildNativeCompactionSummary,
  compactSessionMessages,
  compactMidTurnLLMHistory,
  isToolResultMessage,
  isUsableProviderSummary,
} from "../../src/core/agent/compactor";
import { runCloudTurn } from "../../src/core/agent/cloudEngine";
import { runUnifiedTurn } from "../../src/core/agent/unifiedEngine";
import { enforceSessionMessageCap } from "../../src/host/sessionCoordinator";
import type { AdaptivePlan, ChatMessage, SessionState, ToolCall } from "../../src/shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import type { Tool } from "../../src/core/tools/types";

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

    it("accounts for the pending turn and reserved completion before overflow", () => {
      const text = "word ".repeat(110); // roughly 143 tokens with message framing
      const msgs = [
        makeUserMsg("1", "Task anchor"),
        makeAssistantMsg("2", text),
        makeUserMsg("3", "Continue"),
        makeAssistantMsg("4", text),
      ];

      // Historical messages alone remain under 75% of a 1k window.
      assert.equal(shouldAutoCompact(msgs, 1000, undefined, 0.75), false);
      // The same history must compact before adding a 400-token prompt while
      // reserving 200 tokens for the response (usable input window = 800).
      assert.equal(
        shouldAutoCompact(msgs, 1000, undefined, 0.75, {
          incomingTokens: 400,
          reserveOutputTokens: 200,
        }),
        true
      );
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

  describe("Provider-summary fact retention", () => {
    it("appends omitted inspected paths, commands, and failures to a provider summary", async () => {
      const msgs: ChatMessage[] = [
        makeUserMsg("u1", "Fix the import issue without changing public APIs"),
        makeAssistantMsg("a1", "I inspected and tested it.", [
          {
            id: "read-1",
            name: "read_file",
            args: { path: "src/imports.ts" },
            status: "done",
            result: "import { legacy } from './legacy';",
          },
          {
            id: "test-1",
            name: "execute_command",
            args: { command: "npm test -- imports" },
            status: "error",
            error: "module not found",
          },
        ]),
        makeUserMsg("u2", "Try the supported module path"),
        makeAssistantMsg("a2", "Still investigating."),
      ];
      const terseProvider: LLMProvider = {
        id: "openai",
        label: "OpenAI",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(): AsyncGenerator<LLMChatChunk> {
          yield {
            done: false,
            message: { role: "assistant", content: "### Summary\n- Continuing the import investigation." },
          };
        },
      };

      const result = await compactSessionMessages({
        messages: msgs,
        contextWindow: 4096,
        model: "openai:gpt-4o-mini",
        provider: terseProvider,
        force: true,
        keepRecentUserTurns: 1,
      });

      assert.equal(result.strategy, "provider-model");
      assert.ok(result.summary?.includes("src/imports.ts"));
      assert.ok(result.summary?.includes("npm test -- imports"));
      assert.ok(result.summary?.includes("module not found"));
    });
  });

  describe("Phase 4.1: Compactor Fidelity, Fact Separation & Boundary Invariants", () => {
    it("accurately records source and destination for moves and prefers result metadata over model args", () => {
      const msgs: ChatMessage[] = [
        makeUserMsg("u1", "Reorganize the file tree"),
        makeAssistantMsg("a1", "Moving components and editing with metadata", [
          {
            id: "tc-move",
            name: "move_path",
            args: { from: "src/components/OldButton.tsx", to: "src/ui/Button.tsx" },
            status: "done",
            result: "Moved successfully",
          },
          {
            id: "tc-meta",
            name: "edit_file",
            args: { path: "typo_in_model_args.ts" },
            status: "done",
            result: "Replaced content",
            metadata: {
              path: "src/real/ResolvedPath.ts",
              changedLines: { start: 10, end: 25 },
            },
          } as any,
        ]),
      ];

      const data = extractStructuredCompactionData(msgs);

      // Verify move source and destination
      assert.ok(data.filesModified.has("src/components/OldButton.tsx"));
      assert.ok(data.filesModified.get("src/components/OldButton.tsx")?.some((d) => d.includes("Moved to `src/ui/Button.tsx`")));
      assert.ok(data.filesModified.has("src/ui/Button.tsx"));
      assert.ok(data.filesModified.get("src/ui/Button.tsx")?.some((d) => d.includes("Created by moving from `src/components/OldButton.tsx`")));

      // Verify metadata path preference
      assert.ok(data.filesModified.has("src/real/ResolvedPath.ts"), "Must use metadata path over model args");
      assert.equal(data.filesModified.has("typo_in_model_args.ts"), false, "Model typo path must not be recorded");
      assert.ok(data.filesModified.get("src/real/ResolvedPath.ts")?.some((d) => d.includes("lines 10-25")));
    });

    it("distinguishes inspected, attempted, modified, verified, and negative findings", () => {
      const msgs: ChatMessage[] = [
        makeUserMsg("u1", "Do not modify the database schema under any circumstances!"),
        makeAssistantMsg("a1", "Inspecting and trying operations", [
          // 1. Inspected file
          {
            id: "tc1",
            name: "read_file",
            args: { path: "src/config.ts" },
            status: "done",
            result: "export const port = 3000;",
          },
          // 2. Negative finding: file not found
          {
            id: "tc2",
            name: "read_file",
            args: { path: "src/legacy_db.ts" },
            status: "error",
            error: "ENOENT: no such file or directory",
          },
          // 3. Attempted/denied operation
          {
            id: "tc3",
            name: "write_file",
            args: { path: "prisma/schema.prisma", content: "new table" },
            status: "denied",
          },
          // 4. Proposed/not-executed operation
          {
            id: "tc4",
            name: "append_file",
            args: { path: "src/audit.log", content: "log entry" },
            status: "proposed",
          },
          // 5. Confirmed modified file
          {
            id: "tc5",
            name: "write_file",
            args: { path: "src/clean.ts", content: "export const ok = true;" },
            status: "done",
            result: "Wrote file",
          },
        ]),
      ];

      const data = extractStructuredCompactionData(msgs);

      // User constraints preserved
      assert.ok(data.userConstraints.some((c) => c.includes("Do not modify the database schema")));

      // Inspected files
      assert.ok(data.filesInspected.has("src/config.ts"));

      // Negative findings
      assert.ok(data.negativeFindings.some((n) => n.includes("legacy_db.ts")));

      // Only clean.ts is in filesModified
      assert.ok(data.filesModified.has("src/clean.ts"));
      assert.equal(data.filesModified.has("prisma/schema.prisma"), false, "Denied schema modification must NOT be marked modified");
      assert.equal(data.filesModified.has("src/audit.log"), false, "Proposed append must NOT be marked modified");

      // Attempted/denied/proposed are in unresolved
      const unresolved = data.unresolvedItems.join(" ");
      assert.ok(unresolved.includes("schema.prisma") && unresolved.includes("denied"));
      assert.ok(unresolved.includes("audit.log") && unresolved.includes("not executed"));

      // Native summary renders dedicated sections
      const summary = buildNativeCompactionSummary(msgs);
      assert.ok(summary.includes("### 🚫 Negative & Preservation Constraints"));
      assert.ok(summary.includes("### ✅ Verified Repository Facts"));
      assert.ok(summary.includes("### ⚠️ Unresolved Issues & Pending Items"));
    });

    it("redacts secrets and credentials from user directives and tool findings", () => {
      const msgs: ChatMessage[] = [
        makeUserMsg("u1", "Connect with key sk-proj-123456789012345678 and Bearer mySecretToken123456"),
        makeAssistantMsg("a1", "Connecting...", [
          {
            id: "tc1",
            name: "execute_command",
            args: { command: "curl -H 'Authorization: Bearer mySecretToken123456' https://api.internal.com" },
            status: "error",
            error: "Authentication failed for token: superSecretPass12345",
          },
        ]),
      ];

      const data = extractStructuredCompactionData(msgs);
      const summary = buildNativeCompactionSummary(msgs);

      // Verify no raw keys leaked in directives or commands
      assert.ok(!data.userDirectives.join(" ").includes("sk-proj-123456789012345678"));
      assert.ok(!data.commandsRun[0].command.includes("mySecretToken123456"));
      assert.ok(!summary.includes("sk-proj-123456789012345678"));
      assert.ok(!summary.includes("superSecretPass12345"));
      assert.ok(summary.includes("[REDACTED_KEY]") || summary.includes("[REDACTED]"));
    });
  });

  describe("Enterprise Compaction Parity (Archive Rollover, Active Fallback & Mid-Turn Recovery)", () => {
    it("preserves leading enforceSessionMessageCap archive digests across subsequent compactions", async () => {
      const messages: ChatMessage[] = [
        makeUserMsg("u0", "Original root objective: migrate auth tokens to RS256"),
        makeAssistantMsg("a0", "Migrated core signing helper.", [
          { id: "tc0", name: "edit_file", args: { path: "src/auth/jwtSigner.ts" }, status: "done" },
        ]),
        makeUserMsg("u1", "Add key rotation support"),
        makeAssistantMsg("a1", "Added rotation config."),
        makeUserMsg("u2", "Now audit middleware"),
        makeAssistantMsg("a2", "Audited middleware."),
        makeUserMsg("u3", "Latest prompt"),
        makeAssistantMsg("a3", "Latest reply."),
      ];

      const session: SessionState = {
        id: "s-archive",
        title: "Archive test",
        mode: "agent",
        messages,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Force persistence cap so index 0 becomes an assistant-role archive digest
      const archived = enforceSessionMessageCap(session, 5);
      assert.equal(archived, true);
      assert.equal(session.messages[0].isCompacted, true);
      assert.ok(session.messages[0].content.includes("src/auth/jwtSigner.ts"));

      // Subsequent compaction MUST NOT drop session.messages[0]!
      const comp2 = await compactSessionMessages({
        messages: session.messages,
        contextWindow: 4096,
        force: true,
        keepRecentUserTurns: 1,
      });
      assert.equal(comp2.compacted, true);
      const joined = comp2.newMessages.map((m) => m.content).join("\n");
      assert.ok(joined.includes("src/auth/jwtSigner.ts"), "Leading archive digest facts must survive next compaction");
    });

    it("falls back to active model when lightweight sibling model errors and preserves >8k transcripts", async () => {
      const requestedModels: string[] = [];
      let receivedPrompt = "";

      const fallbackProvider: LLMProvider = {
        id: "claude",
        label: "Claude",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
          requestedModels.push(req.model);
          if (req.model.includes("haiku")) {
            throw new Error("404 model_not_found");
          }
          receivedPrompt = req.messages.map((m) => m.content).join("\n");
          yield {
            done: true,
            message: {
              role: "assistant",
              content: "### 🎯 Summary\n- Successfully synthesized full transcript using active model fallback.",
            },
          };
        },
      };

      const msgs: ChatMessage[] = [
        makeUserMsg("u1", "Build analytics pipeline"),
        makeAssistantMsg("a1", "Step 1: " + "A".repeat(1800)),
        makeUserMsg("u2", "MIDDLE_MARKER_TOKEN_98765"),
        makeAssistantMsg("a2", "Step 2: " + "B".repeat(1800)),
        makeUserMsg("u3", "Keep logging enabled"),
        makeAssistantMsg("a3", "Step 3: " + "C".repeat(1800)),
        makeUserMsg("u4", "Final step"),
        makeAssistantMsg("a4", "Working on final step."),
      ];

      const res = await compactSessionMessages({
        messages: msgs,
        contextWindow: 128_000,
        model: "claude:claude-sonnet-4-5",
        provider: fallbackProvider,
        force: true,
        keepRecentUserTurns: 1,
      });

      assert.equal(res.compacted, true);
      assert.equal(res.strategy, "provider-model");
      assert.deepEqual(requestedModels, ["claude:claude-haiku-4-5", "claude:claude-sonnet-4-5"]);
      assert.ok(receivedPrompt.includes("MIDDLE_MARKER_TOKEN_98765"), "Dynamic transcript limit should retain >8k chars on 128k models");
    });

    it("avoids redundant auto-recompaction loops when history is already compacted", async () => {
      const msgs: ChatMessage[] = [
        makeUserMsg("u1", "Big initial task " + "word ".repeat(300)),
        {
          id: "c1",
          role: "assistant",
          content: "⚡ **[Context Compaction Summary]**\n\n### Summary\n- Earlier context",
          createdAt: Date.now(),
          isCompacted: true,
        },
        makeUserMsg("u2", "Latest large turn " + "word ".repeat(300)),
        makeAssistantMsg("a2", "Done " + "word ".repeat(300)),
      ];

      const res = await compactSessionMessages({
        messages: msgs,
        contextWindow: 1000,
        force: false,
      });
      assert.equal(res.compacted, false);
      assert.equal(res.reason, "already_compacted");
    });

    it("compacts mid-turn and recovers automatically from context overflow errors in Cloud Engine", async () => {
      let attempt = 0;
      const phases: string[] = [];
      let errorMsg = "";
      let finalOut = "";

      const provider: LLMProvider = {
        id: "openai",
        name: "OpenAI",
        chat: async () => ({ content: "" }),
        async *chatStream(req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
          // Compaction engine prompt check
          if (req.messages[0]?.content.includes("context compaction engine")) {
            yield {
              done: true,
              message: {
                role: "assistant",
                content: "### 🎯 Compaction Digest\n- Inspected `src/file1.ts` and `src/file2.ts`.",
              },
            };
            return;
          }
          attempt++;
          if (attempt <= 3) {
            yield {
              done: true,
              done_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: `c-${attempt}`, function: { name: "read_file", arguments: { path: `src/file${attempt}.ts` } } },
                ],
              },
            };
            return;
          }
          if (attempt === 4) {
            // Simulate API rejecting due to unexpected context length overflow
            throw Object.assign(new Error("400 Bad Request: maximum context length exceeded (context_length_exceeded)"), {
              status: 400,
            });
          }
          yield {
            done: true,
            done_reason: "stop",
            message: { role: "assistant", content: "Completed task cleanly after mid-turn compaction." },
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
        execute: async (args) => ({ ok: true, output: `contents of ${args.path}: ` + "x".repeat(400) }),
      };

      await runCloudTurn({
        provider,
        model: "openai:gpt-4o",
        system: "sys",
        history: [{ role: "user", content: "Inspect multiple files and summarize." }],
        tools: [readTool],
        contextWindow: 128_000,
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
          onDelta: (_, d) => { finalOut += d; },
          onContent: (_, c) => { finalOut += c; },
          onAssistantCancel: () => {},
          onPhase: (_, detail) => { if (detail) phases.push(detail); },
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

      assert.equal(errorMsg, "", "Cloud Engine must recover from context overflow instead of failing");
      assert.equal(attempt, 5);
      assert.ok(phases.some((p) => /compact/i.test(p)));
      assert.ok(finalOut.includes("Completed task cleanly after mid-turn compaction"));
    });

    it("recovers automatically from context overflow errors in Local Unified Engine", async () => {
      let attempt = 0;
      let errorMsg = "";
      let finalOut = "";

      const plan: AdaptivePlan = {
        model: "qwen2.5-coder:7b",
        mode: "chat",
        contextWindow: 8192,
        numCtx: 8192,
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1024,
        toolProtocol: "native",
        maxTools: 4,
        allowParallelTools: false,
        intelligence: "medium",
        intelligenceAuto: false,
        rationale: [],
      };

      const session = {
        messages: [
          makeUserMsg("u1", "Analyze module"),
          makeAssistantMsg("a1", "Checked part 1"),
          makeUserMsg("u2", "Check part 2"),
          makeAssistantMsg("a2", "Checked part 2"),
          makeUserMsg("u3", "Give final overview"),
        ],
      };

      const provider: LLMProvider = {
        id: "ollama",
        label: "Ollama",
        enabled: true,
        isConfigured: () => true,
        ping: async () => true,
        listModels: async () => [],
        async *chatStream(req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
          if (req.messages[0]?.content.includes("context compaction engine")) {
            yield {
              done: true,
              message: {
                role: "assistant",
                content: "### 🎯 Summary\n- Reviewed parts 1 and 2 successfully.",
              },
            };
            return;
          }
          attempt++;
          if (attempt === 1) {
            throw new Error("prompt is too long for context window");
          }
          yield {
            done: true,
            done_reason: "stop",
            message: { role: "assistant", content: "Overview complete after overflow recovery." },
          };
        },
      };

      await runUnifiedTurn(
        session,
        plan,
        {
          onAssistantStart: () => {},
          onDelta: (_, d) => { finalOut += d; },
          onContent: (_, c) => { finalOut += c; },
          onAssistantCancel: () => {},
          onPhase: () => {},
          onToolCall: () => {},
          onToolUpdate: () => {},
          onUsage: () => {},
          onGenerationStats: () => {},
          onDone: () => {},
          onError: (e) => { errorMsg = e; },
        },
        new AbortController().signal,
        {
          provider,
          tools: [],
          buildToolContext: (sig) => ({
            mode: "chat",
            workspaceRoot: "B:/repo",
            signal: sig,
            log: () => {},
            webSearchProvider: "duckduckgo",
            findFiles: async () => [],
            capability: "medium",
            getDiagnostics: async () => [],
            todos: [],
            requestApproval: async () => true,
          }),
          reserveOutputTokens: 1024,
        }
      );

      assert.equal(errorMsg, "");
      assert.equal(attempt, 2);
      assert.ok(session.messages.some((m) => m.isCompacted), "Session should hold compacted digest after overflow recovery");
      assert.ok(finalOut.includes("Overview complete after overflow recovery."));
    });
  });
});
