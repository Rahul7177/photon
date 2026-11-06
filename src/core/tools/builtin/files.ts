import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../shared/types";
import { resolveInWorkspace } from "../paths";
import { clamp, clampToolResult, fail, ok, toolError, type Tool } from "../types";
import { getProjectContextManager } from "../../context/projectContext";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  ".venv",
  "__pycache__",
  ".next",
]);

const GUTTER_RE = /^\s*\d+\s*[│|]\s?/;

// A file under this size qualifies for the "no old_str, new_str is the
// whole file" shortcut in edit_file. Above it, old_str is required — this
// stops a model from "helpfully" rewriting (and truncating) a large file
// it only partially remembers.
const WHOLE_FILE_SHORTCUT_MAX_LINES = 40;

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

/** Cheap subsequence fuzzy-match score; -1 if candidate doesn't contain query's chars in order. */
function fuzzyScore(query: string, candidate: string): number {
  let qi = 0, score = 0, streak = 0;
  for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
    if (candidate[ci] === query[qi]) { qi++; streak++; score += streak; }
    else streak = 0;
  }
  if (qi < query.length) return -1;
  return score;
}

/**
 * Looks for real, existing nearby paths to suggest when a model gets a path
 * wrong — walks up to the nearest directory that actually exists and
 * fuzzy-matches its entries, instead of returning a fixed, made-up example.
 */
