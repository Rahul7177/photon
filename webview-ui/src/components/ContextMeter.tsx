import type { AdaptivePlan, GenerationStats, ModelInfo, TokenUsage } from "../../../src/shared/types";
import { CapabilityBadges } from "./CapabilityBadges";

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

  return (
    <div className="context-meter">
      <div className="meter-label">
        <span className="meter-tokens">
          {used.toLocaleString()} / {window.toLocaleString()} tokens
        </span>
        {compactBadgesModel && <CapabilityBadges model={compactBadgesModel} compact />}
        {live && (
          <span className="meter-tps live" title={`${stats.totalTokens} tokens in ${(stats.elapsedMs / 1000).toFixed(1)}s`}>
            ⚡ {stats.tps} tok/s
            <span className="meter-tps-detail"> · {stats.totalTokens} tok</span>
          </span>
        )}
        {plan && (
          <span className="plan-chip" title={(plan.rationale ?? []).join("\n")}>
            {plan.intelligence}
            {plan.intelligenceAuto ? " (auto)" : ""} ·{" "}
            {plan.toolProtocol === "native" ? "native tools" : "block tools"} ·{" "}
            {plan.numCtx.toLocaleString()} ctx
          </span>
        )}
      </div>
      <div className="meter-bar">
        <div className={`meter-fill ${warn ? "warn" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
