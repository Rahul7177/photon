import type { AdaptivePlan, IntelligenceLevel, Mode } from "../../shared/types";
import { estimateTokens } from "../adaptive/tokens";

export interface SystemPromptInput { mode:Mode; plan:AdaptivePlan; toolInstructions:string; workspaceName:string|undefined; workspaceMap?:string; retrievedContext?:string; }
const BUDGET_FRACTION:Record<IntelligenceLevel,number>={low:.22,medium:.22,high:.28,max:.32};
const MAP_LINES:Record<IntelligenceLevel,number>={low:18,medium:50,high:90,max:130};

export function buildSystemPrompt(input:SystemPromptInput):string{
  const {mode,plan,toolInstructions,workspaceName,workspaceMap,retrievedContext}=input;
  const level=plan.intelligence;const core:string[]=[];
  core.push(identity(level));
  if(workspaceName)core.push(`Workspace: ${workspaceName}.`);
  core.push(modePrompt(mode,level,Boolean(toolInstructions),plan));
  if(toolInstructions)core.push(toolInstructions);
  if(mode!=="chat")core.push(multiFileGuidance(level));
  core.push(formattingRules(level));
  const budgetTokens=Math.max(256,Math.floor(plan.numCtx*BUDGET_FRACTION[level]));let used=estimateTokens(core.join("\n\n"));const extras:string[]=[];
  if(workspaceMap&&mode!=="chat"){
    const capped=capLines(workspaceMap,MAP_LINES[level]);const t=estimateTokens(`Project files (partial):\n${capped}`);
    if(used+t<=budgetTokens){extras.push(`Project files (partial):\n${capped}`);used+=t;}
  }
  if(retrievedContext&&mode!=="chat"){
    const trimmed=fitBlock(retrievedContext,budgetTokens-used-8);if(trimmed)extras.push("Relevant code from the workspace (retrieved for this request; read files to confirm before editing):\n"+trimmed);
  }
  return[...core,...extras].join("\n\n");
}
function capLines(text:string,max:number):string{const lines=text.split("\n");return lines.length<=max?text:lines.slice(0,max).join("\n")+"\n…";}
function fitBlock(text:string,maxTokens:number):string|null{if(maxTokens<40)return null;if(estimateTokens(text)<=maxTokens)return text;const chars=Math.max(200,maxTokens*4);const cut=text.slice(0,chars);const lastNl=cut.lastIndexOf("\n");return(lastNl>100?cut.slice(0,lastNl):cut)+"\n… (truncated)";}
function identity(level:IntelligenceLevel):string{if(level==="low")return"You are Photon, a concise coding assistant inside VS Code. Photon will scaffold the workflow for you; follow the tool instructions exactly.";if(level==="max")return"You are Photon, an expert coding and information assistant inside VS Code. Reason carefully when needed, use available tools, verify changes, and be concise but complete.";return"You are Photon, a precise, practical coding and information assistant inside VS Code. Be concise.";}
const MODE_PROMPTS:Record<Mode,Record<"low"|"rich",string>>={
  chat:{low:"You are in CHAT mode. Answer directly. Use web_search to find current/latest/live/external facts and web_fetch to read web pages. Never claim you lack web access when these tools are listed.",rich:"You are in CHAT mode. Answer directly. For current, latest, live, market, price, weather, news, or other external facts, use web_search/web_fetch when available instead of guessing."},
  plan:{low:"PLAN mode. Inspect the workspace with read-only tools (read_file, list_dir, search_code), use web_search for external/current facts, then give a short ordered plan. Do not edit files.",rich:"You are in PLAN mode. Use read-only tools to understand the code, then give a clear ordered plan. Use web_search/web_fetch for external facts. Do not make changes."},
  agent:{low:"AGENT mode. Photon expects a strict sequence: locate → read → one focused edit/write → verify → next step. Use web_search for current/external facts and web_fetch for web pages. Call exactly ONE tool, wait for its result, then decide the next tool. Do not invent paths or file contents.",rich:"You are in AGENT mode. Complete the task with tools in small, verifiable steps: locate, read, edit, verify. Use web_search/web_fetch for external facts. Only rely on tool results."}
};
function modePrompt(mode:Mode,level:IntelligenceLevel,hasTools:boolean,plan:AdaptivePlan):string{let text=MODE_PROMPTS[mode][level==="low"?"low":"rich"];if(hasTools&&mode==="chat")text+="\nTool use is available for this turn; use it when needed.";if(plan.task&&/current|latest|live|today|as of/i.test(plan.rationale.join(" ")))text+="\nThis request may require fresh external information; prioritize web tools when appropriate.";return text;}
function multiFileGuidance(level:IntelligenceLevel):string{
  if(level==="low")return[
    "LOW-END TOOL WORKFLOW — follow literally:",
    "1. LOCATE: use list_dir, find_files, or search_code to find the correct path.",
    "2. READ: use read_file on the target before changing it.",
    "3. EDIT: use edit_file with the exact text copied from read_file, or use write_file for a complete new file.",
    "   write_file format: [TOOL write_file] path: <file> content: ``` <full file content> ``` [/TOOL]",
    "   edit_file format: [TOOL edit_file] path: <file> find: ``` <exact text> ``` replace: ``` <new text> ``` [/TOOL]",
    "   ALWAYS use ``` fences for content/find/replace. Never use | or > after the colon.",
    "4. WAIT: read the complete tool result before choosing the next step.",
    "5. VERIFY: after a change, use get_diagnostics; use run_command when the task needs tests/build/runtime verification.",
    "6. WEB: use web_search for current/external facts and web_fetch to read web pages.",
    "7. CONTINUE: if the task is not complete, make ONE more tool call. Do not restart from the beginning.",
    "8. FINISH: only stop when the requested change is actually complete or a tool reports a blocker.",
    "CRITICAL: NEVER narrate what you will do. NEVER say 'I will search...' or 'I will read...'. Just CALL the tool directly.",
    "CRITICAL: NEVER invent file paths, file contents, or tool results. Only use what tools actually returned.",
    "AVAILABLE TOOLS: list_dir, find_files, search_code, read_file, edit_file, write_file, get_diagnostics, run_command, web_search, web_fetch, move_path, code_outline, todo_write.",
    "IMPORTANT: use tool names exactly as listed. Do not use write_to_file, replace_in_file, execute_command, list_files, or search_files."
  ].join("\n");
  if(level==="medium")return["Working across files:","- Locate before guessing: find_files/search_code/list_dir.","- Always read_file before edit_file/write_file.","- One focused mutation at a time.","- Read every tool result before choosing the next step.","- Verify with get_diagnostics and relevant run_command calls.","- Use web_search for current/external facts, web_fetch for web pages.","- Use todo_write for genuinely multi-step tasks."] .join("\n");
  return["## Working across multiple files","1. ORIENT — locate exact files/symbols.","2. PLAN — use todo_write for multi-step work when useful.","3. READ — read every file before editing.","4. EDIT — make focused changes with exact snippets.","5. VERIFY — diagnostics then relevant tests/build/runtime.","6. WEB — use web_search for current/external facts, web_fetch for web pages.","7. Track completed vs remaining work and continue until done.","Never invent paths, symbols, or command output."].join("\n");
}
function formattingRules(level:IntelligenceLevel):string{if(level==="low")return"Use Markdown. Keep the visible answer short. Never narrate what you will do — just call the tool. Never describe an unexecuted tool call as completed.";return"Formatting: reply in GitHub-flavored Markdown. Use fenced code blocks for code and concise lists where helpful. Only report actions supported by tool results.";}
