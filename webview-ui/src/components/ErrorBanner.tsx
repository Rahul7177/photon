export function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  const sanitized = sanitizeErrorMessage(message);
  const suggestion = getErrorSuggestion(message);

  return (
    <div className="banner error-banner" role="alert">
      <div className="error-content" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span className="error-text">{sanitized}</span>
        {suggestion && <span className="error-suggestion" style={{ fontSize: 11, opacity: 0.85 }}>💡 {suggestion}</span>}
      </div>
      <button className="banner-close" title="Dismiss error" aria-label="Dismiss error" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

export function sanitizeErrorMessage(msg: string): string {
  if (!msg) return "";
  let clean = msg;
  // Strip node stack traces: "   at ... (path:line:col)"
  clean = clean.replace(/\s+at\s+.*(?:\r?\n|$)/g, " ").trim();
  // Strip Bearer tokens
  clean = clean.replace(/Bearer\s+[A-Za-z0-9_\-\.]{6,}/gi, "Bearer [REDACTED]");
  // Strip raw API keys
  clean = clean.replace(/\b(?:sk-[a-zA-Z0-9_\-]{16,}|nvapi-[a-zA-Z0-9_\-]{16,}|AIza[a-zA-Z0-9_\-]{30,})\b/g, "[REDACTED]");
  return clean.slice(0, 300);
}

export function getErrorSuggestion(msg: string): string | null {
  const lower = (msg || "").toLowerCase();
  if (lower.includes("quota") || lower.includes("credit") || lower.includes("insufficient_quota")) {
    return "Check your provider account credit balance or billing plan.";
  }
  if (lower.includes("401") || lower.includes("api key") || lower.includes("authentication")) {
    return "Verify your API key in Settings → Cloud Providers.";
  }
  if (lower.includes("econnrefused") || lower.includes("11434") || (lower.includes("ollama") && lower.includes("reachable"))) {
    return "Ensure the local daemon is running (`ollama serve` or open Ollama app).";
  }
  if (lower.includes("disk full") || lower.includes("enospc") || lower.includes("no space")) {
    return "Free up disk space on your drive to allow downloading/writing.";
  }
  if (lower.includes("stalled") || lower.includes("timeout")) {
    return "Connection timed out. Retry the prompt or raise timeout in Settings.";
  }
  return null;
}
