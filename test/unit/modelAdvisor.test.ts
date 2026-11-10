import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessFit,
  findMatchingBenchmark,
  recommendModels,
  recommendModelForTask,
  evaluateInstalledLocalModels,
  hardwareFromProfile,
  validatePredictionAgainstRuntime,
  evaluateBackgroundBenchGuard,
  type HardwareInput,
} from "../../src/core/adaptive/modelAdvisor";
import { computeOptimalContextWindow } from "../../src/core/adaptive/orchestrator";
import { checkContextWindowOverflow } from "../../webview-ui/src/contextPresets";
import type { BenchResult, MachineProfile } from "../../src/shared/types";

describe("Phase 6.1: Model Advisor, Measured Benchmarks & Hardware Reconciliation", () => {
  const baseHardware: HardwareInput = {
    totalRamGb: 16,
    freeRamGb: 10,
    ramBufferGb: 3.6,
    vramGb: 8,
    gpuName: "RTX 4070",
    gpuVendor: "nvidia",
    cpuCores: 16,
    unifiedMemory: false,
  };

  describe("Benchmark Matching & Compatibility Filtering", () => {
    it("matches exact model name and uses measured throughput", () => {
      const benchmarks: BenchResult[] = [
        {
          model: "qwen2.5-coder:7b",
          tokensPerSec: 42.5,
          firstTokenMs: 250,
          hardwareClass: "sweet",
          methodologyVersion: 1,
          toolCallReliability: 1.0,
          reasoningPass: true,
          tasks: [],
          ranAt: Date.now() - 3600000, // 1 hour ago
        },
      ];

      const match = findMatchingBenchmark("qwen2.5-coder:7b", benchmarks, baseHardware);
      assert.ok(match);
      assert.equal(match.tokensPerSec, 42.5);

      const fit = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.06 }, baseHardware, 8192, match.tokensPerSec);
      assert.equal(fit.isEstimate, false);
      assert.equal(fit.tokPerSec, 43);
      assert.ok(fit.label.includes("43 tok/s (measured benchmark)"));
    });

    it("rejects stale benchmarks older than 30 days", () => {
      const thirtyFiveDaysAgo = Date.now() - 35 * 24 * 3600 * 1000;
      const benchmarks: BenchResult[] = [
        {
          model: "qwen2.5-coder:7b",
          tokensPerSec: 50.0,
          firstTokenMs: 200,
          hardwareClass: "sweet",
          methodologyVersion: 1,
          toolCallReliability: 1.0,
          reasoningPass: true,
          tasks: [],
          ranAt: thirtyFiveDaysAgo,
        },
      ];

      const match = findMatchingBenchmark("qwen2.5-coder:7b", benchmarks, baseHardware);
      assert.equal(match, undefined);
    });

    it("rejects benchmarks with invalid methodology version or non-positive tps", () => {
      const badMethodology: BenchResult[] = [
        {
          model: "qwen2.5-coder:7b",
          tokensPerSec: 40.0,
          firstTokenMs: 200,
          hardwareClass: "sweet",
          methodologyVersion: 0,
          toolCallReliability: 1.0,
          reasoningPass: true,
          tasks: [],
          ranAt: Date.now(),
        },
      ];

      const matchBadVer = findMatchingBenchmark("qwen2.5-coder:7b", badMethodology, baseHardware);
      assert.equal(matchBadVer, undefined);

      const zeroTps: BenchResult[] = [
        {
          model: "qwen2.5-coder:7b",
          tokensPerSec: 0,
          firstTokenMs: 200,
          hardwareClass: "sweet",
          methodologyVersion: 1,
          toolCallReliability: 1.0,
          reasoningPass: true,
          tasks: [],
          ranAt: Date.now(),
        },
      ];

      const matchZero = findMatchingBenchmark("qwen2.5-coder:7b", zeroTps, baseHardware);
      assert.equal(matchZero, undefined);
    });

    it("rejects benchmarks recorded on a mismatched hardware tier", () => {
      const highTierBench: BenchResult[] = [
        {
          model: "qwen2.5-coder:7b",
          tokensPerSec: 95.0, // measured on high-tier RTX 4090 / 24GB VRAM
          firstTokenMs: 100,
          hardwareClass: "high",
          methodologyVersion: 1,
          toolCallReliability: 1.0,
          reasoningPass: true,
          tasks: [],
          ranAt: Date.now(),
        },
      ];

      // baseHardware is "sweet" tier (8GB VRAM)
      const match = findMatchingBenchmark("qwen2.5-coder:7b", highTierBench, baseHardware);
      assert.equal(match, undefined);
    });
  });

  describe("RAM Pressure, Free RAM & Safety Reserve Reconciliation", () => {
    it("bounds usable RAM by actual free RAM when system is under memory pressure", () => {
      // 32GB total RAM, but only 1.2GB currently free (e.g. running heavy background services)
      const pressureHardware: HardwareInput = {
        totalRamGb: 32,
        freeRamGb: 1.2,
        ramBufferGb: 7.2,
        vramGb: 0, // CPU only
        cpuCores: 8,
        unifiedMemory: false,
      };

      // Model requires 4.7GB weights + 0.4GB runtime overhead = 5.1GB
      const fit = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.06 }, pressureHardware, 8192);

      // Must NOT claim it fits in RAM because only 1.2GB is free!
      assert.equal(fit.mode, "exceeds");
      assert.equal(fit.badge, "red");
      assert.ok(fit.label.includes("only 1.2GB RAM currently free"));
    });

    it("labels estimated speed vs measured speed explicitly", () => {
      const estimatedFit = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.06 }, baseHardware, 8192);
      assert.equal(estimatedFit.isEstimate, true);
      assert.ok(estimatedFit.label.includes("(estimated)"));

      const measuredFit = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.06 }, baseHardware, 8192, 38.2);
      assert.equal(measuredFit.isEstimate, false);
      assert.ok(measuredFit.label.includes("(measured benchmark)"));
    });

    it("correctly reconciles Apple Silicon unified memory", () => {
      const m1Mac: MachineProfile = {
        os: "darwin",
        arch: "arm64",
        cpuModel: "Apple M1 Pro",
        cpuCores: 10,
        totalRamBytes: 16 * 1024 ** 3,
        freeRamBytes: 10 * 1024 ** 3,
        gpu: { vendor: "apple", name: "Apple M1 Pro", vramBytes: 0 },
      };

      const hw = hardwareFromProfile(m1Mac);
      assert.equal(hw.unifiedMemory, true);
      assert.ok(hw.vramGb > 10); // ~65% of unified memory exposed to GPU

      const fit = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.06 }, hw, 8192);
      assert.equal(fit.mode, "gpu");
      assert.ok(fit.label.includes("unified memory"));
    });
  });

  describe("recommendModels & evaluateInstalledLocalModels Benchmark Integration", () => {
    it("plumbs measured benchmarks into recommendModels and evaluateInstalledLocalModels", () => {
      const machine: MachineProfile = {
        os: "win32",
        arch: "x64",
        cpuModel: "AMD Ryzen 7",
        cpuCores: 8,
        totalRamBytes: 16 * 1024 ** 3,
        freeRamBytes: 10 * 1024 ** 3,
        gpu: { vendor: "nvidia", name: "RTX 4070", vramBytes: 8 * 1024 ** 3 },
      };

      const benchMap = new Map<string, BenchResult>();
      benchMap.set("qwen2.5-coder:7b", {
        model: "qwen2.5-coder:7b",
        tokensPerSec: 51.4,
        firstTokenMs: 180,
        hardwareClass: "sweet",
        methodologyVersion: 1,
        toolCallReliability: 1.0,
        reasoningPass: true,
        tasks: [],
        ranAt: Date.now() - 10000,
      });

      const recs = recommendModels(machine, {
        goal: "coding",
        installed: ["qwen2.5-coder:7b"],
        benchmarks: benchMap,
      });

      const rec7b = recs.models.find((m) => m.name === "qwen2.5-coder:7b");
      assert.ok(rec7b);
      assert.equal(rec7b.fit.isEstimate, false);
      assert.equal(rec7b.fit.tokPerSec, 51);
      assert.ok(rec7b.fit.label.includes("51 tok/s (measured benchmark)"));

      // Also verify evaluatedInstalled
      const inst7b = recs.evaluatedInstalled?.find((m) => m.name === "qwen2.5-coder:7b");
      assert.ok(inst7b);
      assert.equal(inst7b.fit.isEstimate, false);
      assert.equal(inst7b.fit.tokPerSec, 51);
    });
  });

  describe("Bugfixes: Tier Normalization, Unified Memory & Custom Metadata", () => {
    it("matches controller-persisted 'low' and 'mid' hardwareClass benchmarks against 'light' and 'sweet' tiers", () => {
      const lowHw: HardwareInput = {
        totalRamGb: 8,
        freeRamGb: 5,
        ramBufferGb: 1.8,
        vramGb: 0,
        cpuCores: 4,
        unifiedMemory: false,
      };
      const lowBench: BenchResult = {
        model: "qwen2.5-coder:1.5b",
        tokensPerSec: 18,
        firstTokenMs: 320,
        hardwareClass: "low",
        methodologyVersion: 1,
        toolCallReliability: 0.75,
        reasoningPass: true,
        tasks: [],
        ranAt: Date.now() - 5000,
      };
      const midBench: BenchResult = {
        ...lowBench,
        model: "qwen2.5-coder:7b",
        tokensPerSec: 44,
        hardwareClass: "mid",
      };

      const matchedLow = findMatchingBenchmark("qwen2.5-coder:1.5b", [lowBench], lowHw);
      assert.ok(matchedLow, "low hardwareClass must match light tier hardware");
      assert.equal(matchedLow.tokensPerSec, 18);

      const matchedMid = findMatchingBenchmark("qwen2.5-coder:7b", [midBench], baseHardware);
      assert.ok(matchedMid, "mid hardwareClass must match sweet tier hardware");
      assert.equal(matchedMid.tokensPerSec, 44);
    });

    it("does not cross-contaminate distinct parameter tags on base-name benchmark fallback", () => {
      const bench14b: BenchResult = {
        model: "qwen2.5-coder:14b",
        tokensPerSec: 22,
        firstTokenMs: 400,
        hardwareClass: "sweet",
        methodologyVersion: 1,
        toolCallReliability: 0.9,
        reasoningPass: true,
        tasks: [],
        ranAt: Date.now(),
      };
      assert.equal(findMatchingBenchmark("qwen2.5-coder:7b", [bench14b], baseHardware), undefined);
      assert.ok(findMatchingBenchmark("qwen2.5-coder:14b", [bench14b], baseHardware));
    });

    it("does not double-count unified memory across assessFit, computeOptimalContextWindow, and checkContextWindowOverflow", () => {
      const m1Mac16: MachineProfile = {
        totalRamBytes: 16 * 1024 ** 3,
        freeRamBytes: 12 * 1024 ** 3,
        cpuCores: 8,
        cpuModel: "Apple M1",
        platform: "darwin",
        arch: "arm64",
        tier: "mid",
        gpu: {
          name: "Apple M1",
          vendor: "apple",
          vramBytes: 10.4 * 1024 ** 3,
          isUnifiedMemory: true,
        },
      };
      const hw = hardwareFromProfile(m1Mac16);
      // Usable RAM is ~10.7 GB (bounded by freeRam - margin), NEVER usableVram + usableRam (~20.6 GB).
      const tooLarge = assessFit({ sizeGb: 13.5, kvGbPer1k: 0.12 }, hw, 8192);
      assert.equal(tooLarge.mode, "exceeds");
      assert.equal(tooLarge.pressure, "critical");

      const ctxWindow = computeOptimalContextWindow(
        { name: "custom:14b", sizeBytes: 13.5 * 1024 ** 3, paramsB: 14, tier: "medium", contextLength: 32768 },
        m1Mac16,
        true
      );
      assert.equal(ctxWindow.numCtx, 8192);

      const overflow = checkContextWindowOverflow(
        32768,
        {
          name: "custom:14b",
          provider: "ollama",
          sizeBytes: 13.5 * 1024 ** 3,
          paramsB: 14,
          contextLength: 32768,
        },
        m1Mac16
      );
      assert.equal(overflow.overflows, true);
    });

    it("preserves non-zero kvGbPer1k for small custom models and uses ModelInfo paramsB/thinking/quantization", () => {
      const evals = evaluateInstalledLocalModels(
        [
          {
            name: "my-custom-assistant",
            provider: "ollama",
            paramsB: 2,
            quantization: "q4_k_m",
            thinking: true,
            toolTrained: true,
          },
        ],
        {
          totalRamBytes: 16 * 1024 ** 3,
          freeRamBytes: 11 * 1024 ** 3,
          cpuCores: 8,
          cpuModel: "Intel",
          platform: "win32",
          arch: "x64",
          tier: "mid",
          gpu: { name: "RTX 4060", vendor: "nvidia", vramBytes: 8 * 1024 ** 3 },
        },
        "reasoning",
        8192
      );
      assert.equal(evals.length, 1);
      assert.equal(evals[0].quantization, "q4_k_m");
      assert.ok(evals[0].capabilities.includes("reasoning"));
      assert.ok(evals[0].fit.memRequiredGb > 1.5);

      const eval32k = evaluateInstalledLocalModels(
        [
          {
            name: "my-custom-assistant",
            provider: "ollama",
            paramsB: 2,
            quantization: "q4_k_m",
          },
        ],
        {
          totalRamBytes: 16 * 1024 ** 3,
          freeRamBytes: 11 * 1024 ** 3,
          cpuCores: 8,
          cpuModel: "Intel",
          platform: "win32",
          arch: "x64",
          tier: "mid",
          gpu: { name: "RTX 4060", vendor: "nvidia", vramBytes: 8 * 1024 ** 3 },
        },
        "coding",
        32768
      );
      assert.ok(
        eval32k[0].fit.memRequiredGb > evals[0].fit.memRequiredGb + 0.5,
        "KV cache must grow with context even for 2B models"
      );
    });
  });

  describe("Runtime, Quantization, Context Scaling & Live Validation", () => {
    it("predicts distinct memory pressure, speed, and safe context across quantizations and runtimes", () => {
      const q4 = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.06 }, baseHardware, 8192, {
        quantization: "q4_k_m",
        runtime: "llamacpp",
      });
      const q8 = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.06 }, baseHardware, 8192, {
        quantization: "q8_0",
        runtime: "ollama",
      });
      const f16 = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.06 }, baseHardware, 8192, {
        quantization: "f16",
        runtime: "vllm",
      });

      assert.equal(q4.mode, "gpu");
      assert.equal(q4.gpuPercent, 100);
      assert.ok((q4.maxSafeContextTokens ?? 0) >= 32768);
      assert.ok(q8.memRequiredGb > q4.memRequiredGb);
      assert.equal(q8.mode, "hybrid", "8GB GPU + Q8 7B spills to hybrid RAM");
      assert.equal(f16.mode, "exceeds", "FP16 7B + vLLM overhead exceeds 16GB total safe pool");
      assert.ok((q4.tokPerSec ?? 0) > (q8.tokPerSec ?? 0));

      const longCtx = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.12 }, baseHardware, 65536, {
        quantization: "q4_k_m",
      });
      assert.ok(longCtx.memRequiredGb > q4.memRequiredGb);
      assert.ok((longCtx.tokPerSec ?? 0) < (q4.tokPerSec ?? 0));
    });

    it("validates predictions against live /api/ps residency and calibrates future recommendations", () => {
      const predicted = assessFit({ sizeGb: 4.7, kvGbPer1k: 0.06 }, baseHardware, 8192);
      const offloaded = validatePredictionAgainstRuntime(
        predicted,
        {
          name: "qwen2.5-coder:7b",
          sizeBytes: 5.5 * 1024 ** 3,
          vramBytes: 2.5 * 1024 ** 3,
          gpuPercent: 45,
          contextLength: 16384,
        },
        19
      );
      assert.equal(offloaded.status, "more_offload");
      assert.equal(offloaded.actualGpuPercent, 45);
      assert.equal(offloaded.actualTokPerSec, 19);

      const calibrated = recommendModels(
        {
          totalRamBytes: 16 * 1024 ** 3,
          freeRamBytes: 10 * 1024 ** 3,
          cpuCores: 16,
          cpuModel: "AMD",
          platform: "win32",
          arch: "x64",
          tier: "mid",
          gpu: { name: "RTX 4070", vendor: "nvidia", vramBytes: 8 * 1024 ** 3 },
        },
        {
          installedModels: [{ name: "qwen2.5-coder:7b", provider: "ollama", sizeBytes: 4.7 * 1024 ** 3 }],
          liveObservations: { "qwen2.5-coder:7b": 110 },
          runtimeModels: [
            {
              name: "qwen2.5-coder:7b",
              sizeBytes: 5.2 * 1024 ** 3,
              vramBytes: 5.2 * 1024 ** 3,
              gpuPercent: 100,
              contextLength: 8192,
            },
          ],
        }
      );

      assert.ok((calibrated.calibrationScale ?? 1) > 1);
      const inst = calibrated.evaluatedInstalled?.[0];
      assert.equal(inst?.fit.validation?.actualGpuPercent, 100);
      assert.equal(inst?.fit.validation?.actualTokPerSec, 110);
    });
  });

  describe("Task-Specific Model Recommendations", () => {
    const sweetMachine: MachineProfile = {
      totalRamBytes: 32 * 1024 ** 3,
      freeRamBytes: 24 * 1024 ** 3,
      cpuCores: 16,
      cpuModel: "AMD Ryzen 9",
      platform: "win32",
      arch: "x64",
      tier: "high",
      gpu: { name: "RTX 4070", vendor: "nvidia", vramBytes: 8 * 1024 ** 3 },
    };

    it("recommends small fast model for autocomplete vs reasoning/large-context model for complex debugging", () => {
      const fastTask = recommendModelForTask(
        "autocomplete next line inline completion snippet",
        sweetMachine,
        { mode: "agent" }
      );
      const complexTask = recommendModelForTask(
        "Debug race condition and redesign authentication concurrency architecture across multiple files in this codebase",
        sweetMachine,
        { mode: "agent" }
      );
      const visionTask = recommendModelForTask(
        "Inspect this UI screenshot mockup and identify alignment bugs",
        sweetMachine,
        { mode: "chat" }
      );

      assert.equal(fastTask.goal, "autocomplete");
      assert.equal(fastTask.recommendedName, "qwen2.5-coder:1.5b");

      assert.equal(complexTask.taskComplexity, "complex");
      assert.ok(complexTask.ctxTokens >= 12288);
      assert.equal(complexTask.recommendedName, "deepseek-r1:8b");

      assert.equal(visionTask.goal, "multimodal");
      assert.equal(visionTask.recommendedName, "gemma4:e4b");
    });

    it("blocks background benchmarks once user uses a local model or when another GPU model is loaded", () => {
      const blockedByActiveUser = evaluateBackgroundBenchGuard({
        reachable: true,
        manual: false,
        autoRunEnabled: true,
        turnActive: false,
        localModelUsed: true,
        targetModel: "qwen2.5-coder:14b",
      });
      assert.equal(blockedByActiveUser.allowed, false);
      assert.equal(blockedByActiveUser.reason, "local_model_active_in_session");

      const blockedByGpuResident = evaluateBackgroundBenchGuard({
        reachable: true,
        manual: false,
        autoRunEnabled: true,
        turnActive: false,
        localModelUsed: false,
        targetModel: "qwen2.5-coder:14b",
        runningModels: [{ name: "qwen2.5-coder:7b", gpuPercent: 100, vramBytes: 5.2e9 }],
      });
      assert.equal(blockedByGpuResident.allowed, false);
      assert.equal(blockedByGpuResident.reason, "would_evict_loaded_gpu_model");

      const sameLoadedModelAllowed = evaluateBackgroundBenchGuard({
        reachable: true,
        manual: false,
        autoRunEnabled: true,
        turnActive: false,
        localModelUsed: false,
        targetModel: "qwen2.5-coder:7b",
        runningModels: [{ name: "qwen2.5-coder:7b", gpuPercent: 100, vramBytes: 5.2e9 }],
      });
      assert.equal(sameLoadedModelAllowed.allowed, true);

      const manualAllowedEvenAfterUse = evaluateBackgroundBenchGuard({
        reachable: true,
        manual: true,
        autoRunEnabled: false,
        turnActive: false,
        localModelUsed: true,
        targetModel: "qwen2.5-coder:14b",
      });
      assert.equal(manualAllowedEvenAfterUse.allowed, true);
    });
  });
});
