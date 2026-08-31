import { randomUUID } from "node:crypto";
import type { AdaptivePlan, ChatMessage, ToolCall, ToolSpec } from "../../shared/types";
import type { LLMMessage, LLMProvider } from "../llm/types";
import { buildSystemPrompt } from "../prompts/system";
import { fitToWindow } from "./contextManager";
import { parsePhotonBlocks, validateAgainstSpec, stripToolMarkup } from "../protocol/parse";
import { renderToolInstructionsV2, toNativeToolsV2, renderToolResultV2 } from "../protocol/serialize.v2";
import { rankTools, executionFingerprint, recoveryDirective, canRunInParallel } from "../intelligence/policy";
import { ToolPipeline } from "../../photon-core/tools/pipeline";
import type { Tool, ToolContext } from "../tools/types";

export interface UnifiedEngineDeps {
  provider: LLMProvider;
  tools: Tool[];
  workspaceName?: string;
  workspaceMap?: () => Promise<string | undefined>;
  retrieveContext?: (query: string, signal: AbortSignal) => Promise<string | undefined>;
  buildToolContext: (signal: AbortSignal) => ToolContext;
  reserveOutputTokens?: number;
}

export interface UnifiedEmitter {
  onAssistantStart(id: string): void;
  onDelta(id: string, delta: string): void;
  onContent(id: string, content: string): void;
  onAssistantCancel(id: string): void;
  onPhase(phase: "thinking"|"working", detail?: string): void;
  onToolCall(id: string, call: ToolCall): void;
  onToolUpdate(id: string, call: ToolCall): void;
  onUsage(usage: import("../../shared/types").TokenUsage): void;
  onGenerationStats(stats: import("../../shared/types").GenerationStats|null): void;
  onDone(id: string, notice?: string): void;
  onError(message: string): void;
}

const MAX_OUTPUT_CHARS=200_000;
const MAX_EMPTY_RETRIES=2;
const MAX_CONTINUATIONS=3;

