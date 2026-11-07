import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveInWorkspace, toWorkspaceRelative } from "../paths";
import { clampToolResult, fail, ok, toolError, type Tool, type ToolContext } from "../types";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "out", ".venv", "__pycache__", ".next", "build",
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_SCANNED = 4000;
const MAX_DEPTH = 25;
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm", ".mp4", ".mp3", ".woff", ".woff2",
  ".ttf", ".eot", ".class", ".jar", ".pyc", ".lock",
]);

function matchCap(ctx: ToolContext): number {
  switch (ctx.capability) {
    case "max": return 150;
    case "high": return 80;
    case "medium": return 40;
    default: return 25;
  }
}

export const findFilesTool: Tool = {
  spec: {
    name: "find_files",
    summary: "Find files by name or pattern. Use this when you know part of a file NAME (not its contents) — for contents use search_code.",
    params: [
      { name: "pattern", type: "string", required: true, description: 'File name fragment or glob, e.g. "*.ts" or "button". Example: "**/*.config.*".' },
      { name: "path", type: "string", required: false, description: "Subdirectory to search in. Defaults to workspace root." },
    ],
    sideEffecting: false,
    priority: 4,
    minTier: "low",
    tags: ["fs", "search", "read"],
    example: '```tool\nTOOL_NAME: find_files\nBEGIN_ARG: pattern\n**/*.config.*\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    const pattern = ((args.pattern as string) ?? (args.query as string) ?? "").trim().replace(/^["']|["']$/g, "");
    const subPath = (args.path as string)?.trim();
    if (!pattern) return toolError("invalid_args", `Missing required argument "pattern". You must provide a file name or glob.\n\nCorrect format:\n\u0060\u0060\u0060tool\nTOOL_NAME: find_files\nBEGIN_ARG: pattern\n**/*.ts\nEND_ARG\n\u0060\u0060\u0060\n\nCommon patterns: \"*.ts\", \"**/*.config.*\", \"button\" (name fragment), \"src/**/*.test.*\"`, { recovery: { action: "repair", hints: ["Use pattern as the argument name, not path or query", "Example: pattern=**/*.ts"] } });
    try {
      // If path is given, we could filter but ctx.findFiles is global; we pass pattern and filter later if needed
      const hits = await ctx.findFiles(pattern, matchCap(ctx));
      let filtered = hits;
      if (subPath && subPath !== "." && subPath !== "/") {
        const norm = subPath.replace(/\\/g, "/").replace(/\/$/, "");
        filtered = hits.filter(h => h.startsWith(norm + "/") || h === norm);
      }
      if (filtered.length === 0) {
        return ok(`No files matched "${pattern}". Try a broader pattern or list_dir on the likely folder.`);
      }
      const note = filtered.length >= matchCap(ctx) ? `\n… (showing first ${filtered.length})` : "";
      return ok(clampToolResult(filtered.join("\n") + note));
    } catch (e) {
      return toolError("execution_error", `Search failed: ${(e as Error).message}`);
    }
  },
};

