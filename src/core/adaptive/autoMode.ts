import type {
  AdaptivePlan,
  AutoDecision,
  BenchResult,
  ComplexityAssessment,
  MachineProfile,
  Mode,
  ModelInfo,
  ModelScore,
} from "../../shared/types";
import { buildPlan, type OrchestratorInput } from "./orchestrator";
import { classifyComplexity } from "./complexity";

// Ranking weights, kept as named, tunable constants (not magic numbers buried in
// logic) so they can be adjusted from telemetry later without touching the algorithm.
const WEIGHTS = {
  /** Meets the task's minimum context requirement — dominant, near-binary. */
  contextFit: 40,
  /** Extra headroom above the minimum, lightly rewarded. */
  contextHeadroom: 8,
  /** Measured generation speed on this machine (from Photon Bench). */
  throughput: 18,
  /** Measured structured-tool-call reliability (from Photon Bench). */
  toolReliability: 22,
  /** Capability tier vs. task difficulty match. */
  tierMatch: 20,
  /** Small efficiency bonus for not over-provisioning a simple task. */
  efficiency: 6,
  /** Nudge toward free/local models when scores are otherwise close. */
  localPreference: 4,
  /** Penalty for a model whose context can't hold the task. Large enough to
   *  matter, small enough that measured bench quality can still win — the old
   *  fits-first sort made ANY fitting model (e.g. a cloud model with a huge
   *  advertised window) beat every local model regardless of everything else. */
  contextMisfit: 24,
};

const TIER_RANK: Record<NonNullable<ModelInfo["tier"]>, number> = {
  tiny: 0,
  small: 1,
  medium: 2,
  large: 3,
};

/** Ideal tier per complexity level — the ranker rewards proximity to this. */
const IDEAL_TIER: Record<ComplexityAssessment["level"], number> = {
  simple: 1, // small is plenty
  moderate: 2, // medium
  complex: 3, // large
};

export interface AutoModeInput {
  prompt: string;
  mode: Mode;
  attachmentCount?: number;
  models: ModelInfo[];
  machine: MachineProfile | null;
  /** Photon Bench results keyed by model name (M7), used to rank on real data. */
  benchByModel?: Map<string, BenchResult>;
  /** A model the user pinned for this project — always wins if it still exists. */
  pinnedModel?: string;
}

/**
 * Rank the available models for a given task. Pure and transparent: each score
 * carries `reasons` so the UI can explain the ranking. Uses measured benchmark
 * data when present, and falls back to static tier/param heuristics otherwise.
 */
