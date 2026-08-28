import type {
  OllamaChatChunk,
  OllamaChatRequest,
  OllamaEmbedResponse,
  OllamaShowResponse,
  OllamaTagsResponse,
} from "./types";

export class OllamaError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "OllamaError";
  }
}

export interface OllamaClientOptions {
  baseUrl: string;
  /** Idle timeout: max gap between streamed chunks before we give up. */
  timeoutMs: number;
  /** How long Ollama should keep a loaded model resident between requests.
   *  Ollama's default (5m) unloads models between infrequent turns, so every
   *  call pays a full cold load — which also skews bench throughput numbers.
   *  Example: "30m". Omit to use the server default. */
  keepAlive?: string;
}

const CONNECT_TIMEOUT_MS = 60_000;

/**
 * Minimal, dependency-free client for a local Ollama server.
 * Uses the global fetch (Node 18+/20+) and streams NDJSON responses.
 */
export class OllamaClient {
  constructor(private opts: OllamaClientOptions) {}

  get baseUrl() {
    return this.opts.baseUrl.replace(/\/+$/, "");
  }

  update(opts: Partial<OllamaClientOptions>) {
    this.opts = { ...this.opts, ...opts };
  }

  /** Cheap reachability probe used on activation and by diagnostics. */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetch("/api/version", { method: "GET" }, 4000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<OllamaTagsResponse> {
    const res = await this.fetch("/api/tags", { method: "GET" }, 15_000);
    if (!res.ok) throw new OllamaError(`GET /api/tags failed: ${res.status}`);
    return (await res.json()) as OllamaTagsResponse;
  }

  async showModel(name: string): Promise<OllamaShowResponse> {
    const res = await this.fetch(
      "/api/show",
      { method: "POST", body: JSON.stringify({ name }) },
      15_000
    );
    if (!res.ok) throw new OllamaError(`POST /api/show failed: ${res.status}`);
    return (await res.json()) as OllamaShowResponse;
  }

  /**
   * Embed one or more strings with a local embedding model (workspace indexing).
   * Uses /api/embed (batched). Bounded by a total timeout — embedding is a quick,
   * non-streaming call.
   */
  async embed(model: string, input: string | string[], timeoutMs = 60_000): Promise<number[][]> {
    const res = await this.fetch(
      "/api/embed",
      {
        method: "POST",
        body: JSON.stringify({
          model,
          input,
          // Pin the embedding model too — indexing embeds in bursts separated
          // by idle gaps longer than Ollama's unload window.
          ...(this.opts.keepAlive ? { keep_alive: this.opts.keepAlive } : {}),
        }),
      },
      timeoutMs
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new OllamaError(`POST /api/embed failed (${res.status}). ${detail}`.trim());
    }
    const json = (await res.json()) as OllamaEmbedResponse;
    if (!Array.isArray(json.embeddings)) throw new OllamaError("Embeddings response had no vectors.");
    return json.embeddings;
  }

  /**
   * Stream a chat completion. Yields decoded NDJSON chunks until done.
   *
   * Timeout model (important for slow local models): we bound the CONNECT phase
   * and the IDLE gap between chunks — never the total duration. As long as the
   * model keeps emitting tokens, generation may run indefinitely. Pass an
   * AbortSignal to cancel.
   */
  async *chatStream(
    req: OllamaChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<OllamaChatChunk, void, unknown> {
    const ctrl = new AbortController();
    let abortReason: OllamaError | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const arm = (ms: number, reason: string) => {
      clearTimer();
      timer = setTimeout(() => {
        abortReason = new OllamaError(reason);
        ctrl.abort();
      }, ms);
    };

    const onUserAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onUserAbort, { once: true });
    }

    const idleMs = Math.max(this.opts.timeoutMs, 60_000);
    // The first token can lag while a low-end machine does prompt eval on a big
    // context, so give it a much longer grace than the inter-chunk idle gap.
    const firstByteMs = Math.max(idleMs, 600_000);
    let res: Response;
    try {
      arm(CONNECT_TIMEOUT_MS, `Ollama did not respond within ${CONNECT_TIMEOUT_MS / 1000}s.`);
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...req,
          stream: true,
          ...(this.opts.keepAlive ? { keep_alive: this.opts.keepAlive } : {}),
        }),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimer();
      if (signal) signal.removeEventListener("abort", onUserAbort);
      throw this.translateError(err, signal, abortReason);
    }
    clearTimer();

    if (!res.ok || !res.body) {
      if (signal) signal.removeEventListener("abort", onUserAbort);
      const detail = await res.text().catch(() => "");
      throw new OllamaError(`Ollama /api/chat failed (${res.status}). ${detail}`.trim());
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let first = true;

    try {
      while (true) {
        const waitMs = first ? firstByteMs : idleMs;
        arm(waitMs, `No output from the model for ${Math.round(waitMs / 1000)}s.`);
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          throw this.translateError(err, signal, abortReason);
        }
        clearTimer();
        if (done) break;
        first = false;

        if (value) buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) yield this.parseChunk(line);
        }
      }
      const tail = buffer.trim();
      if (tail) yield this.parseChunk(tail);
    } finally {
      clearTimer();
      if (signal) signal.removeEventListener("abort", onUserAbort);
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  }

  private translateError(
    err: unknown,
    signal: AbortSignal | undefined,
    abortReason: OllamaError | null
  ): Error {
    // Our own idle/connect timeout fired.
    if (abortReason) return abortReason;
    // The caller cancelled — propagate a plain AbortError.
    if (signal?.aborted) return new DOMException("Aborted", "AbortError");
    if (err instanceof Error && err.name === "AbortError") return err;
    return new OllamaError(`Cannot reach Ollama at ${this.baseUrl}. Is it running?`, err);
  }

  private parseChunk(line: string): OllamaChatChunk {
    try {
      return JSON.parse(line) as OllamaChatChunk;
    } catch (err) {
      throw new OllamaError(`Malformed NDJSON chunk from Ollama: ${line}`, err);
    }
  }

  /** Total-timeout fetch for the small, quick JSON endpoints. */
  private async fetch(
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new OllamaError(`Ollama request timed out after ${timeoutMs}ms`, err);
      }
      throw new OllamaError(`Cannot reach Ollama at ${this.baseUrl}. Is it running?`, err);
    }
  }
}
