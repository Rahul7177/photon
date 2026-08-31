import type { AppState } from "../state/store";

const MODE_LABELS: Record<string, string> = {
  chat: "Chat",
  plan: "Plan",
  agent: "Agent",
};

export function Hero({ state }: { state: AppState }) {
  const model = state.models.find((m) => m.name === state.selectedModel);
  const modeLabel = MODE_LABELS[state.mode] ?? state.mode;
  const engineLabel = state.config.interfaceMode === "cloud" ? "Cloud" : "Local";

  return (
    <div className="hero-wrapper">
      <div className="hero">
        {/* Photon brand mark */}
        <div className="hero-brand">
          <span className="hero-brand-icon" aria-hidden>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
              <defs>
                <radialGradient id="hero-core" cx="50%" cy="45%" r="55%">
                  <stop offset="0%" stopColor="#ffeab3" />
                  <stop offset="50%" stopColor="#ff8a2d" />
                  <stop offset="100%" stopColor="#ff2d2d" />
                </radialGradient>
              </defs>
              <circle cx="12" cy="12" r="3" fill="url(#hero-core)" />
              <ellipse cx="12" cy="12" rx="10" ry="4.5" stroke="var(--red)" strokeWidth="1.2" opacity="0.7" transform="rotate(30 12 12)" />
              <ellipse cx="12" cy="12" rx="10" ry="4.5" stroke="var(--orange)" strokeWidth="1.2" opacity="0.7" transform="rotate(-30 12 12)" />
            </svg>
          </span>
          <h1 className="hero-brand-title">PHOTON</h1>
          <p className="hero-tagline">Your local AI coding companion</p>
        </div>

        {/* Model + mode summary */}
        <div className="hero-info">
          <span className="hero-info-badge">{engineLabel}</span>
          <span className="hero-info-sep">·</span>
          <span className="hero-info-badge">{modeLabel}</span>
          {model && (
            <>
              <span className="hero-info-sep">·</span>
              <span className="hero-info-model">
                {(() => {
                  const display = model.name.includes(":") ? model.name.split(":").slice(1).join(":") : model.name;
                  return display;
                })()}
              </span>
              {model.contextLength && (
                <>
                  <span className="hero-info-sep">·</span>
                  <span className="hero-info-ctx">{model.contextLength.toLocaleString()} ctx</span>
                </>
              )}
            </>
          )}
        </div>

        {/* Quick action hints */}
        <div className="hero-hints">
          <div className="hero-hint">
            <span className="hero-hint-icon">💬</span>
            <span>Ask anything about your code</span>
          </div>
          <div className="hero-hint">
            <span className="hero-hint-icon">📝</span>
            <span>Describe what to plan or build</span>
          </div>
          <div className="hero-hint">
            <span className="hero-hint-icon">🤖</span>
            <span>Let the agent handle a task</span>
          </div>
        </div>
      </div>
    </div>
  );
}
