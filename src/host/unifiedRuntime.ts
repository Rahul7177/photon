import { AgentEngine } from "../core/agent/engine";
import { runUnifiedTurn } from "../core/agent/unifiedEngine";
import { PhotonController } from "./PhotonController";
import type { AdaptivePlan, ChatMessage, ThinkingSetting, ToolCall } from "../shared/types";
import type { ProviderManager } from "../core/llm/providerManager";
import { setCloudToolPolicy, type CloudToolPolicy } from "../core/tools/cloud/cloudTools";

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
 * This bridge adds shared thinking-setting plumbing and a deterministic
 * request-aware cloud tool surface so casual messages cannot trigger workspace
 * exploration and pure external-information requests receive web tools first.
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

    const originalRunCloudTurn=controllerProto.runCloudTurn;
    controllerProto.runCloudTurn=async function(session:any,plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal){
      const messages=session?.messages??[];
      let lastUser="";
      for(let i=messages.length-1;i>=0;i--){
        if(messages[i]?.role==="user"){lastUser=String(messages[i]?.content??"");break;}
      }
      const policy=classifyCloudToolPolicy(plan?.mode,lastUser);
      setCloudToolPolicy(policy);
      try{
        return await originalRunCloudTurn.call(this,session,plan,emitter,signal);
      }finally{
        setCloudToolPolicy("all");
      }
    };

    controllerProto.__photonThinkingWired=true;
  }
}

function classifyCloudToolPolicy(mode:unknown,text:string):CloudToolPolicy{
  const t=text.trim().toLowerCase();
  if(!t) return "all";

  // Deterministic guard: greetings, thanks and other social acknowledgements
  // must never make a cloud model inspect the workspace.
  if(/^(hi|hello|hey|hiya|yo|thanks|thank you|thx|ok|okay|great|cool|nice|good morning|good afternoon|good evening)[\s,!.?]*$/i.test(t)){
    return "none";
  }

  // Agent/plan modes always need the full tool set.
  if(mode==="agent"||mode==="plan") return "all";

  const workspaceIntent=/\b(file|files|folder|directory|workspace|repo|repository|codebase|code|class|function|symbol|bug|error|stack trace|edit|modify|change|implement|refactor|debug|fix|write|read|search files|list files|build|test|compile|lint|run command|search|find|show|open|list|get|create|add|remove|delete|rename|move|copy|update|set|configure|install|uninstall|run|start|stop|restart|check|test|debug|format|lint|deploy|push|pull|commit|merge|branch|clone|init|setup)\b/i.test(t);
  const externalIntent=/\b(weather|temperature|forecast|news|current|today|tonight|latest|live|recent|price|prices|stock|stocks|market|release|version|time|date|traffic|search|lookup|find out|what is|what are|how to|who is|where is)\b/i.test(t);

  if(externalIntent && !workspaceIntent) return "web";
  // Chat mode: still pass tools so the model can search/fetch when needed.
  // Only deny tools for purely social/greeting messages (handled above).
  return "all";
}
