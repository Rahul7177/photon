import type { AdaptivePlan, IntelligenceLevel, ToolSpec } from "../../shared/types";
import { rankTools } from "../intelligence/policy";
import type { Tool } from "./types";
const TIER_RANK:Record<IntelligenceLevel,number>={low:0,medium:1,high:2,max:3};
export class ToolRegistry{
  private tools=new Map<string,Tool>();
  register(tool:Tool):void{this.tools.set(tool.spec.name,tool);}registerAll(tools:Tool[]):void{for(const t of tools)this.register(t);}unregisterByPrefix(prefix:string):void{for(const name of this.tools.keys())if(name.startsWith(prefix))this.tools.delete(name);}get(name:string):Tool|undefined{return this.tools.get(name);}all():Tool[]{return[...this.tools.values()];}
  specsForPlan(plan:AdaptivePlan):ToolSpec[]{
    if(plan.mode==="chat")return[];let specs=[...this.tools.values()].map(t=>t.spec);if(plan.mode==="plan")specs=specs.filter(s=>!s.sideEffecting);const modelRank=TIER_RANK[plan.intelligence]??0;specs=specs.filter(s=>(TIER_RANK[s.minTier??"low"]??0)<=modelRank);
    // A strong native-reasoning model gains nothing from a user-visible scratchpad tool.
    if((plan.modelCapabilities?.reasoning??0)<.82||plan.toolProtocol!=="native")specs=specs;else specs=specs.filter(s=>s.name!=="think");
    const phase=inferPhase(plan);const task=plan.task??{scope:"single_file",reasoning:"medium",risk:"low",verification:[],ambiguity:"low",estimatedSteps:1};return rankTools(specs,task,phase).slice(0,Math.max(1,plan.maxTools));
  }
}
function inferPhase(plan:AdaptivePlan):"orient"|"edit"|"verify"|"final"{if(plan.mode==="plan")return"orient";if(plan.verification?.required.length&&plan.verification.required.every(v=>plan.verification.completed.includes(v)))return"final";return plan.mode==="agent"?"orient":"edit";}
