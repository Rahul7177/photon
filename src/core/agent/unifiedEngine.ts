import { randomUUID } from "node:crypto";
import type { AdaptivePlan, ChatMessage, ToolCall, ToolSpec, VerificationPlan } from "../../shared/types";
import type { LLMMessage } from "../llm/types";
import { buildSystemPrompt } from "../prompts/system";
import { fitToWindow } from "./contextManager";
import { parsePhotonBlocks, validateAgainstSpec, stripToolMarkup } from "../protocol/parse";
import { renderToolInstructionsV2, toNativeToolsV2, renderToolResultV2 } from "../protocol/serialize.v2";
import { rankTools, executionFingerprint, recoveryDirective, buildVerificationPlan, isFreshInfoRequest } from "../intelligence/policy";
import { ToolPipeline } from "../../photon-core/tools/pipeline";
import type { LLMProvider } from "../llm/types";
import type { Tool, ToolContext } from "../tools/types";

export interface UnifiedEngineDeps { provider:LLMProvider;tools:Tool[];workspaceName?:string;workspaceMap?:()=>Promise<string|undefined>;retrieveContext?:(query:string,signal:AbortSignal)=>Promise<string|undefined>;buildToolContext:(signal:AbortSignal)=>ToolContext;reserveOutputTokens?:number; }
export interface UnifiedEmitter { onAssistantStart(id:string):void;onDelta(id:string,delta:string):void;onContent(id:string,content:string):void;onAssistantCancel(id:string):void;onPhase(phase:"thinking"|"working",detail?:string):void;onToolCall(id:string,call:ToolCall):void;onToolUpdate(id:string,call:ToolCall):void;onUsage(usage:import("../../shared/types").TokenUsage):void;onGenerationStats(stats:import("../../shared/types").GenerationStats|null):void;onDone(id:string,notice?:string):void;onError(message:string):void; }
const MAX_OUTPUT_CHARS=200_000;const MAX_CONTINUATIONS=3;
// Low-end models need more retry budget — they often emit empty/reasoning-only
// responses or malformed tool calls on the first few attempts before settling in.
const EMPTY_RETRIES_BY_LEVEL:Record<string,number>={low:5,medium:3,high:2,max:2};
const NO_PROGRESS_BY_LEVEL:Record<string,number>={low:6,medium:4,high:3,max:3};

