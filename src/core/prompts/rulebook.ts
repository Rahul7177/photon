import type { IntelligenceLevel, Mode, ToolProtocol, ToolSpec } from "../../shared/types";
import { builtinTools } from "../tools/builtin";

export type PromptSectionId =
  | "identity"
  | "mode"
  | "fresh_info"
  | "tools"
  | "result_framing"
  | "workflow"
  | "formatting";

export interface RuleRenderContext {
  mode: Mode;
  level: IntelligenceLevel;
  protocol: ToolProtocol;
  hasToolInstructions: boolean;
  freshInfoRequest: boolean;
  oldParam: string;
  newParam: string;
  appendSignature: string;
}

export interface PromptRule {
  id: string;
  dedupeKey: string;
  section: PromptSectionId;
  priority: number;
  appliesTo?: {
    modes?: Mode[];
    levels?: IntelligenceLevel[];
    protocols?: ToolProtocol[];
  };
  when?: (ctx: RuleRenderContext) => boolean;
  render: (ctx: RuleRenderContext) => string;
}

let cachedBuiltinSpecs: ToolSpec[] | undefined;

function defaultSpecs(): ToolSpec[] {
  if (!cachedBuiltinSpecs) {
    cachedBuiltinSpecs = builtinTools().map((t) => t.spec);
  }
  return cachedBuiltinSpecs;
}

/**
 * Derive `edit_file` patch argument names directly from the active ToolSpec
 * (`old_str`/`new_str` for built-in tools, falling back to `find`/`replace` only
 * if a custom spec explicitly declares them). Fixes S-1.
 */
export function editFilePatchParamNames(specs?: readonly ToolSpec[]): {
  oldParam: string;
  newParam: string;
} {
  const pool = specs && specs.length > 0 ? specs : defaultSpecs();
  const editSpec = pool.find((s) => s.name === "edit_file") ?? defaultSpecs().find((s) => s.name === "edit_file");
  const paramNames = new Set((editSpec?.params ?? []).map((p) => p.name));
  if (paramNames.has("old_str") || !paramNames.has("find")) {
    return {
      oldParam: paramNames.has("old_str") ? "old_str" : "old_str",
      newParam: paramNames.has("new_str") ? "new_str" : "new_str",
    };
  }
  return { oldParam: "find", newParam: paramNames.has("replace") ? "replace" : "new_str" };
}

/** Format `tool(required_arg1, required_arg2)` directly from ToolSpec.params. */
export function toolRequiredSignature(toolName: string, specs?: readonly ToolSpec[]): string {
  const pool = specs && specs.length > 0 ? specs : defaultSpecs();
  const spec = pool.find((s) => s.name === toolName) ?? defaultSpecs().find((s) => s.name === toolName);
  const required = (spec?.params ?? []).filter((p) => p.required).map((p) => p.name);
  return required.length ? `${toolName}(${required.join(", ")})` : `${toolName}()`;
}

/** Keep at most one rule per `dedupeKey` (highest-priority rule first). */
export function selectDeduplicatedRules(
  rules: readonly PromptRule[],
  ctx: RuleRenderContext,
  claimedKeys: Set<string> = new Set()
): { kept: PromptRule[]; droppedIds: string[] } {
  const applicable = rules
    .filter((r) => {
      if (r.appliesTo?.modes && !r.appliesTo.modes.includes(ctx.mode)) return false;
      if (r.appliesTo?.levels && !r.appliesTo.levels.includes(ctx.level)) return false;
      if (r.appliesTo?.protocols && !r.appliesTo.protocols.includes(ctx.protocol)) return false;
      if (r.when && !r.when(ctx)) return false;
      return true;
    })
    .sort((a, b) => a.priority - b.priority);

  const kept: PromptRule[] = [];
  const droppedIds: string[] = [];
  for (const rule of applicable) {
    if (claimedKeys.has(rule.dedupeKey)) {
      droppedIds.push(rule.id);
      continue;
    }
    claimedKeys.add(rule.dedupeKey);
    kept.push(rule);
  }
  return { kept, droppedIds };
}

