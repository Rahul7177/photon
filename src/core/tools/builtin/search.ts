import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveInWorkspace, toWorkspaceRelative } from "../paths";
import { clamp, fail, ok, outputBudget, type Tool, type ToolContext } from "../types";

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

/** Match cap scaled by model capability — strong models can digest more. */
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
    summary: "Find files by name or pattern. Returns matching paths.",
    params: [
      { name: "query", type: "string", required: true, description: 'Part of a file name ("button"), a path fragment ("utils/date"), or a glob ("**/*.test.ts").' },
    ],
    sideEffecting: false,
    priority: 4,
    minTier: "low",
    tags: ["fs", "search", "read"],
    example: '[TOOL find_files]\nquery: **/*.config.*\n[/TOOL]',
  },
  async execute(args, ctx) {
    const query = (args.query as string)?.trim().replace(/^["']|["']$/g, "");
    if (!query) return fail("Provide part of a file name or a glob pattern.");
    try {
      // Native, index-backed search — fast even on large repos. Globs are
      // passed through untouched; plain text becomes a substring match.
      const hits = await ctx.findFiles(query, matchCap(ctx));
      if (hits.length === 0) {
        return ok(
          `No files matching "${query}". Try a shorter fragment of the name, a different extension, or search_code if you're looking for file CONTENT.`
        );
      }
      const note = hits.length >= matchCap(ctx) ? `\n… (showing first ${hits.length})` : "";
      return ok(clamp(hits.join("\n") + note, 4000));
    } catch (e) {
      return fail(`Search failed: ${(e as Error).message}`);
    }
  },
};

export const searchCodeTool: Tool = {
  spec: {
    name: "search_code",
    summary: "Search file contents across the workspace (like grep). Supports regex and surrounding-context lines.",
    params: [
      { name: "query", type: "string", required: true, description: "Text or regex to search for." },
      { name: "is_regex", type: "boolean", required: false, description: "true = treat query as a regular expression (default false: literal text)." },
      { name: "case_sensitive", type: "boolean", required: false, description: "true = case-sensitive (default false)." },
      { name: "path", type: "string", required: false, description: "Subdirectory to limit the search to." },
      { name: "include", type: "string", required: false, description: 'Only search files whose name matches this fragment or glob, e.g. "*.ts".' },
      { name: "context_lines", type: "number", required: false, description: "Lines of context around each match (0-4, default 0)." },
    ],
    sideEffecting: false,
    priority: 6,
    minTier: "low",
    tags: ["search", "read"],
    example: '[TOOL search_code]\nquery: getUserById\ninclude: *.ts\ncontext_lines: 2\n[/TOOL]',
  },
  async execute(args, ctx) {
    const rawQuery = (args.query as string)?.trim();
    if (!rawQuery) return fail("Provide a non-empty query.");
    const useRegex = args.is_regex === true;
    const caseSensitive = args.case_sensitive === true;
    const contextLines = Math.max(0, Math.min(4, Math.floor(Number(args.context_lines) || 0)));
    const includeGlob = (args.include as string)?.trim().replace(/^["']|["']$/g, "");

    let re: RegExp;
    try {
      re = new RegExp(useRegex ? rawQuery : escapeRegExp(rawQuery), caseSensitive ? "" : "i");
    } catch (e) {
      return fail(
        `Invalid regular expression: ${(e as Error).message}. Set is_regex: false to search for literal text instead.`
      );
    }

    const rel = (args.path as string) || ".";
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return fail(r.error);

    const maxMatches = matchCap(ctx);
    const budget = outputBudget(ctx);
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
            if (contextLines === 0) {
              blocks.push(`${toWorkspaceRelative(ctx.workspaceRoot, abs)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
            } else {
              const from = Math.max(0, i - contextLines);
              const to = Math.min(lines.length, i + contextLines + 1);
              const ctxText = lines
                .slice(from, to)
                .map((l, k) => `${String(from + k + 1).padStart(5)} │ ${l}`)
                .join("\n");
              blocks.push(`${toWorkspaceRelative(ctx.workspaceRoot, abs)}:${i + 1}:\n${ctxText}`);
            }
          }
          if (fileHitCount > 0) filesWithMatches++;
        } catch {
          // binary or unreadable — skip
        }
        // Yield every 20 files to keep host responsive (audit)
        if (filesScanned % 20 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      // Recurse dirs in parallel batches of 4 (audit: previous depth-first serial blocked)
      for (let i = 0; i < dirQueue.length; i += 4) {
        await Promise.all(dirQueue.slice(i, i + 4).map((d) => walk(d, depth + 1)));
      }
    };

    await walk(r.abs, 0);

    if (totalMatches === 0) {
      const capped = filesScanned >= MAX_FILES_SCANNED ? " (search limit reached)" : "";
      return ok(
        `No matches for "${rawQuery}"${capped}. Try: a shorter query, different casing (add case_sensitive: true), an include filter like "*.ts", or find_files if you're looking for a file NAME.`
      );
    }
    const header = `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"}:\n`;
    const note =
      totalMatches >= maxMatches ? `\n… (stopped at ${maxMatches} matches — narrow the query or add include/path)` : "";
    return ok(clamp(header + blocks.join("\n") + note, budget));
  },
};

/** Symbol outline of a source file — navigate big files without reading them whole. */
export const codeOutlineTool: Tool = {
  spec: {
    name: "code_outline",
    summary: "List a file's symbols (functions, classes, methods, exports, types) with line numbers.",
    params: [
      { name: "path", type: "string", required: true, description: "File path relative to the workspace root." },
    ],
    sideEffecting: false,
    priority: 10,
    minTier: "medium",
    tags: ["fs", "read", "navigate"],
    example: '[TOOL code_outline]\npath: src/core/agent/engine.ts\n[/TOOL]',
  },
  async execute(args, ctx) {
    const rel = args.path as string;
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return fail(r.error);
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
      return ok(`# Outline of ${rel}\n${clamp(out.join("\n"), 5000)}`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return fail(`"${rel}" does not exist. Use find_files to locate the correct path.`);
      }
      return fail(`Could not read "${rel}": ${err.message}`);
    }
  },
};

// Ordered patterns covering the common languages (TS/JS/Python/Go/Rust/Java/C#).
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

/** Case-insensitive name match against a fragment or simple glob (`*.ts`). */
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
