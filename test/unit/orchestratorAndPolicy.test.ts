import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeTask,
  buildExecutionPolicy,
  shouldUseNativeToolProtocol,
  capabilityForModel,
} from "../../src/core/intelligence/policy";
import {
  buildPlan,
  computeOptimalContextWindow,
} from "../../src/core/adaptive/orchestrator";
import {
  rankModels,
  decideModel,
  type AutoModeInput,
} from "../../src/core/adaptive/autoMode";
import { ToolPipeline } from "../../src/photon-core/tools/pipeline";
import { runCloudTurn, type CloudEmitter } from "../../src/core/agent/cloudEngine";
import type {
  BenchResult,
  MachineProfile,
  ModelInfo,
  Tool,
  ToolContext,
} from "../../src/shared/types";
import type { LLMProvider } from "../../src/core/llm/types";

describe("Phase 6.2: Orchestrator, Auto Mode & Policy Intelligence", () => {
  describe("Task Classification & Risk Guardrails (False Positive/Negative Mitigation)", () => {
    it("correctly identifies destructive tasks", () => {
      const t1 = analyzeTask("rm -rf node_modules and wipe database", "agent");
      assert.equal(t1.risk, "destructive");

      const t2 = analyzeTask("git reset --hard HEAD~1", "agent");
      assert.equal(t2.risk, "destructive");

      const t3 = analyzeTask("drop table users", "agent");
      assert.equal(t3.risk, "destructive");

      const t4 = analyzeTask("purge credentials from secrets manager", "agent");
      assert.equal(t4.risk, "destructive");
    });

    it("correctly identifies high-risk modification tasks", () => {
      const t1 = analyzeTask("deploy application to production", "agent");
      assert.equal(t1.risk, "high");

      const t2 = analyzeTask("npm install express redis", "agent");
      assert.equal(t2.risk, "high");

      const t3 = analyzeTask("run database migration to alter table schema", "agent");
      assert.equal(t3.risk, "high");
    });

    it("does not trigger false positive destructive or high risk on read-only queries", () => {
      const t1 = analyzeTask("explain how user authentication and password hashing works", "chat");
      assert.equal(t1.risk, "low");

      const t2 = analyzeTask("where is the API key read from process.env?", "agent");
      assert.equal(t2.risk, "low");

      const t3 = analyzeTask("show me what the database schema looks like in prisma.schema", "agent");
      assert.equal(t3.risk, "low");

      const t4 = analyzeTask("how do I deploy this to AWS?", "chat");
      assert.equal(t4.risk, "low");

      const t5 = analyzeTask("find all occurrences of git in package.json", "agent");
      assert.equal(t5.risk, "low");

      const t6 = analyzeTask("what is the secret sauce of this sorting algorithm?", "agent");
      assert.equal(t6.risk, "low");
    });

    it("accurately classifies task scope across single_file, multi_file, and codebase", () => {
      const single = analyzeTask("fix typo in src/utils.ts", "agent");
      assert.equal(single.scope, "single_file");

      const multi = analyzeTask("compare implementation between src/a.ts and src/b.ts", "agent");
      assert.equal(multi.scope, "multi_file");

      const codebase = analyzeTask("audit dependencies throughout the entire project codebase", "agent");
      assert.equal(codebase.scope, "codebase");
    });
  });

  describe("Execution Policy & Risk-Gated Permissions", () => {
    const defaultCap = capabilityForModel({ name: "qwen:7b", tier: "small" });

    it("elevates security policy on destructive tasks", () => {
      const task = analyzeTask("rm -rf dist and drop database", "agent");
      const policy = buildExecutionPolicy(task, defaultCap, 25, 10);
      assert.equal(policy.maxConcurrent, 1);
      assert.equal(policy.allowParallelReads, false);
      assert.equal(policy.requireExplicitApproval, true);
      assert.equal(policy.blockTerminalCommands, true);
    });

    it("enforces execution policy restrictions in ToolPipeline", async () => {
      const dummyTool: Tool = {
        spec: {
          name: "run_command",
          summary: "Run terminal command",
          sideEffecting: true,
          priority: 10,
          risk: "execute",
          params: [{ name: "command", type: "string", required: true, description: "cmd" }],
        },
        execute: async () => ({ ok: true, output: "ran" }),
      };

      const pipeline = new ToolPipeline();
      pipeline.register(dummyTool);
      const mockCtx: ToolContext = {
        workspaceRoot: "B:/test",
        signal: new AbortController().signal,
        log: () => {},
        webSearchProvider: "duckduckgo",
        findFiles: async () => [],
        capability: "high",
        getDiagnostics: async () => [],
        todos: [],
        requestApproval: async () => true,
        executionPolicy: {
          maxConcurrent: 1,
          allowParallelReads: false,
          serializeMutations: true,
          generationBudgetTokens: 1024,
          stepBudget: 10,
          blockTerminalCommands: true,
          requireExplicitApproval: true,
        },
      };

      const result = await pipeline.execute(
        { id: "c1", name: "run_command", args: { command: "dir" }, status: "proposed" },
        mockCtx
      );

      assert.equal(result.ok, false);
      assert.equal(result.status, "permission_denied");
      assert.ok(result.output.includes("disabled by current execution policy"));
    });

    it("elevates side-effect risk to destructive when requireExplicitApproval is active", async () => {
      let requestedRisk = "";
      const writeTool: Tool = {
        spec: {
          name: "edit_file",
          summary: "Edit file",
          sideEffecting: true,
          priority: 10,
          risk: "workspace_write",
          params: [{ name: "path", type: "string", required: true, description: "path" }],
        },
        execute: async () => ({ ok: true, output: "edited" }),
      };

      const pipeline = new ToolPipeline();
      pipeline.register(writeTool);
      const mockCtx: ToolContext = {
        workspaceRoot: "B:/test",
        signal: new AbortController().signal,
        log: () => {},
        webSearchProvider: "duckduckgo",
        findFiles: async () => [],
        capability: "high",
        getDiagnostics: async () => [],
        todos: [],
        requestApproval: async (call) => {
          requestedRisk = call.risk ?? "";
          return true;
        },
        executionPolicy: {
          maxConcurrent: 1,
          allowParallelReads: false,
          serializeMutations: true,
          generationBudgetTokens: 1024,
          stepBudget: 10,
          requireExplicitApproval: true,
        },
      };

      await pipeline.execute(
        { id: "c2", name: "edit_file", args: { path: "a.ts" }, status: "proposed" },
        mockCtx
      );

      assert.equal(requestedRisk, "destructive");
    });
  });

  describe("Context Window Selection & Runtime Output Reserves", () => {
    const baseMachine: MachineProfile = {
      totalRamBytes: 32 * 1024 ** 3,
      freeRamBytes: 20 * 1024 ** 3,
      cpuCores: 8,
      cpuModel: "x86_64",
      platform: "win32",
      arch: "x64",
      gpu: { name: "RTX 3070", vramBytes: 8 * 1024 ** 3 },
      tier: "mid",
    };

    it("strictly bounds context window by model maximum limit", () => {
      const smallModel: ModelInfo = {
        name: "tiny-embed:latest",
        contextLength: 4096,
        tier: "tiny",
      };

      const opt = computeOptimalContextWindow(smallModel, baseMachine, true);
      assert.ok(opt.numCtx <= 4096, `Expected numCtx <= 4096 but got ${opt.numCtx}`);
    });

    it("clamps userNumCtx when user pins context beyond model capability", () => {
      const model: ModelInfo = {
        name: "local-coder:7b",
        contextLength: 16384,
        tier: "small",
      };

      const plan = buildPlan({
        model,
        machine: baseMachine,
        mode: "agent",
        prompt: "Fix bug",
        userNumCtx: 65536,
        intelligence: "auto",
        reserveOutputTokens: 2048,
        adaptiveEnabled: true,
      });

      assert.equal(plan.numCtx, 16384);
      assert.ok(plan.rationale.some((r) => r.includes("clamped to model ceiling")));
    });

    it("guarantees output reserve does not starve context budget", () => {
      const model: ModelInfo = {
        name: "local-coder:7b",
        contextLength: 8192,
        tier: "small",
      };

      const plan = buildPlan({
        model,
        machine: baseMachine,
        mode: "agent",
        prompt: "Fix bug",
        intelligence: "auto",
        reserveOutputTokens: 4096,
        adaptiveEnabled: true,
      });

      assert.ok(plan.maxOutputTokens <= 4096);
      assert.ok(plan.maxOutputTokens >= 256);
      assert.ok(plan.executionPolicy!.generationBudgetTokens <= plan.maxOutputTokens);
    });
  });

  describe("Auto Mode Constraint Satisfaction & Routing Stability", () => {
    const local1: ModelInfo = { name: "qwen2.5-coder:7b", tier: "small", contextLength: 32768, provider: "ollama" };
    const local2: ModelInfo = { name: "deepseek-coder:6.7b", tier: "small", contextLength: 16384, provider: "ollama" };
    const cloud1: ModelInfo = { name: "claude-3-5-sonnet", tier: "large", contextLength: 200000, provider: "anthropic" };
    const models = [local1, local2, cloud1];

    it("enforces localOnly privacy constraint by disqualifying cloud models", () => {
      const input: AutoModeInput = {
        prompt: "refactor entire authentication architecture across all files in codebase",
        mode: "agent",
        models,
        machine: null,
        localOnly: true,
        adaptiveEnabled: true,
      };

      const decision = decideModel(input);
      assert.ok(decision.chosenModel.includes("qwen") || decision.chosenModel.includes("deepseek"));
      const cloudScore = decision.scores.find((s) => s.model === cloud1.name);
      assert.equal(cloudScore?.fits, false);
      assert.ok(cloudScore?.reasons.some((r) => r.includes("privacy: local-only")));
    });

    it("maintains deterministic tie-breaking without oscillation", () => {
      const input: AutoModeInput = {
        prompt: "write a helper function",
        mode: "agent",
        models: [local1, local2],
        machine: null,
        previousModel: "deepseek-coder:6.7b",
        adaptiveEnabled: true,
      };

      const d1 = decideModel(input);
      const d2 = decideModel(input);
      assert.equal(d1.chosenModel, d2.chosenModel);
      assert.equal(d1.scores[0]?.model, d2.scores[0]?.model);
    });

    it("rejects stale or invalid benchmark methodology", () => {
      const staleBench: BenchResult = {
        model: "qwen2.5-coder:7b",
        hardwareClass: "sweet",
        methodologyVersion: 1,
        tokensPerSec: 120,
        firstTokenMs: 100,
        toolCallReliability: 0.95,
        reasoningPass: true,
        tasks: [],
        ranAt: Date.now() - 40 * 86_400_000, // 40 days old (>30 days)
      };

      const benches = new Map([[local1.name, staleBench]]);
      const caps = capabilityForModel(local1, staleBench);
      const nativeOk = shouldUseNativeToolProtocol(local1, caps, staleBench, "high");
      assert.equal(nativeOk, false, "Stale benchmark must not grant native tool permission");
    });

    it("preserves user model directly when adaptive intelligence is disabled", () => {
      const input: AutoModeInput = {
        prompt: "huge complex codebase refactor requiring complex reasoning",
        mode: "agent",
        models,
        machine: null,
        previousModel: "deepseek-coder:6.7b",
        adaptiveEnabled: false,
      };

      const decision = decideModel(input);
      assert.equal(decision.chosenModel, "deepseek-coder:6.7b");
      assert.ok(decision.reason.includes("Adaptive disabled"));
    });
  });

  describe("Engine Step & Tool Caps by Mode", () => {
    it("enforces mode step caps in Cloud Engine", async () => {
      let stepCount = 0;
      const mockProvider: LLMProvider = {
        id: "mock-cloud",
        name: "mock-cloud",
        chat: async () => ({ content: "" }),
        chatStream: async function* () {
          stepCount++;
          yield {
            message: {
              role: "assistant",
              content: "inspecting",
              tool_calls: [
                {
                  id: `call-${stepCount}`,
                  function: {
                    name: "read_file",
                    arguments: { path: "test.ts" },
                  },
                },
              ],
            },
            done: true,
            done_reason: "tool_calls",
          };
        },
      };

      const mockTool: Tool = {
        spec: {
          name: "read_file",
          summary: "Read file",
          sideEffecting: false,
          priority: 1,
          params: [{ name: "path", type: "string", required: true, description: "path" }],
        },
        execute: async () => ({ ok: true, output: "file content" }),
      };

      let errorMessage = "";
      const emitter: CloudEmitter = {
        onAssistantStart: () => {},
        onDelta: () => {},
        onContent: () => {},
        onAssistantCancel: () => {},
        onPhase: () => {},
        onToolCall: () => {},
        onToolUpdate: () => {},
        onUsage: () => {},
        onGenerationStats: () => {},
        onDone: () => {},
        onError: (err) => {
          errorMessage = err;
        },
      };

      const mockCtx: ToolContext = {
        workspaceRoot: "B:/test",
        signal: new AbortController().signal,
        log: () => {},
        webSearchProvider: "duckduckgo",
        findFiles: async () => [],
        capability: "high",
        getDiagnostics: async () => [],
        todos: [],
        requestApproval: async () => true,
      };

      // Test Chat mode step cap (Spec §5: hard cap 6)
      await runCloudTurn({
        provider: mockProvider,
        model: "claude-3-5",
        system: "system prompt",
        history: [{ role: "user", content: "hello" }],
        tools: [mockTool],
        contextWindow: 100000,
        ctx: mockCtx,
        emitter,
        signal: new AbortController().signal,
        mode: "chat",
      });

      assert.equal(stepCount, 6, "Chat mode must stop at 6 steps");
      assert.ok(errorMessage.includes("Reached the 6-step safety limit in chat mode"));
    });

    it("rejects side-effecting tool calls in Cloud Engine during chat and plan modes", async () => {
      let executedCall = false;
      let finalContent = "";
      const mockProvider: LLMProvider = {
        id: "mock-cloud",
        name: "mock-cloud",
        chat: async () => ({ content: "" }),
        chatStream: async function* () {
          yield {
            message: {
              role: "assistant",
              content: "writing file",
              tool_calls: [
                {
                  id: "call-1",
                  function: {
                    name: "write_file",
                    arguments: { path: "a.ts", content: "bad" },
                  },
                },
              ],
            },
            done: true,
            done_reason: "tool_calls",
          };
        },
      };

      const sideEffectTool: Tool = {
        spec: {
          name: "write_file",
          summary: "Write file",
          sideEffecting: true,
          priority: 1,
          params: [{ name: "path", type: "string", required: true, description: "path" }],
        },
        execute: async () => {
          executedCall = true;
          return { ok: true, output: "wrote" };
        },
      };

      let lastToolStatus = "";
      const emitter: CloudEmitter = {
        onAssistantStart: () => {},
        onDelta: () => {},
        onContent: (_id, text) => {
          finalContent += text;
        },
        onAssistantCancel: () => {},
        onPhase: () => {},
        onToolCall: () => {},
        onToolUpdate: (_id, call) => {
          lastToolStatus = call.status;
        },
        onUsage: () => {},
        onGenerationStats: () => {},
        onDone: () => {},
        onError: () => {},
      };

      const mockCtx: ToolContext = {
        workspaceRoot: "B:/test",
        signal: new AbortController().signal,
        log: () => {},
        webSearchProvider: "duckduckgo",
        findFiles: async () => [],
        capability: "high",
        getDiagnostics: async () => [],
        todos: [],
        requestApproval: async () => true,
      };

      await runCloudTurn({
        provider: mockProvider,
        model: "claude-3-5",
        system: "system prompt",
        history: [{ role: "user", content: "please write a file" }],
        tools: [sideEffectTool],
        contextWindow: 100000,
        ctx: mockCtx,
        emitter,
        signal: new AbortController().signal,
        mode: "chat",
      });

      assert.equal(executedCall, false, "Side-effecting tool execute must not be called in chat mode");
      assert.equal(lastToolStatus, "error");
    });
  });
});
