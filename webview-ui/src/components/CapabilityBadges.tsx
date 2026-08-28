import type { ModelInfo } from "../../../src/shared/types";

export function CapabilityBadges({ model, compact }: { model: ModelInfo | undefined; compact?: boolean }) {
  if (!model) return null;
  const badges: { key: string; label: string; icon: string; short: string; title: string; active: boolean }[] = [
    {
      key: "tools",
      label: "Tools",
      icon: "◈",
      short: "tools",
      title: model.toolTrained ? "Native tool calling" : "Block-protocol tools (works for every model)",
      active: true,
    },
    {
      key: "vision",
      label: "Vision",
      icon: "◉",
      short: "vision",
      title: model.vision ? "Image input (vision)" : "No image input",
      active: !!model.vision,
    },
    {
      key: "audio",
      label: "Audio",
      icon: "♫",
      short: "audio",
      title: model.audio ? "Audio input" : "No audio input",
      active: !!model.audio,
    },
    {
      key: "video",
      label: "Video",
      icon: "▶",
      short: "video",
      title: model.video ? "Video input" : "No video input",
      active: !!model.video,
    },
    {
      key: "thinking",
      label: "Thinking",
      icon: "✦",
      short: "think",
      title: model.thinking ? "Extended thinking / reasoning" : "No extended reasoning",
      active: !!model.thinking,
    },
  ];

  if (compact) {
    // Only show active caps, very small
    const active = badges.filter((b) => b.active);
    if (!active.length) return null;
    return (
      <span className="cap-badges compact" title={active.map((b) => b.label).join(" · ")}>
        {active.map((b) => (
          <span key={b.key} className={`cap-badge on cap-${b.key}`} title={b.title}>
            {b.icon}
          </span>
        ))}
      </span>
    );
  }

  return (
    <span className="cap-badges">
      {badges.map((b) => (
        <span
          key={b.key}
          className={`cap-badge ${b.active ? "on" : "off"} cap-${b.key}`}
          title={b.title}
        >
          <span className="cap-icon">{b.icon}</span>
          <span className="cap-label">{b.short}</span>
        </span>
      ))}
      {model.contextLength ? (
        <span className="cap-badge on cap-ctx" title={`${model.contextLength.toLocaleString()} token context`}>
          {Math.round(model.contextLength / 1000)}k ctx
        </span>
      ) : null}
    </span>
  );
}

export function capabilitySummary(model: ModelInfo | undefined): string {
  if (!model) return "";
  const parts: string[] = [];
  if (model.toolTrained) parts.push("tools");
  if (model.vision) parts.push("vision");
  if (model.audio) parts.push("audio");
  if (model.video) parts.push("video");
  if (model.thinking) parts.push("thinking");
  if (model.contextLength) parts.push(`${Math.round(model.contextLength / 1000)}k ctx`);
  return parts.join(" · ") || "base";
}
