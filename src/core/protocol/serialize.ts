import type { AdaptivePlan, ToolSpec } from "../../shared/types";

/**
 * Continue-style tool instructions for small local models.
 * Primary format is the fenced block (raw values, no JSON escaping).
 * The <tool_call> JSON envelope is still accepted by the parser as an
 * alternative for single-line args — see parse.ts leniency.
 * Spec §4: Tool definitions budget ~250-400 tok, filtered per mode.
 */
export function renderToolInstructions(
  tools: ToolSpec[],
  plan: AdaptivePlan
): string {
  if (tools.length === 0) return "";
  const terse = plan.intelligence === "low";
  const list = tools.map((t) => renderToolSpec(t, terse)).join("\n");
  // Show worked examples for up to 3 tools — small models copy patterns,
  // and a single example at the top is too easy to forget by tool #5.
  const exampleCount = plan.intelligence === "max" ? 5 : plan.intelligence === "high" ? 4 : 3;
  const examples = tools.slice(0, Math.min(exampleCount, tools.length))
    .map((t) => renderExampleCall(t, terse))
    .join("\n\n");

  return [
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
    "Examples:",
    examples,
    "",
    "ALTERNATIVE FORMAT — only for single-line values (never for file contents):",
    "<tool_call>",
    '{"tool": "<name>", "args": { ... }}',
    "</tool_call>",
    "",
    "Available tools for this mode:",
    list,
    "",
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
          "   For ADD/APPEND requests use append_file(path, content) — it preserves all old content.",
          "   append_file requires EXACTLY two arguments: path and content. Never omit either one.",
          "   Example: TOOL_NAME: append_file, BEGIN_ARG: path, temp.md, END_ARG, BEGIN_ARG: content, your text, END_ARG.",
          "   For targeted updates use edit_file with old_str copied from read_file and new_str.",
          "   write_file is CREATE-ONLY. Never use it on an existing file.",
        ]
      : [
          `8. CRITICAL — Read-Only Mode (${plan.mode}): NEVER invoke file-editing, file-writing, move, or shell command tools — they are disabled in ${plan.mode} mode.`,
        ]),
  ].join("\n");
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

export function toNativeTools(tools: ToolSpec[]): unknown[] {
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

/** Spec §3.1: Photon result envelope */
export function renderToolResult(
  name: string,
  result: string,
  ok: boolean
): string {
  const status = ok ? "ok" : "error";
  return `<tool_result tool="${name}" status="${status}">\n${result}\n</tool_result>`;
}
