import { clamp, fail, ok, toolError, type Tool, type TodoItem } from "../types";

// §8 Todo list protocol — external memory for Agent mode
// Format per spec: {"action": "set"|"update"|"get", "items": [{"id": 1, "task": "...", "status": "pending"}]}
// Also supports legacy string format for leniency

export const todoWriteTool: Tool = {
  spec: {
    name: "todo_write",
    summary: "Manage the task list (your external memory). For multi-step tasks, call this FIRST with action set and one item per step — then mark items done as you finish them.",
    params: [
      { name: "action", type: "string", required: false, description: 'Action: "set" (replace the whole list), "update" (change one item), or "get" (read the list). Default "set".' },
      { name: "items", type: "string", required: false, description: 'For set: JSON array like [{"id":1,"task":"...","status":"pending"}]. Statuses: pending, in_progress, done, blocked.' },
      { name: "id", type: "number", required: false, description: "For update: the item id to change." },
      { name: "status", type: "string", required: false, description: 'For update: new status "pending", "in_progress", "done", or "blocked".' },
    ],
    sideEffecting: false,
    priority: 11,
    minTier: "low",
    tags: ["plan"],
    example: '```tool\nTOOL_NAME: todo_write\nBEGIN_ARG: action\nset\nEND_ARG\nBEGIN_ARG: items\n[{"id": 1, "task": "Find getUserById and read it", "status": "in_progress"}, {"id": 2, "task": "Fix the missing-user crash", "status": "pending"}]\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    const action = ((args.action as string) || "set").toLowerCase();
    if (action === "get") {
      if (ctx.todos.length === 0) return ok("(no todos yet)");
      return ok(renderTodos(ctx.todos));
    }
    if (action === "update") {
      const id = Number(args.id);
      const status = String(args.status || "").toLowerCase();
      if (!Number.isFinite(id)) return toolError("invalid_args", `Missing required argument "id" for update.`);
      if (!["pending", "in_progress", "done", "blocked"].includes(status)) return toolError("invalid_args", `Invalid status "${status}". Use pending, in_progress, done, or blocked.`);
      const item = ctx.todos.find(t => t.id === id);
      if (!item) return toolError("not_found", `No todo with id ${id}.`);
      item.status = status as TodoItem["status"];
      if (args.reason) item.reason = String(args.reason);
      // Also handle task rename if provided
      if (args.task) item.task = String(args.task);
      return ok(renderTodos(ctx.todos) + `\nUpdated [${id}] → ${status}.`);
    }
    // action === "set"
    let raw = args.items as unknown;
    // Also support legacy: items as string checklist
    if (typeof raw === "string") {
      const items = parseTodoLines(raw);
      if (items.length === 0) {
        // Try JSON parse
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            const mapped = parsed.map((it: any, idx: number) => ({
              id: Number(it.id) || idx + 1,
              task: String(it.task || it.text || ""),
              status: normalizeStatus(String(it.status || "pending")),
              reason: it.reason ? String(it.reason) : undefined,
            })).filter((i: TodoItem) => i.task.trim());
            if (mapped.length) {
              ctx.todos.length = 0;
              ctx.todos.push(...mapped);
              return ok(renderTodos(ctx.todos) + `\n(${mapped.filter(i=>i.status==="done").length}/${mapped.length} done). Keep this list updated as you complete steps.`);
            }
          }
        } catch {}
        return toolError("invalid_args", `No checklist items found. Provide a JSON array like [{"id":1,"task":"...","status":"pending"}] or checklist lines with [ ]/[>]/[x].`);
      }
      // Map legacy TodoItem (text) to spec TodoItem (task)
      const mapped: TodoItem[] = items.map((it, idx) => ({
        id: idx + 1,
        task: (it as any).text || (it as any).task || "",
        status: (it as any).status as TodoItem["status"],
      }));
      ctx.todos.length = 0;
      ctx.todos.push(...mapped);
      const done = mapped.filter((i) => i.status === "done").length;
      const current = mapped.find((i) => i.status === "in_progress");
      return ok(renderTodos(mapped) + `\n(${done}/${mapped.length} done${current ? ` — now working on: ${current.task}` : ""}). Keep this list updated as you complete steps.`);
    }
    if (Array.isArray(raw)) {
      const mapped: TodoItem[] = (raw as any[]).map((it: any, idx: number) => ({
        id: Number(it.id) || idx + 1,
        task: String(it.task || it.text || ""),
        status: normalizeStatus(String(it.status || "pending")),
        reason: it.reason ? String(it.reason) : undefined,
      })).filter((i: TodoItem) => i.task.trim());
      if (mapped.length === 0) return toolError("invalid_args", `No checklist items found. Provide items like [{"id":1,"task":"...","status":"pending"}].`);
      ctx.todos.length = 0;
      ctx.todos.push(...mapped);
      const done = mapped.filter((i) => i.status === "done").length;
      return ok(renderTodos(mapped) + `\n(${done}/${mapped.length} done). Keep this list updated as you complete steps.`);
    }
    // Try to handle object with items property
    if (raw && typeof raw === "object" && Array.isArray((raw as any).items)) {
      return this.execute({ action: "set", items: (raw as any).items } as any, ctx);
    }
    return toolError("invalid_args", `Missing required argument "items". Provide a JSON array like [{"id":1,"task":"...","status":"pending"}].`);
  },
};

