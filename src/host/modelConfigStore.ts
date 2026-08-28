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
    if (!next.numCtx) delete (next as any).numCtx;
    // Prune empty llamacpp
    if (next.llamacpp && Object.keys(next.llamacpp).length === 0) delete (next as any).llamacpp;
    await this.set(model, next);
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
