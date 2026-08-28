import { useState } from "react";
import type { PerModelConfig, LlamaCppSettings } from "../../../src/shared/types";
import type { AppState, Actions } from "../state/store";

function launchPreview(model: string, baseUrl: string, cfg?: PerModelConfig): string {
  const lc = cfg?.llamacpp;
  const ctx = lc?.ctx ?? cfg?.numCtx;
  const parts = ["llama-server", "-m", model.replace(/^llamacpp:/, "") || "<model.gguf>"];
  if (ctx) parts.push("-c", String(ctx));
  if (lc?.ngl !== undefined) parts.push("-ngl", String(lc.ngl));
  if (lc?.fit !== undefined) parts.push(lc.fit ? "--fit" : "--no-fit");
  if (lc?.np !== undefined) parts.push("-np", String(lc.np));
  if (lc?.fa !== undefined) parts.push("-fa", lc.fa ? "on" : "off");
  if (lc?.ctk) parts.push("-ctk", lc.ctk);
  if (lc?.ctv) parts.push("-ctv", lc.ctv);
  try {
    const port = new URL(baseUrl).port;
    if (port && port !== "8080") parts.push("--port", port);
  } catch {}
  if (lc?.extraArgs) parts.push(lc.extraArgs);
  return parts.join(" ");
}

const isLocalModel = (m: { provider?: string }) =>
  !m.provider || m.provider === "ollama" || m.provider === "llamacpp";

