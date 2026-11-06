import { useState, useMemo } from "react";
import type { AppState, Actions } from "../state/store";
import { ClockIcon, GearIcon, LightbulbIcon, PlusIcon, BrainIcon, PhotonLogoIcon, CloseIcon } from "./Icons";
import { SessionHistory } from "./SessionHistory";
import { TransparencyPanel } from "./TransparencyPanel";

export function Header({
  state,
  actions,
  onOpenSettings,
  onOpenContextModal,
}: {
  state: AppState;
  actions: Actions;
  onOpenSettings: () => void;
  onOpenContextModal: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);

  const sessionTitle = useMemo(() => {
    if (!state.activeSessionId) return "";
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    return s?.title ?? "";
  }, [state.activeSessionId, state.sessions]);

  const hasHandoffReady = Boolean(
    state.projectContext?.latestHandoff &&
    state.selectedModel &&
    state.projectContext.latestHandoff.fromModel !== state.selectedModel
  );

  const indexedCount = state.projectContext?.totalFiles ?? 0;

  return (
    <header className="header">
      <div className="header-row">
        <div className="header-brand-group">
          <span className="header-logo" aria-hidden title="Photon">
            <PhotonLogoIcon size={16} />
          </span>
          <span className={`session-title ${!sessionTitle ? "brand-wordmark" : ""}`}>
            {sessionTitle || "Photon"}
          </span>
        </div>

        <div className="header-actions">
          {state.pullProgress && state.pullProgress.phase === "pulling" && (
            <div className="header-pull-pill" title={state.pullProgress.status}>
              <span className="pull-spinner" />
              <span className="header-pull-text">
                {state.pullProgress.model} ({state.pullProgress.percent !== undefined ? `${state.pullProgress.percent}%` : "pulling"})
              </span>
              <button
                type="button"
                className="header-pull-cancel"
                onClick={actions.cancelPull}
                title="Cancel download"
              >
                <CloseIcon />
              </button>
            </div>
          )}
          <button
            type="button"
            className={`icon-btn ctx-header-btn ${indexedCount > 0 ? "indexed" : ""} ${hasHandoffReady ? "handoff-ready" : ""}`}
            style={{ position: "relative" }}
            title={
              hasHandoffReady
                ? `Cross-Model Handoff Ready (${state.projectContext?.latestHandoff?.fromModel} → ${state.selectedModel})`
                : `Project Context & Memory (${indexedCount} files indexed)`
            }
            onClick={() => {
              actions.requestProjectContext();
              onOpenContextModal();
            }}
            aria-label="Project Context & Memory"
          >
            <BrainIcon />
            {hasHandoffReady && <span className="ctx-handoff-dot" />}
          </button>
          {state.config.autoSelectModel && (
            <button
              className="icon-btn active"
              title="Auto-routing active — inspect model selection"
              onClick={() => setAutoOpen((o) => !o)}
            >
              <LightbulbIcon />
            </button>
          )}
          <button
            className={`icon-btn ${historyOpen ? "active" : ""}`}
            title="Session history"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            <ClockIcon />
          </button>
          <button className="icon-btn" title="New session" onClick={actions.newSession}>
            <PlusIcon />
          </button>
          <button className="icon-btn" title="Settings & Providers" onClick={onOpenSettings}>
            <GearIcon />
          </button>
          {autoOpen && <TransparencyPanel state={state} actions={actions} onClose={() => setAutoOpen(false)} />}
          {historyOpen && <SessionHistory sessions={state.sessions} activeId={state.activeSessionId} actions={actions} onClose={() => setHistoryOpen(false)} />}
        </div>
      </div>
    </header>
  );
}
