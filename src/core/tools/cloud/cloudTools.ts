import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Mode, ToolCall } from "../../../shared/types";
import { locateEdit, listDirTool, readFileTool } from "../builtin/files";
import { codeOutlineTool, findFilesTool, searchCodeTool } from "../builtin/search";
import { getDiagnosticsTool } from "../builtin/verify";
import { todoWriteTool } from "../builtin/plan";
import { webSearchTool, webFetchTool } from "../builtin/web";
import { queryProjectContextTool, updateProjectContextTool } from "../builtin/context";
import { getProjectContextManager } from "../../context/projectContext";
import { resolveInWorkspace } from "../paths";
import { clamp, fail, ok, outputBudget, type Tool } from "../types";
import { analyzeCommandSecurity } from "../security";

/**
 * The CLOUD tool set — used only by CloudEngine's native tool-calling loop.
 *
 * Deliberately separate from the local (block-protocol) tools: names and shapes
 * follow the conventions capable models already know from agentic coding tools
 * while reusing Photon's hardened workspace and web implementations.
 *
 * The active policy is set by the cloud runtime for each request:
 *   all  = normal coding/agent task
 *   web  = pure external-information request
 *   none = conversational turn with no tool need (0 tool schemas sent)
 */
export type CloudToolPolicy = "all" | "web" | "none";
let activeCloudToolPolicy: CloudToolPolicy = "all";

export function setCloudToolPolicy(policy: CloudToolPolicy): void {
  activeCloudToolPolicy = policy;
}

export function getCloudToolPolicy(): CloudToolPolicy {
  return activeCloudToolPolicy;
}

/**
 * Request-aware tool surface: greetings get no tools, pure external-info
 * requests get web tools first, agent/plan modes get mode-appropriate tools.
 */
export function classifyCloudToolPolicy(mode: unknown, text: string): CloudToolPolicy {
  const t = text.trim().toLowerCase();
  if (!t) return "all";
  if (
    /^(hi|hello|hey|hiya|yo|thanks|thank you|thx|ok|okay|great|cool|nice|good morning|good afternoon|good evening)[\s,!.?]*$/i.test(
      t
    )
  ) {
    return "none";
  }
  if (mode === "agent" || mode === "plan") return "all";
  const workspaceIntent =
    /\b(file|files|folder|directory|workspace|repo|repository|codebase|code|class|function|symbol|bug|error|stack trace|edit|modify|change|implement|refactor|debug|fix|write|read|search files|list files|build|test|compile|lint|run command|search|find|show|open|list|get|create|add|remove|delete|rename|move|copy|update|set|configure|install|uninstall|run|start|stop|restart|check|format|deploy|push|pull|commit|merge|branch|clone|init|setup)\b/i.test(
      t
    );
  const externalIntent =
    /\b(weather|temperature|forecast|news|current|today|tonight|latest|live|recent|price|prices|stock|stocks|market|release|version|time|date|traffic|search|lookup|find out|what is|what are|how to|who is|where is)\b/i.test(
      t
    );
  if (externalIntent && !workspaceIntent) return "web";
  return "all";
}

interface WebSearchState {
  calls: number;
  cache: Map<string, string>;
}

const WEB_SEARCH_STATE = new WeakMap<AbortSignal, WebSearchState>();
const MAX_WEB_SEARCH_CALLS = 3;

const COMMAND_TIMEOUT_MS = 180_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;

export const cloudReadFile: Tool = {
  spec: {
    name: "read_file",
    summary: "Read the contents of a file at the given path. Prefer start_line/end_line for large files to save tokens.",
    params: [
      { name: "path", type: "string", required: true, description: "File path relative to the workspace root." },
      { name: "start_line", type: "number", required: false, description: "Optional 1-based first line (for large files)." },
      { name: "end_line", type: "number", required: false, description: "Optional 1-based last line." },
    ],
    sideEffecting: false,
    priority: 1,
    tags: ["fs", "read"],
  },
  execute: readFileTool.execute,
};

