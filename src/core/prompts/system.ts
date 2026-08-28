import type { AdaptivePlan, IntelligenceLevel, Mode } from "../../shared/types";
import { estimateTokens } from "../adaptive/tokens";

export interface SystemPromptInput {
  mode: Mode;
  plan: AdaptivePlan;
  toolInstructions: string;
  workspaceName: string | undefined;
  /** Compact file tree, injected so the model can navigate multiple files. */
  workspaceMap?: string;
  /** Relevance-ranked code retrieved from the local workspace index (M10). */
  retrievedContext?: string;
}

/**
 * Fraction of the model's context window the system prompt may occupy.
 * Small-window models get a proportionally tighter cap: on an 8k model every
 * system token competes directly with conversation memory and output room,
 * while a 128k cloud model can afford generous guidance.
 */
const BUDGET_FRACTION: Record<IntelligenceLevel, number> = {
  low: 0.16,
  medium: 0.22,
  high: 0.28,
  max: 0.32,
};

/** Hard cap on workspace-map lines per level — structure helps, walls of tree
 *  don't. Low models get just the top of the tree. */
const MAP_LINES: Record<IntelligenceLevel, number> = {
  low: 18,
  medium: 50,
  high: 90,
  max: 130,
};

/**
 * Build the system prompt for a turn, within a token budget derived from the
 * model's actual context window.
 *
 * Structure: a CORE that defines behavior (identity, mode contract, tool
 * mechanics, output form) is always included — it is what keeps a weak model
 * from hallucinating. Optional CONTEXT (file map, retrieved code) is appended
 * only while it fits, trimmed at line boundaries, and dropped entirely on tiny
 * windows. Detail scales with plan.intelligence: a "low" model gets a terse
 * skeleton; a "max" model gets refined, explicit guidance.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const { mode, plan, toolInstructions, workspaceName, workspaceMap, retrievedContext } = input;
  const level = plan.intelligence;

  // --- Core (never dropped): how to behave, how to call tools, how to answer.
  const core: string[] = [];
  core.push(identity(level));
  if (workspaceName) core.push(`Workspace: ${workspaceName}.`);
  core.push(modePrompt(mode, level));
  if (toolInstructions) core.push(toolInstructions);
  if (mode !== "chat" && level !== "low") core.push(multiFileGuidance(level));
  core.push(formattingRules(level));

  // --- Optional context, admitted strictly by budget.
  const budgetTokens = Math.max(256, Math.floor(plan.numCtx * BUDGET_FRACTION[level]));
  let used = estimateTokens(core.join("\n\n"));

  const extras: string[] = [];
  if (workspaceMap && mode !== "chat") {
    const capped = capLines(workspaceMap, MAP_LINES[level]);
    const t = estimateTokens(`Project files (partial):\n${capped}`);
    if (used + t <= budgetTokens) {
      extras.push(`Project files (partial):\n${capped}`);
      used += t;
    }
  }
  if (retrievedContext && mode !== "chat") {
    const trimmed = fitBlock(retrievedContext, budgetTokens - used - 8);
    if (trimmed) {
      extras.push(
        "Relevant code from the workspace (retrieved for this request; read files to confirm before editing):\n" +
          trimmed
      );
    }
  }

  return [...core, ...extras].join("\n\n");
}

/** Trim multi-line text to at most `max` lines. */
function capLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : lines.slice(0, max).join("\n") + "\n…";
}

/** Fit a reference block into a token allowance, cutting at a line boundary.
 *  Returns null when the allowance is too small to be worth anything. */
function fitBlock(text: string, maxTokens: number): string | null {
  if (maxTokens < 40) return null;
  if (estimateTokens(text) <= maxTokens) return text;
  const chars = Math.max(200, maxTokens * 4);
  const cut = text.slice(0, chars);
  const lastNl = cut.lastIndexOf("\n");
  return (lastNl > 100 ? cut.slice(0, lastNl) : cut) + "\n… (truncated)";
}

