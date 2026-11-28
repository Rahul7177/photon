import type * as vscode from "vscode";
import { isLocalModel, type ModelInfo, type TurnReliabilitySummary } from "../shared/types";
import { passportKey, updatePassport, type PassportEntry } from "../core/adaptive/passport";

const KEY = "photon.passport";
const MAX = 200;

/**
 * Host persistence for on-device Capability Passports (Phase 3.4).
 * Stored locally in VS Code globalState next to `BenchStore`; never leaves the machine.
 */
export class PassportStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  all(): PassportEntry[] {
    return this.context.globalState.get<PassportEntry[]>(KEY, []);
  }

  forModel(
    model: Pick<ModelInfo, "name" | "quantization" | "provider"> | string,
    runtimeOverride?: string
  ): PassportEntry | undefined {
    const info = typeof model === "string" ? { name: model } : model;
    const runtime = runtimeOverride ?? (info.provider && isLocalModel(info) ? info.provider : "ollama");
    const exactKey = passportKey({ model: info.name, quantization: info.quantization, runtime });
    const entries = this.all();
    const exact = entries.find((e) => e.key === exactKey);
    if (exact) return exact;
    return entries.find((e) => e.model === info.name);
  }

  byModel(models: readonly ModelInfo[]): Map<string, PassportEntry> {
    const map = new Map<string, PassportEntry>();
    for (const m of models) {
      const entry = this.forModel(m);
      if (entry) map.set(m.name, entry);
    }
    return map;
  }

  async recordTurn(
    model: Pick<ModelInfo, "name" | "quantization" | "provider">,
    summary: TurnReliabilitySummary
  ): Promise<PassportEntry | undefined> {
    if (!isLocalModel(model)) return undefined;
    const id = {
      model: model.name,
      quantization: model.quantization,
      runtime: model.provider ?? "ollama",
    };
    const key = passportKey(id);
    const all = this.all();
    const prev = all.find((e) => e.key === key) ?? all.find((e) => e.model === model.name);
    const next = updatePassport(prev, id, summary);
    if (!next) return prev;
    const filtered = all.filter((e) => e.key !== next.key);
    filtered.push(next);
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    await this.context.globalState.update(KEY, filtered.slice(0, MAX));
    return next;
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(KEY, []);
  }
}
