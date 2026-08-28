import { clamp, fail, ok, type Tool, type TodoItem } from "../types";

/**
 * Task checklist (à la Claude Code's TodoWrite). Long agentic tasks fall apart
 * in small models when the plan lives only in "memory" — each step the model
 * re-derives what's left and drifts. Writing the list down gives every later
 * step a stable anchor, and the rendered checklist doubles as progress the
 * user can see.
 *
 * The whole list is replaced on each call (simplest possible semantics for a
 * weak model: "send the current state of the list").
 */
export const todoWriteTool: Tool = {
  spec: {
    name: "todo_write",
    summary: "Write your task checklist for this job. Call again to update statuses as you work.",
    params: [
      { name: "items", type: "string", required: true, description: 'The full checklist, one item per line. Prefix each line with "[ ]" (to do), "[>]" (in progress), or "[x]" (done).' },
    ],
    sideEffecting: false,
    priority: 11,
    minTier: "medium",
    tags: ["plan"],
    example:
      '[TOOL todo_write]\nitems:\n```\n[x] Find where sessions are persisted\n[>] Add updatedAt to save path\n[ ] Update tests\n```\n[/TOOL]',
  },
  async execute(args, ctx) {
    const raw = (args.items as string) ?? "";
    const items = parseTodoLines(raw);
    if (items.length === 0) {
      return fail(
        'No checklist items found. Put one item per line, each starting with "[ ]", "[>]", or "[x]".'
      );
    }
    ctx.todos.length = 0;
    ctx.todos.push(...items);

    const done = items.filter((i) => i.status === "done").length;
    const current = items.find((i) => i.status === "in_progress");
    return ok(
      renderTodos(items) +
        `\n(${done}/${items.length} done${current ? ` — now working on: ${current.text}` : ""}). Keep this list updated as you complete steps.`
    );
  },
};

/** Parse `- [ ] text` / `[x] text` / `[>] text` lines. Unprefixed lines are
 *  accepted as pending — forgiving by design, since weak models forget markers. */
function parseTodoLines(raw: string): TodoItem[] {
  const out: TodoItem[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim().replace(/^[-*]\s*/, "");
    if (!t) continue;
    if (/^\[x\]/i.test(t)) out.push({ status: "done", text: t.replace(/^\[x\]\s*/i, "") });
    else if (/^\[>\]/.test(t)) out.push({ status: "in_progress", text: t.replace(/^\[>\]\s*/, "") });
    else if (/^\[\s?\]/.test(t)) out.push({ status: "pending", text: t.replace(/^\[\s?\]\s*/, "") });
    else out.push({ status: "pending", text: t });
  }
  return out.filter((i) => i.text.trim());
}

export function renderTodos(items: TodoItem[]): string {
  return clamp(
    items
      .map((i) => (i.status === "done" ? "[x]" : i.status === "in_progress" ? "[>]" : "[ ]") + ` ${i.text}`)
      .join("\n"),
    2000
  );
}

/**
 * Scratchpad for structured thinking before acting (the "think" tool pattern).
 * Zero side effects — it exists so a model can plan multi-step work, do
 * arithmetic, or reconcile tool results WITHOUT emitting those as visible chat
 * or burning a real action. Especially valuable for mid-tier models that
 * otherwise conflate planning with doing.
 */
export const thinkTool: Tool = {
  spec: {
    name: "think",
    summary: "Reason privately: plan steps, check assumptions, or review tool results before acting.",
    params: [
      { name: "thought", type: "string", required: true, description: "Your reasoning. Not shown to the user; nothing is executed." },
    ],
    sideEffecting: false,
    priority: 12,
    minTier: "medium",
    tags: ["reasoning"],
    example:
      '[TOOL think]\nthought:\n```\nThe user wants the export renamed in both api.ts and its test.\nSteps: 1) search_code "exportData" 2) edit both files 3) get_diagnostics.\n``` \n[/TOOL]',
  },
  async execute(args) {
    const thought = (args.thought as string) ?? "";
    if (!thought.trim()) return fail("Provide the thought to reason through.");
    return ok(
      "Noted. Continue with your next tool call — act on this reasoning now."
    );
  },
};
