import { useEffect, useRef } from "react";
import type { AppState, Actions } from "../state/store";
import { AlertTriangleIcon } from "./Icons";
import { Toggle } from "./Toggle";

export function TransparencyPanel({
  state,
  actions,
  onClose,
}: {
  state: AppState;
  actions: Actions;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const onDoc = (e: MouseEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) onClose();
      };
      document.addEventListener("mousedown", onDoc);
      cleanupRef.current = () => document.removeEventListener("mousedown", onDoc);
    }, 0);
    const cleanupRef = { current: () => clearTimeout(timer) };
    return () => {
      clearTimeout(timer);
      cleanupRef.current();
    };
  }, [onClose]);

  const d = state.decision;
  const promptReport = state.usage?.promptReport;
  const telemetry = state.turnTelemetry;
  const issueEntries = telemetry
    ? Object.entries(telemetry.counts).filter(
        ([k, v]) => typeof v === "number" && v > 0 && k !== "tool_ok" && k !== "verify_ok"
      )
    : [];

  return (
    <div className="dropdown transparency" ref={ref}>
      <div className="dropdown-head">
        <span>Auto-Select Model</span>
        <Toggle checked={state.config.autoSelectModel} onChange={actions.setAutoSelect} />
      </div>

      {!d ? (
        <div className="dropdown-empty">
          Send a message to see automatic model selection.
        </div>
      ) : (
        <div className="transparency-body">
          <div className="transparency-chosen">
            <strong>{d.chosenModel || "—"}</strong>
            <span className={`badge ${d.pinned ? "badge-pin" : "badge-auto"}`}>
              {d.pinned ? "pinned" : d.complexity.level}
            </span>
          </div>
          <div className="transparency-reason">{d.reason}</div>

          <div className="transparency-rank">
            {d.scores.slice(0, 5).map((s) => (
              <div
                key={s.model}
                className={`rank-row ${s.model === d.chosenModel ? "chosen" : ""}`}
              >
                <span className="rank-name" title={s.reasons.join(" · ")}>
                  {s.model}
                  {!s.fits && (
                    <span className="rank-warn" title="Context overflow risk">
                      <AlertTriangleIcon />
                    </span>
                  )}
                </span>
                <span className="rank-score">{s.score.toFixed(0)}</span>
                {s.model !== d.chosenModel && (
                  <button
                    className="btn btn-sm ghost"
                    title="Pin this model"
                    onClick={() => actions.pinModel(s.model)}
                  >
                    Pin
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(promptReport || telemetry) && (
        <div className="transparency-telemetry">
          {promptReport && (
            <div className="transparency-telemetry-block">
              <div className="transparency-kw">
                Prompt: {promptReport.totalTokens.toLocaleString()}
                {promptReport.budgetTokens ? ` / ${promptReport.budgetTokens.toLocaleString()}` : ""} tok
                {promptReport.renderedToolCount !== undefined ? ` · ${promptReport.renderedToolCount} tools` : ""}
              </div>
              <div className="transparency-signals">
                {promptReport.sections
                  .filter((s) => s.tokens > 0 || s.status !== "kept")
                  .map((s) => (
                    <span key={s.id} className="chip" title={`${s.label}: ${s.tokens} tok (${s.status})`}>
                      {s.id}: {s.tokens}
                      {s.status !== "kept" ? ` (${s.status})` : ""}
                    </span>
                  ))}
              </div>
            </div>
          )}
          {telemetry && (
            <div className="transparency-telemetry-block">
              <div className="transparency-kw">
                Turn ({telemetry.protocol}
                {telemetry.protocolDowngraded ? " (downgraded)" : ""} · rung {telemetry.rung}
                {telemetry.peakRung !== undefined && telemetry.peakRung > telemetry.rung
                  ? ` (peak ${telemetry.peakRung})`
                  : ""}
                {telemetry.adaptive === false ? " · frozen" : ""}): {telemetry.steps} step{telemetry.steps === 1 ? "" : "s"}
                {issueEntries.length === 0 ? " · clean" : ""}
              </div>
              <div className="transparency-signals">
                {Object.entries(telemetry.counts)
                  .filter(([, v]) => typeof v === "number" && v > 0)
                  .map(([k, v]) => (
                    <span key={k} className="chip">
                      {k}: {v}
                    </span>
                  ))}
              </div>
              {telemetry.timeline && telemetry.timeline.length > 0 && (
                <div className="transparency-timeline">
                  {telemetry.timeline.map((entry, idx) => (
                    <div key={`${entry.step}-${entry.type}-${idx}`} className="timeline-row">
                      <span className="timeline-step">
                        #{entry.step}{" "}
                        {entry.type === "escalate" || entry.type === "deescalate"
                          ? `R${entry.fromRung}→R${entry.toRung}`
                          : entry.type}
                      </span>
                      <span className="timeline-reason">{entry.reason}</span>
                    </div>
                  ))}
                </div>
              )}
              {telemetry.autoReverted && telemetry.autoReverted.length > 0 && (
                <div className="transparency-hint">
                  Auto-reverted on diagnostics regression: {telemetry.autoReverted.join(", ")}
                </div>
              )}
            </div>
          )}
          <div className="transparency-freeze-row">
            <span>Freeze adaptivity</span>
            <Toggle
              checked={Boolean(state.config.adaptivityFrozen)}
              onChange={actions.setAdaptivityFrozen}
            />
          </div>
        </div>
      )}
    </div>
  );
}
