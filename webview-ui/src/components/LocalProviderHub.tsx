import { useState } from "react";
import type { AppState, Actions } from "../state/store";
import {
  RefreshIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  StopSquareIcon,
  BoltIcon,
} from "./Icons";
import { ProviderLogo } from "./ProviderLogos";

export function LocalProviderHub({
  state,
  actions,
  collapsible = false,
}: {
  state: AppState;
  actions: Actions;
  collapsible?: boolean;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const [selectedRuntime, setSelectedRuntime] = useState<"ollama" | "llamacpp">("ollama");

  const llamacppInfo = state.localRuntimes.find((r) => r.id === "llamacpp");
  const hasLlamaCpp = Boolean(llamacppInfo && llamacppInfo.state !== "not_installed");
  const activeId: "ollama" | "llamacpp" =
    hasLlamaCpp && selectedRuntime === "llamacpp" ? "llamacpp" : "ollama";
  const runtimeInfo = state.localRuntimes.find((r) => r.id === activeId);
  const lifecycle = state.providerLifecycle[activeId];
  const runtimeLabel = activeId === "llamacpp" ? "llama.cpp" : "Ollama";
  const runtimePort = runtimeInfo?.port ?? (activeId === "llamacpp" ? 8080 : 11434);
  const runtimeBaseUrl =
    runtimeInfo?.baseUrl ??
    (activeId === "llamacpp" ? "http://127.0.0.1:8080" : state.config.ollamaBaseUrl);

  const isStarting = lifecycle?.phase === "starting";
  const isStopping = lifecycle?.phase === "stopping";
  const isRunning =
    activeId === "ollama"
      ? state.ollamaReachable || runtimeInfo?.state === "running"
      : runtimeInfo?.state === "running";
  const isConflict = runtimeInfo?.state === "port_conflict";
  const isNotInstalled = runtimeInfo?.state === "not_installed";
  const hasError = !isRunning && lifecycle?.phase === "error";
  const isStopped =
    !isRunning && (runtimeInfo?.state === "installed_stopped" || (!isNotInstalled && !isConflict));

  const loadedModel = activeId === "ollama" ? state.ollamaRuntime?.[0] : undefined;
  const formatGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

  return (
    <div className={`local-provider-hub ${isRunning ? "running" : "needs-attention"}`}>
      <div className="hub-header">
        <div className="hub-header-left">
          <span className="hub-icon" title={runtimeLabel}>
            <ProviderLogo providerId={activeId} label={runtimeLabel} baseUrl={runtimeBaseUrl} size={18} />
          </span>
          <div className="hub-titles">
            <div className="hub-main-title">
              <span>{runtimeLabel}</span>
              {hasLlamaCpp && (
                <div className="hub-runtime-tabs" role="tablist" aria-label="Local runtimes">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeId === "ollama"}
                    className={`btn btn-xs ${activeId === "ollama" ? "primary" : "ghost"}`}
                    onClick={() => setSelectedRuntime("ollama")}
                  >
                    <ProviderLogo providerId="ollama" label="Ollama" size={12} />
                    <span>Ollama</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeId === "llamacpp"}
                    className={`btn btn-xs ${activeId === "llamacpp" ? "primary" : "ghost"}`}
                    onClick={() => setSelectedRuntime("llamacpp")}
                  >
                    <ProviderLogo providerId="llamacpp" label="llama.cpp" size={12} />
                    <span>llama.cpp</span>
                  </button>
                </div>
              )}
              <span
                className={`hub-badge ${
                  isRunning ? "ok" : isStarting ? "warn" : isConflict || hasError ? "error" : "faint"
                }`}
              >
                {isRunning ? (
                  <>
                    <span className="dot-pulse green" />
                    <span>Running {runtimeInfo?.version ? `v${runtimeInfo.version}` : ""}</span>
                  </>
                ) : isStarting ? (
                  <>
                    <span className="hub-spinner" />
                    <span>Starting…</span>
                  </>
                ) : isStopping ? (
                  <span>Stopping…</span>
                ) : isConflict ? (
                  <>
                    <AlertTriangleIcon />
                    <span>Port Conflict</span>
                  </>
                ) : hasError ? (
                  <>
                    <AlertTriangleIcon />
                    <span>Failed to Start</span>
                  </>
                ) : isNotInstalled ? (
                  <span>Not Installed</span>
                ) : (
                  <>
                    <span className="dot-pulse amber" />
                    <span>Stopped</span>
                  </>
                )}
              </span>
            </div>
            <div className="hub-sub-title">
              {isRunning
                ? loadedModel
                  ? `${loadedModel.name} (${formatGb(loadedModel.vramBytes || loadedModel.sizeBytes)})`
                  : runtimeBaseUrl
                : isConflict
                  ? `Port ${runtimePort} is in use`
                  : isStarting
                    ? "Starting background service…"
                    : hasError
                      ? (lifecycle?.message || "Failed to start service")
                      : isNotInstalled
                        ? "Not found on PATH"
                        : "Service stopped"}
            </div>
          </div>
        </div>

        <div className="hub-header-actions">
          {!isRunning && !isStarting && (isStopped || hasError) && (
            <button
              type="button"
              className="btn primary btn-sm"
              onClick={() => actions.startProvider(activeId)}
              title={`Start ${runtimeLabel} service`}
            >
              <BoltIcon />
              <span>Start</span>
            </button>
          )}

          {isConflict && (
            <button
              type="button"
              className="btn danger btn-sm"
              onClick={() => actions.restartProvider(activeId)}
              title={`Free port ${runtimePort} and start ${runtimeLabel}`}
            >
              <RefreshIcon />
              <span>Free Port</span>
            </button>
          )}

          {isNotInstalled && runtimeInfo?.installOptions && runtimeInfo.installOptions.length > 0 && (
            <div className="hub-install-btns">
              {runtimeInfo.installOptions.slice(0, 2).map((opt, i) => (
                <button
                  key={opt.label}
                  type="button"
                  className={`btn btn-sm ${i === 0 ? "primary" : "ghost"}`}
                  onClick={() => actions.installProvider(activeId, i)}
                  title={opt.value}
                >
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          )}

          {isRunning && loadedModel && (
            <button
              type="button"
              className="btn ghost btn-sm"
              onClick={() => actions.unloadModel(loadedModel.name)}
              title="Unload model from VRAM"
            >
              <span>Unload</span>
            </button>
          )}

          {isRunning && lifecycle?.managed && (
            <button
              type="button"
              className="btn danger btn-sm"
              onClick={() => actions.stopProvider(activeId)}
              title={`Stop ${runtimeLabel}`}
            >
              <StopSquareIcon />
              <span>Stop</span>
            </button>
          )}

          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              actions.detectProviders();
              actions.refreshModels();
            }}
            title="Refresh status"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {!collapsible && ((lifecycle?.logs && lifecycle.logs.length > 0) || lifecycle?.phase === "error") && (
        <div className="hub-details">
          {lifecycle?.logs && lifecycle.logs.length > 0 && (
            <div className="hub-logs-section">
              <button
                type="button"
                className="hub-logs-toggle"
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? <ChevronDownIcon /> : <ChevronRightIcon />}
                <span>Logs ({lifecycle.logs.length})</span>
              </button>
              {(showLogs || lifecycle.phase === "error") && (
                <div className="hub-log-output">
                  {lifecycle.logs.slice(-8).map((line, idx) => (
                    <div key={idx} className="hub-log-line">
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {lifecycle?.phase === "error" && lifecycle.message && (
            <div className="hub-error-msg">
              <AlertTriangleIcon />
              <span>{lifecycle.message}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
