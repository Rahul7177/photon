import type { IntelligenceLevel, ToolCall, ToolSpec } from "../../shared/types";

export type ToolStatus = "success" | "invalid_args" | "not_found" | "ambiguous" | "permission_denied" | "conflict" | "execution_error" | "timeout" | "stale_state";
export interface ToolRecovery { action: "retry" | "reread" | "search" | "repair" | "ask_user" | "verify"; hints?: string[]; }
export interface ToolResult {
  ok: boolean;
  status?: ToolStatus;
  retryable?: boolean;
  recovery?: ToolRecovery;
  output: string;
  metadata?: {
    path?: string;
    fileId?: string;
    versionBefore?: string;
    versionAfter?: string;
    changedLines?: { start: number; end: number };
    changed?: boolean;
    evidence?: string[];
  };
}
export interface DiagnosticInfo { file:string; line:number; col:number; severity:"error"|"warning"|"info"; message:string; source?:string; }
export interface TodoItem { id:number; task:string; status:"pending"|"in_progress"|"done"|"blocked"; reason?:string; }
export interface ToolContext {
  workspaceRoot:string|undefined;
  requestApproval:(call:ToolCall)=>Promise<boolean>;
  /** FIX: id of the tool call currently being executed. Tools pass this back
   *  into requestApproval so the controller's pendingApprovals lookup finds
   *  the right entry — otherwise the user's "Allow" click resolves a no-op. */
  pendingCallId?:string;
  signal:AbortSignal;
  log:(msg:string)=>void;
  webSearchProvider:"google"|"duckduckgo"|"none";
  findFiles:(query:string,maxResults:number)=>Promise<string[]>;
  capability:IntelligenceLevel;
  getDiagnostics:(path?:string)=>Promise<DiagnosticInfo[]>;
  todos:TodoItem[];
  checkpointTracker?: { recordBeforeChange: (relPath: string) => Promise<void> };
}
// §4 Context budget rules for 6K window
export const CONTEXT_BUDGETS = {
  system: 800,
  toolDefs: 400,
  history: 1500,
  toolResult: 1200, // tokens max per tool result
  reserved: 1000,
  total: 6000,
} as const;
// Tool result char budget: ~1200 tokens * 4 chars/token = 4800 chars
export const TOOL_RESULT_CHAR_BUDGET = 4800;
export const TOOL_RESULT_LINE_BUDGET = 80; // for run_command/get_diagnostics per §4

const OUTPUT_BUDGET:Record<IntelligenceLevel,number>={low:4000,medium:8000,high:16000,max:32000};
export function outputBudget(ctx:ToolContext):number{
  // Cap by spec's 1200 token budget for tool results
  const specCap = TOOL_RESULT_CHAR_BUDGET;
  const levelCap = OUTPUT_BUDGET[ctx.capability]??6000;
  return Math.min(specCap, levelCap);
}
export interface Tool { spec:ToolSpec; execute(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolResult>; }
export function ok(output:string,extra:Partial<ToolResult>={}):ToolResult{return{ok:true,status:"success",retryable:false,output,...extra};}
export function fail(output:string,extra:Partial<ToolResult>={}):ToolResult{return{ok:false,status:"execution_error",retryable:false,output,...extra};}
export function toolError(status:ToolStatus,output:string,extra:Partial<ToolResult>={}):ToolResult{const retryable=extra.retryable??["invalid_args","not_found","ambiguous","conflict","timeout","stale_state"].includes(status);return{ok:false,status,retryable,output,...extra};}
export function clamp(text:string,maxChars=6000):string{if(text.length<=maxChars)return text;return`${text.slice(0,maxChars)}\n… [truncated ${text.length-maxChars} more characters]`;}
export function clampToolResult(text:string,maxChars=TOOL_RESULT_CHAR_BUDGET):string{
  if(text.length<=maxChars) return text;
  return `${text.slice(0,maxChars)}\n… [truncated, ${text.length-maxChars} more characters — request a narrower range or use grep filter]`;
}
export function clampLines(text:string,maxLines=TOOL_RESULT_LINE_BUDGET):string{
  const lines=text.split("\n");
  if(lines.length<=maxLines) return text;
  return lines.slice(0,maxLines).join("\n")+`\n… [${lines.length-maxLines} more lines omitted]`;
}
