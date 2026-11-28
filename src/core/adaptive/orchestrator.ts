import type {
  AdaptivePlan,
  BenchResult,
  IntelligenceLevel,
  IntelligenceSetting,
  MachineProfile,
  Mode,
  ModelCapabilityProfile,
  ModelInfo,
  ModelTier,
  ScaffoldProfile,
  SessionTaskContext,
  TaskAnalysis,
} from "../../shared/types";
import { analyzeTask, buildExecutionPolicy, buildVerificationPlan, capabilityForModel, isFreshInfoRequest, shouldUseNativeToolProtocol } from "../intelligence/policy";
import { bytesPerParamForQuant, normalizeQuantization } from "./modelAdvisor";
import { passportNativeUnreliable, suggestedInitialRung, type PassportEntry } from "./passport";

export interface OrchestratorInput{model:ModelInfo;machine:MachineProfile|null;mode:Mode;prompt?:string;userNumCtx?:number;intelligence:IntelligenceSetting;reserveOutputTokens:number;adaptiveEnabled:boolean;cloudNativeTools?:boolean;scaffoldOptimizations?:boolean;/** Capability Passport entry for this model (live reliability learned on-device). */passport?:PassportEntry;/** User froze runtime adaptivity (ignore passport, governor observes only). */freezeAdaptivity?:boolean;task?:TaskAnalysis;sessionTaskContext?:SessionTaskContext;bench?:BenchResult;sampling?:{temp?:number;topP?:number;seed?:number};}
interface LevelProfile{outputCap:number;chatTemp:number;taskTemp:number;}
const MAX_PLAN_TOOLS = 40;
// High non-blocking safety ceilings so complex tasks finish naturally; duplicate-call and runaway guards prevent spin loops.
const MODE_CAPS:Record<Mode,number>={chat:100,plan:150,agent:200};
/**
 * Adaptive Scaffolding Profiles (Inverse Scaffolding Philosophy):
 * All intelligence levels grant access to the full tool suite (no artificial tool
 * starvation). Instead, `level` controls how much cognitive scaffolding, worked
 * examples, tool-result framing, and anti-hallucination guardrails Photon injects:
 *  - `max`: Maximum cognitive scaffolding — designed to make 2–8B local models
 *    behave like frontier models via explicit step-by-step rules, worked tool
 *    examples, and strict result-synthesis templates.
 *  - `high`: Strong structured guidance for mid-sized models or complex tasks.
 *  - `medium`: Balanced guidance for capable models.
 *  - `low`: Minimal/Autonomous overhead for large self-sufficient models.
 */
const LEVELS:Record<IntelligenceLevel,LevelProfile>={
  low:{outputCap:2048,chatTemp:.25,taskTemp:.15},
  medium:{outputCap:3072,chatTemp:.25,taskTemp:.15},
  high:{outputCap:4096,chatTemp:.2,taskTemp:.1},
  max:{outputCap:4096,chatTemp:.15,taskTemp:.1},
};
const LEGACY_BUDGET_FRACTION: Record<IntelligenceLevel, number> = { low: 0.2, medium: 0.26, high: 0.34, max: 0.42 };
const PROMPT_BUDGET_CLAMPS: Record<IntelligenceLevel, { frac: number; minTokens: number; maxTokens: number }> = {
  low: { frac: 0.2, minTokens: 800, maxTokens: 2800 },
  medium: { frac: 0.26, minTokens: 1400, maxTokens: 3600 },
  high: { frac: 0.34, minTokens: 1900, maxTokens: 4600 },
  max: { frac: 0.42, minTokens: 2400, maxTokens: 5600 },
};
const SPLIT_SAMPLING: Record<IntelligenceLevel, { toolTurnTemp: number; answerTurnTemp: number }> = {
  max: { toolTurnTemp: 0.05, answerTurnTemp: 0.2 },
  high: { toolTurnTemp: 0.08, answerTurnTemp: 0.2 },
  medium: { toolTurnTemp: 0.1, answerTurnTemp: 0.25 },
  low: { toolTurnTemp: 0.12, answerTurnTemp: 0.25 },
};
const NUDGE_POLICY_BY_PRESET: Record<IntelligenceLevel, { continue: number; finalAnswer: number; truncation: number }> = {
  max: { continue: 5, finalAnswer: 2, truncation: 2 },
  high: { continue: 4, finalAnswer: 2, truncation: 2 },
  medium: { continue: 3, finalAnswer: 2, truncation: 2 },
  low: { continue: 2, finalAnswer: 1, truncation: 1 },
};
const TIER_RANK:Record<ModelTier,number>={tiny:0,small:1,medium:2,large:3};

