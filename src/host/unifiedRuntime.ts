import * as vscode from "vscode";
import { AgentEngine } from "../core/agent/engine";
import { runUnifiedTurn } from "../core/agent/unifiedEngine";
import { buildExecutionPolicy, buildVerificationPlan, capabilityForModel } from "../core/intelligence/policy";
import { buildWorkspaceMap } from "../core/tools/workspaceMap";
import { PhotonController } from "./PhotonController";
import type { AdaptivePlan, ChatMessage, ThinkingSetting, ToolCall } from "../shared/types";

interface UnifiedEmitter {onAssistantStart(id:string):void;onDelta(id:string,delta:string):void;onContent(id:string,content:string):void;onAssistantCancel(id:string):void;onPhase(phase:"thinking"|"working",detail?:string):void;onToolCall(id:string,call:ToolCall):void;onToolUpdate(id:string,call:ToolCall):void;onUsage(usage:import("../shared/types").TokenUsage):void;onGenerationStats(stats:import("../shared/types").GenerationStats|null):void;onDone(id:string,notice?:string):void;onError(message:string):void;}
const THINKING_KEY="photon.thinkingLevel";

/** Canonical runtime bridge: one engine policy for local and cloud providers. */
export function installUnifiedRuntime():void{
  const localProto=AgentEngine.prototype as any;
  if(!localProto.__photonUnified){
    localProto.runTurn=function(session:ChatMessage|any,plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal){const d=this.deps;const thinkingSetting=(this.__photonThinkingSetting??plan.thinkingLevel??"auto") as ThinkingSetting;return runUnifiedTurn(session,plan,emitter,signal,{provider:d.client,tools:d.registry.all(),workspaceName:d.workspaceName,workspaceMap:d.workspaceMap,retrieveContext:d.retrieveContext,buildToolContext:d.toolContext,reserveOutputTokens:d.reserveOutputTokens,thinkingSetting});};
    localProto.__photonUnified=true;
  }
  const controllerProto=PhotonController.prototype as any;
  if(!controllerProto.__photonThinkingWired){
    const originalInitialize=controllerProto.initialize;
    controllerProto.initialize=async function(){const stored=this.context?.globalState?.get?.(THINKING_KEY) as ThinkingSetting|undefined;this.thinkingLevel=stored??"auto";return originalInitialize.call(this);};
    const originalHandle=controllerProto.handleMessage;
    controllerProto.handleMessage=async function(msg:any){const result=await originalHandle.call(this,msg);if(msg?.type==="setThinkingLevel"){const level=msg.payload.level as ThinkingSetting;this.thinkingLevel=level;await this.context.globalState.update(THINKING_KEY,level);this.recomputePlan?.();this.pushPlan?.();this.pushConfig?.();}else if(msg?.type==="setThinkingEnabled"){const level:ThinkingSetting=msg.payload.enabled?"medium":"off";await this.context.globalState.update(THINKING_KEY,level);this.recomputePlan?.();this.pushPlan?.();this.pushConfig?.();}return result;};
    const originalRunPrompt=controllerProto.runPrompt;
    controllerProto.runPrompt=async function(text:string,attachments:any[]|undefined){if(this.engine)this.engine.__photonThinkingSetting=(this.thinkingLevel??"auto") as ThinkingSetting;return originalRunPrompt.call(this,text,attachments);};
    controllerProto.__photonThinkingWired=true;
  }
  if(!controllerProto.__photonUnifiedCloud){
    controllerProto.runCloudTurn=async function(session:any,plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal){const self=this as any;const model=self.models?.find((m:any)=>m.name===plan.model);const task=plan.task??self.lastDecision?.complexity?.task??{scope:"single_file",reasoning:"medium",risk:"low",verification:[],ambiguity:"low",estimatedSteps:1,freshness:"none",requiresWeb:false};const caps=plan.modelCapabilities??capabilityForModel(model??{name:plan.model});const thinkingSetting=(self.thinkingLevel??"auto") as ThinkingSetting;const enriched:AdaptivePlan={...plan,task,modelCapabilities:caps,executionPolicy:plan.executionPolicy??buildExecutionPolicy(task,caps,8,plan.maxTools),verification:plan.verification??buildVerificationPlan(task),thinkingLevel:thinkingSetting};enriched.thinkingBudgetTokens=enriched.executionPolicy?.thinkingBudgetTokens??0;const root=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;return runUnifiedTurn(session,enriched,emitter,signal,{provider:self.providers,tools:self.registry.all(),workspaceName:vscode.workspace.workspaceFolders?.[0]?.name,workspaceMap:()=>buildWorkspaceMap(root),retrieveContext:(q:string,s:AbortSignal)=>self.index?.retrieveContext(q,s),buildToolContext:(s:AbortSignal)=>self.buildToolContext(s),reserveOutputTokens:1024,thinkingSetting});};
    controllerProto.__photonUnifiedCloud=true;
  }
}