export const cloudWriteFile: Tool = {
  spec: {
    name: "write_to_file",
    summary: "Write full contents to a file: create a new file or completely overwrite an existing one.",
    params: [
      { name: "path", type: "string", required: true, description: "File path relative to the workspace root." },
      { name: "content", type: "string", required: true, description: "The COMPLETE file contents. Never truncate or abbreviate; never use placeholders." },
    ],
    sideEffecting: true,
    priority: 2,
    tags: ["fs", "write"],
  },
  async execute(args, ctx) {
    const rel = args.path as string;
    const content = (args.content as string) ?? "";
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return fail(r.error);
    const approved = await ctx.requestApproval(mkCall("write_to_file", args, ctx.pendingCallId));
    if (!approved) return fail("User declined the write.");
    try {
      await ctx.checkpointTracker?.recordBeforeChange(rel);
      await fs.mkdir(path.dirname(r.abs), { recursive: true });
      await fs.writeFile(r.abs, content, "utf8");
      const lines = content.split("\n").length;
      void getProjectContextManager(ctx.workspaceRoot)?.recordFileEdit(rel, `Wrote file (${lines} lines)`);
      return ok(`Wrote ${rel} (${lines} lines).`);
    } catch (e) {
      return fail(`Could not write "${rel}": ${(e as Error).message}`);
    }
  },
};

export const cloudReplaceInFile: Tool = {
  spec: {
    name: "replace_in_file",
    summary: "Make targeted edits to an existing file by replacing an exact snippet.",
    params: [
      { name: "path", type: "string", required: true, description: "File to edit, relative to the workspace root." },
      { name: "find", type: "string", required: true, description: "The EXACT existing text to replace (copy verbatim; include surrounding lines to make it unique)." },
      { name: "replace", type: "string", required: true, description: "The replacement text." },
      { name: "replace_all", type: "boolean", required: false, description: "Replace every occurrence (default false)." },
    ],
    sideEffecting: true,
    priority: 3,
    tags: ["fs", "write"],
  },
  async execute(args, ctx) {
    const rel = args.path as string;
    const find = args.find as string;
    const replace = (args.replace as string) ?? "";
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return fail(r.error);
    if (!find?.trim()) return fail('"find" must not be empty.');
    let original: string;
    try {
      original = await fs.readFile(r.abs, "utf8");
    } catch (e) {
      return fail(`Could not read "${rel}": ${(e as Error).message}`);
    }
    const result = locateEdit(original, find, replace, args.replace_all === true);
    if ("error" in result) return fail(`${result.error} (in ${rel})`);
    const approved = await ctx.requestApproval(mkCall("replace_in_file", args, ctx.pendingCallId));
    if (!approved) return fail("User declined the edit.");
    try {
      await ctx.checkpointTracker?.recordBeforeChange(rel);
      await fs.writeFile(r.abs, result.text, "utf8");
      const startLine = original.slice(0, result.firstIndex).split("\n").length;
      void getProjectContextManager(ctx.workspaceRoot)?.recordFileEdit(
        rel,
        `Edited at line ~${startLine} (${result.count} replacement${result.count === 1 ? "" : "s"})`
      );
      return ok(`Edited ${rel} (${result.count} replacement${result.count === 1 ? "" : "s"}).`);
    } catch (e) {
      return fail(`Could not write "${rel}": ${(e as Error).message}`);
    }
  },
};