/** Derive the multi-dimensional ScaffoldProfile vector from tier, capabilities, task, and preset. */
export function deriveScaffoldProfile(
  tier: ModelTier,
  capabilities: ModelCapabilityProfile,
  task: TaskAnalysis,
  mode: Mode,
  numCtx: number,
  preset: IntelligenceLevel,
  options?: { legacyMode?: boolean; modelThinking?: boolean }
): ScaffoldProfile {
  const ruleVerbosity: ScaffoldProfile["ruleVerbosity"] =
    preset === "max" || preset === "high" ? "guided" : preset === "medium" ? "standard" : "terse";

  if (options?.legacyMode) {
    const legacyTemp = mode === "chat" ? LEVELS[preset].chatTemp : LEVELS[preset].taskTemp;
    return {
      preset,
      ruleVerbosity,
      toolCards: "full",
      shortlistSize: MAX_PLAN_TOOLS,
      examples: "phase",
      stateCard: "off",
      hostVerify: "off",
      hostOrient: false,
      promptBudget: {
        frac: LEGACY_BUDGET_FRACTION[preset],
        minTokens: 512,
        maxTokens: Math.max(512, numCtx),
      },
      sampling: { toolTurnTemp: legacyTemp, answerTurnTemp: legacyTemp },
      thinking: task.reasoning === "high" ? "high" : task.reasoning === "medium" ? "medium" : "low",
      nudgePolicy: { continue: 5, finalAnswer: 2, truncation: 2 },
    };
  }

  const toolCards: ScaffoldProfile["toolCards"] =
    tier === "large" && preset === "low" ? "names_only" : "shortlist";
  const shortlistSize = toolCards === "names_only" ? 0 : mode === "agent" ? 5 : 4;
  const examples: ScaffoldProfile["examples"] =
    preset === "low"
      ? "none"
      : tier === "tiny" || tier === "small" || capabilities.toolCalling < 0.78
        ? "phase+failing"
        : "phase";

  let stateCard: ScaffoldProfile["stateCard"] = "off";
  if (mode !== "chat" && !(task.readOnly && task.scope === "single_file" && task.estimatedSteps <= 2)) {
    if (tier === "tiny" && (mode === "agent" || task.scope !== "single_file" || task.estimatedSteps >= 3)) {
      stateCard = "rich";
    } else if (tier === "small" && (mode === "agent" || task.scope !== "single_file")) {
      stateCard = "compact";
    } else if (tier === "medium" && mode === "agent" && (task.scope !== "single_file" || task.reasoning === "high")) {
      stateCard = "compact";
    }
  }

  const hostVerify: ScaffoldProfile["hostVerify"] =
    mode === "agent" && !task.readOnly
      ? task.verification.includes("tests")
        ? "diagnostics+tests"
        : "diagnostics"
      : "off";

  let thinking: ScaffoldProfile["thinking"];
  if (tier === "tiny") {
    thinking = task.reasoning === "high" ? "low" : "off";
  } else if (tier === "small") {
    thinking = task.reasoning === "high" ? "medium" : task.reasoning === "medium" ? "low" : "off";
  } else if (tier === "medium") {
    thinking = task.reasoning === "high" ? "high" : task.reasoning === "medium" ? "medium" : "low";
  } else {
    thinking = task.reasoning === "high" ? "high" : "medium";
  }

  return {
    preset,
    ruleVerbosity,
    toolCards,
    shortlistSize,
    examples,
    stateCard,
    hostVerify,
    hostOrient: false,
    promptBudget: { ...PROMPT_BUDGET_CLAMPS[preset] },
    sampling: { ...SPLIT_SAMPLING[preset] },
    thinking,
    nudgePolicy: { ...NUDGE_POLICY_BY_PRESET[preset] },
  };
}

