import { useState, useMemo, useEffect } from "react";
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

  useEffect(() => {
    if (!historyOpen && !autoOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHistoryOpen(false);
        setAutoOpen(false);
      }
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [historyOpen, autoOpen]);

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
          <span className="header-logo" aria-hidden="true" title="Photon">
            <PhotonLogoIcon size={16} />
          </span>
          <span className={`session-title ${!sessionTitle ? "brand-wordmark" : ""}`}>
            {sessionTitle || "Photon"}
          </span>
        </div>

        <div className="header-actions">
          {state.pullProgress && state.pullProgress.phase === "pulling" && (
            <div className="header-pull-pill" title={state.pullProgress.status} role="status" aria-live="polite">
              <span className="pull-spinner" aria-hidden="true" />
              <span className="header-pull-text">
                {state.pullProgress.model} ({state.pullProgress.percent !== undefined ? `${state.pullProgress.percent}%` : "pulling"})
              </span>
              <button
                type="button"
                className="header-pull-cancel"
                onClick={actions.cancelPull}
                title="Cancel download"
                aria-label={`Cancel ${state.pullProgress.model} download`}
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
            aria-label={`Project Context and Memory (${indexedCount} files indexed)`}
          >
            <BrainIcon />
            {hasHandoffReady && <span className="ctx-handoff-dot" aria-hidden="true" />}
          </button>
          {state.config.autoSelectModel && (
            <button
              type="button"
              className={`icon-btn ${autoOpen ? "active" : ""}`}
              title="Auto-routing active — inspect model selection"
              aria-label="Inspect auto-routing model selection"
              aria-expanded={autoOpen}
              onClick={() => setAutoOpen((o) => !o)}
            >
              <LightbulbIcon />
            </button>
          )}
          <button
            type="button"
            className={`icon-btn ${historyOpen ? "active" : ""}`}
            title="Session history"
            aria-label="Session history"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((o) => !o)}
          >
            <ClockIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="New session"
            aria-label="Start new session"
            onClick={actions.newSession}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Settings & Providers"
            aria-label="Settings and Providers"
            onClick={onOpenSettings}
          >
            <GearIcon />
          </button>
          {autoOpen && <TransparencyPanel state={state} actions={actions} onClose={() => setAutoOpen(false)} />}
          {historyOpen && <SessionHistory sessions={state.sessions} activeId={state.activeSessionId} actions={actions} onClose={() => setHistoryOpen(false)} />}
        </div>
      </div>
    </header>
  );
}
