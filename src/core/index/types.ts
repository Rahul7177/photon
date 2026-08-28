// Internal types for the local workspace index (Module 10). Kept in the engine
// (no vscode / heavy deps) so the index can be reused outside VS Code.

export interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface IndexedChunk extends Chunk {
  id: string;
  /** Unit-normalized embedding, so cosine similarity is a plain dot product. */
  vector: number[];
}

export interface RetrievedChunk extends Chunk {
  /** Cosine similarity in [-1, 1]; higher is more relevant. */
  score: number;
}

/** Embeds a batch of texts into vectors. Injected so the engine never imports a
 *  concrete provider — the host wires this to Ollama's /api/embed. */
export type EmbedFn = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
