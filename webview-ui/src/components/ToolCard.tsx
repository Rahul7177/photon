import { useState } from "react";
import type { ToolCall } from "../../../src/shared/types";
import type { Actions } from "../state/store";

/**
 * Inline approval UI: a side-effecting tool call that's running and waiting on
 * the user shows Allow/Deny buttons right on the card. This is the primary
 * approval surface — it's harder to miss than the bottom-of-list Approval
 * component and survives scrolling.
 */
export function ToolCard({ call, pendingApproval, actions }: {
  call: ToolCall;
  pendingApproval?: ToolCall | null;
  actions?: Actions;
}) {
  const [open, setOpen] = useState(call.status === "error");
  const rawDetail = call.result ?? call.error;
  // Bound DOM: tool results are already clamped server-side, but persisted
  // sessions / MCP output can still be large. Truncate with an explicit note.
  const MAX_DETAIL = 4000;
  const detail = rawDetail && rawDetail.length > MAX_DETAIL
    ? rawDetail.slice(0, MAX_DETAIL) + `\n… [${rawDetail.length - MAX_DETAIL} more chars — see Output]`
    : rawDetail;
  const argSummary = Object.entries(call.args ?? {})
    .map(([k, v]) => `${k}=${truncate(String(v))}`)
    .join("  ");
  const isAwaitingApproval = pendingApproval?.id === call.id;
  // Never let a card collapse to a bare bordered box: a call with no name,
  // no args and an unmapped status (partial data from a persisted session or
  // a malformed model response) would render as a visually empty rectangle.
  const toolName = call.name?.trim() || "tool";
  const statusText = isAwaitingApproval ? "needs approval" : statusLabel(call.status);
  const iconStatus = KNOWN_STATUSES.has(call.status) ? call.status : "proposed";

  const decide = (approved: boolean) => {
    if (!actions) return;
    actions.approve(call.id, approved);
  };

  return (
    <div className={`tool-card${isAwaitingApproval ? " awaiting-approval" : ""}`}>
      <div className="tool-head" onClick={() => detail && setOpen((o) => !o)}>
        <span className={`tool-icon ${iconStatus}`} />
        <span className="tool-name">{toolName}</span>
        <span className="tool-args">{argSummary}</span>
        <span style={{ marginLeft: "auto", color: "var(--text-faint)", fontSize: 11 }}>
          {statusText}
        </span>
      </div>
      {isAwaitingApproval && actions && (
        <div className="tool-approval">
          <div className="tool-approval-text">
            <strong>Allow {toolName}?</strong> This action will modify files in your workspace.
          </div>
          <div className="tool-approval-actions">
            <button className="btn primary" onClick={() => decide(true)}>Allow</button>
            <button className="btn ghost" onClick={() => decide(false)}>Deny</button>
          </div>
        </div>
      )}
      {open && detail && <div className="tool-body">{detail}</div>}
    </div>
  );
}

const KNOWN_STATUSES = new Set<string>(["proposed", "running", "done", "error", "denied"]);

const STATUS_LABELS: Record<string, string> = {
  proposed: "queued",
  running: "running…",
  done: "done",
  error: "error",
  denied: "denied",
};

function statusLabel(s: ToolCall["status"]): string {
  const label = STATUS_LABELS[String(s)];
  if (label) return label;
  return typeof s === "string" && s.trim() ? s.trim() : "";
}

function truncate(s: string, n = 40): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}