/** Standard context window presets selectable by the user or auto-planner. */
export const CONTEXT_WINDOW_BUCKETS = [8192, 16384, 32768, 65536, 131072, 262144] as const;

export function buildPlan(input:OrchestratorInput):AdaptivePlan{
  const {model,machine,mode,reserveOutputTokens,adaptiveEnabled}=input;
  const rationale:string[]=[];
  const tier=model.tier??"small";
  const task=input.task??analyzeTask(input.prompt??"",mode,0,input.sessionTaskContext);
  const frozen=input.freezeAdaptivity===true;
  const livePassport=frozen?undefined:input.passport;
  const capabilities=capabilityForModel(model,input.bench,livePassport);
  const auto=adaptiveEnabled&&input.intelligence==="auto";
  const level:IntelligenceLevel=auto
    ? deriveScaffoldingLevel(tier,capabilities,task)
    : (input.intelligence==="auto"?"medium":input.intelligence as IntelligenceLevel);
  const profile=LEVELS[level];

  const scaffoldingLabel:Record<IntelligenceLevel,string>={
    max:"Maximum scaffolding (deep behavioral guidance, worked examples & anti-hallucination framing to maximize model reliability)",
    high:"High scaffolding (structured multi-step guidance & verification rules)",
    medium:"Balanced scaffolding (standard workflow & tool guidance)",
    low:"Autonomous / minimal scaffolding (lean prompt overhead for self-sufficient models)",
  };
  if(!adaptiveEnabled){
    rationale.push(`Adaptive Assistance: ${level} (adaptive disabled by user) — ${scaffoldingLabel[level]}.`);
  }else if(auto){
    rationale.push(`Adaptive Assistance: ${scaffoldingLabel[level]}.`);
  }else{
    rationale.push(`Adaptive Assistance: ${level} (pinned by user) — ${scaffoldingLabel[level]}.`);
  }
  rationale.push(`Task: ${task.scope}, reasoning=${task.reasoning}, risk=${task.risk}, verification=${task.verification.join(",")||"none"}.`);
  if(task.carriedForward)rationale.push("Session continuity: carried forward prior task scope and verification requirements.");
  if(isFreshInfoRequest(input.prompt??""))rationale.push("Fresh-data request detected; web-capable tools are prioritized and grounded synthesis is enforced.");

  const ctxSelection=computeOptimalContextWindow(model,machine,adaptiveEnabled);
  let numCtx=ctxSelection.numCtx;
  const modelMax=(model.contextLength&&model.contextLength>0)?model.contextLength:8192;
  if(input.userNumCtx&&input.userNumCtx>0){
    if(input.userNumCtx>modelMax){
      numCtx=modelMax;
      rationale.push(`Context requested (${input.userNumCtx.toLocaleString()} tokens) exceeds model limit (${modelMax.toLocaleString()} tokens); clamped to model ceiling.`);
    }else{
      numCtx=input.userNumCtx;
      rationale.push(`Context pinned to ${numCtx.toLocaleString()} tokens by user (${ctxSelection.recommendedNumCtx.toLocaleString()} recommended for this hardware).`);
    }
  }else{
    rationale.push(ctxSelection.reason);
  }

  const isCloud=!!model.provider&&model.provider!=="ollama"&&model.provider!=="llamacpp";
  const nativeEligible=shouldUseNativeToolProtocol(model,capabilities,input.bench,level);
  let toolProtocol:AdaptivePlan["toolProtocol"]="photon-block";
  if(nativeEligible&&(isCloud?(input.cloudNativeTools??true):true))toolProtocol="native";
  if(toolProtocol==="native"&&!isCloud&&passportNativeUnreliable(livePassport)){
    toolProtocol="photon-block";
    rationale.push("Capability Passport: native tool calling repeatedly fell back on this device; using the Photon block protocol.");
  }
  if(toolProtocol==="native"){
    rationale.push("Protocol: Native tool calling with structured result-framing & anti-hallucination guidance.");
  }else{
    rationale.push("Protocol: Photon structured block protocol with worked examples & tolerant parser recovery.");
  }

  // Spec §5: hard iteration caps per user turn — enforce, not just suggest
  const hardCap=MODE_CAPS[mode];
  // Never starve small models of tools; cap only by mode or total available tools
  const maxTools=MAX_PLAN_TOOLS;
  // Lower temperature for smaller models / high-scaffolding turns reduces tool & fact hallucination
  const defaultTemp=mode==="chat"?profile.chatTemp:profile.taskTemp;
  const temperature=(typeof input.sampling?.temp==="number"&&Number.isFinite(input.sampling.temp))
    ? Math.max(0,Math.min(2,input.sampling.temp))
    : defaultTemp;
  const topP=(typeof input.sampling?.topP==="number"&&Number.isFinite(input.sampling.topP)&&input.sampling.topP>0&&input.sampling.topP<=1)
    ? input.sampling.topP
    : .9;
  const seed=(typeof input.sampling?.seed==="number"&&Number.isFinite(input.sampling.seed)&&input.sampling.seed>=0)
    ? Math.floor(input.sampling.seed)
    : undefined;
  const policy=buildExecutionPolicy(task,capabilities,hardCap,maxTools)!;
  policy.stepBudget=hardCap;
  const allowParallelTools = policy.maxConcurrent > 1 && policy.allowParallelReads && toolProtocol === "native";
  const effectiveOutputReserve=Math.max(256,Math.min(reserveOutputTokens,Math.floor(numCtx*.5)));
  const contextBudget=Math.max(256,numCtx-effectiveOutputReserve);
  const maxOutputTokens=Math.max(256,Math.min(contextBudget,Math.floor(numCtx*.5),profile.outputCap,effectiveOutputReserve));
  policy.generationBudgetTokens=Math.min(policy.generationBudgetTokens,maxOutputTokens);
  const verification=buildVerificationPlan(task);

  const scaffoldOptimizations=input.scaffoldOptimizations!==false;
  const samplingOverridden=Boolean(input.sampling&&typeof input.sampling.temp==="number"&&Number.isFinite(input.sampling.temp));
  const scaffoldProfile=deriveScaffoldProfile(tier,capabilities,task,mode,numCtx,level,{legacyMode:!scaffoldOptimizations,modelThinking:model.thinking});
  const initialRung=scaffoldOptimizations&&!frozen?suggestedInitialRung(livePassport):0;
  if(initialRung>0)rationale.push(`Capability Passport: this model needed extra help on earlier turns; starting at governor rung ${initialRung}.`);
  if(frozen)rationale.push("Adaptivity frozen by user: governor observes only (no rung, protocol or host actions).");

  if(model.vision)rationale.push(`${model.name} accepts images.`);
  if(model.thinking)rationale.push(`${model.name} exposes native thinking/reasoning capability; Photon will bound it per task.`);
  if(input.bench)rationale.push("Photon Bench capability profile applied.");
  if(input.sampling && (input.sampling.temp!==undefined||input.sampling.topP!==undefined||input.sampling.seed!==undefined)){
    rationale.push(`Per-model sampling override applied: temp=${temperature}, topP=${topP}${seed!==undefined?`, seed=${seed}`:""}.`);
  }
  rationale.push(
    scaffoldOptimizations
      ? `Scaffold profile: cards=${scaffoldProfile.toolCards}(${scaffoldProfile.shortlistSize}), stateCard=${scaffoldProfile.stateCard}, thinking=${scaffoldProfile.thinking}, temp(tool=${scaffoldProfile.sampling.toolTurnTemp}, answer=${scaffoldProfile.sampling.answerTurnTemp}).`
      : "Scaffold optimizations disabled (legacy full-card prompt)."
  );
  rationale.push(`Execution: temp=${temperature}, generationBudget=${policy.generationBudgetTokens} tok, stepBudget=${policy.stepBudget}.`);

  return{model:model.name,mode,contextWindow:numCtx,numCtx,temperature,topP,...(seed!==undefined?{seed}:{}),maxOutputTokens,toolProtocol,maxTools,allowParallelTools,intelligence:level,intelligenceAuto:auto,rationale,task,modelCapabilities:capabilities,executionPolicy:policy,verification,scaffoldProfile,scaffoldOptimizations,...(samplingOverridden?{samplingOverridden:true}:{}),...(initialRung>0?{initialRung}:{}),...(frozen?{adaptivityFrozen:true}:{})};
}

