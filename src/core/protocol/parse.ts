import type { ToolSpec } from "../../shared/types";
import { BLOCK_RE, OPEN_UNCLOSED_RE } from "./format";

export interface ParsedCall{name:string;args:Record<string,unknown>;raw:string;errors:string[];}
export interface ParseResult{calls:ParsedCall[];cleanedText:string;}
interface RawMatch{name:string;args:Record<string,unknown>;start:number;end:number;explicit:boolean;}

const TOOL_ALIASES:Record<string,string>={
  list_files:"list_dir",list_directory:"list_dir",search_files:"search_code",grep:"search_code",find_file:"find_files",
  read_file_contents:"read_file",write_to_file:"write_file",create_file:"write_file",replace_in_file:"edit_file",
  edit_file_contents:"edit_file",execute_command:"run_command",run_shell_command:"run_command",diagnostics:"get_diagnostics",
  get_errors:"get_diagnostics",move:"move_path",rename_file:"move_path",todo:"todo_write",
};
const MULTILINE_KEYS=/^(content|find|replace|text|body|patch|code|query)$/i;

export function canonicalToolName(rawName:string,specs:ToolSpec[]):string|undefined{
  const raw=String(rawName).trim().toLowerCase();
  const exact=specs.find(s=>s.name.toLowerCase()===raw)?.name;
  if(exact)return exact;
  const alias=TOOL_ALIASES[raw];
  return alias?specs.find(s=>s.name.toLowerCase()===alias)?.name:undefined;
}

export function parsePhotonBlocks(text:string,specs:ToolSpec[]):ParseResult{
  const specByName=new Map(specs.map(s=>[s.name.toLowerCase(),s]));
  const findSpec=(name:string)=>{const c=canonicalToolName(name,specs);return c?specByName.get(c.toLowerCase()):undefined;};
  const consumed:[number,number][]=[];const raws:RawMatch[]=[];
  const claim=(m:RawMatch)=>{if(overlaps(m.start,m.end,consumed))return;consumed.push([m.start,m.end]);raws.push(m);};
  const known=(name:string)=>!!findSpec(name);
  collectBlockTags(text,findSpec,claim);
  collectXmlTags(text,findSpec,known,claim);
  collectPipeUnclosed(text,findSpec,known,claim);
  collectJsonFences(text,known,claim);
  collectBareJson(text,known,claim);
  const calls=raws.sort((a,b)=>a.start-b.start).map(m=>finalizeCall(m.name,m.args,text.slice(m.start,m.end),specByName,specs,m.explicit)).filter((c):c is ParsedCall=>c!==null);
  return{calls,cleanedText:stripToolMarkup(stripRanges(text,consumed))};
}

function collectBlockTags(text:string,findSpec:(name:string)=>ToolSpec|undefined,claim:(m:RawMatch)=>void):void{
  BLOCK_RE.lastIndex=0;let m:RegExpExecArray|null;let lastEnd=0;
  while((m=BLOCK_RE.exec(text))!==null){claim({name:m[1],args:parseBody(m[2],findSpec(m[1])),start:m.index,end:m.index+m[0].length,explicit:true});lastEnd=m.index+m[0].length;}
  const tail=text.slice(lastEnd);
  if(!/\[\/TOOL\]/i.test(tail)){const um=OPEN_UNCLOSED_RE.exec(tail);if(um)claim({name:um[1],args:parseBody(um[2],findSpec(um[1])),start:lastEnd+um.index,end:text.length,explicit:true});}
}

