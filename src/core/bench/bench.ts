import type { BenchResult, BenchTaskOutcome, ModelCapabilityProfile, ToolSpec } from "../../shared/types";
import type { LLMProvider, LLMChatChunk, LLMMessage } from "../llm/types";
import { parsePhotonBlocks } from "../protocol/parse";
import { estimateTokens } from "../adaptive/tokens";

export const BENCH_VERSION=2;
const BENCH_OPTS={temperature:0,top_p:1,num_ctx:4096,num_predict:220,seed:7};
const PROBE_TOOL:ToolSpec={name:"read_file",summary:"Read a file from the workspace.",params:[{name:"path",type:"string",required:true,description:"File path to read."}],sideEffecting:false,priority:1};
const TOOLCALL_ATTEMPTS=3;
export interface BenchOptions{hardwareClass:string;quantization?:string;signal?:AbortSignal;onProgress?:(message:string)=>void;}

export async function runBench(client:LLMProvider,model:string,opts:BenchOptions):Promise<BenchResult>{
  const tasks:BenchTaskOutcome[]=[];
  opts.onProgress?.("Measuring throughput and latency…");
  const speed=await generate(client,model,[{role:"user",content:"Write a TypeScript function add(a,b) that returns the sum. Code only."}],opts.signal);
  tasks.push({id:"throughput",passed:speed.tokensPerSec>0,detail:`${Math.round(speed.tokensPerSec)} tok/s, first token ${Math.round(speed.firstTokenMs)} ms`});

  opts.onProgress?.("Measuring tool-call reliability…");
  let toolPasses=0;
  for(let i=0;i<TOOLCALL_ATTEMPTS;i++){
    const out=await generate(client,model,[{role:"system",content:"Emit exactly one Photon tool block and nothing else. Use read_file with path src/index.ts."},{role:"user",content:"Read src/index.ts using the tool."}],opts.signal);
    if(parsePhotonBlocks(out.text,[PROBE_TOOL]).calls.some(c=>c.name==="read_file"&&!c.errors.length&&c.args.path==="src/index.ts"))toolPasses++;
  }
  const toolReliability=toolPasses/TOOLCALL_ATTEMPTS;
  tasks.push({id:"toolcall",passed:toolReliability>=0.67,detail:`${toolPasses}/${TOOLCALL_ATTEMPTS} well-formed calls`});
  tasks.push({id:"schema",passed:toolReliability>=0.67,detail:`schema adherence ${Math.round(toolReliability*100)}%`});

  opts.onProgress?.("Checking tool selection and recovery…");
  const select=await generate(client,model,[{role:"system",content:"Available tools: read_file, search_code, edit_file, run_command. User asks: locate a symbol named parseConfig without changing anything. Reply with only the tool name."},{role:"user",content:"Find the implementation of parseConfig."}],opts.signal);
  const selectionPass=/\b(read_file|search_code)\b/i.test(select.text)&&!/\b(edit_file|run_command)\b/i.test(select.text);
  tasks.push({id:"tool_selection",passed:selectionPass,detail:selectionPass?"selected a read/search tool":"selected an unsafe or invalid tool"});
  const recover=await generate(client,model,[{role:"system",content:"A tool call failed because the file path was not found. The correct recovery is to search for the file name before retrying. Reply with the recovery action only."},{role:"user",content:"read_file failed for src/app.ts; what should you do next?"}],opts.signal);
  const recoveryPass=/search|find/i.test(recover.text);
  tasks.push({id:"recovery",passed:recoveryPass,detail:recoveryPass?"understood reread/search recovery":"did not choose search/re-read recovery"});

  opts.onProgress?.("Checking editing and verification behavior…");
  const edit=await generate(client,model,[{role:"system",content:"You already read a file containing `const value = 1;`. Replace only that exact statement with `const value = 2;`. Reply with the exact find text and no other code."},{role:"user",content:"Prepare the smallest safe edit."}],opts.signal);
  const editPass=/const value = 1/.test(edit.text)&&!/const value = 3/.test(edit.text);
  tasks.push({id:"edit",passed:editPass,detail:editPass?"preserved exact target text":"could not preserve edit target"});
  const verify=await generate(client,model,[{role:"system",content:"After changing code you must verify it. The user changed a TypeScript function and asks what to do next. Reply with one of: diagnostics, tests, build."},{role:"user",content:"The edit is complete. What is the next verification step?"}],opts.signal);
  const verificationPass=/diagnostics|tests|build/i.test(verify.text);
  tasks.push({id:"verification",passed:verificationPass,detail:verificationPass?"selected a verification step":"did not select verification"});

  opts.onProgress?.("Checking multi-step context retention…");
  const context=await generate(client,model,[{role:"user",content:"Remember this identifier for the next message: PHOTON_CTX_7429."},{role:"assistant",content:"Remembered."},{role:"user",content:"What identifier did I ask you to remember? Reply with the identifier only."}],opts.signal);
  const contextPass=/PHOTON_CTX_7429/.test(context.text);
  tasks.push({id:"context",passed:contextPass,detail:contextPass?"retained prior state":"lost prior state"});
  opts.onProgress?.("Checking basic reasoning…");
  const reason=await generate(client,model,[{role:"user",content:"A function runs 3 times and appends 2 items each time. How many items are present at the end? Reply only with the number."}],opts.signal);
  const reasoningPass=/\b6\b/.test(reason.text);
  tasks.push({id:"reasoning",passed:reasoningPass,detail:reasoningPass?"correct (6)":`unexpected: "${reason.text.trim().slice(0,40)}"`});

  const profile:ModelCapabilityProfile={
    reasoning:reasoningPass?0.9:0.35,coding:editPass?0.88:0.45,toolCalling:toolReliability,
    schemaAdherence:toolReliability>=0.67?Math.min(1,toolReliability+0.05):Math.max(0,toolReliability-0.15),
    contextRetention:contextPass?0.9:0.35,editFidelity:editPass?0.88:0.4,recovery:recoveryPass?0.82:0.35,verification:verificationPass?0.85:0.4,speed:1,
  };
  return {model,quantization:opts.quantization,hardwareClass:opts.hardwareClass,methodologyVersion:BENCH_VERSION,tokensPerSec:Math.round(speed.tokensPerSec*10)/10,firstTokenMs:Math.round(speed.firstTokenMs),toolCallReliability:toolReliability,reasoningPass,tasks,ranAt:Date.now(),capabilityProfile:profile};
}
interface GenResult{text:string;tokensPerSec:number;firstTokenMs:number;}
async function generate(client:LLMProvider,model:string,messages:LLMMessage[],signal?:AbortSignal):Promise<GenResult>{
  const start=Date.now();let firstAt=0,text="";let last:LLMChatChunk|undefined;
  for await(const chunk of client.chatStream({model,messages,options:BENCH_OPTS},signal)){if(chunk.message?.content){if(!firstAt)firstAt=Date.now();text+=chunk.message.content;}last=chunk;}
  const end=Date.now();let tokensPerSec=0;if(last?.eval_count&&last.eval_duration&&last.eval_duration>0)tokensPerSec=last.eval_count/(last.eval_duration/1e9);else{const genMs=Math.max(1,end-(firstAt||start));tokensPerSec=(estimateTokens(text)/genMs)*1000;}
  return{text,tokensPerSec,firstTokenMs:(firstAt||end)-start};
}
