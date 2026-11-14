import { useEffect, useState } from "react";
import type { ToolCall } from "../../../src/shared/types";
import type { Actions, AppState } from "../state/store";
import { AlertTriangleIcon, CheckCircleIcon, CloseIcon, StopSquareIcon } from "./Icons";

const TERMINAL_TOOL_NAMES = new Set([
  "run_command",
  "execute_command",
  "bash",
  "terminal",
  "sh",
  "shell",
  "exec_command",
  "execute_bash",
]);

export function isTerminalToolName(name: string): boolean {
  return TERMINAL_TOOL_NAMES.has(name.trim().toLowerCase());
}

export interface TerminalTaskItem {
  id: string;
  toolName: string;
  kind: "terminal" | "verify";
  command: string;
  cwd?: string;
  phase: "running" | "awaiting_approval" | "queued" | "done" | "error";
  startedAt?: number;
  detail?: string;
  dockedApproval?: boolean;
}

function shortCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

function formatTaskCommand(call: ToolCall): { command: string; kind: "terminal" | "verify"; cwd?: string } {
  if (call.name === "get_diagnostics") {
    const p = typeof call.args?.path === "string" ? call.args.path.trim() : "";
    return {
      command: p ? `get_diagnostics (${p})` : "get_diagnostics (workspace)",
      kind: "verify",
    };
  }
  const rawCmd = call.args?.command ?? call.args?.cmd ?? call.args?.script ?? call.name;
  const cmdText = String(rawCmd).replace(/\s+/g, " ").trim();
  const isVerifyCmd =
    /verifying/i.test(call.statusDetail || "") ||
    /\b(test|typecheck|tsc|vitest|jest|pytest|cargo\s+test|go\s+test|lint|eslint)\b/i.test(cmdText);
  return {
    command: cmdText || call.name,
    kind: isVerifyCmd ? "verify" : "terminal",
    cwd: shortCwd(call.args?.cwd),
  };
}

/**
 * Derive active, queued ("about to run"), and current-turn terminal/verification tasks
 * so a compact status strip can stay pinned right above the composer.
 */
export function extractTerminalTasks(state: AppState): TerminalTaskItem[] {
  const messages = state.messages ?? [];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && !m.hidden) {
      lastUserIdx = i;
      break;
    }
  }
  const currentTurnMsgs = messages.slice(lastUserIdx + 1);
  const turnActive = state.status === "running" || state.status === "thinking";
  const pendingId = state.pendingApproval?.id;

  const byId = new Map<string, TerminalTaskItem>();

  for (const m of currentTurnMsgs) {
    for (const c of m.toolCalls ?? []) {
      if (!isTerminalToolName(c.name) && c.name !== "get_diagnostics") continue;
      let phase: TerminalTaskItem["phase"] | null = null;
      if (pendingId && c.id === pendingId) {
        phase = "awaiting_approval";
      } else if (c.status === "running" && turnActive) {
        phase = "running";
      } else if (c.status === "proposed" && turnActive) {
        phase = "queued";
      } else if ((c.status === "done" || c.status === "error") && turnActive) {
        phase = c.status;
      }
      if (!phase) continue;

      const meta = formatTaskCommand(c);
      byId.set(c.id, {
        id: c.id,
        toolName: c.name,
        kind: meta.kind,
        command: meta.command,
        cwd: meta.cwd,
        phase,
        startedAt: state.toolStartTimes?.[c.id],
        detail: c.error || c.result || c.statusDetail,
        dockedApproval: pendingId === c.id,
      });
    }
  }

  if (
    state.pendingApproval &&
    (isTerminalToolName(state.pendingApproval.name) || state.pendingApproval.name === "get_diagnostics") &&
    !byId.has(state.pendingApproval.id)
  ) {
    const c = state.pendingApproval;
    const meta = formatTaskCommand(c);
    byId.set(c.id, {
      id: c.id,
      toolName: c.name,
      kind: meta.kind,
      command: meta.command,
      cwd: meta.cwd,
      phase: "awaiting_approval",
      startedAt: state.toolStartTimes?.[c.id],
      detail: c.statusDetail,
      dockedApproval: true,
    });
  }

  if (turnActive) {
    for (const q of state.queuedTools ?? []) {
      if (!isTerminalToolName(q.name) && q.name !== "get_diagnostics") continue;
      if (byId.has(q.id)) continue;
      const meta = formatTaskCommand(q);
      byId.set(q.id, {
        id: q.id,
        toolName: q.name,
        kind: meta.kind,
        command: meta.command,
        cwd: meta.cwd,
        phase: "queued",
        detail: q.statusDetail,
      });
    }
  }

  return Array.from(byId.values());
}

/** Filter tasks for banner presentation (avoids duplicating an already-docked approval card). */
export function getVisibleTerminalBannerTasks(state: AppState): TerminalTaskItem[] {
  const all = extractTerminalTasks(state);
  const nonDocked = all.filter((t) => !t.dockedApproval);
  if (nonDocked.length === 0) return [];

  const active = nonDocked.filter((t) => t.phase === "running" || t.phase === "queued" || t.phase === "awaiting_approval");
  if (active.length > 0) return active;

  // No running/queued items remain: show only the most recent completed/failed task during the active turn
  return [nonDocked[nonDocked.length - 1]];
}

