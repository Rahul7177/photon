import type {
  OllamaChatChunk,
  OllamaChatRequest,
  OllamaEmbedResponse,
  OllamaPsModel,
  OllamaPsResponse,
  OllamaPullChunk,
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
  /** Connect timeout: max wait for the server to begin responding. Must cover
   *  cold model loads on slow disks (multi-GB weights, evicted VRAM/RAM) plus
   *  prompt eval before the first byte. Consumer laptops routinely need minutes.
   *  Adjustable via photon.ollama.connectTimeoutMs. */
  connectTimeoutMs?: number;
  /** How long Ollama should keep a loaded model resident between requests.
   *  Ollama's default (5m) unloads models between infrequent turns, so every
   *  call pays a full cold load — which also skews bench throughput numbers.
   *  Example: "-1" (never unload) or "30m". Omit to use the server default. */
  keepAlive?: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 300_000;
const MIN_CONNECT_TIMEOUT_MS = 15_000;
/** Safe default context window when a caller (like testModel) omits num_ctx.
 *  Prevents a stray request with no num_ctx from falling back to a massive
 *  OLLAMA_CONTEXT_LENGTH env var (e.g. 131072) and triggering a cold reload. */
const SAFE_FALLBACK_CTX = 8192;

/**
 * Minimal, dependency-free client for a local Ollama server.
 * Uses the global fetch (Node 18+/20+) and streams NDJSON responses.
 */
export class OllamaClient {
  constructor(private opts: OllamaClientOptions) {}

  /** Last num_ctx used per model. Ollama reloads a model whenever num_ctx
   *  differs from the loaded runner's, so every request to a model must agree. */
  private lastCtx = new Map<string, number>();

  /** Pre-seed or update the pinned context window for a model. */
  setModelCtx(model: string, numCtx: number): void {
    if (model && numCtx > 0) this.lastCtx.set(model, numCtx);
  }

  private pinCtx(req: OllamaChatRequest): OllamaChatRequest {
    const ctx = req.options?.num_ctx;
    if (ctx && ctx > 0) {
      this.lastCtx.set(req.model, ctx);
      return req;
    }
    const prev = this.lastCtx.get(req.model) ?? SAFE_FALLBACK_CTX;
    this.lastCtx.set(req.model, prev);
    return { ...req, options: { ...(req.options ?? {}), num_ctx: prev } };
  }

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
    try {
      return (await res.json()) as OllamaTagsResponse;
    } catch (e) {
      throw new OllamaError("Malformed JSON from Ollama /api/tags.", e);
    }
  }

  /** List models currently loaded in Ollama's GPU/RAM runner (`ollama ps`). */
  async listRunning(): Promise<OllamaPsModel[]> {
    try {
      const res = await this.fetch("/api/ps", { method: "GET" }, 5_000);
      if (!res.ok) return [];
      const json = (await res.json()) as OllamaPsResponse;
      const list = Array.isArray(json?.models) ? json.models : [];
      // Sync lastCtx from any already-running model so our first request matches
      // what's currently in VRAM unless the plan explicitly overrides it.
      for (const m of list) {
        if (m.name && m.context_length && m.context_length > 0 && !this.lastCtx.has(m.name)) {
          this.lastCtx.set(m.name, m.context_length);
        }
      }
      return list;
    } catch {
      return [];
    }
  }

  /** Explicitly unload a model from GPU/RAM (`keep_alive: 0`). */
  async unloadModel(model: string): Promise<void> {
    const res = await this.fetch(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
      },
      10_000
    );
    await res.body?.cancel().catch(() => undefined);
    this.lastCtx.delete(model);
  }

  /** Stream a `POST /api/pull` download for a model name, reporting progress. */
  async pullModel(
    model: string,
    onProgress: (chunk: OllamaPullChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      throw new OllamaError(`Ollama /api/pull failed (${res.status}). ${detail}`.trim());
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as OllamaPullChunk;
            if (parsed.error) throw new OllamaError(parsed.error);
            onProgress(parsed);
          } catch (e) {
            if (e instanceof OllamaError) throw e;
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  }

  async showModel(name: string): Promise<OllamaShowResponse> {
    const res = await this.fetch(
      "/api/show",
      { method: "POST", body: JSON.stringify({ name }) },
      30_000
    );
    if (!res.ok) throw new OllamaError(`POST /api/show (${name}) failed: ${res.status}`);
    try {
      return (await res.json()) as OllamaShowResponse;
    } catch (e) {
      throw new OllamaError(`Malformed JSON from Ollama /api/show (${name}).`, e);
    }
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
          // Run embeddings on CPU: a second GPU-resident model (the embedder) makes
          // Ollama evict the chat model to fit it, forcing a full reload on the next
          // chat turn. nomic-style embedders are small enough for CPU.
          options: { num_gpu: 0 },
          // Pin the embedding model too — indexing embeds in bursts separated
          // by idle gaps longer than Ollama's unload window.
          ...(this.opts.keepAlive ? { keep_alive: normalizeKeepAlive(this.opts.keepAlive) } : {}),
        }),
      },
      timeoutMs
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      throw new OllamaError(`POST /api/embed failed (${res.status}). ${detail}`.trim());
    }
    let json: OllamaEmbedResponse;
    try {
      json = (await res.json()) as OllamaEmbedResponse;
    } catch (e) {
      throw new OllamaError("Malformed JSON from Ollama /api/embed.", e);
    }
    if (!Array.isArray(json.embeddings)) throw new OllamaError("Embeddings response had no vectors.");
    return json.embeddings;
  }

  /**
   * Stream a chat completion. Yields decoded NDJSON chunks until done.
   */
  async *chatStream(
    req: OllamaChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<OllamaChatChunk, void, unknown> {
    // Ollama may evict/restart the model runner between turns (idle unload,
    // VRAM pressure, runner crash) -> 5xx or an empty stream with no reply.
    // Retry transparently (the retry reloads the model) if nothing was yielded.
    const MAX_RETRIES = 2;
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const chunk of this.chatStreamOnce(req, signal)) {
          yielded = true;
          yield chunk;
        }
        if (yielded || signal?.aborted || attempt >= MAX_RETRIES) return;
      } catch (err) {
        const retryable = err instanceof OllamaError && /failed \(5\d\d\)/.test(err.message);
        if (yielded || signal?.aborted || !retryable || attempt >= MAX_RETRIES) throw err;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }

  private async *chatStreamOnce(
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
    const firstByteMs = Math.max(idleMs, 600_000);
    const connectMs = Math.max(
      this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      MIN_CONNECT_TIMEOUT_MS
    );
    let res: Response;
    try {
      arm(connectMs, `Ollama did not start responding within ${Math.round(connectMs / 1000)}s — the model may still be loading into memory (cold load on slow disks/VRAM takes minutes). If this persists, raise photon.ollama.connectTimeoutMs.`);
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...this.pinCtx(req),
          stream: true,
          ...(this.opts.keepAlive ? { keep_alive: normalizeKeepAlive(this.opts.keepAlive) } : {}),
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
      const detail = (await res.text().catch(() => "")).slice(0, 500);
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
    if (abortReason) return abortReason;
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

  /**
   * Best-effort background warmup: loads `model` into memory now so the first
   * real turn doesn't pay the cold load.
   */
  async warmup(model: string, timeoutMs?: number, numCtx?: number): Promise<void> {
    const ms = Math.max(timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, MIN_CONNECT_TIMEOUT_MS);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const effectiveCtx = numCtx ?? this.lastCtx.get(model) ?? SAFE_FALLBACK_CTX;
    this.lastCtx.set(model, effectiveCtx);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ok" }],
          stream: false,
          options: { num_predict: 1, num_ctx: effectiveCtx },
          ...(this.opts.keepAlive ? { keep_alive: normalizeKeepAlive(this.opts.keepAlive) } : {}),
        }),
        signal: ctrl.signal,
      });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new OllamaError(`Warmup for "${model}" failed (${res.status}).`);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new OllamaError(`Warmup for "${model}" timed out after ${Math.round(ms / 1000)}s.`);
      }
      throw err;
    } finally {
      clearTimeout(t);
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

/** Ollama rejects bare numeric strings like "-1"; send them as numbers. */
function normalizeKeepAlive(v: string): string | number {
  return /^-?\d+$/.test(v) ? Number(v) : v;
}