function collectPipeUnclosed(text:string,findSpec:(name:string)=>ToolSpec|undefined,known:(name:string)=>boolean,claim:(m:RawMatch)=>void):void{
  if(/<\/(?:tool_call|function_call|tool)\|?>/i.test(text))return;
  const re=/<\|?(?:tool_call|function_call|tool)\|?>\s*([\s\S]*)$/i;const m=re.exec(text);if(!m)return;
  const inner=m[1].trim();const rough=parseBody(inner);const rawCall=(rough.call as string)||(rough.name as string)||(rough.tool as string);
  const cand=rawCall?rawCall.replace(/^call:/i,"").trim():"";
  if(cand&&known(cand)){
    const body=parseBody(inner,findSpec(cand));delete(body.call);delete(body.name);delete(body.tool);
    claim({name:cand,args:body,start:m.index,end:text.length,explicit:true});return;
  }
  const found=inner.match(/\b(?:list_dir|list_files|read_file|write_file|write_to_file|edit_file|replace_in_file|find_files|find_file|search_code|search_files|get_diagnostics|code_outline|run_command|execute_command|move_path|todo_write|todo|think|web_search|web_fetch)\b/i);
  if(found&&known(found[0]))claim({name:found[0],args:parseBody(inner,findSpec(found[0])),start:m.index,end:text.length,explicit:true});
}

function collectXmlTags(text:string,findSpec:(name:string)=>ToolSpec|undefined,known:(name:string)=>boolean,claim:(m:RawMatch)=>void):void{
  const re=/<\|?(?:tool_call|function_call|tool)\|?>\s*([\s\S]*?)\s*<\|?\/(?:tool_call|function_call|tool)\|?>/gi;let m:RegExpExecArray|null;
  while((m=re.exec(text))!==null){
    const inner=m[1].trim();let call=jsonToCall(safeJson(inner));
    if(!call){const rough=parseBody(inner);const rawCall=(rough.call as string)||(rough.name as string)||(rough.tool as string);if(rawCall&&known(rawCall)){const name=rawCall.replace(/^call:/i,"").trim();const body=parseBody(inner,findSpec(name));delete(body.call);delete(body.name);delete(body.tool);call={name,args:body};}else{const found=inner.match(/\b(?:list_dir|list_files|read_file|write_file|write_to_file|edit_file|replace_in_file|find_files|find_file|search_code|search_files|get_diagnostics|code_outline|run_command|execute_command|move_path|todo_write|todo|think|web_search|web_fetch)\b/i);if(found&&known(found[0]))call={name:found[0],args:parseBody(inner,findSpec(found[0]))};}}
    if(call&&known(call.name))claim({...call,start:m.index,end:m.index+m[0].length,explicit:true});
  }
}