async function suggestNearbyPaths(workspaceRoot: string | undefined, rel: string, limit = 3): Promise<string[]> {
  if (!workspaceRoot) return [];
  const wanted = path.basename(rel).toLowerCase();
  let dir = path.dirname(rel);

  while (true) {
    // Jail every probe: a model-supplied "../../etc" must not readdir outside.
    const jailed = resolveInWorkspace(workspaceRoot, dir === "" ? "." : dir);
    if (!("error" in jailed)) {
      const abs = jailed.abs;
    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const names = entries
        .filter((e) => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
        .map((e) => (dir === "." ? e.name : `${dir}/${e.name}`) + (e.isDirectory() ? "/" : ""));
      const scored = names
        .map((n) => ({ n, s: fuzzyScore(wanted, path.basename(n).toLowerCase()) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((x) => x.n);
      if (scored.length) return scored;
      if (names.length) return names.slice(0, limit);
      // directory exists but is empty — fall through to walk up
    } catch {
      // this directory doesn't exist either — walk up
    }
    } // end jailed check — outside-workspace dirs are skipped silently
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the top
    dir = parent;
  }

  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    return entries
      .filter((e) => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
      .slice(0, limit)
      .map((e) => e.name + (e.isDirectory() ? "/" : ""));
  } catch {
    return [];
  }
}

async function notFoundMessage(workspaceRoot: string | undefined, rel: string): Promise<string> {
  if (!workspaceRoot) return "No workspace folder is open.";
  const smartCandidates = getProjectContextManager(workspaceRoot)?.resolveSmartPath(rel).candidates ?? [];
  const suggestions = smartCandidates.length > 0 ? smartCandidates : await suggestNearbyPaths(workspaceRoot, rel);
  const hint = suggestions.length
    ? `Did you mean one of:\n${suggestions.map((s) => `- ${s}`).join("\n")}`
    : `Use query_project_context or find_files to locate the correct path.`;
  return `ENOENT: no file at "${rel}". ${hint}\nUse query_project_context or find_files if unsure of the exact path.`;
}

/** Strips a leading/trailing ```lang fence if the model wrapped its content in one. */
function stripCodeFences(s: string): string {
  const lines = s.split("\n");
  if (
    lines.length >= 2 &&
    /^```[a-zA-Z0-9_+-]*\s*$/.test(lines[0].trim()) &&
    lines[lines.length - 1].trim() === "```"
  ) {
    return lines.slice(1, -1).join("\n");
  }
  return s;
}

/** Strips leading/trailing garbage lines (stray gutter chars, bullets, dashes) some parsers leak in. */
function stripLeadingTrailingGarbageLines(s: string): string {
  const lines = s.split("\n");
  while (lines.length && /^[\|\>\-\*\•\·\s]+$/.test(lines[0])) lines.shift();
  while (lines.length && /^[\|\>\-\*\•\·\s]+$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}

function cleanIncomingText(s: string): string {
  return stripLeadingTrailingGarbageLines(stripCodeFences(s));
}

/** True if a string is a leftover parser artifact rather than real content (e.g. a stray "|" or ">"). */
function isParserArtifact(s: string): boolean {
  const t = s.trim();
  return t === "" || t === "|" || t === ">" || t === "---" || t === "``" || t === "```";
}

function stripGutter(text: string): string {
  const lines = text.split("\n");
  const nonBlank = lines.filter((l) => l.trim() !== "");
  if (nonBlank.length === 0 || !nonBlank.every((l) => GUTTER_RE.test(l))) return text;
  return lines.map((l) => l.replace(GUTTER_RE, "")).join("\n");
}

function restoreEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr)];
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function locateFuzzy(
  original: string,
  find: string
): { start: number; end: number } | { count: number } {
  const origLines = original.split("\n");
  let findLines = find.split("\n").map((l) => l.replace(/\s+$/, ""));
  while (findLines.length && findLines[0].trim() === "") findLines.shift();
  while (findLines.length && findLines[findLines.length - 1].trim() === "") findLines.pop();
  if (findLines.length === 0) return { count: 0 };
  const target = findLines.map((l) => l.trim());
  const windows: number[] = [];
  for (let i = 0; i + target.length <= origLines.length; i++) {
    let match = true;
    for (let k = 0; k < target.length; k++) {
      if (origLines[i + k].trim() !== target[k]) {
        match = false;
        break;
      }
    }
    if (match) {
      windows.push(i);
      if (windows.length > 1) break;
    }
  }
  if (windows.length === 0) return { count: 0 };
  if (windows.length > 1) return { count: 2 };
  const i = windows[0];
  let start = 0;
  for (let k = 0; k < i; k++) start += origLines[k].length + 1;
  let end = start;
  for (let k = 0; k < target.length; k++) {
    end += origLines[i + k].length;
    if (k < target.length - 1) end += 1;
  }
  return { start, end };
}

export function locateEdit(
  original: string,
  find: string,
  replace: string,
  replaceAll: boolean
): { text: string; firstIndex: number; count: number } | { error: string } {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  const o = norm(original);
  const cleanFind = cleanIncomingText(norm(find));
  const candidates = uniq([cleanFind, stripGutter(cleanFind), cleanIncomingText(stripGutter(cleanFind))]);
  const rep = cleanIncomingText(norm(replace));

  for (const cand of candidates) {
    if (!cand) continue;
    const first = o.indexOf(cand);
    if (first === -1) continue;
    const total = countOccurrences(o, cand);
    if (total > 1 && !replaceAll) {
      return {
        error: `The text to change appears ${total} times. Either include more surrounding lines so the match is unique (copy from read_file), or pass replace_all: true.`,
      };
    }
    const text =
      total > 1 && replaceAll
        ? restoreEol(o.split(cand).join(rep), eol)
        : restoreEol(o.slice(0, first) + rep + o.slice(first + cand.length), eol);
    return { text, firstIndex: first, count: total > 1 && replaceAll ? total : 1 };
  }

  const fuzzy = locateFuzzy(o, stripGutter(cleanFind));
  if ("count" in fuzzy) {
    if (fuzzy.count > 1) {
      return {
        error: `The text to change matches ${fuzzy.count} places — include more surrounding lines so it's unique. Use read_file to copy the exact block you want to change.`,
      };
    }
    return {
      error: `Could not find the text to change. Fix it like this:\n1. Call read_file on this file and copy the EXACT current text you want to change (whitespace and indentation included).\n2. Paste that verbatim into "old_str", with 3-5 extra surrounding lines so it's unique.\n3. Put the replacement in "new_str". Do not guess the file content — copy it from read_file output.`,
    };
  }
  const edited = o.slice(0, fuzzy.start) + rep + o.slice(fuzzy.end);
  return { text: restoreEol(edited, eol), firstIndex: fuzzy.start, count: 1 };
}

function mkCall(name: string, args: Record<string, unknown>, existingId?: string): ToolCall {
  // FIX: Reuse the engine's call id when provided — otherwise the approval
  // request uses a fresh random id and the user's "Allow" click can never
  // resolve the right promise (pendingApprovals is keyed by id).
  return { id: existingId ?? randomUUID(), name, args, status: "proposed", sideEffecting: true };
}

// ---------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------

export const listDirTool: Tool = {
  spec: {
    name: "list_dir",
    summary: "List files and folders in a workspace directory. Use this FIRST when you don't know the layout — never guess paths.",
    params: [
      { name: "path", type: "string", required: false, description: "Directory relative to the workspace root. Defaults to the root. Example: \"src\"." },
      { name: "depth", type: "number", required: false, description: "Depth for recursive listing (0 = top level only). Omit for top level." },
    ],
    sideEffecting: false,
    priority: 5,
    minTier: "low",
    tags: ["fs", "read"],
    example: '```tool\nTOOL_NAME: list_dir\nBEGIN_ARG: path\nsrc\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    const rel = (args.path as string) || ".";
    const depth = args.depth !== undefined ? Math.floor(Number(args.depth)) : 0;
    const recursive = depth > 0 || args.recursive === true;
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    // FIX: surface the real resolution error instead of a fabricated ENOENT message.
    if ("error" in r) return toolError("not_found", r.error);
    try {
      const st = await fs.stat(r.abs).catch(() => null);
      if (!st) {
        return toolError("not_found", await notFoundMessage(ctx.workspaceRoot, rel), { recovery: { action: "search" } });
      }
      if (!st.isDirectory()) return toolError("invalid_args", `"${rel}" is a file, not a directory. Use read_file on it.`, { recovery: { action: "reread" } });

      if (!recursive) {
        const entries = await fs.readdir(r.abs, { withFileTypes: true });
        const lines = entries
          .filter((e) => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return ok(lines.length ? clampToolResult(lines.join("\n")) : "(empty directory)");
      }

      const out: string[] = [];
      const queue: { abs: string; prefix: string; depth: number }[] = [{ abs: r.abs, prefix: "", depth: 0 }];
      const maxDepth = depth > 0 ? depth : 2;
      while (queue.length && out.length < 400) {
        const node = queue.shift()!;
        let entries;
        try {
          entries = await fs.readdir(node.abs, { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) {
          if (out.length >= 400) break;
          if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
          const line = `${node.prefix}${e.name}${e.isDirectory() ? "/" : ""}`;
          out.push(line);
          if (e.isDirectory() && node.depth < maxDepth) {
            queue.push({ abs: path.join(node.abs, e.name), prefix: `${line}/`, depth: node.depth + 1 });
          }
        }
      }
      const note = out.length >= 400 ? "\n… (listing capped)" : "";
      return ok(clampToolResult(out.join("\n") + note));
    } catch (e) {
      return toolError("execution_error", `Could not list "${rel}": ${(e as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------

export const readFileTool: Tool = {
  spec: {
    name: "read_file",
    summary: "Read a file's text with line numbers. ALWAYS read a file before editing it — never guess at its contents.",
    params: [
      { name: "path", type: "string", required: true, description: "File path relative to the workspace root. Example: \"src/index.ts\"." },
      { name: "start_line", type: "number", required: false, description: "First line to read (1-based). Omit to start at the top." },
      { name: "end_line", type: "number", required: false, description: "Last line to read (1-based). Omit to read up to the default cap." },
    ],
    sideEffecting: false,
    priority: 1,
    minTier: "low",
    tags: ["fs", "read"],
    example: '```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nsrc/index.ts\nEND_ARG\nBEGIN_ARG: start_line\n1\nEND_ARG\nBEGIN_ARG: end_line\n60\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    let rel = args.path as string;
    let autoResolvedNote = "";
    const ctxMgr = getProjectContextManager(ctx.workspaceRoot);

    let r = resolveInWorkspace(ctx.workspaceRoot, rel);
    // FIX: surface the real resolution error instead of a fabricated ENOENT message.
    if ("error" in r) return toolError("not_found", r.error);
    try {
      // Guard: never read a huge/binary file fully into memory (OOM before clamp).
      const MAX_READ_BYTES = 2_000_000;
      let st: { size: number; isDirectory(): boolean } | null = null;
      try { st = await fs.stat(r.abs); } catch { /* fall through */ }

      // If path was not found directly (e.g. model omitted "src/" prefix), consult Project Context Index!
      if (!st && ctxMgr) {
        const smart = ctxMgr.resolveSmartPath(rel);
        if (smart.resolved) {
          const alt = resolveInWorkspace(ctx.workspaceRoot, smart.resolved);
          if (!("error" in alt)) {
            const altSt = await fs.stat(alt.abs).catch(() => null);
            if (altSt && !altSt.isDirectory()) {
              autoResolvedNote = `# Auto-resolved path "${rel}" → "${smart.resolved}"\n`;
              rel = smart.resolved;
              r = alt;
              st = altSt;
            }
          }
        }
      }

      if (st && st.isDirectory()) return toolError("invalid_args", `"${rel}" is a directory. Use list_dir on it.`, { recovery: { action: "reread" } });
      if (st && st.size > MAX_READ_BYTES) {
        return toolError("invalid_args", `"${rel}" is ${(st.size / 1024 / 1024).toFixed(1)}MB — too large to read fully. Pass start_line/end_line to read a range.`, { recovery: { action: "reread" } });
      }
      const raw = await fs.readFile(r.abs, "utf8");
      if (raw.includes("\0")) return toolError("invalid_args", `"${rel}" looks like a binary file — refusing to dump it as text.`, { recovery: { action: "reread" } });
      void ctxMgr?.recordFileRead(rel);

      const lines = raw.split("\n");
      const total = lines.length;

      // Never dump a whole file. Default to first 200 lines if no range given.
      const DEFAULT_CAP = 200;
      const explicitStart = Number.isFinite(Number(args.start_line)) && Number(args.start_line) > 0;
      const explicitEnd = Number.isFinite(Number(args.end_line)) && Number(args.end_line) > 0;
      let start = Math.max(1, Math.floor((args.start_line as number) || 1));
      let end = explicitEnd ? Math.floor(args.end_line as number) : total;
      if (!explicitStart && !explicitEnd && total > DEFAULT_CAP) {
        end = DEFAULT_CAP;
        const body = lines
          .slice(0, DEFAULT_CAP)
          .map((l, i) => `${String(i + 1).padStart(4)} │ ${l}`)
          .join("\n");
        const outline = ctxMgr?.getFileSymbolOutline(rel);
        const outlineHint = outline ? `\n\n${outline}` : "";
        return ok(
          clampToolResult(
            `${autoResolvedNote}# ${rel} lines 1-${DEFAULT_CAP} of ${total}\n${body}\n[truncated, ${total - DEFAULT_CAP} more lines — request a start_line/end_line range]${outlineHint}`
          )
        );
      }
      end = Math.min(end, total);
      if (start > total) return ok(`File has ${total} lines; start_line ${start} is past the end.`);

      const slice = lines.slice(start - 1, end);
      const numbered = slice
        .map((l, i) => `${String(start + i).padStart(4)} │ ${l}`)
        .join("\n");
      const header =
        start > 1 || end < total ? `# ${rel} lines ${start}-${end} of ${total}\n` : "";
      return ok(clampToolResult(autoResolvedNote + header + numbered));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return toolError("not_found", await notFoundMessage(ctx.workspaceRoot, rel), { recovery: { action: "search" } });
      }
      if (err?.code === "EISDIR") {
        return toolError("invalid_args", `"${rel}" is a directory. Use list_dir on it.`, { recovery: { action: "reread" } });
      }
      return toolError("execution_error", `Could not read "${rel}": ${err.message}`);
    }
  },
};

// ---------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------

export const writeFileTool: Tool = {
  spec: {
    name: "write_file",
    summary: "Create a NEW file with the given content. Fails if the file already exists — use edit_file for existing files.",
    params: [
      { name: "path", type: "string", required: true, description: "New file path relative to the workspace root, e.g. src/utils/helper.ts" },
      { name: "content", type: "string", required: true, description: "Full file content as raw text. Put the complete file text here — no escaping needed, and no ``` code fences." },
    ],
    sideEffecting: true,
    priority: 3,
    minTier: "low",
    tags: ["fs", "write"],
    example: '```tool\nTOOL_NAME: write_file\nBEGIN_ARG: path\nsrc/utils/id.ts\nEND_ARG\nBEGIN_ARG: content\nexport function newId(): string {\n  return Math.random().toString(36).slice(2);\n}\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    let rel = args.path as string;
    if (!rel || !String(rel).trim()) {
      return toolError("invalid_args", `Missing required argument "path".`);
    }

    let r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return toolError("not_found", r.error);

    const content = cleanIncomingText((args.content as string) ?? "");

    // FIX: content used to be checked with just `!content.trim()`, which did
    // reject a truly blank string — but the sibling bug was downstream in
    // edit_file, and this file had lost its "don't clobber existing files"
    // check entirely (see below). Kept and clarified here for defense in depth.
    if (isParserArtifact(content)) {
      return toolError(
        "invalid_args",
        `Missing or empty "content" — provide the full text of the new file. Nothing usable was received, so nothing was written.`
      );
    }

    // FIX: this existence check was previously removed ("Removed check for
    // existed file to allow overwrite"), which silently contradicted the
    // tool's own contract ("Fails if the file already exists") and let a
    // model overwrite files it didn't mean to touch. Restored.
    const existed = await fs.stat(r.abs).then(() => true).catch(() => false);
    if (existed) {
      return toolError(
        "conflict",
        `"${rel}" already exists. write_file only creates NEW files — use edit_file to modify existing ones (read_file it first if you need to see the current content).`,
        { recovery: { action: "reread", hints: ["Use edit_file for existing files"] } }
      );
    }

    const approved = await ctx.requestApproval(mkCall("write_file", args, ctx.pendingCallId));
    if (!approved) return toolError("permission_denied", "User declined the file write.");
    try {
      await ctx.checkpointTracker?.recordBeforeChange(rel);
      await fs.mkdir(path.dirname(r.abs), { recursive: true });
      await fs.writeFile(r.abs, content, "utf8");
      const lines = content.split("\n").length;
      void getProjectContextManager(ctx.workspaceRoot)?.recordFileEdit(rel, `Created file (${lines} lines)`);
      return ok(`Created ${rel} — ${lines} line${lines === 1 ? "" : "s"}, ${content.length} bytes.`);
    } catch (e) {
      return toolError("execution_error", `Could not write "${rel}": ${(e as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------

export const editFileTool: Tool = {
  spec: {
    name: "edit_file",
    summary:
      "Replace text in an existing file. Provide old_str (exact text to find, copied from read_file) AND new_str (its replacement). For files under ~40 lines you may omit old_str and put the ENTIRE new file content in new_str instead — but new_str is always required.",
    params: [
      { name: "path", type: "string", required: true, description: "File to edit, relative to the workspace root. Example: \"src/services/user.ts\"." },
      { name: "old_str", type: "string", required: false, description: "The EXACT text to replace, copied verbatim from read_file, with 3-5 surrounding lines so the match is unique. Omit ONLY for files under ~40 lines, where new_str is treated as the entire new file content." },
      { name: "new_str", type: "string", required: true, description: "The replacement text. If old_str is given, this is what replaces it (may be empty to delete that block). If old_str is omitted, this MUST be the full new content of the file." },
      { name: "append", type: "boolean", required: false, description: "If true, appends new_str to the end of the file instead of replacing anything. new_str is required and must be non-empty." },
      { name: "replace_all", type: "boolean", required: false, description: "If true and old_str matches more than once, replace every occurrence instead of erroring." },
    ],
    sideEffecting: true,
    priority: 2,
    minTier: "low",
    tags: ["fs", "write"],
    example: '```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\nsrc/services/user.ts\nEND_ARG\nBEGIN_ARG: old_str\n  const user = db.find(id);\n  if (!user) throw new Error(\'User not found\');\n  return user;\nEND_ARG\nBEGIN_ARG: new_str\n  const user = db.find(id);\n  if (!user) return null;\n  return user;\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    let rel = args.path as string;
    if (!rel || !String(rel).trim()) {
      return toolError("invalid_args", `Missing required argument "path".`);
    }

    let r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return toolError("not_found", r.error);

    // FIX: previously old_str/new_str both silently defaulted to "" via `??`
    // chains, with no way to tell "nothing meaningfully provided" apart from
    // "explicitly empty on purpose." A malformed or incomplete tool call
    // (very common with small models) landed in the "whole file replace"
    // branch and wrote "" as the entire file, wiping it. Below, both values
    // are cleaned and checked explicitly, and a genuinely empty/missing
    // new_str is now always an error, not a silent wipe.
    const rawOld = cleanIncomingText(((args.old_str as string) ?? (args.find as string) ?? ""));
    const rawNew = cleanIncomingText(((args.new_str as string) ?? (args.replace as string) ?? ""));
    const oldStr = isParserArtifact(rawOld) ? "" : rawOld;
    const newStr = isParserArtifact(rawNew) ? "" : rawNew;
    const replaceAll = args.replace_all === true;
    const append = args.append === true;

    let original: string | undefined = undefined;
    try {
      original = await fs.readFile(r.abs, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        const smart = getProjectContextManager(ctx.workspaceRoot)?.resolveSmartPath(rel);
        if (smart?.resolved) {
          const alt = resolveInWorkspace(ctx.workspaceRoot, smart.resolved);
          if (!("error" in alt)) {
            try {
              original = await fs.readFile(alt.abs, "utf8");
              rel = smart.resolved;
              r = alt;
            } catch {
              // proceed to notFoundMessage
            }
          }
        }
        if (typeof original !== "string") {
          const msg = await notFoundMessage(ctx.workspaceRoot, rel);
          return toolError(
            "not_found",
            `${msg}\nIf you meant to create a NEW file, use write_file instead.`,
            { recovery: { action: "search" } }
          );
        }
      } else if (err?.code === "EISDIR") {
        return toolError("invalid_args", `"${rel}" is a directory. Use list_dir on it.`, { recovery: { action: "reread" } });
      } else {
        return toolError("execution_error", `Could not read "${rel}": ${err.message}`);
      }
    }

    if (original === undefined) {
      return toolError("execution_error", `Could not read "${rel}".`);
    }

    // --- append mode ---
    if (append) {
      if (!newStr.trim()) {
        return toolError("invalid_args", `append requires non-empty "new_str" — that's the text to add to the end of the file. Nothing was written.`);
      }
      const approved = await ctx.requestApproval(mkCall("edit_file", args, ctx.pendingCallId));
      if (!approved) return toolError("permission_denied", "User declined the edit.");
      try {
        const sep = original.length === 0 || original.endsWith("\n") ? "" : "\n";
        await fs.appendFile(r.abs, sep + newStr, "utf8");
        return ok(`Appended to ${rel}.`);
      } catch (e) {
        return toolError("execution_error", `Could not append to "${rel}": ${(e as Error).message}`);
      }
    }

    // --- no old_str: either the whole-file shortcut, or nothing usable was given ---
    if (!oldStr.trim()) {
      if (!newStr.trim()) {
        return toolError(
          "invalid_args",
          `edit_file needs either:\n1. old_str (exact text to find) + new_str (its replacement), or\n2. new_str alone with the FULL new file content (only for files under ${WHOLE_FILE_SHORTCUT_MAX_LINES} lines).\nNeither was provided, so nothing was changed. Call read_file on "${rel}" first if you need to see its current content, then retry with both arguments filled in.`
        );
      }

      const originalLines = original.split("\n").length;
      if (originalLines > WHOLE_FILE_SHORTCUT_MAX_LINES) {
        return toolError(
          "invalid_args",
          `"${rel}" has ${originalLines} lines — too large for the whole-file shortcut (only files under ${WHOLE_FILE_SHORTCUT_MAX_LINES} lines qualify, so a partial rewrite can't accidentally discard the rest of a bigger file). Nothing was changed. Provide "old_str" with the exact text to change, copied from read_file, plus a few surrounding lines for uniqueness.`
        );
      }

      const approved = await ctx.requestApproval(mkCall("edit_file", args, ctx.pendingCallId));
      if (!approved) return toolError("permission_denied", "User declined the edit.");
      try {
        await ctx.checkpointTracker?.recordBeforeChange(rel);
        await fs.writeFile(r.abs, newStr, "utf8");
        const lines = newStr.split("\n").length;
        return ok(`Replaced ${rel} (whole file, ${lines} line${lines === 1 ? "" : "s"}).`);
      } catch (e) {
        return toolError("execution_error", `Could not write "${rel}": ${(e as Error).message}`);
      }
    }

    // --- targeted find/replace ---
    const result = locateEdit(original, oldStr, newStr, replaceAll);
    if ("error" in result) {
      const isAmbiguous = result.error.includes("appears") || result.error.includes("matches");
      return toolError(isAmbiguous ? "ambiguous" : "not_found", result.error + ` (in ${rel})`, {
        recovery: {
          action: isAmbiguous ? "reread" : "search",
          hints: ["Include more surrounding lines for uniqueness", "Copy exact text from read_file"],
        },
      });
    }
    const approved = await ctx.requestApproval(mkCall("edit_file", args, ctx.pendingCallId));
    if (!approved) return toolError("permission_denied", "User declined the edit.");
    try {
      await ctx.checkpointTracker?.recordBeforeChange(rel);
      await fs.writeFile(r.abs, result.text, "utf8");
      const startLine = original.slice(0, result.firstIndex).split("\n").length;
      const newLines = result.text.split("\n").length;
      const oldLines = original.split("\n").length;
      const delta = newLines - oldLines;
      void getProjectContextManager(ctx.workspaceRoot)?.recordFileEdit(
        rel,
        `Edited at line ~${startLine} (${delta >= 0 ? `+${delta}` : delta} lines)`
      );
      return ok(
        `Edited ${rel} at line ~${startLine}${result.count > 1 ? ` (${result.count} occurrences)` : ""}. File is now ${newLines} line${newLines === 1 ? "" : "s"}${delta !== 0 ? ` (${delta > 0 ? "+" : ""}${delta})` : ""}.`
      );
    } catch (e) {
      return toolError("execution_error", `Could not write "${rel}": ${(e as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------
// move_path
// ---------------------------------------------------------------------

export const appendFileTool: Tool = {
  spec: {
    name: "append_file",
    summary: "Add text to the end of an existing file without removing existing content.",
    params: [
      { name: "path", type: "string", required: true, description: "Existing file path relative to the workspace root." },
      { name: "content", type: "string", required: true, description: "Text to append. Existing content is preserved." },
    ],
    sideEffecting: true,
    priority: 2,
    minTier: "low",
    tags: ["fs", "write"],
    example: "```tool\nTOOL_NAME: append_file\nBEGIN_ARG: path\ntemp.md\nEND_ARG\nBEGIN_ARG: content\nA new paragraph.\nEND_ARG\n```",
  },
  async execute(args, ctx) {
    const resolved = resolveInWorkspace(ctx.workspaceRoot, String(args.path ?? ""));
    if ("error" in resolved) return toolError("invalid_args", resolved.error);
    const content = cleanIncomingText(String(args.content ?? ""));
    if (isParserArtifact(content)) return toolError("invalid_args", "content is missing. Existing content was preserved.");
    let original: string;
    try {
      const info = await fs.stat(resolved.abs);
      if (info.isDirectory()) return toolError("invalid_args", `"${String(args.path)}" is a directory. Use list_dir instead.`);
      original = await fs.readFile(resolved.abs, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return toolError("not_found", `${await notFoundMessage(ctx.workspaceRoot, String(args.path))} Use write_file only for a new file.`, { recovery: { action: "search" } });
      return toolError("execution_error", `Could not read "${String(args.path)}": ${(e as Error).message}`);
    }
    if (!await ctx.requestApproval(mkCall("append_file", args, ctx.pendingCallId))) return toolError("permission_denied", "User declined the append.");
    const separator = original.length && !original.endsWith("\n") ? "\n" : "";
    try {
      await ctx.checkpointTracker?.recordBeforeChange(String(args.path));
      await fs.appendFile(resolved.abs, separator + content, "utf8");
      return ok(`Appended content to ${String(args.path)}. Existing content was preserved.`);
    } catch (e) {
      return toolError("execution_error", `Could not append to "${String(args.path)}": ${(e as Error).message}`);
    }
  },
};

export const movePathTool: Tool = {
  spec: {
    name: "move_path",
    summary: "Move or rename a file or folder to a path that must not already exist.",
    params: [
      { name: "from", type: "string", required: true, description: "Current path relative to the workspace root. Example: \"src/oldName.ts\"." },
      { name: "to", type: "string", required: true, description: "New path relative to the workspace root (must not already exist). Example: \"src/newName.ts\"." },
    ],
    sideEffecting: true,
    priority: 9,
    minTier: "medium",
    tags: ["fs", "write"],
    example: '```tool\nTOOL_NAME: move_path\nBEGIN_ARG: from\nsrc/oldName.ts\nEND_ARG\nBEGIN_ARG: to\nsrc/newName.ts\nEND_ARG\n```',
  },
  async execute(args, ctx) {
    const fromRel = args.from as string;
    const toRel = args.to as string;
    const src = resolveInWorkspace(ctx.workspaceRoot, fromRel);
    if ("error" in src) return toolError("not_found", src.error);
    const dst = resolveInWorkspace(ctx.workspaceRoot, toRel);
    if ("error" in dst) return toolError("not_found", dst.error);
    const srcStat = await fs.stat(src.abs).catch(() => null);
    if (!srcStat) return toolError("not_found", await notFoundMessage(ctx.workspaceRoot, fromRel));
    if (await fs.stat(dst.abs).catch(() => null)) {
      return toolError("conflict", `"${toRel}" already exists — pick a different destination.`);
    }
    const approved = await ctx.requestApproval(mkCall("move_path", args, ctx.pendingCallId));
    if (!approved) return toolError("permission_denied", "User declined the move.");
    try {
      await ctx.checkpointTracker?.recordBeforeChange(fromRel);
      await ctx.checkpointTracker?.recordBeforeChange(toRel);
      await fs.mkdir(path.dirname(dst.abs), { recursive: true });
      await fs.rename(src.abs, dst.abs);
      return ok(`Moved ${fromRel} → ${toRel}.`);
    } catch (e) {
      try {
        await fs.cp(src.abs, dst.abs, { recursive: true });
        await fs.rm(src.abs, { recursive: true });
        return ok(`Moved ${fromRel} → ${toRel}.`);
      } catch (e2) {
        return toolError("execution_error", `Could not move "${fromRel}" to "${toRel}": ${(e2 as Error).message}`);
      }
    }
  },
};