/**
 * Inverse Cognitive Scaffolding:
 * Smaller / less tool-reliable models receive MORE guidance (`max` / `high`) so
 * they know exactly how to behave, call tools, and synthesize results without
 * hallucinating. Larger / highly reliable models need less boilerplate unless
 * the task itself requires high reasoning or carries high risk.
 */
function deriveScaffoldingLevel(tier:ModelTier,capabilities:ReturnType<typeof capabilityForModel>,task:TaskAnalysis):IntelligenceLevel{
  const rank=TIER_RANK[tier];
  // Tiny (≤4B) and small (≤8.5B) models always get maximum scaffolding so they
  // can operate at their full potential with zero guesswork.
  if(rank<=1)return "max";
  // If measured or estimated tool/schema reliability is below 0.72, boost to max scaffolding.
  if(capabilities.toolCalling<.72||capabilities.schemaAdherence<.72)return "max";
  // Medium models (9–20B) get high scaffolding by default, or max on complex/high-risk tasks.
  if(rank===2){
    if(task.reasoning==="high"||task.scope==="codebase"||task.risk==="high"||task.risk==="destructive")return "max";
    return "high";
  }
  // Large models (20B+ / cloud): scale scaffolding with task complexity.
  if(task.reasoning==="high"||task.scope==="codebase"||task.risk==="destructive")return "high";
  if(task.reasoning==="medium"||task.scope==="multi_file")return "medium";
  return "low";
}

