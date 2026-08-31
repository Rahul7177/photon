import type { AdaptivePlan, IntelligenceLevel, IntelligenceSetting, MachineProfile, Mode, ModelInfo, ModelTier, TaskAnalysis } from "../../shared/types";
import { analyzeTask, buildExecutionPolicy, buildVerificationPlan, capabilityForModel } from "../intelligence/policy";

export interface OrchestratorInput {
  model: ModelInfo;
  machine: MachineProfile | null;
  mode: Mode;
  prompt?: string;
  userNumCtx?: number;
  intelligence: IntelligenceSetting;
  reserveOutputTokens: number;
  adaptiveEnabled: boolean;
  cloudNativeTools?: boolean;
  task?: TaskAnalysis;
}

interface LevelProfile { maxTools: number; allowParallelTools: boolean; outputCap: number; chatTemp: number; taskTemp: number; }
const LEVELS: Record<IntelligenceLevel, LevelProfile> = {
  low: { maxTools: 5, allowParallelTools: false, outputCap: 768, chatTemp: 0.5, taskTemp: 0.2 },
  medium: { maxTools: 8, allowParallelTools: true, outputCap: 2048, chatTemp: 0.6, taskTemp: 0.3 },
  high: { maxTools: 14, allowParallelTools: true, outputCap: 4096, chatTemp: 0.7, taskTemp: 0.35 },
  max: { maxTools: 18, allowParallelTools: true, outputCap: 8192, chatTemp: 0.7, taskTemp: 0.4 },
};
const TIER_RANK: Record<ModelTier, number> = { tiny: 0, small: 1, medium: 2, large: 3 };

export function buildPlan(input: OrchestratorInput): AdaptivePlan {
  const { model, machine, mode, reserveOutputTokens, adaptiveEnabled } = input;
  const rationale: string[] = [];
  const tier = model.tier ?? "small";
  const task = input.task ?? analyzeTask(input.prompt ?? "", mode);
  const capabilities = capabilityForModel(model);

  const auto = input.intelligence === "auto";
  let level: IntelligenceLevel = auto ? deriveIntelligence(tier, machine, capabilities, task) : input.intelligence;
  const profile = LEVELS[level];
  rationale.push(auto ? `Intelligence: ${level} (task/capability aware).` : `Intelligence: ${level} (pinned by user).`);
  rationale.push(`Task: ${task.scope}, reasoning=${task.reasoning}, risk=${task.risk}, verification=${task.verification.join(",") || "none"}.`);

  const modelMax = model.contextLength ?? 8192;
  let numCtx = modelMax;
  if (adaptiveEnabled && machine) {
    const ramGb = machine.freeRamBytes / 1024 ** 3;
    const ramCap = machine.tier === "low" ? 8192 : machine.tier === "mid" ? 16384 : 32768;
    if (modelMax > ramCap) { numCtx = ramCap; rationale.push(`Capped context to ${ramCap} for ${machine.tier}-end hardware (${ramGb.toFixed(1)} GB free).`); }
    else rationale.push(`Using model context ${modelMax}.`);
  }
  if (input.userNumCtx && input.userNumCtx > 0) { numCtx = input.userNumCtx; rationale.push(`Context pinned to ${numCtx} by user.`); }

  const isCloud = !!model.provider && model.provider !== "ollama" && model.provider !== "llamacpp";
  const canNative = model.toolTrained === true || capabilities.toolCalling >= 0.78;
  let toolProtocol: AdaptivePlan["toolProtocol"] = "photon-block";
  if (canNative && ((!isCloud && adaptiveEnabled) || (isCloud && input.cloudNativeTools === true))) toolProtocol = "native";
  rationale.push(toolProtocol === "native" ? "Native tool calling enabled." : "Using Photon block protocol for tolerant tool use.");

  const riskTight = task.risk === "destructive";
  const maxTools = isCloud ? 100 : profile.maxTools;
  const allowParallelTools = profile.allowParallelTools && !riskTight;
  const temperature = mode === "chat" ? profile.chatTemp : profile.taskTemp;
  const maxOutputTokens = Math.max(256, Math.min(profile.outputCap, Math.max(256, numCtx - reserveOutputTokens), Math.floor(numCtx * 0.5)));
  const executionPolicy = buildExecutionPolicy(task, capabilities, mode === "agent" ? 100 : mode === "plan" ? 50 : 1, maxTools);
  executionPolicy.maxConcurrent = allowParallelTools ? executionPolicy.maxConcurrent : 1;
  executionPolicy.generationBudgetTokens = Math.min(executionPolicy.generationBudgetTokens, maxOutputTokens);
  const verification = buildVerificationPlan(task);

  if (model.vision) rationale.push(`${model.name} accepts images.`);
  if (model.thinking) rationale.push(`${model.name} exposes native thinking/reasoning capability.`);
  rationale.push(`Execution: maxConcurrent=${executionPolicy.maxConcurrent}, generationBudget=${executionPolicy.generationBudgetTokens}, steps=${executionPolicy.stepBudget}.`);

  return {
    model: model.name,
    mode,
    contextWindow: numCtx,
    numCtx,
    temperature,
    topP: 0.9,
    maxOutputTokens,
    toolProtocol,
    maxTools,
    allowParallelTools,
    intelligence: level,
    intelligenceAuto: auto,
    rationale,
    task,
    modelCapabilities: capabilities,
    executionPolicy,
    verification,
  };
}

function deriveIntelligence(tier: ModelTier, machine: MachineProfile | null, capabilities: ReturnType<typeof capabilityForModel>, task: TaskAnalysis): IntelligenceLevel {
  const rank = TIER_RANK[tier];
  let level: IntelligenceLevel = rank <= 0 ? "low" : rank === 1 ? "medium" : rank === 2 ? "high" : "max";
  if (capabilities.toolCalling < 0.5 || capabilities.schemaAdherence < 0.5) level = level === "max" ? "high" : level === "high" ? "medium" : "low";
  if (task.risk === "destructive") level = level === "low" ? "low" : "medium";
  if (task.reasoning === "high" && rank >= 2) level = "max";
  if (machine?.tier === "low" && level === "max") level = "high";
  return level;
}
