import { randomUUID } from "node:crypto";
import type { EmbedFn, IndexedChunk, RetrievedChunk } from "./types";
import { chunkText } from "./chunker";
import { VectorStore } from "./vectorStore";

// Embed in batches so a big file doesn't produce one enormous /api/embed request.
const EMBED_BATCH = 24;
// Never chunk-explode a single generated/minified file.
const MAX_CHUNKS_PER_FILE = 80;
// Maximum indexable file size (256 KB)
export const MAX_INDEXABLE_FILE_BYTES = 256 * 1024;

/** Directory segments excluded from indexing (ignored, build outputs, runtime state). */
const EXCLUDED_DIR_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".photon",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  "coverage",
  ".cache",
  "target",
  "vendor",
]);

/** Lockfiles, generated bundles, sourcemaps, and binary extensions excluded from indexing. */
const EXCLUDED_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "composer.lock",
  "gemfile.lock",
]);

const EXCLUDED_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".bundle.js",
  ".chunk.js",
  ".map",
  ".pb.go",
  ".pb.ts",
  ".generated.ts",
  ".g.dart",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".vsix",
];

/**
 * Determines whether a file path and optional content should be indexed.
 * Excludes generated, ignored (including `.photon/`), binary, minified, and oversized files.
 */
export function shouldIndexFile(
  filePath: string,
  content?: string,
  maxBytes = MAX_INDEXABLE_FILE_BYTES
): { indexable: boolean; reason?: string } {
  const norm = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm) return { indexable: false, reason: "empty_path" };

  const segments = norm.split("/");
  for (const seg of segments) {
    if (EXCLUDED_DIR_SEGMENTS.has(seg)) {
      return { indexable: false, reason: `excluded_directory:${seg}` };
    }
  }

  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  if (EXCLUDED_FILENAMES.has(base)) {
    return { indexable: false, reason: `excluded_lockfile:${base}` };
  }
  for (const suffix of EXCLUDED_SUFFIXES) {
    if (base.endsWith(suffix)) {
      return { indexable: false, reason: `excluded_suffix:${suffix}` };
    }
  }

  if (content !== undefined) {
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      return { indexable: false, reason: "oversized" };
    }
    // Check for null bytes or high control-character ratio (binary content)
    const sample = content.slice(0, 8192);
    if (sample.includes("\0")) {
      return { indexable: false, reason: "binary_content" };
    }
    // Detect minified single-line files (> 2000 chars per line on average)
    const lines = sample.split("\n");
    if (sample.length > 4000 && sample.length / Math.max(1, lines.length) > 1500) {
      return { indexable: false, reason: "minified_content" };
    }
  }

  return { indexable: true };
}

export interface RetrievalEvalCase {
  id: string;
  query: string;
  expectedPath: string;
  expectedSymbolOrSnippet?: string;
}

export interface RetrievalEvalReport {
  totalCases: number;
  recallAtK: number;
  mrr: number;
  caseResults: Array<{
    id: string;
    query: string;
    expectedPath: string;
    hitRank: number | null;
    matchedSnippet: boolean;
    topPaths: string[];
  }>;
}

/**
 * Evaluates retrieval recall@K and Mean Reciprocal Rank (MRR) over known-answer repository questions.
 */
