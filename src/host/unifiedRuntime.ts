import { AgentEngine } from "../core/agent/engine";
import { runUnifiedTurn } from "../core/agent/unifiedEngine";
import { PhotonController } from "./PhotonController";
import type { AdaptivePlan, ChatMessage, ThinkingSetting, ToolCall } from "../shared/types";
import type { ProviderManager } from "../core/llm/providerManager";

interface UnifiedEmitter {
  onAssistantStart(id:string):void; onDelta(id:string,delta:string):void; onContent(id:string,content:string):void; onAssistantCancel(id:string):void;
  onPhase(phase:"thinking"|"working",detail?:string):void; onToolCall(id:string,call:ToolCall):void; onToolUpdate(id:string,call:ToolCall):void;
  onUsage(usage:import("../shared/types").TokenUsage):void; onGenerationStats(stats:import("../shared/types").GenerationStats|null):void;
  onDone(id:string,notice?:string):void; onError(message:string):void;
}

const THINKING_KEY="photon.thinkingSetting";

/**
 * Keep the existing local unified runtime, but NEVER replace the dedicated
 * cloud engine. The cloud engine owns its native tool loop and must remain
 * isolated from local adaptive orchestration.
 *
 * This bridge only adds the shared thinking-setting plumbing used by both
 * engines through ProviderManager.
 */
export function installUnifiedRuntime():void{
  const localProto=AgentEngine.prototype as any;
  if(!localProto.__photonUnified){
    localProto.runTurn=function(session:ChatMessage|any,plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal){
      const d=this.deps;
      return runUnifiedTurn(session,plan,emitter,signal,{provider:d.client,tools:d.registry.all(),workspaceName:d.workspaceName,workspaceMap:d.workspaceMap,retrieveContext:d.retrieveContext,buildToolContext:d.toolContext,reserveOutputTokens:d.reserveOutputTokens});
    };
    localProto.__photonUnified=true;
  }

  const controllerProto=PhotonController.prototype as any;
  if(!controllerProto.__photonThinkingWired){
    const originalInitialize=controllerProto.initialize;
    controllerProto.initialize=async function(){
      const stored=(this.context?.globalState?.get?.(THINKING_KEY) as ThinkingSetting|undefined)??"auto";
      this.thinkingLevel=stored;
      await originalInitialize.call(this);
    };

    const originalHandle=controllerProto.handleMessage;
    controllerProto.handleMessage=async function(msg:any){
      const result=await originalHandle.call(this,msg);
      if(msg?.type==="setThinkingSetting"){
        const level=msg.payload.level as ThinkingSetting;
        this.thinkingLevel=level;
        await this.context.globalState.update(THINKING_KEY,level);
        this.recomputePlan?.();
        this.pushPlan?.();
        this.pushConfig?.();
      }else if(msg?.type==="setThinkingLevel"){
        const level=msg.payload.level as ThinkingSetting;
        this.thinkingLevel=level;
        await this.context.globalState.update(THINKING_KEY,level);
        this.recomputePlan?.();
        this.pushPlan?.();
        this.pushConfig?.();
      }else if(msg?.type==="setThinkingEnabled"){
        const level:ThinkingSetting=msg.payload.enabled?"medium":"off";
        this.thinkingLevel=level;
        await this.context.globalState.update(THINKING_KEY,level);
        this.recomputePlan?.();
        this.pushPlan?.();
        this.pushConfig?.();
      }
      return result;
    };

    const originalRunPrompt=controllerProto.runPrompt;
    controllerProto.runPrompt=async function(text:string,attachments:any[]|undefined){
      const manager=this.providers as ProviderManager|undefined;
      manager?.setThinkingLevel?.((this.thinkingLevel??"auto") as ThinkingSetting);
      return originalRunPrompt.call(this,text,attachments);
    };

    controllerProto.__photonThinkingWired=true;
  }
}