function collectJsonFences(text:string,known:(name:string)=>boolean,claim:(m:RawMatch)=>void):void{
  const re=/```(?:json|tool_call|tool|tool_code)?\s*\n?([\s\S]*?)```/gi;let m:RegExpExecArray|null;
  while((m=re.exec(text))!==null){const call=jsonToCall(safeJson(m[1]));if(call&&known(call.name))claim({...call,start:m.index,end:m.index+m[0].length,explicit:false});}
}
function collectBareJson(text:string,known:(name:string)=>boolean,claim:(m:RawMatch)=>void):void{
  scanBalancedJson(text,(obj,start,end)=>{const call=jsonToCall(obj);if(call&&known(call.name))claim({...call,start,end,explicit:false});});
}
function finalizeCall(rawName:string,args:Record<string,unknown>,raw:string,specByName:Map<string,ToolSpec>,specs:ToolSpec[],explicit:boolean):ParsedCall|null{
  const canonical=canonicalToolName(rawName,specs);if(!canonical)return explicit?{name:rawName.trim(),args,raw,errors:[`Unknown tool "${rawName.trim()}".`]}:null;
  const spec=specByName.get(canonical.toLowerCase());if(!spec)return null;const validated=coerceArgs(spec,args);return{name:spec.name,args:validated.args,raw,errors:validated.errors};
}
export function validateAgainstSpec(name:string,rawArgs:Record<string,unknown>,specs:ToolSpec):{args:Record<string,unknown>;errors:string[]};
export function validateAgainstSpec(name:string,rawArgs:Record<string,unknown>,specs:ToolSpec[]):{args:Record<string,unknown>;errors:string[]};
export function validateAgainstSpec(name:string,rawArgs:Record<string,unknown>,specs:ToolSpec|ToolSpec[]):{args:Record<string,unknown>;errors:string[]}{
  const list=Array.isArray(specs)?specs:[specs];const canonical=canonicalToolName(name,list);if(!canonical)return{args:rawArgs,errors:[`Unknown tool "${name}".`]};
  const spec=list.find(s=>s.name===canonical);return spec?coerceArgs(spec,rawArgs):{args:rawArgs,errors:[`Unknown tool "${name}".`]};
}
function coerceArgs(spec:ToolSpec,args:Record<string,unknown>):{args:Record<string,unknown>;errors:string[]}{
  const coerced:Record<string,unknown>={};const errors:string[]=[];
  for(const p of spec.params){if(!(p.name in args)||args[p.name]===undefined||args[p.name]===null){if(p.required)errors.push(`Missing required argument "${p.name}".`);continue;}const [value,error]=coerce(args[p.name],p.type);if(error)errors.push(`Argument "${p.name}": ${error}`);else coerced[p.name]=value;}
  return{args:coerced,errors};
}
function coerce(value:unknown,type:ToolSpec["params"][number]["type"]):[unknown,string|null]{
  if(type==="string")return[typeof value==="string"?value:String(value),null];
  if(type==="number"||type==="integer"){const n=typeof value==="number"?value:Number(String(value).trim());if(!Number.isFinite(n))return[undefined,`expected a number, got "${String(value)}"`];if(type==="integer"&&!Number.isInteger(n))return[undefined,`expected an integer, got "${String(value)}"`];return[n,null];}
  if(type==="boolean"){if(typeof value==="boolean")return[value,null];const s=String(value).trim();if(/^(true|yes|1)$/i.test(s))return[true,null];if(/^(false|no|0)$/i.test(s))return[false,null];return[undefined,`expected true/false, got "${s}"`];}
  if(type==="null")return value===null?[null,null]:[undefined,"expected null"];
  if(type==="array"){if(Array.isArray(value))return[value,null];if(typeof value!=="string")return[undefined,"expected a JSON array"];const parsed=safeJson(value);return Array.isArray(parsed)?[parsed,null]:[undefined,"expected a JSON array string"];}
  if(type==="object"){if(value&&typeof value==="object"&&!Array.isArray(value))return[value,null];if(typeof value!=="string")return[undefined,"expected a JSON object"];const parsed=safeJson(value);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?[parsed,null]:[undefined,"expected a JSON object string"];}
  return[undefined,"unsupported argument type"];
}
function jsonToCall(obj:unknown):{name:string;args:Record<string,unknown>}|null{if(!obj||typeof obj!=="object")return null;const o=obj as Record<string,unknown>;const fn=(o.function??{}) as Record<string,unknown>;const name=o.name??o.tool??o.tool_name??o.action??fn.name;if(typeof name!=="string"||!name)return null;let args=o.arguments??o.args??o.parameters??o.input??fn.arguments??{};if(typeof args==="string")args=safeJson(args)??{};if(!args||typeof args!=="object")args={};return{name,args:args as Record<string,unknown>};}
function safeJson(s:string):unknown{try{return JSON.parse(s.trim());}catch{return null;}}
const MAX_BRACE_ATTEMPTS=200;
function scanBalancedJson(text:string,onObject:(obj:unknown,start:number,end:number)=>void):void{let i=0,scanned=0,attempts=0;while(i<text.length&&scanned<50&&attempts<MAX_BRACE_ATTEMPTS){if(text[i]==="{"){attempts++;const end=matchBrace(text,i);if(end!==-1){const obj=safeJson(text.slice(i,end+1));if(obj)onObject(obj,i,end+1);scanned++;i=end+1;continue;}}i++;}}
function matchBrace(text:string,start:number):number{let depth=0,inStr=false,esc=false;for(let i=start;i<text.length;i++){const c=text[i];if(inStr){if(esc)esc=false;else if(c==="\\")esc=true;else if(c==='"')inStr=false;}else if(c==='"')inStr=true;else if(c==="{")depth++;else if(c=== "}"){depth--;if(depth===0)return i;}}return-1;}

