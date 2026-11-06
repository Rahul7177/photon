import type { AppState, Actions } from "../state/store";
import { BrainIcon, CodeIcon, PhotonLogoIcon, SparkleIcon } from "./Icons";

const SUGGESTIONS = [
  { text: "Explain project architecture & key files", icon: <BrainIcon /> },
  { text: "Find potential bugs and edge cases", icon: <SparkleIcon /> },
  { text: "Help me refactor and optimize code", icon: <CodeIcon size={13} /> },
];

export function Hero({
  actions,
}: {
  state?: AppState;
  actions?: Actions;
  onOpenSettings?: (tab?: "general" | "tools" | "models" | "providers" | "advanced") => void;
  onOpenHardwareModal?: () => void;
}) {
  return (
    <div className="hero-wrapper">
      {/* Moving blurred gradient background (Photon website triad: #FF2D2D, #FF6B2D, #FFC02E) */}
      <div className="hero-aurora-bg" aria-hidden="true">
        <div className="aurora-blob aurora-blob-1" />
        <div className="aurora-blob aurora-blob-2" />
        <div className="aurora-blob aurora-blob-3" />
        <div className="aurora-blob aurora-blob-4" />
      </div>

      {/* Matte vignette finish */}
      <div className="hero-matte-overlay" aria-hidden="true" />

      {/* Foreground Branding */}
      <div className="hero">
        <div className="hero-emblem" aria-hidden="true">
          <PhotonLogoIcon size={38} />
        </div>
        <h1 className="hero-brand-title">Photon</h1>

        {/* Minimal Gemini-style prompt suggestions */}
        <div className="hero-suggestions">
          {SUGGESTIONS.map((s, idx) => (
            <button
              key={idx}
              type="button"
              className="hero-suggestion-item"
              onClick={() => actions?.send(s.text)}
            >
              <span className="hero-suggestion-icon">{s.icon}</span>
              <span className="hero-suggestion-text">{s.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
