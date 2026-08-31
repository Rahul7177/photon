import { useState, useMemo } from "react";
import type { AppState, Actions } from "../state/store";
import { ClockIcon, GearIcon, LightbulbIcon, RefreshIcon, PlusIcon } from "./Icons";
import { SessionHistory } from "./SessionHistory";
import { TransparencyPanel } from "./TransparencyPanel";

export function Header({
  state,
  actions,
  onOpenSettings,
}: {
  state: AppState;
  actions: Actions;
  onOpenSettings: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);

  const sessionTitle = useMemo(() => {
    if (!state.activeSessionId) return "";
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    return s?.title ?? "";
  }, [state.activeSessionId, state.sessions]);

  return (
    <header className="header">
      <div className="header-row">
        <span className="session-title">{sessionTitle || "New Chat"}</span>
        <div className="header-actions">
          <button
            className={`icon-btn ${state.config.autoSelectModel ? "active" : ""}`}
            title="Why this model? (Auto Mode)"
            onClick={() => setAutoOpen((o) => !o)}
          >
            <LightbulbIcon />
          </button>
          <button className="icon-btn" title="Chat history" onClick={() => setHistoryOpen((o) => !o)}>
            <ClockIcon />
          </button>
          <button className="icon-btn" title="Refresh models" onClick={actions.refreshModels}>
            <RefreshIcon />
          </button>
          <button className="icon-btn" title="New chat" onClick={actions.newSession}>
            <PlusIcon />
          </button>
          <button className="icon-btn" title="Settings" onClick={onOpenSettings}>
            <GearIcon />
          </button>
          {autoOpen && <TransparencyPanel state={state} actions={actions} onClose={() => setAutoOpen(false)} />}
          {historyOpen && <SessionHistory sessions={state.sessions} activeId={state.activeSessionId} actions={actions} onClose={() => setHistoryOpen(false)} />}
        </div>
      </div>
    </header>
  );
}
