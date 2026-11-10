import { memo, useEffect, useRef, useState } from "react";
import type { ChatMessage, ToolCall } from "../../../src/shared/types";
import type { Actions } from "../state/store";
import { ToolCard } from "./ToolCard";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  CheckCircleIcon,
  AlertTriangleIcon,
  SparkleIcon,
  ChevronRightIcon,
  StopSquareIcon,
} from "./Icons";

export const TurnProcess = memo(function TurnProcess({
  messages,
  pendingApproval: _pendingApproval,
  actions,
  isStreaming,
  hasContent,
}: {
  messages: ChatMessage[];
  pendingApproval?: ToolCall | null;
  actions?: Actions;
  isStreaming: boolean;
  hasContent: boolean;
}) {
  const allToolCalls: ToolCall[] = [];
  const thinkingMessages: ChatMessage[] = [];
  let totalThinkingMs = 0;
  let wasCancelled = false;

  for (const m of messages) {
    if (m.toolCalls?.length) allToolCalls.push(...m.toolCalls);
    if (hasVisibleText(m.thinking)) {
      thinkingMessages.push(m);
      if (m.thinkingElapsedMs) totalThinkingMs += m.thinkingElapsedMs;
    }
    if (m.notice && /stopped/i.test(m.notice)) {
      wasCancelled = true;
    }
  }

  const hasToolCalls = allToolCalls.length > 0;
  const hasThinking = thinkingMessages.length > 0;

  // Nothing to abstract
  if (!hasToolCalls && !hasThinking) return null;

  // Only auto-expand while actively streaming initial thinking/tool steps before text output.
  // Never auto-expand on tool approval — approval belongs solely in the dedicated bottom card.
  const shouldBeOpenLive = isStreaming && !hasContent;

  const [open, setOpen] = useState(shouldBeOpenLive);
  const userToggled = useRef(false);

  useEffect(() => {
    // Auto-open only while streaming initial steps before content arrives
    if (isStreaming && !hasContent && !userToggled.current && !open) {
      setOpen(true);
    } else if ((hasContent || !isStreaming) && !userToggled.current && open) {
      // Auto-collapse once content starts streaming or execution settles
      setOpen(false);
    }
  }, [hasContent, isStreaming, open]);

  // If there are NO tool calls and only 1 thinking message, use standard ThinkingBlock
  if (!hasToolCalls && thinkingMessages.length === 1) {
    const single = thinkingMessages[0];
    const live = isStreaming && !hasContent;
    return (
      <ThinkingBlock
        thinking={single.thinking!}
        elapsedMs={single.thinkingElapsedMs}
        live={live}
      />
    );
  }

  const summary = computeSummary(
    allToolCalls,
    totalThinkingMs,
    isStreaming,
    hasContent,
    wasCancelled
  );

  const handleToggle = () => {
    userToggled.current = true;
    setOpen((o) => !o);
  };

  // Group steps by message so multi-step execution flows chronologically
  const steps = messages.filter(
    (m) => (m.toolCalls?.length ?? 0) > 0 || hasVisibleText(m.thinking)
  );

  return (
    <div className={`turn-process${open ? " open" : ""}`}>
      <button
        type="button"
        className="turn-process-head"
        onClick={handleToggle}
        title={open ? "Collapse execution details" : "Expand execution details"}
        aria-expanded={open}
        aria-label={`Agent execution steps: ${summary.text}`}
      >
        {summary.state === "running" ? (
          <span className="turn-process-spinner" aria-hidden="true" />
        ) : summary.state === "error" ? (
          <span className="turn-process-icon err" aria-hidden="true">
            <AlertTriangleIcon />
          </span>
        ) : summary.state === "cancelled" ? (
          <span className="turn-process-icon cancelled" aria-hidden="true">
            <StopSquareIcon />
          </span>
        ) : hasToolCalls ? (
          <span className="turn-process-icon ok" aria-hidden="true">
            <CheckCircleIcon />
          </span>
        ) : (
          <span className="turn-process-icon brain" aria-hidden="true">
            <SparkleIcon />
          </span>
        )}

        <span className={`turn-process-badge ${summary.state}`}>{summary.badge}</span>
        <span className="turn-process-label">{summary.text}</span>
        <span className={`turn-process-chevron${open ? " open" : ""}`} aria-hidden="true">
          <ChevronRightIcon />
        </span>
      </button>

      {open && (
        <div className="turn-process-body">
          {steps.map((m, idx) => {
            const hasStepThinking = hasVisibleText(m.thinking);
            const stepTools = m.toolCalls ?? [];
            const isSingleStep = steps.length === 1;

            return (
              <div key={m.id} className="turn-process-step">
                {!isSingleStep && (
                  <div className="turn-process-step-title">
                    Step {idx + 1}
                    {m.thinkingElapsedMs ? ` · Thought for ${formatElapsed(m.thinkingElapsedMs)}` : ""}
                  </div>
                )}

                {hasStepThinking && (
                  <div className="turn-process-step-thinking">
                    <ThinkingBlock
                      thinking={m.thinking!}
                      elapsedMs={isSingleStep ? m.thinkingElapsedMs : undefined}
                      live={isStreaming && !hasContent && m.streaming === true}
                    />
                  </div>
                )}

                {stepTools.length > 0 && (
                  <div className="turn-process-step-tools">
                    {stepTools.map((call) => (
                      <ToolCard
                        key={call.id}
                        call={call}
                        actions={actions}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export function computeSummary(
  toolCalls: ToolCall[],
  totalThinkingMs: number,
  isStreaming: boolean,
  hasContent: boolean,
  wasCancelled: boolean
): {
  text: string;
  badge: string;
  state: "running" | "error" | "cancelled" | "done";
} {
  const toolCount = toolCalls.length;
  const errorCount = toolCalls.filter((c) => c.status === "error").length;
  const deniedCount = toolCalls.filter((c) => c.status === "denied").length;
  const runningTool = toolCalls.find((c) => c.status === "running");
  const timeStr = totalThinkingMs > 0 ? `Thought for ${formatElapsed(totalThinkingMs)}` : "";

  if (isStreaming && (runningTool || !hasContent)) {
    if (runningTool) {
      const doneCount = toolCalls.filter((c) => c.status === "done").length;
      const isVerifying = runningTool.name === "get_diagnostics";
      return {
        text: isVerifying
          ? `Verifying changes (${runningTool.name})… (${doneCount}/${toolCount})`
          : `Running ${runningTool.name}… (${doneCount}/${toolCount} tools)`,
        badge: isVerifying ? "Verifying" : "Running",
        state: "running",
      };
    }
    if (toolCount > 0) {
      return {
        text: `Executing tools… (${toolCount} call${toolCount === 1 ? "" : "s"})`,
        badge: "Running",
        state: "running",
      };
    }
    return {
      text: "Understanding request & reasoning…",
      badge: "Thinking",
      state: "running",
    };
  }

  if (wasCancelled || (deniedCount > 0 && deniedCount === toolCount)) {
    const toolStr =
      toolCount > 0
        ? `${toolCount} tool${toolCount === 1 ? "" : "s"} (${deniedCount > 0 ? `${deniedCount} denied` : "stopped"})`
        : "Stopped";
    return {
      text: timeStr ? `${toolStr} · ${timeStr}` : toolStr,
      badge: deniedCount > 0 ? "Denied" : "Cancelled",
      state: "cancelled",
    };
  }

  // Done or answer is streaming
  if (toolCount > 0) {
    if (errorCount > 0) {
      const toolStr = `${toolCount} tool${toolCount === 1 ? "" : "s"} (${errorCount} failed)`;
      return {
        text: timeStr ? `${toolStr} · ${timeStr}` : toolStr,
        badge: "Failed",
        state: "error",
      };
    }
    const verified = toolCalls.some((c) => c.name === "get_diagnostics" && c.status === "done");
    const toolStr = `${toolCount} tool${toolCount === 1 ? "" : "s"} used${verified ? " · verified" : ""}`;
    return {
      text: timeStr ? `${toolStr} · ${timeStr}` : toolStr,
      badge: "Done",
      state: "done",
    };
  }

  // Thinking only
  return {
    text: timeStr || "Thought process",
    badge: "Reasoned",
    state: "done",
  };
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const NO_GLYPH = /[\s\u00A0\u180E\u200B-\u200F\u2028\u2029\u2060-\u2064\u206A-\u206F\uFEFF]/g;
function hasVisibleText(s?: string): boolean {
  if (!s) return false;
  return s.replace(NO_GLYPH, "").length > 0;
}
