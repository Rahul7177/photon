import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../shared/types";
import { resolveInWorkspace } from "../paths";
import { clamp, fail, ok, type Tool } from "../types";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  ".venv",
  "__pycache__",
  ".next",
]);

// Line-number gutter used by read_file. edit_file strips it if the model
// copies numbered lines into `find`.
const GUTTER_RE = /^\s*\d+\s*│\s?/;

export const listDirTool: Tool = {
  spec: {
    name: "list_dir",
    summary: "List files and folders in a workspace directory.",
    params: [
      { name: "path", type: "string", required: false, description: "Directory relative to the workspace root. Defaults to the root." },
      { name: "recursive", type: "boolean", required: false, description: "true = also list subdirectories (a shallow tree, capped). Default false." },
    ],
    sideEffecting: false,
    priority: 5,
    minTier: "low",
    tags: ["fs", "read"],
    example: '[TOOL list_dir]\npath: src\n[/TOOL]',
  },
  async execute(args, ctx) {
    const rel = (args.path as string) || ".";
    const recursive = args.recursive === true;
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return fail(r.error);
    try {
      const st = await fs.stat(r.abs).catch(() => null);
      if (!st) return fail(`"${rel}" does not exist. Use find_files to locate paths.`);
      if (!st.isDirectory()) return fail(`"${rel}" is a file, not a directory. Use read_file on it.`);

      if (!recursive) {
        const entries = await fs.readdir(r.abs, { withFileTypes: true });
        const lines = entries
          .filter((e) => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return ok(lines.length ? clamp(lines.join("\n"), 4000) : "(empty directory)");
      }

      // Shallow recursive tree, breadth-first, capped.
      const out: string[] = [];
      const queue: { abs: string; prefix: string; depth: number }[] = [{ abs: r.abs, prefix: "", depth: 0 }];
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
          if (e.isDirectory() && node.depth < 2) {
            queue.push({ abs: path.join(node.abs, e.name), prefix: `${line}/`, depth: node.depth + 1 });
          }
        }
      }
      const note = out.length >= 400 ? "\n… (listing capped)" : "";
      return ok(clamp(out.join("\n") + note, 5000));
    } catch (e) {
      return fail(`Could not list "${rel}": ${(e as Error).message}`);
    }
  },
};

/** Lines read by default when the model gives no range — keeps huge files from
 *  eating the context window while teaching chunked reading via the hint. */
function readChunkLines(ctxCap: string): number {
  switch (ctxCap) {
    case "max": return 4000;
    case "high": return 2500;
    case "medium": return 1200;
    default: return 600;
  }
}

