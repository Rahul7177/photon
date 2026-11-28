import type { EvalTaskResult } from "./harness";
import { runBaselineEval } from "./runner";

export interface TierBaseline {
  minPassRatePct: number;
  phase0AgentToolsTokens: number;
}

export interface ReleaseGateCheck {
  tier: string;
  tasksTotal: number;
  tasksPassed: number;
  passRatePct: number;
  minAllowedPassRatePct: number;
  avgAgentToolsTokens: number;
  maxAllowedToolsTokens: number;
  totalIssues: number;
  passed: boolean;
  reasons: string[];
}

export interface ReleaseGateResult {
  passed: boolean;
  checks: ReleaseGateCheck[];
  summary: string;
}

export const LOCKED_TIER_BASELINES: Record<string, TierBaseline> = {
  tiny: { minPassRatePct: 100, phase0AgentToolsTokens: 2737 },
  small: { minPassRatePct: 100, phase0AgentToolsTokens: 2737 },
  medium: { minPassRatePct: 100, phase0AgentToolsTokens: 2716 },
};

/**
 * CI Release Gate (Phase 4): ensures no model tier regresses by more than
 * `maxPassRateRegressionPct` (default 2 points), records zero governor issues on
 * compliant runs, and preserves >= 50% tool-card token savings vs Phase 0.
 */
export function evaluateReleaseGate(
  results: EvalTaskResult[],
  options?: {
    maxPassRateRegressionPct?: number;
    maxToolsTokenRatioVsPhase0?: number;
  }
): ReleaseGateResult {
  const maxRegression = options?.maxPassRateRegressionPct ?? 2;
  const maxToolsRatio = options?.maxToolsTokenRatioVsPhase0 ?? 0.5;
  const byTier = new Map<string, EvalTaskResult[]>();

  for (const r of results) {
    const arr = byTier.get(r.tier) ?? [];
    arr.push(r);
    byTier.set(r.tier, arr);
  }

  const checks: ReleaseGateCheck[] = [];
  for (const [tier, list] of byTier.entries()) {
    const baseline = LOCKED_TIER_BASELINES[tier] ?? { minPassRatePct: 100, phase0AgentToolsTokens: 2737 };
    const passedCount = list.filter((r) => r.passed).length;
    const passRatePct = Math.round((passedCount / Math.max(1, list.length)) * 1000) / 10;
    const minAllowedPassRatePct = Math.max(0, baseline.minPassRatePct - maxRegression);

    const agentTasks = list.filter((r) => r.mode === "agent");
    const avgAgentToolsTokens =
      agentTasks.length > 0
        ? Math.round(
            agentTasks.reduce(
              (s, r) => s + (r.promptSections.find((sec) => sec.id === "tools")?.tokens ?? 0),
              0
            ) / agentTasks.length
          )
        : 0;
    const maxAllowedToolsTokens = Math.floor(baseline.phase0AgentToolsTokens * maxToolsRatio);
    const totalIssues = list.reduce((s, r) => s + r.totalIssues, 0);

    const reasons: string[] = [];
    if (passRatePct < minAllowedPassRatePct) {
      reasons.push(`pass rate ${passRatePct}% < floor ${minAllowedPassRatePct}%`);
    }
    if (totalIssues > 0) {
      reasons.push(`recorded ${totalIssues} governor issue(s) on compliant suite`);
    }
    if (agentTasks.length > 0 && avgAgentToolsTokens > maxAllowedToolsTokens) {
      reasons.push(`agent tools tokens ${avgAgentToolsTokens} > budget ${maxAllowedToolsTokens}`);
    }

    checks.push({
      tier,
      tasksTotal: list.length,
      tasksPassed: passedCount,
      passRatePct,
      minAllowedPassRatePct,
      avgAgentToolsTokens,
      maxAllowedToolsTokens,
      totalIssues,
      passed: reasons.length === 0,
      reasons,
    });
  }

  const allPassed = checks.length > 0 && checks.every((c) => c.passed);
  const summary = checks
    .map(
      (c) =>
        `${c.tier}: ${c.tasksPassed}/${c.tasksTotal} (${c.passRatePct}% >= ${c.minAllowedPassRatePct}%), tools=${c.avgAgentToolsTokens}<=${c.maxAllowedToolsTokens} tok -> ${c.passed ? "PASS" : `FAIL (${c.reasons.join("; ")})`}`
    )
    .join("\n");

  return { passed: allPassed, checks, summary };
}

async function main() {
  const results = await runBaselineEval({ writeReport: false });
  const gate = evaluateReleaseGate(results);
  console.log("Photon Phase 4 Release Gate:\n" + gate.summary);
  if (!gate.passed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[eval:gate] failed:", err);
    process.exitCode = 1;
  });
}
