import { resolveInWorkspace } from "../paths";
import { clampLines, clampToolResult, toolError, ok, type Tool } from "../types";

export const getDiagnosticsTool:Tool={
  spec:{
    name:"get_diagnostics",summary:"Get compiler/linter errors for a file or the workspace. Call this AFTER every edit_file or write_file touching source code.",
    params:[{name:"path",type:"string",required:false,description:"File path relative to workspace root. Omit for workspace-wide diagnostics. Example: \"src/app.ts\"."}],
    sideEffecting:false,priority:7,minTier:"low",tags:["verify","read"],risk:"read",concurrency:"safe_parallel",idempotency:"idempotent",verifyAfter:["diagnostics"],
    example:'```tool\nTOOL_NAME: get_diagnostics\nBEGIN_ARG: path\nsrc/app.ts\nEND_ARG\n```',
  },
  async execute(args,ctx){
    const rel=(args.path as string)?.trim();let absFilter:string|undefined;
    if(rel&&rel!=="."&&rel!=="/"){const r=resolveInWorkspace(ctx.workspaceRoot,rel);if("error" in r)return toolError("not_found", r.error, { recovery: { action: "search" } });absFilter=r.abs;}
    try{
      const all=await ctx.getDiagnostics(absFilter);
      if(all.length===0)return ok(`No diagnostics reported for ${absFilter?rel:"the workspace"}.`,{metadata:{evidence:[`diagnostics checked: ${rel||"workspace"}`]}});
      // §4: Truncate get_diagnostics output to ~80 lines
      const lines=all.slice(0,200).map(d=>`${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.col}${d.source?` [${d.source}]`:""}: ${d.message}`);
      const output=clampLines(`${all.length} diagnostic(s):\n${lines.join("\n")}`,80);
      const hasErrors=all.some(d=>d.severity==="error");
      if(!hasErrors) return ok(clampToolResult(output),{metadata:{evidence:[`diagnostics checked: ${rel||"workspace"}`]}});
      return toolError("execution_error", clampToolResult(output),{retryable:false,recovery:{action:"verify",hints:["Resolve reported diagnostics before claiming completion."]},metadata:{evidence:[`diagnostics checked: ${rel||"workspace"}`]}} as any);
    }catch(e){return toolError("execution_error", `Could not read diagnostics: ${(e as Error).message}`,{retryable:true,recovery:{action:"retry"}});}
  },
};
