import { useEffect, useState } from "react";
import type { Actions, AppState } from "../state/store";
import { ChartIcon, CloseIcon } from "./Icons";

function fmtGb(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function fmtUsd(usd?: number): string {
  if (!usd || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function describeRuntimeCompatibility(gpuPercent: number): {
  badge: string;
  detail: string;
  tone: "ok" | "warn" | "crit";
} {
  if (gpuPercent >= 95) {
    return {
      badge: `✓ Fits in VRAM (${gpuPercent}% GPU)`,
      detail: "Running entirely in GPU memory for optimal token generation speed.",
      tone: "ok",
    };
  }
  if (gpuPercent >= 50) {
    return {
      badge: `◐ Requires Offloading (${gpuPercent}% GPU)`,
      detail: "Split across GPU VRAM and system RAM; expect moderate generation speed.",
      tone: "warn",
    };
  }
  if (gpuPercent > 0) {
    return {
      badge: `⚠ Heavy Offload (${gpuPercent}% GPU)`,
      detail: "Mostly offloaded to system RAM; may run slowly on long contexts.",
      tone: "crit",
    };
  }
  return {
    badge: "○ CPU / System RAM Only",
    detail: "Running on CPU and system RAM without GPU acceleration; may run slowly.",
    tone: "warn",
  };
}

export function HardwareMetricsModal({
  state,
  actions,
  onClose,
}: {
  state: AppState;
  actions: Actions;
  onClose: () => void;
}) {
  const [viewTab, setViewTab] = useState<"local" | "cloud">(
    state.config.interfaceMode === "cloud" ? "cloud" : "local"
  );
  const [confirmUnloadModel, setConfirmUnloadModel] = useState<string | null>(null);
  const [confirmResetCloud, setConfirmResetCloud] = useState(false);

  useEffect(() => {
    actions.requestHardwareMetrics();
    const timer = window.setInterval(() => {
      actions.requestHardwareMetrics();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [actions]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const hw = state.hardwareMetrics;
  const gpuName = hw?.gpuName ?? state.machine?.gpu?.name ?? "GPU";
  const gpuUtil = hw?.gpuUtilPercent;
  const vramUsed = hw?.vramUsedBytes;
  const vramTotal = hw?.vramTotalBytes ?? state.machine?.gpu?.vramBytes;
  const vramPercent =
    vramTotal && vramUsed !== undefined
      ? Math.min(100, Math.round((vramUsed / vramTotal) * 100))
      : undefined;

  const ramTotal = hw?.ramTotalBytes ?? state.machine?.totalRamBytes ?? 0;
  const ramFree = hw?.ramFreeBytes ?? state.machine?.freeRamBytes ?? 0;
  const ramUsed = hw?.ramUsedBytes ?? Math.max(0, ramTotal - ramFree);
  const ramPercent =
    hw?.ramUsedPercent ??
    (ramTotal > 0 ? Math.min(100, Math.round((ramUsed / ramTotal) * 100)) : 0);

  const cu = state.cloudUsage;
  const localModels = state.models.filter(
    (m) => !m.provider || m.provider === "ollama" || m.provider === "llamacpp"
  );

  return (
    <div className="hw-modal-backdrop" onClick={onClose}>
      <div
        className="hw-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hw-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hw-modal-header">
          <div className="hw-modal-title-wrap">
            <span className="hw-modal-icon" aria-hidden="true">
              <ChartIcon />
            </span>
            <span id="hw-modal-title" className="hw-modal-title">
              Hardware &amp; Telemetry
            </span>
          </div>

          <div className="ctx-modal-head-actions">
            <div className="iface-toggle" role="tablist" aria-label="Telemetry view">
              <button
                type="button"
                role="tab"
                aria-selected={viewTab === "local"}
                className={viewTab === "local" ? "active" : ""}
                onClick={() => setViewTab("local")}
              >
                Local
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewTab === "cloud"}
                className={viewTab === "cloud" ? "active" : ""}
                onClick={() => setViewTab("cloud")}
              >
                Cloud
              </button>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close Hardware and Telemetry modal"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="hw-modal-body">
          {viewTab === "local" ? (
            <>
              {/* Live Measured Hardware Summary */}
              <div className="hw-section-title">Live System Telemetry (Measured)</div>
              <div className="hw-metric-card">
                <div className="hw-metric-head">
                  <span className="hw-metric-label">{gpuName}</span>
                  <span className="hw-metric-val">
                    {gpuUtil !== undefined ? `${gpuUtil}% util` : "No live sensor"}
                    {hw?.gpuTempC !== undefined ? ` · ${hw.gpuTempC}°C` : ""}
                  </span>
                </div>
                <div className="hw-metric-bar" aria-hidden="true">
                  <div
                    className="hw-metric-fill gpu-compute"
                    style={{ width: `${gpuUtil ?? 0}%` }}
                  />
                </div>
              </div>

              <div className="hw-metric-card">
                <div className="hw-metric-head">
                  <span className="hw-metric-label">GPU VRAM</span>
                  <span className="hw-metric-val">
                    {vramUsed !== undefined && vramTotal !== undefined
                      ? `${fmtGb(vramUsed)} / ${fmtGb(vramTotal)} (${vramPercent}%)`
                      : vramTotal !== undefined
                        ? `${fmtGb(vramTotal)} total (est.)`
                        : "Shared / Unified"}
                  </span>
                </div>
                <div className="hw-metric-bar" aria-hidden="true">
                  <div
                    className={`hw-metric-fill ${
                      (vramPercent ?? 0) > 90
                        ? "crit"
                        : (vramPercent ?? 0) > 75
                          ? "warn"
                          : "ok"
                    }`}
                    style={{ width: `${vramPercent ?? 0}%` }}
                  />
                </div>
              </div>

              <div className="hw-metric-card">
                <div className="hw-metric-head">
                  <span className="hw-metric-label">
                    System RAM {state.machine?.cpuCores ? `(${state.machine.cpuCores} cores)` : ""}
                  </span>
                  <span className="hw-metric-val">
                    {ramTotal > 0
                      ? `${fmtGb(ramUsed)} / ${fmtGb(ramTotal)} (${ramPercent}%)`
                      : "N/A"}
                  </span>
                </div>
                <div className="hw-metric-bar" aria-hidden="true">
                  <div
                    className={`hw-metric-fill ${
                      ramPercent > 88 ? "crit" : ramPercent > 75 ? "warn" : "ok"
                    }`}
                    style={{ width: `${ramPercent}%` }}
                  />
                </div>
              </div>

              {/* Active Models in Memory */}
              <div className="hw-models-section">
                <div className="hw-section-title">Loaded in Runtime Memory (Measured)</div>
                {state.ollamaRuntime.length === 0 ? (
                  <div className="hw-empty-note">
                    No model is currently resident in Ollama memory. A model loads automatically on your next local prompt.
                  </div>
                ) : (
                  state.ollamaRuntime.map((rt) => {
                    const isConfirming = confirmUnloadModel === rt.name;
                    const compat = describeRuntimeCompatibility(rt.gpuPercent);
                    return (
                      <div key={rt.name} className="hw-model-card">
                        <div className="hw-model-row">
                          <div>
                            <div className="hw-model-name">{rt.name}</div>
                            <div className="hw-model-meta">
                              <span
                                className={
                                  compat.tone === "ok"
                                    ? "hw-tag-ok"
                                    : compat.tone === "crit"
                                      ? "hw-tag-crit"
                                      : "hw-tag-warn"
                                }
                              >
                                {compat.badge}
                              </span>
                              <span>· {fmtGb(rt.sizeBytes)} footprint</span>
                              {rt.contextLength > 0 && (
                                <span>· {Math.round(rt.contextLength / 1024)}k ctx</span>
                              )}
                            </div>
                            <div className="hw-compat-note">{compat.detail}</div>
                          </div>
                          {isConfirming ? (
                            <div className="hw-confirm-inline">
                              <button
                                type="button"
                                className="btn btn-sm ghost"
                                onClick={() => setConfirmUnloadModel(null)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm danger"
                                onClick={() => {
                                  actions.unloadModel(rt.name);
                                  setConfirmUnloadModel(null);
                                }}
                              >
                                Unload
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => setConfirmUnloadModel(rt.name)}
                              aria-label={`Unload ${rt.name} from memory`}
                            >
                              Unload
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Hardware Compatibility & Benchmarks for Installed Local Models */}
              {localModels.length > 0 && (
                <div className="hw-models-section">
                  <div className="hw-section-title">Installed Model Compatibility &amp; Speed</div>
                  {localModels.slice(0, 6).map((m) => {
                    const bench = state.benchResults.find((b) => b.model === m.name);
                    const evalItem = state.recommendations?.evaluatedInstalled?.find(
                      (e) => e.name.toLowerCase() === m.name.toLowerCase()
                    );
                    const catalogItem = state.recommendations?.models.find(
                      (r) =>
                        r.installedName?.toLowerCase() === m.name.toLowerCase() ||
                        r.name.toLowerCase() === m.name.toLowerCase()
                    );
                    const fit = evalItem?.fit ?? catalogItem?.fit;
                    const quant = evalItem?.quantization ?? catalogItem?.quantization ?? m.quantization;
                    const validation = fit?.validation;
                    const estBytes = m.sizeBytes ?? (m.paramsB ? m.paramsB * 0.65 * 1024 ** 3 : 0);
                    const fitLabel = fit
                      ? fit.label
                      : vramTotal && estBytes > 0 && estBytes <= vramTotal * 0.85
                        ? "Fits in VRAM"
                        : ramTotal > 0 && estBytes > 0 && estBytes <= ramTotal * 0.65
                          ? "Requires CPU/RAM offload"
                          : estBytes > 0
                            ? "May run slowly (high memory footprint)"
                            : "Compatible";
                    return (
                      <div key={m.name} className="hw-model-card">
                        <div className="hw-model-row">
                          <span className="hw-model-name">
                            {m.name}
                            {quant ? ` (${quant.toUpperCase()})` : ""}
                          </span>
                          {validation && validation.status !== "unverified" ? (
                            <span
                              className={
                                validation.status === "slower" || validation.status === "more_offload"
                                  ? "hw-model-meta"
                                  : "hw-tag-ok"
                              }
                              title={validation.detail}
                            >
                              {validation.detail}
                            </span>
                          ) : bench ? (
                            <span className="hw-tag-ok" title="Measured via Photon Bench on this machine">
                              Measured: {Math.round(bench.tokensPerSec)} tok/s
                            </span>
                          ) : (
                            <span className="hw-model-meta">Est. fit</span>
                          )}
                        </div>
                        <div className="hw-model-meta">
                          <span>{fitLabel}</span>
                          {m.sizeBytes ? <span>· {fmtGb(m.sizeBytes)}</span> : null}
                          {fit?.maxSafeContextTokens ? (
                            <span>· {Math.round(fit.maxSafeContextTokens / 1024)}k safe ctx</span>
                          ) : m.contextLength ? (
                            <span>· {Math.round(m.contextLength / 1024)}k max ctx</span>
                          ) : null}
                          {fit?.pressure && fit.pressure !== "low" ? (
                            <span>· {fit.pressure} pressure</span>
                          ) : null}
                          {fit?.runtime && fit.runtime !== "ollama" ? (
                            <span>· {fit.runtime}</span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="cloud-stat-grid">
                <div className="cloud-stat-item">
                  <span className="cloud-stat-k">Session Tokens (Measured)</span>
                  <span className="cloud-stat-v">
                    {(
                      (cu?.sessionInputTokens ?? 0) + (cu?.sessionOutputTokens ?? 0)
                    ).toLocaleString()}
                  </span>
                </div>
                <div className="cloud-stat-item">
                  <span className="cloud-stat-k">Est. Session Cost</span>
                  <span className="cloud-stat-v">{fmtUsd(cu?.sessionEstimatedCostUsd)}</span>
                </div>
                <div className="cloud-stat-item">
                  <span className="cloud-stat-k">Est. Tokens Saved</span>
                  <span className="cloud-stat-v hw-tag-ok">
                    +{(cu?.totalSavedTokens ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="cloud-stat-item">
                  <span className="cloud-stat-k">Est. Total Cost</span>
                  <span className="cloud-stat-v">{fmtUsd(cu?.totalEstimatedCostUsd)}</span>
                </div>
              </div>

              <div className="hw-models-section">
                <div className="hw-metric-head">
                  <span className="hw-section-title">Usage by Cloud Model</span>
                  {(cu?.byModel.length ?? 0) > 0 && (
                    confirmResetCloud ? (
                      <div className="hw-confirm-inline">
                        <button
                          type="button"
                          className="btn btn-sm ghost"
                          onClick={() => setConfirmResetCloud(false)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm danger"
                          onClick={() => {
                            actions.resetCloudUsage();
                            setConfirmResetCloud(false);
                          }}
                        >
                          Reset
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm ghost"
                        onClick={() => setConfirmResetCloud(true)}
                      >
                        Reset
                      </button>
                    )
                  )}
                </div>

                {!cu || cu.byModel.length === 0 ? (
                  <div className="hw-empty-note">No cloud token usage recorded yet.</div>
                ) : (
                  cu.byModel.map((m) => (
                    <div key={m.model} className="hw-model-card">
                      <div className="hw-model-row">
                        <span className="hw-model-name">{m.model}</span>
                        <span className="hw-metric-val" title="Estimated from published per-million-token pricing">
                          ~{fmtUsd(m.estimatedCostUsd)}
                        </span>
                      </div>
                      <div className="hw-model-meta">
                        <span>{m.turns} turns</span>
                        <span>· {m.inputTokens.toLocaleString()} in</span>
                        <span>· {m.outputTokens.toLocaleString()} out</span>
                        {m.savedTokens > 0 && (
                          <span className="hw-tag-ok">
                            · ~{m.savedTokens.toLocaleString()} saved
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
