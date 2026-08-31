import type { PerModelConfig } from "../shared/types";
import type * as vscode from "vscode";

const KEY = "photon.perModelConfigs";

export class ModelConfigStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  all(): Record<string, PerModelConfig> {
    return this.ctx.globalState.get<Record<string, PerModelConfig>>(KEY) ?? {};
  }

  get(model: string): PerModelConfig | undefined {
    return this.all()[model];
  }

  async set(model: string, cfg: PerModelConfig): Promise<void> {
    const all = this.all();
    all[model] = cfg;
    await this.ctx.globalState.update(KEY, all);
  }

  async patch(model: string, patch: Partial<PerModelConfig>): Promise<void> {
    const cur = this.get(model) ?? {};
    const next: PerModelConfig = { ...cur, ...patch };
    // Deep-merge llamacpp sub-object
    if (patch.llamacpp && cur.llamacpp) next.llamacpp = { ...cur.llamacpp, ...patch.llamacpp };
    if (patch.sampling && cur.sampling) next.sampling = { ...cur.sampling, ...patch.sampling };
    if (!next.numCtx) delete (next as any).numCtx;
    // Prune empty llamacpp
    if (next.llamacpp && Object.keys(next.llamacpp).length === 0) delete (next as any).llamacpp;
    if (next.sampling && Object.keys(next.sampling).length === 0) delete (next as any).sampling;
    if (next.sampling) {
      if (next.sampling.temp === undefined) delete (next.sampling as any).temp;
      if (next.sampling.topP === undefined) delete (next.sampling as any).topP;
      if (next.sampling.seed === undefined) delete (next.sampling as any).seed;
      if (Object.keys(next.sampling).length === 0) delete (next as any).sampling;
    }
    await this.set(model, next);
  }

  /** Effective config for a model, with file-wins merging (Phase 1.4). */
  effective(model: string, fileConfigs?: Record<string, PerModelConfig>): PerModelConfig | undefined {
    const stored = this.get(model);
    const file = fileConfigs?.[model];
    if (!file) return stored;
    if (!stored) return file;
    // File wins: shallow merge, with deep merge for sub-objects
    const merged: PerModelConfig = { ...stored, ...file };
    if (stored.llamacpp || file.llamacpp) merged.llamacpp = { ...(stored.llamacpp ?? {}), ...(file.llamacpp ?? {}) };
    if (stored.sampling || file.sampling) merged.sampling = { ...(stored.sampling ?? {}), ...(file.sampling ?? {}) };
    return merged;
  }

  async remove(model: string): Promise<void> {
    const all = this.all();
    delete all[model];
    await this.ctx.globalState.update(KEY, all);
  }

  /** Build the llama-server launch command for a llamacpp model + its config. */
  static launchCommand(modelName: string, baseUrl: string, cfg?: PerModelConfig): string {
    const lc = cfg?.llamacpp;
    const ctx = lc?.ctx ?? cfg?.numCtx;
    const ngl = lc?.ngl;
    const fit = lc?.fit;
    const np = lc?.np;
    const fa = lc?.fa;
    const ctk = lc?.ctk;
    const ctv = lc?.ctv;
    const port = (() => { try { return new URL(baseUrl).port || "8080"; } catch { return "8080"; } })();
    const modelFile = modelName.replace(/^llamacpp:/, "") || "<model.gguf>";
    const parts = ["llama-server", "-m", modelFile];
    if (ctx && ctx > 0) parts.push("-c", String(ctx));
    if (ngl !== undefined) parts.push("-ngl", String(ngl));
    if (fit !== undefined) parts.push(fit ? "--fit" : "--no-fit");
    if (np !== undefined) parts.push("-np", String(np));
    if (fa !== undefined) parts.push("-fa", fa ? "on" : "off");
    if (ctk) parts.push("-ctk", ctk);
    if (ctv) parts.push("-ctv", ctv);
    if (port !== "8080") parts.push("--port", port);
    if (lc?.extraArgs) parts.push(lc.extraArgs);
    return parts.join(" ");
  }
}
