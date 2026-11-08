import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { computePercentiles } from "./bench";

/**
 * Target budgets for Photon runtime operations.
 * Established based on sub-second interactive latency and bounded memory consumption.
 */
export interface PerformanceBudgets {
  /** Cold activation to ready state: <= 500 ms */
  activationMs: number;
  /** First token latency: <= 800 ms */
  firstTokenMs: number;
  /** Webview UI token streaming frame rate: >= 30 fps */
  tokenStreamingFps: number;
  /** Snapshot/persist for small files (< 50 KB): <= 25 ms */
  checkpointPersistSmallMs: number;
  /** Snapshot/persist for medium files (~500 KB): <= 120 ms */
  checkpointPersistMediumMs: number;
  /** Vector retrieval p50 with 1,000 chunks: <= 15 ms */
  retrieval1kP50Ms: number;
  /** Vector retrieval p95 with 1,000 chunks: <= 35 ms */
  retrieval1kP95Ms: number;
  /** Vector retrieval p50 with 8,000 chunks: <= 50 ms */
  retrieval8kP50Ms: number;
  /** Vector retrieval p95 with 8,000 chunks: <= 100 ms */
  retrieval8kP95Ms: number;
  /** Project indexing throughput: >= 1,200 files/min */
  indexingFilesPerMinute: number;
  /** Turn cancellation responsiveness: <= 50 ms */
  cancellationResponseMs: number;
  /** MCP client connect & initialize: <= 500 ms */
  mcpConnectMs: number;
}

export const DEFAULT_PERFORMANCE_BUDGETS: PerformanceBudgets = {
  activationMs: 500,
  firstTokenMs: 800,
  tokenStreamingFps: 30,
  checkpointPersistSmallMs: 25,
  checkpointPersistMediumMs: 120,
  retrieval1kP50Ms: 15,
  retrieval1kP95Ms: 35,
  retrieval8kP50Ms: 50,
  retrieval8kP95Ms: 100,
  indexingFilesPerMinute: 1200,
  cancellationResponseMs: 50,
  mcpConnectMs: 500,
};

export interface PerformanceReport {
  passed: boolean;
  violations: string[];
  measured: Record<string, number>;
  budgets: PerformanceBudgets;
}

/**
 * Validates measured performance metrics against defined targets.
 */
export function validatePerformanceAgainstBudgets(
  measured: Partial<PerformanceBudgets>,
  budgets: PerformanceBudgets = DEFAULT_PERFORMANCE_BUDGETS
): PerformanceReport {
  const violations: string[] = [];
  const measuredRecord: Record<string, number> = {};

  for (const [key, val] of Object.entries(measured)) {
    if (typeof val !== "number") continue;
    measuredRecord[key] = val;
    const target = budgets[key as keyof PerformanceBudgets];
    if (typeof target !== "number") continue;

    // Minimum targets (higher is better)
    if (key === "tokenStreamingFps" || key === "indexingFilesPerMinute") {
      if (val < target) {
        violations.push(`${key}: measured ${val} is below minimum target of ${target}`);
      }
    } else {
      // Maximum latency targets (lower is better)
      if (val > target) {
        violations.push(`${key}: measured ${val}ms exceeds maximum target of ${target}ms`);
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    measured: measuredRecord,
    budgets,
  };
}

/**
 * Measures file persistence latency across small/medium file tiers in a temporary directory.
 */
export function measurePersistenceLatency(
  targetDir: string,
  fileSizeTier: "small" | "medium" | "nearLimit",
  iterations = 5
): { p50Ms: number; p95Ms: number; meanMs: number; sizeBytes: number } {
  const sizeMap = {
    small: 15 * 1024,      // 15 KB
    medium: 350 * 1024,    // 350 KB
    nearLimit: 1.5 * 1024 * 1024, // 1.5 MB
  };
  const sizeBytes = sizeMap[fileSizeTier];
  const buffer = Buffer.alloc(sizeBytes, "a");
  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const filePath = path.join(targetDir, `perf_test_${fileSizeTier}_${i}.tmp`);
    const t0 = performance.now();
    fs.writeFileSync(filePath, buffer);
    fs.readFileSync(filePath);
    const elapsed = performance.now() - t0;
    samples.push(elapsed);
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }

  const stats = computePercentiles(samples);
  return {
    p50Ms: stats.p50,
    p95Ms: stats.p95,
    meanMs: stats.mean,
    sizeBytes,
  };
}

/**
 * Measures vector store similarity search p50 and p95 latency.
 */
export function measureRetrievalLatency(
  storeQueryFn: (query: number[], topK: number) => unknown[],
  vectorDimension: number,
  iterations = 20
): { p50Ms: number; p95Ms: number; meanMs: number } {
  const query = new Array(vectorDimension).fill(0).map(() => Math.random());
  // Normalize query
  const norm = Math.sqrt(query.reduce((sum, v) => sum + v * v, 0)) || 1;
  const normalized = query.map((v) => v / norm);

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    storeQueryFn(normalized, 10);
    const elapsed = performance.now() - t0;
    samples.push(elapsed);
  }

  const stats = computePercentiles(samples);
  return {
    p50Ms: stats.p50,
    p95Ms: stats.p95,
    meanMs: stats.mean,
  };
}

/**
 * Measures turn cancellation responsiveness (time from abort signal trigger to callback).
 */
export function measureCancellationResponsiveness(
  triggerFn: (signal: AbortSignal) => Promise<void>
): Promise<number> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const t0 = performance.now();
    void triggerFn(ac.signal).finally(() => {
      const elapsed = performance.now() - t0;
      resolve(Math.round(elapsed * 100) / 100);
    });
    // Trigger abort after 5ms
    setTimeout(() => {
      ac.abort();
    }, 5);
  });
}