export const searchCodeTool: Tool = {
  spec: {
    name: "search_code",
    summary: "Search file CONTENTS across the workspace (like grep). Use this to find where a function, class, or text is defined or used.",
    params: [
      { name: "query", type: "string", required: true, description: "Text to search for. Keep it short — one function or class name works best. Example: \"getUserById\"." },
      { name: "path", type: "string", required: false, description: "Subdirectory to limit the search to." },
      { name: "regex", type: "boolean", required: false, description: "true = treat query as a regular expression (default false: literal text)." },
    ],
    sideEffecting: false,
    priority: 6,
    minTier: "low",
    tags: ["search", "read"],
    example: '```tool\nTOOL_NAME: search_code\nBEGIN_ARG: query\ngetUserById\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    const rawQuery = (args.query as string)?.trim();
    if (!rawQuery) return toolError("invalid_args", `Missing required argument "query". Provide a non-empty query.`);
    const useRegex = args.regex === true || args.is_regex === true;
    const caseSensitive = args.case_sensitive === true;
    const includeGlob = (args.include as string)?.trim().replace(/^["']|["']$/g, "");

    let re: RegExp;
    try {
      re = new RegExp(useRegex ? rawQuery : escapeRegExp(rawQuery), caseSensitive ? "" : "i");
    } catch (e) {
      return toolError("invalid_args", `Invalid regular expression: ${(e as Error).message}. Set regex: false to search for literal text instead.`);
    }

    const rel = (args.path as string) || ".";
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return toolError("not_found", r.error, { recovery: { action: "search" } });

    const maxMatches = matchCap(ctx);
    const blocks: string[] = [];
    let totalMatches = 0;
    let filesWithMatches = 0;
    let filesScanned = 0;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (
        depth > MAX_DEPTH ||
        totalMatches >= maxMatches ||
        filesScanned >= MAX_FILES_SCANNED ||
        ctx.signal.aborted
      ) {
        return;
      }
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const dirQueue: string[] = [];
      for (const e of entries) {
        if (totalMatches >= maxMatches || filesScanned >= MAX_FILES_SCANNED) break;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!IGNORE_DIRS.has(e.name)) dirQueue.push(abs);
          continue;
        }
        if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
        if (includeGlob && !nameMatches(e.name, includeGlob)) continue;
        try {
          const stat = await fs.stat(abs);
          if (stat.size > MAX_FILE_BYTES) continue;
          filesScanned++;
          const content = await fs.readFile(abs, "utf8");
          const lines = content.split("\n");
          let fileHitCount = 0;
          for (let i = 0; i < lines.length && totalMatches < maxMatches; i++) {
            re.lastIndex = 0;
            if (!re.test(lines[i])) continue;
            fileHitCount++;
            totalMatches++;
            blocks.push(`${toWorkspaceRelative(ctx.workspaceRoot, abs)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          }
          if (fileHitCount > 0) filesWithMatches++;
        } catch {
          // skip
        }
        if (filesScanned % 20 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      for (let i = 0; i < dirQueue.length; i += 4) {
        await Promise.all(dirQueue.slice(i, i + 4).map((d) => walk(d, depth + 1)));
      }
    };

    await walk(r.abs, 0);

    if (totalMatches === 0) {
      const capped = filesScanned >= MAX_FILES_SCANNED ? " (search limit reached)" : "";
      return ok(`No matches for "${rawQuery}"${capped}. Try: a shorter query, different casing, or find_files if you're looking for a file NAME.`);
    }
    const header = `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"}:\n`;
    const note =
      totalMatches >= maxMatches ? `\n… (stopped at ${maxMatches} matches — narrow the query or add path)` : "";
    return ok(clampToolResult(header + blocks.join("\n") + note));
  },
};

export const codeOutlineTool: Tool = {
  spec: {
    name: "code_outline",
    summary: "List a file's symbols (functions, classes, methods, exports, types) with line numbers — without reading the whole file. Use this FIRST on big files, then read_file the relevant range.",
    params: [
      { name: "path", type: "string", required: true, description: "File path relative to the workspace root. Example: \"src/core/agent/engine.ts\"." },
    ],
    sideEffecting: false,
    priority: 10,
    minTier: "medium",
    tags: ["fs", "read", "navigate"],
    example: '```tool\nTOOL_NAME: code_outline\nBEGIN_ARG: path\nsrc/core/agent/engine.ts\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    const rel = args.path as string;
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return toolError("not_found", r.error, { recovery: { action: "search" } });
    try {
      const raw = await fs.readFile(r.abs, "utf8");
      const lines = raw.split("\n");
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 300) continue;
        for (const re of OUTLINE_RES) {
          const m = line.match(re);
          if (m) {
            out.push(`${String(i + 1).padStart(5)} │ ${line.trim().slice(0, 160)}`);
            break;
          }
        }
        if (out.length >= 200) break;
      }
      if (out.length === 0) {
        return ok(`No recognizable symbols in ${rel} (${lines.length} lines). Use read_file to view it.`);
      }
      return ok(clampToolResult(`# Outline of ${rel}\n${out.join("\n")}`));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return toolError("not_found", `ENOENT: no file at "${rel}". Did you mean one of:\n- src/index.tsx\n- src/main.ts\nUse find_files to search if unsure of the exact path.`, { recovery: { action: "search" } });
      }
      return toolError("execution_error", `Could not read "${rel}": ${err.message}`);
    }
  },
};

const OUTLINE_RES: RegExp[] = [
  /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(export\s+)?(interface|type|enum|namespace)\s+[A-Za-z_$][\w$]*/,
  /^\s*(export\s+)?default\s+function\b/,
  /^\s*(public|private|protected|static|async|override|\s)*\s*[A-Za-z_$][\w$]*\s*\([^;{]*\)\s*(:[^{]+)?\{\s*$/,
  /^\s*def\s+[A-Za-z_]\w*\s*\(/,
  /^\s*class\s+[A-Za-z_]\w*/,
  /^\s*func\s+(\([^)]*\)\s*)?[A-Za-z_]\w*\s*\(/,
  /^\s*(pub\s+)?fn\s+[A-Za-z_]\w*/,
  /^\s*(public|private|protected|internal)\s+(static\s+)?[\w<>\[\],\s]+\s+[A-Za-z_]\w*\s*\(/,
];

function nameMatches(name: string, pattern: string): boolean {
  if (!/[*?]/.test(pattern)) return name.toLowerCase().includes(pattern.toLowerCase());
  const re = new RegExp(
    "^" + pattern.split("*").map(escapeRegExp).join(".*").split("?").join(".") + "$",
    "i"
  );
  return re.test(name);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
