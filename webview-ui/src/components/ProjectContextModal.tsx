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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
        aria-modal="true"
        aria-label="Project Context and Memory"
      >
        <div className="hw-modal-header">
          <div className="hw-modal-title-wrap">
            <span className="hw-modal-icon" aria-hidden="true">
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
              aria-label="Re-scan workspace files and symbols"
            >
              <RefreshIcon />
              <span>{refreshing ? "Syncing…" : "Sync"}</span>
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close Project Context modal"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Summary Metrics Bar (Measured vs Estimated) */}
        <div className="ctx-metrics-grid" role="region" aria-label="Workspace index summary">
          <div className="ctx-metric-card">
            <span className="ctx-metric-label">Indexed Files</span>
            <span className="ctx-metric-val">{context?.totalFiles ?? 0}</span>
          </div>
          <div className="ctx-metric-card">
            <span className="ctx-metric-label">Symbols Extracted</span>
            <span className="ctx-metric-val">{fmtK(context?.totalSymbols ?? 0)}</span>
          </div>
          <div
            className="ctx-metric-card"
            title="Estimated tokens saved by injecting symbol outlines instead of full file contents"
          >
            <span className="ctx-metric-label">Est. Context Saved</span>
            <span className="ctx-metric-val">~{fmtK(context?.estimatedTokensSaved ?? 0)} tok</span>
          </div>
        </div>

        {/* Clean Segmented Tabs */}
        <div className="ctx-tabs" role="tablist" aria-label="Project context sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "handoff"}
            className={`ctx-tab ${tab === "handoff" ? "active" : ""}`}
            onClick={() => setTab("handoff")}
          >
            <RefreshIcon />
            <span>Memory &amp; Files</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "architecture"}
            className={`ctx-tab ${tab === "architecture" ? "active" : ""}`}
            onClick={() => setTab("architecture")}
          >
            <LayersIcon />
            <span>Modules &amp; Index</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "notes"}
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
                        <span>Handoff Ready: {handoff?.fromModel} → {selectedModel}</span>
                      </>
                    ) : handoff ? (
                      <>
                        <CheckIcon size={12} />
                        <span>Working Memory ({handoff.fromModel})</span>
                      </>
                    ) : (
                      "Cross-Model Working Memory"
                    )}
                  </span>
                  {handoff && (
                    <button
                      type="button"
                      className="btn btn-sm ghost"
                      onClick={() => actions.clearWorkingMemory()}
                      title="Clear recorded turn handoff memory"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {handoff ? (
                  <div className="ctx-handoff-details">
                    {handoff.taskSummary && (
                      <div className="ctx-detail-row">
                        <strong>Last Task:</strong> <span>{handoff.taskSummary}</span>
                      </div>
                    )}
                    {handoff.activeFiles.length > 0 && (
                      <div className="ctx-detail-row">
                        <strong>Active Files:</strong>
                        <span className="ctx-code-pills">
                          {handoff.activeFiles.slice(0, 6).map((f) => (
                            <button
                              key={f}
                              type="button"
                              className="ctx-file-pill-btn"
                              title={`Open ${f} in editor`}
                              onClick={() => {
                                actions.openFile(f);
                                onClose();
                              }}
                            >
                              <code>{f}</code>
                            </button>
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
                              <button
                                type="button"
                                className="ctx-file-pill-btn"
                                title={`Open ${e.path} in editor`}
                                onClick={() => {
                                  actions.openFile(e.path);
                                  onClose();
                                }}
                              >
                                <code>{e.path}</code>
                              </button>{" "}
                              — {e.summary}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="ctx-empty-hint">
                    Tracks active files, recent edits, and task state so switching between local and cloud models preserves context automatically.
                  </div>
                )}
              </div>

              <div className="ctx-subsection">
                <div className="ctx-subsection-title">Indexed &amp; Recently Touched Files (click to open)</div>
                <div className="ctx-file-list">
                  {(context?.recentFiles ?? []).slice(0, 12).map((f) => (
                    <div key={f.path} className="ctx-file-item">
                      <div className="ctx-file-top">
                        <button
                          type="button"
                          className="ctx-file-link-btn"
                          title={`Open ${f.path} in VS Code`}
                          onClick={() => {
                            actions.openFile(f.path);
                            onClose();
                          }}
                        >
                          <code className="ctx-file-path">{f.path}</code>
                        </button>
                        <span className={`ctx-action-pill ${f.lastAction}`}>{f.lastAction}</span>
                        <span className="ctx-file-meta">
                          {f.lineCount}L · {f.symbolCount} sym
                        </span>
                      </div>
                    </div>
                  ))}
                  {(!context || context.recentFiles.length === 0) && (
                    <div className="ctx-empty-hint">No indexed files yet. Click Sync to scan the workspace.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === "architecture" && (
            <div className="ctx-section-stack">
              <div className="ctx-arch-grid">
                <div className="ctx-arch-box">
                  <div className="ctx-subsection-title">Detected Stack</div>
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
                  <div className="ctx-subsection-title">Entry Points (click to open)</div>
                  <div className="ctx-code-pills">
                    {(context?.entryPoints ?? []).map((ep) => (
                      <button
                        key={ep}
                        type="button"
                        className="ctx-file-pill-btn"
                        title={`Open ${ep} in editor`}
                        onClick={() => {
                          actions.openFile(ep);
                          onClose();
                        }}
                      >
                        <code>{ep}</code>
                      </button>
                    ))}
                    {(context?.entryPoints.length ?? 0) === 0 && (
                      <span className="ctx-empty-hint">None detected</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="ctx-subsection">
                <div className="ctx-subsection-title">Workspace Modules</div>
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
                    aria-label="Note category"
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
                    aria-label="Note title"
                    placeholder="Note title…"
                    value={noteTitle}
                    onChange={(e) => setNoteTitle(e.target.value)}
                    className="ctx-input"
                  />
                </div>
                <div className="ctx-note-form-foot">
                  <input
                    type="text"
                    aria-label="Rule or project note"
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
                        aria-label={`Delete note ${n.title}`}
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
