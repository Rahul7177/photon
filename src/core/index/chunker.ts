import type { Chunk } from "./types";

// Line-window chunking with overlap. A language-server-aware, by-symbol chunker
// is a future upgrade (M10 mentions it "where available"); a windowed splitter
// is robust, language-agnostic, and cheap — the right default for the target
// hardware tier.
const CHUNK_LINES = 60;
const OVERLAP_LINES = 12;
/** Skip chunks that are essentially empty (whitespace/braces only). */
const MIN_MEANINGFUL_CHARS = 12;
/** Hard cap on stored chunk text so one pathological file can't bloat the index. */
const MAX_CHUNK_CHARS = 4000;

/**
 * Split a file's content into overlapping line-window chunks. Deterministic and
 * pure. Returns [] for empty/binary-ish content.
 */
export function chunkText(path: string, content: string): Chunk[] {
  if (!content) return [];
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  const step = Math.max(1, CHUNK_LINES - OVERLAP_LINES);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const slice = lines.slice(start, end);
    let text = slice.join("\n");
    if (text.replace(/\s|[{}();,]/g, "").length < MIN_MEANINGFUL_CHARS) {
      if (end >= lines.length) break;
      continue;
    }
    if (text.length > MAX_CHUNK_CHARS) text = text.slice(0, MAX_CHUNK_CHARS);
    chunks.push({ path, startLine: start + 1, endLine: end, text });
    if (end >= lines.length) break;
  }
  return chunks;
}
