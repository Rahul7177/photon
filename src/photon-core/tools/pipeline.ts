import type { Tool, ToolContext, ToolResult } from "../../core/tools/types";
import type { ToolCall, ToolSpec } from "../../shared/types";

export type ToolPreExecuteEvent={call:ToolCall;tool:Tool;cancel?:(reason:string)=>void};
export type ToolPostExecuteEvent={call:ToolCall;result:ToolResult};

export class ToolPipeline{
  private tools=new Map<string,Tool>();
  private preListeners=new Set<(e:ToolPreExecuteEvent,next:()=>Promise<void>)=>Promise<void>>();
  private postListeners=new Set<(e:ToolPostExecuteEvent)=>void>();
  register(tool:Tool):()=>void{this.tools.set(tool.spec.name,tool);return()=>this.tools.delete(tool.spec.name);}
  registerAll(tools:Tool[]):void{for(const t of tools)this.register(t);}
  get(name:string){return this.tools.get(name);}
  all():Tool[]{return[...this.tools.values()];}
  specs():ToolSpec[]{return[...this.tools.values()].map(t=>t.spec);}
  onPreExecute(fn:(e:ToolPreExecuteEvent,next:()=>Promise<void>)=>Promise<void>):()=>void{this.preListeners.add(fn);return()=>this.preListeners.delete(fn);}
  onPostExecute(fn:(e:ToolPostExecuteEvent)=>void):()=>void{this.postListeners.add(fn);return()=>this.postListeners.delete(fn);}

  specsForPlan(plan:import("../../shared/types").AdaptivePlan):ToolSpec[]{
    if(plan.mode==="chat")return[];
    const rank:Record<string,number>={low:0,medium:1,high:2,max:3};
    const level=rank[plan.intelligence]??0;
    const preferredTags=plan.mode==="plan"?["fs","read","search","plan"]:["fs","read","search","write","exec","plan","web"];
    return this.specs()
      .filter(s=>{const min=rank[s.minTier??"low"]??0;return min<=level;})
      .filter(s=>plan.mode!=="plan"||!s.sideEffecting)
      .sort((a,b)=>{
        const at=(a.tags??[]).some(t=>preferredTags.includes(t))?0:1;
        const bt=(b.tags??[]).some(t=>preferredTags.includes(t))?0:1;
        return at-bt||a.priority-b.priority;
      })
      .slice(0,Math.max(1,plan.maxTools));
  }

  async execute(call:ToolCall,ctx:ToolContext):Promise<ToolResult>{
    const tool=this.tools.get(call.name);
    if(!tool)return{ok:false,status:"invalid_args",retryable:false,output:`Unknown tool "${call.name}". Available tools: ${this.specs().slice(0,12).map(s=>s.name).join(", ")}`};
    let cancelled:string|undefined;
    const preEvent:ToolPreExecuteEvent={call,tool,cancel:r=>cancelled=r};
    for(const fn of this.preListeners){let nextCalled=false;await fn(preEvent,async()=>{nextCalled=true;});if(!nextCalled){cancelled??="blocked by policy";break;}if(cancelled)break;}
    if(cancelled)return{ok:false,status:"permission_denied",retryable:false,output:cancelled};
    let result:ToolResult;
    try{result=await tool.execute(call.args,ctx);}catch(e){result={ok:false,status:"execution_error",retryable:true,output:(e as Error).message};}
    for(const fn of this.postListeners)fn({call,result});
    return result;
  }
}
