import { useState } from "react";
import type { AppState, Actions } from "../state/store";
import {
  CpuIcon,
  RefreshIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  StopSquareIcon,
  BoltIcon,
} from "./Icons";

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

  const ollama = state.localRuntimes.find((r) => r.id === "ollama");
  const lifecycle = state.providerLifecycle["ollama"];
  const isStarting = lifecycle?.phase === "starting";
  const isStopping = lifecycle?.phase === "stopping";
  const isRunning = state.ollamaReachable || ollama?.state === "running";
  const isConflict = ollama?.state === "port_conflict";
  const isNotInstalled = ollama?.state === "not_installed";
  const isStopped =
    !isRunning && (ollama?.state === "installed_stopped" || (!isNotInstalled && !isConflict));

  const loadedModel = state.ollamaRuntime?.[0];
  const formatGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

  return (
    <div className={`local-provider-hub ${isRunning ? "running" : "needs-attention"}`}>
      <div className="hub-header">
        <div className="hub-header-left">
          <span className="hub-icon">
            <CpuIcon />
          </span>
          <div className="hub-titles">
            <div className="hub-main-title">
              <span>Ollama</span>
              <span
                className={`hub-badge ${
                  isRunning ? "ok" : isStarting ? "warn" : isConflict ? "error" : "faint"
                }`}
              >
                {isRunning ? (
                  <>
                    <span className="dot-pulse green" />
                    <span>Running {ollama?.version ? `v${ollama.version}` : ""}</span>
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
                  : state.config.ollamaBaseUrl
                : isConflict
                  ? "Port 11434 is in use"
                  : isStarting
                    ? "Starting background service…"
                    : isNotInstalled
                      ? "Not found on PATH"
                      : "Service stopped"}
            </div>
          </div>
        </div>

        <div className="hub-header-actions">
          {!isRunning && !isStarting && isStopped && (
            <button
              type="button"
              className="btn primary btn-sm"
              onClick={() => actions.startProvider("ollama")}
              title="Start Ollama service"
            >
              <BoltIcon />
              <span>Start</span>
            </button>
          )}

          {isConflict && (
            <button
              type="button"
              className="btn danger btn-sm"
              onClick={() => actions.restartProvider("ollama")}
              title="Free port 11434 and start Ollama"
            >
              <RefreshIcon />
              <span>Free Port</span>
            </button>
          )}

          {isNotInstalled && ollama?.installOptions && ollama.installOptions.length > 0 && (
            <div className="hub-install-btns">
              {ollama.installOptions.slice(0, 2).map((opt, i) => (
                <button
                  key={opt.label}
                  type="button"
                  className={`btn btn-sm ${i === 0 ? "primary" : "ghost"}`}
                  onClick={() => actions.installProvider("ollama", i)}
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
              onClick={() => actions.stopProvider("ollama")}
              title="Stop Ollama"
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
