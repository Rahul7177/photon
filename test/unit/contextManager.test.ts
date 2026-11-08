import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  tokensOf,
  clampStructuredToolResult,
  fitToWindow,
} from "../../src/core/agent/contextManager";
import {
  estimateTokens,
  estimateMessageTokens,
  estimateToolSchemasTokens,
  TOKENS_PER_IMAGE,
} from "../../src/core/adaptive/tokens";
import type { LLMMessage } from "../../src/core/llm/types";
import type { ChatMessage } from "../../src/shared/types";

describe("Phase 4.2: Context Manager & Token Estimation Fidelity", () => {
  describe("Token Estimation for Code, Multimodal & Tool Schemas", () => {
    it("estimates higher token density for code-heavy and symbol-dense prompts", () => {
      const prose = "This is a normal paragraph with standard English words and spaces.";
      const code = "const res = arr.map((x) => ({ id: x.id, val: (x.val * 2) + [1, 2, 3][0] }));";

      const proseTokens = estimateTokens(prose);
      const codeTokens = estimateTokens(code);

      // Symbol-dense code should have higher ratio of tokens per character than plain prose
      assert.ok(codeTokens > 0);
      assert.ok(proseTokens > 0);
      assert.ok((codeTokens / code.length) >= (proseTokens / prose.length));
    });

    it("accurately accounts for multimodal image attachments (800 tokens per image)", () => {
      const textOnlyMsg: ChatMessage = {
        id: "msg-1",
        role: "user",
        content: "What is in this screenshot?",
        createdAt: Date.now(),
      };

      const withImageMsg: ChatMessage = {
        id: "msg-2",
        role: "user",
        content: "What is in this screenshot?",
        attachments: [
          { kind: "image", mimeType: "image/png", dataBase64: "dummyBase64Data" },
        ],
        createdAt: Date.now(),
      };

      const textTokens = estimateMessageTokens(textOnlyMsg);
      const imageTokens = estimateMessageTokens(withImageMsg);

      assert.equal(imageTokens - textTokens, TOKENS_PER_IMAGE);
    });

    it("tokensOf accounts for multimodal images in LLMMessage", () => {
      const msgWithoutImages: LLMMessage = {
        role: "user",
        content: "Inspect these charts.",
      };
      const msgWithImages: LLMMessage = {
        role: "user",
        content: "Inspect these charts.",
        images: ["img1_base64", "img2_base64"],
      };

      const tokens1 = tokensOf(msgWithoutImages);
      const tokens2 = tokensOf(msgWithImages);

      assert.equal(tokens2 - tokens1, 2 * TOKENS_PER_IMAGE);
    });

    it("tokensOf accounts for assistant thinking, tool calls, and tool results", () => {
      const msg: LLMMessage = {
        role: "assistant",
        content: "I will edit the file.",
        thinking: "Let me check the existing contents first.",
        tool_calls: [
          {
            id: "call_123",
            function: {
              name: "edit_file",
              arguments: { path: "src/app.ts", edit: "replace" },
            },
            thoughtSignature: "sig_abc",
          },
        ],
      };

      const tokens = tokensOf(msg);
      assert.ok(tokens > 30);

      const toolMsg: LLMMessage = {
        role: "tool",
        tool_call_id: "call_123",
        name: "edit_file",
        content: "Successfully updated src/app.ts",
      };
      const toolTokens = tokensOf(toolMsg);
      assert.ok(toolTokens > 10);
    });

    it("estimates tokens consumed by tool schemas accurately", () => {
      const tools = [
        {
          name: "read_file",
          description: "Read the contents of a file at path",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        {
          name: "edit_file",
          description: "Edit portions of a file",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              target: { type: "string" },
              replacement: { type: "string" },
            },
            required: ["path", "target", "replacement"],
          },
        },
      ];

      const schemaTokens = estimateToolSchemasTokens(tools);
      assert.ok(schemaTokens > 40 && schemaTokens < 500);
    });
  });

  describe("Structured Tool Result Clamping", () => {
    it("leaves content untouched when under maxChars", () => {
      const short = JSON.stringify({ ok: true, count: 5 });
      const clamped = clampStructuredToolResult(short, 1000);
      assert.equal(clamped, short);
    });

    it("clamps JSON array without cutting mid-object and keeps valid JSON", () => {
      const items = Array.from({ length: 40 }, (_, i) => ({
        id: i,
        name: `file_${i}.ts`,
        description: `This is a descriptive record number ${i} for testing context bounds.`,
      }));
      const rawJson = JSON.stringify(items, null, 2);
      assert.ok(rawJson.length > 3000);

      const clamped = clampStructuredToolResult(rawJson, 800);
      assert.ok(clamped.length <= 1200);

      // Must be valid JSON that parses cleanly
      const parsed = JSON.parse(clamped);
      assert.ok(Array.isArray(parsed));
      assert.ok(parsed.length > 0 && parsed.length < items.length);
      // The last element is the truncation indicator
      const last = parsed[parsed.length - 1];
      assert.ok(last._photon_truncated);
      assert.ok(last._photon_truncated.includes("omitted to fit context window"));
    });

    it("clamps JSON object with array property without breaking outer structure", () => {
      const obj = {
        status: "success",
        total: 50,
        results: Array.from({ length: 30 }, (_, i) => ({
          file: `src/core/module_${i}.ts`,
          matches: [`const val = ${i};`, `return val;`],
        })),
      };
      const rawJson = JSON.stringify(obj, null, 2);
      const clamped = clampStructuredToolResult(rawJson, 1000);

      const parsed = JSON.parse(clamped);
      assert.equal(parsed.status, "success");
      assert.ok(Array.isArray(parsed.results));
      assert.ok(parsed.results.length < 30);
      const last = parsed.results[parsed.results.length - 1];
      assert.ok(last._photon_truncated);
    });

    it("clamps line-oriented output at newline boundaries without cutting lines in half", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: Important log event message with timestamp 2026-11-08T12:00:${i < 10 ? "0" + i : i}`);
      const rawText = lines.join("\n");

      const clamped = clampStructuredToolResult(rawText, 1200);
      assert.ok(clamped.length <= 1500);
      assert.ok(clamped.includes("[Output truncated to stay within context budget:"));

      // Head and tail should both be preserved
      assert.ok(clamped.startsWith("Line 1:"));
      assert.ok(clamped.endsWith("Line 100: Important log event message with timestamp 2026-11-08T12:00:99"));
    });
  });

  describe("fitToWindow Preservations, Priorities & Context Budgets", () => {
    it("never removes the active user request even under severe context pressure", () => {
      const system: LLMMessage = { role: "system", content: "You are Photon." };
      const history: LLMMessage[] = [
        { role: "user", content: "Initial greeting from long ago: " + "X".repeat(400) },
        { role: "assistant", content: "Hello! How can I assist you today? " + "Y".repeat(400) },
        { role: "user", content: "Turn 2 query that is old: " + "Z".repeat(400) },
        { role: "assistant", content: "Turn 2 response: " + "W".repeat(400) },
        { role: "user", content: "ACTIVE REQUEST: Fix the bug in auth.ts immediately!" },
        {
          role: "assistant",
          content: "I'll read auth.ts",
          tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: { path: "auth.ts" } } }],
        },
        { role: "tool", tool_call_id: "call_1", name: "read_file", content: "export function auth() { return false; }" },
      ];

      // Constrained budget (reserve 256 for output, budgetTokens 350)
      const res = fitToWindow(system, history, 350, 1024, "qwen2.5-coder:7b", {
        preserveFirstUser: false,
        reserveOutputTokens: 256,
      });

      const userMessages = res.messages.filter((m) => m.role === "user");

      // Active user request MUST be in the kept messages
      assert.ok(userMessages.some((m) => m.content.includes("ACTIVE REQUEST: Fix the bug in auth.ts")));
      // System must be kept
      assert.equal(res.messages[0].role, "system");
      assert.equal(res.messages[0].content, "You are Photon.");
      assert.ok(res.droppedCount > 0);
    });

    it("preserves conversation anchor when preserveFirstUser is true", () => {
      const system: LLMMessage = { role: "system", content: "System prompt." };
      const history: LLMMessage[] = [
        { role: "user", content: "ANCHOR REQUEST: Build a compiler in TypeScript." },
        { role: "assistant", content: "Sure, let's start with lexer." },
        { role: "user", content: "Middle turn 1" },
        { role: "assistant", content: "Middle response 1" },
        { role: "user", content: "Middle turn 2" },
        { role: "assistant", content: "Middle response 2" },
        { role: "user", content: "ACTIVE REQUEST: Add parser tests." },
      ];

      const res = fitToWindow(system, history, 600, 2048, undefined, {
        preserveFirstUser: true,
      });

      const userMessages = res.messages.filter((m) => m.role === "user");
      assert.ok(userMessages.some((m) => m.content.includes("ANCHOR REQUEST")));
      assert.ok(userMessages.some((m) => m.content.includes("ACTIVE REQUEST")));
    });

    it("clamps oversized intermediate tool results first before dropping conversational messages", () => {
      const system: LLMMessage = { role: "system", content: "System" };
      const hugeOutput = "A".repeat(8000);
      const history: LLMMessage[] = [
        { role: "user", content: "Please read the big log." },
        {
          role: "assistant",
          content: "Reading log...",
          tool_calls: [{ id: "call_log", function: { name: "read_file", arguments: { path: "big.log" } } }],
        },
        { role: "tool", tool_call_id: "call_log", name: "read_file", content: hugeOutput },
        { role: "assistant", content: "I analyzed the log." },
        { role: "user", content: "ACTIVE REQUEST: What was the error?" },
      ];

      // Budget is 1200 tokens (8000 chars is ~2000 tokens so it exceeds 1200; clamping to 2400 chars makes it ~600 tokens so it fits)
      const res = fitToWindow(system, history, 1200, 2048, undefined, {
        preserveFirstUser: true,
        reserveOutputTokens: 256,
      });

      // No conversational messages should be dropped because clamping the tool was sufficient
      assert.equal(res.droppedCount, 0);
      const toolMsg = res.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg);
      assert.ok(toolMsg.content.length < 3000);
      assert.ok(toolMsg.content.includes("Output truncated to stay within context budget"));
    });

    it("strictly preserves required tool-call and tool-result pairing", () => {
      const system: LLMMessage = { role: "system", content: "System" };
      const history: LLMMessage[] = [
        { role: "user", content: "Run tests." },
        {
          role: "assistant",
          content: "Running tests",
          tool_calls: [
            { id: "call_test1", function: { name: "terminal", arguments: { command: "npm test" } } },
            { id: "call_test2", function: { name: "terminal", arguments: { command: "npm run lint" } } },
          ],
        },
        { role: "tool", tool_call_id: "call_test1", name: "terminal", content: "Tests passed: 10/10" },
        { role: "tool", tool_call_id: "call_test2", name: "terminal", content: "Lint clean: 0 warnings" },
      ];

      const res = fitToWindow(system, history, 2000, 4096, undefined, {
        preserveFirstUser: true,
      });

      const assistantMsg = res.messages.find((m) => m.tool_calls);
      assert.ok(assistantMsg && assistantMsg.tool_calls);
      const toolMsgs = res.messages.filter((m) => m.role === "tool");

      // For every tool_call in assistant, there must be a matching tool message with tool_call_id
      for (const call of assistantMsg.tool_calls) {
        assert.ok(toolMsgs.some((tm) => tm.tool_call_id === call.id));
      }
    });

    it("distinguishes model context capacity from configured runtime capacity", () => {
      const system: LLMMessage = { role: "system", content: "System" };
      const history: LLMMessage[] = [{ role: "user", content: "Hi" }];

      // Model architecture capacity is 4096, but runtime was requested with 16384
      const res = fitToWindow(system, history, 0, 16384, undefined, {
        modelCapacity: 4096,
        runtimeCapacity: 16384,
      });

      // Window should be clamped to 4096 (the hardware/model boundary)
      assert.equal(res.usage.window, 4096);
    });

    it("handles large 256k contexts and accounts for large tool schemas", () => {
      const system: LLMMessage = { role: "system", content: "System" };
      const history: LLMMessage[] = [
        { role: "user", content: "Task in large context" },
        { role: "assistant", content: "Response in large context" },
      ];

      // Unusually large tool schema (e.g. 50 MCP tools taking 12,000 tokens)
      const res = fitToWindow(system, history, 0, 262144, undefined, {
        toolSchemasTokens: 12000,
        reserveOutputTokens: 4096,
      });

      assert.equal(res.usage.window, 262144);
      const schemaEntry = res.usage.breakdown.find((b) => b.label === "Tool schemas");
      assert.ok(schemaEntry);
      assert.equal(schemaEntry.tokens, 12000);
      assert.ok(res.usage.used > 12000);
    });

    it("handles missing limits (window=0, budget=0) by defaulting safely", () => {
      const system: LLMMessage = { role: "system", content: "System" };
      const history: LLMMessage[] = [{ role: "user", content: "Hello" }];

      const res = fitToWindow(system, history, 0, 0);
      assert.ok(res.usage.window >= 4096);
      assert.ok(res.messages.length >= 2);
      assert.equal(res.droppedCount, 0);
    });
  });
});