export const cloudExecuteCommand: Tool = {
  spec: {
    name: "execute_command",
    summary: "Run a shell command in the workspace root and return its output.",
    params: [
      { name: "command", type: "string", required: true, description: "The shell command to run." },
      { name: "timeout_ms", type: "number", required: false, description: "Optional timeout in ms (default 180000, max 600000)." },
    ],
    sideEffecting: true,
    priority: 4,
    tags: ["exec", "write"],
  },
  async execute(args, ctx) {
    const command = (args.command as string)?.trim();
    if (!command) return fail("Provide a command.");
    if (findShellChaining(command)) {
      return fail(
        `Run one command at a time — chaining is not allowed. Split into separate calls. Got: "${command.slice(0, 120)}"`
      );
    }
    if (!ctx.workspaceRoot) return fail("No workspace folder is open.");
    const requested = Number(args.timeout_ms);
    const timeoutMs =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), 600_000)
        : COMMAND_TIMEOUT_MS;
    const secAnalysis = analyzeCommandSecurity(command);
    const toolCall = mkCall("execute_command", args, ctx.pendingCallId);
    if (secAnalysis.isDangerous) {
      toolCall.risk = "critical";
      toolCall.statusDetail = `High-risk action: ${secAnalysis.reason}`;
    }
    const approved = await ctx.requestApproval(toolCall);
    if (ctx.signal.aborted) return fail("Command cancelled.");
    if (!approved) return fail(secAnalysis.isDangerous ? `User declined high-risk action: ${secAnalysis.reason}` : "User declined to run the command.");
    ctx.log(`$ ${command}`);
    return new Promise((resolve) => {
      if (ctx.signal.aborted) return resolve(fail("Command cancelled."));
      let settled = false;
      const finish = (res: ReturnType<typeof ok>) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };
      let child: ReturnType<typeof exec> | undefined;
      const onAbort = () => {
        if (child) {
          try { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); } catch { /* ignore */ }
          try { child.kill(); } catch { /* ignore */ }
          if (process.platform === "win32" && child.pid) {
            try { exec(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true }); } catch { /* ignore */ }
          }
        }
        finish(fail("Command cancelled."));
      };
      child = exec(
        command,
        { cwd: ctx.workspaceRoot, timeout: timeoutMs, maxBuffer: COMMAND_MAX_BUFFER, windowsHide: true },
        (error, stdout, stderr) => {
          ctx.signal.removeEventListener("abort", onAbort);
          if (settled || ctx.signal.aborted) return finish(fail("Command cancelled."));
          const out = [stdout, stderr].filter(Boolean).join("\n").trim();
          const code = error ? ((error as unknown as { code?: number }).code ?? 1) : 0;
          const header = `Exit code ${code}.`;
          const outputText = `${header}\n${clamp(out || error?.message || "(no output)", outputBudget(ctx))}`;
          if (code !== 0) {
            // Return full stdout and stderr so the cloud model knows exactly why the command or test failed
            return finish(fail(outputText));
          }
          finish(ok(outputText));
        }
      );
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export const cloudFindFiles: Tool = {
  spec: {
    name: "find_files",
    summary: "Find files by name or glob pattern (e.g. '*.tsx' or 'auth'). Much faster and more token-efficient than recursive list_files.",
    params: [
      { name: "pattern", type: "string", required: true, description: "File name fragment or glob pattern (e.g. '**/*.ts', 'Button')." },
      { name: "path", type: "string", required: false, description: "Optional subdirectory to restrict the search." },
    ],
    sideEffecting: false,
    priority: 5,
    tags: ["fs", "search", "read"],
  },
  execute: findFilesTool.execute,
};

export const cloudSearchFiles: Tool = {
  spec: {
    name: "search_files",
    summary: "Search file contents across the workspace (regex supported).",
    params: [
      { name: "query", type: "string", required: true, description: "Text or regex to search for." },
      { name: "path", type: "string", required: false, description: "Subdirectory to limit the search to." },
      { name: "include", type: "string", required: false, description: 'File filter, e.g. "*.ts".' },
      { name: "is_regex", type: "boolean", required: false, description: "Treat query as a regex (default false)." },
    ],
    sideEffecting: false,
    priority: 6,
    tags: ["search", "read"],
  },
  execute: searchCodeTool.execute,
};

export const cloudListFiles: Tool = {
  spec: {
    name: "list_files",
    summary: "List files and directories at a path.",
    params: [
      { name: "path", type: "string", required: false, description: "Directory relative to the workspace root (default root)." },
      { name: "recursive", type: "boolean", required: false, description: "Also list subdirectories (default false)." },
    ],
    sideEffecting: false,
    priority: 7,
    tags: ["fs", "read"],
  },
  execute: listDirTool.execute,
};

