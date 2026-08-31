import { resolveInWorkspace } from "../paths";
import { clamp, fail, ok, outputBudget, type Tool } from "../types";

export const getDiagnosticsTool:Tool={
  spec:{
    name:"get_diagnostics",
    summary:"Get current editor diagnostics for a file or the workspace.",
    params:[
      {name:"path",type:"string",required:false,description:"File path relative to workspace root. Omit for workspace-wide diagnostics."},
      {name:"errors_only",type:"boolean",required:false,description:"Only show errors."},
    ],
    sideEffecting:false,
    priority:7,
    minTier:"low",
    tags:["verify","read"],
    risk:"read",
    concurrency:"safe_parallel",
    idempotency:"idempotent",
    verifyAfter:["diagnostics"],
    example:'[TOOL get_diagnostics]\npath: src/app.ts\n[/TOOL]',
  },
  async execute(args,ctx){
    const rel=(args.path as string)?.trim();let absFilter:string|undefined;
    if(rel&&rel!=="."&&rel!=="/"){const r=resolveInWorkspace(ctx.workspaceRoot,rel);if("error"in r)return fail(r.error);absFilter=r.abs;}
    try{
      const all=await ctx.getDiagnostics(absFilter);const errorsOnly=args.errors_only===true;const filtered=errorsOnly?all.filter(d=>d.severity==="error"):all;
      if(filtered.length===0)return ok(all.length>0?`No errors${absFilter?" in this file":""} — ${all.length} warning/info diagnostic(s) remain.`:`No diagnostics reported for ${absFilter?rel:"the workspace"}.`,{metadata:{evidence:[`diagnostics checked: ${rel||"workspace"}`,`errors: ${all.filter(d=>d.severity==="error").length}`]}});
      const budget=outputBudget(ctx);const capped=filtered.slice(0,200);const maxShown=ctx.capability==="low"?20:50;
      const lines=capped.slice(0,maxShown).map(d=>`${d.severity.toUpperCase()} ${d.file}:${d.line}:${d.col}${d.source?` [${d.source}]`:""}: ${d.message}`);
      const more=capped.length>maxShown?`\n… (${capped.length-maxShown} more)`:"";
      return ok(clamp(`${capped.length} diagnostic(s):\n${lines.join("\n")}${more}`,budget),{status:"execution_error",retryable:false,recovery:{action:"verify",hints:["Resolve reported diagnostics before claiming completion."]}});
    }catch(e){return fail(`Could not read diagnostics: ${(e as Error).message}`,{retryable:true,recovery:{action:"retry"}});}
  },
};
