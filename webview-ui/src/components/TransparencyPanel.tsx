import { useEffect, useRef } from "react";
import type { AppState, Actions } from "../state/store";

/**
 * "Why did Auto Mode choose this?" (M12). A power user won't trust a black-box
 * router — this shows the chosen model, the complexity signals behind it, the
 * full ranked candidate list, and a one-click pin to override per project.
 */
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
    // Delay adding the listener so the mousedown that *opened* this panel
    // doesn't immediately trigger the outside-click close.
    const timer = setTimeout(() => {
      const onDoc = (e: MouseEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) onClose();
      };
      document.addEventListener("mousedown", onDoc);
      cleanupRef.current = () => document.removeEventListener("mousedown", onDoc);
    }, 0);
    const cleanupRef = { current: () => clearTimeout(timer) };
    return () => { clearTimeout(timer); cleanupRef.current(); };
  }, [onClose]);

  const d = state.decision;

  return (
    <div className="dropdown transparency" ref={ref}>
      <div className="dropdown-head">
        <span>Auto Mode</span>
        <label className="switch-inline" title="Let Photon pick the best model for each request">
          <input
            type="checkbox"
            checked={state.config.autoSelectModel}
            onChange={(e) => actions.setAutoSelect(e.target.checked)}
          />
          <span>Auto-select model</span>
        </label>
      </div>

      {!d ? (
        <div className="dropdown-empty">
          No decision yet — send a message and Photon will explain its model choice here.
        </div>
      ) : (
        <div className="transparency-body">
          <div className="transparency-chosen">
            <strong>{d.chosenModel || "—"}</strong>
            <span className={`badge ${d.pinned ? "badge-pin" : "badge-auto"}`}>
              {d.pinned ? "pinned" : "auto"}
            </span>
          </div>
          <div className="transparency-reason">{d.reason}</div>

          <div className="transparency-signals">
            <span className={`chip chip-${d.complexity.level}`}>{d.complexity.level}</span>
            <span className="chip">{d.complexity.signals.filesReferenced} files</span>
            <span className="chip">~{d.complexity.signals.estimatedSteps} steps</span>
            <span className="chip">needs {d.complexity.minContextTokens.toLocaleString()} ctx</span>
          </div>
          {d.complexity.signals.keywords.length > 0 && (
            <div className="transparency-kw">
              keywords: {d.complexity.signals.keywords.slice(0, 6).join(", ")}
            </div>
          )}

          <div className="transparency-rank">
            {d.scores.slice(0, 6).map((s) => (
              <div key={s.model} className={`rank-row ${s.model === d.chosenModel ? "chosen" : ""}`}>
                <span className="rank-name" title={s.reasons.join(" · ")}>
                  {s.model}
                  {!s.fits && <span className="rank-warn"> ⚠ ctx</span>}
                </span>
                <span className="rank-score">{s.score.toFixed(0)}</span>
                {s.model !== d.chosenModel && (
                  <button className="rank-pin" title="Pin this model for this project" onClick={() => actions.pinModel(s.model)}>
                    pin
                  </button>
                )}
              </div>
            ))}
          </div>

          {d.chosenModel && (
            <button className="btn" onClick={() => actions.pinModel(d.chosenModel)}>
              Pin {d.chosenModel} for this project
            </button>
          )}
        </div>
      )}
    </div>
  );
}
