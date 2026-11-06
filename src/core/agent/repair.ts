import type { AdaptivePlan, ToolSpec } from "../../shared/types";

// Spec §5: retry same logical step at most 2 times, then blocked
export const MAX_REPAIRS = 2;

export function buildRepairPrompt(
  errors: string[],
  specs: ToolSpec[],
  plan: AdaptivePlan
): string {
  // Continue-style: show the fenced format with the failing tool's worked
  // example first — weak models fix a concrete example, not an abstract schema.
  const failing = specs.filter((s) => s.example && errors.some((e) => e.startsWith(`${s.name}:`) || e.includes(`"${s.name}"`)));
  const others = specs.filter((s) => !failing.includes(s));
  // FIX: Always include web_search and web_fetch in the repair prompt when the
  // failure involved a web call. Previously these could be cut by the 4-tool
  // limit, leaving the model without the format it needs to retry correctly.
  const webTools = specs.filter(s => (s.name === "web_search" || s.name === "web_fetch") && !failing.includes(s));
  const hasWebFailure = errors.some(e => e.includes("web_search") || e.includes("web_fetch"));
  const webGuaranteed = hasWebFailure ? webTools : [];
  const ordered = [...failing, ...webGuaranteed, ...others.filter(s => !webGuaranteed.includes(s))].slice(0, 4);
  const defs = ordered
    .map((s) => {
      const args = s.params.map((p) => `TOOL_ARG: ${p.name} (${p.type}, ${p.required ? "required" : "optional"})${p.description ? `\n${p.description}` : ""}\nEND_ARG`).join("\n");
      return `\`\`\`tool_definition\nTOOL_NAME: ${s.name}\nTOOL_DESCRIPTION:\n${s.summary}\n${args}\n\`\`\``;
    })
    .join("\n");

  const examples = failing
    .slice(0, 2)
    .map((s) => `Correct example for ${s.name} — copy this shape exactly:\n${s.example}`);

  return [
    "Your last tool call was invalid. Read the error, fix it, and try again — do NOT repeat the same call unchanged:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Use EXACTLY this format (values are raw text, no escaping):",
    "```tool",
    "TOOL_NAME: <tool name>",
    "BEGIN_ARG: <arg name>",
    "<value>",
    "END_ARG",
    "```",
    "",
    ...(examples.length ? [...examples, ""] : []),
    "Available tools:",
    defs,
    "",
    "Reply with EXACTLY one tool block and nothing else. If this tool keeps",
    "failing, try a DIFFERENT tool that could get the same information.",
  ].join("\n");
}
