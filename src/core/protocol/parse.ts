import type { ToolSpec } from "../../shared/types";
import { BLOCK_RE, OPEN_UNCLOSED_RE } from "./format";
export interface ParsedCall{name:string;args:Record<string,unknown>;raw:string;errors:string[];}
export interface ParseResult{calls:ParsedCall[];cleanedText:string;}
interface RawMatch{name:string;args:Record<string,unknown>;start:number;end:number;explicit:boolean;}

const TOOL_ALIASES:Record<string,string>={
  list_files:"list_dir",
  list_directory:"list_dir",
  search_files:"search_code",
  grep:"search_code",
  find_file:"find_files",
  read_file_contents:"read_file",
  read:"read_file",
  view:"read_file",
  show:"read_file",
  write_to_file:"write_file",
  create_file:"write_file",
  new_file:"write_file",
  save_file:"write_file",
  replace_in_file:"edit_file",
  edit_file_contents:"edit_file",
  update_file:"edit_file",
  modify_file:"edit_file",
  execute_command:"run_command",
  run_shell_command:"run_command",
  shell_command:"run_command",
  diagnostics:"get_diagnostics",
  get_errors:"get_diagnostics",
  move:"move_path",
  rename_file:"move_path",
  todo:"todo_write",
};

export function canonicalToolName(rawName:string,specs:ToolSpec[]):string|undefined{
  const raw=String(rawName).trim().toLowerCase();
  const exact=specs.find(s=>s.name.toLowerCase()===raw)?.name;if(exact)return exact;
  const alias=TOOL_ALIASES[raw];
  if(alias&&specs.some(s=>s.name.toLowerCase()===alias))return specs.find(s=>s.name.toLowerCase()===alias)?.name;
  return undefined;
}