function formatElapsedSec(startedAt: number | undefined, nowMs: number): string {
  if (!startedAt) return "";
  const secs = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function tailLines(text: string, maxLines = 6): string {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join("\n");
  return "…\n" + lines.slice(-maxLines).join("\n");
}

function TerminalGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="m4.5 6.5 2.5 2-2.5 2" />
      <path d="M8.5 10.5h3" />
    </svg>
  );
}

export function TerminalTaskBanner({ state, actions }: { state: AppState; actions: Actions }) {
  const tasks = getVisibleTerminalBannerTasks(state);
  const hasRunning = tasks.some((t) => t.phase === "running");
  const hasActiveOrQueued = tasks.some((t) => t.phase === "running" || t.phase === "queued");
  const primary = tasks.find((t) => t.phase === "running") ?? tasks[0];
  const queuedFollowups = tasks.filter((t) => t.id !== primary?.id && t.phase === "queued");

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    if (!hasRunning) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  useEffect(() => {
    if (hasActiveOrQueued) {
      setDismissedId(null);
    }
  }, [hasActiveOrQueued, primary?.id]);

  if (!primary) return null;
  if (!hasActiveOrQueued && dismissedId === primary.id) return null;

  const isVerify = primary.kind === "verify";
  const phaseLabel =
    primary.phase === "running"
      ? isVerify
        ? "Verifying"
        : "Running"
      : primary.phase === "queued"
        ? "About to run"
        : primary.phase === "done"
          ? "Completed"
          : primary.phase === "error"
            ? "Failed"
            : "Pending";

  const elapsed = primary.phase === "running" ? formatElapsedSec(primary.startedAt, nowMs) : "";
  const canExpand = Boolean(primary.detail?.trim()) || queuedFollowups.length > 0;

  return (
    <div className="terminal-banner-dock">
      <div
        className={`terminal-banner phase-${primary.phase}${isVerify ? " kind-verify" : ""}`}
        role="region"
        aria-label={`Terminal task ${phaseLabel}: ${primary.command}`}
      >
        <div className="terminal-banner-main">
          <div className="terminal-banner-left">
            <span className={`terminal-banner-indicator phase-${primary.phase}`} aria-hidden="true">
              {primary.phase === "running" ? (
                <span className="terminal-banner-spinner" />
              ) : primary.phase === "done" ? (
                <CheckCircleIcon />
              ) : primary.phase === "error" ? (
                <AlertTriangleIcon />
              ) : (
                <TerminalGlyph />
              )}
            </span>

            <span className={`terminal-banner-pill phase-${primary.phase}`}>{phaseLabel}</span>

            <code className="terminal-banner-cmd" title={primary.command}>
              {primary.kind === "terminal" ? `$ ${primary.command}` : primary.command}
            </code>

            {primary.cwd && (
              <span className="terminal-banner-cwd" title={`Working directory: ${primary.cwd}`}>
                @{primary.cwd}
              </span>
            )}
          </div>

          <div className="terminal-banner-right">
            {elapsed && <span className="terminal-banner-elapsed">{elapsed}</span>}

            {queuedFollowups.length > 0 && (
              <button
                type="button"
                className="terminal-banner-queue-chip"
                onClick={() => setExpanded((e) => !e)}
                title="Show queued commands about to run"
              >
                +{queuedFollowups.length} next
              </button>
            )}

            {canExpand && (
              <button
                type="button"
                className="terminal-banner-toggle"
                onClick={() => setExpanded((e) => !e)}
                aria-expanded={expanded}
                title={expanded ? "Hide details" : "Show details"}
              >
                {expanded ? "▾" : "▸"}
              </button>
            )}

            {hasActiveOrQueued ? (
              <button
                type="button"
                className="terminal-banner-stop"
                onClick={() => actions.cancel()}
                title="Stop running terminal command"
                aria-label="Stop running terminal command"
              >
                <StopSquareIcon />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                className="terminal-banner-dismiss"
                onClick={() => setDismissedId(primary.id)}
                title="Dismiss banner"
                aria-label="Dismiss terminal banner"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        </div>

        {expanded && canExpand && (
          <div className="terminal-banner-details">
            {queuedFollowups.length > 0 && (
              <div className="terminal-banner-queued-list">
                <div className="terminal-banner-sublabel">About to run next:</div>
                {queuedFollowups.map((q) => (
                  <div key={q.id} className="terminal-banner-queued-item">
                    <span className="terminal-banner-pill phase-queued">Queued</span>
                    <code>{q.kind === "terminal" ? `$ ${q.command}` : q.command}</code>
                  </div>
                ))}
              </div>
            )}
            {primary.detail?.trim() && (
              <pre className="terminal-banner-output">{tailLines(primary.detail, 6)}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
