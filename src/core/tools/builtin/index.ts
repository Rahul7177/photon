import { editFileTool, listDirTool, movePathTool, readFileTool, writeFileTool } from "./files";
import { codeOutlineTool, findFilesTool, searchCodeTool } from "./search";
import { runCommandTool } from "./terminal";
import { webFetchTool, webSearchTool } from "./web";
import { getDiagnosticsTool } from "./verify";
import { thinkTool, todoWriteTool } from "./plan";
import type { Tool } from "../types";

/** Single canonical built-in set; metadata is normalized here so local/cloud/MCP policy sees the same semantics. */
export function builtinTools(): Tool[] {
  const tools=[
    readFileTool, editFileTool, writeFileTool, findFilesTool, listDirTool, searchCodeTool,
    getDiagnosticsTool, runCommandTool, movePathTool, codeOutlineTool, todoWriteTool,
    thinkTool, webSearchTool, webFetchTool,
  ];
  return tools.map(enrichMetadata);
}

function enrichMetadata(tool:Tool):Tool{
  const s=tool.spec;
  if(s.risk)return tool;
  const tags=new Set(s.tags??[]);
  let risk:s["risk"]="read";
  if(tags.has("web"))risk="network";
  else if(tags.has("exec"))risk="execute";
  else if(tags.has("write")||s.sideEffecting)risk="workspace_write";
  const concurrency:risk extends "read" ? "safe_parallel" : "serial" = (risk==="read"?"safe_parallel":"serial") as any;
  const idempotency=risk==="read"?"idempotent":s.name==="run_command"?"stateful":"non_idempotent";
  const verifyAfter=s.name==="edit_file"||s.name==="write_file"?["diagnostics"]:s.name==="move_path"?["diagnostics"]:s.name==="run_command"?["tests","build","diagnostics"]:s.name.startsWith("web_")?[]:[];
  return {...tool,spec:{...s,risk,concurrency,idempotency,verifyAfter}};
}
