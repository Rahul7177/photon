import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../shared/types";
import { clampLines, clampToolResult, fail, ok, toolError, type Tool } from "../types";
import { analyzeCommandSecurity } from "../security";

const DEFAULT_TIMEOUT_MS=60_000;
const MAX_TIMEOUT_MS=300_000;
const MAX_BUFFER=1024*1024;

export const runCommandTool:Tool={
  spec:{
    name:"run_command",
    summary:"Run ONE shell command in the workspace root and return its output and exit code. Check the exit code before assuming success.",
    params:[
      {name:"command",type:"string",required:true,description:"The shell command to run. One command at a time — never chain with &&. Example: \"npm test\"."},
      {name:"cwd",type:"string",required:false,description:"Working directory relative to workspace root. Defaults to workspace root."},
    ],
    sideEffecting:true,
    priority:8,
    minTier: "low",
    tags:["exec","write","verify"],
    risk:"execute",
    concurrency:"serial",
    idempotency:"stateful",
    example:'```tool\nTOOL_NAME: run_command\nBEGIN_ARG: command\nnpm test\nEND_ARG\n```',
    verifyAfter:["tests","build","diagnostics"],
  },
  async execute(args,ctx){
    const command=(args.command as string)?.trim();if(!command)return toolError("invalid_args","Missing required argument \"command\". Provide a command to run.");
    // §6.2: run_command accepts ONE command at a time. exec() runs with a shell,
    // so chaining operators would allow a second unseen command to run. Reject
    // them and ask the model to split into separate calls.
    const chained = findShellChaining(command);
    if(chained){
      return toolError("invalid_args", `Run one command at a time with run_command — chaining with "${chained}" is not allowed. Split into separate calls. Got: "${command.slice(0,120)}"`, { recovery: { action: "repair", hints: ["Split chained commands into separate run_command calls"] } });
    }
    if(!ctx.workspaceRoot)return toolError("execution_error","No workspace folder is open.");
    const cwdRel=(args.cwd as string)?.trim();
    let cwd=ctx.workspaceRoot;
    if(cwdRel){
      const { resolveInWorkspace } = await import("../paths.js");
      const r=resolveInWorkspace(ctx.workspaceRoot,cwdRel);
      if("error" in r) return toolError("not_found", r.error);
      cwd=r.abs;
    }
    const requested=Number(args.timeout_ms ?? args.timeoutMs);
    const timeoutMs=Number.isFinite(requested)&&requested>0?Math.min(Math.floor(requested),MAX_TIMEOUT_MS):DEFAULT_TIMEOUT_MS;
    const secAnalysis = analyzeCommandSecurity(command);
    const toolCall = mkCall(command, args, ctx.pendingCallId);
    if (secAnalysis.isDangerous) {
      toolCall.risk = "critical";
      toolCall.statusDetail = `High-risk action: ${secAnalysis.reason}`;
    }
    const approved=await ctx.requestApproval(toolCall);if(!approved)return toolError("permission_denied", secAnalysis.isDangerous ? `User declined high-risk action: ${secAnalysis.reason}` : "User declined to run the command.");
    ctx.log(`$ ${command}`);
    return new Promise(resolve=>{let child:ReturnType<typeof exec>|undefined;const onAbort=()=>child?.kill();child=exec(command,{cwd,timeout:timeoutMs,maxBuffer:MAX_BUFFER,windowsHide:true},(error,stdout,stderr)=>{
      ctx.signal.removeEventListener("abort",onAbort);
      const rawOut=[stdout,stderr].filter(Boolean).join("\n").trim();
      // §4: Truncate run_command output to ~80 lines
      const out=clampLines(rawOut,80);
      if(ctx.signal.aborted)return resolve(toolError("execution_error","Command cancelled."));
      if(error&&(error as {killed?:boolean}).killed)return resolve(toolError("timeout",`Command timed out after ${Math.round(timeoutMs/1000)}s.\n${clampToolResult(out)}`,{retryable:true,recovery:{action:"retry"}}));
      const code=error?((error as unknown as {code?:number}).code??1):0;
      const header=`Exit code ${code}.`;
      const outputText = `${header}\n${clampToolResult(out||error?.message||"(no output)")}`;
      if(code!==0) {
        // Return full stdout/stderr with retryable metadata so the model can inspect error traces and repair.
        return resolve(toolError("execution_error", outputText, {
          retryable: true,
          recovery: { action: "repair", hints: ["Inspect the output/stderr above, fix errors, and re-run"] }
        }));
      }
      resolve(ok(outputText,{metadata:{evidence:[`command exited 0: ${command}`]}}));
    });ctx.signal.addEventListener("abort",onAbort,{once:true});});
  },
};
function mkCall(command:string,args:Record<string,unknown>,existingId?:string):ToolCall{return{id:existingId??randomUUID(),name:"run_command",args:{...args,command},status:"proposed",sideEffecting:true};}
/** Detect shell chaining/substitution outside single/double quotes. Returns the offending token or null. */
export function findShellChaining(cmd:string):string|null{
  let sq=false,dq=false,esc=false;
  for(let i=0;i<cmd.length;i++){
    const c=cmd[i];
    if(esc){esc=false;continue;}
    if(c==="\\"){esc=true;continue;}
    if(c==="'"&&!dq){sq=!sq;continue;}
    if(c==='"'&&!sq){dq=!dq;continue;}
    if(sq||dq)continue;
    const two=cmd.slice(i,i+2);
    if(two==="&&"||two==="||")return two;
    if(c===";"||c==="|"||c==="&"||c==="`"||c===">"||c==="<")return c;
    if(two==="$(")return "$(";
    if(c==="\n"||c==="\r")return "\\n";
  }
  return null;
}
