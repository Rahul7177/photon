import { useEffect, useMemo, useRef, useState } from "react";
import type { Mode, SessionSummary } from "../../../src/shared/types";
import type { Actions } from "../state/store";
import { CheckIcon, CloseIcon, PencilIcon, PinIcon, PlusIcon, SearchIcon, TrashIcon } from "./Icons";

export const MAX_PINNED_CHATS = 3;
export type SessionFilterMode = "all" | "pinned" | Mode;

export interface GroupedSessions {
  pinned: SessionSummary[];
  recent: SessionSummary[];
  pinnedCount: number;
}

/** Format a compact model label (strips provider prefix for narrow history popovers). */
export function compactModelLabel(model?: string): string {
  if (!model) return "";
  const idx = model.indexOf(":");
  if (idx > 0 && idx < model.length - 1) {
    const tail = model.slice(idx + 1);
    return tail.split("/").pop() || tail;
  }
  return model.split("/").pop() || model;
}

/** Pure filter + pinned/recent partition helper for SessionHistory and tests. */
export function filterAndGroupSessions(
  sessions: SessionSummary[],
  query: string,
  filterMode: SessionFilterMode
): GroupedSessions {
  const pinnedCount = sessions.filter((s) => Boolean(s.pinned)).length;
  const q = query.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

  const matches = sessions.filter((s) => {
    if (filterMode === "pinned" && !s.pinned) return false;
    if (filterMode !== "all" && filterMode !== "pinned" && s.mode !== filterMode) return false;
    if (tokens.length === 0) return true;
    const title = (s.title || "New chat").toLowerCase();
    const model = (s.model || "").toLowerCase();
    const shortModel = compactModelLabel(s.model).toLowerCase();
    const mode = (s.mode || "").toLowerCase();
    const body = (s.searchText || "").toLowerCase();
    const haystack = `${title} ${model} ${shortModel} ${mode} ${body}`;
    return tokens.every((tok) => haystack.includes(tok));
  });

  const pinned = matches
    .filter((s) => Boolean(s.pinned))
    .sort((a, b) => (b.pinnedAt ?? b.updatedAt) - (a.pinnedAt ?? a.updatedAt));
  const recent = matches
    .filter((s) => !s.pinned)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return { pinned, recent, pinnedCount };
}

