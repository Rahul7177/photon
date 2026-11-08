import { useState } from "react";
import type { ToolCall } from "../../../src/shared/types";
import type { Actions } from "../state/store";

/**
 * Inline approval UI + expandable tool execution card:
 * - Side-effecting tool calls waiting on the user show Allow / Always Allow / Deny right on the card.
 * - Tool output stays collapsed by default (except on errors) with a clear line/character summary
 *   so users never get a wall of raw output unless they expand it.
 */
export function ToolCard({
  call,
  pendingApproval: _pendingApproval,
  actions,
}: {
  call: ToolCall;
  pendingApproval?: ToolCall | null;
  actions?: Actions;
}) {
  const [open, setOpen] = useState(call.status === "error");
  const rawDetail = call.result ?? call.error;
  // Bound DOM: tool results are already clamped server-side, but persisted
  // sessions / MCP output can still be large. Truncate with an explicit note.
  const MAX_DETAIL = 4000;
  const detail =
    rawDetail && rawDetail.length > MAX_DETAIL
      ? rawDetail.slice(0, MAX_DETAIL) +
        `\n… [${rawDetail.length - MAX_DETAIL} more chars — see Output]`
      : rawDetail;
  const hasDetail = Boolean(detail && detail.trim().length > 0);
  const lineCount = hasDetail ? detail!.split("\n").length : 0;

  const argSummary = Object.entries(call.args ?? {})
    .map(([k, v]) => `${k}=${truncate(String(v))}`)
    .join("  ");
  // Never let a card collapse to a bare bordered box: a call with no name,
  // no args and an unmapped status (partial data from a persisted session or
  // a malformed model response) would render as a visually empty rectangle.
  const toolName = call.name?.trim() || "tool";
  const statusText = statusLabel(call.status);
  const iconStatus = KNOWN_STATUSES.has(call.status)
    ? call.status
    : "proposed";

  // Extract file path if this tool operates on a workspace file so the user can click to open it
  const targetFilePath = extractTargetFilePath(call.args);

  const toggleOpen = () => {
    if (hasDetail) setOpen((o) => !o);
  };

  return (
    <div className={`tool-card status-${iconStatus}`}>
      <div
        className={`tool-head${hasDetail ? " expandable" : ""}`}
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? open : undefined}
        aria-label={`${toolName} (${statusText})${hasDetail ? " — press Enter to toggle output" : ""}`}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (hasDetail && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggleOpen();
          }
        }}
      >
        <span className={`tool-icon ${iconStatus}`} aria-hidden="true" />
        <span className="tool-name">{toolName}</span>
        {targetFilePath && actions ? (
          <button
            type="button"
            className="tool-file-link"
            title={`Open ${targetFilePath} in editor`}
            aria-label={`Open ${targetFilePath} in editor`}
            onClick={(e) => {
              e.stopPropagation();
              actions.openFile(targetFilePath);
            }}
          >
            {targetFilePath}
          </button>
        ) : (
          <span className="tool-args">{argSummary}</span>
        )}
        <span className={`tool-status-badge ${iconStatus}`}>
          {statusSymbol(iconStatus)} {statusText}
        </span>
        {hasDetail && (
          <span className="tool-expand-hint" aria-hidden="true" title={open ? "Hide output" : `Show output (${lineCount} lines)`}>
            {open ? "▾ Hide" : `▸ ${lineCount}L`}
          </span>
        )}
      </div>
      {open && detail && <div className="tool-body">{detail}</div>}
    </div>
  );
}

const KNOWN_STATUSES = new Set<string>([
  "proposed",
  "approval",
  "running",
  "done",
  "error",
  "denied",
  "cancelled",
  "timeout",
]);

const STATUS_LABELS: Record<string, string> = {
  proposed: "Proposed",
  approval: "Awaiting Approval",
  running: "Running…",
  done: "Completed",
  error: "Failed",
  denied: "Denied",
  cancelled: "Cancelled",
  timeout: "Timed Out",
};

function statusLabel(s: ToolCall["status"]): string {
  const label = STATUS_LABELS[String(s)];
  if (label) return label;
  return typeof s === "string" && s.trim() ? s.trim() : "Proposed";
}

function statusSymbol(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "error":
      return "✕";
    case "denied":
      return "⊘";
    case "cancelled":
      return "⏹";
    case "timeout":
      return "⏱";
    case "approval":
      return "!";
    case "running":
      return "●";
    case "proposed":
    default:
      return "○";
  }
}

function extractTargetFilePath(args?: Record<string, unknown>): string | null {
  if (!args) return null;
  const candidate = args.path ?? args.file_path ?? args.filePath ?? args.target_file;
  if (typeof candidate === "string" && candidate.trim().length > 0 && !candidate.includes("\n")) {
    return candidate.trim();
  }
  return null;
}

function truncate(s: string, n = 40): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}
