import { formatK } from "../contextPresets";
import { AlertTriangleIcon, CloseIcon } from "./Icons";

export function ContextWarningModal({
  title,
  explanation,
  recommendedTokens,
  onUseRecommended,
  onKeepSelected,
}: {
  title: string;
  explanation: string;
  recommendedTokens: number;
  onUseRecommended: () => void;
  onKeepSelected: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={onKeepSelected}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ctx-warn-title"
    >
      <div className="hw-modal ctx-warn-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hw-modal-header">
          <div className="hw-modal-title-wrap">
            <span className="hw-modal-icon">
              <AlertTriangleIcon />
            </span>
            <span id="ctx-warn-title" className="hw-modal-title">
              {title}
            </span>
          </div>
          <button className="icon-btn" onClick={onKeepSelected} title="Close">
            <CloseIcon />
          </button>
        </div>
        <p className="ctx-warn-body">{explanation}</p>
        <div className="ctx-warn-actions">
          <button
            className="btn ghost btn-sm"
            onClick={onKeepSelected}
            title="Keep selected context window"
          >
            Keep Selection
          </button>
          <button
            className="btn primary btn-sm"
            onClick={onUseRecommended}
            title={`Switch to recommended ${formatK(recommendedTokens)} context`}
          >
            Use Recommended ({formatK(recommendedTokens)})
          </button>
        </div>
      </div>
    </div>
  );
}
