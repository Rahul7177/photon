import type { AdaptivePlan } from "../../shared/types";
import type { PhotonAgent } from "../agent/agent";

export type LoopDeps = {
  /** Kept for constructor compatibility while the unified runtime is canonical. */
  [key:string]: unknown;
  buildPlan?: (prompt:string,mode:any,attachmentsCount:number)=>AdaptivePlan|null;
};

/**
 * Compatibility shell for the experimental harness loop.
 *
 * Photon now has one canonical execution brain in core/agent/unifiedEngine.ts.
 * This class intentionally does not execute tools itself; existing controller
 * construction remains source-compatible while avoiding a second divergent loop.
 */
export class AgentLoop {
  private preStepListeners:Array<(decision:any,next:()=>Promise<any>)=>Promise<any>>=[];
  constructor(private readonly deps:LoopDeps){}
  onPreStep(fn:(decision:any,next:()=>Promise<any>)=>Promise<any>):()=>void{this.preStepListeners.push(fn);return()=>{const i=this.preStepListeners.indexOf(fn);if(i>=0)this.preStepListeners.splice(i,1);};}
  async run(agent:PhotonAgent):Promise<void>{
    const ctrl=new AbortController();agent._setRunning(ctrl);
    try{
      const inbox=agent.inbox.claim();if(!inbox)return;
      const decision:any={kind:"enter",messages:inbox,plan:null};
      for(const fn of this.preStepListeners){const next=async()=>decision;const result=await fn(decision,next);if(result)Object.assign(decision,result);if(decision.kind==="reject")return;}
      // The controller-facing runtime owns actual turns. This shell only records
      // that a harness invocation was accepted; callers should use the canonical
      // AgentEngine facade installed by installUnifiedRuntime().
      agent.inject(`Unified Photon runtime is responsible for this turn. ${decision.plan?"Plan prepared.":"No plan was supplied."}`);
    }finally{agent._setIdle();}
  }
}
