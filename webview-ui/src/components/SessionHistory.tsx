import { useEffect, useRef } from "react";
import type { SessionSummary } from "../../../src/shared/types";
import type { Actions } from "../state/store";
import { TrashIcon } from "./Icons";

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

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onClose]);

  return (
    <div className="history-pop" ref={ref}>
      {sessions.length === 0 ? (
        <div className="history-empty">No previous chats</div>
      ) : (
        sessions.map((s) => (
          <div
            key={s.id}
            className={`history-row ${s.id === activeId ? "active" : ""}`}
            onClick={() => {
              actions.switchSession(s.id);
              onClose();
            }}
          >
            <div className="history-row-main">
              <div className="history-title">{s.title || "New chat"}</div>
              <div className="history-meta">
                {relativeTime(s.updatedAt)} · {s.messageCount} msg{s.messageCount === 1 ? "" : "s"}
              </div>
            </div>
            <button
              className="history-delete"
              title="Delete chat"
              onClick={(e) => {
                e.stopPropagation();
                actions.deleteSession(s.id);
              }}
            >
              <TrashIcon />
            </button>
          </div>
        ))
      )}
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
