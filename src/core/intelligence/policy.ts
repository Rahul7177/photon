import type { AdaptivePlan, BenchResult, ComplexityAssessment, ModelCapabilityProfile, ModelInfo, TaskAnalysis, ToolCall, ToolSpec, VerificationKind } from "../../shared/types";

export function analyzeTask(prompt:string,mode:"chat"|"plan"|"agent",attachmentCount=0):TaskAnalysis{
  const text=(prompt??"").toLowerCase();const fileRefs=new Set<string>();
  for(const m of prompt.matchAll(/(?:[\w@./-]+\/)*[\w.-]+\.[a-z0-9]{1,8}\b/gi))fileRefs.add(m[0].toLowerCase());
  for(const m of prompt.matchAll(/@[\w./-]+/g))fileRefs.add(m[0].toLowerCase());
  const referenceCount=fileRefs.size+attachmentCount;
  const codebase=/\b(codebase|entire project|all files|every file|throughout|migration|migrate|restructure|re-architect)\b/i.test(prompt);
  const multi=referenceCount>=2||/\b(across|multiple files|both files|several files)\b/i.test(prompt);
  const scope:TaskAnalysis["scope"]=codebase?"codebase":multi?"multi_file":"single_file";
  const highReasoning=/\b(debug|race|concurrency|architecture|architect|refactor|migrate|performance|optimi[sz]e|algorithm|security|dependency|integration|root cause|design)\b/i.test(text);
  const moderateReasoning=/\b(implement|feature|fix|change|modify|wire|hook|add|remove|rename|update|create|build)\b/i.test(text);
  const reasoning:TaskAnalysis["reasoning"]=highReasoning?"high":moderateReasoning||scope!=="single_file"?"medium":"low";
  let risk:TaskAnalysis["risk"]="low";
  if(/\b(rm\s+-rf|delete database|drop table|destroy|wipe|reset production|force push|credential|secret|api key|password)\b/i.test(text))risk="destructive";
  else if(/\b(deploy|publish|release|dependency|install|uninstall|migration|security|permission|auth|database|schema|git)\b/i.test(text))risk="high";
  else if(/\b(write|edit|modify|change|remove|rename|replace|create|implement|fix)\b/i.test(text))risk="medium";
  const verification:VerificationKind[]=[];
  if(/\b(test|tests|testing|spec|unit|integration|regression)\b/i.test(text)||/\bbug\b/i.test(text))verification.push("tests");
  if(/\b(build|compile|bundle|tsc|package)\b/i.test(text))verification.push("build");
  if(/\b(lint|eslint|format|prettier)\b/i.test(text))verification.push("lint");
  if(/\b(diagnostic|type error|types|compile error)\b/i.test(text))verification.push("diagnostics");
  if(/\b(run|execute|runtime|start|server|endpoint|ui|browser)\b/i.test(text))verification.push("runtime");
  if(!verification.length&&mode!=="chat"&&risk!=="low")verification.push("diagnostics");
  if(scope==="codebase"&&!verification.includes("tests"))verification.push("tests");
  const ambiguity=/\b(maybe|somewhere|around|similar|something|it|that|the thing)\b/i.test(prompt)&&fileRefs.size===0?"medium":"low";
  const estimatedSteps=Math.max(1,Math.min(20,1+referenceCount+(scope==="codebase"?4:scope==="multi_file"?2:0)+verification.length));
  return{scope,reasoning,risk,verification:[...new Set(verification)],ambiguity,estimatedSteps};
}

export function toComplexity(task:TaskAnalysis,promptTokens:number):ComplexityAssessment{
  const level=task.scope==="codebase"||task.reasoning==="high"||promptTokens>1200?"complex":task.scope==="multi_file"||task.reasoning==="medium"||promptTokens>350?"moderate":"simple";
  const minContextTokens=level==="complex"?12288:level==="moderate"?6144:2048;
  return{level,minContextTokens,signals:{filesReferenced:Math.max(0,task.estimatedSteps-1-(task.scope==="codebase"?4:task.scope==="multi_file"?2:0)-task.verification.length),estimatedSteps:task.estimatedSteps,keywords:[],promptTokens,scope:task.scope,reasoning:task.reasoning,risk:task.risk,verification:task.verification,ambiguity:task.ambiguity},task};
}

