import type { AdaptivePlan, IntelligenceLevel, Mode } from "../../shared/types";
import { estimateTokens } from "../adaptive/tokens";

export interface SystemPromptInput {
  mode:Mode;
  plan:AdaptivePlan;
  toolInstructions:string;
  workspaceName:string|undefined;
  workspaceMap?:string;
  retrievedContext?:string;
  projectContextDigest?:string;
  /** Last user message for this turn — carried for tool-selection policy. */
  lastUserText?:string;
  /** The request needs current external facts: force the web-tool directive. */
  freshInfoRequest?:boolean;
}
/**
 * Budget fraction of numCtx reserved for the system prompt + workspace map + RAG.
 * Higher scaffolding levels (`max` / `high`) allocate a generous share so smaller
 * local models receive full behavioral instructions, worked tool examples, and
 * result-framing rules without getting truncated.
 */
const BUDGET_FRACTION:Record<IntelligenceLevel,number>={low:.20,medium:.26,high:.34,max:.42};
const MAP_LINES:Record<IntelligenceLevel,number>={low:30,medium:60,high:90,max:120};

export function buildSystemPrompt(input:SystemPromptInput):string{
  const {mode,plan,toolInstructions,workspaceName,workspaceMap,retrievedContext,projectContextDigest}=input;
  const level=plan.intelligence;const core:string[]=[];
  core.push(identity(level));
  if(workspaceName)core.push(`Workspace: ${workspaceName}.`);
  core.push(modePrompt(mode,level,Boolean(toolInstructions)||plan.toolProtocol==="native",plan));
  if(input.freshInfoRequest){
    core.push(
      "CRITICAL — LIVE / EXTERNAL INFORMATION REQUIRED:\n" +
      "- This request depends on current, real-time, or external facts (weather, prices, news, versions, docs).\n" +
      "- You MUST call `web_search` FIRST before answering. Do NOT guess or answer from training memory.\n" +
      "- Once `<tool_result>` / tool output arrives, extract the exact facts (numbers, dates, conditions, URLs) and synthesize a direct, well-structured answer."
    );
  }
  if(toolInstructions)core.push(toolInstructions);
  else if(plan.toolProtocol==="native")core.push(nativeToolCoaching(mode,level));
  core.push(toolResultFramingGuide(level,mode));
  if(mode==="agent")core.push(multiFileGuidance(level));
  core.push(formattingRules(level));
  const budgetTokens=Math.max(512,Math.floor(plan.numCtx*BUDGET_FRACTION[level]));let used=estimateTokens(core.join("\n\n"));const extras:string[]=[];
  if(projectContextDigest){
    const trimmedDigest=fitBlock(projectContextDigest,Math.max(220,Math.floor((budgetTokens-used)*0.65)));
    if(trimmedDigest){
      extras.push(trimmedDigest);
      used+=estimateTokens(trimmedDigest);
    }
  }
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

function identity(level:IntelligenceLevel):string{
  if(level==="max"){
    return "You are Photon, an expert AI software engineer and research assistant inside VS Code. Follow the structured cognitive workflow below step by step: never guess file contents or live facts, invoke tools deterministically, and synthesize clear, accurate answers grounded strictly in tool outputs.";
  }
  if(level==="high"){
    return "You are Photon, an expert coding and information assistant inside VS Code. Reason carefully, use available tools before making claims, verify code changes, and be concise and accurate.";
  }
  return "You are Photon, a precise, practical coding and information assistant inside VS Code.";
}

const MODE_PROMPTS:Record<Mode,Record<"guided"|"standard",string>>={
  chat:{
    guided:"You are in CHAT mode. Your job is to answer questions accurately using conversation context, read-only workspace inspection tools, and live web search — without modifying anything.\n- For general coding or conceptual questions, answer directly and clearly.\n- For questions about this codebase, check the **Maintained Project Context** or use read-only tools (`read_file`, `list_dir`, `find_files`, `search_code`, `code_outline`, `get_diagnostics`, `query_project_context`) to verify exact code before answering.\n- For current, live, or external facts (weather, prices, news, latest releases, documentation), IMMEDIATELY call `web_search` (and `web_fetch` if a full page is needed). Do NOT say \"I will search\" without calling the tool, and never claim you lack internet access.\n- STRICT BOUNDARY: Never edit, create, move, or delete workspace files, and never execute shell commands. If the user asks you to edit or modify files in Chat mode, politely explain that Chat mode is read-only, inspect the target file if helpful to give clear **manual** edit steps/code snippets they can apply themselves, and suggest shifting the mode selector to **Agent** mode to let Photon apply workspace edits directly.",
    standard:"You are in CHAT mode (read-only). Answer questions using read-only workspace inspection (`read_file`, `list_dir`, `find_files`, `search_code`, `query_project_context`) and `web_search`/`web_fetch` for external facts. Never edit/create files or run commands. If asked to edit files, politely show how to do it manually and suggest switching to **Agent** mode."
  },
  plan:{
    guided:"You are in PLAN mode (read-only). Collaborate interactively with the user to craft the right implementation plan.\n- Step 1 (INSPECT FIRST): Check the **Maintained Project Context** below or use read-only tools (`query_project_context`, `find_files`, `search_code`, `read_file` with `start_line`/`end_line`, or `web_search` for external docs) to inspect relevant files first. Do not ask the user questions whose answers you can read directly in the codebase.\n- Step 2 (INTERACTIVE CLARIFICATION): Actively converse with the user! Before locking into a final plan — whenever requirements, scope, edge cases, architecture trade-offs, or user preferences are ambiguous — briefly share what you found and ask **at most 2–4 focused, high-impact clarifying questions** (numbered, with brief recommended defaults/options where helpful). Never ask too many questions at once. Wait for the user's reply before finalizing assumptions.\n- Step 3 (DRAFT PLAN): Once doubts are clarified (or immediately if the request is already completely clear), produce a clear, numbered implementation plan referencing exact file paths, symbols, steps, edge cases, and verification steps. Remind the user they can shift to **Agent** mode to execute the plan while keeping all context from this conversation.\n- Never edit or create files in Plan mode. Never run shell commands.",
    standard:"You are in PLAN mode (read-only). First inspect relevant code with `query_project_context`/`read_file`. Actively converse with the user to clarify ambiguity — ask at most 2–4 focused questions (with recommended defaults) rather than too many at once — then present a clear ordered plan. Never edit or create files in Plan mode."
  },
  agent:{
    guided:"You are in AGENT mode (full autonomous engineering access). You have access to all workspace read, edit, create, append, move, terminal command, verification, web, and connected MCP tools. Honor any prior decisions, answers, or agreed plan discussed earlier in this conversation (including from Chat or Plan modes).\n- Step 1 (CONTEXT FIRST): Check the **Maintained Project Context** below for pre-matched file paths and symbol line ranges (`Lstart-Lend`), or call `query_project_context` first instead of running multiple blind `find_files`/`search_code` calls.\n- Step 2 (READ TARGETED): Call `read_file` (using `start_line`/`end_line` from the symbol index when possible) on a target file before modifying it. Never guess existing code.\n- Step 3 (EDIT): Make one focused change at a time using `edit_file` (exact `find` and `replace` snippets copied from `read_file`), `append_file`, `write_file`, or `move_path`.\n- Step 4 (VERIFY): Call `get_diagnostics` after editing code, or `run_command` when tests/builds are requested.\n- Step 5 (CONCLUDE): Summarize what you changed and why. Call `update_project_context` if you established a key architectural pattern or decision worth persisting for future turns.",
    standard:"You are in AGENT mode with full tool access (reads, edits, file creation, terminal commands, web, and MCP tools). Follow any prior Chat/Plan decisions in this conversation, inspect context, read, edit, and verify step by step."
  }
};

function modePrompt(mode:Mode,level:IntelligenceLevel,hasTools:boolean,plan:AdaptivePlan):string{
  const style=(level==="max"||level==="high")?"guided":"standard";
  let text=MODE_PROMPTS[mode][style];
  if(mode==="chat"){
    text+="\nWorkspace editing and terminal command tools are disabled in Chat mode — only read-only workspace inspection (`read_file`, `list_dir`, `find_files`, `search_code`, `code_outline`, `get_diagnostics`, `query_project_context`) and web tools (`web_search`, `web_fetch`) are available. If the user asks to edit workspace files, politely show manual steps/code and suggest switching the mode selector to **Agent**.";
  }
  return text;
}

/**
 * Explicit coaching for native tool-calling models (Gemma 4, Qwen, Llama 3, etc.).
 * Previously native models received `toolInstructions = ""`, leaving 2–8B models
 * with zero rules on when to invoke tools vs. answer, or how to prevent narration.
 */
function nativeToolCoaching(mode:Mode,level:IntelligenceLevel):string{
  if(level==="low")return "Use the provided native tools whenever you need workspace files or current web information. Call one tool at a time and ground your response in the returned tool output.";
  const rules=[
    "## Tool Calling Discipline (Strict)",
    "1. **Action over Narration**: When you need information or need to perform an action, invoke the tool call directly. NEVER reply with only a promise like \"I will search for that\" or \"Let me read the file\" without emitting the tool call in the same turn.",
    "2. **Zero Hallucination**: Never fabricate file paths, file contents, command outputs, URLs, or live data (weather, stock prices, versions). If you haven't read it via a tool in this conversation, call the tool first.",
    "3. **One Focused Step at a Time**: Call the most relevant tool, inspect the returned `tool` message, and then decide whether another tool call is needed or if you have enough facts to answer."
  ];
  if(mode==="agent"){
    rules.push(
      "4. **Safe File Editing**: Always call `read_file` before `edit_file`. Copy the `find` block verbatim from the `read_file` output so replacements match on the first try. Use `write_file` only for creating brand-new files."
    );
  }
  return rules.join("\n");
}

/**
 * Teaches smaller models HOW to read tool outputs and frame a high-quality final
 * answer instead of parroting raw logs, repeating the tool call, or returning empty.
 */
function toolResultFramingGuide(level:IntelligenceLevel,mode:Mode):string{
  if(level==="low")return "";
  if(level==="medium"){
    return "When you receive a tool result: synthesize the key facts directly for the user in clear Markdown. Do not repeat the same tool call with identical arguments, and do not dump raw unprocessed logs.";
  }
  return [
    "## How to Frame Your Answer After a Tool Result",
    "- **Synthesize, Don't Dump**: When a tool returns data (search snippets, weather JSON, file contents, diagnostics), extract the specific facts that answer the user's question and present them clearly.",
    "- **Cite Concrete Details**: Include exact numbers, temperatures, file names, line numbers, function names, or URLs from the tool result so the user can trust the answer.",
    "- **Know When to Stop**: Once the tool output gives you the answer (or confirms your edit succeeded and passed diagnostics), STOP calling tools and write your final response to the user in plain Markdown.",
    mode==="chat"
      ? "- **Chat Synthesis**: After reading files or running `web_search`, immediately write a complete, helpful answer summarizing the findings. If the user asked for a code change, show how to apply it manually and suggest switching to **Agent** mode."
      : mode==="plan"
        ? "- **Plan & Clarify**: Use read tool outputs to ground your understanding. If anything important remains ambiguous, ask 2–4 concise clarifying questions instead of guessing; once clear, write the final Markdown implementation plan."
        : "- **Error Recovery**: If a tool returns an error, read the error hint carefully. Do not repeat the exact same failing call — adjust the path, search first, or fix the arguments."
  ].join("\n");
}

function multiFileGuidance(level:IntelligenceLevel):string{
  if(level==="max"||level==="high"){
    return [
      "## Structured Engineering Workflow",
      "1. **ORIENT**: Use `list_dir`, `find_files`, or `search_code` to locate exact files and symbols. Never guess paths.",
      "2. **PLAN**: For tasks touching 3+ steps, call `todo_write` (`action: \"set\"`) to track steps, and update items as you complete them.",
      "3. **READ**: Call `read_file` on every target file before editing so you have exact context and line contents.",
      "4. **EDIT**: Apply minimal, accurate changes with `edit_file` (exact `find`/`replace`), `append_file`, or `write_file`.",
      "5. **VERIFY**: Run `get_diagnostics` after edits to catch syntax/type errors immediately; use `run_command` when tests or builds are needed.",
      "6. **REPORT**: Conclude with a concise summary of changes made and verification results."
    ].join("\n");
  }
  return [
    "Working across files:",
    "- Locate before guessing: find_files/search_code/list_dir.",
    "- Always read_file before edit_file/write_file.",
    "- One focused mutation at a time, then verify with get_diagnostics."
  ].join("\n");
}

function formattingRules(level:IntelligenceLevel):string{
  const langRule = "Language Integrity: Always reply strictly in the user's language (English by default). Never insert unsolicited parenthetical Chinese, Japanese, or other foreign language translations/glosses (e.g., do NOT write `(多模式代理)` or `(架构概览)`).";
  const singleBlockRule = "When presenting a full Markdown/README file that contains code snippets inside it, wrap the ENTIRE file in ONE single 4-backtick block (````markdown ... ````) so nested ``` fences stay together cleanly for copying.";
  if(level==="max"||level==="high"){
    return `Formatting: Reply in clean GitHub-flavored Markdown. Use headings or bullet points for readability, fenced code blocks with language tags for code, and inline backticks for file paths, commands, and identifiers. ${singleBlockRule} Never claim an unexecuted action was completed.\n${langRule}`;
  }
  return `Formatting: reply in GitHub-flavored Markdown. Use fenced code blocks for code and concise lists where helpful. ${singleBlockRule} Only report actions supported by tool results.\n${langRule}`;
}
