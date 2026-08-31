import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../shared/types";
import { clamp, fail, ok, outputBudget, type Tool } from "../types";

const DEFAULT_TIMEOUT_MS=60_000;
const MAX_TIMEOUT_MS=300_000;
const MAX_BUFFER=1024*1024;

export const runCommandTool:Tool={
  spec:{
    name:"run_command",
    summary:"Run a shell command in the workspace root and return output and exit code.",
    params:[
      {name:"command",type:"string",required:true,description:"The shell command to run."},
      {name:"description",type:"string",required:false,description:"One short line describing why the command is being run."},
      {name:"timeout_ms",type:"number",required:false,description:"Timeout in ms. Default 60000; max 300000."},
    ],
    sideEffecting:true,
    priority:8,
    minTier:"medium",
    tags:["exec","write","verify"],
    risk:"execute",
    concurrency:"serial",
    idempotency:"stateful",
    example:'[TOOL run_command]\ncommand: npm test -- --run\ndescription: Run the unit tests\n[/TOOL]',
    verifyAfter:["tests","build","diagnostics"],
  },
  async execute(args,ctx){
    const command=(args.command as string)?.trim();if(!command)return fail("Provide a command to run.");if(!ctx.workspaceRoot)return fail("No workspace folder is open.");
    const requested=Number(args.timeout_ms);const timeoutMs=Number.isFinite(requested)&&requested>0?Math.min(Math.floor(requested),MAX_TIMEOUT_MS):DEFAULT_TIMEOUT_MS;
    const budget=outputBudget(ctx);const approved=await ctx.requestApproval(mkCall(command,args));if(!approved)return fail("User declined to run the command.");
    ctx.log(`$ ${command}`);
    return new Promise(resolve=>{let child:ReturnType<typeof exec>|undefined;const onAbort=()=>child?.kill();child=exec(command,{cwd:ctx.workspaceRoot,timeout:timeoutMs,maxBuffer:MAX_BUFFER,windowsHide:true},(error,stdout,stderr)=>{
      ctx.signal.removeEventListener("abort",onAbort);const out=[stdout,stderr].filter(Boolean).join("\n").trim();if(ctx.signal.aborted)return resolve(fail("Command cancelled."));
      if(error&&(error as {killed?:boolean}).killed)return resolve(fail(`Command timed out after ${Math.round(timeoutMs/1000)}s.\n${clamp(out,Math.min(3000,budget))}`,{status:"timeout",retryable:true,recovery:{action:"retry"}}));
      const code=error?((error as unknown as {code?:number}).code??1):0;const header=`Exit code ${code}.`;
      if(code!==0)return resolve(fail(`${header}\n${clamp(out||error?.message||"(no output)",budget)}`,{status:"execution_error",retryable:true,recovery:{action:"retry"}}));
      resolve(ok(`${header}\n${clamp(out||"(no output)",budget)}`,{metadata:{evidence:[`command exited 0: ${command}`]}}));
    });ctx.signal.addEventListener("abort",onAbort,{once:true});});
  },
};
function mkCall(command:string,args:Record<string,unknown>):ToolCall{return{id:randomUUID(),name:"run_command",args:{...args,command},status:"proposed",sideEffecting:true};}