export function ModelConfigs({ state, actions }: { state: AppState; actions: Actions }) {
  const [editing, setEditing] = useState<string | null>(null);
  const baseUrl = state.config.llamacppBaseUrl || "http://localhost:8080";
  const localModels = state.models.filter(isLocalModel);

  if (localModels.length === 0) {
    return (
      <div className="settings-hint">
        No local models loaded — start Ollama or llama.cpp and pull a model, or switch to <b>Local</b> mode.
      </div>
    );
  }

  return (
    <div className="model-config-list">
      {localModels.map((m) => {
        const cfg = state.modelConfigs[m.name];
        const isLlama = m.provider === "llamacpp";
        const open = editing === m.name;
        return (
          <div key={m.name} className="model-config-row">
            <div className="model-config-head" onClick={() => setEditing(open ? null : m.name)}>
              <span className="model-config-name" title={m.name}>
                {m.name}
              </span>
              <span className="model-config-meta">
                {cfg?.numCtx || cfg?.llamacpp?.ctx ? `${cfg.numCtx ?? cfg.llamacpp?.ctx} ctx` : `${m.contextLength ?? "?"} ctx`} {isLlama ? "· llamacpp" : ""}
              </span>
              <span className={`expand-chevron ${open ? "open" : ""}`}>›</span>
            </div>
            {open && (
              <ModelEditor
                model={m.name}
                isLlama={isLlama}
                cfg={cfg}
                baseUrl={baseUrl}
                onSave={(next) => {
                  actions.setPerModelConfig(m.name, next);
                  setEditing(null);
                }}
                onClear={() => {
                  actions.removePerModelConfig(m.name);
                  setEditing(null);
                }}
                onClose={() => setEditing(null)}
              />
            )}
            {!open && isLlama && cfg && (
              <div className="settings-hint" style={{ padding: "0 8px 6px", fontFamily: "var(--mono)", fontSize: "10px" }}>
                {launchPreview(m.name, baseUrl, cfg)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ModelEditor({
  model,
  isLlama,
  cfg,
  baseUrl,
  onSave,
  onClear,
  onClose,
}: {
  model: string;
  isLlama: boolean;
  cfg?: PerModelConfig;
  baseUrl: string;
  onSave: (c: PerModelConfig) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [numCtx, setNumCtx] = useState(String(cfg?.numCtx ?? cfg?.llamacpp?.ctx ?? ""));
  const [note, setNote] = useState(cfg?.note ?? "");
  const [lc, setLc] = useState<LlamaCppSettings>(cfg?.llamacpp ?? {});
  const [nglStr, setNglStr] = useState(
    lc.ngl === undefined ? "" : String(lc.ngl)
  );

  const commit = () => {
    const next: PerModelConfig = {};
    const n = parseInt(numCtx, 10);
    if (Number.isFinite(n) && n > 0) next.numCtx = n;
    if (note.trim()) next.note = note.trim();
    if (isLlama) {
      const out: LlamaCppSettings = {};
      const c = parseInt(numCtx, 10);
      if (Number.isFinite(c) && c > 0) out.ctx = c;
      if (nglStr.trim() !== "") {
        const v = nglStr.trim().toLowerCase();
        out.ngl = v === "all" ? "all" : parseInt(v, 10) || 0;
      }
      if (lc.fit !== undefined) out.fit = lc.fit;
      if (lc.np !== undefined) out.np = lc.np;
      if (lc.fa !== undefined) out.fa = lc.fa;
      if (lc.ctk?.trim()) out.ctk = lc.ctk.trim();
      if (lc.ctv?.trim()) out.ctv = lc.ctv.trim();
      if (lc.extraArgs?.trim()) out.extraArgs = lc.extraArgs.trim();
      if (Object.keys(out).length) next.llamacpp = out;
      // numCtx already in top-level; for llamacpp keep ctx alias in llamacpp.ctx too
    }
    if (!next.numCtx && !next.llamacpp && !next.note) {
      onClear();
      return;
    }
    onSave(next);
  };

  return (
    <div className="model-config-edit">
      <label className="custom-endpoint-field">
        <span>Context window (-c) — 0 = auto ({isLlama ? "llama.cpp" : "Ollama/cloud"} uses model default)</span>
        <input
          type="number"
          placeholder="e.g. 32768"
          value={numCtx}
          onChange={(e) => setNumCtx(e.target.value)}
        />
      </label>
      {isLlama && (
        <>
          <div className="model-config-grid">
            <label className="custom-endpoint-field">
              <span>-ngl (GPU layers, "all" or 0..N)</span>
              <input placeholder="all" value={nglStr} onChange={(e) => setNglStr(e.target.value)} />
            </label>
            <label className="custom-endpoint-field">
              <span>-np (parallel slots)</span>
              <input type="number" placeholder="1" value={lc.np ?? ""} onChange={(e) => setLc({ ...lc, np: e.target.value ? parseInt(e.target.value, 10) : undefined })} />
            </label>
          </div>
          <div className="model-config-grid">
            <label className="custom-endpoint-field">
              <span>--fit</span>
              <select value={lc.fit === undefined ? "" : lc.fit ? "on" : "off"} onChange={(e) => setLc({ ...lc, fit: e.target.value === "" ? undefined : e.target.value === "on" })}>
                <option value="">auto</option>
                <option value="on">on (--fit)</option>
                <option value="off">off (--no-fit)</option>
              </select>
            </label>
            <label className="custom-endpoint-field">
              <span>-fa (flash attn)</span>
              <select value={lc.fa === undefined ? "" : lc.fa ? "on" : "off"} onChange={(e) => setLc({ ...lc, fa: e.target.value === "" ? undefined : e.target.value === "on" })}>
                <option value="">auto</option>
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            </label>
          </div>
          <div className="model-config-grid">
            <label className="custom-endpoint-field">
              <span>-ctk (cache K, e.g. q8_0)</span>
              <input placeholder="q8_0" value={lc.ctk ?? ""} onChange={(e) => setLc({ ...lc, ctk: e.target.value || undefined })} />
            </label>
            <label className="custom-endpoint-field">
              <span>-ctv (cache V)</span>
              <input placeholder="q8_0" value={lc.ctv ?? ""} onChange={(e) => setLc({ ...lc, ctv: e.target.value || undefined })} />
            </label>
          </div>
          <label className="custom-endpoint-field">
            <span>Extra args</span>
            <input placeholder='e.g. --jinja --reasoning-format deepseek' value={lc.extraArgs ?? ""} onChange={(e) => setLc({ ...lc, extraArgs: e.target.value || undefined })} />
          </label>
          <div className="settings-hint" style={{ fontFamily: "var(--mono)", fontSize: "10px", background: "var(--space-850)", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--line)" }}>
            Preview: {launchPreview(model, baseUrl, { numCtx: parseInt(numCtx, 10) || undefined, llamacpp: { ...lc, ctx: parseInt(numCtx, 10) || undefined, ngl: nglStr.trim() ? (nglStr.trim().toLowerCase() === "all" ? "all" : parseInt(nglStr) as any) : undefined } })}
            <button
              className="btn btn-sm ghost"
              style={{ marginLeft: 8 }}
              onClick={() => navigator.clipboard.writeText(launchPreview(model, baseUrl, { numCtx: parseInt(numCtx, 10) || undefined, llamacpp: { ...lc, ctx: parseInt(numCtx, 10) || undefined } }))}
            >
              Copy
            </button>
          </div>
        </>
      )}
      <label className="custom-endpoint-field">
        <span>Note</span>
        <input placeholder="e.g. 8B Q8 for coding" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="custom-endpoint-actions">
        <button className="btn btn-sm btn-accent" onClick={commit}>Save</button>
        <button className="btn btn-sm ghost" onClick={onClose}>Cancel</button>
        {cfg && <button className="btn btn-sm" style={{ marginLeft: "auto", color: "var(--red)" }} onClick={onClear}>Clear</button>}
      </div>
    </div>
  );
}
