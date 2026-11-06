import { memo, useEffect, useRef, useState } from "react";
import type { ChatMessage, ToolCall } from "../../../src/shared/types";
import type { Actions } from "../state/store";
import { ToolCard } from "./ToolCard";
import { ThinkingBlock } from "./ThinkingBlock";
import { CheckCircleIcon, AlertTriangleIcon, SparkleIcon, ChevronRightIcon } from "./Icons";

export const TurnProcess = memo(function TurnProcess({
  messages,
  pendingApproval,
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

  for (const m of messages) {
    if (m.toolCalls?.length) allToolCalls.push(...m.toolCalls);
    if (hasVisibleText(m.thinking)) {
      thinkingMessages.push(m);
      if (m.thinkingElapsedMs) totalThinkingMs += m.thinkingElapsedMs;
    }
  }

  const hasToolCalls = allToolCalls.length > 0;
  const hasThinking = thinkingMessages.length > 0;

  // Nothing to abstract
  if (!hasToolCalls && !hasThinking) return null;

  const hasPendingApproval = allToolCalls.some((c) => c.id === pendingApproval?.id);
  const shouldBeOpenLive = (isStreaming && !hasContent) || hasPendingApproval;

  const [open, setOpen] = useState(shouldBeOpenLive);
  const userToggled = useRef(false);

  useEffect(() => {
    // If a tool requires user approval, always expand so the user sees Allow/Deny
    if (hasPendingApproval && !open) {
      setOpen(true);
      return;
    }
    // Once content starts streaming or turn finishes, auto-abstract into collapsed state
    if ((hasContent || !isStreaming) && !userToggled.current && open) {
      setOpen(false);
    }
  }, [hasContent, isStreaming, hasPendingApproval, open]);

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

  const summary = computeSummary(allToolCalls, totalThinkingMs, isStreaming, hasContent);

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
      >
        {summary.isRunning ? (
          <span className="turn-process-spinner" />
        ) : summary.isError ? (
          <span className="turn-process-icon err">
            <AlertTriangleIcon />
          </span>
        ) : hasToolCalls ? (
          <span className="turn-process-icon ok">
            <CheckCircleIcon />
          </span>
        ) : (
          <span className="turn-process-icon brain">
            <SparkleIcon />
          </span>
        )}

        <span className="turn-process-label">{summary.text}</span>
        <span className={`turn-process-chevron${open ? " open" : ""}`}>
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
                        pendingApproval={pendingApproval}
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

function computeSummary(
  toolCalls: ToolCall[],
  totalThinkingMs: number,
  isStreaming: boolean,
  hasContent: boolean
): { text: string; isRunning?: boolean; isError?: boolean } {
  const toolCount = toolCalls.length;
  const errorCount = toolCalls.filter((c) => c.status === "error").length;
  const runningTool = toolCalls.find((c) => c.status === "running");
  const timeStr = totalThinkingMs > 0 ? `Thought for ${formatElapsed(totalThinkingMs)}` : "";

  if (isStreaming && !hasContent) {
    if (runningTool) {
      const doneCount = toolCalls.filter((c) => c.status === "done").length;
      return {
        text: `Running ${runningTool.name}… (${doneCount}/${toolCount} tools)`,
        isRunning: true,
      };
    }
    if (toolCount > 0) {
      return { text: `Running tools… (${toolCount} calls)`, isRunning: true };
    }
    return { text: "Thinking…", isRunning: true };
  }

  // Done or answer is streaming
  if (toolCount > 0) {
    if (errorCount > 0) {
      const toolStr = `${toolCount} tool${toolCount === 1 ? "" : "s"} (${errorCount} failed)`;
      return {
        text: timeStr ? `${toolStr} · ${timeStr}` : toolStr,
        isError: true,
      };
    }
    const toolStr = `${toolCount} tool${toolCount === 1 ? "" : "s"} used`;
    return {
      text: timeStr ? `${toolStr} · ${timeStr}` : toolStr,
    };
  }

  // Thinking only
  return {
    text: timeStr || "Thought process",
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