export function capabilityForModel(model:ModelInfo,bench?:BenchResult):ModelCapabilityProfile{
  const tier=model.tier??"small";const baseMap:Record<string,number>={tiny:.38,small:.55,medium:.72,large:.88};const base=baseMap[tier]??.55;
  const p:ModelCapabilityProfile={reasoning:Math.min(1,base+(model.thinking?.08:0)),coding:Math.min(1,base+(model.toolTrained?.04:0)),toolCalling:model.toolTrained?Math.min(.95,base+.12):Math.max(.25,base-.10),schemaAdherence:model.toolTrained?Math.min(.92,base+.08):Math.max(.25,base-.08),contextRetention:Math.min(.96,base+.03),editFidelity:Math.min(.94,base+.02),recovery:Math.max(.25,base-.03),verification:Math.min(.94,base+.04),speed:.5};
  if(bench){
    const referenceTps=Math.max(1,bench.tokensPerSec);p.speed=Math.max(.05,Math.min(1,bench.tokensPerSec/referenceTps));
    if(bench.capabilityProfile)return clampProfile({...p,...bench.capabilityProfile});
    p.toolCalling=bench.toolCallReliability;p.schemaAdherence=bench.toolCallReliability;
    p.reasoning=taskPassRate(bench,"reasoning",p.reasoning);p.recovery=taskPassRate(bench,"recovery",p.recovery);p.editFidelity=taskPassRate(bench,"edit",p.editFidelity);p.verification=taskPassRate(bench,"verification",p.verification);p.contextRetention=taskPassRate(bench,"context",p.contextRetention);p.coding=taskPassRate(bench,"edit",p.coding);
  }
  return clampProfile(p);
}
function taskPassRate(bench:BenchResult,id:string,fallback:number){const t=bench.tasks.find(x=>x.id===id);return t?(t.passed?Math.min(1,fallback+.12):Math.max(0,fallback-.18)):fallback;}
function clampProfile(p:ModelCapabilityProfile):ModelCapabilityProfile{return Object.fromEntries(Object.entries(p).map(([k,v])=>[k,Math.max(0,Math.min(1,Number(v)))])) as ModelCapabilityProfile;}

export function rankTools(specs:ToolSpec[],task:TaskAnalysis,phase:"orient"|"edit"|"verify"|"final",previousFailures=new Map<string,number>()):ToolSpec[]{const verification=new Set(task.verification);return[...specs].sort((a,b)=>scoreTool(b,task,phase,verification,previousFailures)-scoreTool(a,task,phase,verification,previousFailures));}
function scoreTool(tool:ToolSpec,task:TaskAnalysis,phase:string,verification:Set<VerificationKind>,failures:Map<string,number>):number{let score=100-tool.priority;const tags=new Set(tool.tags??[]);const risk=tool.risk??(tool.sideEffecting?"workspace_write":"read");if(phase==="orient"&&(tags.has("read")||tags.has("search")||tags.has("navigate")))score+=35;if(phase==="edit"&&(tags.has("write")||risk==="workspace_write"))score+=40;if(phase==="verify"&&(tags.has("verify")||tool.name==="run_command"))score+=45;if(task.risk==="destructive"&&(risk==="destructive"||risk==="execute"))score-=30;if(task.verification.length&&(tool.verifyAfter??[]).some(v=>verification.has(v)))score+=15;if((failures.get(tool.name)??0)>=2)score+=5;return score;}

export function executionFingerprint(call:ToolCall,mutationEpoch:number):string{return`${call.name}|${JSON.stringify(stableNormalize(call.args))}|epoch:${mutationEpoch}`;}
function stableNormalize(value:unknown):unknown{if(Array.isArray(value))return value.map(stableNormalize);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stableNormalize(v)]));return value;}
export function canRunInParallel(a:ToolSpec,b:ToolSpec):boolean{const ar=a.risk??(a.sideEffecting?"workspace_write":"read");const br=b.risk??(b.sideEffecting?"workspace_write":"read");return(a.concurrency??"serial")==="safe_parallel"&&(b.concurrency??"serial")==="safe_parallel"&&ar==="read"&&br==="read";}
export function buildExecutionPolicy(task:TaskAnalysis,capability:ModelCapabilityProfile,maxSteps:number,maxTools:number):AdaptivePlan["executionPolicy"]{const concurrency=capability.toolCalling>=.78&&capability.recovery>=.60?4:capability.toolCalling>=.60?2:1;return{maxConcurrent:task.risk==="destructive"?1:Math.min(concurrency,4),allowParallelReads:task.risk!=="destructive",serializeMutations:true,generationBudgetTokens:Math.max(256,Math.min(8192,Math.floor(300+capability.reasoning*2500+capability.contextRetention*1200))),stepBudget:Math.max(8,Math.min(200,Math.max(maxSteps,task.estimatedSteps*3,maxTools*2)))};}
export function buildVerificationPlan(task:TaskAnalysis):AdaptivePlan["verification"]{return{required:[...new Set(task.verification)],completed:[],evidence:[]};}
export function recoveryDirective(result:{status?:string;recovery?:{action?:string;hints?:string[]};output:string}):string|undefined{const action=result.recovery?.action;if(!action)return undefined;const prefix:Record<string,string>={reread:"Re-read the affected file before retrying the operation.",search:"Search for the correct path, symbol, or current text before retrying.",repair:"Re-check the tool schema and correct the arguments before retrying.",verify:"Run the relevant verification step before making another change.",retry:"Retry once after inspecting the reported error.",ask_user:"Ask the user for the missing information or approval."};return`${prefix[action]??"Diagnose the tool failure before continuing."}${result.recovery?.hints?.length?` Hints: ${result.recovery.hints.join("; ")}`:""}\nTool output: ${result.output}`;}
