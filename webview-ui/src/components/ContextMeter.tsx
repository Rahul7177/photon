import type { AdaptivePlan, GenerationStats, OllamaRuntimeModel, TokenUsage } from "../../../src/shared/types";
import { ChartIcon, ContextGaugeIcon, BoltIcon } from "./Icons";

/** Format a token count for display, e.g. 1200 → "1.2k". */
export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

export function computeContextMetrics(
  usage: TokenUsage | null,
  plan: AdaptivePlan | null
): { used: number; window: number; pct: number; warn: boolean; tooltip: string } {
  const effectiveBudget = plan ? Math.max(2048, plan.numCtx - (plan.maxOutputTokens ?? 1024)) : 0;
  const window = usage?.window ?? plan?.numCtx ?? effectiveBudget ?? 0;
  const used = usage?.used ?? 0;
  const pct = window > 0 ? Math.min(100, (used / window) * 100) : 0;
  const warn = pct > 80;
  const breakdown = usage?.breakdown ?? [];
  const tooltip = breakdown.length
    ? breakdown.map((b) => `${b.label}: ${fmtTokens(b.tokens)}`).join("\n") +
      `\n─────────────` +
      `\nContext: ${fmtTokens(used)} / ${fmtTokens(window)} (${pct.toFixed(0)}%)`
    : `Context window: ${fmtTokens(used)} / ${fmtTokens(window)} tokens (${pct.toFixed(0)}%)`;

  return { used, window, pct, warn, tooltip };
}

export function ContextIconTrigger({
  usage,
  plan,
  active,
  onClick,
}: {
  usage: TokenUsage | null;
  plan: AdaptivePlan | null;
  active: boolean;
  onClick: () => void;
}) {
  const { used, window, pct, warn, tooltip } = computeContextMetrics(usage, plan);

  return (
    <button
      type="button"
      className={`ctx-icon-trigger${active ? " active" : ""}${warn ? " warn" : ""}`}
      onClick={onClick}
      title={`${tooltip}\nClick to tune context & runtime`}
      aria-label={`Context window ${fmtTokens(used)} of ${fmtTokens(window)} tokens`}
      aria-expanded={active}
    >
      <ContextGaugeIcon pct={pct} />
    </button>
  );
}

export function ContextMeter({
  usage,
  plan,
  stats,
  ollamaRuntime,
  onOpenHardwareModal,
  onCompact,
}: {
  usage: TokenUsage | null;
  plan: AdaptivePlan | null;
  stats?: GenerationStats | null;
  ollamaRuntime?: OllamaRuntimeModel[];
  onOpenHardwareModal?: () => void;
  onCompact?: () => void;
}) {
  const { used, window, pct, warn, tooltip } = computeContextMetrics(usage, plan);
  const live = stats && stats.tps > 0;
  const hasLoadedModel = (ollamaRuntime ?? []).length > 0;

  return (
    <div className="context-meter-popover-section">
      <div className="meter-label">
        <span className="meter-tokens" title={tooltip}>
          <span className="meter-tokens-used">{fmtTokens(used)}</span>
          <span className="meter-tokens-sep">/</span>
          <span>{fmtTokens(window)}</span>
          <span className="meter-tokens-pct">({pct.toFixed(0)}%)</span>
        </span>
        {live && (
          <span
            className="meter-tps"
            title={`${stats.totalTokens} tokens in ${(stats.elapsedMs / 1000).toFixed(1)}s`}
          >
            {stats.tps} tok/s
          </span>
        )}
        <div className="meter-actions-group">
          {onCompact && (
            <button
              type="button"
              className={`ctx-compact-btn ${warn ? "highlight" : ""}`}
              onClick={onCompact}
              title="Compact context window now (preserves anchor, key decisions, and modified files)"
            >
              <BoltIcon />
              <span>Compact</span>
            </button>
          )}
          {onOpenHardwareModal && (
            <button
              type="button"
              className={`hw-chart-btn ${hasLoadedModel ? "loaded" : ""}`}
              onClick={onOpenHardwareModal}
              title="Open live hardware & token telemetry"
            >
              <ChartIcon />
              <span>Telemetry</span>
              {hasLoadedModel && <span className="hw-chart-dot" />}
            </button>
          )}
        </div>
      </div>
      <div className="meter-bar" title={tooltip}>
        <div className={`meter-fill ${warn ? "warn" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