export const readFileTool: Tool = {
  spec: {
    name: "read_file",
    summary: "Read a file's text with line numbers. For big files, read a range with start_line/end_line.",
    params: [
      { name: "path", type: "string", required: true, description: "File path relative to the workspace root." },
      { name: "start_line", type: "number", required: false, description: "First line to read (1-based). Omit to start at the top." },
      { name: "end_line", type: "number", required: false, description: "Last line to read (1-based). Omit to read up to the default cap." },
    ],
    sideEffecting: false,
    priority: 1,
    minTier: "low",
    tags: ["fs", "read"],
    example: '[TOOL read_file]\npath: src/index.ts\nstart_line: 1\nend_line: 80\n[/TOOL]',
  },
  async execute(args, ctx) {
    const rel = args.path as string;
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return fail(r.error);
    try {
      const raw = await fs.readFile(r.abs, "utf8");
      const lines = raw.split("\n");
      const total = lines.length;

      const cap = readChunkLines(ctx.capability);
      const explicitStart = Number.isFinite(Number(args.start_line)) && Number(args.start_line) > 0;
      let start = Math.max(1, Math.floor((args.start_line as number) || 1));
      let end = args.end_line ? Math.floor(args.end_line as number) : total;
      // No explicit range on a big file → read the first chunk and teach the
      // model how to continue instead of dumping thousands of lines.
      if (!explicitStart && !args.end_line && total > cap) {
        end = cap;
        const body = lines
          .slice(0, cap)
          .map((l, i) => `${String(i + 1).padStart(4)} │ ${l}`)
          .join("\n");
        return ok(
          clamp(
            `# ${rel} lines 1-${cap} of ${total}\n${body}\n` +
              `[File continues. Call again with start_line: ${cap + 1} to read the next section.]`,
            9000
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
      return ok(header + clamp(numbered, 9000));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return fail(
          `"${rel}" does not exist. Use find_files (by name) or search_code (by content) to locate the right path, then read it.`
        );
      }
      if (err?.code === "EISDIR") {
        return fail(`"${rel}" is a directory. Use list_dir on it.`);
      }
      return fail(`Could not read "${rel}": ${err.message}`);
    }
  },
};

export const writeFileTool: Tool = {
  spec: {
    name: "write_file",
    summary: "Create a new file or overwrite an existing one with the given content. Use this for new files.",
    params: [
      { name: "path", type: "string", required: true, description: "File path relative to the workspace root, e.g. src/utils/helper.ts" },
      { name: "content", type: "string", required: true, description: "Full file content. Put the complete file text here." },
    ],
    sideEffecting: true,
    priority: 3,
    minTier: "low",
    tags: ["fs", "write"],
    example: '[TOOL write_file]\npath: src/utils/id.ts\ncontent:\n```\nexport function newId(): string {\n  return Math.random().toString(36).slice(2);\n}\n```\n[/TOOL]',
  },
  async execute(args, ctx) {
    const rel = args.path as string;
    const content = (args.content as string) ?? "";
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return fail(r.error);

    // Guard: local models sometimes emit "content: |" or "content: >" which parses as just "|" or ">".
    // Reject this and tell the model to use a fenced code block instead.
    if (content.trim() === "|" || content.trim() === ">") {
      return fail(
        'The "content" was parsed as a single "' + content.trim() + '" character. This usually means the tool call was formatted incorrectly.\n' +
        'Fix: use a fenced code block for the content, like this:\n' +
        "[TOOL write_file]\npath: " + rel + "\ncontent:\n```\n<your file content here>\n```\n[/TOOL]"
      );
    }
    if (!content.trim()) {
      return fail(
        'The "content" is empty. Provide the full file content inside a fenced code block:\n' +
        "[TOOL write_file]\npath: " + rel + "\ncontent:\n```\n<your file content here>\n```\n[/TOOL]"
      );
    }

    const existed = await fs
      .stat(r.abs)
      .then(() => true)
      .catch(() => false);

    const approved = await ctx.requestApproval(mkCall("write_file", args));
    if (!approved) return fail("User declined the file write.");

    try {
      await fs.mkdir(path.dirname(r.abs), { recursive: true });
      await fs.writeFile(r.abs, content, "utf8");
      const lines = content.split("\n").length;
      return ok(
        `${existed ? "Overwrote" : "Created"} ${rel} — ${lines} line${lines === 1 ? "" : "s"}, ${content.length} bytes.`
      );
    } catch (e) {
      return fail(`Could not write "${rel}": ${(e as Error).message}`);
    }
  },
};

export const editFileTool: Tool = {
  spec: {
    name: "edit_file",
    summary: "Replace an exact snippet of text in a file. Copy find text EXACTLY from read_file — no extra symbols.",
    params: [
      { name: "path", type: "string", required: true, description: "File to edit, relative to the workspace root." },
      { name: "find", type: "string", required: true, description: "The EXACT text to replace. Copy verbatim from read_file — no line numbers, no │ symbols, no extra characters. Include 3-5 surrounding lines so the match is unique." },
      { name: "replace", type: "string", required: true, description: "The new text to put in its place. Plain code/text only — no extra symbols or markers." },
      { name: "replace_all", type: "boolean", required: false, description: "true = replace every occurrence (default false: exactly one match required)." },
    ],
    sideEffecting: true,
    priority: 2,
    minTier: "low",
    tags: ["fs", "write"],
    example:
      '[TOOL edit_file]\npath: src/app.ts\nfind:\n```\nfunction greet(name) {\n  console.log("hi", name)\n}\n```\nreplace:\n```\nfunction greet(name: string): void {\n  console.log("hello", name);\n}\n```\n[/TOOL]\n\nIMPORTANT: Copy find text EXACTLY from read_file. Do NOT include line numbers or │ symbols. Use ``` fences for find and replace. Do NOT add | or > characters.',
  },
  async execute(args, ctx) {
    const rel = args.path as string;
    const rawFind = args.find as string;
    const rawReplace = (args.replace as string) ?? "";
    const replaceAll = args.replace_all === true;
    const r = resolveInWorkspace(ctx.workspaceRoot, rel);
    if ("error" in r) return fail(r.error);
    if (!rawFind || !rawFind.trim()) return fail('The "find" text must not be empty.');
    // Guard: local models sometimes emit "find: |" which parses as just "|".
    if (rawFind.trim() === "|") {
      return fail(
        'The "find" was parsed as a single "|" character. This usually means the tool call was formatted incorrectly.\n' +
        'Fix: use a fenced code block for the find text, like this:\n' +
        "[TOOL edit_file]\npath: " + rel + "\nfind:\n```\n<exact text to find>\n```\nreplace:\n```\n<replacement text>\n```\n[/TOOL]"
      );
    }

    let original: string;
    try {
      original = await fs.readFile(r.abs, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return fail(`"${rel}" does not exist. Create it with write_file, or use find_files to locate the correct path.`);
      }
      return fail(`Could not read "${rel}": ${err.message}`);
    }

    const result = locateEdit(original, rawFind, rawReplace, replaceAll);
    if ("error" in result) return fail(`${result.error} (in ${rel})`);

    const approved = await ctx.requestApproval(mkCall("edit_file", args));
    if (!approved) return fail("User declined the edit.");

    try {
      await fs.writeFile(r.abs, result.text, "utf8");
      const startLine = original.slice(0, result.firstIndex).split("\n").length;
      const newLines = result.text.split("\n").length;
      const oldLines = original.split("\n").length;
      const delta = newLines - oldLines;
      return ok(
        `Edited ${rel} at line ~${startLine}${result.count > 1 ? ` (${result.count} occurrences)` : ""}. File is now ${newLines} line${newLines === 1 ? "" : "s"}${delta !== 0 ? ` (${delta > 0 ? "+" : ""}${delta})` : ""}.`
      );
    } catch (e) {
      return fail(`Could not write "${rel}": ${(e as Error).message}`);
    }
  },
};

/** Rename or move a file/folder within the workspace. */
export const movePathTool: Tool = {
  spec: {
    name: "move_path",
    summary: "Move or rename a file or folder.",
    params: [
      { name: "from", type: "string", required: true, description: "Current path relative to the workspace root." },
      { name: "to", type: "string", required: true, description: "New path relative to the workspace root (must not already exist)." },
    ],
    sideEffecting: true,
    priority: 9,
    minTier: "medium",
    tags: ["fs", "write"],
    example: '[TOOL move_path]\nfrom: src/oldName.ts\nto: src/newName.ts\n[/TOOL]',
  },
  async execute(args, ctx) {
    const fromRel = args.from as string;
    const toRel = args.to as string;
    const src = resolveInWorkspace(ctx.workspaceRoot, fromRel);
    if ("error" in src) return fail(src.error);
    const dst = resolveInWorkspace(ctx.workspaceRoot, toRel);
    if ("error" in dst) return fail(dst.error);

    const srcStat = await fs.stat(src.abs).catch(() => null);
    if (!srcStat) return fail(`"${fromRel}" does not exist.`);
    if (await fs.stat(dst.abs).catch(() => null)) {
      return fail(`"${toRel}" already exists — pick a different destination.`);
    }

    const approved = await ctx.requestApproval(mkCall("move_path", args));
    if (!approved) return fail("User declined the move.");

    try {
      await fs.mkdir(path.dirname(dst.abs), { recursive: true });
      await fs.rename(src.abs, dst.abs);
      return ok(`Moved ${fromRel} → ${toRel}.`);
    } catch (e) {
      // rename can fail across devices; fall back to copy+delete.
      try {
        await fs.cp(src.abs, dst.abs, { recursive: true });
        await fs.rm(src.abs, { recursive: true });
        return ok(`Moved ${fromRel} → ${toRel}.`);
      } catch (e2) {
        return fail(`Could not move "${fromRel}" to "${toRel}": ${(e2 as Error).message}`);
      }
    }
  },
};

/**
 * Find `find` in `original` tolerantly and return the edited text. Tries, in
 * order: exact match, exact match with the read_file line-number gutter
 * stripped, then a whitespace-tolerant line-block match (handles indentation
 * or trailing-space differences). Returns an error string if it can't match.
 * Exported for reuse by the cloud tool set.
 */
export function locateEdit(
  original: string,
  find: string,
  replace: string,
  replaceAll: boolean
): { text: string; firstIndex: number; count: number } | { error: string } {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  // Sanitize find/replace: strip stray symbols small models add (pipes, bullets, etc.)
  const sanitize = (s: string): string => {
    let lines = s.split("\n");
    while (lines.length && /^[\|\>\-\*\•\·\s]+$/.test(lines[0])) lines.shift();
    while (lines.length && /^[\|\>\-\*\•\·\s]+$/.test(lines[lines.length - 1])) lines.pop();
    return lines.join("\n");
  };
  const o = norm(original);
  const cleanFind = sanitize(norm(find));
  const candidates = uniq([cleanFind, stripGutter(cleanFind), sanitize(stripGutter(cleanFind))]);
  const rep = sanitize(norm(replace));

  // 1 & 2: exact / gutter-stripped exact.
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

  // 3: whitespace-tolerant line-block match.
  const fuzzy = locateFuzzy(o, stripGutter(cleanFind));
  if ("count" in fuzzy) {
    if (fuzzy.count > 1) {
      return {
        error: `The text to change matches ${fuzzy.count} places — include more surrounding lines so it's unique. Use read_file to copy the exact block you want to change.`,
      };
    }
    return {
      error: `Could not find the text to change. Fix it like this:
1. Call read_file on this file and copy the EXACT current text you want to change (whitespace and indentation included).
2. Paste that verbatim into "find", with 3-5 extra surrounding lines so it's unique.
3. Put the replacement in "replace". Do not guess the file content — copy it from read_file output.`,
    };
  }
  const edited = o.slice(0, fuzzy.start) + rep + o.slice(fuzzy.end);
  return { text: restoreEol(edited, eol), firstIndex: fuzzy.start, count: 1 };
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
  for (let k = 0; k < i; k++) start += origLines[k].length + 1; // +1 for the \n
  let end = start;
  for (let k = 0; k < target.length; k++) {
    end += origLines[i + k].length;
    if (k < target.length - 1) end += 1; // internal newlines only
  }
  return { start, end };
}

/** Strip a read_file line-number gutter if EVERY non-blank line has one. */
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

function mkCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: randomUUID(), name, args, status: "proposed", sideEffecting: true };
}