export async function runUnifiedTurn(session:{messages:ChatMessage[]},plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal,deps:UnifiedEngineDeps):Promise<void>{
  const pipeline=new ToolPipeline();pipeline.registerAll(deps.tools);
  const task=plan.task??{scope:"single_file",reasoning:"medium",risk:"low",verification:[],ambiguity:"low",estimatedSteps:1};
  const lastUserText=lastUser(session.messages)??"";
  const freshWebRequest=plan.mode==="chat"&&isFreshInfoRequest(lastUserText);
  const workspaceMap=plan.mode!=="chat"&&deps.workspaceMap?await deps.workspaceMap().catch(()=>undefined):undefined;
  // Enable context retrieval for ALL intelligence levels (including low).
  // Low-end models benefit from retrieved context because it reduces the need
  // to discover files by trial-and-error, which they are poor at.
  const retrieved=plan.mode!=="chat"&&deps.retrieveContext?await deps.retrieveContext(lastUserText,signal).catch(()=>undefined):undefined;
  const verificationPlan:VerificationPlan=plan.verification??buildVerificationPlan(task);
  const verification=new Set(verificationPlan.completed);const required=new Set(verificationPlan.required);
  let webEvidence=false;
  const phase=():"orient"|"edit"|"verify"|"final"=>{if(freshWebRequest&&!webEvidence)return"orient";if(required.size&&[...required].some(v=>!verification.has(v)))return"verify";return plan.mode==="chat"?"final":"orient";};

  // Fresh-data chat requests are retrieval-first. This keeps current facts out of model memory
  // and prevents a reasoning model from debating whether it can browse.
  if(freshWebRequest){
    const webTool=deps.tools.find(t=>t.spec.name==="web_search");
    if(webTool){
      const webId=randomUUID();const webCall:ToolCall={id:webId,name:"web_search",args:{query:lastUserText},status:"proposed",sideEffecting:false};
      emitter.onPhase("working","web_search");emitter.onToolCall(webId,webCall);
      try{
        const result=(await pipeline.executeMany([webCall],deps.buildToolContext(signal),1)).get(webId);
        if(result?.ok){
          webEvidence=true;webCall.status="done";webCall.result=result.output;emitter.onToolUpdate(webId,webCall);
          session.messages.push({id:randomUUID(),role:"user",content:`Photon fetched fresh web data for this request. Use the evidence below to answer the user; do not claim web access is unavailable and do not invent facts.\n\n${renderToolResultV2("web_search",result.output,true,result.metadata)}`,createdAt:Date.now()});
        }else{webCall.status="error";webCall.error=result?.output??"Web search failed.";emitter.onToolUpdate(webId,webCall);}
      }catch(e){webCall.status="error";webCall.error=(e as Error).message;emitter.onToolUpdate(webId,webCall);}
      emitter.onDone(webId);
    }
  }

  const baseBudget=Math.max(512,Math.min(plan.maxOutputTokens||2048,plan.executionPolicy?.generationBudgetTokens??plan.maxOutputTokens??2048));
  const availableTools=()=>{const ts=deps.tools.filter(t=>!(plan.toolProtocol==="native"&&(plan.modelCapabilities?.reasoning??0)>=.82&&t.spec.name==="think"));return rankTools(ts.map(t=>t.spec),task,phase()).slice(0,Math.max(1,plan.maxTools));};
  // ALWAYS include tool instructions in the system prompt, regardless of
  // protocol. When toolProtocol="native", the model also receives tools as
  // JSON schema in the API body — but local models often ignore that schema.
  // The text-based instructions act as a reliable fallback reference.
  const toolSpecs=availableTools();const toolInstructions=renderToolInstructionsV2(toolSpecs,plan);
  const system=buildSystemPrompt({mode:plan.mode,plan,toolInstructions,workspaceName:deps.workspaceName,workspaceMap,retrievedContext:retrieved});
  const systemMsg:LLMMessage={role:"system",content:system};
  let mutationEpoch=0;const executed=new Set<string>();let noProgress=0;let emptyRetries=0;let continuations=0;let mutationOccurred=false;
  const maxSteps=plan.executionPolicy?.stepBudget??(plan.mode==="agent"?100:plan.mode==="plan"?50:8);
  let reasoningLevel=reasoningLevelForTask(task);

  for(let step=0;step<maxSteps&&!signal.aborted;step++){
    const currentPhase=phase();const specs=availableTools();const factor=currentPhase==="orient"?.75:currentPhase==="edit"?1:.85;const budgetTokens=Math.max(512,Math.min(plan.maxOutputTokens||2048,Math.floor(baseBudget*factor)));
    emitter.onPhase("thinking");const history=historyToLLM(session.messages,plan);const fit=fitToWindow(systemMsg,history,Math.max(512,plan.numCtx-budgetTokens),plan.numCtx,plan.model);emitter.onUsage(fit.usage);
    const id=randomUUID();emitter.onAssistantStart(id);let raw="";const nativeCalls:{id?:string;name:string;args:Record<string,unknown>;thoughtSignature?:string}[]=[];let doneReason:string|undefined;
    try{for await(const chunk of deps.provider.chatStream({model:plan.model,messages:fit.messages.slice(1),options:{num_ctx:plan.numCtx,temperature:plan.temperature,top_p:plan.topP,num_predict:budgetTokens,thinkingLevel:reasoningLevel},tools:plan.toolProtocol==="native"&&specs.length?toNativeToolsV2(specs):undefined},signal)){if(chunk.message?.content){raw+=chunk.message.content;emitter.onDelta(id,chunk.message.content);}for(const tc of chunk.message?.tool_calls??[])nativeCalls.push({id:tc.id,name:tc.function.name,args:tc.function.arguments??{},thoughtSignature:tc.thoughtSignature});if(chunk.done_reason)doneReason=chunk.done_reason;if(raw.length>MAX_OUTPUT_CHARS){doneReason="length";break;}}}
    catch(e){if(signal.aborted){emitter.onDone(id);return;}emitter.onAssistantCancel(id);emitter.onError(`Model error: ${(e as Error).message}`);return;}

    const cleanedRaw=stripReasoningMarkup(raw);const calls=resolveCalls(cleanedRaw,nativeCalls,specs,plan);const visible=plan.toolProtocol==="native"?stripToolMarkup(cleanedRaw):parsePhotonBlocks(cleanedRaw,specs).cleanedText;if(visible!==raw)emitter.onContent(id,visible);
    const onlyReasoning=!cleanedRaw.trim()||isReasoningOnly(raw);
    if(!calls.length&&onlyReasoning){
      emitter.onAssistantCancel(id);
      if((isLengthCutoff(doneReason)||isReasoningOnly(raw))&&reasoningLevel!=="off"){reasoningLevel="off";emptyRetries=0;injectUser(session,"Answer directly and efficiently. Do not spend time on extended reasoning; use the available tool if one is required, then provide the result.");continue;}
      emptyRetries++;const maxEmpty=EMPTY_RETRIES_BY_LEVEL[plan.intelligence]??2;if(emptyRetries<=maxEmpty){const hint=plan.intelligence==="low"?"Call exactly ONE tool using [TOOL name] format with the required arguments, then wait.":"Continue the task. If work remains, call the next tool; otherwise provide the final answer.";injectUser(session,hint);continue;}emitter.onError("The model returned an empty response repeatedly.");return;
    }
    emptyRetries=0;

    if(!calls.length){
      const cut=isLengthCutoff(doneReason)||hasUnclosedFence(cleanedRaw);
      if(cut&&continuations<MAX_CONTINUATIONS){continuations++;emitter.onDone(id);if(reasoningLevel!=="off")reasoningLevel="off";injectUser(session,"The reply was cut off. Continue exactly where you stopped; do not repeat completed work.");continue;}
      if(plan.mode!=="chat"&&mutationOccurred&&[...required].some(v=>!verification.has(v))&&continuations<MAX_CONTINUATIONS){continuations++;emitter.onDone(id);injectUser(session,`Verification is still required before finishing: ${[...required].filter(v=>!verification.has(v)).join(", ")}. Run the appropriate verification tool.`);continue;}
      emitter.onDone(id);return;
    }

    const executable=calls.filter(c=>c.status!=="error");if(!executable.length){noProgress++;emitter.onDone(id);const maxNoProgress=NO_PROGRESS_BY_LEVEL[plan.intelligence]??3;const hint=plan.intelligence==="low"?`Fix the tool call. Use exactly: [TOOL tool_name]\\narg: value\\n[/TOOL]. Error: ${calls.map(c=>c.error??"invalid call").join("; ")}`:`Correct the invalid tool call and retry. ${calls.map(c=>c.error??"invalid call").join("; ")}`;injectUser(session,hint);if(noProgress>=maxNoProgress){emitter.onError("Stopped after repeated invalid tool calls.");return;}continue;}
    const fresh=executable.filter(c=>{const key=executionFingerprint(c,mutationEpoch);if(executed.has(key))return false;executed.add(key);return true;});if(!fresh.length){noProgress++;emitter.onDone(id);const maxNoProgress=NO_PROGRESS_BY_LEVEL[plan.intelligence]??3;if(noProgress>=maxNoProgress)return;injectUser(session,plan.intelligence==="low"?"Choose a different tool or a different file to work on.":"That exact operation already ran at the current workspace state. Choose a different next step.");continue;}

    const toolCtx=deps.buildToolContext(signal);const results=await pipeline.executeMany(fresh,toolCtx,plan.executionPolicy?.maxConcurrent??1);let ran=false;
    for(const call of fresh){
      const result=results.get(call.id);if(!result)continue;ran=true;const spec=deps.tools.find(t=>t.spec.name===call.name)?.spec;if(spec?.sideEffecting&&result.ok){mutationEpoch++;mutationOccurred=true;}
      if((call.name==="web_search"||call.name==="web_fetch")&&result.ok)webEvidence=true;
      if(call.name==="get_diagnostics"&&result.ok)verification.add("diagnostics");
      if(call.name==="run_command"&&result.ok){const cmd=String(call.args.command??"").toLowerCase();if(/\b(test|vitest|jest|mocha|pytest|cargo test|go test)\b/.test(cmd))verification.add("tests");if(/\b(build|tsc|compile|bundle)\b/.test(cmd))verification.add("build");if(/\b(eslint|lint|prettier)\b/.test(cmd))verification.add("lint");if(/\b(run|start|serve|runtime)\b/.test(cmd))verification.add("runtime");}
      emitter.onPhase("working",call.name);emitter.onToolCall(id,call);emitter.onToolUpdate(id,{...call,status:result.ok?"done":"error",result:result.ok?result.output:undefined,error:result.ok?undefined:result.output});call.result=result.output;call.status=result.ok?"done":"error";call.error=result.ok?undefined:result.output;
      session.messages.push({id:randomUUID(),role:plan.toolProtocol==="native"?"tool":"user",content:renderToolResultV2(call.name,result.output,result.ok,result.metadata),toolCallId:call.id,createdAt:Date.now()});
      if(!result.ok){const hint=result.recovery?recoveryDirective(result):undefined;if(hint)injectUser(session,hint);}if(result.metadata?.evidence?.length)for(const evidence of result.metadata.evidence)verificationPlan.evidence.push(evidence);
    }
    verificationPlan.completed=[...verification];emitter.onDone(id);if(ran){noProgress=0;continuations=0;}else noProgress++;const maxNoProgress=NO_PROGRESS_BY_LEVEL[plan.intelligence]??3;if(noProgress>=maxNoProgress){emitter.onError("Stopped after three steps without meaningful progress.");return;}
  }
  if(!signal.aborted)emitter.onError(`Reached the ${maxSteps}-step safety limit.`);
}

