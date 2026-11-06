import { PhotonController } from "./PhotonController";
import type { AdaptivePlan, ThinkingSetting, ToolCall } from "../shared/types";
import type { ProviderManager } from "../core/llm/providerManager";
import { setCloudToolPolicy, getCloudToolPolicy, classifyCloudToolPolicy } from "../core/tools/cloud/cloudTools";

interface UnifiedEmitter {
  onAssistantStart(id:string):void; onDelta(id:string,delta:string):void; onContent(id:string,content:string):void; onAssistantCancel(id:string):void;
  onPhase(phase:"thinking"|"working",detail?:string):void; onToolCall(id:string,call:ToolCall):void; onToolUpdate(id:string,call:ToolCall):void;
  onUsage(usage:import("../shared/types").TokenUsage):void; onGenerationStats(stats:import("../shared/types").GenerationStats|null):void;
  onDone(id:string,notice?:string):void; onError(message:string):void;
}

const THINKING_KEY="photon.thinkingSetting";
const THINKING_MIGRATED_KEY="photon.thinkingAutoDefaultV1";

/**
 * Keep the existing local unified runtime, but NEVER replace the dedicated
 * cloud engine. The cloud engine owns its native tool loop and must remain
 * isolated from local adaptive orchestration.
 *
 * This bridge adds shared thinking-setting plumbing and a deterministic
 * request-aware cloud tool surface so casual messages cannot trigger workspace
 * exploration and pure external-information requests receive web tools first.
 */
export function installUnifiedRuntime():void{
  const controllerProto=PhotonController.prototype as any;
  if(!controllerProto.__photonThinkingWired){
    const originalInitialize=controllerProto.initialize;
    controllerProto.initialize=async function(){
      const stored=(this.context?.globalState?.get?.(THINKING_KEY) as ThinkingSetting|undefined)??"auto";
      // One-time migration: "off" used to be the default, so long-time installs
      // have it persisted without ever choosing it — leaving thinking-capable
      // models (qwen3, deepseek-r1, gpt-oss…) silent with no trace in chat.
      // Move those installs to "auto" once; an explicit later choice of "off"
      // is respected because the flag is already set by then.
      let level=stored;
      try{
        if(!this.context?.globalState?.get?.(THINKING_MIGRATED_KEY)){
          if(level==="off")level="auto";
          await this.context?.globalState?.update?.(THINKING_KEY,level);
          await this.context?.globalState?.update?.(THINKING_MIGRATED_KEY,true);
        }
      }catch{/* best-effort: a failed migration must never block startup */}
      this.thinkingLevel=level;
      await originalInitialize.call(this);
      this.normalizeThinkingForModel?.();
      this.pushConfig?.();
    };

    const originalHandle=controllerProto.handleMessage;
    controllerProto.handleMessage=async function(msg:any){
      const result=await originalHandle.call(this,msg);
      // Note: the controller route already applies the fast UI update for
      // setThinkingLevel/Enabled. This wrapper only adds persistence +
      // re-plan, guarded by actual change so the double-handling is idempotent.
      if(msg?.type==="setThinkingSetting"){
        const level=msg.payload.level as ThinkingSetting;
        const next=this.isThinkingLevelSupported?.(level) === false ? "auto" : level;
        if(next===this.thinkingLevel)return result;
        this.thinkingLevel=next;
        await this.context.globalState.update(THINKING_KEY,level);
        this.recomputePlan?.();
        this.pushPlan?.();
        this.pushConfig?.();
      }else if(msg?.type==="setThinkingLevel"){
        const level=msg.payload.level as ThinkingSetting;
        const next=this.isThinkingLevelSupported?.(level) === false ? "auto" : level;
        // Route already set thinkingLevel; only persist + re-plan on real change
        // of the persisted key to avoid duplicate writes.
        const stored=this.context.globalState.get?.(THINKING_KEY);
        if(stored===level&&next===this.thinkingLevel)return result;
        this.thinkingLevel=next;
        await this.context.globalState.update(THINKING_KEY,level);
        this.recomputePlan?.();
        this.pushPlan?.();
        this.pushConfig?.();
      }else if(msg?.type==="setThinkingEnabled"){
        const level:ThinkingSetting=msg.payload.enabled?"medium":"off";
        if(level===this.thinkingLevel)return result;
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

    const originalRunCloudTurn=controllerProto.runCloudTurn;
    controllerProto.runCloudTurn=async function(session:any,plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal){
      const messages=session?.messages??[];
      let lastUser="";
      for(let i=messages.length-1;i>=0;i--){
        if(messages[i]?.role==="user"){lastUser=String(messages[i]?.content??"");break;}
      }
      const policy=classifyCloudToolPolicy(plan?.mode,lastUser);
      const prev=getCloudToolPolicy();
      setCloudToolPolicy(policy);
      try{
        return await originalRunCloudTurn.call(this,session,plan,emitter,signal);
      }finally{
        setCloudToolPolicy(prev);
      }
    };

    controllerProto.__photonThinkingWired=true;
  }
}
