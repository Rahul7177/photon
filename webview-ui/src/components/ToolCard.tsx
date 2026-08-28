import { useState } from "react";
import type { ToolCall } from "../../../src/shared/types";

export function ToolCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(call.status === "error");
  const detail = call.result ?? call.error;
  const argSummary = Object.entries(call.args ?? {})
    .map(([k, v]) => `${k}=${truncate(String(v))}`)
    .join("  ");

  return (
    <div className="tool-card">
      <div className="tool-head" onClick={() => detail && setOpen((o) => !o)}>
        <span className={`tool-icon ${call.status}`} />
        <span className="tool-name">{call.name}</span>
        <span className="tool-args">{argSummary}</span>
        <span style={{ marginLeft: "auto", color: "var(--text-faint)", fontSize: 11 }}>
          {statusLabel(call.status)}
        </span>
      </div>
      {open && detail && <div className="tool-body">{detail}</div>}
    </div>
  );
}

function statusLabel(s: ToolCall["status"]): string {
  return {
    proposed: "queued",
    running: "running…",
    done: "done",
    error: "error",
    denied: "denied",
  }[s];
}

function truncate(s: string, n = 40): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}
