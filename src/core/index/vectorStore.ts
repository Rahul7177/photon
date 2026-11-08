import type { IndexedChunk, RetrievedChunk } from "./types";

// Upper bound on stored chunks — caps both memory (~vectorDim floats each) and
// the persisted file size. At 768-dim that's roughly 8000 * 768 * 8 B ≈ 47 MB
// worst case in memory; comfortable for the target hardware and bounded.
export const MAX_CHUNKS = 8000;

interface Persisted {
  version: 1 | 2;
  dim: number;
  embeddingModel?: string;
  fileMtimes?: Record<string, number>;
  fileSizes?: Record<string, number>;
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
  private fileSizes = new Map<string, number>();
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

  get dimension(): number {
    return this.dim;
  }

  get maxChunks(): number {
    return MAX_CHUNKS;
  }

  /** Replace all chunks for a file (incremental re-index). Vectors normalized here. */
  setFile(path: string, chunks: IndexedChunk[], mtime?: number, size?: number): void {
    const normPath = normalizePathKey(path);
    const normalized = chunks.map((c) => ({ ...c, path: normPath, vector: normalize(c.vector) }));
    if (normalized[0]?.vector.length) this.dim = normalized[0].vector.length;
    this.byPath.set(normPath, normalized);
    if (typeof mtime === "number") {
      this.fileMtimes.set(normPath, mtime);
    }
    if (typeof size === "number") {
      this.fileSizes.set(normPath, size);
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

  setFileSize(path: string, size: number): void {
    this.fileSizes.set(normalizePathKey(path), size);
  }

  getFileSize(path: string): number | undefined {
    return this.fileSizes.get(normalizePathKey(path));
  }

  getFileSizes(): Map<string, number> {
    return new Map(this.fileSizes);
  }

  getFilePaths(): string[] {
    return Array.from(this.byPath.keys());
  }

  removeFile(path: string): void {
    const norm = normalizePathKey(path);
    this.fileMtimes.delete(norm);
    this.fileSizes.delete(norm);
    if (this.byPath.delete(norm)) this.dirty = true;
  }

  hasFile(path: string): boolean {
    return this.byPath.has(normalizePathKey(path));
  }

  clear(): void {
    this.byPath.clear();
    this.fileMtimes.clear();
    this.fileSizes.clear();
    this.flat = [];
    this.dirty = true;
    // Dimension is deliberately preserved across clear so vector size contract remains valid
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
    const scored: RetrievedChunk[] = [];
    for (let i = 0; i < this.flat.length; i++) {
      const c = this.flat[i];
      scored.push({
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        score: dot(c.vector, q),
      });
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
    const sizesObj: Record<string, number> = {};
    for (const [p, s] of this.fileSizes.entries()) {
      sizesObj[p] = s;
    }
    return {
      version: 2,
      dim: this.dim,
      embeddingModel: this.embeddingModel,
      fileMtimes: mtimesObj,
      fileSizes: sizesObj,
      chunks: this.flat,
    };
  }

  static fromJSON(data: unknown, expectedEmbeddingModel?: string): VectorStore {
    const store = new VectorStore();
    const p = data as Partial<Persisted> | undefined;
    if (!p || (p.version !== 1 && p.version !== 2) || !Array.isArray(p.chunks)) return store;

    // Check embedding model compatibility:
    // If expected model identity is set and persisted identity is missing or different,
    // invalidate and rebuild. Never relabel legacy vectors as generated by the current model.
    if (expectedEmbeddingModel) {
      if (!p.embeddingModel || p.embeddingModel.trim() !== expectedEmbeddingModel.trim()) {
        return store;
      }
    }

    if (p.embeddingModel) {
      store.embeddingModel = p.embeddingModel;
    }

    const declaredDim = typeof p.dim === "number" && p.dim > 0 ? p.dim : 0;
    store.dim = declaredDim;

    let loaded = 0;
    for (const c of p.chunks) {
      if (loaded >= MAX_CHUNKS) break;
      if (!c || typeof c.path !== "string" || !Array.isArray(c.vector)) continue;

      // Workspace containment validation: reject traversal or absolute paths
      if (
        c.path.startsWith("/") ||
        c.path.startsWith("\\") ||
        c.path.includes("..") ||
        /^[a-zA-Z]:/.test(c.path)
      ) {
        continue;
      }

      // Content and metadata validation
      if (typeof c.text !== "string" || c.text.length === 0) continue;
      if (
        typeof c.startLine !== "number" ||
        typeof c.endLine !== "number" ||
        c.startLine < 1 ||
        c.endLine < c.startLine
      ) {
        continue;
      }

      // Dimension and finite values validation
      if (declaredDim && c.vector.length !== declaredDim) continue;
      if (c.vector.length === 0 || !c.vector.every((x) => typeof x === "number" && Number.isFinite(x))) {
        continue;
      }

      // Revalidate vector normalization on load
      const normalizedVector = normalize(c.vector);
      const normPath = normalizePathKey(c.path);
      const list = store.byPath.get(normPath) ?? [];
      list.push({ ...c, path: normPath, vector: normalizedVector });
      store.byPath.set(normPath, list);
      loaded++;
    }

    if (p.fileMtimes && typeof p.fileMtimes === "object") {
      for (const [k, v] of Object.entries(p.fileMtimes)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          store.fileMtimes.set(normalizePathKey(k), v);
        }
      }
    }

    if (p.fileSizes && typeof p.fileSizes === "object") {
      for (const [k, v] of Object.entries(p.fileSizes)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          store.fileSizes.set(normalizePathKey(k), v);
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

  /**
   * Deterministically trim oldest files when over chunk cap so memory/disk stay bounded.
   * Sorts files by oldest mtime then lexicographically for deterministic eviction.
   */
  private enforceCap(): void {
    let total = 0;
    for (const list of this.byPath.values()) total += list.length;
    if (total <= MAX_CHUNKS) return;

    const paths = Array.from(this.byPath.keys()).sort((a, b) => {
      const ma = this.fileMtimes.get(a) ?? 0;
      const mb = this.fileMtimes.get(b) ?? 0;
      if (ma !== mb) return ma - mb;
      return a.localeCompare(b);
    });

    for (const path of paths) {
      if (total <= MAX_CHUNKS) break;
      const count = this.byPath.get(path)?.length ?? 0;
      total -= count;
      this.byPath.delete(path);
      this.fileMtimes.delete(path);
      this.fileSizes.delete(path);
    }
    this.dirty = true;
  }
}

export function normalizePathKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0 || !Number.isFinite(norm)) return v.map(() => 0);
  return v.map((x) => x / norm);
}

export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