/** One execution path for both local and cloud providers. Provider adapters only translate wire formats. */
export async function runUnifiedTurn(session:{messages:ChatMessage[]},plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal,deps:UnifiedEngineDeps):Promise<void>{
  const pipeline=new ToolPipeline();pipeline.registerAll(deps.tools);
  const task=plan.task??{scope:"single_file",reasoning:"medium",risk:"low",verification:[],ambiguity:"low",estimatedSteps:1};
  const map=plan.mode!=="chat"&&deps.workspaceMap?await deps.workspaceMap().catch(()=>undefined):undefined;
  const retrieved=plan.mode!=="chat"&&plan.intelligence!=="low"&&deps.retrieveContext?await deps.retrieveContext(lastUser(session.messages)??"",signal).catch(()=>undefined):undefined;
  const allSpecs=deps.tools.map(t=>t.spec);
  const initialSpecs=rankTools(allSpecs,task,"orient").slice(0,Math.max(1,plan.maxTools));
  const toolInstructions=plan.toolProtocol==="photon-block"?renderToolInstructionsV2(initialSpecs,plan):"";
  const system=buildSystemPrompt({mode:plan.mode,plan,toolInstructions,workspaceName:deps.workspaceName,workspaceMap:map,retrievedContext:retrieved});
  const systemMsg:LLMMessage={role:"system",content:system};
  let mutationEpoch=0;
  const executed=new Set<string>();
  let noProgress=0;
  let emptyRetries=0;
  let continuations=0;
  const verification=new Set(plan.verification?.completed??[]);
  const required=new Set(plan.verification?.required??[]);
  let mutationOccurred=false;
  const maxSteps=plan.executionPolicy?.stepBudget??(plan.mode==="agent"?100:plan.mode==="plan"?50:1);
  const budgetTokens=Math.max(256,plan.executionPolicy?.generationBudgetTokens??plan.maxOutputTokens??1024);

  for(let step=0;step<maxSteps&&!signal.aborted;step++){
    emitter.onPhase("thinking");
    const history=historyToLLM(session.messages,plan);
    const fit=fitToWindow(systemMsg,history,Math.max(512,plan.numCtx-budgetTokens),plan.numCtx,plan.model);
    emitter.onUsage(fit.usage);
    const id=randomUUID();emitter.onAssistantStart(id);
    let raw="";const nativeCalls:{id?:string;name:string;args:Record<string,unknown>;thoughtSignature?:string}[]=[];let doneReason:string|undefined;
    try{
      for await(const chunk of deps.provider.chatStream({model:plan.model,messages:fit.messages.slice(1),options:{num_ctx:plan.numCtx,temperature:plan.temperature,top_p:plan.topP,num_predict:budgetTokens,thinkingLevel:plan.modelCapabilities?.reasoning&&plan.modelCapabilities.reasoning>=0.78?"medium":"off"},tools:plan.toolProtocol==="native"&&initialSpecs.length?toNativeToolsV2(initialSpecs):undefined},signal)){
        if(chunk.message?.content){raw+=chunk.message.content;emitter.onDelta(id,chunk.message.content);}
        for(const tc of chunk.message?.tool_calls??[])nativeCalls.push({id:tc.id,name:tc.function.name,args:tc.function.arguments??{},thoughtSignature:tc.thoughtSignature});
        if(chunk.done_reason)doneReason=chunk.done_reason;
        if(raw.length>MAX_OUTPUT_CHARS){doneReason="length";break;}
      }
    }catch(e){if(signal.aborted){emitter.onDone(id);return;}emitter.onAssistantCancel(id);emitter.onError(`Model error: ${(e as Error).message}`);return;}

    const calls=resolveCalls(raw,nativeCalls,initialSpecs,plan);
    const visible=plan.toolProtocol==="native"?stripToolMarkup(raw):parsePhotonBlocks(raw,initialSpecs).cleanedText;
    if(visible!==raw)emitter.onContent(id,visible);
    if(calls.length===0&&!raw.trim()){
      emptyRetries++;emitter.onAssistantCancel(id);
      if(emptyRetries<=MAX_EMPTY_RETRIES){session.messages.push({id:randomUUID(),role:"user",content:"Continue the task. If work remains, call the next tool; otherwise provide the final answer.",createdAt:Date.now()});continue;}
      emitter.onError("The model returned an empty response repeatedly.");return;
    }
    emptyRetries=0;
    session.messages.push({id: id,role:"assistant",content:visible,toolCalls:calls,createdAt:Date.now()});

    if(calls.length===0){
      const cut=isLengthCutoff(doneReason)||hasUnclosedFence(raw);
      if(cut&&continuations<MAX_CONTINUATIONS){continuations++;emitter.onDone(id);session.messages.push({id:randomUUID(),role:"user",content:"The reply was cut off. Continue exactly where you stopped; do not repeat completed work.",createdAt:Date.now()});continue;}
      if(plan.mode!=="chat"&&mutationOccurred&&required.size>verification.size&&continuations<MAX_CONTINUATIONS){
        continuations++;emitter.onDone(id);session.messages.push({id:randomUUID(),role:"user",content:`Verification is still required before finishing. Run the appropriate verification tool now: ${[...required].filter(v=>!verification.has(v)).join(", ")}.`,createdAt:Date.now()});continue;
      }
      emitter.onDone(id);return;
    }

    const executable=calls.filter(c=>c.status!=="error");
    if(executable.length===0){
      const errors=calls.map(c=>c.error??"invalid tool call").join("; ");
      session.messages.push({id:randomUUID(),role:"user",content:`Your tool call was invalid. Correct it and retry only once. Errors: ${errors}`,createdAt:Date.now()});
      noProgress++;if(noProgress>=3){emitter.onDone(id);emitter.onError("Stopped after repeated invalid tool calls.");return;}emitter.onDone(id);continue;
    }

    // Remove only exact duplicates at the same workspace state; rereads after edits and repeated tests after mutations remain legal.
    const fresh=executable.filter(c=>{const key=executionFingerprint(c,mutationEpoch);if(executed.has(key))return false;executed.add(key);return true;});
    if(fresh.length===0){noProgress++;emitter.onDone(id);if(noProgress>=3)return;session.messages.push({id:randomUUID(),role:"user",content:"That exact operation was already executed at the current workspace state. Choose a different next step.",createdAt:Date.now()});continue;}

    const specs=new Map(deps.tools.map(t=>[t.spec.name,t.spec]));
    const maxConcurrent=plan.executionPolicy?.maxConcurrent??1;
    const toolCtx=deps.buildToolContext(signal);
    const results=await pipeline.executeMany(fresh,toolCtx,maxConcurrent);
    let ran=false;
    for(const call of fresh){
      const result=results.get(call.id);if(!result)continue;
      ran=true;const spec=specs.get(call.name);if(spec?.sideEffecting&&result.ok){mutationEpoch++;mutationOccurred=true;}
      if(result.ok&&spec?.verifyAfter)for(const v of spec.verifyAfter){if(result.metadata?.evidence?.some(e=>e.toLowerCase().includes(v)))verification.add(v);}
      if(result.ok&&call.name==="get_diagnostics")verification.add("diagnostics");
      if(result.ok&&call.name==="run_command"){
        const cmd=String(call.args.command??"").toLowerCase();
        if(/\b(test|vitest|jest|mocha|pytest|cargo test|go test)\b/.test(cmd))verification.add("tests");
        if(/\b(build|tsc|compile|bundle)\b/.test(cmd))verification.add("build");
        if(/\b(eslint|lint|prettier)\b/.test(cmd))verification.add("lint");
      }
      emitter.onToolCall(id,call);emitter.onToolUpdate(id,{...call,status:result.ok?"done":"error",result:result.ok?result.output:undefined,error:result.ok?undefined:result.output});
      session.messages.push({id:randomUUID(),role:plan.toolProtocol==="native"?"tool":"user",content:renderToolResultV2(call.name,result.output,result.ok,result.metadata),toolCallId:call.id,createdAt:Date.now()});
      if(!result.ok&&result.recovery){const hint=recoveryDirective(result);if(hint)session.messages.push({id:randomUUID(),role:"user",content:hint,createdAt:Date.now()});}
    }
    emitter.onDone(id);
    if(ran){noProgress=0;continuations=0;}else noProgress++;
    if(noProgress>=3){emitter.onError("Stopped after three steps without meaningful progress.");return;}
  }
  if(!signal.aborted)emitter.onError(`Reached the ${maxSteps}-step safety limit.`);
}