function normalizeStatus(s: string): TodoItem["status"] {
  const lower = s.toLowerCase().trim();
  if (lower === "done" || lower === "completed" || lower === "x") return "done";
  if (lower === "in_progress" || lower === "in-progress" || lower === ">" || lower === "doing") return "in_progress";
  if (lower === "blocked") return "blocked";
  return "pending";
}

function parseTodoLines(raw: string): { status: string; text: string }[] {
  const out: { status: string; text: string }[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim().replace(/^[-*]\s*/, "");
    if (!t) continue;
    if (/^\[x\]/i.test(t)) out.push({ status: "done", text: t.replace(/^\[x\]\s*/i, "") });
    else if (/^\[>\]/.test(t)) out.push({ status: "in_progress", text: t.replace(/^\[>\]\s*/, "") });
    else if (/^\[\s?\]/.test(t)) out.push({ status: "pending", text: t.replace(/^\[\s?\]\s*/, "") });
    else if (/^\[blocked\]/i.test(t)) out.push({ status: "blocked", text: t.replace(/^\[blocked\]\s*/i, "") });
    else out.push({ status: "pending", text: t });
  }
  return out.filter((i) => i.text.trim());
}

export function renderTodos(items: TodoItem[]): string {
  return clamp(
    items
      .map((i) => {
        const marker = i.status === "done" ? "[x]" : i.status === "in_progress" ? "[>]" : i.status === "blocked" ? "[blocked]" : "[ ]";
        const reason = i.status === "blocked" && i.reason ? ` — ${i.reason}` : "";
        return `${marker} [${i.id}] ${i.task}${reason}`;
      })
      .join("\n"),
    2000
  );
}

export const thinkTool: Tool = {
  spec: {
    name: "think",
    summary: "Private scratchpad — state in one line what you are about to do and why, BEFORE a mutating call (edit_file, write_file, move_path, run_command). No side effects.",
    params: [
      { name: "thought", type: "string", required: true, description: "Your reasoning in one line. Nothing is executed — act on it with your NEXT tool call." },
    ],
    sideEffecting: false,
    priority: 12,
    minTier: "low",
    tags: ["reasoning"],
    example: '```tool\nTOOL_NAME: think\nBEGIN_ARG: thought\nReplace the throw with a return null so the function stops crashing on a missing user.\nEND_ARG\n```',
  },
  async execute(args) {
    const thought = (args.thought as string) ?? "";
    if (!thought.trim()) return toolError("invalid_args", `Missing required argument "thought". Provide the thought to reason through.`);
    return ok("Noted. Continue with your next tool call — act on this reasoning now.");
  },
};
