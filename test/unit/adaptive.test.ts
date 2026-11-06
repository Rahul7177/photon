import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeOptimalContextWindow } from "../../src/core/adaptive/orchestrator";
import {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  registerTokenizer,
} from "../../src/core/adaptive/tokens";
import {
  analyzeTask,
  capabilityForModel,
  isFreshInfoRequest,
  looksLikeNarration,
  rankTools,
  selectToolSpecs,
  stripFencedCode,
  suggestFirstTool,
  toComplexity,
} from "../../src/core/intelligence/policy";
import { checkContextWindowOverflow } from "../../webview-ui/src/contextPresets";
import type { MachineProfile, ModelInfo, ToolSpec } from "../../src/shared/types";

describe("Adaptive Intelligence & Hardware Profiling", () => {
  const baseMachine: MachineProfile = {
    totalRamBytes: 16 * 1024 ** 3, // 16 GB
    freeRamBytes: 10 * 1024 ** 3, // 10 GB
    cpuCores: 8,
    cpuModel: "Test CPU",
    platform: "win32",
    arch: "x64",
    gpu: {
      name: "RTX 4060",
      vramBytes: 8 * 1024 ** 3, // 8 GB
      vendor: "nvidia",
    },
    tier: "mid",
  };

  const localModel: ModelInfo = {
    name: "qwen2.5-coder:7b",
    provider: "ollama",
    contextLength: 32768,
    paramsB: 7,
    tier: "small",
    toolTrained: true,
  };

  const cloudModel: ModelInfo = {
    name: "claude-3-5-sonnet",
    provider: "anthropic",
    contextLength: 200000,
    tier: "large",
    toolTrained: true,
  };

  describe("computeOptimalContextWindow", () => {
    it("respects the 22.5% RAM safety buffer for local machines", () => {
      const res = computeOptimalContextWindow(localModel, baseMachine, true);
      assert.ok(res.numCtx > 0);
      assert.ok(res.numCtx <= 32768);
      assert.ok(res.recommendedNumCtx > 0);
      assert.ok(typeof res.reason === "string" && res.reason.length > 0);
    });

    it("caps context appropriately on low-RAM machines to prevent swapping", () => {
      const lowMachine: MachineProfile = {
        ...baseMachine,
        totalRamBytes: 4 * 1024 ** 3, // 4 GB
        freeRamBytes: 1.5 * 1024 ** 3, // 1.5 GB
        gpu: undefined,
        tier: "low",
      };
      const res = computeOptimalContextWindow(localModel, lowMachine, true);
      // On a 4 GB RAM machine with no GPU, 7B model weights won't even fit comfortably in RAM;
      // should cap to minimum safe bucket (8192)
      assert.equal(res.numCtx, 8192);
      assert.ok(res.reason.toLowerCase().includes("context"));
      assert.ok(res.reason.includes("22% RAM buffer reserved"));
    });

    it("allows full context for cloud models without hardware constraints", () => {
      const res = computeOptimalContextWindow(cloudModel, baseMachine, true);
      assert.equal(res.numCtx, 200000);
      assert.ok(res.reason.includes("Cloud model"));
    });

    it("falls back to model maximum context when adaptive is disabled", () => {
      const res = computeOptimalContextWindow(localModel, baseMachine, false);
      assert.equal(res.numCtx, 32768);
    });
  });

  describe("checkContextWindowOverflow", () => {
    it("detects no overflow when selection is within hardware safety pool", () => {
      const check = checkContextWindowOverflow(8192, localModel, baseMachine);
      assert.equal(check.overflows, false);
      assert.equal(check.title, "");
    });

    it("detects overflow when selecting beyond model maximum context length", () => {
      const check = checkContextWindowOverflow(65536, localModel, baseMachine);
      assert.equal(check.overflows, true);
      assert.ok(check.title.includes("exceeds model limit") || check.explanation.includes("exceeds"));
      assert.equal(check.recommendedTokens, 32768);
    });

    it("detects memory pressure overflow when local memory pool cannot fit weights + KV cache", () => {
      const tightMachine: MachineProfile = {
        ...baseMachine,
        totalRamBytes: 8 * 1024 ** 3,
        freeRamBytes: 2 * 1024 ** 3,
        gpu: undefined, // no VRAM
      };
      const largeLocalModel: ModelInfo = {
        name: "command-r:35b",
        provider: "ollama",
        contextLength: 131072,
        paramsB: 35,
        tier: "large",
      };

      const check = checkContextWindowOverflow(131072, largeLocalModel, tightMachine);
      assert.equal(check.overflows, true);
      assert.ok(check.explanation.includes("memory") || check.explanation.includes("exceeds"));
      assert.ok(check.recommendedTokens <= 32768);
    });

    it("gracefully handles zero or negative selected tokens", () => {
      const check = checkContextWindowOverflow(0, localModel, baseMachine);
      assert.equal(check.overflows, false);
      assert.equal(check.recommendedTokens, 8192);
    });
  });

  describe("Token Estimation & Pluggable Tokenizers", () => {
    it("estimates tokens heuristically for standard prose and code", () => {
      const emptyTokens = estimateTokens("");
      assert.equal(emptyTokens, 0);

      const prose = "Hello world! This is a test prompt for estimating tokens.";
      const proseTokens = estimateTokens(prose);
      assert.ok(proseTokens >= 10 && proseTokens <= 25);

      const code = `function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}`;
      const codeTokens = estimateTokens(code);
      assert.ok(codeTokens >= 15 && codeTokens <= 40);
    });

    it("estimates ChatMessage tokens including tool calls and results", () => {
      const msg = {
        id: "msg-1",
        role: "assistant" as const,
        content: "Here is the file you requested.",
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            args: { path: "src/index.ts" },
            result: "export const app = 'test';",
            status: "done" as const,
          },
        ],
        createdAt: Date.now(),
      };

      const tokens = estimateMessageTokens(msg);
      assert.ok(tokens > 15);

      const total = estimateMessagesTokens([msg, { ...msg, id: "msg-2" }]);
      assert.equal(total, tokens * 2);
    });

    it("registers, prioritizes, and unregisters custom model tokenizers", () => {
      const customTokenizer = {
        modelPrefix: "custom-special-model",
        count: (text: string) => text.length, // simple 1 char = 1 token for testing
      };

      registerTokenizer(customTokenizer);

      const msg = {
        id: "msg-custom",
        role: "user" as const,
        content: "1234567890",
        createdAt: Date.now(),
      };

      // 4 overhead tokens + 10 chars = 14 tokens
      const customTokens = estimateMessageTokens(msg, "custom-special-model-v2");
      assert.equal(customTokens, 14);

      // Unregister by setting to null
      registerTokenizer(null);
    });
  });

  describe("Task Intelligence & Tool Policies", () => {
    it("identifies fresh info requests for real-time keywords", () => {
      assert.equal(isFreshInfoRequest("what is the weather in Paris"), true);
      assert.equal(isFreshInfoRequest("current bitcoin price"), true);
      assert.equal(isFreshInfoRequest("latest stock prices for AAPL"), true);
      assert.equal(isFreshInfoRequest("search the web for modern Next.js 15 features"), true);
      assert.equal(isFreshInfoRequest("write a quicksort function in Rust"), false);
      assert.equal(isFreshInfoRequest("explain how React useEffect works"), false);
    });

    it("analyzes task scope, reasoning complexity, and destructive risk", () => {
      const codebaseTask = analyzeTask("refactor the entire codebase to use async/await across all files", "agent");
      assert.equal(codebaseTask.scope, "codebase");
      assert.equal(codebaseTask.reasoning, "high");

      const destructiveTask = analyzeTask("rm -rf node_modules and drop table users", "agent");
      assert.equal(destructiveTask.risk, "destructive");

      const complexity = toComplexity(codebaseTask, 500);
      assert.equal(complexity.level, "complex");
      assert.ok(complexity.minContextTokens >= 12288);
    });

    it("ranks tools contextually by agent phase", () => {
      const specs: ToolSpec[] = [
        { name: "read_file", summary: "read", params: [], sideEffecting: false, priority: 1, tags: ["read"] },
        { name: "edit_file", summary: "edit", params: [], sideEffecting: true, priority: 2, tags: ["write"] },
        { name: "get_diagnostics", summary: "diag", params: [], sideEffecting: false, priority: 3, tags: ["verify"] },
      ];
      const task = analyzeTask("fix the bug in src/index.ts", "agent");

      const orientRanked = rankTools(specs, task, "orient");
      assert.equal(orientRanked[0].name, "read_file");

      const editRanked = rankTools(specs, task, "edit");
      assert.equal(editRanked[0].name, "edit_file");

      const verifyRanked = rankTools(specs, task, "verify");
      assert.equal(verifyRanked[0].name, "get_diagnostics");
    });

    it("selectToolSpecs restricts tools in chat mode to web and context queries", () => {
      const specs: ToolSpec[] = [
        { name: "web_search", summary: "search", params: [], sideEffecting: false, priority: 1 },
        { name: "web_fetch", summary: "fetch", params: [], sideEffecting: false, priority: 2 },
        { name: "read_file", summary: "read", params: [], sideEffecting: false, priority: 3 },
        { name: "write_file", summary: "write", params: [], sideEffecting: true, priority: 4 },
      ];
      const plan = {
        mode: "chat" as const,
        intelligence: "high" as const,
        maxTools: 5,
        numCtx: 8192,
        contextWindow: 8192,
        toolProtocol: "photon-block" as const,
        model: "qwen2.5-coder:7b",
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1024,
      };

      const selected = selectToolSpecs(specs, plan, "orient");
      const names = selected.map((s) => s.name);
      assert.ok(names.includes("web_search"));
      assert.ok(!names.includes("read_file"));
      assert.ok(!names.includes("write_file"));
    });

    it("identifies model narration vs deliverable", () => {
      assert.equal(looksLikeNarration("Let me read the file src/index.ts next to inspect it."), true);
      assert.equal(looksLikeNarration("I will search for the definition of the function now."), true);
      assert.equal(looksLikeNarration("```typescript\nconst x = 42;\n```"), false);
      assert.equal(
        looksLikeNarration(
          "Here is the architecture breakdown:\n1. Front-end in React\n2. Backend in Node\n3. Database in SQLite"
        ),
        false
      );
    });

    it("strips fenced code cleanly and suggests the first actionable tool", () => {
      const codeSnippet = "Here is some code:\n```typescript\nconsole.log('hi');\n```\nAnd then some text.";
      const stripped = stripFencedCode(codeSnippet);
      assert.ok(!stripped.includes("console.log"));
      assert.ok(stripped.includes("Here is some code:"));

      const specs: ToolSpec[] = [
        { name: "web_search", summary: "web", params: [], sideEffecting: false, priority: 1 },
        { name: "search_code", summary: "search", params: [], sideEffecting: false, priority: 2 },
        { name: "list_dir", summary: "list", params: [], sideEffecting: false, priority: 3 },
      ];
      assert.equal(suggestFirstTool(specs, "search the workspace for handleAuth"), "search_code");
      assert.equal(suggestFirstTool(specs, "what is the latest weather in Tokyo"), "web_search");
      assert.equal(suggestFirstTool(specs, "list the files in the directory"), "list_dir");
    });
  });
});