function identity(level: IntelligenceLevel): string {
  // Deliberately provider-neutral: the same prompt serves a 3B local model and
  // a frontier cloud model, so it must never claim "local" or "Ollama".
  if (level === "low") return "You are Photon, a coding assistant inside VS Code.";
  if (level === "max") {
    return "You are Photon, an expert coding assistant inside VS Code. You reason carefully, work methodically, and verify your changes before claiming success. Be concise but complete.";
  }
  return "You are Photon, a precise, practical coding assistant inside VS Code. Be concise.";
}

const MODE_PROMPTS: Record<Mode, Record<"low" | "rich", string>> = {
  chat: {
    low: "Answer the user's coding question directly. No tools.",
    rich:
      "You are in CHAT mode. Answer questions and write code snippets directly in your reply. You have no tools and cannot change files — explain clearly and show correct, runnable code.",
  },
  plan: {
    low:
      "PLAN mode. Inspect code with read-only tools (read_file, list_dir, find_files, search_code), then reply with a short numbered plan. Do NOT edit files. Never guess file contents — read them.",
    rich:
      "You are in PLAN mode. Produce a clear, ordered plan — do not make changes. Use read-only tools (read_file, list_dir, find_files, search_code) to understand the code first, then present a numbered plan the user can approve. Name the exact files and functions each step touches.",
  },
  agent: {
    // The five rules below are the highest-value tokens in the whole prompt for
    // an 8k model: they prevent the classic failure modes (editing unread
    // files, hallucinated `find` text, inventing results, never stopping).
    low:
      "AGENT mode rules: 1) read_file before edit_file; copy `find` EXACTLY from what you read. 2) One small step per tool call, then wait for its result. 3) Only state what tools returned — never invent file contents, paths, or command output. 4) When done, stop calling tools and summarize briefly.",
    rich:
      "You are in AGENT mode. Complete the task by using tools. Work in small, verifiable steps: locate the relevant files, read a file fully before editing it, make one focused change at a time, and check the result. Only rely on what tools actually return — never invent file contents, paths, or command output, and don't claim you did something unless a tool confirmed it. When the task is complete, stop calling tools and give a short summary of what changed.",
  },
};

function modePrompt(mode: Mode, level: IntelligenceLevel): string {
  return MODE_PROMPTS[mode][level === "low" ? "low" : "rich"];
}

/** Explicit multi-file workflow — the thing small models fail at without help. */
function multiFileGuidance(level: IntelligenceLevel): string {
  if (level === "medium") {
    return [
      "Working across files:",
      "- Locate before you guess: find_files for file names, search_code for content.",
      "- Always read_file before edit_file, and copy the exact text into `find`.",
      "- After edits, run get_diagnostics on the changed file to catch mistakes early.",
      "- For multi-step tasks, keep a todo_write checklist updated.",
      "- Change one file at a time.",
    ].join("\n");
  }
  // high / max
  return [
    "## Working across multiple files",
    "1. ORIENT — start from the project file list; use find_files (names/globs), search_code (content, supports regex + context_lines), or code_outline (symbols of a big file) instead of guessing paths.",
    "2. PLAN — for multi-step work, write a todo_write checklist first and keep it updated as you go. Use think to reason through tricky decisions privately.",
    "3. READ — open each file you intend to change with read_file (use start_line/end_line for big files). Never edit a file you haven't read this turn.",
    "4. EDIT — use edit_file with `find` copied verbatim from what you read (3-5 surrounding lines make it unique). One focused change per call; use replace_all only when repetition is intended. Use move_path for renames.",
    "5. VERIFY — after each edit run get_diagnostics on that file; after behavioral changes run the relevant command via run_command. Fix what they report before moving on.",
    "6. Track done vs. remaining across files; finish one file before the next.",
    "Never invent file paths, function names, or command output — confirm them with a tool first. If a tool errors twice, re-read its usage example in the error and adjust instead of retrying blind.",
  ].join("\n");
}

function formattingRules(level: IntelligenceLevel): string {
  if (level === "low") {
    return "Use Markdown. Put code in triple-backtick blocks. Keep it short.";
  }
  return [
    "Formatting: reply in GitHub-flavored Markdown. Use fenced code blocks with a language tag for code, `inline code` for identifiers, and **bold**/lists where they aid clarity. Always close every Markdown marker you open. Do not narrate your tool use at length — act, then briefly report.",
  ].join("\n");
}
