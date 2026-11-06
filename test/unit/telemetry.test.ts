import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CloudUsageTracker,
  estimateCloudCost,
  getModelPricing,
} from "../../src/core/telemetry/cloudUsage";
import { sampleHardwareMetrics } from "../../src/core/adaptive/machineProfiler";

describe("Telemetry & Live Hardware Monitoring", () => {
  describe("Cloud Model Pricing & Cost Estimation", () => {
    it("returns accurate pricing for major frontier models", () => {
      const claude = getModelPricing("anthropic:claude-3-5-sonnet");
      assert.equal(claude.inputPerMillion, 3.0);
      assert.equal(claude.outputPerMillion, 15.0);
      assert.equal(claude.cachedInputPerMillion, 0.3);

      const gpt4o = getModelPricing("openai:gpt-4o");
      assert.equal(gpt4o.inputPerMillion, 2.5);
      assert.equal(gpt4o.outputPerMillion, 10.0);

      const flash = getModelPricing("gemini-2.0-flash");
      assert.equal(flash.inputPerMillion, 0.1);
      assert.equal(flash.outputPerMillion, 0.4);

      const fallback = getModelPricing("custom:unknown-llm");
      assert.equal(fallback.inputPerMillion, 2.0);
      assert.equal(fallback.outputPerMillion, 8.0);
    });

    it("estimates cost accurately with uncached and cached tokens", () => {
      // 1000 input tokens (with 200 cached) and 500 output tokens on claude-3-5-sonnet:
      // uncached input = 800 * $3.00/1M = $0.0024
      // cached input = 200 * $0.30/1M = $0.00006
      // output = 500 * $15.00/1M = $0.0075
      // total = 0.0024 + 0.00006 + 0.0075 = $0.00996
      const cost = estimateCloudCost("claude-3-5-sonnet", 1000, 500, 200);
      assert.ok(Math.abs(cost - 0.00996) < 0.00001, `Expected ~0.00996, got ${cost}`);
    });
  });

  describe("CloudUsageTracker Accumulation & Persistence", () => {
    it("accumulates session and total metrics across steps", () => {
      const tracker = new CloudUsageTracker();

      tracker.recordStep({
        model: "claude-3-5-sonnet",
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 200,
        savedTokens: 150,
      });

      tracker.recordStep({
        model: "claude-3-5-sonnet",
        inputTokens: 2000,
        outputTokens: 1000,
        cachedTokens: 500,
        savedTokens: 300,
      });

      const summary = tracker.getSummary();
      assert.equal(summary.sessionInputTokens, 3000);
      assert.equal(summary.sessionOutputTokens, 1500);
      assert.equal(summary.sessionCachedTokens, 700);
      assert.equal(summary.sessionSavedTokens, 450);
      assert.ok(summary.sessionEstimatedCostUsd > 0);

      assert.equal(summary.totalInputTokens, 3000);
      assert.equal(summary.totalOutputTokens, 1500);
      assert.equal(summary.totalCachedTokens, 700);
      assert.equal(summary.totalSavedTokens, 450);
      assert.ok(summary.totalEstimatedCostUsd > 0);

      assert.equal(summary.byModel.length, 1);
      assert.equal(summary.byModel[0].model, "claude-3-5-sonnet");
      assert.equal(summary.byModel[0].turns, 2);
      assert.equal(summary.byModel[0].inputTokens, 3000);
      assert.equal(summary.byModel[0].outputTokens, 1500);
    });

    it("initializes from persisted state and preserves historical totals", () => {
      const persisted = {
        totalInputTokens: 50000,
        totalOutputTokens: 20000,
        totalCachedTokens: 10000,
        totalSavedTokens: 5000,
        totalEstimatedCostUsd: 0.45,
        byModel: [
          {
            model: "gpt-4o",
            turns: 10,
            inputTokens: 50000,
            outputTokens: 20000,
            cachedTokens: 10000,
            savedTokens: 5000,
            estimatedCostUsd: 0.45,
          },
        ],
      };

      const tracker = new CloudUsageTracker(persisted);
      const initial = tracker.getSummary();

      // Session should start at zero
      assert.equal(initial.sessionInputTokens, 0);
      assert.equal(initial.sessionOutputTokens, 0);

      // Total should retain persisted historical data
      assert.equal(initial.totalInputTokens, 50000);
      assert.equal(initial.totalOutputTokens, 20000);
      assert.equal(initial.totalEstimatedCostUsd, 0.45);
      assert.equal(initial.byModel.length, 1);
      assert.equal(initial.byModel[0].model, "gpt-4o");

      // Record a new step in the new session
      tracker.recordStep({
        model: "gpt-4o",
        inputTokens: 1000,
        outputTokens: 500,
      });

      const updated = tracker.getSummary();
      assert.equal(updated.sessionInputTokens, 1000);
      assert.equal(updated.totalInputTokens, 51000);
      assert.equal(updated.byModel[0].turns, 11);
    });

    it("resets session and totals cleanly on reset()", () => {
      const tracker = new CloudUsageTracker();
      tracker.recordStep({
        model: "gemini-2.0-flash",
        inputTokens: 5000,
        outputTokens: 1000,
      });

      assert.ok(tracker.getSummary().totalInputTokens > 0);
      tracker.reset();

      const resetSummary = tracker.getSummary();
      assert.equal(resetSummary.sessionInputTokens, 0);
      assert.equal(resetSummary.totalInputTokens, 0);
      assert.equal(resetSummary.totalEstimatedCostUsd, 0);
      assert.equal(resetSummary.byModel.length, 0);
    });
  });

  describe("sampleHardwareMetrics Realtime Sampling", () => {
    it("returns valid hardware telemetry with RAM and timestamp", async () => {
      const metrics = await sampleHardwareMetrics();
      assert.ok(typeof metrics.ramTotalBytes === "number" && metrics.ramTotalBytes > 0);
      assert.ok(typeof metrics.ramUsedBytes === "number" && metrics.ramUsedBytes >= 0);
      assert.ok(typeof metrics.ramFreeBytes === "number" && metrics.ramFreeBytes >= 0);
      assert.ok(typeof metrics.ramUsedPercent === "number" && metrics.ramUsedPercent >= 0 && metrics.ramUsedPercent <= 100);
      assert.ok(typeof metrics.updatedAt === "number" && metrics.updatedAt > 0);

      // If GPU is detected (e.g. NVIDIA on this host), metrics should contain valid values
      if (metrics.gpuName) {
        assert.ok(typeof metrics.gpuName === "string");
        if (metrics.gpuUtilPercent !== undefined) {
          assert.ok(metrics.gpuUtilPercent >= 0 && metrics.gpuUtilPercent <= 100);
        }
        if (metrics.vramTotalBytes !== undefined) {
          assert.ok(metrics.vramTotalBytes > 0);
        }
      }
    });
  });
});

