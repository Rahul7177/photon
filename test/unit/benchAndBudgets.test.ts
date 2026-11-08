import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  BENCH_VERSION,
  computePercentiles,
  calculateCompositeBenchmarkScore,
  evaluateRepoTaskInDisposableWorkspace,
} from "../../src/core/bench/bench";
import {
  DEFAULT_PERFORMANCE_BUDGETS,
  validatePerformanceAgainstBudgets,
  measurePersistenceLatency,
  measureRetrievalLatency,
  measureCancellationResponsiveness,
} from "../../src/core/bench/performanceBudgets";
import { VectorStore } from "../../src/core/index/vectorStore";
import type { BenchResult } from "../../src/shared/types";

describe("Phase 10: Benchmark Validity & Performance Budgets", () => {
  describe("10.1 Photon Bench Methodology & Evaluation", () => {
    it("increments BENCH_VERSION to 4 to invalidate incompatible legacy records", () => {
      assert.equal(BENCH_VERSION, 4);
    });

    it("evaluates complete inspect -> edit -> test lifecycle in a disposable temporary workspace", () => {
      const outcome = evaluateRepoTaskInDisposableWorkspace(
        (_repoDir) => {
          return {
            inspected: true,
            editedPath: "src/pricing.ts",
            oldStr: "return base + base * discountRate;",
            newStr: "return base - base * discountRate;",
          };
        }
      );

      assert.equal(outcome.taskCompleted, true);
      assert.equal(outcome.inspectPassed, true);
      assert.equal(outcome.editApplied, true);
      assert.equal(outcome.testPassed, true);
      assert.equal(outcome.noExtraneousEdits, true);
      assert.equal(outcome.cleanedUp, true);
      assert.ok(outcome.detail.includes("successfully completed"));
    });

    it("rejects wrong-file edit attempts and prevents repository escapes", () => {
      const wrongFileOutcome = evaluateRepoTaskInDisposableWorkspace(
        (_repoDir) => {
          return {
            inspected: true,
            editedPath: "src/other.ts",
            oldStr: "return base + base * discountRate;",
            newStr: "return base - base * discountRate;",
          };
        },
        { attemptWrongFile: true }
      );

      assert.equal(wrongFileOutcome.taskCompleted, false);
      assert.equal(wrongFileOutcome.editApplied, false);
      assert.ok(wrongFileOutcome.detail.includes("Rejected: attempt to edit wrong file"));
    });

    it("rejects partial patches where exact old_str is missing or incorrect", () => {
      const partialPatchOutcome = evaluateRepoTaskInDisposableWorkspace(
        (_repoDir) => {
          return {
            inspected: true,
            editedPath: "src/pricing.ts",
            oldStr: "this_string_does_not_exist_in_pricing",
            newStr: "return base - base * discountRate;",
          };
        },
        { attemptPartialPatch: true }
      );

      assert.equal(partialPatchOutcome.taskCompleted, false);
      assert.equal(partialPatchOutcome.editApplied, false);
      assert.ok(partialPatchOutcome.detail.includes("exact old_str invariant not found"));
    });

    it("detects and rejects unrelated destructive edits to other files", () => {
      const extraneousEditOutcome = evaluateRepoTaskInDisposableWorkspace(
        (repoDir) => {
          // Destructive edit: modify control file
          fs.writeFileSync(path.join(repoDir, "src", "constants.ts"), "corrupted constants");
          return {
            inspected: true,
            editedPath: "src/pricing.ts",
            oldStr: "return base + base * discountRate;",
            newStr: "return base - base * discountRate;",
          };
        },
        { attemptExtraneousEdit: true }
      );

      assert.equal(extraneousEditOutcome.taskCompleted, false);
      assert.equal(extraneousEditOutcome.noExtraneousEdits, false);
      assert.ok(extraneousEditOutcome.detail.includes("Extraneous file modified"));
    });

    it("handles cancellation without leaving orphan files", () => {
      const ac = new AbortController();
      ac.abort();

      const cancelledOutcome = evaluateRepoTaskInDisposableWorkspace(
        () => ({ inspected: true }),
        { signal: ac.signal }
      );

      assert.equal(cancelledOutcome.taskCompleted, false);
      assert.ok(cancelledOutcome.detail.includes("cancelled before execution"));
    });

    it("calculates weighted composite score (25% speed, 25% tools, 25% reasoning, 25% coding)", () => {
      const mockResult: BenchResult = {
        model: "qwen2.5-coder:7b",
        hardwareClass: "gpu",
        methodologyVersion: BENCH_VERSION,
        tokensPerSec: 60, // 60/80 = 0.75 speed score
        firstTokenMs: 250,
        toolCallReliability: 1.0, // 1.0 tool calling score
        reasoningPass: true, // 1.0 reasoning score
        ranAt: Date.now(),
        tasks: [
          { id: "throughput", passed: true, detail: "ok" },
          { id: "toolcall", passed: true, detail: "ok" },
          { id: "tool_selection", passed: true, detail: "ok" },
          { id: "recovery", passed: true, detail: "ok" },
          { id: "edit", passed: true, detail: "ok" },
          { id: "verification", passed: true, detail: "ok" },
          { id: "context", passed: true, detail: "ok" },
          { id: "reasoning", passed: true, detail: "ok" },
        ],
      };

      const { compositeScore, breakdown, explanation } = calculateCompositeBenchmarkScore(mockResult);

      assert.equal(breakdown.speedScore, 0.75);
      assert.equal(breakdown.toolCallingScore, 1.0);
      assert.equal(breakdown.reasoningScore, 1.0);
      assert.equal(breakdown.codingOutcomeScore, 1.0);

      // (0.25 * 0.75) + (0.25 * 1.0) + (0.25 * 1.0) + (0.25 * 1.0) = 0.1875 + 0.75 = 0.938
      assert.equal(compositeScore, 0.938);
      assert.ok(explanation.includes("Composite Score 94%"));
    });

    it("computes accurate statistical percentiles and variance", () => {
      const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const stats = computePercentiles(data);

      assert.equal(stats.min, 10);
      assert.equal(stats.max, 100);
      assert.equal(stats.mean, 55);
      assert.equal(stats.p50, 50);
      assert.equal(stats.p90, 90);
      assert.equal(stats.p95, 100);
      assert.ok(stats.variance > 0);
    });
  });

  describe("10.2 Performance Budgets & Latency Targets", () => {
    it("validates measured metrics against standard performance budgets", () => {
      const goodMetrics = {
        activationMs: 120,
        firstTokenMs: 250,
        tokenStreamingFps: 45,
        checkpointPersistSmallMs: 10,
        retrieval1kP50Ms: 8,
        indexingFilesPerMinute: 2400,
      };

      const report = validatePerformanceAgainstBudgets(goodMetrics);
      assert.equal(report.passed, true);
      assert.equal(report.violations.length, 0);

      const degradedMetrics = {
        activationMs: 900, // exceeds 500ms
        tokenStreamingFps: 18, // below 30 fps
      };

      const degradedReport = validatePerformanceAgainstBudgets(degradedMetrics);
      assert.equal(degradedReport.passed, false);
      assert.equal(degradedReport.violations.length, 2);
      assert.ok(degradedReport.violations[0].includes("activationMs"));
      assert.ok(degradedReport.violations[1].includes("tokenStreamingFps"));
    });

    it("measures checkpoint persistence latency across file size tiers within budget", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-test-"));
      try {
        const small = measurePersistenceLatency(tmpDir, "small", 3);
        assert.equal(small.sizeBytes, 15 * 1024);
        assert.ok(small.p50Ms < DEFAULT_PERFORMANCE_BUDGETS.checkpointPersistSmallMs * 3);

        const medium = measurePersistenceLatency(tmpDir, "medium", 3);
        assert.equal(medium.sizeBytes, 350 * 1024);
        assert.ok(medium.p50Ms < DEFAULT_PERFORMANCE_BUDGETS.checkpointPersistMediumMs * 3);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("measures vector retrieval latency across 500 vector chunks within budget", () => {
      const store = new VectorStore();
      for (let i = 0; i < 50; i++) {
        const chunks = [];
        for (let j = 0; j < 10; j++) {
          const vec = new Array(16).fill(0).map(() => Math.random());
          const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
          chunks.push({
            path: `file_${i}.ts`,
            startLine: j * 10 + 1,
            endLine: j * 10 + 10,
            text: `function f${i}_${j}() {}`,
            vector: vec.map((v) => v / norm),
          });
        }
        store.setFile(`file_${i}.ts`, chunks, Date.now());
      }

      const retrieval = measureRetrievalLatency(
        (query, topK) => store.query(query, topK),
        16,
        15
      );

      assert.ok(retrieval.p50Ms >= 0);
      assert.ok(retrieval.p95Ms < DEFAULT_PERFORMANCE_BUDGETS.retrieval1kP95Ms);
    });

    it("measures turn cancellation responsiveness within budget", async () => {
      const latency = await measureCancellationResponsiveness(async (signal) => {
        return new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });

      assert.ok(latency >= 0);
      assert.ok(latency < DEFAULT_PERFORMANCE_BUDGETS.cancellationResponseMs * 2);
    });
  });
});
