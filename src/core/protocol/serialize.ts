import type { AdaptivePlan, IntelligenceLevel, ToolSpec } from "../../shared/types";

/**
 * Render the tool instructions injected into the system prompt for the
 * photon-block protocol. Verbosity scales with intelligence so low-tier models
 * spend fewer of their scarce context tokens on scaffolding.
 */
export function renderToolInstructions(
  tools: ToolSpec[],
  plan: AdaptivePlan
): string {
  if (tools.length === 0) return "";
  const list = tools.map((t) => renderToolSpec(t, plan.intelligence)).join("\n");

  if (plan.intelligence === "low") {
    // Terse but COMPLETE: every mechanic a weak model needs to form a valid
    // call (one arg per line, fenced multi-line values, stop-and-wait). Omitting
    // these saves ~30 tokens and costs whole failed turns.
    return [
      "TOOLS. Call ONE tool, then stop and wait for its result.",
      "Format — use exactly:",
      "[TOOL tool_name]",
      "arg_name: value",
      "[/TOOL]",
      "Each argument on its own line as name: value.",
      "Long values (file contents): leave the value empty, put a ``` fence on the next lines, then close the fence.",
      "Use only the tools listed below. Do not invent names or arguments.",
      "",
      list,
    ].join("\n");
  }

  const parallel = plan.allowParallelTools
    ? "You may call more than one tool if needed."
    : "Call ONE tool, then stop and wait for its result before continuing.";

  return [
    "## Tools",
    "You can act on the workspace by calling tools. To call a tool, write a block:",
    "",
    "[TOOL tool_name]",
    "arg_name: value",
    "[/TOOL]",
    "",
    "Rules:",
    `- ${parallel}`,
    "- Put each argument on its own line as `name: value`.",
    "- For long text (like file contents), put the value in a fenced code block on the next lines.",
    "- After a tool block, stop writing — the result will be given back to you.",
    "- Only use the tools listed below. Do not invent tool names or arguments.",
    "",
    "Available tools:",
    list,
  ].join("\n");
}

function renderToolSpec(t: ToolSpec, level: IntelligenceLevel): string {
  const args = t.params
    .map((p) => `${p.name}${p.required ? "" : "?"}:${p.type}`)
    .join(", ");
  if (level === "low") {
    return `- ${t.name}(${args}) — ${t.summary}`;
  }
  const paramLines = t.params
    .map(
      (p) =>
        `    - ${p.name} (${p.type}${p.required ? ", required" : ", optional"}): ${p.description}`
    )
    .join("\n");
  const effect = t.sideEffecting ? " [changes your workspace]" : "";
  return `- **${t.name}**${effect}: ${t.summary}${paramLines ? "\n" + paramLines : ""}`;
}

/** Build the Ollama-native `tools` JSON schema array for tool-trained models.
 *  The worked example is folded into the description: structured-calling models
 *  are typically capable ones with context to spare, and a concrete example
 *  measurably reduces argument mistakes. */
export function toNativeTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.example ? `${t.summary}\n\nExample:\n${t.example}` : t.summary,
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

/** Format a tool result for feeding back into the conversation. */
export function renderToolResult(
  name: string,
  result: string,
  ok: boolean
): string {
  const status = ok ? "RESULT" : "ERROR";
  return `[${status} ${name}]\n${result}\n[/${status}]`;
}
