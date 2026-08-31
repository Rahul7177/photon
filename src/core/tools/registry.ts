import type { AdaptivePlan, ToolSpec } from "../../shared/types";
import { selectToolSpecs } from "../intelligence/policy";
import type { Tool } from "./types";

export class ToolRegistry{
  private tools=new Map<string,Tool>();
  register(tool:Tool):void{this.tools.set(tool.spec.name,tool);}registerAll(tools:Tool[]):void{for(const t of tools)this.register(t);}unregisterByPrefix(prefix:string):void{for(const name of this.tools.keys())if(name.startsWith(prefix))this.tools.delete(name);}get(name:string):Tool|undefined{return this.tools.get(name);}all():Tool[]{return[...this.tools.values()];}
  specsForPlan(plan:AdaptivePlan):ToolSpec[]{
    const specs=[...this.tools.values()].map(t=>t.spec);
    return selectToolSpecs(specs,plan,plan.mode==="plan"?"orient":plan.mode==="chat"?"final":"orient");
  }
}
