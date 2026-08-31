import * as vscode from "vscode";
import { AgentEngine } from "../core/agent/engine";
import { runUnifiedTurn } from "../core/agent/unifiedEngine";
import { buildExecutionPolicy, buildVerificationPlan, capabilityForModel } from "../core/intelligence/policy";
import { buildWorkspaceMap } from "../core/tools/workspaceMap";
import { PhotonController } from "./PhotonController";
import type { AdaptivePlan, ChatMessage, ToolCall } from "../shared/types";

interface UnifiedEmitter {
  onAssistantStart(id:string):void; onDelta(id:string,delta:string):void; onContent(id:string,content:string):void; onAssistantCancel(id:string):void;
  onPhase(phase:"thinking"|"working",detail?:string):void; onToolCall(id:string,call:ToolCall):void; onToolUpdate(id:string,call:ToolCall):void;
  onUsage(usage:import("../shared/types").TokenUsage):void; onGenerationStats(stats:import("../shared/types").GenerationStats|null):void;
  onDone(id:string,notice?:string):void; onError(message:string):void;
}

/** Replace the legacy facades with the canonical core runtime while keeping controller APIs stable. */
export function installUnifiedRuntime():void {
  const localProto=AgentEngine.prototype as any;
  if(!localProto.__photonUnified){
    localProto.runTurn=function(session:ChatMessage|any,plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal){
      const d=this.deps;
      return runUnifiedTurn(session,plan,emitter,signal,{provider:d.client,tools:d.registry.all(),workspaceName:d.workspaceName,workspaceMap:d.workspaceMap,retrieveContext:d.retrieveContext,buildToolContext:d.toolContext,reserveOutputTokens:d.reserveOutputTokens});
    };
    localProto.__photonUnified=true;
  }
  const cloudProto=PhotonController.prototype as any;
  if(!cloudProto.__photonUnifiedCloud){
    cloudProto.runCloudTurn=async function(session:any,plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal){
      const self=this as any;
      const model=self.models?.find((m:any)=>m.name===plan.model);
      const task=plan.task??self.lastDecision?.complexity?.task??{scope:"single_file",reasoning:"medium",risk:"low",verification:[],ambiguity:"low",estimatedSteps:1};
      const caps=plan.modelCapabilities??capabilityForModel(model??{name:plan.model});
      const enriched:AdaptivePlan={
        ...plan,
        task,
        modelCapabilities:caps,
        executionPolicy:plan.executionPolicy??buildExecutionPolicy(task,caps,plan.mode==="agent"?100:plan.mode==="plan"?50:1,plan.maxTools),
        verification:plan.verification??buildVerificationPlan(task),
      };
      const root=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return runUnifiedTurn(session,enriched,emitter,signal,{
        provider:self.providers,
        tools:self.registry.all(),
        workspaceName:vscode.workspace.workspaceFolders?.[0]?.name,
        workspaceMap:()=>buildWorkspaceMap(root),
        retrieveContext:(q:string,s:AbortSignal)=>self.index?.retrieveContext(q,s),
        buildToolContext:(s:AbortSignal)=>self.buildToolContext(s),
        reserveOutputTokens:1024,
      });
    };
    cloudProto.__photonUnifiedCloud=true;
  }
}
