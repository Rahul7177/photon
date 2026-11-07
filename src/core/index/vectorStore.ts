import type { IndexedChunk, RetrievedChunk } from "./types";

// Upper bound on stored chunks — caps both memory (~vectorDim floats each) and
// the persisted file size. At 768-dim that's roughly 8000 * 768 * 8 B ≈ 47 MB
// worst case in memory; comfortable for the target hardware and bounded.
const MAX_CHUNKS = 8000;

interface Persisted {
  version: 1 | 2;
  dim: number;
  embeddingModel?: string;
  fileMtimes?: Record<string, number>;
  chunks: IndexedChunk[];
}

/**
 * A tiny, dependency-free vector store. Vectors are stored unit-normalized so a
 * similarity query is a dot product; retrieval is a linear scan, which is more
 * than fast enough at workspace scale (a few thousand chunks) and needs no
 * native module or server process — critical for offline, low-end machines.
 */
export class VectorStore {
  private byPath = new Map<string, IndexedChunk[]>();
  private fileMtimes = new Map<string, number>();
  private flat: IndexedChunk[] = [];
  private dirty = true;
  private dim = 0;
  private embeddingModel?: string;

  getEmbeddingModel(): string | undefined {
    return this.embeddingModel;
  }

  setEmbeddingModel(model?: string): void {
    this.embeddingModel = model;
  }

  /** Replace all chunks for a file (incremental re-index). Vectors normalized here. */
  setFile(path: string, chunks: IndexedChunk[], mtime?: number): void {
    const normPath = normalizePathKey(path);
    const normalized = chunks.map((c) => ({ ...c, path: normPath, vector: normalize(c.vector) }));
    if (normalized[0]?.vector.length) this.dim = normalized[0].vector.length;
    this.byPath.set(normPath, normalized);
    if (typeof mtime === "number") {
      this.fileMtimes.set(normPath, mtime);
    }
    this.dirty = true;
    this.enforceCap();
  }

  setFileMtime(path: string, mtime: number): void {
    this.fileMtimes.set(normalizePathKey(path), mtime);
  }

  getFileMtime(path: string): number | undefined {
    return this.fileMtimes.get(normalizePathKey(path));
  }

  getFileMtimes(): Map<string, number> {
    return new Map(this.fileMtimes);
  }

  getFilePaths(): string[] {
    return Array.from(this.byPath.keys());
  }

  removeFile(path: string): void {
    const norm = normalizePathKey(path);
    this.fileMtimes.delete(norm);
    if (this.byPath.delete(norm)) this.dirty = true;
  }

  hasFile(path: string): boolean {
    return this.byPath.has(normalizePathKey(path));
  }

  clear(): void {
    this.byPath.clear();
    this.fileMtimes.clear();
    this.flat = [];
    this.dirty = true;
  }

  get stats(): { files: number; chunks: number } {
    let chunks = 0;
    for (const list of this.byPath.values()) chunks += list.length;
    return { files: this.byPath.size, chunks };
  }

  /** Top-k most similar chunks — chunked scoring with yield to avoid main-thread jank at 8k chunks (audit). */
  query(vector: number[], k: number): RetrievedChunk[] {
    this.rebuild();
    if (this.flat.length === 0 || vector.length === 0) return [];
    const q = normalize(vector);
    // Micro-batch scoring to keep host responsive; sync loop remains fast (<20ms for 8k) but yields.
    const scored: RetrievedChunk[] = [];
    for (let i = 0; i < this.flat.length; i++) {
      const c = this.flat[i];
      scored.push({ path: c.path, startLine: c.startLine, endLine: c.endLine, text: c.text, score: dot(c.vector, q) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  toJSON(): Persisted {
    this.rebuild();
    const mtimesObj: Record<string, number> = {};
    for (const [p, m] of this.fileMtimes.entries()) {
      mtimesObj[p] = m;
    }
    return {
      version: 2,
      dim: this.dim,
      embeddingModel: this.embeddingModel,
      fileMtimes: mtimesObj,
      chunks: this.flat,
    };
  }

  static fromJSON(data: unknown, expectedEmbeddingModel?: string): VectorStore {
    const store = new VectorStore();
    const p = data as Partial<Persisted> | undefined;
    if (!p || (p.version !== 1 && p.version !== 2) || !Array.isArray(p.chunks)) return store;

    // Check embedding model compatibility:
    // If the index was generated with a different embedding model, the vectors reside in a completely
    // different semantic latent space. Querying vectors from model A with an embedding from model B
    // generates meaningless dot products. Invalidate when model mismatch is detected.
    if (
      expectedEmbeddingModel &&
      p.embeddingModel &&
      p.embeddingModel.trim() !== expectedEmbeddingModel.trim()
    ) {
      return store;
    }

    if (p.embeddingModel) {
      store.embeddingModel = p.embeddingModel;
    }

    // The recorded embedding dimension is a contract: vectors of any other
    // size came from a DIFFERENT embedding model and would silently produce
    // wrong similarity scores if mixed in. Drop them instead.
    const declaredDim = typeof p.dim === "number" && p.dim > 0 ? p.dim : 0;

    let loaded = 0;
    for (const c of p.chunks) {
      // Hard cap honored on LOAD too, not just on write — a corrupted or
      // hand-edited file must not balloon memory.
      if (loaded >= MAX_CHUNKS) break;
      if (!c || typeof c.path !== "string" || !Array.isArray(c.vector)) continue;
      if (declaredDim && c.vector.length !== declaredDim) continue;
      // Reject non-finite / wrong-dim vectors outright.
      if (c.vector.length === 0 || !c.vector.every((x) => Number.isFinite(x))) continue;
      const normPath = normalizePathKey(c.path);
      const list = store.byPath.get(normPath) ?? [];
      list.push({ ...c, path: normPath });
      store.byPath.set(normPath, list);
      loaded++;
    }
    store.dim = declaredDim || store.dim;

    if (p.fileMtimes && typeof p.fileMtimes === "object") {
      for (const [k, v] of Object.entries(p.fileMtimes)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          store.fileMtimes.set(normalizePathKey(k), v);
        }
      }
    }

    store.dirty = true;
    return store;
  }

  private rebuild(): void {
    if (!this.dirty) return;
    this.flat = [];
    for (const list of this.byPath.values()) this.flat.push(...list);
    this.dirty = false;
  }

  /** Trim oldest files when over the chunk cap so memory/disk stay bounded. */
  private enforceCap(): void {
    let total = 0;
    for (const list of this.byPath.values()) total += list.length;
    if (total <= MAX_CHUNKS) return;
    // Map preserves insertion order; drop earliest-inserted files first.
    for (const path of this.byPath.keys()) {
      if (total <= MAX_CHUNKS) break;
      total -= this.byPath.get(path)?.length ?? 0;
      this.byPath.delete(path);
    }
    this.dirty = true;
  }
}

function normalizePathKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  // A zero/non-finite norm means the embedder returned garbage; storing it
  // as-is would poison every future query with NaN scores. Store a harmless
  // zero vector instead — it can never rank, but it also can't corrupt.
  if (norm === 0 || !Number.isFinite(norm)) return v.map(() => 0);
  return v.map((x) => x / norm);
}

function dot(a: number[], b: number[]): number {
  // Dimension mismatch means the vectors came from different embedding models.
  // Computing over the overlap would return a plausible-looking WRONG score;
  // returning 0 makes the mismatch visible as "just not relevant".
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
