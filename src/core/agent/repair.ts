import type { AdaptivePlan, ToolSpec } from "../../shared/types";

// Hard ceiling on corrective retries for a single malformed batch. Bounded so a
// model that can't produce a valid call never spins — after this we degrade
// gracefully rather than loop (M9 checklist).
export const MAX_REPAIRS = 2;

/**
 * Build a terse corrective micro-prompt for a malformed tool call. Deliberately
 * short: it competes for the same scarce context that caused the failure, so it
 * states only the errors, the exact schema, and the required format. For tools
 * named in the errors, a worked example is included — seeing one correct call
 * fixes most format mistakes far faster than another prose explanation.
 */
export function buildRepairPrompt(
  errors: string[],
  specs: ToolSpec[],
  plan: AdaptivePlan
): string {
  const schema = specs
    .map((s) => `${s.name}(${s.params.map((p) => `${p.name}${p.required ? "" : "?"}:${p.type}`).join(", ")})`)
    .join("\n");

  // Tools the model fumbled (mentioned in the error lines) get a worked example.
  const examples = specs
    .filter((s) => s.example && errors.some((e) => e.startsWith(`${s.name}:`) || e.includes(`"${s.name}"`)))
    .slice(0, 2)
    .map((s) => `Example for ${s.name}:\n${s.example}`);

  const format =
    plan.toolProtocol === "native"
      ? "Reply with a single valid tool call (structured), nothing else."
      : [
          "Reply with EXACTLY one block, nothing else:",
          "[TOOL tool_name]",
          "arg_name: value",
          "[/TOOL]",
        ].join("\n");

  return [
    "Your last tool call was invalid:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Valid tools and their arguments:",
    schema,
    ...(examples.length ? ["", ...examples] : []),
    "",
    format,
  ].join("\n");
}
