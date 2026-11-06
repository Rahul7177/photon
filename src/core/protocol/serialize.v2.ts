import type { AdaptivePlan, ToolSpec } from "../../shared/types";
import { renderToolInstructions, renderToolResult } from "./serialize";

// V2 compat — delegates to the Continue-style renderer so both paths agree.
export function renderToolInstructionsV2(tools:ToolSpec[],plan:AdaptivePlan):string{
  return renderToolInstructions(tools, plan);
}

export function toNativeToolsV2(tools:ToolSpec[]):unknown[]{
  return tools.map(t=>({
    type:"function",
    function:{
      name:t.name,
      description:t.summary,
      parameters:{
        type:"object",
        properties:Object.fromEntries(t.params.map(p=>[p.name,{type:p.type,description:p.description}])),
        required:t.params.filter(p=>p.required).map(p=>p.name),
      }
    }
  }));
}

export function renderToolResultV2(name:string,result:string,ok:boolean,metadata?:Record<string,unknown>,nextStep?:string):string{
  return renderToolResult(name,result,ok);
}
