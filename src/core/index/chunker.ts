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

const CODE_BOUNDARY_RE =
  /^(?:export\s+(?:default\s+)?|pub(?:\([^)]*\))?\s+)?(?:abstract\s+|async\s+)?(?:class|interface|type|enum|function|def|fn|func|struct|impl)\b/;

/** Format a chunk with file path and line range metadata for higher-accuracy embedding vectors. */
export function formatChunkForEmbedding(chunk: Chunk): string {
  return `// File: ${chunk.path} (L${chunk.startLine}-${chunk.endLine})\n${chunk.text}`;
}

/**
 * Split a file's content into overlapping line-window chunks. Deterministic and
 * pure. Returns [] for empty/binary-ish content.
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
  const isCode = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|cpp|c|h|hpp|rb|php|swift|kt|scala)$/i.test(path);
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
    // Snap start forward slightly (<= 5 lines < OVERLAP_LINES) to Markdown headers or code declarations
    let adjustedStart = start;
    if (start > 0) {
      if (isMarkdown) {
        for (let look = 0; look < 5 && start + look < lines.length; look++) {
          if (/^#{1,3}\s+\S+/.test(lines[start + look])) {
            adjustedStart = start + look;
            break;
          }
        }
      } else if (isCode) {
        for (let look = 0; look <= 5 && start + look < lines.length; look++) {
          const trimmed = lines[start + look].trimStart();
          if (CODE_BOUNDARY_RE.test(trimmed)) {
            adjustedStart = start + look;
            break;
          }
          if (look > 0 && trimmed === "" && start + look + 1 < lines.length && lines[start + look + 1].trim()) {
            adjustedStart = start + look + 1;
            break;
          }
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
