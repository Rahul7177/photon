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
    </div>
  );
}