export function parsePhotonBlocks(text:string,specs:ToolSpec[]):ParseResult{const specByName=new Map(specs.map(s=>[s.name.toLowerCase(),s]));const consumed:[number,number][]=[];const raws:RawMatch[]=[];const claim=(m:RawMatch)=>{if(overlaps(m.start,m.end,consumed))return;consumed.push([m.start,m.end]);raws.push(m);};const known=(name:string)=>!!canonicalToolName(name,specs);collectBlockTags(text,claim);collectXmlTags(text,known,claim);collectSysBlocks(text,known,claim);collectHybridTags(text,known,claim);collectPipeUnclosed(text,known,claim);collectToolNameBlocks(text,claim);collectJsonFences(text,known,claim);collectBareJson(text,known,claim);const calls=raws.sort((a,b)=>a.start-b.start).map(m=>finalizeCall(m.name,m.args,text.slice(m.start,m.end),specByName,specs,m.explicit)).filter((c):c is ParsedCall=>c!==null);return{calls,cleanedText:stripToolMarkup(stripRanges(text,consumed))};}
function hasUnclosedBeginArg(body:string):boolean{
  const lines=body.replace(/\r\n/g,"\n").split("\n");
  let open=false;
  for(const line of lines){
    if(/^[ \t]*BEGIN_ARG[ \t]*:/i.test(line))open=true;
    else if(/^[ \t]*END_ARG[ \t]*:?[ \t]*$/i.test(line))open=false;
  }
  return open;
}
function findNonToolCodeFenceRanges(text:string):[number,number][]{
  const ranges:[number,number][]=[];
  const re=/```([a-zA-Z0-9_-]*)[ \t]*\r?\n[\s\S]*?```/g;
  let m:RegExpExecArray|null;
  while((m=re.exec(text))!==null){
    const lang=(m[1]||"").toLowerCase();
    if(lang&&lang!=="tool"&&lang!=="tool_code"&&lang!=="tool_call"&&lang!=="json"){
      ranges.push([m.index,m.index+m[0].length]);
    }
  }
  return ranges;
}
function collectBlockTags(text:string,claim:(m:RawMatch)=>void):void{BLOCK_RE.lastIndex=0;let m:RegExpExecArray|null;let lastEnd=0;while((m=BLOCK_RE.exec(text))!==null){claim({name:m[1],args:parseBody(m[2]),start:m.index,end:m.index+m[0].length,explicit:true});lastEnd=m.index+m[0].length;}const tail=text.slice(lastEnd);if(!/\[\/TOOL\]/i.test(tail)){const um=OPEN_UNCLOSED_RE.exec(tail);if(um&&!hasUnclosedBeginArg(um[2]))claim({name:um[1],args:parseBody(um[2]),start:lastEnd+um.index,end:text.length,explicit:true});}}
/** Hybrid format: <|tool_call>...[/TOOL] or <|tool_call>call:name{json} — local models mix XML open with bracket close or inline JSON. */
function collectHybridTags(text:string,known:(n:string)=>boolean,claim:(m:RawMatch)=>void):void{
  // Variant 1: <|tool_call>...[/TOOL] (bracket close)
  {
    const re=/<\|?(?:tool_call|function_call|tool)\|?>\s*([\s\S]*?)\s*\[\/TOOL\]/gi;
    let m:RegExpExecArray|null;
    while((m=re.exec(text))!==null){
      const inner=m[1].trim();
      let call=jsonToCall(safeJson(inner));
      if(!call){
        const body=parseBody(inner);
        const rawCall=(body.call as string)||(body.name as string)||(body.tool as string);
        if(rawCall&&known(rawCall.replace(/^call:/," ").trim())){
          const name=rawCall.replace(/^call:/," ").trim().toLowerCase();
          const args={...body};delete(args as any).call;delete(args as any).name;delete(args as any).tool;
          call={name,args};
        }else{
          const found=inner.match(/\b(?:list_dir|list_files|read_file|write_file|write_to_file|edit_file|replace_in_file|find_files|find_file|search_code|search_files|get_diagnostics|code_outline|run_command|execute_command|move_path|todo_write|todo|think|web_search|web_fetch)\b/i);
          if(found&&known(found[0]))call={name:found[0].toLowerCase(),args:parseBody(inner)};
        }
      }
      if(call&&known(call.name))claim({...call,start:m.index,end:m.index+m[0].length,explicit:true});
    }
  }
  // Variant 2: <|tool_call>call:name{json} — inline JSON without any closing tag
  {
    const re=/(?:<\|?(?:tool_call|function_call|tool)\|?>\s*)?\bcall:([a-z0-9_-]+)\s*(\{[\s\S]*?\})/gi;
    let m:RegExpExecArray|null;
    while((m=re.exec(text))!==null){
      const name=m[1].trim().toLowerCase();
      if(!known(name))continue;
      const call=jsonToCall(safeJson(m[2]));
      if(call&&known(call.name))claim({...call,start:m.index,end:m.index+m[0].length,explicit:true});
      else {
        // Try parsing the JSON args directly
        const args=safeJson(m[2]);
        if(args&&typeof args==="object"&&!Array.isArray(args))claim({name,args:args as Record<string,unknown>,start:m.index,end:m.index+m[0].length,explicit:true});
      }
    }
  }
}
function collectPipeUnclosed(text:string,known:(n:string)=>boolean,claim:(m:RawMatch)=>void):void{
  // Only skip if a proper XML close exists — bracket [/TOOL] is handled by collectHybridTags
  if(/<\/(?:tool_call|function_call|tool)\|?>/i.test(text))return;
  const re=/<\|?(?:tool_call|function_call|tool)\|?>\s*([\s\S]*)$/i;const m=re.exec(text);if(!m)return;
  const inner=m[1].trim();
  // Try JSON first (handles <|tool_call>call:web_fetch{url: "..."})
  const jsonCall=jsonToCall(safeJson(inner));
  if(jsonCall&&known(jsonCall.name)){claim({...jsonCall,start:m.index,end:text.length,explicit:true});return;}
  // Try inline JSON after call: prefix
  const inlineJson=inner.match(/^call:([a-z0-9_-]+)\s*(\{[\s\S]*\})/i);
  if(inlineJson&&known(inlineJson[1].toLowerCase())){
    const args=safeJson(inlineJson[2]);
    if(args&&typeof args==="object"&&!Array.isArray(args)){claim({name:inlineJson[1].toLowerCase(),args:args as Record<string,unknown>,start:m.index,end:text.length,explicit:true});return;}
  }
  if(hasUnclosedBeginArg(inner))return;
  const body=parseBody(inner);const rawCall=(body.call as string)||(body.name as string);const cand=rawCall?rawCall.replace(/^call:/," ").trim().toLowerCase():"";if(cand&&known(cand)){claim({name:cand,args:{...body,call:undefined as any},start:m.index,end:text.length,explicit:true});return;}const found=inner.match(/\b(?:list_dir|list_files|read_file|write_file|write_to_file|edit_file|replace_in_file|find_files|find_file|search_code|search_files|get_diagnostics|code_outline|run_command|execute_command|move_path|todo_write|todo|think|web_search|web_fetch)\b/i);if(found&&known(found[0]))claim({name:found[0].toLowerCase(),args:parseBody(inner),start:m.index,end:text.length,explicit:true});}
/** `TOOL_NAME:` blocks — the PRIMARY format renderToolInstructions teaches
 *  (```tool fence, BEGIN_ARG/END_ARG body). Also accepts the same body with a
 *  bracket header or no fence at all, since weak local models drop markers.
 *  Without this collector those responses parsed to zero calls, so the turn
 *  ended as plain text with no tool card in the chat. */
