import { randomUUID } from "node:crypto";
import type { PhotonAgent } from "../agent/agent";
import type { PhotonSession } from "../session/store";
import type { LlmAdapter } from "../llm/types.v2";
import type { ToolPipeline } from "../tools/pipeline";
import type { SystemPromptRegistry } from "../systemPrompt/registry";
import { buildSystemPrompt } from "../../core/prompts/system";
import { renderToolInstructions, toNativeTools } from "../../core/protocol/serialize";
import { parsePhotonBlocks, stripToolMarkup, validateAgainstSpec } from "../../core/protocol/parse";
import { fitToWindow } from "../../core/agent/contextManager";
import { buildRepairPrompt, MAX_REPAIRS } from "../../core/agent/repair";
import { buildWorkspaceMap } from "../../core/tools/workspaceMap";
import type { AdaptivePlan, ToolCall } from "../../shared/types";
import type { LLMMessage } from "../../core/llm/types";
import { ToolCallAssembler, parseToolArguments } from "./toolCallAssembler";

type LoopDeps = {
  llm: LlmAdapter;
  tools: ToolPipeline;
  systemPrompt: SystemPromptRegistry;
  workspaceName?: string;
  retrieveContext?: (query: string, signal: AbortSignal) => Promise<string | undefined>;
  reserveOutputTokens: number;
  buildPlan: (prompt: string, mode: any, attachmentsCount: number) => AdaptivePlan | null;
  buildToolContext: (signal: AbortSignal, capability: any) => import("../../core/tools/types").ToolContext;
};

export class AgentLoop {
  private preStepListeners: Array<(decision: any, next: () => Promise<any>) => Promise<any>> = [];
  constructor(private deps: LoopDeps) {}
  onPreStep(fn: any) { this.preStepListeners.push(fn); }

