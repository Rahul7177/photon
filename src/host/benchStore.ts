import * as vscode from "vscode";
import type { BenchResult } from "../shared/types";

const KEY = "photon.bench";
const MAX = 200;

/**
 * Persists Photon Bench results (M7) across reloads, keyed by model +
 * hardware class + methodology version so a rubric change or a different
 * machine never overwrites an incomparable result.
 */
export class BenchStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  all(): BenchResult[] {
    return this.context.globalState.get<BenchResult[]>(KEY, []);
  }

  /** Latest result per model (for the current view — most recent wins). */
  byModel(): Map<string, BenchResult> {
    const map = new Map<string, BenchResult>();
    for (const r of this.all()) {
      const prev = map.get(r.model);
      if (!prev || r.ranAt > prev.ranAt) map.set(r.model, r);
    }
    return map;
  }

  async upsert(result: BenchResult): Promise<void> {
    const key = (r: BenchResult) => `${r.model}|${r.hardwareClass}|${r.methodologyVersion}`;
    const all = this.all().filter((r) => key(r) !== key(result));
    all.push(result);
    // Bound growth; keep the most recent.
    all.sort((a, b) => b.ranAt - a.ranAt);
    await this.context.globalState.update(KEY, all.slice(0, MAX));
  }
}