function collectToolNameBlocks(text:string,claim:(m:RawMatch)=>void):void{
  const fence=/```(?:tool|tool_code|tool_call)[ \t]*\r?\n([\s\S]*?)```/gi;
  let m:RegExpExecArray|null;
  while((m=fence.exec(text))!==null){
    const name=toolNameIn(m[1]);
    if(!name)continue;
    claim({name,args:parseBody(m[1]),start:m.index,end:m.index+m[0].length,explicit:true});
  }
  const nonToolFences=findNonToolCodeFenceRanges(text);
  const bare=/^[ \t]*TOOL_NAME[ \t]*:[ \t]*\S.*$/gim;
  while((m=bare.exec(text))!==null){
    const start=m.index;
    if(overlaps(start,start+m[0].length,nonToolFences))continue;
    const end=bareToolBlockEnd(text,start);
    if(end<=start)continue;
    const name=toolNameIn(text.slice(start,end));
    if(!name)continue;
    claim({name,args:parseBody(text.slice(start,end)),start,end,explicit:true});
  }
}
function toolNameIn(body:string):string|undefined{
  const m=body.match(/^[ \t]*(?:TOOL_NAME[ \t]*:[ \t]*|call:)([a-z0-9_-]+)[ \t]*$/mi);
  return m?m[1]:undefined;
}
/** End offset of an unfenced block starting at `start`. A block with arguments
 *  must contain at least one BEGIN_ARG and a closing END_ARG, otherwise it is
 *  truncated mid-call and the repair nudge should re-emit it. A zero-argument
 *  call is just the TOOL_NAME line (plus any plain `key: value` lines). */