export async function evaluateRetrieval(
  index: WorkspaceIndex,
  cases: RetrievalEvalCase[],
  k = 5
): Promise<RetrievalEvalReport> {
  if (cases.length === 0) {
    return { totalCases: 0, recallAtK: 0, mrr: 0, caseResults: [] };
  }

  let hits = 0;
  let rrSum = 0;
  const caseResults: RetrievalEvalReport["caseResults"] = [];

  for (const c of cases) {
    const retrieved = await index.retrieve(c.query, k);
    const normExpected = c.expectedPath.replace(/\\/g, "/").replace(/^\.\//, "");
    let hitRank: number | null = null;
    let matchedSnippet = false;

    for (let i = 0; i < retrieved.length; i++) {
      const rPath = retrieved[i].path.replace(/\\/g, "/").replace(/^\.\//, "");
      if (rPath === normExpected || rPath.endsWith(`/${normExpected}`)) {
        if (hitRank === null) hitRank = i + 1;
        if (
          !c.expectedSymbolOrSnippet ||
          retrieved[i].text.includes(c.expectedSymbolOrSnippet)
        ) {
          matchedSnippet = true;
          hitRank = i + 1;
          break;
        }
      }
    }

    if (hitRank !== null) {
      hits++;
      rrSum += 1 / hitRank;
    }

    caseResults.push({
      id: c.id,
      query: c.query,
      expectedPath: normExpected,
      hitRank,
      matchedSnippet: c.expectedSymbolOrSnippet ? matchedSnippet : hitRank !== null,
      topPaths: retrieved.map((r) => r.path),
    });
  }

  return {
    totalCases: cases.length,
    recallAtK: Math.round((hits / cases.length) * 1000) / 1000,
    mrr: Math.round((rrSum / cases.length) * 1000) / 1000,
    caseResults,
  };
}

/**
 * Owns the workspace vector index: chunk → embed → store, incremental per file,
 * plus similarity retrieval. VS Code-agnostic (embedding is injected), so it can
 * back a CLI or another IDE unchanged.
 */
export class WorkspaceIndex {
  constructor(
    private readonly store: VectorStore,
    private readonly embed: EmbedFn
  ) {}

  get stats(): { files: number; chunks: number } {
    return this.store.stats;
  }

  hasFile(path: string): boolean {
    return this.store.hasFile(path);
  }

  removeFile(path: string): void {
    this.store.removeFile(path);
  }

  /**
   * Handle file rename: immediately invalidates stale chunks at `oldPath` and
   * indexes `newPath` if `newContent` is provided and indexable.
   */
  async renameFile(
    oldPath: string,
    newPath: string,
    newContent?: string,
    signal?: AbortSignal
  ): Promise<number> {
    this.store.removeFile(oldPath);
    if (newContent !== undefined) {
      return this.indexFile(newPath, newContent, signal);
    }
    return 0;
  }

  /** Chunk, embed, and (re)store one file's content. Returns chunks stored. */
  async indexFile(path: string, content: string, signal?: AbortSignal): Promise<number> {
    const check = shouldIndexFile(path, content);
    if (!check.indexable) {
      // Ensure any previously stored chunks for this path are invalidated
      this.store.removeFile(path);
      return 0;
    }

    let chunks = chunkText(path, content);
    if (chunks.length === 0) {
      this.store.removeFile(path);
      return 0;
    }
    if (chunks.length > MAX_CHUNKS_PER_FILE) chunks = chunks.slice(0, MAX_CHUNKS_PER_FILE);

    const indexed: IndexedChunk[] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      if (signal?.aborted) throw new Error("Indexing cancelled.");
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await this.embed(batch.map((c) => c.text), signal);
      batch.forEach((c, j) => {
        const vector = vectors[j];
        if (Array.isArray(vector) && vector.length) {
          indexed.push({ ...c, id: randomUUID(), vector });
        }
      });
    }
    if (indexed.length === 0) {
      this.store.removeFile(path);
      return 0;
    }
    this.store.setFile(path, indexed);
    return indexed.length;
  }

  /** Retrieve the top-k most relevant chunks for a natural-language query. */
  async retrieve(query: string, k = 6, signal?: AbortSignal): Promise<RetrievedChunk[]> {
    const q = query.trim();
    if (!q || this.store.stats.chunks === 0) return [];
    const [vector] = await this.embed([q], signal);
    if (!Array.isArray(vector) || vector.length === 0) return [];
    return this.store.query(vector, k);
  }

  /**
   * Format retrieved chunks as a compact context block for the system prompt.
   * Bounded by `maxChars` so injected context never blows a small window; the
   * caller's context-budget manager still trims the final prompt.
   */
  async retrieveContext(query: string, maxChars = 4000, signal?: AbortSignal): Promise<string | undefined> {
    const hits = await this.retrieve(query, 6, signal);
    if (hits.length === 0) return undefined;
    const parts: string[] = [];
    let used = 0;
    for (const h of hits) {
      if (h.score <= 0.2) continue; // drop weak matches
      const block = `// ${h.path}:${h.startLine}-${h.endLine}\n${h.text}`;
      if (used + block.length > maxChars) break;
      parts.push(block);
      used += block.length;
    }
    if (parts.length === 0) return undefined;
    return parts.join("\n\n");
  }
}