/**
 * Consumer-Laptop-Aware VRAM + System RAM + CPU Context Window Calculator:
 *
 * Consumer laptops typically have 2–8 GB of GPU VRAM, so local models and/or their
 * KV cache naturally spill across GPU VRAM + System RAM and execute partly on CPU.
 *  - Minimum context window is ALWAYS at least 8,192 (8k) tokens (4k is too cramped
 *    for structured prompts, tools, and multi-step file reads).
 *  - Pools available GPU VRAM + empty System RAM, while strictly keeping a 20–25%
 *    safety buffer of System RAM untouched so the OS and VS Code never freeze or swap.
 *  - Factors in CPU core count (`cpuCores`) when weights/KV spill into system RAM,
 *    so CPU prompt-evaluation time remains practical.
 */
export function computeOptimalContextWindow(
  model:ModelInfo,
  machine:MachineProfile|null,
  adaptiveEnabled:boolean
):{numCtx:number;recommendedNumCtx:number;safeMaxTokens:number;reason:string}{
  const modelMax=(model.contextLength&&model.contextLength>0)?model.contextLength:8192;
  const minCtx=Math.min(8192,modelMax);
  if(!adaptiveEnabled||!machine){
    return{
      numCtx:modelMax,
      recommendedNumCtx:modelMax,
      safeMaxTokens:modelMax,
      reason:`Using model context ${modelMax.toLocaleString()} tokens.`,
    };
  }

  const isLocal=!model.provider||model.provider==="ollama"||model.provider==="llamacpp";
  if(!isLocal){
    return{
      numCtx:modelMax,
      recommendedNumCtx:modelMax,
      safeMaxTokens:modelMax,
      reason:`Cloud model: using full context window (${modelMax.toLocaleString()} tokens).`,
    };
  }

  // 1. Model weight footprint in GB
  const paramsB=model.paramsB??(model.tier==="tiny"?3:model.tier==="small"?7:model.tier==="medium"?14:30);
  const bpp=bytesPerParamForQuant(normalizeQuantization(model.quantization,model.name));
  const weightBytes=model.sizeBytes&&model.sizeBytes>0
    ? model.sizeBytes
    : paramsB*bpp*(1024**3);
  const weightGb=weightBytes/(1024**3);

  // 2. KV cache + compute buffer cost per 1K context tokens (GB per 1K tokens)
  const kvGbPer1k=Math.max(0.04, Math.min(0.40, paramsB*0.022));

  // 3. Hardware memory pool: GPU VRAM + Available System RAM (leaving 22.5% RAM buffer for OS/VS Code)
  const totalRamGb=machine.totalRamBytes/(1024**3);
  const freeRamGb=machine.freeRamBytes/(1024**3);
  const ramSafetyBufferGb=totalRamGb*0.225; // 22.5% buffer (within 20-25% requirement)
  // Effective usable system RAM after reserving the 22.5% safety buffer
  const usableSystemRamGb=Math.max(0.5, Math.min(freeRamGb - totalRamGb*0.10, totalRamGb - ramSafetyBufferGb));
  const vramGb=(machine.gpu?.vramBytes??0)/(1024**3);
  const usableVramGb=vramGb>0?Math.max(0, vramGb-0.5):0;
  const isUnified=Boolean(machine.gpu?.isUnifiedMemory);

  // Total memory available for (Model Weights + KV Cache) across GPU + System RAM.
  // On unified-memory SoCs (e.g. Apple Silicon), VRAM and RAM share the same physical pool.
  const totalPoolGb=isUnified?usableSystemRamGb:usableVramGb + usableSystemRamGb;
  const remainingForKvGb=Math.max(0, totalPoolGb - weightGb);

  // Raw max context tokens that fit in the remaining VRAM + RAM pool without touching the 22.5% RAM buffer
  const rawSafeTokens=Math.floor((remainingForKvGb / kvGbPer1k)*1024);

  // 4. CPU core throughput cap when spilling to system RAM:
  // If weights + 8k KV exceed usable VRAM, CPU cores assist inference; cap auto-recommendation
  // to what the CPU core count can evaluate briskly while still allowing manual override up to 256k.
  const spillsToRam=weightGb + (8*kvGbPer1k) > usableVramGb;
  const cores=machine.cpuCores||4;
  const cpuPracticalCap=spillsToRam
    ? (cores>=12 ? 65536 : cores>=8 ? 32768 : 16384)
    : 131072;

  // 5. Never exceed modelMax or drop below minCtx
  const targetTokens=Math.max(minCtx, Math.min(modelMax, rawSafeTokens, cpuPracticalCap));

  // Snap to the highest standard bucket (8k, 16k, 32k, 64k, 128k, 256k) <= targetTokens
  let chosen:number=minCtx;
  for(const b of CONTEXT_WINDOW_BUCKETS){
    if(b<=targetTokens)chosen=b;
  }
  chosen=Math.max(minCtx, Math.min(modelMax, chosen));
  const safeMaxTokens=Math.max(minCtx, Math.min(modelMax, rawSafeTokens));

  const memSummary=vramGb>0
    ? `${vramGb.toFixed(1)} GB VRAM + ${freeRamGb.toFixed(1)}/${totalRamGb.toFixed(1)} GB RAM (${cores} CPU cores, 22% RAM buffer reserved)`
    : `${freeRamGb.toFixed(1)}/${totalRamGb.toFixed(1)} GB RAM (${cores} CPU cores, 22% RAM buffer reserved)`;

  const reason=`Context window auto-set to ${chosen.toLocaleString()} tokens for ${memSummary} (model weights ~${weightGb.toFixed(1)} GB${spillsToRam?", hybrid GPU+CPU/RAM offload":", 100% GPU resident"}).`;

  return{numCtx:chosen,recommendedNumCtx:chosen,safeMaxTokens,reason};
}
