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
            <span className="hw-modal-icon">
              <ChartIcon />
            </span>
            <span id="hw-modal-title" className="hw-modal-title">
              Telemetry
            </span>
          </div>

          <div className="ctx-modal-head-actions">
            <div className="iface-toggle">
              <button
                type="button"
                className={viewTab === "local" ? "active" : ""}
                onClick={() => setViewTab("local")}
              >
                Local
              </button>
              <button
                type="button"
                className={viewTab === "cloud" ? "active" : ""}
                onClick={() => setViewTab("cloud")}
              >
                Cloud
              </button>
            </div>
            <button className="icon-btn" onClick={onClose} title="Close">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="hw-modal-body">
          {viewTab === "local" ? (
            <>
              {/* Compact Hardware Bars */}
              <div className="hw-metric-card">
                <div className="hw-metric-head">
                  <span className="hw-metric-label">{gpuName}</span>
                  <span className="hw-metric-val">
                    {gpuUtil !== undefined ? `${gpuUtil}%` : "N/A"}
                    {hw?.gpuTempC !== undefined ? ` · ${hw.gpuTempC}°C` : ""}
                  </span>
                </div>
                <div className="hw-metric-bar">
                  <div
                    className="hw-metric-fill gpu-compute"
                    style={{ width: `${gpuUtil ?? 0}%` }}
                  />
                </div>
              </div>

              <div className="hw-metric-card">
                <div className="hw-metric-head">
                  <span className="hw-metric-label">VRAM</span>
                  <span className="hw-metric-val">
                    {vramUsed !== undefined && vramTotal !== undefined
                      ? `${fmtGb(vramUsed)} / ${fmtGb(vramTotal)} (${vramPercent}%)`
                      : vramTotal !== undefined
                        ? `${fmtGb(vramTotal)}`
                        : "N/A"}
                  </span>
                </div>
                <div className="hw-metric-bar">
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
                <div className="hw-metric-bar">
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
                <div className="hw-section-title">Loaded in Memory</div>
                {state.ollamaRuntime.length === 0 ? (
                  <div className="hw-empty-note">No model currently loaded in memory.</div>
                ) : (
                  state.ollamaRuntime.map((rt) => {
                    const isConfirming = confirmUnloadModel === rt.name;
                    return (
                      <div key={rt.name} className="hw-model-card">
                        <div className="hw-model-row">
                          <div>
                            <div className="hw-model-name">{rt.name}</div>
                            <div className="hw-model-meta">
                              <span className={rt.gpuPercent >= 95 ? "hw-tag-ok" : "hw-tag-warn"}>
                                {rt.gpuPercent}% GPU
                              </span>
                              <span>· {fmtGb(rt.sizeBytes)}</span>
                              {rt.contextLength > 0 && (
                                <span>· {Math.round(rt.contextLength / 1024)}k ctx</span>
                              )}
                            </div>
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
            </>
          ) : (
            <>
              <div className="cloud-stat-grid">
                <div className="cloud-stat-item">
                  <span className="cloud-stat-k">Session Tokens</span>
                  <span className="cloud-stat-v">
                    {(
                      (cu?.sessionInputTokens ?? 0) + (cu?.sessionOutputTokens ?? 0)
                    ).toLocaleString()}
                  </span>
                </div>
                <div className="cloud-stat-item">
                  <span className="cloud-stat-k">Session Cost</span>
                  <span className="cloud-stat-v">{fmtUsd(cu?.sessionEstimatedCostUsd)}</span>
                </div>
                <div className="cloud-stat-item">
                  <span className="cloud-stat-k">Tokens Saved</span>
                  <span className="cloud-stat-v hw-tag-ok">
                    +{(cu?.totalSavedTokens ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="cloud-stat-item">
                  <span className="cloud-stat-k">Total Cost</span>
                  <span className="cloud-stat-v">{fmtUsd(cu?.totalEstimatedCostUsd)}</span>
                </div>
              </div>

              <div className="hw-models-section">
                <div className="hw-metric-head">
                  <span className="hw-section-title">Usage by Model</span>
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
                        <span className="hw-metric-val">{fmtUsd(m.estimatedCostUsd)}</span>
                      </div>
                      <div className="hw-model-meta">
                        <span>{m.turns} turns</span>
                        <span>· {m.inputTokens.toLocaleString()} in</span>
                        <span>· {m.outputTokens.toLocaleString()} out</span>
                        {m.savedTokens > 0 && (
                          <span className="hw-tag-ok">
                            · {m.savedTokens.toLocaleString()} saved
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
