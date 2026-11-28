import type { AgentPhase, ChatMessage, Mode } from "../../shared/types";
import { extractStructuredCompactionData, isToolResultMessage } from "../agent/compactor";
import type { TodoItem } from "../tools/types";

export interface StateCardInput {
  goal: string;
  mode: Mode;
  phase: AgentPhase;
  style: "off" | "compact" | "rich";
  todos?: readonly TodoItem[];
  messages?: readonly ChatMessage[];
  executedTools?: readonly { name: string; args: Record<string, unknown>; ok: boolean; directAnswer?: boolean }[];
  lastFailedTool?: string;
}

const READ_TOOLS = new Set(["read_file", "code_outline"]);
const WRITE_TOOLS = new Set(["edit_file", "write_file", "append_file", "move_path"]);

function extractToolPath(args: Record<string, unknown>): string | undefined {
  const candidate = args.path ?? args.file_path ?? args.filePath ?? args.file ?? args.from ?? args.to;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function clampSingleLine(text: string, maxChars: number): string {
  const oneLine = (text ?? "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return oneLine.slice(0, Math.max(12, maxChars - 1)).trimEnd() + "…";
}

function phaseGuidance(
  phase: AgentPhase,
  mode: Mode,
  lastFailedTool?: string,
  executed?: readonly { name: string; ok: boolean; directAnswer?: boolean }[]
): string {
  if (lastFailedTool) {
    return `Repair the previous ${lastFailedTool} call using exact schema args or inspect first.`;
  }
  const hasWebSearchOnly =
    phase !== "final" &&
    executed &&
    executed.some((t) => t.name === "web_search" && t.ok && !t.directAnswer) &&
    !executed.some((t) => t.name === "web_fetch");
  if (hasWebSearchOnly) {
    return "If the web_search snippets already contain the exact requested number/fact, answer directly; otherwise call web_fetch on the best URL from the search results to read the full page (never tell the user to visit the links themselves).";
  }
  if (phase === "orient") {
    return mode === "agent"
      ? "Locate and read the target file(s) before making edits."
      : "Inspect relevant files or search once, then answer directly.";
  }
  if (phase === "edit") {
    return "Apply minimal targeted edits with edit_file (or append_file/write_file).";
  }
  if (phase === "verify") {
    return "Verify modified files with get_diagnostics (and tests if requested), or conclude if complete.";
  }
  return "Provide a concise, grounded Markdown final response with no unnecessary tool calls.";
}

/**
 * Step-scoped working memory state card injected transiently at the tail of
 * LLM history (never persisted into session.messages) so KV prefixes stay warm
 * while small models retain goal, constraints, progress, and phase hints.
 */
export function buildStepStateCard(input: StateCardInput): string | undefined {
  if (input.style === "off") return undefined;
  const executed = input.executedTools ?? [];
  const todos = input.todos ?? [];
  if (executed.length === 0 && todos.length === 0) return undefined;

  const visibleMessages = (input.messages ?? []).filter(
    (m) => !(m.hidden && m.role === "user" && !isToolResultMessage(m))
  );
  const compacted = extractStructuredCompactionData(visibleMessages);

  const readFiles = new Set<string>(compacted.filesInspected);
  const modifiedFiles = new Set<string>(compacted.filesModified.keys());

  for (const t of executed) {
    const p = extractToolPath(t.args);
    if (!p || !t.ok) continue;
    if (WRITE_TOOLS.has(t.name)) {
      modifiedFiles.add(p);
    } else if (READ_TOOLS.has(t.name)) {
      readFiles.add(p);
    }
  }

  const lines: string[] = ["<working_memory>"];
  const goalText = clampSingleLine(input.goal, 180);
  if (goalText) lines.push(`GOAL: ${goalText}`);

  const constraintPool = compacted.userConstraints.filter(Boolean);
  if (constraintPool.length > 0) {
    const conciseConstraints = constraintPool
      .slice(-2)
      .map((c) => clampSingleLine(c, 120))
      .join(" | ");
    lines.push(`CONSTRAINTS: ${conciseConstraints}`);
  } else if (/\b(?:do not|don't|never|must not|avoid|without changing|preserve)\b/i.test(input.goal)) {
    lines.push(`CONSTRAINTS: ${clampSingleLine(input.goal, 140)}`);
  }

  if (todos.length > 0) {
    const marker = (s: TodoItem["status"]) => (s === "done" ? "[x]" : s === "in_progress" ? "[>]" : s === "blocked" ? "[!]" : "[ ]");
    const planText = todos
      .slice(0, input.style === "rich" ? 6 : 4)
      .map((t) => `${marker(t.status)} ${clampSingleLine(t.task, 48)}`)
      .join(" | ");
    lines.push(`PLAN: ${planText}`);
  }

  const knownParts: string[] = [];
  if (readFiles.size > 0) {
    knownParts.push(`read=[${[...readFiles].filter((x) => !x.includes(": \"")).slice(-5).join(", ")}]`);
  }
  if (modifiedFiles.size > 0) {
    knownParts.push(`modified=[${[...modifiedFiles].slice(-5).join(", ")}]`);
  }
  if (input.style === "rich" && executed.length > 0) {
    const last = executed[executed.length - 1];
    knownParts.push(`last_tool=${last.name}:${last.ok ? "ok" : "error"}`);
  }
  if (input.lastFailedTool) {
    knownParts.push(`repair_target=${input.lastFailedTool}`);
  }
  if (knownParts.length > 0) {
    lines.push(`KNOWN: ${knownParts.join(" ")}`);
  }

  lines.push(`PHASE: ${input.phase} — ${phaseGuidance(input.phase, input.mode, input.lastFailedTool, executed)}`);
  lines.push("</working_memory>");
  return lines.join("\n");
}