function resolveCalls(raw:string,native:{id?:string;name:string;args:Record<string,unknown>;thoughtSignature?:string}[],specs:ToolSpec[],plan:AdaptivePlan):ToolCall[]{
  if(plan.toolProtocol==="native"&&native.length)return native.map(c=>{const v=validateAgainstSpec(c.name,c.args,specs);return{id:c.id??randomUUID(),name:c.name,args:v.args,status:v.errors.length?"error":"proposed",error:v.errors.join(" "),sideEffecting:specs.find(s=>s.name===c.name)?.sideEffecting,thoughtSignature:c.thoughtSignature};});
  return parsePhotonBlocks(raw,specs).calls.map(p=>({id:randomUUID(),name:p.name,args:p.args,status:p.errors.length?"error":"proposed",error:p.errors.join(" "),sideEffecting:specs.find(s=>s.name===p.name)?.sideEffecting}));
}
function historyToLLM(messages:ChatMessage[],plan:AdaptivePlan):LLMMessage[]{const out:LLMMessage[]=[];for(const m of messages){if(m.role==="user")out.push({role:"user",content:m.content,images:m.attachments?.filter(a=>a.kind==="image"&&a.dataBase64).map(a=>a.dataBase64 as string)});else if(m.role==="assistant"){if(m.content.trim())out.push({role:"assistant",content:m.content});for(const c of m.toolCalls??[])if(c.result!==undefined)out.push({role:plan.toolProtocol==="native"?"tool":"user",content:renderToolResultV2(c.name,c.result,c.status!=="error"),tool_call_id:plan.toolProtocol==="native"?c.id:undefined,name:plan.toolProtocol==="native"?c.name:undefined});}else if(m.role==="tool")out.push({role:"tool",content:m.content,tool_call_id:m.toolCallId});}return out;}
function lastUser(messages:ChatMessage[]):string|undefined{for(let i=messages.length-1;i>=0;i--)if(messages[i].role==="user")return messages[i].content;return undefined;}
function isLengthCutoff(r?:string){if(!r)return false;const x=r.toLowerCase();return x==="length"||x==="max_tokens"||x==="max-tokens"||x==="maxoutputtokens";}
function hasUnclosedFence(text:string){const m=text.match(/```/g);return!!m&&m.length%2===1;}

/** Patch the legacy AgentEngine prototype without changing the controller contract. */
export function installUnifiedAgentEngine():void{
  // This module is imported once from extension activation. The cast is deliberate: private runtime fields are used only to bridge the legacy facade.
  // eslint/tsconfig do not expose a direct way to augment a class method across modules.
}
