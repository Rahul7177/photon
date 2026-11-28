import type { AdaptivePlan, AgentPhase, ToolSpec } from "../../shared/types";
import { estimateTokens } from "../adaptive/tokens";
import { editFilePatchParamNames, toolRequiredSignature } from "../prompts/rulebook";

export interface ToolInstructionsRenderResult {
  text: string;
  exampleToolNames: string[];
  toolCount: number;
  examplesTokens: number;
  definitionsTokens: number;
  rulesTokens: number;
}

export interface ToolInstructionsRenderOptions {
  phase?: AgentPhase;
  failingTools?: readonly string[];
}

/**
 * Continue-style tool instructions for small local models.
 * Primary format is the fenced block (raw values, no JSON escaping).
 * The <tool_call> JSON envelope is still accepted by the parser as an
 * alternative for single-line args — see parse.ts leniency.
 * Spec §4: Tool definitions budget ~250-400 tok, filtered per mode.
 */
export function renderToolInstructions(
  tools: ToolSpec[],
  plan: AdaptivePlan,
  options?: ToolInstructionsRenderOptions
): string {
  return renderToolInstructionsWithMeta(tools, plan, options).text;
}

export function renderToolInstructionsWithMeta(
  tools: ToolSpec[],
  plan: AdaptivePlan,
  options?: ToolInstructionsRenderOptions
): ToolInstructionsRenderResult {
  if (tools.length === 0) {
    return {
      text: "",
      exampleToolNames: [],
      toolCount: 0,
      examplesTokens: 0,
      definitionsTokens: 0,
      rulesTokens: 0,
    };
  }
  const terse = plan.intelligence === "low";
  const profile = plan.scaffoldProfile;
  const useCompactSurface =
    Boolean(profile && plan.scaffoldOptimizations !== false && profile.toolCards !== "full");

  let list: string;
  let exampleTools: ToolSpec[];

  if (!useCompactSurface || !profile) {
    list = tools.map((t) => renderToolSpec(t, terse)).join("\n");
    // Legacy path (flag-off or raw AdaptivePlan): keep 100% byte-identical output.
    const exampleCount = plan.intelligence === "max" ? 5 : plan.intelligence === "high" ? 4 : 3;
    exampleTools = tools.slice(0, Math.min(exampleCount, tools.length));
    if (options?.failingTools?.length) {
      const seen = new Set(exampleTools.map((t) => t.name));
      for (const fname of options.failingTools) {
        if (seen.has(fname)) continue;
        const found = tools.find((t) => t.name === fname);
        if (found) {
          exampleTools.push(found);
          seen.add(fname);
        }
      }
    }
  } else {
    const isMcp = (t: ToolSpec) => Boolean(t.tags?.includes("mcp") || t.name.startsWith("mcp_"));
    const failingSet = new Set(options?.failingTools ?? []);
    const shortlistCap = profile.toolCards === "names_only" ? 0 : Math.max(1, profile.shortlistSize);

    const primaryTools: ToolSpec[] = [];
    const seenPrimary = new Set<string>();
    for (const t of tools) {
      if (primaryTools.length >= shortlistCap) break;
      if (isMcp(t)) continue;
      primaryTools.push(t);
      seenPrimary.add(t.name);
    }
    for (const t of tools) {
      if (failingSet.has(t.name) && !seenPrimary.has(t.name)) {
        primaryTools.push(t);
        seenPrimary.add(t.name);
      }
    }
    const secondaryTools = tools.filter((t) => !seenPrimary.has(t.name));

    const parts: string[] = [];
    if (primaryTools.length > 0) {
      parts.push(primaryTools.map((t) => renderShortlistToolSpec(t, terse)).join("\n"));
    }
    if (secondaryTools.length > 0) {
      parts.push(
        "Other callable tools (same ```tool format — supply listed args):",
        ...secondaryTools.map((t) => renderOneLineToolSpec(t))
      );
    }
    list = parts.join("\n");

    const seenEx = new Set<string>();
    exampleTools = [];
    const addEx = (t: ToolSpec | undefined) => {
      if (!t || seenEx.has(t.name)) return;
      seenEx.add(t.name);
      exampleTools.push(t);
    };

    if (profile.examples !== "none") {
      const exCap = plan.mode === "chat" ? 2 : 3;
      const candidatePool = primaryTools.length > 0 ? primaryTools : tools.filter((t) => !isMcp(t));
      if (options?.phase === "edit") {
        addEx(tools.find((t) => t.name === "edit_file"));
        addEx(tools.find((t) => t.name === "append_file"));
      }
      for (const t of candidatePool) {
        if (exampleTools.length >= exCap) break;
        addEx(t);
      }
    }
    if (profile.examples === "phase+failing" || failingSet.size > 0) {
      for (const t of tools) {
        if (failingSet.has(t.name)) addEx(t);
      }
    }
  }

  const exampleToolNames = exampleTools.map((t) => t.name);
  const examples = exampleTools
    .map((t) => renderExampleCall(t, terse))
    .join("\n\n");

  const { oldParam, newParam } = editFilePatchParamNames(tools);
  const appendSignature = toolRequiredSignature("append_file", tools);
  const rulesLines = [
    "RULES FOR TOOL USE:",
    "1. Call exactly ONE tool per response, then STOP — write nothing after the closing fence/tag.",
    "2. Always start the tool block on a new line. The tool block MUST be the last thing in your response.",
    "3. Do NOT use XML tags like <function=...> and do NOT invent tools or arguments not listed above.",
    "4. If the request can be addressed with a listed tool, USE IT rather than guessing from memory.",
    "5. Do not perform actions with hypothetical files — use list_dir/find_files to confirm paths first.",
    "6. Never write a <tool_result> block yourself. Photon runs the tool and gives you the real result.",
    "7. CRITICAL — Web & current info: If the user asks about anything that changes over time (latest",
    "   versions, news, prices, weather, current events, recent releases, live data), you MUST call",
    "   web_search FIRST. Never answer these from memory — your training data is outdated. Call the tool.",
    ...(plan.mode === "agent"
      ? [
          "8. CRITICAL — File edits: Before changing an existing file, call read_file first.",
          `   For ADD/APPEND requests use ${appendSignature} — it preserves all old content and requires all listed arguments.`,
          "   Example: TOOL_NAME: append_file, BEGIN_ARG: path, temp.md, END_ARG, BEGIN_ARG: content, your text, END_ARG.",
          `   For targeted updates use edit_file with ${oldParam} copied from read_file and ${newParam}.`,
          "   write_file is CREATE-ONLY. Never use it on an existing file.",
        ]
      : [
          `8. CRITICAL — Read-Only Mode (${plan.mode}): NEVER invoke file-editing, file-writing, move, or shell command tools — they are disabled in ${plan.mode} mode.`,
        ]),
  ];

  const text = [
    "You have access to tools. To call a tool, respond with EXACTLY one tool block, then stop.",
    "",
    "PRIMARY FORMAT — use this (values are raw text, NO escaping needed):",
    "```tool",
    "TOOL_NAME: <tool name>",
    "BEGIN_ARG: <arg name>",
    "<value — raw text, can span many lines>",
    "END_ARG",
    "```",
    "",
    ...(examples ? ["Examples:", examples, ""] : []),
    "ALTERNATIVE FORMAT — only for single-line values (never for file contents):",
    "<tool_call>",
    '{"tool": "<name>", "args": { ... }}',
    "</tool_call>",
    "",
    "Available tools for this mode:",
    list,
    "",
    ...rulesLines,
  ].join("\n");

  return {
    text,
    exampleToolNames,
    toolCount: tools.length,
    examplesTokens: estimateTokens(examples),
    definitionsTokens: estimateTokens(list),
    rulesTokens: estimateTokens(rulesLines.join("\n")),
  };
}