function bareToolBlockEnd(text:string,start:number):number{
  const finish=(n:number):number=>{
    const end=Math.max(start,Math.min(n,text.length));
    return end>start&&text[end-1]==="\n"?end-1:end;
  };
  const isKv=(line:string):boolean=>/^[ \t]*[a-z0-9_-]+[ \t]*[:=]/i.test(line);
  const lines=text.slice(start).split("\n");
  let offset=0,seenName=false,seenBegin=false,open=false,lastEnd=0;
  for(const line of lines){
    const width=line.length+1;
    const isName=/^[ \t]*TOOL_NAME[ \t]*:/i.test(line);
    const isBegin=/^[ \t]*BEGIN_ARG[ \t]*:/i.test(line);
    const isEnd=/^[ \t]*END_ARG[ \t]*:?[ \t]*$/i.test(line);
    if(isName||isBegin||isEnd){
      if(isName)seenName=true;
      if(isBegin){seenBegin=true;open=true;}
      if(isEnd)open=false;
      offset+=width;
      lastEnd=offset;
      continue;
    }
    if(seenName&&!seenBegin){
      if(line.trim()===""){offset+=width;continue;}
      if(isKv(line)){offset+=width;lastEnd=offset;continue;}
      return finish(start+lastEnd);
    }
    if(!open)break;
    offset+=width;
  }
  if(!seenName||open)return -1;
  return finish(start+lastEnd);
}
function collectSysBlocks(text:string,known:(name:string)=>boolean,claim:(m:RawMatch)=>void):void{
  const re=/\[SYS\]\s*([\s\S]*?)\s*\[\/SYS\]/gi;
  let m:RegExpExecArray|null;
  while((m=re.exec(text))!==null){
    const inner=m[1].trim();
    const jCall=jsonToCall(safeJson(inner),true);
    if(jCall&&known(jCall.name)){claim({...jCall,start:m.index,end:m.index+m[0].length,explicit:true});continue;}
    const kv=inner.match(/^([a-z0-9_-]+)\s*(?::|=|\()\s*([\s\S]*?)\)?$/i);
    if(kv&&known(kv[1])){
      const name=kv[1].trim().toLowerCase();
      const rhs=kv[2].trim();
      const rhsJson=safeJson(rhs);
      if(rhsJson&&typeof rhsJson==="object"&&!Array.isArray(rhsJson)){
        claim({name,args:rhsJson as Record<string,unknown>,start:m.index,end:m.index+m[0].length,explicit:true});
      }else{
        claim({name,args:{__positional:stripQuotes(rhs)},start:m.index,end:m.index+m[0].length,explicit:true});
      }
    }
  }
}
function collectXmlTags(text:string,known:(name:string)=>boolean,claim:(m:RawMatch)=>void):void{const re=/<\|?(?:tool_call|function_call|tool)\|?>\s*([\s\S]*?)\s*<\|?\/(?:tool_call|function_call|tool)\|?>/gi;let m:RegExpExecArray|null;while((m=re.exec(text))!==null){const inner=m[1].trim();let call=jsonToCall(safeJson(inner));if(!call){const body=parseBody(inner);const rawCall=(body.call as string)||(body.name as string)||(body.tool as string);if(rawCall&&known(rawCall)){const name=rawCall.replace(/^call:/," ").trim().toLowerCase();const args={...body};delete(args as any).call;delete(args as any).name;delete(args as any).tool;call={name,args};}else{const found=inner.match(/\b(?:list_dir|list_files|read_file|write_file|write_to_file|edit_file|replace_in_file|find_files|find_file|search_code|search_files|get_diagnostics|code_outline|run_command|execute_command|move_path|todo_write|todo|think|web_search|web_fetch)\b/i);if(found&&known(found[0]))call={name:found[0].toLowerCase(),args:parseBody(inner)};}}if(call&&known(call.name))claim({...call,start:m.index,end:m.index+m[0].length,explicit:true});}}
function collectJsonFences(text:string,known:(name:string)=>boolean,claim:(m:RawMatch)=>void):void{const re=/```(json|tool_call|tool|tool_code)?[ \t]*\r?\n([\s\S]*?)```/gi;let m:RegExpExecArray|null;while((m=re.exec(text))!==null){const lang=(m[1]||"").toLowerCase();const isExplicitToolFence=lang==="tool"||lang==="tool_call"||lang==="tool_code";const call=jsonToCall(safeJson(m[2]),isExplicitToolFence);if(call&&known(call.name))claim({...call,start:m.index,end:m.index+m[0].length,explicit:isExplicitToolFence});}}
function collectBareJson(text:string,known:(name:string)=>boolean,claim:(m:RawMatch)=>void):void{
  const nonToolFences=findNonToolCodeFenceRanges(text);
  scanBalancedJson(text,(obj,start,end)=>{
    if(overlaps(start,end,nonToolFences))return;
    const call=jsonToCall(obj,false);
    if(!call||!known(call.name))return;
    let claimStart=start;
    let claimEnd=end;
    let beforeIdx=claimStart-1;
    while(beforeIdx>=0&&/[ \t]/.test(text[beforeIdx]))beforeIdx--;
    let afterIdx=claimEnd;
    while(afterIdx<text.length&&/[ \t]/.test(text[afterIdx]))afterIdx++;
    if(beforeIdx>=0&&text[beforeIdx]==="["&&afterIdx<text.length&&text[afterIdx]==="]"){
      claimStart=beforeIdx;
      claimEnd=afterIdx+1;
    }
    // Merge split adjacent JSON: e.g. [{"name":"web_search"}]{"query":"Mysore weather today"}
    if(Object.keys(call.args).length===0){
      let nextBrace=claimEnd;
      while(nextBrace<text.length&&/[ \t\r\n]/.test(text[nextBrace]))nextBrace++;
      if(nextBrace<text.length&&text[nextBrace]==="{"){
        const nextEnd=matchBrace(text,nextBrace);
        if(nextEnd!==-1){
          const nextObj=safeJson(text.slice(nextBrace,nextEnd+1));
          if(nextObj&&typeof nextObj==="object"&&!Array.isArray(nextObj)&&!jsonToCall(nextObj,false)){
            call.args=nextObj as Record<string,unknown>;
            claimEnd=nextEnd+1;
          }
        }
      }
    }
    claim({...call,start:claimStart,end:claimEnd,explicit:false});
  });
}
function resolvePositionalAndAliases(canonical:string,spec:ToolSpec,rawArgs:Record<string,unknown>):Record<string,unknown>{
  const aliases=PARAM_ALIASES[canonical]??{};
  const resolved:Record<string,unknown>={...rawArgs};
  for(const[alias,target]of Object.entries(aliases)){
    if(alias in resolved&&!(target in resolved)){
      resolved[target]=resolved[alias];
      delete resolved[alias];
    }
  }
  if(canonical==="edit_file"){
    const hasOldStr=spec.params.some(p=>p.name==="old_str");
    if(hasOldStr){
      if("find" in resolved&&!("old_str" in resolved)){resolved.old_str=resolved.find;delete resolved.find;}
      if("replace" in resolved&&!("new_str" in resolved)){resolved.new_str=resolved.replace;delete resolved.replace;}
    }else{
      if("old_str" in resolved&&!("find" in resolved)){resolved.find=resolved.old_str;delete resolved.old_str;}
      if("new_str" in resolved&&!("replace" in resolved)){resolved.replace=resolved.new_str;delete resolved.new_str;}
    }
  }
  if(canonical==="find_files"&&!spec.params.some(p=>p.name==="pattern")&&spec.params.some(p=>p.name==="query")){
    if("pattern" in resolved&&!("query" in resolved)){resolved.query=resolved.pattern;delete resolved.pattern;}
  }
  const paramNames=new Set(spec.params.map(p=>p.name));
  // If the model used the tool name itself as the key (e.g. `web_search: "Mysore weather today"`), treat it as positional
  if(canonical in resolved&&!paramNames.has(canonical)&&typeof resolved[canonical]==="string"&&!resolved.__positional){
    resolved.__positional=resolved[canonical];
    delete resolved[canonical];
  }
  const missingReq=spec.params.filter(p=>p.required&&(!(p.name in resolved)||resolved[p.name]===undefined||resolved[p.name]===null||resolved[p.name]===""));
  if(missingReq.length===1&&missingReq[0].type==="string"){
    const targetParam=missingReq[0].name;
    if(typeof resolved.__positional==="string"&&resolved.__positional.trim()!==""){
      resolved[targetParam]=resolved.__positional.trim();
    }else{
      // Check for BEGIN_ARG: <value directly on header line>\nEND_ARG which produces resolved[value] = ""
      for(const[k,v]of Object.entries(resolved)){
        if(k.startsWith("__")||paramNames.has(k)||k.toLowerCase()===canonical.toLowerCase()||/^(?:tool_name|call|name|tool|type|function)$/i.test(k))continue;
        if((v===""||v===undefined)&&k.trim().length>0){
          resolved[targetParam]=stripQuotes(k.trim());
          delete resolved[k];
          break;
        }
      }
    }
  }
  delete resolved.__positional;
  return resolved;
}
function finalizeCall(rawName:string,args:Record<string,unknown>,raw:string,specByName:Map<string,ToolSpec>,specs:ToolSpec[],explicit:boolean):ParsedCall|null{const canonical=canonicalToolName(rawName,specs);if(!canonical)return explicit?{name:rawName.trim(),args,raw,errors:[`Unknown tool "${rawName.trim()}".`]}:null;const spec=specByName.get(canonical.toLowerCase());if(!spec)return null;
  const resolved=resolvePositionalAndAliases(canonical,spec,args);
  const validated=coerceArgs(spec,resolved);return{name:spec.name,args:validated.args,raw,errors:validated.errors};}