  async run(agent: PhotonAgent): Promise<void> {
    const ctrl = new AbortController(); agent._setRunning(ctrl); const signal=ctrl.signal; const session=agent.session;
    try {
      while(!signal.aborted) {
        const inbox=agent.inbox.claim();
        if(!inbox){ await agent.inbox.waitForWake(signal).catch(()=>{}); if(signal.aborted) break; continue; }
        const turnId=randomUUID(); session.append("turn/start",{turnId,at:Date.now()} as any);
        const userContents=inbox.map(i=>i.content).join("\n\n");
        for(const item of inbox) session.append("user/message",{id:item.id,content:item.content,attachments:item.attachments,source:item.source,createdAt:Date.now()} as any);
        if(session.allEvents().filter(e=>e.type==="user/message").length===inbox.length) session.setTitle(userContents.slice(0,40));

        let plan=this.deps.buildPlan(userContents,agent.options as any,inbox.reduce((n,i)=>n+(i.attachments?.length??0),0));
        if(!plan){ session.append("turn/end",{turnId,reason:"error",at:Date.now()} as any); continue; }
        let decision:any={kind:"enter",messages:inbox,plan};
        for(const fn of this.preStepListeners){ let nextCalled=false; const next=async()=>{nextCalled=true;return decision;}; const out=await fn(decision,next); if(!nextCalled){decision=out;break;} decision=out; }
        if(decision.kind==="reject"){session.append("turn/end",{turnId,reason:"aborted",at:Date.now()} as any);continue;}
        plan=decision.plan??plan;

        const specs=this.deps.tools.specsForPlan(plan);
        const toolInstructions=plan.toolProtocol==="photon-block"?renderToolInstructions(specs,plan):"";
        const wantsMap=plan.mode!=="chat";
        const workspaceMap=wantsMap?await buildWorkspaceMap(undefined).catch(()=>undefined):undefined;
        const retrievedContext=wantsMap&&plan.intelligence!=="low"&&this.deps.retrieveContext?await this.deps.retrieveContext(userContents,signal).catch(()=>undefined):undefined;
        const system=this.deps.systemPrompt.assemble({mode:plan.mode,plan,toolInstructions,workspaceName:this.deps.workspaceName,workspaceMap,retrievedContext} as any)||buildSystemPrompt({mode:plan.mode,plan,toolInstructions,workspaceName:this.deps.workspaceName,workspaceMap,retrievedContext} as any);
        session.append("request/header",{provider:this.deps.llm.id,model:plan.model,systemPrompt:system,tools:plan.toolProtocol==="native"?toNativeTools(specs):[],temperature:plan.temperature,contextWindow:plan.numCtx,reason:"initial"} as any);

        const maxSteps:Record<string,number>={chat:1,plan:50,agent:100}; const max=maxSteps[plan.mode]??10; let stepIdx=0; let continueLoop=true; let noProgress=0; const executed=new Set<string>(); let repairs=0;
        while(continueLoop&&stepIdx<max&&!signal.aborted){
          const stepId=randomUUID(); session.append("step/start",{stepId,turnId,at:Date.now()} as any);
          const history=sessionToLLM(session); const budget=plan.numCtx-plan.maxOutputTokens;
          const fit=fitToWindow({role:"system",content:system} as LLMMessage,history,budget,plan.numCtx,plan.model);
          const messagesForLlm=fit.messages.slice(1); const toolCtx=this.deps.buildToolContext(signal,plan.intelligence);
          let raw=""; let doneReason:string|undefined; const assembler=new ToolCallAssembler();
          try{
            for await(const chunk of this.deps.llm.stream({provider:this.deps.llm.id,model:plan.model,messages:messagesForLlm,system,tools:plan.toolProtocol==="native"?toNativeTools(specs):undefined,temperature:plan.temperature,signal})){
              if(chunk.type==="text-delta"){raw+=chunk.text;session.append("assistant/chunk",{id:stepId,delta:chunk.text,model:plan.model,seq:raw.length} as any);}
              else if(chunk.type==="tool-call-delta") assembler.accept(chunk);
              else if(chunk.type==="block-end"&&chunk.block.type==="tool-call") assembler.addCompleted(chunk.block);
              else if(chunk.type==="finish") doneReason=chunk.reason;
            }
          }catch(e){ if(signal.aborted) break; session.append("assistant/message",{id:stepId,content:`Model error: ${(e as Error).message}`,model:plan.model,createdAt:Date.now()} as any); session.append("step/end",{stepId,turnId,at:Date.now()} as any); break; }

          const native=plan.toolProtocol==="native"?assembler.finalize():[];
          let calls=resolveCalls(raw,native,specs,plan);
          const visible=stripToolMarkup(raw);
          const toolCallsForHistory=calls.map(c=>({id:c.id,name:c.name,args:c.args,status:c.status,error:c.error} as ToolCall));
          if(visible.trim()||calls.length) session.append("assistant/message",{id:stepId,content:visible,model:plan.model,provider:this.deps.llm.id,toolCalls:toolCallsForHistory,createdAt:Date.now()} as any);

          if(calls.length===0){
            const cutOff=isLengthCutoff(doneReason)||hasUnclosedFence(raw);
            const intent=plan.mode!=="chat"?continuationIntent(raw,specs):undefined;
            if((cutOff||intent)&&stepIdx<5){
              session.append("user/message",{id:randomUUID(),content:cutOff?"Your reply was cut off. Continue from exactly where you stopped. Do not repeat completed work.":intent==="format"?"You described a tool call but did not emit a valid call. Use one of the available tools now.":"Continue the task: call the next required tool or clearly finish the task.",source:{kind:"injected"},createdAt:Date.now()} as any);
              session.append("step/end",{stepId,turnId,at:Date.now()} as any);stepIdx++;continue;
            }
            session.append("step/end",{stepId,turnId,at:Date.now()} as any);break;
          }

          const invalid=calls.filter(c=>c.status==="error");
          if(invalid.length===calls.length){
            if(repairs<MAX_REPAIRS){ repairs++; const errors=invalid.map(c=>`${c.name}: ${c.error}`).join("\n"); session.append("user/message",{id:randomUUID(),content:buildRepairPrompt([errors],specs,plan),source:{kind:"injected"},createdAt:Date.now()} as any); session.append("step/end",{stepId,turnId,at:Date.now()} as any);stepIdx++;continue; }
            session.append("step/end",{stepId,turnId,at:Date.now()} as any);break;
          }

          let ranNew=false; const toRun=plan.allowParallelTools?calls:calls.slice(0,1);
          for(const call of toRun){
            const sig=`${call.name}|${JSON.stringify(call.args)}`;
            if(executed.has(sig)){session.append("tool/result",{callId:call.id,name:call.name,output:"This exact operation was already executed. Use its previous result instead of repeating it.",ok:false,status:"conflict",retryable:false} as any);continue;}
            executed.add(sig); call.status="running";
            session.append("tool/call",{id:call.id,name:call.name,args:call.args,attempt:1} as any);
            const res=await this.deps.tools.execute(call,toolCtx);
            call.status=res.ok?"done":"error"; call.result=res.output; call.error=res.ok?undefined:res.output;
            session.append("tool/result",{callId:call.id,name:call.name,output:res.output,ok:res.ok,status:res.status,retryable:res.retryable} as any); ranNew=true;
            if(!res.ok&&res.retryable){ session.append("user/message",{id:randomUUID(),content:recoveryHint(res),source:{kind:"injected"},createdAt:Date.now()} as any); }
          }
          session.append("step/end",{stepId,turnId,at:Date.now()} as any);
          stepIdx++; if(!ranNew&&++noProgress>=3) break; if(ranNew) noProgress=0; continueLoop=plan.mode!=="chat";
        }
        session.append("turn/end",{turnId,reason:stepIdx>=max?"max-steps":"stop",at:Date.now()} as any);
      }
    } finally { agent._setIdle(); }
  }
}

