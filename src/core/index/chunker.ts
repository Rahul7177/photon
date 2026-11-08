import type { Chunk } from "./types";

// Line-window chunking with overlap and semantic awareness.
const CHUNK_LINES = 60;
const OVERLAP_LINES = 12;
const MAX_LINE_CHARS = 1000;
/** Skip chunks that are essentially empty (whitespace/braces only). */
const MIN_MEANINGFUL_CHARS = 12;
/** Hard cap on stored chunk text so one pathological file can't bloat the index. */
const MAX_CHUNK_CHARS = 4000;
/** Hard cap on chunks per file to prevent memory exhaustion on giant generated files. */
const MAX_CHUNKS_PER_FILE = 80;

/**
 * Split a file's content into overlapping line-window chunks. Deterministic and
 * pure. Returns [] for empty/binary-ish content.
 *
 * Hardened to handle:
 * - Extremely long lines (minified / generated code) by wrapping them safely.
 * - Markdown header boundaries for semantic cohesion.
 * - File header / import context preservation for deeper chunks.
 * - Pathological files capped at MAX_CHUNKS_PER_FILE.
 */
export function chunkText(path: string, content: string): Chunk[] {
  if (!content || content.includes("\0")) return [];

  // Break pathological lines (> 1000 chars) into manageable segments
  const rawLines = content.split("\n");
  const lines: string[] = [];
  const lineMap: number[] = []; // maps broken line index to original 1-based line number

  for (let origIdx = 0; origIdx < rawLines.length; origIdx++) {
    const rawLine = rawLines[origIdx];
    if (rawLine.length <= MAX_LINE_CHARS) {
      lines.push(rawLine);
      lineMap.push(origIdx + 1);
    } else {
      // Split very long lines cleanly into 800-char segments
      for (let offset = 0; offset < rawLine.length; offset += 800) {
        lines.push(rawLine.slice(offset, offset + 800));
        lineMap.push(origIdx + 1);
      }
    }
  }

  // Extract concise top-level import/package context (up to 3 non-empty import/package lines)
  const headerImports: string[] = [];
  const isCode = /\.(ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|h|rb|php)$/i.test(path);
  if (isCode) {
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      const trimmed = lines[i].trim();
      if (
        /^(import|from|require|package|using|#include|use)\b/.test(trimmed) &&
        trimmed.length < 120
      ) {
        headerImports.push(trimmed);
        if (headerImports.length >= 3) break;
      }
    }
  }
  const importContextPrefix =
    headerImports.length > 0 ? `// Module imports: ${headerImports.join("; ")}\n` : "";

  const isMarkdown = /\.(md|markdown|mdx)$/i.test(path);
  const chunks: Chunk[] = [];
  const step = Math.max(1, CHUNK_LINES - OVERLAP_LINES);

  for (let start = 0; start < lines.length && chunks.length < MAX_CHUNKS_PER_FILE; start += step) {
    // For Markdown, snap start to nearby header (# or ##) if within a 4-line window
    let adjustedStart = start;
    if (isMarkdown && start > 0) {
      for (let look = 0; look < 4 && start + look < lines.length; look++) {
        if (/^#{1,3}\s+\S+/.test(lines[start + look])) {
          adjustedStart = start + look;
          break;
        }
      }
    }

    const end = Math.min(lines.length, adjustedStart + CHUNK_LINES);
    const slice = lines.slice(adjustedStart, end);
    let text = slice.join("\n");

    if (text.replace(/\s|[{}();,]/g, "").length < MIN_MEANINGFUL_CHARS) {
      if (end >= lines.length) break;
      continue;
    }

    // For code chunks past the first one, include concise import context if not already present
    if (adjustedStart > 0 && importContextPrefix && !text.includes("import ") && !text.includes("require(")) {
      text = `${importContextPrefix}${text}`;
    }

    if (text.length > MAX_CHUNK_CHARS) {
      text = text.slice(0, MAX_CHUNK_CHARS);
    }

    const startLine = lineMap[adjustedStart] ?? 1;
    const endLine = lineMap[end - 1] ?? startLine;

    chunks.push({ path, startLine, endLine, text });
    if (end >= lines.length) break;
  }

  return chunks;
}