export const CORE_PROMPT_RULES: readonly PromptRule[] = [
  // --- Live / External Info Directive (highest priority when triggered) ---
  {
    id: "fresh_info_directive",
    dedupeKey: "web_live_facts",
    section: "fresh_info",
    priority: 10,
    when: (ctx) => ctx.freshInfoRequest,
    render: () =>
      [
        "CRITICAL — LIVE / EXTERNAL INFORMATION REQUIRED:",
        "- This request depends on current, real-time, or external facts (weather, prices, news, versions, docs).",
        "- You MUST call `web_search` FIRST before answering. Do NOT guess or answer from training memory.",
        "- If `web_search` snippets only contain generic site descriptions or links without the exact number, live price, or fact requested, you MUST call `web_fetch` on the best URL from the search results to read the actual page content — NEVER tell the user to visit/check the links themselves without calling `web_fetch` first.",
        "- Extract exact facts (numbers, dates, conditions, URLs) from the tool result to synthesize a direct answer.",
      ].join("\n"),
  },

  // --- Mode Role & Boundaries ---
  {
    id: "chat_mode_role",
    dedupeKey: "chat_readonly_boundary",
    section: "mode",
    priority: 20,
    appliesTo: { modes: ["chat"] },
    render: (ctx) => {
      const guided = ctx.level === "max" || ctx.level === "high";
      if (!guided) {
        return "You are in CHAT mode (read-only). Answer using read-only inspection (`read_file`, `list_dir`, `find_files`, `search_code`, `query_project_context`) and `web_search`/`web_fetch` for external facts. Workspace editing and terminal command tools are disabled in Chat mode — if asked to edit files, provide manual steps/code and suggest switching to **Agent** mode.";
      }
      const lines = [
        "You are in CHAT mode. Answer accurately using conversation context, **Maintained Project Context**, read-only inspection tools (`read_file`, `list_dir`, `find_files`, `search_code`, `code_outline`, `get_diagnostics`, `query_project_context`), and live web search — without modifying anything.",
      ];
      if (!ctx.freshInfoRequest) {
        lines.push(
          "- For live or external facts (weather, prices, news, releases, docs), immediately call `web_search` (and `web_fetch` if needed); never say \"I will search\" without calling the tool."
        );
      }
      lines.push(
        "- STRICT READ-ONLY BOUNDARY: Workspace editing and terminal command tools are disabled in Chat mode. Never edit, create, move, or delete files or run shell commands. If asked to modify files, inspect them read-only if helpful, give clear **manual** edit steps/code snippets, and suggest switching the mode selector to **Agent** mode."
      );
      return lines.join("\n");
    },
  },
  {
    id: "plan_mode_role",
    dedupeKey: "plan_readonly_boundary",
    section: "mode",
    priority: 20,
    appliesTo: { modes: ["plan"] },
    render: (ctx) => {
      const guided = ctx.level === "max" || ctx.level === "high";
      if (!guided) {
        return "You are in PLAN mode (read-only). First inspect relevant code with `query_project_context`/`read_file`. Actively converse with the user to clarify ambiguity — ask at most 2–4 focused questions (with recommended defaults) rather than too many at once — then present a clear ordered plan. Never edit or create files in Plan mode.";
      }
      return [
        "You are in PLAN mode (read-only). Collaborate interactively with the user to craft the right implementation plan.",
        "- Step 1 (INSPECT FIRST): Check **Maintained Project Context** or use read-only tools (`query_project_context`, `find_files`, `search_code`, `read_file` with `start_line`/`end_line`, or `web_search`) before asking the user questions answerable from code.",
        "- Step 2 (INTERACTIVE CLARIFICATION): When requirements, scope, edge cases, or trade-offs are ambiguous, share what you found and ask **at most 2–4 focused clarifying questions** (with recommended defaults) and wait for the user's reply.",
        "- Step 3 (DRAFT PLAN): Once clear, produce a numbered plan referencing exact file paths, symbols, steps, edge cases, and verification steps. Remind the user they can switch to **Agent** mode to execute it.",
        "- Never edit or create files in Plan mode. Never run shell commands.",
      ].join("\n");
    },
  },
  {
    id: "agent_mode_role",
    dedupeKey: "agent_continuity",
    section: "mode",
    priority: 20,
    appliesTo: { modes: ["agent"] },
    render: (ctx) => {
      const guided = ctx.level === "max" || ctx.level === "high";
      if (!guided) {
        return "You are in AGENT mode with full tool access (reads, edits, file creation, terminal commands, web, and MCP tools). Follow any prior Chat/Plan decisions and verify changes step by step.";
      }
      return [
        "You are in AGENT mode (full autonomous engineering access: workspace read/edit/create/append/move, terminal commands, verification, web, and connected MCP tools).",
        "- Honor prior decisions and any agreed plan from earlier Chat or Plan turns in this conversation.",
        "- Check **Maintained Project Context** below for pre-matched files and symbol ranges (`Lstart-Lend`), or call `query_project_context` before running broad searches.",
      ].join("\n");
    },
  },

  // --- Native Tool Coaching (only when toolInstructions string is empty) ---
  {
    id: "native_tool_coaching",
    dedupeKey: "tool_discipline",
    section: "tools",
    priority: 30,
    when: (ctx) => !ctx.hasToolInstructions && ctx.protocol === "native",
    render: (ctx) => {
      if (ctx.level === "low") {
        return "Use the provided native tools whenever you need workspace files or current web information. Call one tool at a time and ground your response in the returned tool output.";
      }
      const rules = [
        "## Tool Calling Discipline (Strict)",
        "1. **Action over Narration**: Invoke the tool call directly instead of replying with only a promise like \"I will search\" or \"Let me read the file\".",
        "2. **Zero Hallucination**: Never fabricate file paths, file contents, command outputs, URLs, or live data. Call the tool first.",
        "3. **One Focused Step at a Time**: Call the most relevant tool, inspect its `tool` result, then act or answer.",
      ];
      if (ctx.mode === "agent") {
        rules.push(
          `4. **Safe File Editing**: Always call \`read_file\` before \`edit_file\`, copying \`${ctx.oldParam}\` verbatim from \`read_file\` and putting the replacement in \`${ctx.newParam}\`. Use \`write_file\` only for new files.`
        );
      }
      return rules.join("\n");
    },
  },

  // --- Result Framing ---
  {
    id: "result_framing_guide",
    dedupeKey: "result_framing",
    section: "result_framing",
    priority: 40,
    appliesTo: { levels: ["medium", "high", "max"] },
    render: (ctx) => {
      if (ctx.level === "medium") {
        return "When you receive a tool result: synthesize the key facts directly in clear Markdown. Do not repeat identical tool calls or dump raw unprocessed logs.";
      }
      return [
        "## How to Frame Your Answer After a Tool Result",
        "- **Synthesize, Don't Dump**: Extract the exact facts (numbers, temperatures, file names, line numbers, symbols, URLs) that answer the request cleanly.",
        "- **Know When to Stop**: Once tool outputs answer the question (or confirm your edit passed diagnostics), stop calling tools and write your final Markdown response.",
        ctx.mode === "chat"
          ? "- **Chat Synthesis**: After inspecting files or `web_search`, immediately summarize the findings directly."
          : ctx.mode === "plan"
            ? "- **Plan & Clarify**: Ground questions and the final Markdown implementation plan in the inspected tool outputs."
            : "- **Error Recovery**: On tool error, read the hint and fix the path, search first, or adjust arguments — never repeat the exact failing call.",
      ].join("\n");
    },
  },

  // --- Agent Workflow ---
  {
    id: "agent_workflow",
    dedupeKey: "agent_step_workflow",
    section: "workflow",
    priority: 50,
    appliesTo: { modes: ["agent"] },
    render: (ctx) => {
      if (ctx.level === "max" || ctx.level === "high") {
        return [
          "## Structured Engineering Workflow",
          "1. **ORIENT**: Use `list_dir`, `find_files`, or `search_code` to locate exact files and symbols. Never guess paths.",
          "2. **PLAN**: For 3+ step tasks, track progress with `todo_write` (`action: \"set\"`).",
          "3. **READ**: Call `read_file` (using `start_line`/`end_line` when known) before modifying any file.",
          `4. **EDIT**: Apply minimal, accurate changes with \`edit_file\` (exact \`${ctx.oldParam}\`/\`${ctx.newParam}\` copied from \`read_file\`), \`${ctx.appendSignature}\`, or \`write_file\` (new files only).`,
          "5. **VERIFY**: Run `get_diagnostics` after edits and `run_command` when tests/builds are needed.",
          "6. **REPORT**: Summarize verified changes concisely (call `update_project_context` for lasting architectural decisions).",
        ].join("\n");
      }
      return [
        "Working across files:",
        "- Locate before guessing: `find_files`/`search_code`/`list_dir`.",
        `- Always \`read_file\` before \`edit_file\` (\`${ctx.oldParam}\`/\`${ctx.newParam}\`) or \`write_file\`.`,
        "- One focused mutation at a time, then verify with `get_diagnostics`.",
      ].join("\n");
    },
  },

  // --- Formatting & Language Integrity ---
  {
    id: "formatting_and_language",
    dedupeKey: "formatting_rules",
    section: "formatting",
    priority: 60,
    render: (ctx) => {
      const langRule =
        "Language Integrity: Always reply strictly in the user's language (English by default). Never insert unsolicited parenthetical Chinese, Japanese, or other foreign language translations/glosses (e.g., do NOT write `(多模式代理)` or `(架构概览)`).";
      const singleBlockRule =
        "When presenting a full Markdown/README file that contains code snippets inside it, wrap the ENTIRE file in ONE single 4-backtick block (````markdown ... ````) so nested ``` fences stay together cleanly for copying.";
      if (ctx.level === "max" || ctx.level === "high") {
        return `Formatting: Reply in clean GitHub-flavored Markdown using fenced code blocks with language tags and inline backticks for paths, commands, and identifiers. ${singleBlockRule} Never claim an unexecuted action was completed.\n${langRule}`;
      }
      return `Formatting: reply in GitHub-flavored Markdown with fenced code blocks and concise lists. ${singleBlockRule} Only report actions supported by tool results.\n${langRule}`;
    },
  },
];
