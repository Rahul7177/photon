import { editFileTool, listDirTool, movePathTool, readFileTool, writeFileTool } from "./files";
import { codeOutlineTool, findFilesTool, searchCodeTool } from "./search";
import { runCommandTool } from "./terminal";
import { webFetchTool, webSearchTool } from "./web";
import { getDiagnosticsTool } from "./verify";
import { thinkTool, todoWriteTool } from "./plan";
import type { Tool } from "../types";

/** Single canonical built-in set; metadata is normalized once for all engines. */
export function builtinTools(): Tool[] {
  const tools=[readFileTool,editFileTool,writeFileTool,findFilesTool,listDirTool,searchCodeTool,getDiagnosticsTool,runCommandTool,movePathTool,codeOutlineTool,todoWriteTool,thinkTool,webSearchTool,webFetchTool];
  return tools.map(enrichMetadata);
}
function enrichMetadata(tool:Tool):Tool{
  const s=tool.spec;if(s.risk)return tool;
  const tags=new Set(s.tags??[]);
  const risk=s.name.startsWith("web_")?"network":tags.has("exec")?"execute":tags.has("write")||s.sideEffecting?"workspace_write":"read";
  const concurrency=risk==="read"?"safe_parallel":"serial";
  const idempotency=risk==="read"?"idempotent":s.name==="run_command"?"stateful":"non_idempotent";
  const verifyAfter=s.name==="edit_file"||s.name==="write_file"||s.name==="move_path"?["diagnostics"]:s.name==="run_command"?["tests","build","diagnostics"]:[];
  return {...tool,spec:{...s,risk:risk as any,concurrency:concurrency as any,idempotency:idempotency as any,verifyAfter:verifyAfter as any}};
}