export const cloudListDefinitions: Tool = {
  spec: {
    name: "list_code_definition_names",
    summary: "List the top-level code definitions (functions, classes, types) defined in a source file.",
    params: [{ name: "path", type: "string", required: true, description: "File path relative to the workspace root." }],
    sideEffecting: false,
    priority: 8,
    tags: ["fs", "read", "navigate"],
  },
  execute: codeOutlineTool.execute,
};

export const cloudGetDiagnostics: Tool = {
  spec: {
    name: "get_diagnostics",
    summary: "Get VS Code compiler/linter errors and warnings for a file or the workspace. Call this after editing code instead of running a full build command.",
    params: [
      { name: "path", type: "string", required: false, description: "Optional file path relative to workspace root. Omit for workspace-wide diagnostics." },
    ],
    sideEffecting: false,
    priority: 9,
    tags: ["verify", "read"],
  },
  execute: getDiagnosticsTool.execute,
};

export const cloudTodoWrite: Tool = {
  spec: {
    name: "todo_write",
    summary: "Create or update a task checklist for complex multi-step engineering tasks.",
    params: [
      { name: "action", type: "string", required: false, description: '"set", "update", or "get". Default "set".' },
      { name: "items", type: "string", required: false, description: 'JSON array like [{"id":1,"task":"...","status":"pending"}].' },
      { name: "id", type: "number", required: false, description: "Item id to update." },
      { name: "status", type: "string", required: false, description: '"pending", "in_progress", "done", or "blocked".' },
    ],
    sideEffecting: false,
    priority: 10,
    tags: ["plan"],
  },
  execute: todoWriteTool.execute,
};

/** Public web search for cloud models, with evidence enrichment and loop protection. */
export const cloudWebSearch: Tool = {
  ...webSearchTool,
  spec: { ...webSearchTool.spec, priority: 11, minTier: undefined },
  async execute(args, ctx) {
    const query = (args.query as string)?.trim();
    if (!query) return fail("Provide a search query.");
    const state = getWebSearchState(ctx.signal);
    const key = normalizeSearchQuery(query);
    const cached = state.cache.get(key);
    if (cached) return ok(`${cached}\n\n[Photon reused the existing web evidence for this repeated query.]`);
    if (state.calls >= MAX_WEB_SEARCH_CALLS) {
      return ok(
        `${[...state.cache.values()][0] ?? "No usable web evidence has been collected."}\n\n[Photon stopped repeated web searches for this turn. Use web_fetch on a relevant source above or answer from the evidence already collected.]`
      );
    }
    state.calls++;
    const result = await webSearchTool.execute(args, ctx);
    if (!result.ok) return result;

    let output = result.output;
    if (isFreshOrExactQuery(query)) {
      const urls = [...output.matchAll(/https:\/\/[^\s)]+/gi)]
        .map((m) => m[0].replace(/[.,;]+$/, ""))
        .filter((url, i, all) => all.indexOf(url) === i)
        .slice(0, 1);
      if (urls[0]) {
        const fetched = await webFetchTool.execute({ url: urls[0] }, ctx);
        if (fetched.ok) {
          output += `\n\n--- PRIMARY SOURCE EVIDENCE ---\n${fetched.output}\n--- END PRIMARY SOURCE EVIDENCE ---`;
        } else {
          output += "\n\nIMPORTANT: This is a search lead only. For an exact/current value, fetch one of the returned URLs before answering.";
        }
      }
    }

    output = clamp(output, outputBudget(ctx));
    state.cache.set(key, output);
    return ok(output);
  },
};

/** Public HTTPS fetch available to cloud models using the same hardened implementation as local Photon. */
export const cloudWebFetch: Tool = { ...webFetchTool, spec: { ...webFetchTool.spec, priority: 12, minTier: undefined } };