function reasoningLevelForTask(task:{reasoning:"low"|"medium"|"high"}):"off"|"low"|"medium"|"high"{if(task.reasoning==="low")return"off";if(task.reasoning==="medium")return"medium";return"high";}
function stripReasoningMarkup(text:string):string{const lower=text.toLowerCase();let out=text;for(const tag of ["think","analysis"]){const start=lower.indexOf(`<${tag}>`);const end=lower.indexOf(`</${tag}>`,start+tag.length+2);if(start>=0&&end>=0)out=out.slice(0,start)+out.slice(end+tag.length+3);}return out.trim();}
function isReasoningOnly(text:string):boolean{const t=text.trim().toLowerCase();return(t.startsWith("<think>")&&t.endsWith("</think>"))||(t.startsWith("<analysis>")&&t.endsWith("</analysis>"));}
function injectUser(session:{messages:ChatMessage[]},content:string):void{session.messages.push({id:randomUUID(),role:"user",content,createdAt:Date.now()});}
function resolveCalls(raw:string,native:{id?:string;name:string;args:Record<string,unknown>;thoughtSignature?:string}[],specs:ToolSpec[],plan:AdaptivePlan):ToolCall[]{if(plan.toolProtocol==="native"&&native.length)return native.map(c=>{const v=validateAgainstSpec(c.name,c.args,specs);return{id:c.id??randomUUID(),name:c.name,args:v.args,status:v.errors.length?"error":"proposed",error:v.errors.join(" "),sideEffecting:specs.find(s=>s.name===c.name)?.sideEffecting,thoughtSignature:c.thoughtSignature};});return parsePhotonBlocks(raw,specs).calls.map(p=>({id:randomUUID(),name:p.name,args:p.args,status:p.errors.length?"error":"proposed",error:p.errors.join(" "),sideEffecting:specs.find(s=>s.name===p.name)?.sideEffecting}));}
function historyToLLM(messages:ChatMessage[],plan:AdaptivePlan):LLMMessage[]{const out:LLMMessage[]=[];for(const m of messages){if(m.role==="user")out.push({role:"user",content:m.content,images:m.attachments?.filter(a=>a.kind==="image"&&a.dataBase64).map(a=>a.dataBase64 as string)});else if(m.role==="assistant"){const calls=(m.toolCalls??[]).filter(c=>c.status!=="error");if(m.content.trim()||calls.length)out.push({role:"assistant",content:m.content,tool_calls:plan.toolProtocol==="native"&&calls.length?calls.map(c=>({id:c.id,function:{name:c.name,arguments:c.args},thoughtSignature:c.thoughtSignature})):undefined});}else if(m.role==="tool")out.push({role:"tool",content:m.content,tool_call_id:m.toolCallId,name:(m as any).name});}return out;}
function lastUser(messages:ChatMessage[]):string|undefined{for(let i=messages.length-1;i>=0;i--)if(messages[i].role==="user")return messages[i].content;return undefined;}
function isLengthCutoff(r?:string){if(!r)return false;const x=r.toLowerCase();return x==="length"||x==="max_tokens"||x==="max-tokens"||x==="maxoutputtokens";}
function hasUnclosedFence(text:string){const m=text.match(/```/g);return!!m&&m.length%2===1;}
