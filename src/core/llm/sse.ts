/**
 * Shared streaming helpers for HTTP-based LLM providers. Ollama uses bare
 * NDJSON lines; the cloud providers use SSE (`data: {...}` lines). Both are
 * just newline-delimited text, so one reader handles every source.
 */

/** Default max gap between received bytes before a cloud stream is declared
 *  stalled. Generous on purpose: reasoning-style models can think silently for
 *  minutes before their first visible token, and a false stall aborts a healthy
 *  generation. Mirrors the Ollama client's philosophy — bound the silence,
 *  never the total generation time. */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/**
 * Yield complete SSE `data:` payloads from a response body.
 *
 * Unlike reading raw lines, this implements the SSE framing rules: consecutive
 * `data:` lines compose ONE event (joined with `\n`), dispatched on the blank
 * line separator. Providers that split a large JSON frame across multiple
 * `data:` lines are therefore reassembled instead of silently dropped. Event/
 * comment/id lines and the `[DONE]` terminator are filtered out. Also enforces
 * an idle watchdog: if no bytes arrive for `idleTimeoutMs`, the stream is
 * cancelled and an error thrown, so a hung connection can't stall a turn.
 */
export async function* streamSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const dispatch = function* (): Generator<string> {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    if (!payload || payload === "[DONE]") return;
    yield payload;
  };

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const res = await raceIdleTimeout(reader.read(), idleTimeoutMs, signal);
        done = res.done;
        value = res.value;
      } catch (e) {
        if (signal?.aborted || (e as Error).name === "AbortError") throw new DOMException("Aborted", "AbortError");
        await reader.cancel().catch(() => {});
        throw e;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) {
          // Strip exactly one leading space per the SSE spec.
          const rest = line.slice(5);
          dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
        } else if (line.trim() === "") {
          yield* dispatch();
        }
        // `event:`/`id:`/`retry:`/comment lines carry no payload for our use.
      }
    }
    // Flush any residual buffer line not terminated by a newline
    if (buffer.trim()) {
      const line = buffer.replace(/\r$/, "");
      if (line.startsWith("data:")) {
        const rest = line.slice(5);
        dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
      }
    }
    // Flush any final event not terminated by a blank line.
    yield* dispatch();
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** Reject if the wrapped read produces nothing within `ms`. Honors caller's AbortSignal (audit). */
function raceIdleTimeout<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(
      () => { signal?.removeEventListener("abort", onAbort); reject(new Error(`No output from the provider for ${Math.round(ms / 1000)}s — connection stalled.`)); },
      ms
    );
    if (signal?.aborted) { clearTimeout(timer); return reject(new DOMException("Aborted", "AbortError")); }
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * fetch with bounded retry + exponential backoff for transient failures
 * (rate limits and gateway errors). Cloud APIs 429/503 routinely under agent
 * load; without this a single blip kills an entire multi-step turn. The user's
 * abort signal is honored between attempts and after backoff sleeps.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: { retries?: number; signal?: AbortSignal; timeoutMs?: number }
): Promise<Response> {
  const retries = opts?.retries ?? 2;
  const userSignal = opts?.signal ?? init.signal;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Per-attempt timeout: a stale AbortSignal.timeout baked into init must not
    // poison retries. Combine user abort with a fresh timeout each attempt.
    const timeoutMs = opts?.timeoutMs;
    const attemptTimeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const combined = userSignal && attemptTimeout
      ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any
        ? AbortSignal.any([userSignal, attemptTimeout])
        : userSignal
      : attemptTimeout ?? userSignal;
    // Strip a potentially-expired init.signal; use the fresh combined signal.
    const { signal: _ignored, ...rest } = init;
    try {
      const res = await fetch(url, { ...rest, signal: combined });
      if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) return res;
      // Honor Retry-After on 429/503 when present (bounded).
      const retryAfter = Number(res.headers.get("Retry-After"));
      await res.text().catch(() => {});
      lastError = new Error(`HTTP ${res.status}`);
      if (userSignal?.aborted) throw new DOMException("Aborted", "AbortError");
      const base = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : 700 * 2 ** attempt;
      await sleepAbortable(base + Math.random() * 300, userSignal);
    } catch (e) {
      // Only the user's abort fails fast; per-attempt timeouts/transients retry.
      if (userSignal?.aborted) throw e;
      lastError = e;
      if (attempt === retries) throw e;
      if (attempt < retries) {
        await sleepAbortable(700 * 2 ** attempt + Math.random() * 300, userSignal).catch(() => {
          throw new DOMException("Aborted", "AbortError");
        });
        continue;
      }
      throw e;
    }
    if (userSignal?.aborted) throw new DOMException("Aborted", "AbortError");
  }
  // Unreachable — the loop always returns or throws.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleepAbortable(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Extract the JSON payload from a line. Handles:
 *  - SSE `data: {...}` (and the `data: [DONE]` terminator → undefined)
 *  - bare NDJSON `{...}` (Ollama)
 * Returns undefined for event lines (`event: x`), comments, or the terminator.
 */
export function sseData(line: string): string | undefined {
  if (line.startsWith("data:")) {
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return undefined;
    return payload;
  }
  if (line.startsWith("{")) return line;
  return undefined;
}

/** Parse a JSON payload defensively — returns undefined on malformed input. */
export function tryJson<T>(payload: string): T | undefined {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
}