export function rankModels(
  models: ModelInfo[],
  complexity: ComplexityAssessment,
  benchByModel?: Map<string, BenchResult>
): ModelScore[] {
  const throughputs = [...(benchByModel?.values() ?? [])].map((b) => b.tokensPerSec);
  const maxTps = throughputs.length ? Math.max(...throughputs, 1) : 0;

  const scored = models.map((m): ModelScore => {
    const reasons: string[] = [];
    let score = 0;

    const ctx = m.contextLength ?? 8192;
    const fits = ctx >= complexity.minContextTokens;
    if (fits) {
      score += WEIGHTS.contextFit;
      const headroom = Math.min(1, (ctx - complexity.minContextTokens) / complexity.minContextTokens);
      score += headroom * WEIGHTS.contextHeadroom;
      reasons.push(`context ${ctx.toLocaleString()} ≥ needed ${complexity.minContextTokens.toLocaleString()}`);
    } else {
      score -= WEIGHTS.contextMisfit;
      reasons.push(`context ${ctx.toLocaleString()} < needed ${complexity.minContextTokens.toLocaleString()}`);
    }

    // Local models are free, private, and always warm on this machine — a
    // small tiebreaker toward them keeps Auto Mode from drifting cloudward.
    if (m.provider === "ollama") {
      score += WEIGHTS.localPreference;
      reasons.push("local model");
    }

    // Tier match: reward proximity to the ideal tier for this complexity.
    const tier = TIER_RANK[m.tier ?? "small"];
    const ideal = IDEAL_TIER[complexity.level];
    const tierMatch = 1 - Math.min(1, Math.abs(tier - ideal) / 3);
    score += tierMatch * WEIGHTS.tierMatch;
    // For simple tasks, a smaller model that still fits is a plus (fast + frugal).
    if (complexity.level === "simple" && tier <= ideal) score += WEIGHTS.efficiency;

    // Measured signals from Photon Bench, if we have them.
    const bench = benchByModel?.get(m.name);
    if (bench) {
      if (maxTps > 0) {
        const tps = bench.tokensPerSec / maxTps;
        score += tps * WEIGHTS.throughput;
        reasons.push(`${Math.round(bench.tokensPerSec)} tok/s`);
      }
      score += bench.toolCallReliability * WEIGHTS.toolReliability;
      reasons.push(`${Math.round(bench.toolCallReliability * 100)}% tool-call reliability`);
    } else {
      // No bench yet: assume tool-trained models are more reliable at tool calls.
      const assumed = m.toolTrained ? 0.6 : 0.35;
      score += assumed * WEIGHTS.toolReliability;
      reasons.push(m.toolTrained ? "tool-trained (assumed reliable)" : "not tool-trained (assumed weaker)");
    }

    return { model: m.name, score: Math.round(score * 100) / 100, fits, reasons };
  });

  // Pure score order — fit is already priced into each score via the
  // contextFit bonus / misfit penalty above.
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Choose a model for the request and return a fully explainable decision. A
 * pinned model always wins (but is still ranked, so the panel can show why the
 * alternatives were passed over).
 */
export function decideModel(input: AutoModeInput): AutoDecision {
  const complexity = classifyComplexity({
    prompt: input.prompt,
    attachmentCount: input.attachmentCount,
    mode: input.mode,
  });
  const scores = rankModels(input.models, complexity, input.benchByModel);

  const pinnedExists =
    !!input.pinnedModel && input.models.some((m) => m.name === input.pinnedModel);

  if (pinnedExists) {
    return {
      chosenModel: input.pinnedModel!,
      auto: false,
      pinned: true,
      complexity,
      scores,
      reason: `Pinned to ${input.pinnedModel} for this project.`,
    };
  }

  const best = scores[0];
  if (!best) {
    return {
      chosenModel: "",
      auto: true,
      pinned: false,
      complexity,
      scores,
      reason: "No models available.",
    };
  }

  const reason = best.fits
    ? `Auto-selected ${best.model} for a ${complexity.level} task — ${best.reasons.slice(0, 2).join(", ")}.`
    : `No model fully fits a ${complexity.level} task; using the closest, ${best.model}. Context may be tight.`;

  return { chosenModel: best.model, auto: true, pinned: false, complexity, scores, reason };
}

export interface PlanRequest extends AutoModeInput {
  intelligence: OrchestratorInput["intelligence"];
  reserveOutputTokens: number;
  adaptiveEnabled: boolean;
  userNumCtx?: number;
}

/**
 * The engine's top-level entry (Module 6/8): given a prompt, the available
 * models, and the machine, decide which model to use and produce the concrete
 * ExecutionPlan (`AdaptivePlan`) for it. Returns both so the host can act on the
 * plan and surface the decision in the transparency panel.
 */
export function planRequest(input: PlanRequest): { decision: AutoDecision; plan: AdaptivePlan | null } {
  const decision = decideModel(input);
  const model = input.models.find((m) => m.name === decision.chosenModel);
  if (!model) return { decision, plan: null };

  const plan = buildPlan({
    model,
    machine: input.machine,
    mode: input.mode,
    userNumCtx: input.userNumCtx,
    intelligence: input.intelligence,
    reserveOutputTokens: input.reserveOutputTokens,
    adaptiveEnabled: input.adaptiveEnabled,
  });
  return { decision, plan };
}