function sessionToLLM(session: PhotonSession): LLMMessage[]{ return session.deriveMessages().filter(m=>m.role!=="system").map(m=>({role:m.role as any,content:m.content,tool_calls:m.tool_calls,tool_call_id:m.tool_call_id,name:m.name})); }

function resolveCalls(raw:string,native:any[],specs:any[],plan:AdaptivePlan):any[]{
  if(plan.mode==="chat") return [];
  if(plan.toolProtocol==="native"&&native.length){
    return native.map(c=>{const parsed=parseToolArguments(c.argumentsText);const validated=validateAgainstSpec(c.name??"",parsed.args,specs);const errors=[parsed.error,...validated.errors].filter(Boolean);return{id:c.id,name:c.name??"",args:validated.args,status:errors.length?"error":"proposed",error:errors.join(" ")};});
  }
  const parsed=parsePhotonBlocks(raw,specs);
  return parsed.calls.map(p=>({id:randomUUID(),name:p.name,args:p.args,status:p.errors.length?"error":"proposed",error:p.errors.join(" ")}));
}

function recoveryHint(res:any):string{
  if(res.recovery?.action==="reread") return `Tool failed. Re-read the affected file before attempting another edit.\nReason: ${res.output}`;
  if(res.recovery?.action==="search") return `Tool failed. Search for the correct path/name before retrying.\nReason: ${res.output}`;
  if(res.recovery?.action==="repair") return `Tool arguments need correction. Re-read the tool schema and retry only after fixing the arguments.\nReason: ${res.output}`;
  return `The previous tool call failed. Diagnose the reported error and retry only if it is safe.\nReason: ${res.output}`;
}
function isLengthCutoff(r?:string){if(!r)return false;const s=r.toLowerCase();return s==="length"||s==="max_tokens"||s==="maxoutputtokens";}
function hasUnclosedFence(t:string){const m=t.match(/```/g);return !!m&&m.length%2===1;}
function continuationIntent(raw:string,specs:any[]):"format"|"continue"|undefined{for(const s of specs){const re=new RegExp(`(?:\\[TOOL\\s*|<tool_call>|\\"(?:name|tool)\\"\\s*:\\s*\\"|\\b)${s.name}\\s*\\(`,"i");if(re.test(raw))return "format";}if(/\b(let me|i'll|i will|going to|now let|then,|first,)\b/i.test(raw))return "continue";return undefined;}
