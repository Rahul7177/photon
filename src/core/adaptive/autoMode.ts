import {
  isLocalModel,
  type AdaptivePlan,
  type AutoDecision,
  type BenchResult,
  type ComplexityAssessment,
  type MachineProfile,
  type Mode,
  type ModelInfo,
  type ModelScore,
  type RoutingSignalBreakdown,
} from "../../shared/types";
import { capabilityForModel, analyzeTask, toComplexity } from "../intelligence/policy";
import { buildPlan, type OrchestratorInput } from "./orchestrator";
import { estimateTokens } from "./tokens";
import { getModelPricing } from "../telemetry/cloudUsage";

const WEIGHTS = {
  contextFit: 30,
  contextHeadroom: 6,
  throughput: 12,
  toolCalling: 18,
  reasoning: 12,
  coding: 14,
  recovery: 10,
  verification: 8,
  tierMatch: 8,
  localPreference: 3,
};

export interface AutoModeInput {
  prompt: string;
  mode: Mode;
  attachmentCount?: number;
  models: ModelInfo[];
  machine: MachineProfile | null;
  benchByModel?: Map<string, BenchResult>;
  pinnedModel?: string;
  previousModel?: string;
}

function classifyHardwareFit(
  m: ModelInfo,
  machine: MachineProfile | null | undefined
): RoutingSignalBreakdown["hardwareFit"] {
  if (!isLocalModel(m)) return "cloud";
  if (!machine) return "hybrid";
  const paramsB = m.paramsB ?? (m.tier === "tiny" ? 3 : m.tier === "small" ? 7 : m.tier === "medium" ? 14 : 30);
  const weightGb = m.sizeBytes && m.sizeBytes > 0 ? m.sizeBytes / 1024 ** 3 : paramsB * 0.65;
  const vramGb = (machine.gpu?.vramBytes ?? 0) / 1024 ** 3;
  const safeRamGb = (machine.totalRamBytes * 0.775) / 1024 ** 3;
  if (vramGb > 0 && weightGb + 1.0 <= vramGb) return "gpu";
  if (weightGb + 1.5 <= vramGb + safeRamGb) return vramGb > 0 ? "hybrid" : "cpu";
  return "tight";
}

