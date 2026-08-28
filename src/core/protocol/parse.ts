import type { ToolSpec } from "../../shared/types";
import { BLOCK_RE, OPEN_UNCLOSED_RE } from "./format";

export interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
  /** Validation problems — fed back to the model so it can self-correct. */
  errors: string[];
}

export interface ParseResult {
  calls: ParsedCall[];
  /** Assistant text with tool calls removed, for display. */
  cleanedText: string;
}

interface RawMatch {
  name: string;
  args: Record<string, unknown>;
  start: number;
  end: number;
  /** If false, an unknown tool name means "not a tool call" (leave in text). */
  explicit: boolean;
}

/**
 * Forgiving, multi-format tool-call parser. Small local models rarely emit
 * Photon's `[TOOL]` blocks perfectly — they fall back to whatever they were
 * trained on. So we also accept `<tool_call>` tags, ```json fences, and bare
 * JSON, execute them all, and strip them from the visible text so raw
 * JSON/markup never leaks into the chat.
 */
export function parsePhotonBlocks(text: string, specs: ToolSpec[]): ParseResult {
  const specByName = new Map(specs.map((s) => [s.name.toLowerCase(), s]));
  const consumed: [number, number][] = [];
  const raws: RawMatch[] = [];

  const claim = (m: RawMatch) => {
    if (overlaps(m.start, m.end, consumed)) return;
    consumed.push([m.start, m.end]);
    raws.push(m);
  };

  const known = (name: string) => specByName.has(String(name).trim().toLowerCase());
  collectBlockTags(text, claim); // [TOOL] ... [/TOOL] — explicit Photon format
  collectXmlTags(text, known, claim); // <tool_call>{...}</tool_call> and <|tool_call>call:X...
  collectPipeUnclosed(text, known, claim); // trailing <|tool_call> without closing (truncation)
  collectJsonFences(text, known, claim); // ```json {...} ```
  collectBareJson(text, known, claim); // {"name":...}

  const calls = raws
    .sort((a, b) => a.start - b.start)
    .map((m) => finalizeCall(m.name, m.args, text.slice(m.start, m.end), specByName, m.explicit))
    .filter((c): c is ParsedCall => c !== null);

  return { calls, cleanedText: stripToolMarkup(stripRanges(text, consumed)) };
}

/* ------------------------------- extractors ------------------------------- */

function collectBlockTags(text: string, claim: (m: RawMatch) => void): void {
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    claim({ name: m[1], args: parseBody(m[2]), start: m.index, end: m.index + m[0].length, explicit: true });
    lastEnd = m.index + m[0].length;
  }
  // A trailing [TOOL] block left unclosed by truncation.
  const tail = text.slice(lastEnd);
  if (!/\[\/TOOL\]/i.test(tail)) {
    const um = OPEN_UNCLOSED_RE.exec(tail);
    if (um) {
      claim({
        name: um[1],
        args: parseBody(um[2]),
        start: lastEnd + um.index,
        end: text.length,
        explicit: true,
      });
    }
  }
}

function collectPipeUnclosed(text: string, known: (n: string) => boolean, claim: (m: RawMatch) => void): void {
  // Some models (Gemma via llama.cpp) emit <|tool_call> without a closing tag when truncated.
  if (/<\/(?:tool_call|function_call|tool)\|?>/i.test(text)) return; // has closing, already handled
  const re = /<\|?(?:tool_call|function_call|tool)\|?>\s*([\s\S]*)$/i;
  const m = re.exec(text);
  if (!m) return;
  const inner = m[1].trim();
  const body = parseBody(inner);
  const rawCall = (body.call as string) || (body.name as string);
  const cand = rawCall ? rawCall.replace(/^call:/, "").trim().toLowerCase() : "";
  const start = m.index;
  if (cand && known(cand)) {
    const args: Record<string, unknown> = { ...body };
    delete (args as any).call; delete (args as any).name; delete (args as any).tool;
    claim({ name: cand, args, start, end: text.length, explicit: true });
    return;
  }
  const found = inner.match(/\b(list_dir|read_file|write_file|edit_file|find_files|search_code|get_diagnostics|code_outline|run_command|move_path|think|todo_write|web_search|web_fetch)\b/i);
  if (found && known(found[1])) {
    const args = parseBody(inner);
    if ((args as any).call) delete (args as any).call;
    claim({ name: found[1].toLowerCase(), args, start, end: text.length, explicit: true });
  }
}

