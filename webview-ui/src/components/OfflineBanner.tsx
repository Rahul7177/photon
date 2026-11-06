import type { AppState, Actions } from "../state/store";
import { LocalProviderHub } from "./LocalProviderHub";

/**
 * Backward-compatible wrapper around LocalProviderHub.
 * @deprecated Use LocalProviderHub directly.
 */
export function OfflineBanner({
  onRetry,
  state,
  actions,
}: {
  onRetry?: () => void;
  state?: AppState;
  actions?: Actions;
}) {
  if (state && actions) {
    return <LocalProviderHub state={state} actions={actions} />;
  }

  return (
    <div className="banner">
      <strong>Can&apos;t reach Ollama.</strong> Make sure it&apos;s installed and running:
      <div style={{ marginTop: 6 }}>
        <code>ollama serve</code> &nbsp;then&nbsp; <code>ollama pull qwen2.5-coder</code>
      </div>
      <div className="approval-actions">
        <button className="btn primary" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}