function parseBody(body:string,spec?:ToolSpec):Record<string,string>{
  const args:Record<string,string>={};const lines=body.replace(/\r\n/g,"\n").split("\n");
  const expected=new Set((spec?.params??[]).map(p=>p.name.toLowerCase()).concat(["call","name","tool","tool_name","action"]));
  let i=0;
  while(i<lines.length){
    const segments=splitAssignments(lines[i],expected);
    if(!segments.length){i++;continue;}
    for(const {key,value} of segments){
      let val=value.trim();const isMulti=MULTILINE_KEYS.test(key);const marker=/^\|[-+]?$/.test(val);
      if((marker||val==="")&&isMulti){
        let j=i+1;while(j<lines.length&&lines[j].trim()==="")j++;
        const fence=lines[j]?.match(/^\s*(```+|~~~+)(.*)$/);
        if(fence){const markerText=fence[1];const collected:string[]=[];j++;while(j<lines.length&&!lines[j].trimStart().startsWith(markerText)){collected.push(lines[j]);j++;}val=collected.join("\n");i=j;args[key]=val;continue;}
        const collected:string[]=[];j=i+1;
        while(j<lines.length){if(/^\s*\[\/TOOL\]/i.test(lines[j]))break;const next=splitAssignments(lines[j],expected);if(next.length&&next[0].key.toLowerCase()!==key.toLowerCase())break;collected.push(lines[j]);j++;}
        val=collected.join("\n").replace(/^\n+|\n+$/g,"");i=j-1;args[key]=val;continue;
      }
      if(val.startsWith("```")&&isMulti){const opening=val.match(/^(```+|~~~+)(.*)$/);if(opening){const mark=opening[1];const first=opening[2].trimStart();const collected:string[]=[];if(first)collected.push(first);let j=i+1;while(j<lines.length&&!lines[j].trimStart().startsWith(mark)){collected.push(lines[j]);j++;}val=collected.join("\n");i=j-1;args[key]=val;continue;}}
      args[key]=stripQuotes(val);
    }
    i++;
  }
  return args;
}

function splitAssignments(line:string,expected:Set<string>):{key:string;value:string}[]{
  const out:{key:string;value:string}[]=[];const re=/(?:^|\s)([a-zA-Z0-9_-]+)\s*[:=]\s*/g;const matches=[...line.matchAll(re)].filter(m=>!expected.size||expected.has(m[1].toLowerCase()));
  if(!matches.length)return[];
  for(let i=0;i<matches.length;i++){const m=matches[i];const valueStart=(m.index??0)+m[0].length;const end=i+1<matches.length?(matches[i+1].index??line.length):line.length;out.push({key:m[1],value:line.slice(valueStart,end).trim()});}
  return out;
}
function stripQuotes(v:string):string{return v.length>=2&&((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))?v.slice(1,-1):v;}
function overlaps(a:number,b:number,ranges:[number,number][]):boolean{return ranges.some(([x,y])=>a<y&&b>x);}
function stripRanges(text:string,ranges:[number,number][]):string{if(!ranges.length)return text;let out="",cursor=0;for(const [s,e] of ranges.sort((a,b)=>a[0]-b[0])){out+=text.slice(cursor,s);cursor=Math.max(cursor,e);}return out+text.slice(cursor);}
export function stripToolMarkup(text:string):string{return text.replace(/\[\/(?:RESULT|ERROR)\]/gi,"").replace(/\[(?:RESULT|ERROR)\s+[^\]]+\]/gi,"").replace(/<\/?(?:tool_call|function_call|tool)\b[^>]*>/gi,"").trim();}
