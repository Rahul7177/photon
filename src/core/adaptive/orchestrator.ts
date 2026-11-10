import type { AdaptivePlan, BenchResult, IntelligenceLevel, IntelligenceSetting, MachineProfile, Mode, ModelInfo, ModelTier, TaskAnalysis } from "../../shared/types";
import { analyzeTask, buildExecutionPolicy, buildVerificationPlan, capabilityForModel, isFreshInfoRequest, shouldUseNativeToolProtocol } from "../intelligence/policy";

export interface OrchestratorInput{model:ModelInfo;machine:MachineProfile|null;mode:Mode;prompt?:string;userNumCtx?:number;intelligence:IntelligenceSetting;reserveOutputTokens:number;adaptiveEnabled:boolean;cloudNativeTools?:boolean;task?:TaskAnalysis;bench?:BenchResult;}
interface LevelProfile{maxTools:number;allowParallelTools:boolean;outputCap:number;chatTemp:number;taskTemp:number;}
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
  low:{maxTools:40,allowParallelTools:false,outputCap:2048,chatTemp:.25,taskTemp:.15},
  medium:{maxTools:40,allowParallelTools:false,outputCap:3072,chatTemp:.25,taskTemp:.15},
  high:{maxTools:40,allowParallelTools:false,outputCap:4096,chatTemp:.2,taskTemp:.1},
  max:{maxTools:40,allowParallelTools:false,outputCap:4096,chatTemp:.15,taskTemp:.1},
};
const TIER_RANK:Record<ModelTier,number>={tiny:0,small:1,medium:2,large:3};

/** Standard context window presets selectable by the user or auto-planner. */
export const CONTEXT_WINDOW_BUCKETS = [8192, 16384, 32768, 65536, 131072, 262144] as const;

export function buildPlan(input:OrchestratorInput):AdaptivePlan{
  const {model,machine,mode,reserveOutputTokens,adaptiveEnabled}=input;
  const rationale:string[]=[];
  const tier=model.tier??"small";
  const task=input.task??analyzeTask(input.prompt??"",mode);
  const capabilities=capabilityForModel(model,input.bench);
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
  if(toolProtocol==="native"){
    rationale.push("Protocol: Native tool calling with structured result-framing & anti-hallucination guidance.");
  }else{
    rationale.push("Protocol: Photon structured block protocol with worked examples & tolerant parser recovery.");
  }

  // Spec §5: hard iteration caps per user turn — enforce, not just suggest
  const hardCap=MODE_CAPS[mode];
  // Never starve small models of tools; cap only by mode or total available tools
  const maxTools=profile.maxTools;
  // Lower temperature for smaller models / high-scaffolding turns reduces tool & fact hallucination
  const temperature=mode==="chat"?profile.chatTemp:profile.taskTemp;
  const policy=buildExecutionPolicy(task,capabilities,hardCap,maxTools)!;
  policy.maxConcurrent=task.risk==="destructive"?1:1;
  policy.stepBudget=hardCap;
  const effectiveOutputReserve=Math.max(256,Math.min(reserveOutputTokens,Math.floor(numCtx*.5)));
  const contextBudget=Math.max(256,numCtx-effectiveOutputReserve);
  const maxOutputTokens=Math.max(256,Math.min(contextBudget,Math.floor(numCtx*.5),profile.outputCap,effectiveOutputReserve));
  policy.generationBudgetTokens=Math.min(policy.generationBudgetTokens,maxOutputTokens);
  const verification=buildVerificationPlan(task);

  if(model.vision)rationale.push(`${model.name} accepts images.`);
  if(model.thinking)rationale.push(`${model.name} exposes native thinking/reasoning capability; Photon will bound it per task.`);
  if(input.bench)rationale.push("Photon Bench capability profile applied.");
  rationale.push(`Execution: temp=${temperature}, generationBudget=${policy.generationBudgetTokens} tok, stepBudget=${policy.stepBudget}.`);

  return{model:model.name,mode,contextWindow:numCtx,numCtx,temperature,topP:.9,maxOutputTokens,toolProtocol,maxTools,allowParallelTools:false,intelligence:level,intelligenceAuto:auto,rationale,task,modelCapabilities:capabilities,executionPolicy:policy,verification};
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
  const weightBytes=model.sizeBytes&&model.sizeBytes>0
    ? model.sizeBytes
    : paramsB*0.65*(1024**3);
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

  // Total memory available for (Model Weights + KV Cache) across GPU + System RAM
  const totalPoolGb=usableVramGb + usableSystemRamGb;
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