export function validateAgainstSpec(name:string,rawArgs:Record<string,unknown>,specs:ToolSpec):{args:Record<string,unknown>;errors:string[]};
export function validateAgainstSpec(name:string,rawArgs:Record<string,unknown>,specs:ToolSpec[]):{args:Record<string,unknown>;errors:string[]};
export function validateAgainstSpec(name:string,rawArgs:Record<string,unknown>,specs:ToolSpec|ToolSpec[]):{args:Record<string,unknown>;errors:string[]}{const list=Array.isArray(specs)?specs:[specs];const canonical=canonicalToolName(name,list);if(!canonical)return{args:rawArgs,errors:[`Unknown tool "${name}".`]};const spec=list.find(s=>s.name===canonical);if(!spec)return{args:rawArgs,errors:[`Unknown tool "${name}".`]};
  const resolved=resolvePositionalAndAliases(canonical,spec,rawArgs);
  return coerceArgs(spec,resolved);}
function coerceArgs(spec:ToolSpec,args:Record<string,unknown>):{args:Record<string,unknown>;errors:string[]}{const coerced:Record<string,unknown>={};const errors:string[]=[];for(const p of spec.params){if(!(p.name in args)||args[p.name]===undefined||args[p.name]===null){if(p.required)errors.push(`Missing required argument "${p.name}".`);continue;}const [value,error]=coerce(args[p.name],p.type);if(error)errors.push(`Argument "${p.name}": ${error}`);else coerced[p.name]=value;}return{args:coerced,errors};}
function coerce(value:unknown,type:ToolSpec["params"][number]["type"]):[unknown,string|null]{if(type==="string")return[typeof value==="string"?value:String(value),null];if(type==="number"||type==="integer"){const n=typeof value==="number"?value:Number(String(value).trim());if(!Number.isFinite(n))return[undefined,`expected a number, got "${String(value)}"`];if(type==="integer"&&!Number.isInteger(n))return[undefined,`expected an integer, got "${String(value)}"`];return[n,null];}if(type==="boolean"){if(typeof value==="boolean")return[value,null];const s=String(value).trim();if(/^(true|yes|1)$/i.test(s))return[true,null];if(/^(false|no|0)$/i.test(s))return[false,null];return[undefined,`expected true/false, got "${s}"`];}if(type==="null")return value===null?[null,null]:[undefined,"expected null"];if(type==="array"){if(Array.isArray(value))return[value,null];if(typeof value!=="string")return[undefined,"expected a JSON array"];const parsed=safeJson(value);return Array.isArray(parsed)?[parsed,null]:[undefined,"expected a JSON array string"];}if(type==="object"){if(value&&typeof value==="object"&&!Array.isArray(value))return[value,null];if(typeof value!=="string")return[undefined,"expected a JSON object"];const parsed=safeJson(value);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?[parsed,null]:[undefined,"expected a JSON object string"];}return[undefined,"unsupported argument type"];}
const AMBIGUOUS_CONVERSATIONAL_ALIASES=new Set(["read","view","show","move","todo","grep"]);
const JSON_TOOL_META_KEYS=new Set(["tool","tool_name","name","function","type","action","id","call_id","description","parameters","arguments","args","input","required","properties"]);
function isJsonSchemaObject(v:unknown):boolean{
  if(!v||typeof v!=="object"||Array.isArray(v))return false;
  const o=v as Record<string,unknown>;
  return o.type==="object"&&Boolean(o.properties&&typeof o.properties==="object");
}
function extractArgsFromEchoedSchema(schemaObj:Record<string,unknown>):Record<string,unknown>{
  const out:Record<string,unknown>={};
  const props=schemaObj.properties;
  if(!props||typeof props!=="object"||Array.isArray(props))return out;
  const BUILTIN_EXAMPLES=new Set(["vite react plugin options","https://example.com"]);
  for(const[k,v]of Object.entries(props as Record<string,unknown>)){
    if(!v||typeof v!=="object"||Array.isArray(v))continue;
    const p=v as Record<string,unknown>;
    if(typeof p.value==="string"&&p.value.trim())out[k]=p.value.trim();
    else if(typeof p.default==="string"&&p.default.trim())out[k]=p.default.trim();
    else if(typeof p.description==="string"){
      const ex=p.description.match(/Example:\s*"([^"]+)"/i);
      if(ex&&ex[1].trim()&&!BUILTIN_EXAMPLES.has(ex[1].trim()))out[k]=ex[1].trim();
    }
  }
  return out;
}
function jsonToCall(obj:unknown,explicit=true):{name:string;args:Record<string,unknown>}|null{
  if(!obj||typeof obj!=="object"||Array.isArray(obj))return null;
  const o=obj as Record<string,unknown>;
  const fn=(o.function&&typeof o.function==="object"?o.function:{}) as Record<string,unknown>;
  const hasExplicitToolField=typeof o.tool==="string"||typeof o.tool_name==="string"||typeof fn.name==="string";
  const hasArgsEnvelope="arguments" in o||"args" in o||"parameters" in o||"input" in o||"arguments" in fn||"parameters" in fn;
  const hasTopLevelKnownArg="query" in o||"url" in o||"path" in o||"command" in o||"pattern" in o;
  if(!explicit&&!hasExplicitToolField&&!hasArgsEnvelope&&!hasTopLevelKnownArg)return null;
  const name=o.tool??o.tool_name??fn.name??o.name??(explicit?o.action:undefined);
  if(typeof name!=="string"||!name)return null;
  if(!explicit&&!hasExplicitToolField&&AMBIGUOUS_CONVERSATIONAL_ALIASES.has(name.trim().toLowerCase()))return null;
  let rawArgs=o.arguments??o.args??o.parameters??o.input??fn.arguments??fn.parameters;
  let args:Record<string,unknown>={};
  if(typeof rawArgs==="string"){
    const parsed=safeJson(rawArgs);
    if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))args=parsed as Record<string,unknown>;
    else if(rawArgs.trim())args={__positional:stripQuotes(rawArgs.trim())};
  }else if(isJsonSchemaObject(rawArgs)){
    args=extractArgsFromEchoedSchema(rawArgs as Record<string,unknown>);
  }else if(rawArgs&&typeof rawArgs==="object"&&!Array.isArray(rawArgs)){
    args={...(rawArgs as Record<string,unknown>)};
  }
  if(Object.keys(args).length===0){
    for(const[k,v]of Object.entries(o)){
      if(!JSON_TOOL_META_KEYS.has(k)&&v!==undefined)args[k]=v;
    }
    for(const[k,v]of Object.entries(fn)){
      if(!JSON_TOOL_META_KEYS.has(k)&&v!==undefined&&!(k in args))args[k]=v;
    }
  }
  return{name,args};
}
function safeJson(s:string):unknown{
  try{return JSON.parse(s.trim());}catch{
    try{
      const relaxed=s.trim()
        .replace(/,\s*([}\]])/g,"$1")
        .replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g,'$1"$2":');
      return JSON.parse(relaxed);
    }catch{
      return null;
    }
  }
}
const MAX_BRACE_ATTEMPTS=200;function scanBalancedJson(text:string,onObject:(obj:unknown,start:number,end:number)=>void):void{let i=0,scanned=0,attempts=0;while(i<text.length&&scanned<50&&attempts<MAX_BRACE_ATTEMPTS){if(text[i]==="{"){attempts++;const end=matchBrace(text,i);if(end!==-1){const obj=safeJson(text.slice(i,end+1));if(obj)onObject(obj,i,end+1);scanned++;i=end+1;continue;}}i++;}}
function matchBrace(text:string,start:number):number{let depth=0,inStr=false,esc=false;for(let i=start;i<text.length;i++){const c=text[i];if(inStr){if(esc)esc=false;else if(c==="\\")esc=true;else if(c==='"')inStr=false;}else if(c==='"')inStr=true;else if(c==="{")depth++;else if(c=== "}"){depth--;if(depth===0)return i;}}return -1;}
/** Common parameter name variants local models emit. Expanded for low-end models that use many synonyms. */
const PARAM_ALIASES:Record<string,Record<string,string>>={
  web_search:{q:"query",search_query:"query",search:"query",term:"query",keywords:"query"},
  web_fetch:{link:"url",page_url:"url",page:"url",target:"url",href:"url",path:"url",file:"url",location:"url"},
  edit_file:{old_text:"find",original:"find",from:"find",old:"find",new_text:"replace",replacement:"replace",to:"replace",new:"replace",file:"path",filepath:"path",file_path:"path",filename:"path",file_name:"path",target:"path",destination:"path"},
  write_file:{file_content:"content",code:"content",data:"content",text:"content",body:"content",file:"content",value:"content",file_data:"content",filepath:"path",file_path:"path",filename:"path",file_name:"path",target:"path",destination:"path",path_name:"path"},
  read_file:{file:"path",filepath:"path",file_path:"path",filename:"path",file_name:"path",target:"path",destination:"path"},
  list_dir:{file:"path",filepath:"path",file_path:"path",directory:"path",dir:"path",folder:"path"},
  find_files:{file:"pattern",filename:"pattern",name:"pattern",query:"pattern",glob:"pattern"},
  search_code:{term:"query",text:"query",pattern:"query",keyword:"query",q:"query"},
  run_command:{cmd:"command",shell:"command",shell_command:"command",command_line:"command",exec:"command"},
};