// For JSON/XML formats we only claim a call when it names a KNOWN tool — these
// shapes also appear in ordinary chat content (e.g. showing a package.json), so
// an unknown name means "leave it as text", never "unknown tool" feedback.
function collectXmlTags(
  text: string,
  known: (name: string) => boolean,
  claim: (m: RawMatch) => void
): void {
  const re = /<\|?(?:tool_call|function_call|tool)\|?>\s*([\s\S]*?)\s*<\|?\/(?:tool_call|function_call|tool)\|?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1].trim();
    let call = jsonToCall(safeJson(inner));
    if (!call) {
      const body = parseBody(inner);
      const rawCall = (body.call as string) || (body.name as string) || (body.tool as string);
      if (rawCall && known(rawCall.replace(/^call:/, "").trim())) {
        const name = rawCall.replace(/^call:/, "").trim().toLowerCase();
        const args: Record<string, unknown> = { ...body };
        delete (args as any).call; delete (args as any).name; delete (args as any).tool;
        call = { name, args };
      } else {
        const found = inner.match(/\b(list_dir|read_file|write_file|edit_file|find_files|search_code|get_diagnostics|code_outline|run_command|move_path|think|todo_write|web_search|web_fetch)\b/i);
        if (found && known(found[1])) {
          const name = found[1].toLowerCase();
          const args = parseBody(inner);
          if ((args as any).call) delete (args as any).call;
          if ((args as any).tool) delete (args as any).tool;
          call = { name, args };
        }
      }
    }
    if (call && known(call.name)) {
      claim({ ...call, start: m.index, end: m.index + m[0].length, explicit: true });
    }
  }
}

