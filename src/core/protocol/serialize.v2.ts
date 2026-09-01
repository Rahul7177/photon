import type { AdaptivePlan, IntelligenceLevel, JsonSchema, ToolSpec } from "../../shared/types";

export function renderToolInstructionsV2(tools:ToolSpec[],plan:AdaptivePlan):string{
  if(!tools.length)return"";
  const list=tools.map(t=>renderSpec(t,plan.intelligence)).join("\n");
  const concurrency=plan.executionPolicy?.allowParallelReads&&(plan.executionPolicy.maxConcurrent??1)>1?"Independent read/search calls may be emitted together; mutations remain ordered.":"Call one tool, wait for its result, then continue.";
  return["TOOLS:","[TOOL tool_name]","arg_name: value","[/TOOL]",`- ${concurrency}`,"- Use only listed tools and exact argument names.","- After every result, decide the NEXT step from the result; do not restart or repeat a successful call.","- Read before editing; verify after changes.","- For multi-line arguments (content, find, replace): ALWAYS use a fenced code block (```...`).","- Do NOT add extra symbols (|, >, -, *) to find/replace/content — just the raw code/text.","- For edit_file: copy find text EXACTLY from read_file, without line numbers or │ symbols.",list].join("\n");
}

function renderSpec(t:ToolSpec,level:IntelligenceLevel):string{
  if(level==="low"){
    const params=t.params.map(p=>`  ${p.name}: ${p.type}${p.required?" (required)":" (optional)"} — ${p.description}`).join("\n");
    const example=t.example?`\nExample:\n${t.example}`:"";
    return`- ${t.name}: ${t.summary}\n${params}${example}`;
  }
  return`- ${t.name}: ${t.summary}${t.risk?` [risk=${t.risk}]`:""}\n${t.params.map(p=>`  ${p.name}: ${p.type}${p.required?" required":" optional"} — ${p.description}`).join("\n")}`;
}

export function toNativeToolsV2(tools:ToolSpec[]):unknown[]{return tools.map(t=>({type:"function",function:{name:t.name,description:t.example?`${t.summary}\nExample:\n${t.example}`:t.summary,parameters:canonicalSchema(t)}}));}
function canonicalSchema(t:ToolSpec):JsonSchema{if(t.inputSchema?.type==="object"||t.inputSchema?.properties)return t.inputSchema;return{type:"object",properties:Object.fromEntries(t.params.map(p=>[p.name,{type:p.type,description:p.description,...(p.enum?{enum:p.enum}:{}),...(p.items?{items:p.items}:{}),...(p.properties?{properties:p.properties}:{})}])),required:t.params.filter(p=>p.required).map(p=>p.name),additionalProperties:false};}

export function renderToolResultV2(name:string,result:string,ok:boolean,metadata?:Record<string,unknown>,nextStep?:string):string{
  const guidance=nextStep??defaultNextStep(name,ok);
  return JSON.stringify({type:ok?"tool_result":"tool_error",tool:name,result,metadata:metadata??{},next_step:guidance});
}

function defaultNextStep(name:string,ok:boolean):string{
  if(!ok)return"Inspect the error and recovery hints. Fix the arguments/path or re-read/search as instructed, then make exactly ONE corrected tool call.";
  if(name==="list_dir")return"Pick the most relevant file or folder from the listing above and call read_file or search_code on it. Do NOT narrate — call a tool.";
  if(name==="find_files")return"Pick the most relevant file from the results and call read_file on it. Do NOT narrate — call a tool.";
  if(name==="search_code")return"Pick the most relevant file from the search results and call read_file on it. Do NOT narrate — call a tool.";
  if(name==="read_file")return"Use the file content above to make your next decision. If you need to change this file, call edit_file or write_file now. Do NOT narrate — call a tool.";
  if(name==="code_outline")return"Pick the relevant symbol from the outline and call read_file on that file. Do NOT narrate — call a tool.";
  if(["edit_file","write_file","move_path"].includes(name))return"The workspace changed successfully. Inspect the result, then verify with get_diagnostics or the requested test/build command before continuing.";
  if(["get_diagnostics","run_command"].includes(name))return"Inspect the verification output. If errors remain, fix them with the appropriate workspace tool; otherwise continue to the next requested task step or finish.";
  if(name==="web_search")return"Pick the most relevant URL from the results above and call web_fetch on it to read the full page. If the snippets already answer the question, answer the user directly instead.";
  if(name==="web_fetch")return"Use the page content above to answer the user's question. Summarize the relevant facts and cite the source URL. Do not invent facts not in the result.";
  if(name==="todo_write")return"Read the checklist state and perform the next pending item with ONE tool call.";
  if(name==="think")return"Act on the reasoning now: make the next concrete tool call instead of generating more reasoning.";
  return"Read the result and choose the next concrete step. Call ONE tool at a time. Do NOT narrate — call a tool.";
}
