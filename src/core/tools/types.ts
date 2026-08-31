import type { IntelligenceLevel, ToolCall, ToolSpec } from "../../shared/types";

export type ToolStatus = "success" | "invalid_args" | "not_found" | "ambiguous" | "permission_denied" | "conflict" | "execution_error" | "timeout";
export interface ToolRecovery { action: "retry" | "reread" | "search" | "repair" | "ask_user"; hints?: string[]; }
export interface ToolResult {
  ok: boolean;
  status?: ToolStatus;
  retryable?: boolean;
  recovery?: ToolRecovery;
  output: string;
  metadata?: { path?: string; fileId?: string; versionBefore?: string; versionAfter?: string; changedLines?: { start: number; end: number } };
}
export interface DiagnosticInfo { file:string; line:number; col:number; severity:"error"|"warning"|"info"; message:string; source?:string; }
export interface TodoItem { status:"pending"|"in_progress"|"done"; text:string; }
export interface ToolContext {
  workspaceRoot:string|undefined;
  requestApproval:(call:ToolCall)=>Promise<boolean>;
  signal:AbortSignal;
  log:(msg:string)=>void;
  webSearchProvider:"duckduckgo"|"none";
  findFiles:(query:string,maxResults:number)=>Promise<string[]>;
  capability:IntelligenceLevel;
  getDiagnostics:(path?:string)=>Promise<DiagnosticInfo[]>;
  todos:TodoItem[];
}
const OUTPUT_BUDGET:Record<IntelligenceLevel,number>={low:4000,medium:8000,high:16000,max:32000};
export function outputBudget(ctx:ToolContext):number{return OUTPUT_BUDGET[ctx.capability]??6000;}
export interface Tool { spec:ToolSpec; execute(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolResult>; }
export function ok(output:string,extra:Partial<ToolResult>={}):ToolResult{return{ok:true,status:"success",retryable:false,output,...extra};}
export function fail(output:string,extra:Partial<ToolResult>={}):ToolResult{return{ok:false,status:"execution_error",retryable:false,output,...extra};}
export function toolError(status:ToolStatus,output:string,extra:Partial<ToolResult>={}):ToolResult{const retryable=extra.retryable??["invalid_args","not_found","ambiguous","conflict","timeout"].includes(status);return{ok:false,status,retryable,output,...extra};}
export function clamp(text:string,maxChars=6000):string{if(text.length<=maxChars)return text;return`${text.slice(0,maxChars)}\n… [truncated ${text.length-maxChars} more characters]`;}