function compactSentence(text: string, maxChars: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const firstPeriod = clean.indexOf(". ");
  const sentence = firstPeriod > 0 && firstPeriod < maxChars ? clean.slice(0, firstPeriod + 1) : clean;
  if (sentence.length <= maxChars) return sentence;
  return sentence.slice(0, Math.max(20, maxChars - 1)).trimEnd() + "…";
}

function renderShortlistToolSpec(t: ToolSpec, terse: boolean): string {
  const lines = ["```tool_definition", `TOOL_NAME: ${t.name}`];
  if (t.summary) lines.push(`TOOL_DESCRIPTION: ${compactSentence(t.summary, 130)}`);
  for (const p of t.params) {
    const req = p.required ? "required" : "optional";
    if (terse || !p.description) {
      lines.push(`TOOL_ARG: ${p.name} (${p.type}, ${req})`, "END_ARG");
    } else {
      lines.push(`TOOL_ARG: ${p.name} (${p.type}, ${req})`, compactSentence(p.description, 85), "END_ARG");
    }
  }
  lines.push("```");
  return lines.join("\n");
}

function renderOneLineToolSpec(t: ToolSpec): string {
  const params = t.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(", ");
  const summary = compactSentence(t.summary, 95);
  return summary ? `- ${t.name}(${params}): ${summary}` : `- ${t.name}(${params})`;
}

