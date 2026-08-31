import type { AdaptivePlan, BenchResult, IntelligenceLevel, IntelligenceSetting, MachineProfile, Mode, ModelInfo, ModelTier, TaskAnalysis } from "../../shared/types";
import { analyzeTask, buildExecutionPolicy, buildVerificationPlan, capabilityForModel, isFreshInfoRequest } from "../intelligence/policy";

export interface OrchestratorInput{model:ModelInfo;machine:MachineProfile|null;mode:Mode;prompt?:string;userNumCtx?:number;intelligence:IntelligenceSetting;reserveOutputTokens:number;adaptiveEnabled:boolean;cloudNativeTools?:boolean;task?:TaskAnalysis;bench?:BenchResult;}
interface LevelProfile{maxTools:number;allowParallelTools:boolean;outputCap:number;chatTemp:number;taskTemp:number;}
const LEVELS:Record<IntelligenceLevel,LevelProfile>={low:{maxTools:8,allowParallelTools:false,outputCap:1536,chatTemp:.35,taskTemp:.2},medium:{maxTools:8,allowParallelTools:true,outputCap:2048,chatTemp:.55,taskTemp:.3},high:{maxTools:14,allowParallelTools:true,outputCap:4096,chatTemp:.7,taskTemp:.35},max:{maxTools:18,allowParallelTools:true,outputCap:8192,chatTemp:.7,taskTemp:.4}};
const TIER_RANK:Record<ModelTier,number>={tiny:0,small:1,medium:2,large:3};

export function buildPlan(input:OrchestratorInput):AdaptivePlan{
  const {model,machine,mode,reserveOutputTokens,adaptiveEnabled}=input;
  const rationale:string[]=[];
  const tier=model.tier??"small";
  const task=input.task??analyzeTask(input.prompt??"",mode);
  const capabilities=capabilityForModel(model,input.bench);
  const auto=input.intelligence==="auto";
  const level:IntelligenceLevel=auto?deriveIntelligence(tier,machine,capabilities,task):(input.intelligence as IntelligenceLevel);
  const profile=LEVELS[level];

  rationale.push(auto?`Intelligence: ${level} (task/capability aware).`:`Intelligence: ${level} (pinned by user).`);
  rationale.push(`Task: ${task.scope}, reasoning=${task.reasoning}, risk=${task.risk}, verification=${task.verification.join(",")||"none"}.`);
  if(isFreshInfoRequest(input.prompt??""))rationale.push("Fresh-data request detected; web-capable tools are prioritized and model reasoning is bounded.");

  const modelMax=model.contextLength??8192;
  let numCtx=modelMax;
  if(adaptiveEnabled&&machine){
    const ramGb=machine.freeRamBytes/1024**3;
    const ramCap=machine.tier==="low"?8192:machine.tier==="mid"?16384:32768;
    if(modelMax>ramCap){numCtx=ramCap;rationale.push(`Capped context to ${ramCap} for ${machine.tier}-end hardware (${ramGb.toFixed(1)} GB free).`);}else rationale.push(`Using model context ${modelMax}.`);
  }
  if(input.userNumCtx&&input.userNumCtx>0){numCtx=input.userNumCtx;rationale.push(`Context pinned to ${numCtx} by user.`);}

  const isCloud=!!model.provider&&model.provider!=="ollama"&&model.provider!=="llamacpp";
  // Native tool calling only works reliably when the model is explicitly
  // tool-trained (e.g. Qwen-2.5-Coder, Llama-3.1-Tool) or is a capable cloud
  // model. Non-tool-trained local models silently ignore the JSON schema in
  // the API body and respond with plain text — so we MUST use block protocol
  // for them and keep tool instructions in the system prompt.
  const canNative=model.toolTrained===true||(isCloud&&capabilities.toolCalling>=.50);
  let toolProtocol:AdaptivePlan["toolProtocol"]='photon-block';
  if(canNative&&((!isCloud&&adaptiveEnabled)||(isCloud&&(input.cloudNativeTools??true))))toolProtocol='native';
  rationale.push(toolProtocol==="native"?"Native tool calling enabled.":"Using Photon block protocol with tool instructions in system prompt.");

  const allowParallelTools=profile.allowParallelTools&&task.risk!=="destructive";
  const maxTools=profile.maxTools;
  const temperature=mode==="chat"?profile.chatTemp:profile.taskTemp;
  const policy=buildExecutionPolicy(task,capabilities,mode==="agent"?100:mode==="plan"?50:8,maxTools)!;
  policy.maxConcurrent=allowParallelTools?policy.maxConcurrent:1;
  const contextBudget=Math.max(256,numCtx-reserveOutputTokens);
  const maxOutputTokens=Math.max(256,Math.min(contextBudget,Math.floor(numCtx*.5),profile.outputCap+policy.generationBudgetTokens,policy.generationBudgetTokens));
  policy.generationBudgetTokens=Math.min(policy.generationBudgetTokens,maxOutputTokens);
  const verification=buildVerificationPlan(task);

  if(model.vision)rationale.push(`${model.name} accepts images.`);
  if(model.thinking)rationale.push(`${model.name} exposes native thinking/reasoning capability; Photon will bound it per task.`);
  if(input.bench)rationale.push("Photon Bench capability profile applied.");
  rationale.push(`Execution: maxConcurrent=${policy.maxConcurrent}, generationBudget=${policy.generationBudgetTokens}, steps=${policy.stepBudget}.`);

  return{model:model.name,mode,contextWindow:numCtx,numCtx,temperature,topP:.9,maxOutputTokens,toolProtocol,maxTools,allowParallelTools,intelligence:level,intelligenceAuto:auto,rationale,task,modelCapabilities:capabilities,executionPolicy:policy,verification};
}

function deriveIntelligence(tier:ModelTier,machine:MachineProfile|null,capabilities:ReturnType<typeof capabilityForModel>,task:TaskAnalysis):IntelligenceLevel{
  const rank=TIER_RANK[tier];
  if(task.reasoning==="low")return"low";
  // Allow small (rank 1) models to reach medium intelligence for medium tasks
  // instead of being stuck at low. This ensures they get more tools and guidance.
  let level:IntelligenceLevel=task.reasoning==="medium"?(rank>=2?"high":rank>=1?"medium":"medium"):(rank>=3?"max":rank>=2?"high":rank===1?"medium":"low");
  if(capabilities.toolCalling<.5||capabilities.schemaAdherence<.5)level=level==="max"?"high":level==="high"?"medium":"low";
  if(task.risk==="destructive")level=level==="low"?"low":"medium";
  if(machine?.tier==="low"&&level==="max")level="high";
  return level;
}
