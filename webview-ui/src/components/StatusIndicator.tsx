import type { AppState } from "../state/store";

/** A small live "Photon is working" line derived from current state. */
export function StatusIndicator({ state }: { state: AppState }) {
  const label = computeLabel(state);
  if (!label) return null;
  return (
    <div className="status-line" role="status" aria-live="polite">
      <span className="status-spinner" />
      <span className="status-label">{label}</span>
      <span className="status-dots">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function computeLabel(state: AppState): string | null {
  if (state.pendingApproval) return null; // approval UI takes over

  // A tool actively running wins — name it so the user knows what's happening.
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const running = state.messages[i].toolCalls?.find((c) => c.status === "running");
    if (running) return `Running ${running.name}`;
  }

  // Host-reported phase (set by the engine each generation / tool step).
  if (state.status === "running") {
    return state.statusDetail ? `Running ${state.statusDetail}` : "Working";
  }

  const last = state.messages[state.messages.length - 1];
  const streaming = last?.role === "assistant" && last.streaming;
  if (streaming) return last.content.trim() ? "Generating" : "Thinking";
  if (state.status === "thinking") return "Thinking";
  return null;
}
