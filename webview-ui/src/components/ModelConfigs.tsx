import { useEffect, useMemo, useState } from "react";
import {
  isLocalModel,
  type LlamaCppSettings,
  type ModelInfo,
  type PerModelConfig,
} from "../../../src/shared/types";
import type { Actions, AppState } from "../state/store";
import { ChevronRightIcon } from "./Icons";
import { HelpTip } from "./HelpTip";

export interface ModelConfigEntry {
  name: string;
  model?: ModelInfo;
  cfg?: PerModelConfig;
  isLlama: boolean;
  isLocal: boolean;
  isSelected: boolean;
  fromProjectFile: boolean;
}

/** Combine active catalog models and any extra configured keys from global/project config. */
export function buildPerModelConfigEntries(
  models: ModelInfo[],
  modelConfigs: Record<string, PerModelConfig>,
  selectedModel: string,
  fileKeys: string[] = []
): ModelConfigEntry[] {
  const fileSet = new Set(fileKeys);
  const byName = new Map<string, ModelConfigEntry>();

  for (const m of models) {
    byName.set(m.name, {
      name: m.name,
      model: m,
      cfg: modelConfigs[m.name],
      isLlama: m.provider === "llamacpp",
      isLocal: isLocalModel(m),
      isSelected: m.name === selectedModel,
      fromProjectFile: fileSet.has(m.name),
    });
  }

  for (const name of Object.keys(modelConfigs)) {
    if (byName.has(name)) continue;
    byName.set(name, {
      name,
      cfg: modelConfigs[name],
      isLlama: name.startsWith("llamacpp:"),
      isLocal: isLocalModel({ name }),
      isSelected: name === selectedModel,
      fromProjectFile: fileSet.has(name),
    });
  }

  return Array.from(byName.values()).sort((a, b) => {
    if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
    const aHas = Boolean(a.cfg);
    const bHas = Boolean(b.cfg);
    if (aHas !== bHas) return aHas ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function parseNglInput(raw: string): number | "all" | undefined {
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "all") return "all";
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function launchPreview(model: string, baseUrl: string, cfg?: PerModelConfig): string {
  const lc = cfg?.llamacpp;
  const ctx = lc?.ctx ?? cfg?.numCtx;
  const rawFile = model.replace(/^llamacpp:/, "") || "<model.gguf>";
  const modelFile = /\s/.test(rawFile) ? `"${rawFile}"` : rawFile;
  const parts = ["llama-server", "-m", modelFile];
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

function summarizeMeta(entry: ModelConfigEntry): string {
  const { cfg, model, isLlama } = entry;
  const parts: string[] = [];
  const effCtx = cfg?.numCtx ?? cfg?.llamacpp?.ctx;
  parts.push(effCtx ? `${effCtx} ctx` : `${model?.contextLength ?? "auto"} ctx`);
  if (cfg?.sampling?.temp !== undefined) parts.push(`T=${cfg.sampling.temp}`);
  if (cfg?.sampling?.topP !== undefined) parts.push(`P=${cfg.sampling.topP}`);
  if (cfg?.sampling?.seed !== undefined) parts.push(`seed=${cfg.sampling.seed}`);
  if (isLlama) parts.push("llamacpp");
  return parts.join(" · ");
}

export function ModelConfigs({ state, actions }: { state: AppState; actions: Actions }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const baseUrl = state.config.llamacppBaseUrl || "http://localhost:8080";

  const entries = useMemo(
    () =>
      buildPerModelConfigEntries(
        state.models,
        state.modelConfigs,
        state.selectedModel,
        state.config.fileModelConfigKeys ?? []
      ),
    [state.models, state.modelConfigs, state.selectedModel, state.config.fileModelConfigKeys]
  );

  const visibleEntries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (e.cfg?.note ?? "").toLowerCase().includes(q)
    );
  }, [entries, filter]);

  if (entries.length === 0) {
    return (
      <div className="settings-hint">
        No models loaded — connect a cloud provider, start Ollama/llama.cpp, or define{" "}
        <code>modelConfigs</code> in <code>.photon/config.json</code>.
      </div>
    );
  }

  return (
    <div className="model-config-list">
      {entries.length > 5 && (
        <input
          type="text"
          className="preset-filter-input"
          placeholder="Filter models or notes…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {visibleEntries.map((entry) => {
        const { name, cfg, isLlama, isSelected, fromProjectFile } = entry;
        const open = editing === name;
        return (
          <div key={name} className="model-config-row">
            <div className="model-config-head" onClick={() => setEditing(open ? null : name)}>
              <span className="model-config-name" title={name}>
                {name}
              </span>
              {isSelected && <span className="model-config-badge active">active</span>}
              {fromProjectFile && (
                <span
                  className="model-config-badge project"
                  title="Overridden by checked-in .photon/config.json"
                >
                  project
                </span>
              )}
              <span className="model-config-meta">{summarizeMeta(entry)}</span>
              <span className={`expand-chevron ${open ? "open" : ""}`}>
                <ChevronRightIcon />
              </span>
            </div>
            {open && (
              <ModelEditor
                model={name}
                isLlama={isLlama}
                isLocal={entry.isLocal}
                fromProjectFile={fromProjectFile}
                cfg={cfg}
                baseUrl={baseUrl}
                onSave={(next) => {
                  actions.setPerModelConfig(name, next);
                  setEditing(null);
                }}
                onClear={() => {
                  actions.removePerModelConfig(name);
                  setEditing(null);
                }}
                onClose={() => setEditing(null)}
              />
            )}
            {!open && isLlama && cfg && (
              <div
                className="settings-hint"
                style={{ padding: "0 8px 6px", fontFamily: "var(--mono)", fontSize: "10px" }}
              >
                {launchPreview(name, baseUrl, cfg)}
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
  isLocal,
  fromProjectFile,
  cfg,
  baseUrl,
  onSave,
  onClear,
  onClose,
}: {
  model: string;
  isLlama: boolean;
  isLocal: boolean;
  fromProjectFile: boolean;
  cfg?: PerModelConfig;
  baseUrl: string;
  onSave: (c: PerModelConfig) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [numCtx, setNumCtx] = useState(String(cfg?.numCtx ?? cfg?.llamacpp?.ctx ?? ""));
  const [tempStr, setTempStr] = useState(
    cfg?.sampling?.temp !== undefined ? String(cfg.sampling.temp) : ""
  );
  const [topPStr, setTopPStr] = useState(
    cfg?.sampling?.topP !== undefined ? String(cfg.sampling.topP) : ""
  );
  const [seedStr, setSeedStr] = useState(
    cfg?.sampling?.seed !== undefined ? String(cfg.sampling.seed) : ""
  );
  const [note, setNote] = useState(cfg?.note ?? "");
  const [lc, setLc] = useState<LlamaCppSettings>(cfg?.llamacpp ?? {});
  const [nglStr, setNglStr] = useState(lc.ngl === undefined ? "" : String(lc.ngl));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setNumCtx(String(cfg?.numCtx ?? cfg?.llamacpp?.ctx ?? ""));
    setTempStr(cfg?.sampling?.temp !== undefined ? String(cfg.sampling.temp) : "");
    setTopPStr(cfg?.sampling?.topP !== undefined ? String(cfg.sampling.topP) : "");
    setSeedStr(cfg?.sampling?.seed !== undefined ? String(cfg.sampling.seed) : "");
    setNote(cfg?.note ?? "");
    const nextLc = cfg?.llamacpp ?? {};
    setLc(nextLc);
    setNglStr(nextLc.ngl === undefined ? "" : String(nextLc.ngl));
  }, [model, cfg]);

  const draftLlamaCfg = (): PerModelConfig => {
    const parsedCtx = parseInt(numCtx, 10);
    const out: LlamaCppSettings = { ...lc };
    if (Number.isFinite(parsedCtx) && parsedCtx > 0) out.ctx = parsedCtx;
    else delete out.ctx;
    const parsedNgl = parseNglInput(nglStr);
    if (parsedNgl !== undefined) out.ngl = parsedNgl;
    else delete out.ngl;
    return {
      numCtx: Number.isFinite(parsedCtx) && parsedCtx > 0 ? parsedCtx : undefined,
      llamacpp: out,
    };
  };

  const commit = () => {
    const next: PerModelConfig = {};
    const n = parseInt(numCtx, 10);
    if (Number.isFinite(n) && n > 0) next.numCtx = n;
    if (note.trim()) next.note = note.trim();

    const sp: NonNullable<PerModelConfig["sampling"]> = {};
    if (tempStr.trim() !== "") {
      const t = Number(tempStr);
      if (Number.isFinite(t) && t >= 0 && t <= 2) sp.temp = t;
    }
    if (topPStr.trim() !== "") {
      const p = Number(topPStr);
      if (Number.isFinite(p) && p > 0 && p <= 1) sp.topP = p;
    }
    if (seedStr.trim() !== "") {
      const s = Number(seedStr);
      if (Number.isFinite(s) && s >= 0) sp.seed = Math.floor(s);
    }
    if (Object.keys(sp).length > 0) next.sampling = sp;

    if (isLlama) {
      const out: LlamaCppSettings = {};
      if (Number.isFinite(n) && n > 0) out.ctx = n;
      const parsedNgl = parseNglInput(nglStr);
      if (parsedNgl !== undefined) out.ngl = parsedNgl;
      if (lc.fit !== undefined) out.fit = lc.fit;
      if (lc.np !== undefined && lc.np > 0) out.np = Math.floor(lc.np);
      if (lc.fa !== undefined) out.fa = lc.fa;
      if (lc.ctk?.trim()) out.ctk = lc.ctk.trim();
      if (lc.ctv?.trim()) out.ctv = lc.ctv.trim();
      if (lc.extraArgs?.trim()) out.extraArgs = lc.extraArgs.trim();
      if (Object.keys(out).length) next.llamacpp = out;
    }

    if (!next.numCtx && !next.llamacpp && !next.sampling && !next.note) {
      onClear();
      return;
    }
    onSave(next);
  };

  const previewCmd = isLlama ? launchPreview(model, baseUrl, draftLlamaCfg()) : "";

  return (
    <div className="model-config-edit">
      {fromProjectFile && (
        <div className="settings-hint">
          Values marked <strong>project</strong> currently inherit workspace overrides from{" "}
          <code>.photon/config.json</code>.
        </div>
      )}

      <label className="custom-endpoint-field">
        <span className="field-label-with-help">
          <span>
            Context window ({isLocal ? "0 = auto hardware fit" : "0 = model native"})
          </span>
          <HelpTip text="Maximum tokens of conversation and file content this model can read at once. Leave empty or 0 for automatic sizing." />
        </span>
        <input
          type="number"
          min={0}
          placeholder="e.g. 32768"
          value={numCtx}
          onChange={(e) => setNumCtx(e.target.value)}
        />
      </label>

      <div className="model-config-grid-3">
        <label className="custom-endpoint-field">
          <span className="field-label-with-help">
            <span>Temp (0–2)</span>
            <HelpTip text="Controls randomness. Lower (0.1–0.3) is more focused and accurate for coding; higher (0.7+) is more creative." />
          </span>
          <input
            type="number"
            step="0.05"
            min={0}
            max={2}
            placeholder="auto"
            value={tempStr}
            onChange={(e) => setTempStr(e.target.value)}
          />
        </label>
        <label className="custom-endpoint-field">
          <span className="field-label-with-help">
            <span>Top P (0–1)</span>
            <HelpTip text="Limits word choices to the most likely options. Leave on auto unless fine-tuning generation." />
          </span>
          <input
            type="number"
            step="0.05"
            min={0.05}
            max={1}
            placeholder="auto"
            value={topPStr}
            onChange={(e) => setTopPStr(e.target.value)}
          />
        </label>
        <label className="custom-endpoint-field">
          <span className="field-label-with-help">
            <span>Seed</span>
            <HelpTip text="Fixed random number so the model gives repeatable answers for the same prompt." />
          </span>
          <input
            type="number"
            min={0}
            placeholder="auto"
            value={seedStr}
            onChange={(e) => setSeedStr(e.target.value)}
          />
        </label>
      </div>

      {isLlama && (
        <>
          <div className="model-config-grid">
            <label className="custom-endpoint-field">
              <span className="field-label-with-help">
                <span>GPU layers (-ngl)</span>
                <HelpTip text="How many model layers run on your GPU. Use 'all' for maximum speed, or lower it if you run out of VRAM." />
              </span>
              <input
                placeholder="all"
                value={nglStr}
                onChange={(e) => setNglStr(e.target.value)}
              />
            </label>
            <label className="custom-endpoint-field">
              <span className="field-label-with-help">
                <span>Parallel slots (-np)</span>
                <HelpTip text="Simultaneous requests llama-server can handle. Keep at 1 to save VRAM." />
              </span>
              <input
                type="number"
                min={1}
                placeholder="1"
                value={lc.np ?? ""}
                onChange={(e) =>
                  setLc({
                    ...lc,
                    np: e.target.value ? parseInt(e.target.value, 10) : undefined,
                  })
                }
              />
            </label>
          </div>
          <div className="model-config-grid">
            <label className="custom-endpoint-field">
              <span className="field-label-with-help">
                <span>Auto-fit VRAM (--fit)</span>
                <HelpTip text="Automatically adjusts GPU layers and context size so the model fits in your available VRAM." />
              </span>
              <select
                value={lc.fit === undefined ? "" : lc.fit ? "on" : "off"}
                onChange={(e) =>
                  setLc({
                    ...lc,
                    fit: e.target.value === "" ? undefined : e.target.value === "on",
                  })
                }
              >
                <option value="">auto</option>
                <option value="on">on (--fit)</option>
                <option value="off">off (--no-fit)</option>
              </select>
            </label>
            <label className="custom-endpoint-field">
              <span className="field-label-with-help">
                <span>Flash Attention (-fa)</span>
                <HelpTip text="Speeds up generation and reduces memory usage on supported GPUs." />
              </span>
              <select
                value={lc.fa === undefined ? "" : lc.fa ? "on" : "off"}
                onChange={(e) =>
                  setLc({
                    ...lc,
                    fa: e.target.value === "" ? undefined : e.target.value === "on",
                  })
                }
              >
                <option value="">auto</option>
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            </label>
          </div>
          <div className="model-config-grid">
            <label className="custom-endpoint-field">
              <span className="field-label-with-help">
                <span>Cache K quant (-ctk)</span>
                <HelpTip text="Compresses the K memory cache (e.g. q8_0 or q4_0) to fit larger context windows in less VRAM." />
              </span>
              <input
                placeholder="q8_0"
                value={lc.ctk ?? ""}
                onChange={(e) => setLc({ ...lc, ctk: e.target.value || undefined })}
              />
            </label>
            <label className="custom-endpoint-field">
              <span className="field-label-with-help">
                <span>Cache V quant (-ctv)</span>
                <HelpTip text="Compresses the V memory cache (e.g. q8_0 or q4_0) to save additional VRAM on long chats." />
              </span>
              <input
                placeholder="q8_0"
                value={lc.ctv ?? ""}
                onChange={(e) => setLc({ ...lc, ctv: e.target.value || undefined })}
              />
            </label>
          </div>
          <label className="custom-endpoint-field">
            <span className="field-label-with-help">
              <span>Extra launch flags</span>
              <HelpTip text="Additional command-line arguments passed directly to llama-server when launching this model." />
            </span>
            <input
              placeholder="e.g. --jinja --reasoning-format deepseek"
              value={lc.extraArgs ?? ""}
              onChange={(e) => setLc({ ...lc, extraArgs: e.target.value || undefined })}
            />
          </label>
          <div
            className="settings-hint"
            style={{
              fontFamily: "var(--mono)",
              fontSize: "10px",
              background: "var(--space-850)",
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid var(--line)",
            }}
          >
            Preview: {previewCmd}
            <button
              type="button"
              className="btn btn-sm ghost"
              style={{ marginLeft: 8 }}
              onClick={() => {
                void navigator.clipboard?.writeText(previewCmd);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </>
      )}
      <label className="custom-endpoint-field">
        <span className="field-label-with-help">
          <span>Note</span>
          <HelpTip text="Optional personal label or reminder shown next to this model." />
        </span>
        <input
          placeholder="e.g. Low temp for strict edits"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="custom-endpoint-actions">
        <button type="button" className="btn btn-sm primary" onClick={commit}>
          Save
        </button>
        <button type="button" className="btn btn-sm ghost" onClick={onClose}>
          Cancel
        </button>
        {cfg && (
          <button
            type="button"
            className="btn btn-sm danger"
            style={{ marginLeft: "auto" }}
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
