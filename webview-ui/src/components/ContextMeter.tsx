import type { AdaptivePlan, GenerationStats, ModelInfo, TokenUsage } from "../../../src/shared/types";
import { CapabilityBadges } from "./CapabilityBadges";

/** Format a token count for display, e.g. 1200 → "1.2k". */
function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

export function ContextMeter({
  usage,
  plan,
  stats,
  compactBadgesModel,
}: {
  usage: TokenUsage | null;
  plan: AdaptivePlan | null;
  stats?: GenerationStats | null;
  compactBadgesModel?: ModelInfo;
}) {
  const effectiveBudget = plan ? Math.max(2048, plan.numCtx - (plan.maxOutputTokens ?? 1024)) : 0;
  const window = usage?.window ?? effectiveBudget ?? plan?.numCtx ?? 0;
  const used = usage?.used ?? 0;
  const pct = window > 0 ? Math.min(100, (used / window) * 100) : 0;
  const warn = pct > 80;
  const live = stats && stats.tps > 0;

  // Phase 1.2: Build a rich breakdown tooltip from TokenUsage.breakdown
  const breakdown = usage?.breakdown ?? [];
  const breakdownTooltip = breakdown.length
    ? breakdown.map((b) => `${b.label}: ${fmtTokens(b.tokens)}`).join("\n") +
      `\n─────────────` +
      `\nUsed: ${fmtTokens(used)} / ${fmtTokens(window)} (${pct.toFixed(0)}%)`
    : `${used.toLocaleString()} / ${window.toLocaleString()} tokens`;

  return (
    <div className="context-meter">
      <div className="meter-label">
        <span className="meter-tokens" title={breakdownTooltip}>
          {fmtTokens(used)} / {fmtTokens(window)}
        </span>
        {compactBadgesModel && <CapabilityBadges model={compactBadgesModel} compact />}
        {live && (
          <span className="meter-tps" title={`${stats.totalTokens} tokens in ${(stats.elapsedMs / 1000).toFixed(1)}s`}>
            {stats.tps} tok/s
          </span>
        )}
        {plan && (
          <span className="plan-chip" title={(plan.rationale ?? []).join("\n")}>
            {plan.intelligence}
            {plan.intelligenceAuto ? " (auto)" : ""} ·{" "}
            {plan.toolProtocol === "native" ? "native" : "block"} ·{" "}
            {fmtTokens(plan.numCtx)} ctx
          </span>
        )}
      </div>
      <div className="meter-bar">
        <div className={`meter-fill ${warn ? "warn" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
