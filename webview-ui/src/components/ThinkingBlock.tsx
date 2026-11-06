import { memo, useEffect, useRef, useState } from "react";
import { ChevronRightIcon, SparkleIcon } from "./Icons";

/**
 * Collapsible reasoning-trace block (Copilot-style).
 *
 * - While the model is still thinking (streaming, no answer yet): open in a
 *   tall scrollable window with follow-scroll, so the trace reads complete
 *   instead of cropping mid-sentence.
 * - The moment the actual answer starts streaming (or the bubble finishes):
 *   auto-collapses to a one-line "Thought process" toggle.
 * - A manual expand/collapse afterwards is respected — auto-collapse only ever
 *   closes, and only on the streaming→content / streaming→done transitions.
 * - Trace renders as plain text (not Markdown): reasoning often contains
 *   half-formed markup and code, which would parse noisily and cost cycles.
 */
export const ThinkingBlock = memo(function ThinkingBlock({ thinking, elapsedMs, live }: {
  thinking: string;
  elapsedMs?: number;
  live: boolean;
}) {
  const [open, setOpen] = useState(live);
  const collapsedOnce = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Answer started arriving while we were open: collapse once.
    if (!live && open && !collapsedOnce.current) {
      collapsedOnce.current = true;
      setOpen(false);
    }
  }, [live, open ]);

  useEffect(() => {
    // Follow-scroll the live trace so the newest reasoning stays visible.
    // Respects the user: if they scrolled up to read, don't yank them down.
    if (!live || !open) return;
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [thinking, live, open]);

  const label = live
    ? "Thinking…"
    : elapsedMs !== undefined
      ? `Thought for ${formatElapsed(elapsedMs)}`
      : "Thought process";

  return (
    <div className={`thinking${open ? " open" : ""}`}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((o) => !o)}
        title={open ? "Collapse reasoning" : "Expand reasoning"}
      >
        {live ? (
          <span className="thinking-spinner" />
        ) : (
          <span className="thinking-icon">
            <SparkleIcon />
          </span>
        )}
        <span className="thinking-label">{label}</span>
        <span className={`thinking-chevron${open ? " open" : ""}`}>
          <ChevronRightIcon />
        </span>
      </button>
      {open && (
        <div ref={bodyRef} className={`thinking-body${live ? " live" : ""}`}>{thinking}</div>
      )}
    </div>
  );
});

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
