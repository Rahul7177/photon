import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideModel,
  rankModels,
  selectFallbackModel,
  type AutoModeInput,
} from "../../src/core/adaptive/autoMode";
import {
  BENCH_VERSION,
  compareRoutingVsBaseline,
  evaluateCodingPatchOutput,
  runBench,
  type RoutingEvalOutcome,
} from "../../src/core/bench/bench";
import {
  evaluateRetrieval,
  shouldIndexFile,
  WorkspaceIndex,
} from "../../src/core/index/indexer";
import { VectorStore } from "../../src/core/index/vectorStore";
import type { LLMProvider } from "../../src/core/llm/types";
import type {
  BenchResult,
  MachineProfile,
  ModelInfo,
} from "../../src/shared/types";

describe("Phase 1 Items 8, 9, 10: Benchmarks, Indexing/Retrieval, and Adaptive Routing", () => {
  describe("P1 Item 8: Coding Outcome Benchmarks & Baseline Comparison", () => {
    it("evaluates coding patch correctness against target file, old_str, and new_str invariants", () => {
      const validToolOutput = `
\`\`\`tool
TOOL_NAME: edit_file
BEGIN_ARG: path
src/pricing.ts
END_ARG
BEGIN_ARG: old_str
const value = 1;
END_ARG
BEGIN_ARG: new_str
const value = 2;
END_ARG
\`\`\`
      `.trim();

      const good = evaluateCodingPatchOutput(validToolOutput);
      assert.equal(good.passed, true);
      assert.ok(good.detail.includes("valid edit_file patch"));

      const wrongFileOutput = validToolOutput
        .replace("src/pricing.ts", "src/other.ts")
        .replace("const value = 1;", "const unrelated = 0;");
      const badFile = evaluateCodingPatchOutput(wrongFileOutput);
      assert.equal(badFile.passed, false);

      const corruptedOutput = "const value = 3;";
      const badPatch = evaluateCodingPatchOutput(corruptedOutput);
      assert.equal(badPatch.passed, false);
    });

    it("runs full coding benchmark suite measuring tool selection, patch correctness, recovery, context, verification, and reasoning", async () => {
      const mockClient: LLMProvider = {
        id: "ollama",
        name: "Mock Ollama",
        ping: async () => true,
        listModels: async () => [],
        chat: async () => ({ content: "ok" }),
        chatStream: async function* (req) {
          const allText = req.messages.map((m) => m.content).join("\n");
          let response = "";
          if (allText.includes("Write a TypeScript function add")) {
            response = "export function add(a: number, b: number): number { return a + b; }";
          } else if (allText.includes("Read src/index.ts using the tool")) {
            response = [
              "```tool",
              "TOOL_NAME: read_file",
              "BEGIN_ARG: path",
              "src/index.ts",
              "END_ARG",
              "```",
            ].join("\n");
          } else if (allText.includes("Inspect the implementation of parseConfig")) {
            response = "Use read_file on src/config/parser.ts";
          } else if (allText.includes("read_file failed for src/app.ts")) {
            response = [
              "```tool",
              "TOOL_NAME: find_files",
              "BEGIN_ARG: pattern",
              "app.ts",
              "END_ARG",
              "```",
            ].join("\n");
          } else if (allText.includes("Prepare the smallest safe edit")) {
            response = [
              "```tool",
              "TOOL_NAME: edit_file",
              "BEGIN_ARG: path",
              "src/pricing.ts",
              "END_ARG",
              "BEGIN_ARG: old_str",
              "const value = 1;",
              "END_ARG",
              "BEGIN_ARG: new_str",
              "const value = 2;",
              "END_ARG",
              "```",
            ].join("\n");
          } else if (allText.includes("What is the next verification step?")) {
            response = "Run diagnostics and tests to verify the change.";
          } else if (allText.includes("PHOTON_CTX_7429")) {
            response = "PHOTON_CTX_7429";
          } else if (allText.includes("A loop runs 3 times")) {
            response = "6";
          }

          yield {
            message: { role: "assistant", content: response },
            done: true,
            eval_count: 24,
            eval_duration: 240_000_000, // 100 tok/s
          };
        },
      };

      const progressLogs: string[] = [];
      const result = await runBench(mockClient, "qwen2.5-coder:7b", {
        hardwareClass: "nvidia-12gb",
        quantization: "Q4_K_M",
        onProgress: (msg) => progressLogs.push(msg),
      });

      assert.equal(result.methodologyVersion, BENCH_VERSION);
      assert.equal(result.toolCallReliability, 1);
      assert.equal(result.reasoningPass, true);
      assert.ok(result.tokensPerSec > 0);
      assert.ok(progressLogs.length >= 4);

      const byId = new Map(result.tasks.map((t) => [t.id, t]));
      assert.equal(byId.get("throughput")?.passed, true);
      assert.equal(byId.get("toolcall")?.passed, true);
      assert.equal(byId.get("tool_selection")?.passed, true);
      assert.ok(byId.get("tool_selection")?.detail.includes("src/config/parser.ts"));
      assert.equal(byId.get("recovery")?.passed, true);
      assert.equal(byId.get("edit")?.passed, true);
      assert.equal(byId.get("verification")?.passed, true);
      assert.equal(byId.get("context")?.passed, true);
      assert.equal(byId.get("reasoning")?.passed, true);
      assert.ok((result.capabilityProfile?.coding ?? 0) >= 0.85);
      assert.ok((result.capabilityProfile?.editFidelity ?? 0) >= 0.85);
      assert.ok((result.capabilityProfile?.recovery ?? 0) >= 0.8);
    });

    it("compares adaptive routing outcomes against a fixed-model baseline", () => {
      const baselineOutcomes: RoutingEvalOutcome[] = [
        {
          taskId: "task-1",
          modelUsed: "qwen2.5-coder:7b",
          fileSelectionOk: true,
          patchValidOk: false,
          toolRecoveryOk: true,
          contextRetentionOk: true,
          verificationOk: false,
          latencyMs: 900,
          tokensUsed: 1200,
        },
        {
          taskId: "task-2",
          modelUsed: "qwen2.5-coder:7b",
          fileSelectionOk: true,
          patchValidOk: true,
          toolRecoveryOk: false,
          contextRetentionOk: true,
          verificationOk: false,
          latencyMs: 1100,
          tokensUsed: 1400,
        },
      ];

      const adaptiveOutcomes: RoutingEvalOutcome[] = [
        {
          taskId: "task-1",
          modelUsed: "qwen2.5-coder:14b",
          fileSelectionOk: true,
          patchValidOk: true,
          toolRecoveryOk: true,
          contextRetentionOk: true,
          verificationOk: true,
          latencyMs: 1050,
          tokensUsed: 1100,
        },
        {
          taskId: "task-2",
          modelUsed: "qwen2.5-coder:14b",
          fileSelectionOk: true,
          patchValidOk: true,
          toolRecoveryOk: true,
          contextRetentionOk: true,
          verificationOk: true,
          latencyMs: 1150,
          tokensUsed: 1250,
        },
      ];

      const comparison = compareRoutingVsBaseline(adaptiveOutcomes, baselineOutcomes);
      assert.equal(comparison.totalTasks, 2);
      assert.equal(comparison.adaptiveSuccessRate, 1.0);
      assert.equal(comparison.baselineSuccessRate, 0.6);
      assert.equal(comparison.qualityDelta, 0.4);
      assert.equal(comparison.adaptiveOutperformsBaseline, true);
      assert.ok(comparison.summary.includes("+40% quality delta"));
    });
  });

  describe("P1 Item 9: Project Indexing Hygiene, Invalidation & Retrieval Evaluation", () => {
    it("excludes .photon/, build directories, lockfiles, minified bundles, binary content, and oversized files", () => {
      assert.equal(shouldIndexFile("src/core/agent/engine.ts", "export class AgentEngine {}").indexable, true);
      assert.equal(shouldIndexFile(".photon/index/chunks.json", "{}").indexable, false);
      assert.equal(shouldIndexFile("node_modules/pkg/index.js", "module.exports = {}").indexable, false);
      assert.equal(shouldIndexFile("dist/extension.js", "console.log(1)").indexable, false);
      assert.equal(shouldIndexFile("package-lock.json", "{}").indexable, false);
      assert.equal(shouldIndexFile("webview-ui/bundle.min.js", "var a=1;").indexable, false);
      assert.equal(shouldIndexFile("assets/logo.png").indexable, false);
      assert.equal(shouldIndexFile("src/huge.ts", "x".repeat(300 * 1024)).indexable, false);
      assert.equal(shouldIndexFile("src/corrupt.ts", "hello\u0000binary").indexable, false);
    });

    it("invalidates stale chunks on file edit, deletion, rename, or when a file becomes excluded, and measures retrieval Recall@K / MRR", async () => {
      const store = new VectorStore();
      // Deterministic keyword-sensitive embedding function for unit testing retrieval
      const vocabulary = [
        "verifyjwtsignature",
        "secretkey",
        "tokenvalidator",
        "computesubtotalwithtax",
        "vatrate",
        "invoicecalculator",
        "chooseoptimalmodelforhardware",
        "vrambytes",
        "autoselector",
      ];
      const embedFn = async (texts: string[]) =>
        texts.map((text) => {
          const lower = text.toLowerCase();
          return vocabulary.map((term) => (lower.includes(term) ? 1 : 0));
        });

      const index = new WorkspaceIndex(store, embedFn);

      await index.indexFile(
        "src/auth/tokenValidator.ts",
        [
          "export function verifyJwtSignature(token: string, secretKey: string): boolean {",
          "  return token.startsWith(secretKey);",
          "}",
        ].join("\n"),
      );
      await index.indexFile(
        "src/billing/invoiceCalculator.ts",
        [
          "export function computeSubtotalWithTax(amountCents: number, vatRate: number): number {",
          "  return Math.round(amountCents * (1 + vatRate));",
          "}",
        ].join("\n"),
      );
      await index.indexFile(
        "src/router/autoSelector.ts",
        [
          "export function chooseOptimalModelForHardware(vramBytes: number): string {",
          "  return vramBytes > 8_000_000_000 ? 'qwen2.5-coder:14b' : 'qwen2.5-coder:7b';",
          "}",
        ].join("\n"),
      );

      // Evaluate retrieval accuracy on known-answer queries
      const evalReport = await evaluateRetrieval(
        index,
        [
          {
            id: "auth-jwt",
            query: "verifyJwtSignature secretKey",
            expectedPath: "src/auth/tokenValidator.ts",
            expectedSymbolOrSnippet: "verifyJwtSignature",
          },
          {
            id: "billing-tax",
            query: "computeSubtotalWithTax vatRate",
            expectedPath: "src/billing/invoiceCalculator.ts",
            expectedSymbolOrSnippet: "computeSubtotalWithTax",
          },
          {
            id: "router-hw",
            query: "chooseOptimalModelForHardware vramBytes",
            expectedPath: "src/router/autoSelector.ts",
            expectedSymbolOrSnippet: "chooseOptimalModelForHardware",
          },
        ],
        3,
      );

      assert.equal(evalReport.totalCases, 3);
      assert.equal(evalReport.recallAtK, 1);
      assert.equal(evalReport.mrr, 1);

      // Rename file and verify old path is evicted and new path is searchable
      await index.renameFile(
        "src/auth/tokenValidator.ts",
        "src/auth/jwtVerifier.ts",
        "export function verifyJwtSignature(token: string, secretKey: string): boolean { return true; }",
      );
      assert.equal(index.hasFile("src/auth/tokenValidator.ts"), false);
      assert.equal(index.hasFile("src/auth/jwtVerifier.ts"), true);
      const afterRename = await index.retrieve("verifyJwtSignature secretKey", 3);
      assert.ok(afterRename.some((h) => h.path === "src/auth/jwtVerifier.ts"));
      assert.ok(!afterRename.some((h) => h.path === "src/auth/tokenValidator.ts"));

      // If an indexed file becomes binary/oversized on re-index, its stale chunks are automatically evicted
      await index.indexFile("src/auth/jwtVerifier.ts", "corrupted\u0000binary");
      assert.equal(index.hasFile("src/auth/jwtVerifier.ts"), false);

      // Delete file and verify stale chunks are gone
      index.removeFile("src/billing/invoiceCalculator.ts");
      assert.equal(index.hasFile("src/billing/invoiceCalculator.ts"), false);
      const afterDelete = await index.retrieve("computeSubtotalWithTax vatRate", 3);
      assert.ok(!afterDelete.some((h) => h.path === "src/billing/invoiceCalculator.ts"));
    });
  });

  describe("P1 Item 10: Explainable & Measurable Adaptive Model Routing", () => {
    const machine: MachineProfile = {
      os: "win32",
      arch: "x64",
      cpuModel: "AMD Ryzen 9",
      cpuCores: 16,
      totalRamBytes: 32 * 1024 ** 3,
      freeRamBytes: 20 * 1024 ** 3,
      gpu: { vendor: "nvidia", name: "RTX 4070", vramBytes: 12 * 1024 ** 3 },
      hardwareClass: "gpu-medium",
    };

    const localModels: ModelInfo[] = [
      {
        name: "qwen2.5-coder:7b",
        provider: "ollama",
        sizeBytes: 4.7 * 1024 ** 3,
        paramsB: 7,
        quantization: "Q4_K_M",
        family: "qwen2.5-coder",
        contextLength: 32768,
        supportsTools: true,
        supportsVision: false,
        tier: "small",
      },
      {
        name: "llama3.2:3b",
        provider: "ollama",
        sizeBytes: 2.0 * 1024 ** 3,
        paramsB: 3,
        quantization: "Q4_K_M",
        family: "llama",
        contextLength: 16384,
        supportsTools: false,
        supportsVision: false,
        tier: "tiny",
      },
    ];

    const cloudModel: ModelInfo = {
      name: "claude-3-5-sonnet-latest",
      provider: "anthropic",
      sizeBytes: 0,
      paramsB: 70,
      family: "claude",
      contextLength: 200000,
      supportsTools: true,
      supportsVision: true,
      tier: "large",
    };

    it("records explainable signal breakdowns (complexity, contextFit, toolReliability, hardwareFit, cost)", () => {
      const benchMap = new Map<string, BenchResult>([
        [
          "qwen2.5-coder:7b",
          {
            model: "qwen2.5-coder:7b",
            hardwareClass: "gpu-medium",
            methodologyVersion: BENCH_VERSION,
            tokensPerSec: 58,
            firstTokenMs: 160,
            toolCallReliability: 0.95,
            reasoningPass: true,
            tasks: [],
            ranAt: Date.now(),
            capabilityProfile: {
              reasoning: 0.88,
              coding: 0.92,
              toolCalling: 0.95,
              schemaAdherence: 0.95,
              contextRetention: 0.9,
              editFidelity: 0.9,
              recovery: 0.85,
              verification: 0.88,
              speed: 1,
            },
          },
        ],
      ]);

      const input: AutoModeInput = {
        prompt: "Refactor the authentication middleware across multiple files and run unit tests",
        mode: "agent",
        models: localModels,
        machine,
        benchByModel: benchMap,
        previousModel: "llama3.2:3b",
      };

      const decision = decideModel(input);
      assert.equal(decision.chosenModel, "qwen2.5-coder:7b");
      assert.equal(decision.cloudEscalated, false);
      assert.ok(decision.signals);
      assert.equal(decision.signals.taskComplexity, decision.complexity.level);
      assert.equal(decision.signals.contextFit, true);
      assert.ok(decision.signals.toolReliability >= 0.9);
      assert.equal(decision.signals.hardwareFit, "gpu");
      assert.equal(decision.signals.estimatedCostPer1MUsd, 0);
      assert.equal(decision.signals.isCloud, false);
      assert.ok(decision.escalationNotice?.includes("llama3.2:3b → qwen2.5-coder:7b"));
      assert.ok(decision.fallbackModels.includes("llama3.2:3b"));
    });

    it("surfaces explicit cloud escalation notices and prevents silent cloud fallback unless allowCloudEscalation is enabled", () => {
      const allModels = [...localModels, cloudModel];
      const localFirstDecision = decideModel({
        prompt: "Read package.json and tell me the version",
        mode: "agent",
        models: allModels,
        machine,
        pinnedModel: "qwen2.5-coder:7b",
      });

      const failed = new Set<string>(["qwen2.5-coder:7b"]);

      // With allowCloudEscalation = false, selectFallbackModel must pick local llama3.2:3b and skip paid cloud
      const safeFallback = selectFallbackModel(localFirstDecision, failed, allModels, false);
      assert.equal(safeFallback.fallbackModel, "llama3.2:3b");
      assert.equal(safeFallback.isCloudEscalation, false);
      assert.ok(safeFallback.notice.includes("local fallback"));

      // If all local models fail and allowCloudEscalation = false, it refuses to silently call paid cloud
      const allLocalFailed = new Set<string>(["qwen2.5-coder:7b", "llama3.2:3b"]);
      const blockedCloudFallback = selectFallbackModel(localFirstDecision, allLocalFailed, allModels, false);
      assert.equal(blockedCloudFallback.fallbackModel, null);

      // With allowCloudEscalation = true, it can fall back to cloud with an explicit cost/escalation notice
      const permittedCloudFallback = selectFallbackModel(localFirstDecision, allLocalFailed, allModels, true);
      assert.equal(permittedCloudFallback.fallbackModel, "claude-3-5-sonnet-latest");
      assert.equal(permittedCloudFallback.isCloudEscalation, true);
      assert.ok(permittedCloudFallback.notice.includes("cloud escalation"));
    });
  });
});
