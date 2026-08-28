import { randomUUID } from "node:crypto";
import type { EmbedFn, IndexedChunk, RetrievedChunk } from "./types";
import { chunkText } from "./chunker";
import { VectorStore } from "./vectorStore";

// Embed in batches so a big file doesn't produce one enormous /api/embed request.
const EMBED_BATCH = 24;
// Never chunk-explode a single generated/minified file.
const MAX_CHUNKS_PER_FILE = 80;

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

  /** Chunk, embed, and (re)store one file's content. Returns chunks stored. */
  async indexFile(path: string, content: string, signal?: AbortSignal): Promise<number> {
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