export function SessionHistory({
  sessions,
  activeId,
  actions,
  onClose,
}: {
  sessions: SessionSummary[];
  activeId: string;
  actions: Actions;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState<SessionFilterMode>("all");
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    // Delay adding the listener so the mousedown that *opened* this panel
    // doesn't immediately trigger the outside-click close.
    const timer = setTimeout(() => {
      const onDocClick = (e: MouseEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) onClose();
      };
      document.addEventListener("mousedown", onDocClick);
      timerRef.current = () => document.removeEventListener("mousedown", onDocClick);
    }, 0);
    const timerRef = { current: () => clearTimeout(timer) };
    return () => {
      clearTimeout(timer);
      timerRef.current();
    };
  }, [onClose]);

  const { pinned, recent, pinnedCount } = useMemo(
    () => filterAndGroupSessions(sessions, query, filterMode),
    [sessions, query, filterMode]
  );

  const flatResults = useMemo(() => [...pinned, ...recent], [pinned, recent]);

  useEffect(() => {
    setHighlightIndex(query.trim() && flatResults.length > 0 ? 0 : -1);
  }, [query, filterMode, flatResults.length]);

  const highlightedId =
    highlightIndex >= 0 && highlightIndex < flatResults.length ? flatResults[highlightIndex].id : null;

  const startRename = (s: SessionSummary) => {
    setConfirmDeleteId(null);
    setEditingId(s.id);
    setEditTitle(s.title || "New chat");
  };

  const commitRename = () => {
    if (!editingId) return;
    const clean = editTitle.replace(/\s+/g, " ").trim();
    if (clean) {
      actions.renameSession(editingId, clean);
    }
    setEditingId(null);
  };

  const renderRow = (s: SessionSummary) => {
    const isEditing = editingId === s.id;
    const isConfirmingDelete = confirmDeleteId === s.id;
    const pinDisabled = !s.pinned && pinnedCount >= MAX_PINNED_CHATS;
    const shortModel = compactModelLabel(s.model);
    const isHighlighted = highlightedId === s.id;

    return (
      <div
        key={s.id}
        className={`history-row ${s.id === activeId ? "active" : ""} ${s.pinned ? "pinned" : ""} ${isHighlighted ? "kb-highlight" : ""}`}
        onMouseLeave={() => {
          if (isConfirmingDelete) setConfirmDeleteId(null);
        }}
        onClick={() => {
          if (isEditing) return;
          actions.switchSession(s.id);
          onClose();
        }}
      >
        <div className="history-row-main">
          {isEditing ? (
            <input
              type="text"
              className="history-rename-input"
              value={editTitle}
              autoFocus
              maxLength={120}
              aria-label="Rename conversation"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingId(null);
                }
              }}
            />
          ) : (
            <div
              className="history-title"
              title="Double-click to rename"
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename(s);
              }}
            >
              {s.title || "New chat"}
            </div>
          )}
          <div className="history-meta">
            <span className={`history-mode-badge mode-${s.mode}`}>{s.mode}</span>
            <span>{relativeTime(s.updatedAt)}</span>
            <span>·</span>
            <span>{s.messageCount}m</span>
            {shortModel && (
              <>
                <span>·</span>
                <span className="history-model-tag" title={s.model}>
                  {shortModel}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="history-row-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`history-action-btn ${s.pinned ? "is-pinned" : ""}`}
            disabled={pinDisabled}
            title={
              s.pinned
                ? "Unpin conversation"
                : pinDisabled
                  ? `Maximum ${MAX_PINNED_CHATS} pinned chats — unpin one first`
                  : "Pin conversation to top (max 3)"
            }
            aria-label={s.pinned ? "Unpin conversation" : "Pin conversation"}
            onClick={() => actions.togglePinSession(s.id)}
          >
            <PinIcon size={12} filled={Boolean(s.pinned)} />
          </button>

          <button
            type="button"
            className="history-action-btn"
            title="Rename conversation"
            aria-label="Rename conversation"
            onClick={() => startRename(s)}
          >
            <PencilIcon />
          </button>

          <button
            type="button"
            className={`history-delete ${isConfirmingDelete ? "confirming" : ""}`}
            title={isConfirmingDelete ? "Click again to permanently delete" : "Delete chat"}
            aria-label={isConfirmingDelete ? "Confirm delete chat" : "Delete chat"}
            onClick={() => {
              if (!isConfirmingDelete) {
                setConfirmDeleteId(s.id);
                return;
              }
              setConfirmDeleteId(null);
              actions.deleteSession(s.id);
            }}
          >
            {isConfirmingDelete ? <CheckIcon size={11} /> : <TrashIcon />}
          </button>
        </div>
      </div>
    );
  };

  const hasResults = pinned.length > 0 || recent.length > 0;

  return (
    <div
      className="history-pop"
      ref={ref}
      role="dialog"
      aria-label="Conversation history"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (editingId) {
            e.stopPropagation();
            setEditingId(null);
            return;
          }
          if (query) {
            e.stopPropagation();
            setQuery("");
            searchInputRef.current?.focus();
            return;
          }
          if (filterMode !== "all") {
            e.stopPropagation();
            setFilterMode("all");
          }
        }
      }}
    >
      <div className="history-toolbar">
        <div
          className="history-search-wrap"
          onClick={() => searchInputRef.current?.focus()}
        >
          <span className="history-search-icon" aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            ref={searchInputRef}
            type="text"
            className="history-search-input"
            placeholder="Filter chats by title, message, or model…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && flatResults.length > 0) {
                e.preventDefault();
                setHighlightIndex((i) => (i + 1) % flatResults.length);
              } else if (e.key === "ArrowUp" && flatResults.length > 0) {
                e.preventDefault();
                setHighlightIndex((i) => (i <= 0 ? flatResults.length - 1 : i - 1));
              } else if (e.key === "Enter" && flatResults.length > 0) {
                const target =
                  highlightIndex >= 0 && highlightIndex < flatResults.length
                    ? flatResults[highlightIndex]
                    : query.trim()
                      ? flatResults[0]
                      : null;
                if (target) {
                  e.preventDefault();
                  actions.switchSession(target.id);
                  onClose();
                }
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="history-search-clear"
              title="Clear filter"
              aria-label="Clear filter"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                setQuery("");
                searchInputRef.current?.focus();
              }}
            >
              <CloseIcon />
            </button>
          )}
        </div>
        <button
          type="button"
          className="history-new-btn"
          title="Start new conversation"
          onClick={() => {
            actions.newSession();
            onClose();
          }}
        >
          <PlusIcon />
          <span>New</span>
        </button>
      </div>

      {sessions.length > 0 && (
        <div className="history-filters" role="tablist" aria-label="Filter conversations">
          {(
            [
              { id: "all", label: `All (${sessions.length})` },
              { id: "pinned", label: `Pinned (${pinnedCount}/${MAX_PINNED_CHATS})` },
              { id: "agent", label: "Agent" },
              { id: "plan", label: "Plan" },
              { id: "chat", label: "Chat" },
            ] as { id: SessionFilterMode; label: string }[]
          ).map((chip) => (
            <button
              key={chip.id}
              type="button"
              role="tab"
              aria-selected={filterMode === chip.id}
              className={`history-filter-chip ${filterMode === chip.id ? "active" : ""}`}
              onClick={() => setFilterMode(chip.id)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      <div className="history-scroll">
        {sessions.length === 0 ? (
          <div className="history-empty">No previous chats yet</div>
        ) : !hasResults ? (
          <div className="history-empty">
            <div>No chats match “{query || filterMode}”</div>
            <button
              type="button"
              className="history-reset-btn"
              onClick={() => {
                setQuery("");
                setFilterMode("all");
                searchInputRef.current?.focus();
              }}
            >
              Reset filters
            </button>
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <div className="history-section">
                <div className="history-section-label">
                  <span>Pinned</span>
                  <span>
                    {pinnedCount}/{MAX_PINNED_CHATS}
                  </span>
                </div>
                {pinned.map(renderRow)}
              </div>
            )}
            {recent.length > 0 && (
              <div className="history-section">
                {pinned.length > 0 && <div className="history-section-label">Recent</div>}
                {recent.map(renderRow)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