function renderToolSpec(t: ToolSpec, terse: boolean): string {
  const lines = ["```tool_definition", `TOOL_NAME: ${t.name}`];
  if (t.summary) lines.push(`TOOL_DESCRIPTION:\n${t.summary}`);
  for (const p of t.params) {
    const req = p.required ? "required" : "optional";
    if (terse) {
      lines.push(`TOOL_ARG: ${p.name} (${p.type}, ${req})`);
    } else {
      lines.push(`TOOL_ARG: ${p.name} (${p.type}, ${req})`);
      if (p.description) lines.push(p.description);
    }
    lines.push("END_ARG");
  }
  lines.push("```");
  return lines.join("\n");
}

/** Worked example for the first tool — small models copy patterns, not abstract rules. */
function renderExampleCall(t: ToolSpec, terse: boolean): string {
  if (t.example && t.example.includes("```tool")) return t.example;
  const args = t.params
    .filter((p) => p.required)
    .map((p) => `BEGIN_ARG: ${p.name}\n<${p.name}>\nEND_ARG`)
    .join("\n");
  return ["```tool", `TOOL_NAME: ${t.name}`, args || "BEGIN_ARG: path\nsrc/index.ts\nEND_ARG", "```"]
    .filter(Boolean)
    .join("\n");
}

export interface NativeToolsOptions {
  compact?: boolean;
  shortlistSize?: number;
  failingTools?: readonly string[];
}

export function toNativeTools(tools: ToolSpec[], options?: NativeToolsOptions): unknown[] {
  if (!options?.compact) {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.summary,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            t.params.map((p) => [
              p.name,
              { type: p.type, description: p.description },
            ])
          ),
          required: t.params.filter((p) => p.required).map((p) => p.name),
        },
      },
    }));
  }

  const isMcp = (t: ToolSpec) => Boolean(t.tags?.includes("mcp") || t.name.startsWith("mcp_"));
  const shortlistCap = Math.max(1, options.shortlistSize ?? 5);
  const failingSet = new Set(options.failingTools ?? []);
  const primarySet = new Set<string>();
  for (const t of tools) {
    if (primarySet.size >= shortlistCap) break;
    if (isMcp(t)) continue;
    primarySet.add(t.name);
  }
  for (const t of tools) {
    if (failingSet.has(t.name)) primarySet.add(t.name);
  }

  return tools.map((t) => {
    const isPrimary = primarySet.has(t.name);
    return {
      type: "function",
      function: {
        name: t.name,
        description: compactSentence(t.summary, isPrimary ? 120 : 60),
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            t.params.map((p) => {
              const desc = isPrimary && p.description ? compactSentence(p.description, 75) : undefined;
              return [
                p.name,
                desc ? { type: p.type, description: desc } : { type: p.type },
              ];
            })
          ),
          required: t.params.filter((p) => p.required).map((p) => p.name),
        },
      },
    };
  });
}

/** Spec §3.1: Photon result envelope */
export function renderToolResult(
  name: string,
  result: string,
  ok: boolean
): string {
  const status = ok ? "ok" : "error";
  return `<tool_result tool="${name}" status="${status}">\n${result}\n</tool_result>`;
}