export const cloudAskFollowup: Tool = {
  spec: {
    name: "ask_followup_question",
    summary: "Ask the user a question when you need information to proceed.",
    params: [{ name: "question", type: "string", required: true, description: "The question to ask." }],
    sideEffecting: false,
    priority: 13,
    tags: ["lifecycle"],
  },
  async execute(args) {
    return ok((args.question as string) ?? "");
  },
};

export const cloudAttemptCompletion: Tool = {
  spec: {
    name: "attempt_completion",
    summary: "Present the final result once the task is fully complete. This ends the task.",
    params: [{ name: "result", type: "string", required: true, description: "The final summary of what was done, in Markdown." }],
    sideEffecting: false,
    priority: 0,
    tags: ["lifecycle"],
  },
  async execute(args) {
    return ok((args.result as string) ?? "");
  },
};

/**
 * Returns the minimal, mode-appropriate cloud tool list to save input tokens,
 * eliminate unnecessary ceremony steps for frontier models, and prevent unintended
 * side-effects in Chat/Plan modes.
 */
export function cloudTools(mode: Mode = "agent", extraMcpTools: Tool[] = []): Tool[] {
  if (activeCloudToolPolicy === "none") return [];

  const webOnly = [cloudWebSearch, cloudWebFetch];
  if (activeCloudToolPolicy === "web") {
    return webOnly;
  }

  const readOnlyWorkspace = [
    cloudReadFile,
    cloudFindFiles,
    cloudSearchFiles,
    cloudListFiles,
    cloudListDefinitions,
    cloudGetDiagnostics,
  ];

  if (mode === "chat") {
    return [...readOnlyWorkspace, ...webOnly];
  }
  if (mode === "plan") {
    return [...readOnlyWorkspace, ...webOnly];
  }

  // Full Agent mode suite + approved MCP server tools.
  // Frontier cloud models do not need pseudo-tools (attempt_completion, ask_followup, todo_write)
  // or context management ceremony (query_project_context/update_project_context) clogging
  // their schemas because context is already pre-injected and they deliver results natively.
  return [
    cloudReadFile,
    cloudWriteFile,
    cloudReplaceInFile,
    cloudExecuteCommand,
    cloudFindFiles,
    cloudSearchFiles,
    cloudListFiles,
    cloudListDefinitions,
    cloudGetDiagnostics,
    ...webOnly,
    ...extraMcpTools,
  ];
}

function getWebSearchState(signal: AbortSignal): WebSearchState {
  let state = WEB_SEARCH_STATE.get(signal);
  if (!state) {
    state = { calls: 0, cache: new Map<string, string>() };
    WEB_SEARCH_STATE.set(signal, state);
  }
  return state;
}

function normalizeSearchQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").replace(/[?!.:,;]+$/g, "").trim();
}

function isFreshOrExactQuery(query: string): boolean {
  return /\b(today|now|right now|current|currently|latest|live|recent|as of|price|prices|weather|temperature|forecast|news|market|stock|stocks|gold|silver|bitcoin|crypto|exchange rate|rate|version|release|traffic)\b/i.test(
    query
  );
}

function mkCall(name: string, args: Record<string, unknown>, existingId?: string): ToolCall {
  return { id: existingId ?? randomUUID(), name, args, status: "proposed", sideEffecting: true };
}

/** Detect shell chaining/substitution outside quotes (mirrors builtin terminal guard). */
function findShellChaining(cmd: string): string | null {
  let sq = false,
    dq = false,
    esc = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === "'" && !dq) {
      sq = !sq;
      continue;
    }
    if (c === '"' && !sq) {
      dq = !dq;
      continue;
    }
    if (sq || dq) continue;
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") return two;
    if (c === ";" || c === "|" || c === "&" || c === "`" || c === ">" || c === "<") return c;
    if (two === "$(") return "$(";
    if (c === "\n" || c === "\r") return "\\n";
  }
  return null;
}
