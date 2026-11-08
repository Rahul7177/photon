import { useEffect, useMemo } from "react";
import type { AppState, Actions } from "../state/store";
import type { CheckpointSummary } from "../../../src/shared/protocol";
import { RewindIcon, CloseIcon } from "./Icons";

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function RevertModal({
  state,
  actions,
  onClose,
}: {
  state: AppState;
  actions: Actions;
  onClose: () => void;
}) {
  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Aggregate checkpoints from store and fallback to message history
  const checkpointList: CheckpointSummary[] = useMemo(() => {
    if (state.checkpoints && state.checkpoints.length > 0) {
      return state.checkpoints;
    }
    // Fallback: deduce from messages in active session
    const deduced: CheckpointSummary[] = [];
    const seen = new Set<string>();
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.checkpointId && m.checkpointFiles && m.checkpointFiles.length > 0 && !seen.has(m.checkpointId)) {
        seen.add(m.checkpointId);
        // Find user prompt associated with this turn
        let label = m.content;
        for (let j = i; j >= 0; j--) {
          if (state.messages[j].role === "user") {
            label = state.messages[j].content;
            break;
          }
        }
        deduced.push({
          id: m.checkpointId,
          checkpointNumber: m.checkpointNumber ?? deduced.length + 1,
          timestamp: m.createdAt,
          label: label.length > 120 ? label.slice(0, 117) + "…" : label,
          filesCount: m.checkpointFiles.length,
          files: m.checkpointFiles,
          messageId: m.id,
        });
      }
    }
    return deduced;
  }, [state.checkpoints, state.messages]);

  return (
    <div className="modal-backdrop revert-modal-backdrop" onClick={onClose}>
      <div
        className="revert-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Revert to Checkpoint"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="revert-modal-head">
          <div className="revert-modal-title-row">
            <span className="revert-modal-icon" aria-hidden="true">
              <RewindIcon size={16} />
            </span>
            <div>
              <h2 className="revert-modal-title">Revert to Checkpoint</h2>
              <p className="revert-modal-subtitle">
                Select a checkpoint to restore files and rewind your conversation.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close Revert to Checkpoint modal"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="revert-modal-body">
          {checkpointList.length === 0 ? (
            <div className="revert-modal-empty">
              <div className="revert-empty-icon">
                <RewindIcon size={24} />
              </div>
              <h3>No checkpoints in this conversation</h3>
              <p>
                Checkpoints are automatically created whenever Photon makes edits to your workspace files.
              </p>
            </div>
          ) : (
            <div className="revert-checkpoint-list">
              {checkpointList.map((cp) => (
                <div key={cp.id} className="revert-checkpoint-card">
                  <div className="revert-checkpoint-meta">
                    <span className="revert-checkpoint-badge">
                      Checkpoint #{cp.checkpointNumber}
                    </span>
                    <span className="revert-checkpoint-time">{timeAgo(cp.timestamp)}</span>
                    <span className="revert-checkpoint-file-count">
                      {cp.filesCount} file{cp.filesCount === 1 ? "" : "s"}
                    </span>
                    {cp.hasUnrestorableFiles && (
                      <span
                        className="revert-checkpoint-warn-badge"
                        title={`Large files (>2MB) without content snapshot: ${cp.unrestorableFiles?.join(", ")}`}
                      >
                        ⚠️ &gt;2MB files unrestorable
                      </span>
                    )}
                  </div>

                  <div className="revert-checkpoint-prompt" title={cp.label}>
                    &ldquo;{cp.label}&rdquo;
                  </div>

                  <div className="revert-checkpoint-files">
                    {cp.files.map((file) => (
                      <button
                        key={file}
                        type="button"
                        className="revert-file-tag"
                        title={`Open ${file} in editor`}
                        onClick={() => actions.openFile(file)}
                      >
                        {file}
                      </button>
                    ))}
                  </div>

                  {cp.hasUnrestorableFiles && cp.unrestorableFiles && cp.unrestorableFiles.length > 0 && (
                    <div className="revert-unrestorable-notice" role="alert">
                      <span className="unrestorable-icon">⚠️</span>
                      <span>
                        <strong>Partial rollback notice:</strong> {cp.unrestorableFiles.join(", ")} exceeded 2MB and cannot be reverted. Other files will be restored.
                      </span>
                    </div>
                  )}

                  <div className="revert-checkpoint-actions">
                    <button
                      type="button"
                      className="btn primary btn-sm revert-btn"
                      onClick={() => {
                        actions.rollbackCheckpoint(cp.id, true);
                        onClose();
                      }}
                      title="Restores files on disk, rewinds chat to this point, and pastes prompt in chat box"
                    >
                      <RewindIcon size={12} />
                      <span>Revert &amp; Rewind Chat</span>
                    </button>
                    <button
                      type="button"
                      className="btn ghost btn-sm"
                      onClick={() => {
                        actions.rollbackCheckpoint(cp.id, false);
                        onClose();
                      }}
                      title="Restores files on disk while retaining conversation history"
                    >
                      <span>Files Only</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