export function rankModels(
  models: ModelInfo[],
  complexity: ComplexityAssessment,
  benchByModel?: Map<string, BenchResult>,
  machine?: MachineProfile | null
): ModelScore[] {
  const task = complexity.task ?? analyzeTask("", "agent");
  const tpsValues = [...(benchByModel?.values() ?? [])].map((b) => b.tokensPerSec).filter((v) => v > 0);
  const maxTps = Math.max(...tpsValues, 1);
  const idealReasoning = task.reasoning === "high" ? 0.85 : task.reasoning === "medium" ? 0.65 : 0.45;
  const idealTool = task.scope === "single_file" && task.verification.length === 0 ? 0.55 : 0.75;

  return models
    .map((m) => {
      const bench = benchByModel?.get(m.name);
      const caps = capabilityForModel(m, bench);
      const ctx = m.contextLength ?? 8192;
      const fits = ctx >= complexity.minContextTokens;
      const local = isLocalModel(m);
      const hwFit = classifyHardwareFit(m, machine);
      const pricing = local ? { inputPerMillion: 0, outputPerMillion: 0 } : getModelPricing(m.name);
      const estimatedCostPer1MUsd = pricing.inputPerMillion ?? 0;

      let score = 0;
      const reasons: string[] = [];

      // 1. Task complexity signal
      reasons.push(`complexity:${complexity.level}`);

      // 2. Context fit signal
      if (fits) {
        score += WEIGHTS.contextFit;
        score +=
          Math.min(1, (ctx - complexity.minContextTokens) / Math.max(1, complexity.minContextTokens)) *
          WEIGHTS.contextHeadroom;
        reasons.push(`context ${ctx.toLocaleString()} fits`);
      } else {
        reasons.push(`context ${ctx.toLocaleString()} is tight`);
        score -= WEIGHTS.contextFit * 0.75;
      }

      // 3. Tool reliability, coding & reasoning signals
      score += caps.toolCalling * WEIGHTS.toolCalling;
      score += caps.coding * WEIGHTS.coding;
      score += caps.recovery * WEIGHTS.recovery;
      score += caps.verification * WEIGHTS.verification;
      score += Math.max(0, 1 - Math.abs(caps.reasoning - idealReasoning)) * WEIGHTS.reasoning;
      score += Math.max(0, 1 - Math.abs(caps.toolCalling - idealTool)) * WEIGHTS.tierMatch;
      reasons.push(`tool ${Math.round(caps.toolCalling * 100)}%`);
      reasons.push(`coding ${Math.round(caps.coding * 100)}%`);
      if (task.reasoning !== "low") {
        reasons.push(`reasoning ${Math.round(caps.reasoning * 100)}%`);
      }

      // 4. Hardware & throughput signals
      if (bench && maxTps > 0) {
        score += (bench.tokensPerSec / maxTps) * WEIGHTS.throughput;
        reasons.push(`${Math.round(bench.tokensPerSec)} tok/s`);
      }
      if (hwFit === "tight") {
        score -= 8;
        reasons.push("hw:tight");
      } else {
        reasons.push(`hw:${hwFit}`);
      }

      // 5. Cost & local/cloud signal
      if (local) {
        score += WEIGHTS.localPreference;
        reasons.push("local ($0)");
      } else {
        reasons.push(`cloud ($${estimatedCostPer1MUsd.toFixed(2)}/1M)`);
      }
      if (bench?.capabilityProfile) reasons.push("bench-profiled");

      const signals: RoutingSignalBreakdown = {
        taskComplexity: complexity.level,
        contextFit: fits,
        toolReliability: Math.round(caps.toolCalling * 100) / 100,
        hardwareFit: hwFit,
        estimatedCostPer1MUsd,
        isCloud: !local,
      };

      return {
        model: m.name,
        score: Math.round(score * 100) / 100,
        fits,
        reasons,
        signals,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function decideModel(input: AutoModeInput): AutoDecision {
  const promptTokens = estimateTokens(input.prompt ?? "");
  const task = analyzeTask(input.prompt, input.mode, input.attachmentCount ?? 0);
  const complexity = toComplexity(task, promptTokens);
  const scores = rankModels(input.models, complexity, input.benchByModel, input.machine);
  const hasLocalModels = input.models.some((m) => isLocalModel(m));

  const pinnedExists = !!input.pinnedModel && input.models.some((m) => m.name === input.pinnedModel);
  if (pinnedExists) {
    const pinnedScore = scores.find((s) => s.model === input.pinnedModel);
    const fallbacks = scores
      .filter((s) => s.model !== input.pinnedModel && s.fits)
      .map((s) => s.model);
    const isCloud = Boolean(pinnedScore?.signals?.isCloud);
    const modelChanged = Boolean(input.previousModel && input.previousModel !== input.pinnedModel);
    return {
      chosenModel: input.pinnedModel!,
      auto: false,
      pinned: true,
      complexity,
      scores,
      signals: pinnedScore?.signals,
      fallbackModels: fallbacks,
      cloudEscalated: false,
      previousModel: input.previousModel,
      escalationNotice: modelChanged
        ? `Model switched: ${input.previousModel} → ${input.pinnedModel} (pinned${isCloud ? ", cloud" : ""}).`
        : undefined,
      reason: `Pinned to ${input.pinnedModel}.`,
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
      fallbackModels: [],
      cloudEscalated: false,
      previousModel: input.previousModel,
      reason: "No models available.",
    };
  }

  const fallbacks = scores
    .slice(1)
    .filter((s) => s.fits)
    .map((s) => s.model);

  const cloudEscalated = Boolean(best.signals?.isCloud && hasLocalModels);
  const modelChanged = Boolean(input.previousModel && input.previousModel !== best.model);

  let escalationNotice: string | undefined;
  if (cloudEscalated) {
    escalationNotice = `Cloud escalation: routed to ${best.model} ($${(best.signals?.estimatedCostPer1MUsd ?? 0).toFixed(2)}/1M input tokens) for ${complexity.level} ${task.scope} task.`;
  } else if (modelChanged) {
    escalationNotice = `Auto-routed model change: ${input.previousModel} → ${best.model} (${complexity.level} task).`;
  }

  return {
    chosenModel: best.model,
    auto: true,
    pinned: false,
    complexity,
    scores,
    signals: best.signals,
    fallbackModels: fallbacks,
    cloudEscalated,
    previousModel: input.previousModel,
    escalationNotice,
    reason: `${best.model} selected for ${task.scope}/${task.reasoning} work; ${best.reasons.slice(0, 4).join(", ")}.`,
  };
}

/**
 * Controlled fallback selector when the primary chosen model fails at runtime.
 * Never silently escalates to a cloud model unless `allowCloudEscalation` is true,
 * and always returns an explicit user-facing notice explaining the model change.
 */
export function selectFallbackModel(
  decision: AutoDecision,
  failedModels: ReadonlySet<string>,
  availableModels: ModelInfo[],
  allowCloudEscalation = false
): { fallbackModel: string | null; isCloudEscalation: boolean; notice: string } {
  const candidates = decision.scores.filter((s) => !failedModels.has(s.model) && s.fits);
  for (const cand of candidates) {
    const info = availableModels.find((m) => m.name === cand.model);
    if (!info) continue;
    const isCloud = !isLocalModel(info);
    if (isCloud && !allowCloudEscalation && !decision.signals?.isCloud) {
      // Do not silently escalate a local turn to a paid cloud API without explicit permission
      continue;
    }
    const costNote = isCloud
      ? ` (cloud escalation: ~$${(cand.signals?.estimatedCostPer1MUsd ?? 0).toFixed(2)}/1M tok)`
      : " (local fallback)";
    return {
      fallbackModel: cand.model,
      isCloudEscalation: isCloud && !decision.signals?.isCloud,
      notice: `Model "${decision.chosenModel}" failed; falling back to "${cand.model}"${costNote}.`,
    };
  }

  return {
    fallbackModel: null,
    isCloudEscalation: false,
    notice: `Model "${decision.chosenModel}" failed and no compatible fallback model is available.`,
  };
}

export interface PlanRequest extends AutoModeInput {
  intelligence: OrchestratorInput["intelligence"];
  reserveOutputTokens: number;
  adaptiveEnabled: boolean;
  userNumCtx?: number;
  cloudNativeTools?: boolean;
}

export function planRequest(input: PlanRequest): { decision: AutoDecision; plan: AdaptivePlan | null } {
  const decision = decideModel(input);
  const model = input.models.find((m) => m.name === decision.chosenModel);
  if (!model) return { decision, plan: null };
  const plan = buildPlan({
    model,
    machine: input.machine,
    mode: input.mode,
    prompt: input.prompt,
    userNumCtx: input.userNumCtx,
    intelligence: input.intelligence,
    reserveOutputTokens: input.reserveOutputTokens,
    adaptiveEnabled: input.adaptiveEnabled,
    cloudNativeTools: input.cloudNativeTools,
    task: decision.complexity.task,
    bench: input.benchByModel?.get(model.name),
  });
  return { decision, plan };
}