/** Parse a tool-call body. The PRIMARY format (see renderToolInstructions)
 *  wraps each argument in BEGIN_ARG/END_ARG so values may contain colons,
 *  fences and blank lines without being mistaken for other arguments. Those
 *  blocks are extracted first; the remaining `key: value` lines (and markers
 *  like `call:`) still go through the classic flat parser. */
function parseBody(body:string):Record<string,string>{
  if(/^[ \t]*BEGIN_ARG[ \t]*:/im.test(body)){
    const {args,rest}=extractBeginArgArgs(body);
    return {...parseKvBody(rest),...args};
  }
  return parseKvBody(body);
}
/** Pull every BEGIN_ARG name/value pair out of `body`; everything else is
 *  returned untouched so the flat parser can still see it. */
function extractBeginArgArgs(body:string):{args:Record<string,string>;rest:string}{
  const lines=body.replace(/\r\n/g,"\n").split("\n");
  const args:Record<string,string>={};
  const rest:string[]=[];
  let i=0;
  while(i<lines.length){
    const open=lines[i].match(/^[ \t]*BEGIN_ARG[ \t]*:[ \t]*(.*)$/i);
    if(!open){rest.push(lines[i]);i++;continue;}
    let key=open[1].trim();
    i++;
    // Tolerate `BEGIN_ARG:` with the argument name on the next line.
    if(!key){
      while(i<lines.length&&lines[i].trim()==="")i++;
      if(i<lines.length&&!/^[ \t]*END_ARG/i.test(lines[i])){key=lines[i].trim();i++;}
    }
    const value:string[]=[];
    while(i<lines.length&&!/^[ \t]*END_ARG[ \t]*:?[ \t]*$/i.test(lines[i])){
      const unescaped=lines[i].replace(/^([ \t]*)\\(END_ARG|BEGIN_ARG)\b/i,"$1$2");
      value.push(unescaped);
      i++;
    }
    if(i<lines.length)i++;
    const joined=value.join("\n").replace(/^\n+|\n+$/g,"");
    if(key){
      if(joined.trim()===""){
        const inlineKv=key.match(/^([a-zA-Z0-9_-]+)\s*[:=]\s*(.+)$/);
        if(inlineKv){
          const k=inlineKv[1].trim();
          const v=stripQuotes(inlineKv[2].trim());
          args[k]=sanitizeEditValue(k,v);
        }else{
          args[key]="";
          if(!args.__positional)args.__positional=stripQuotes(key);
        }
      }else{
        args[key]=sanitizeEditValue(key,joined);
      }
    }
  }
  return {args,rest:rest.join("\n")};
}
function parseKvBody(body:string):Record<string,string>{const args:Record<string,string>={};const lines=body.replace(/\r\n/g,"\n").split("\n");let i=0;while(i<lines.length){const line=lines[i];const kv=line.match(/^\s*([a-zA-Z0-9_-]+)\s*[:=]\s*(.*)$/);if(!kv){i++;continue;}const key=kv[1].trim();let value=kv[2].trim();
  // YAML-style block scalar: "content: |" means multi-line content follows on
  // subsequent (indented) lines. Local models commonly emit this pattern.
  // Also handle "content: >" (folded) and bare "content:" with no value.
  // Small models also emit stray symbols like "content: |>" or "content: |-" — strip those too.
  if(/^[\|\>][\-\+]?$/.test(value)&&( /^(content|find|replace|old_str|new_str|text|body)$/i.test(key) )){value="";}
  if(value===""){let j=i+1;while(j<lines.length&&lines[j].trim()==="")j++;const fence=lines[j]?.match(/^\s*(```+|~~~+)(.*)$/);if(fence){const marker=fence[1];const collected:string[]=[];j++;while(j<lines.length&&!lines[j].trimStart().startsWith(marker)){collected.push(lines[j]);j++;}value=collected.join("\n");i=j+1;args[key]=sanitizeEditValue(key,value);continue;}if(/^(content|find|replace|old_str|new_str|text|body)$/i.test(key)){const collected:string[]=[];j=i+1;while(j<lines.length){if(/^\s*\[\/TOOL\]/i.test(lines[j]))break;if(/^\s*[a-zA-Z0-9_-]+\s*[:=]\s*/.test(lines[j])&&!/^(content|find|replace|old_str|new_str)/i.test(lines[j].trim()))break;collected.push(lines[j]);j++;}if(collected.join("\n").trim()){const tail=collected.join("\n").replace(/^\n+|\n+$/g,"");if(tail.trim()){value=sanitizeEditValue(key,tail);i=j;args[key]=value;continue;}}}}args[key]=sanitizeEditValue(key,stripQuotes(value));i++;}return args;}
/** Strip stray leading/trailing symbols small models add to find/replace/content. */
function sanitizeEditValue(key:string,value:string):string{
  if(!/^(content|find|replace|old_str|new_str)$/i.test(key))return value;
  // Remove stray leading/trailing pipe, >, or bullet characters on their own line
  let lines=value.split("\n");
  // Strip leading/trailing lines that are just symbols
  while(lines.length&&/^[\|\>\-\*\•\·\s]+$/.test(lines[0]))lines.shift();
  while(lines.length&&/^[\|\>\-\*\•\·\s]+$/.test(lines[lines.length-1]))lines.pop();
  // Strip gutter artifacts small models copy from read_file output
  const gutterRe=/^\s*\d+\s*[│|]\s?/;
  const nonBlank=lines.filter(l=>l.trim()!=="");
  if(nonBlank.length>0&&nonBlank.every(l=>gutterRe.test(l))){
    lines=lines.map(l=>l.replace(gutterRe,""));
  }
  return lines.join("\n");
}
function stripQuotes(v:string):string{return v.length>=2&&((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))?v.slice(1,-1):v;}
function overlaps(a:number,b:number,ranges:[number,number][]):boolean{return ranges.some(([x,y])=>a<y&&b>x);}
function stripRanges(text:string,ranges:[number,number][]):string{if(!ranges.length)return text;let out="",cursor=0;for(const [s,e] of ranges.sort((a,b)=>a[0]-b[0])){out+=text.slice(cursor,s);cursor=Math.max(cursor,e);}return out+text.slice(cursor);}
export function stripToolMarkup(text:string):string{
  return text
    .replace(/\[SYS\][\s\S]*?\[\/SYS\]/gi, "")
    .replace(/```(?:json|tool|tool_call|tool_code)?[ \t]*\r?\n[\s\S]*?(?:"type"\s*:\s*"(?:function|web_search|web_fetch|read_file|list_dir|find_files|search_code|edit_file|write_file|run_command)"|"function"\s*:\s*\{|"tool_name"\s*:|TOOL_NAME\s*:)[\s\S]*?```/gi, "")
    .replace(/<\|?tool_call[\s\S]*?(?:END_ARG|<\/\|?tool_call>|$)/gi, "")
    .replace(/\[\/(?:RESULT|ERROR)\]/gi,"")
    .replace(/\[(?:RESULT|ERROR)\s+[^\]]+\]/gi,"")
    .replace(/<\/?(?:tool_call|function_call|tool)\b[^>]*>/gi,"")
    .replace(/<\|(?:tool_call|tool_response|start_of_turn|end_of_turn|im_start|im_end)\|?>/gi, "")
    .replace(/\[\s*\{\s*"(?:name|tool|tool_name|type|function)"[\s\S]*$/gi, "")
    .replace(/\{\s*"(?:type|tool|tool_name|function)"\s*:\s*(?:"function"|\{)[\s\S]*$/gi, "")
    .replace(/^[ \t]*\[\s*\](?:[ \t]*\{[^{}\n]*\})?[ \t]*$/gm, "")
    .replace(/\bEND_ARG\b/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
