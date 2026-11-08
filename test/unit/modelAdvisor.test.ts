import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessFit,
  findMatchingBenchmark,
  recommendModels,
  evaluateInstalledLocalModels,
  hardwareFromProfile,
  type HardwareInput,
} from "../../src/core/adaptive/modelAdvisor";
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
});
