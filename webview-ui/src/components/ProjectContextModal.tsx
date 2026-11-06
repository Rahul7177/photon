import { useEffect, useState } from "react";
import type { ProjectContextSummary, ProjectMemoryNote } from "../../../src/shared/types";
import type { Actions } from "../state/store";
import {
  BrainIcon,
  RefreshIcon,
  CloseIcon,
  BoltIcon,
  CheckIcon,
  LayersIcon,
  PinIcon,
} from "./Icons";

export function ProjectContextModal({
  context,
  selectedModel,
  actions,
  onClose,
}: {
  context: ProjectContextSummary | null;
  selectedModel: string;
  actions: Actions;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"handoff" | "architecture" | "notes">("handoff");
  const [refreshing, setRefreshing] = useState(false);

  const [noteCategory, setNoteCategory] = useState<ProjectMemoryNote["category"]>("architecture");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");

  useEffect(() => {
    actions.requestProjectContext();
  }, [actions]);

  const handleRefresh = () => {
    setRefreshing(true);
    actions.refreshProjectContext();
    setTimeout(() => setRefreshing(false), 600);
  };

  const handleAddNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteTitle.trim() || !noteContent.trim()) return;
    actions.addProjectNote({
      category: noteCategory,
      title: noteTitle.trim(),
      content: noteContent.trim(),
    });
    setNoteTitle("");
    setNoteContent("");
  };

  const handoff = context?.latestHandoff ?? null;
  const isModelSwitchPending =
    Boolean(handoff?.fromModel && selectedModel) &&
    handoff!.fromModel.toLowerCase() !== selectedModel.toLowerCase();

  const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="hw-modal ctx-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Project Context"
      >
        <div className="hw-modal-header">
          <div className="hw-modal-title-wrap">
            <span className="hw-modal-icon">
              <BrainIcon />
            </span>
            <span className="hw-modal-title">Project Context</span>
          </div>
          <div className="ctx-modal-head-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Re-scan workspace files and symbols"
            >
              <RefreshIcon />
              <span>{refreshing ? "Syncing…" : "Sync"}</span>
            </button>
            <button type="button" className="icon-btn" onClick={onClose} title="Close">
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Compact 3-Stat Bar */}
        <div className="ctx-metrics-grid">
          <div className="ctx-metric-card">
            <span className="ctx-metric-label">Files</span>
            <span className="ctx-metric-val">{context?.totalFiles ?? 0}</span>
          </div>
          <div className="ctx-metric-card">
            <span className="ctx-metric-label">Symbols</span>
            <span className="ctx-metric-val">{fmtK(context?.totalSymbols ?? 0)}</span>
          </div>
          <div className="ctx-metric-card">
            <span className="ctx-metric-label">Saved</span>
            <span className="ctx-metric-val">~{fmtK(context?.estimatedTokensSaved ?? 0)} tok</span>
          </div>
        </div>

        {/* Clean Segmented Tabs */}
        <div className="ctx-tabs">
          <button
            type="button"
            className={`ctx-tab ${tab === "handoff" ? "active" : ""}`}
            onClick={() => setTab("handoff")}
          >
            <RefreshIcon />
            <span>Memory</span>
          </button>
          <button
            type="button"
            className={`ctx-tab ${tab === "architecture" ? "active" : ""}`}
            onClick={() => setTab("architecture")}
          >
            <LayersIcon />
            <span>Index</span>
          </button>
          <button
            type="button"
            className={`ctx-tab ${tab === "notes" ? "active" : ""}`}
            onClick={() => setTab("notes")}
          >
            <PinIcon />
            <span>Notes ({context?.notes.length ?? 0})</span>
          </button>
        </div>

        <div className="ctx-modal-body">
          {tab === "handoff" && (
            <div className="ctx-section-stack">
              <div className={`ctx-handoff-card ${isModelSwitchPending ? "switch-ready" : ""}`}>
                <div className="ctx-handoff-head">
                  <span className="ctx-handoff-badge">
                    {isModelSwitchPending ? (
                      <>
                        <BoltIcon />
                        <span>Handoff: {handoff?.fromModel} → {selectedModel}</span>
                      </>
                    ) : handoff ? (
                      <>
                        <CheckIcon size={12} />
                        <span>Synced ({handoff.fromModel})</span>
                      </>
                    ) : (
                      "Working Memory"
                    )}
                  </span>
                  {handoff && (
                    <button
                      type="button"
                      className="btn btn-sm ghost"
                      onClick={() => actions.clearWorkingMemory()}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {handoff ? (
                  <div className="ctx-handoff-details">
                    {handoff.taskSummary && (
                      <div className="ctx-detail-row">
                        <strong>Task:</strong> <span>{handoff.taskSummary}</span>
                      </div>
                    )}
                    {handoff.activeFiles.length > 0 && (
                      <div className="ctx-detail-row">
                        <strong>Files:</strong>
                        <span className="ctx-code-pills">
                          {handoff.activeFiles.slice(0, 6).map((f) => (
                            <code key={f}>{f}</code>
                          ))}
                        </span>
                      </div>
                    )}
                    {handoff.recentEdits.length > 0 && (
                      <div className="ctx-detail-block">
                        <strong>Recent Edits:</strong>
                        <ul className="ctx-compact-list">
                          {handoff.recentEdits.slice(0, 4).map((e, i) => (
                            <li key={i}>
                              <code>{e.path}</code> — {e.summary}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="ctx-empty-hint">
                    Tracks active files and edits across model switches automatically.
                  </div>
                )}
              </div>

              <div className="ctx-subsection">
                <div className="ctx-subsection-title">Recent Files</div>
                <div className="ctx-file-list">
                  {(context?.recentFiles ?? []).slice(0, 12).map((f) => (
                    <div key={f.path} className="ctx-file-item">
                      <div className="ctx-file-top">
                        <code className="ctx-file-path">{f.path}</code>
                        <span className={`ctx-action-pill ${f.lastAction}`}>{f.lastAction}</span>
                        <span className="ctx-file-meta">
                          {f.lineCount}L · {f.symbolCount} sym
                        </span>
                      </div>
                    </div>
                  ))}
                  {(!context || context.recentFiles.length === 0) && (
                    <div className="ctx-empty-hint">No indexed files yet.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === "architecture" && (
            <div className="ctx-section-stack">
              <div className="ctx-arch-grid">
                <div className="ctx-arch-box">
                  <div className="ctx-subsection-title">Stack</div>
                  <div className="ctx-tag-list">
                    {[...(context?.languages ?? []), ...(context?.frameworks ?? [])].map((item) => (
                      <span key={item} className="ctx-tag">
                        {item}
                      </span>
                    ))}
                    {(context?.languages.length ?? 0) === 0 && (
                      <span className="ctx-empty-hint">None detected</span>
                    )}
                  </div>
                </div>
                <div className="ctx-arch-box">
                  <div className="ctx-subsection-title">Entry Points</div>
                  <div className="ctx-code-pills">
                    {(context?.entryPoints ?? []).map((ep) => (
                      <code key={ep}>{ep}</code>
                    ))}
                    {(context?.entryPoints.length ?? 0) === 0 && (
                      <span className="ctx-empty-hint">None detected</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="ctx-subsection">
                <div className="ctx-subsection-title">Modules</div>
                <div className="ctx-dir-list">
                  {(context?.topDirectories ?? []).map((d) => (
                    <div key={d.path} className="ctx-dir-item">
                      <code>{d.path}/</code>
                      <span className="ctx-dir-purpose">{d.purpose}</span>
                      <span className="ctx-dir-count">{d.fileCount} files</span>
                    </div>
                  ))}
                  {(context?.topDirectories.length ?? 0) === 0 && (
                    <div className="ctx-empty-hint">No modules mapped yet.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === "notes" && (
            <div className="ctx-section-stack">
              <form className="ctx-note-form" onSubmit={handleAddNote}>
                <div className="ctx-note-form-row">
                  <select
                    value={noteCategory}
                    onChange={(e) => setNoteCategory(e.target.value as ProjectMemoryNote["category"])}
                    className="ctx-select"
                  >
                    <option value="architecture">Architecture</option>
                    <option value="convention">Convention</option>
                    <option value="decision">Decision</option>
                    <option value="task">Task</option>
                    <option value="gotcha">Gotcha</option>
                  </select>
                  <input
                    type="text"
                    placeholder="Note title…"
                    value={noteTitle}
                    onChange={(e) => setNoteTitle(e.target.value)}
                    className="ctx-input"
                  />
                </div>
                <div className="ctx-note-form-foot">
                  <input
                    type="text"
                    placeholder="Rule or project note…"
                    value={noteContent}
                    onChange={(e) => setNoteContent(e.target.value)}
                    className="ctx-input"
                  />
                  <button
                    type="submit"
                    className="btn primary btn-sm"
                    disabled={!noteTitle.trim() || !noteContent.trim()}
                  >
                    Add
                  </button>
                </div>
              </form>

              <div className="ctx-notes-list">
                {(context?.notes ?? []).map((n) => (
                  <div key={n.id} className="ctx-note-card">
                    <div className="ctx-note-head">
                      <span className={`ctx-note-cat ${n.category}`}>{n.category}</span>
                      <strong className="ctx-note-title">{n.title}</strong>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => actions.deleteProjectNote(n.id)}
                        title="Delete note"
                      >
                        <CloseIcon />
                      </button>
                    </div>
                    <div className="ctx-note-body">{n.content}</div>
                  </div>
                ))}
                {(!context || context.notes.length === 0) && (
                  <div className="ctx-empty-hint">No pinned project notes yet.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
