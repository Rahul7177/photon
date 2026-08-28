export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="banner">
      <strong>Can't reach Ollama.</strong> Make sure it's installed and running:
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
