import { useState, useMemo } from "react";
import type { ThinkingSetting } from "../../../src/shared/types";
import type { AppState, Actions } from "../state/store";
import { ClockIcon, GearIcon, LightbulbIcon, RefreshIcon, PlusIcon } from "./Icons";
import { SessionHistory } from "./SessionHistory";
import { TransparencyPanel } from "./TransparencyPanel";

const THINKING_OPTIONS: Array<{ value: ThinkingSetting; short: string; label: string }> = [
  { value: "auto", short: "A", label: "Auto" },
  { value: "off", short: "0", label: "Off" },
  { value: "low", short: "L", label: "Low" },
  { value: "medium", short: "M", label: "Medium" },
  { value: "high", short: "H", label: "High" },
  { value: "xtrahigh", short: "XH", label: "Extra High" },
];

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
  const thinking = state.config.thinkingLevel;
  const thinkingLabel = THINKING_OPTIONS.find((x) => x.value === thinking)?.label ?? "Auto";

  return (
    <header className="header">
      <div className="header-row">
        <span className="session-title">{sessionTitle || "New Chat"}</span>
        <div className="header-actions">
          <div className="thinking-level-group" role="group" aria-label={`Reasoning level: ${thinkingLabel}`}>
            {THINKING_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`thinking-level-btn ${thinking === option.value ? "active" : ""}`}
                title={option.label}
                aria-label={`Reasoning ${option.label}`}
                aria-pressed={thinking === option.value}
                onClick={() => actions.setThinkingSetting(option.value)}
              >
                {option.short}
              </button>
            ))}
          </div>
          <span className="thinking-level-current" title={`Current reasoning level: ${thinkingLabel}`}>
            {thinkingLabel}
          </span>
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
