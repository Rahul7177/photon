import type { AppState, Actions } from "../state/store";
import { CheckCircleIcon, AlertTriangleIcon, CloseIcon, RefreshIcon } from "./Icons";

export function PullProgressBar({
  state,
  actions,
  compact = false,
}: {
  state: AppState;
  actions?: Actions;
  compact?: boolean;
}) {
  const p = state.pullProgress;
  if (!p) return null;

  const isPulling = p.phase === "pulling";
  const isDone = p.phase === "done";
  const isError = p.phase === "error";

  const pct = p.percent !== undefined ? Math.min(100, Math.max(0, p.percent)) : undefined;

  return (
    <div className={`pull-progress-bar-container ${compact ? "compact" : ""} ${p.phase}`}>
      <div className="pull-progress-info">
        <div className="pull-progress-left">
          {isPulling && <span className="pull-spinner" />}
          {isDone && (
            <span className="pull-icon-ok">
              <CheckCircleIcon />
            </span>
          )}
          {isError && (
            <span className="pull-icon-err">
              <AlertTriangleIcon />
            </span>
          )}
          <span className="pull-model-name">{p.model}</span>
          <span className="pull-status-sep">·</span>
          <span className="pull-status-text">{p.status}</span>
        </div>

        <div className="pull-progress-actions">
          {isPulling && actions && (
            <button
              type="button"
              className="pull-btn-cancel"
              onClick={actions.cancelPull}
              title="Cancel download"
            >
              Cancel
            </button>
          )}

          {isError && p.resumable && actions && (
            <button
              type="button"
              className="pull-btn-resume"
              onClick={() => actions.pullModel(p.model)}
              title="Resume download from cached layers"
            >
              <RefreshIcon />
              <span>Resume</span>
            </button>
          )}

          {(isError || isDone) && actions && (
            <button
              type="button"
              className="pull-btn-close"
              onClick={() => {
                // Post null pullProgress or clear it
              }}
              title="Dismiss"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </div>

      {isPulling && (
        <div className="pull-track">
          <div
            className={`pull-fill ${pct === undefined ? "indeterminate" : ""}`}
            style={{ width: pct !== undefined ? `${pct}%` : "30%" }}
          />
        </div>
      )}
    </div>
  );
}

