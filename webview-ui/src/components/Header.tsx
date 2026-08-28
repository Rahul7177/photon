import { useState } from "react";
import type { BenchResult, Mode } from "../../../src/shared/types";
import type { AppState, Actions } from "../state/store";
import { ClockIcon, GearIcon } from "./Icons";
import { SessionHistory } from "./SessionHistory";
import { TransparencyPanel } from "./TransparencyPanel";

const MODES: { id: Mode; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "plan", label: "Plan" },
  { id: "agent", label: "Agent" },
];

// Sentinel value for the "Auto" model-picker option.
const AUTO = "__auto__";

function benchTps(results: BenchResult[], model: string): number | undefined {
  const r = results.find((b) => b.model === model);
  return r ? Math.round(r.tokensPerSec) : undefined;
}

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

  return (
    <header className="header">
      <div className="header-top">
        <nav className="tabs" role="tablist">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={state.mode === m.id ? "active" : ""}
              onClick={() => actions.setMode(m.id)}
              title={modeHint(m.id)}
            >
              {m.label}
            </button>
          ))}
        </nav>
        <div className="photon-logo" title="Photon">
          <span className="photon-logo-mark" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" fill="currentColor" />
              <ellipse cx="12" cy="12" rx="10" ry="4.5" stroke="currentColor" strokeWidth="1.4" transform="rotate(30 12 12)" />
              <ellipse cx="12" cy="12" rx="10" ry="4.5" stroke="currentColor" strokeWidth="1.4" transform="rotate(-30 12 12)" />
            </svg>
          </span>
          <span className="photon-logo-text">Photon</span>
        </div>
      </div>
      <div className="header-bottom">
        <div className="header-bottom-left">
          <div className="iface-toggle" title="Local: Ollama/llama.cpp with adaptive tuning. Cloud: direct provider APIs.">
            <button
              className={state.config.interfaceMode === "local" ? "active" : ""}
              onClick={() => actions.setInterfaceMode("local")}
            >
              Local
            </button>
            <button
              className={state.config.interfaceMode === "cloud" ? "active cloud" : "cloud"}
              onClick={() => actions.setInterfaceMode("cloud")}
            >
              ☁ Cloud
            </button>
          </div>
          <div className="model-picker">
            <select
              value={state.config.autoSelectModel ? AUTO : state.selectedModel}
              onChange={(e) => {
                if (e.target.value === AUTO) actions.setAutoSelect(true);
                else actions.setModel(e.target.value);
              }}
              disabled={state.models.length === 0}
              title={
                state.config.autoSelectModel
                  ? `Auto — Photon picks the model per request${state.selectedModel ? ` (last: ${state.selectedModel})` : ""}`
                  : state.selectedModel
              }
            >
              {!state.ready && <option value="">Loading models…</option>}
              {state.ready && state.models.length === 0 && <option value="">No models — check Local / Cloud</option>}
              {state.ready && state.models.length > 0 && <option value={AUTO}>🤖 Auto</option>}
              {state.models.map((m) => {
                const tps = benchTps(state.benchResults, m.name);
                // Strip provider prefix (llamacpp:, ollama:, openai: …) but keep the rest — avoids "Q4_0" alone
                const display = m.name.includes(":") ? m.name.split(":").slice(1).join(":") : m.name;
                return (
                  <option key={m.name} value={m.name} title={m.name}>
                    {display}
                    {m.tier ? ` · ${m.tier}` : ""}
                    {tps ? ` · ${tps} tok/s` : ""}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
        <div className="header-bottom-right">
          <button
            className={`icon-btn ${state.config.autoSelectModel ? "active" : ""}`}
            title="Why this model? (Auto Mode)"
            onClick={() => setAutoOpen((o) => !o)}
          >
            ◎
          </button>
          <button className="icon-btn" title="Chat history" onClick={() => setHistoryOpen((o) => !o)}>
            <ClockIcon />
          </button>
          <button className="icon-btn" title="Refresh models" onClick={actions.refreshModels}>
            ↻
          </button>
          <button className="icon-btn" title="New chat" onClick={actions.newSession}>
            +
          </button>
          <button className="icon-btn" title="Settings" onClick={onOpenSettings}>
            <GearIcon />
          </button>
        </div>
        {autoOpen && <TransparencyPanel state={state} actions={actions} onClose={() => setAutoOpen(false)} />}
        {historyOpen && <SessionHistory sessions={state.sessions} activeId={state.activeSessionId} actions={actions} onClose={() => setHistoryOpen(false)} />}
      </div>
    </header>
  );
}

function modeHint(mode: Mode): string {
  switch (mode) {
    case "chat":
      return "Chat: talk & get code, no tools.";
    case "plan":
      return "Plan: read-only investigation, produces a step-by-step plan.";
    case "agent":
      return "Agent: uses tools to edit files and run commands.";
  }
}