function collectJsonFences(
  text: string,
  known: (name: string) => boolean,
  claim: (m: RawMatch) => void
): void {
  const re = /```(?:json|tool_call|tool|tool_code)?\s*\n?([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const call = jsonToCall(safeJson(m[1]));
    if (call && known(call.name)) {
      claim({ ...call, start: m.index, end: m.index + m[0].length, explicit: false });
    }
  }
}

function collectBareJson(
  text: string,
  known: (name: string) => boolean,
  claim: (m: RawMatch) => void
): void {
  scanBalancedJson(text, (obj, start, end) => {
    const call = jsonToCall(obj);
    if (call && known(call.name)) {
      claim({ ...call, start, end, explicit: false });
    }
  });
}

/* ------------------------------- validation ------------------------------- */

function finalizeCall(
  rawName: string,
  args: Record<string, unknown>,
  raw: string,
  specByName: Map<string, ToolSpec>,
  explicit: boolean
): ParsedCall | null {
  const name = String(rawName).trim().toLowerCase();
  const spec = specByName.get(name);

  if (!spec) {
    if (!explicit) return null; // bare JSON for an unknown tool → not a call
    return { name, args, raw, errors: [`Unknown tool "${name}".`] };
  }

  const { args: coerced, errors } = coerceArgs(spec, args);
  return { name: spec.name, args: coerced, raw, errors };
}

/**
 * Validate + coerce raw args against a tool spec. Shared by the text parser and
 * the native-tool-calling path so native calls get the same guarantees (types
 * coerced, required args enforced) instead of reaching a tool unvalidated.
 */
export function validateAgainstSpec(
  name: string,
  rawArgs: Record<string, unknown>,
  specs: ToolSpec[]
): { args: Record<string, unknown>; errors: string[] } {
  const spec = specs.find((s) => s.name === name);
  if (!spec) return { args: rawArgs, errors: [`Unknown tool "${name}".`] };
  return coerceArgs(spec, rawArgs);
}

function coerceArgs(
  spec: ToolSpec,
  args: Record<string, unknown>
): { args: Record<string, unknown>; errors: string[] } {
  const coerced: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const p of spec.params) {
    if (!(p.name in args) || args[p.name] === undefined || args[p.name] === null) {
      if (p.required) errors.push(`Missing required argument "${p.name}".`);
      continue;
    }
    const [value, err] = coerce(args[p.name], p.type);
    if (err) errors.push(`Argument "${p.name}": ${err}`);
    else coerced[p.name] = value;
  }
  return { args: coerced, errors };
}

/** Normalize any tool-call-shaped JSON object into { name, args }. */
function jsonToCall(obj: unknown): { name: string; args: Record<string, unknown> } | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const fn = (o.function ?? {}) as Record<string, unknown>;
  const name = o.name ?? o.tool ?? o.tool_name ?? o.action ?? fn.name;
  if (typeof name !== "string" || !name) return null;

  let args = o.arguments ?? o.args ?? o.parameters ?? o.input ?? fn.arguments ?? {};
  if (typeof args === "string") args = safeJson(args) ?? {};
  if (!args || typeof args !== "object") args = {};
  return { name, args: args as Record<string, unknown> };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return null;
  }
}

const MAX_BRACE_ATTEMPTS = 200;

/**
 * Scan for balanced top-level {...} regions (string/escape aware), bounded.
 *
 * CRITICAL: matchBrace() from an unbalanced "{" scans to end-of-string. Without
 * a cap, a run of many unclosed "{" (which small models emit) would call it at
 * every position → O(n²), freezing the extension host for tens of seconds. We
 * cap the number of matchBrace attempts so total work stays O(attempts·n).
 */
function scanBalancedJson(
  text: string,
  onObject: (obj: unknown, start: number, end: number) => void
): void {
  let i = 0;
  let scanned = 0;
  let attempts = 0;
  const n = text.length;
  while (i < n && scanned < 50 && attempts < MAX_BRACE_ATTEMPTS) {
    if (text[i] === "{") {
      attempts++;
      const end = matchBrace(text, i);
      if (end !== -1) {
        const obj = safeJson(text.slice(i, end + 1));
        if (obj) onObject(obj, i, end + 1);
        scanned++;
        i = end + 1;
        continue;
      }
    }
    i++;
  }
}

function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* -------------------------------- body parse ------------------------------ */

/** Parse a `[TOOL]` body into raw string args, honoring fenced multi-line values. */
function parseBody(body: string): Record<string, string> {
  const args: Record<string, string> = {};
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^\s*([a-zA-Z0-9_-]+)\s*[:=]\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1].trim();
    let value = kv[2].trim();

    if (value === "") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const fence = lines[j]?.match(/^\s*(```+|~~~+)(.*)$/);
      if (fence) {
        const marker = fence[1];
        const collected: string[] = [];
        j++;
        while (j < lines.length && !lines[j].trimStart().startsWith(marker)) {
          collected.push(lines[j]);
          j++;
        }
        value = collected.join("\n");
        i = j + 1;
        args[key] = value;
        continue;
      }
      // FIX: greedy capture for content-like params when model forgets fences.
      if (/^(content|find|replace|text|body)$/i.test(key)) {
        const collected: string[] = [];
        j = i + 1;
        while (j < lines.length) {
          if (/^\s*\[\/TOOL\]/i.test(lines[j])) break; // never swallow close tag (audit)
          if (/^\s*[a-zA-Z0-9_-]+\s*[:=]\s*/.test(lines[j]) && !/^(content|find|replace)/i.test(lines[j].trim())) break;
          collected.push(lines[j]);
          j++;
        }
        if (collected.join("\n").trim()) {
          const tail = collected.join("\n").replace(/^\n+|\n+$/g, "");
          if (tail.trim()) {
            value = tail;
            i = j;
            args[key] = value;
            continue;
          }
        }
      }
    }
    args[key] = stripQuotes(value);
    i++;
  }
  return args;
}

function coerce(
  value: unknown,
  type: "string" | "number" | "boolean"
): [unknown, string | null] {
  if (type === "string") return [typeof value === "string" ? value : String(value), null];
  const s = String(value).trim();
  if (type === "number") {
    const num = Number(s);
    return Number.isFinite(num) ? [num, null] : [undefined, `expected a number, got "${s}"`];
  }
  // boolean
  if (typeof value === "boolean") return [value, null];
  if (/^(true|yes|1)$/i.test(s)) return [true, null];
  if (/^(false|no|0)$/i.test(s)) return [false, null];
  return [undefined, `expected true/false, got "${s}"`];
}

function stripQuotes(v: string): string {
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/* -------------------------------- utilities ------------------------------- */

function overlaps(start: number, end: number, ranges: [number, number][]): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

function stripRanges(text: string, ranges: [number, number][]): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor) continue; // skip overlaps
    out += text.slice(cursor, start);
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Remove leftover tool-call markup fragments and tidy whitespace for display.
 * Safe for chat mode too: it strips `<tool_call>` tags and `[TOOL]` fragments
 * but never touches code blocks or JSON the model is legitimately showing.
 */
export function stripToolMarkup(text: string): string {
  return text
    .replace(/<\|?\/?(?:tool_call|function_call|tool)\|?>/gi, "")
    .replace(/\[\/?TOOL[^\]]*\]/gi, "")
    .replace(/<\|tool_call\|>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
