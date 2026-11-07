import type { AppState } from "../state/store";

/** Minimal, elegant inline thinking indicator styled like Claude Code. */
export function ClaudeThinkingIndicator({ label = "Thinking..." }: { label?: string }) {
  return (
    <div className="claude-status-line" role="status" aria-live="polite">
      <span className="claude-status-dot" aria-hidden="true" />
      <span className="claude-status-text">{label}</span>
    </div>
  );
}

export function getClaudeThinkingLabel(
  detail?: string | null,
  status?: string,
  streaming?: boolean,
  hasThinking?: boolean
): string {
  if (detail) {
    const d = detail.toLowerCase();
    if (d.includes("select") || d.includes("plan") || d.includes("routing")) return "Understanding request...";
    if (d.includes("retriev") || d.includes("context") || d.includes("read") || d.includes("analyz")) return "Understanding request...";
    if (d.includes("generat") || d.includes("respond")) return "Generating response...";
    if (d.includes("think") || d.includes("reason")) return "Thinking...";
    if (d.includes("tool") || d.includes("run") || d.includes("verif")) return "Working...";
    return `${detail.replace(/\.+$/, "")}...`;
  }
  if (hasThinking) return "Thinking...";
  if (streaming) return "Generating response...";
  if (status === "running") return "Working...";
  return "Thinking...";
}

/** A small live "Photon is working" line derived from current runtime state. */
export function StatusIndicator({ state }: { state: AppState }) {
  const info = computeStatusInfo(state);
  if (!info) return null;
  return (
    <div
      className={`status-line status-${info.kind}`}
      role="status"
      aria-live="polite"
      aria-label={`Agent status: ${info.label}`}
    >
      {info.kind === "approval" ? (
        <span className="status-badge-approval" aria-hidden="true">
          !
        </span>
      ) : (
        <span className="status-spinner" aria-hidden="true" />
      )}
      <span className="status-stage-pill">{info.stage}</span>
      <span className="status-label">{info.label}</span>
      {info.kind !== "approval" && (
        <span className="status-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      )}
    </div>
  );
}

export interface StatusDisplayInfo {
  kind: "thinking" | "tool" | "verifying" | "approval" | "compacting";
  stage: string;
  label: string;
}

export function computeStatusInfo(state: AppState): StatusDisplayInfo | null {
  if (state.pendingApproval) {
    return {
      kind: "approval",
      stage: "Awaiting Approval",
      label: `Waiting for approval to run ${state.pendingApproval.name}`,
    };
  }

  if (state.isCompacting || /compact/i.test(state.statusDetail || "")) {
    return {
      kind: "compacting",
      stage: "Context",
      label: "Compacting context window",
    };
  }

  // A tool actively running wins — name it and distinguish verification from general tool execution.
  const messages = state.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const running = messages[i].toolCalls?.find((c) => c.status === "running");
    if (running) {
      if (running.name === "get_diagnostics") {
        return {
          kind: "verifying",
          stage: "Verifying",
          label: "Checking workspace diagnostics",
        };
      }
      return {
        kind: "tool",
        stage: "Tool",
        label: `Running ${running.name}`,
      };
    }
  }

  const detail = state.statusDetail?.replace(/\.+$/, "").trim();

  if (state.status === "running") {
    if (!detail) {
      return { kind: "tool", stage: "Working", label: "Executing step" };
    }
    if (/^verifying/i.test(detail)) {
      return { kind: "verifying", stage: "Verifying", label: detail };
    }
    if (/^waiting for approval/i.test(detail)) {
      return { kind: "approval", stage: "Awaiting Approval", label: detail };
    }
    if (/^(queued|waiting|selecting|retrieving|compacting|generating|thinking|working)/i.test(detail)) {
      return { kind: "tool", stage: "Working", label: detail };
    }
    return { kind: "tool", stage: "Tool", label: `Running ${detail}` };
  }

  const last = messages[messages.length - 1];
  const streaming = last?.role === "assistant" && last.streaming;
  if (streaming) {
    if (last.content.trim()) {
      return { kind: "thinking", stage: "Responding", label: "Generating response" };
    }
    if (detail) {
      return {
        kind: "thinking",
        stage: resolveThinkingStage(detail),
        label: detail,
      };
    }
    return { kind: "thinking", stage: "Thinking", label: "Understanding request & reasoning" };
  }

  if (state.status === "thinking") {
    if (detail) {
      return {
        kind: "thinking",
        stage: resolveThinkingStage(detail),
        label: detail,
      };
    }
    return { kind: "thinking", stage: "Thinking", label: "Understanding request" };
  }

  return null;
}

function resolveThinkingStage(detail: string): string {
  if (/selecting model/i.test(detail)) return "Routing";
  if (/retrieving.*context/i.test(detail)) return "Context";
  if (/waiting for/i.test(detail)) return "Provider";
  if (/verifying/i.test(detail)) return "Verifying";
  return "Thinking";
}
