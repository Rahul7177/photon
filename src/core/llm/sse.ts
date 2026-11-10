import { parseRetryAfter } from "./errors";

/**
 * Shared streaming helpers for HTTP-based LLM providers. Ollama uses bare
 * NDJSON lines; the cloud providers use SSE (`data: {...}` lines). Both are
 * newline-delimited text, so one reader handles every source.
 */

/** Default max gap between received bytes before a cloud stream is declared
 *  stalled. Generous on purpose: reasoning-style models can think silently for
 *  minutes before their first visible token, and a false stall aborts a healthy
 *  generation. Mirrors the Ollama client's philosophy — bound the silence,
 *  never the total generation time. */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** Default maximum total response byte budget (50 MB) to prevent runaway memory usage. */
export const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

export interface StreamSseOptions {
  idleTimeoutMs?: number;
  maxResponseBytes?: number;
  maxDurationMs?: number;
}

/**
 * Yield complete SSE `data:` payloads from a response body.
 *
 * Implements full SSE framing rules:
 * - Consecutive `data:` lines compose ONE event (joined with `\n`), dispatched on the blank line separator.
 * - Providers splitting a large JSON frame across multiple `data:` lines are reassembled.
 * - Event (`event:`), comment (`:`), id (`id:`), and retry (`retry:`) lines are ignored.
 * - The `[DONE]` terminator is filtered out.
 * - Handles both CRLF (`\r\n`) and LF (`\n`).
 * - Handles final payloads without a trailing blank line or newline.
 * - TextDecoder `{ stream: true }` correctly reassembles multi-byte UTF-8 split across chunks.
 * - Enforces an idle watchdog timeout and bounds total response bytes.
 */
export async function* streamSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutOrOpts: number | StreamSseOptions = DEFAULT_IDLE_TIMEOUT_MS
): AsyncGenerator<string> {
  const opts: StreamSseOptions =
    typeof idleTimeoutOrOpts === "number"
      ? { idleTimeoutMs: idleTimeoutOrOpts }
      : (idleTimeoutOrOpts ?? {});

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxDurationMs = opts.maxDurationMs;
  const startTime = Date.now();

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataLines: string[] = [];
  let totalBytes = 0;
  let doneTerminated = false;

  const dispatch = function* (): Generator<string> {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    if (!payload) return;
    if (payload === "[DONE]") {
      doneTerminated = true;
      return;
    }
    yield payload;
  };

  try {
    while (!doneTerminated) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (maxDurationMs && Date.now() - startTime > maxDurationMs) {
        throw new Error(`Stream exceeded maximum duration limit of ${Math.round(maxDurationMs / 1000)}s.`);
      }

      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const res = await raceIdleTimeout(reader.read(), idleTimeoutMs, signal);
        done = res.done;
        value = res.value;
      } catch (e) {
        if (signal?.aborted || (e as Error).name === "AbortError") {
          throw new DOMException("Aborted", "AbortError");
        }
        await reader.cancel().catch(() => {});
        throw e;
      }

      if (done) break;

      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(
            `Stream exceeded maximum response budget of ${Math.round(maxResponseBytes / (1024 * 1024))}MB.`
          );
        }
        buffer += decoder.decode(value, { stream: true });
      }

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);

        // SSE comment
        if (line.startsWith(":")) {
          continue;
        }
        if (line.startsWith("data:")) {
          // Strip exactly one optional leading space per the SSE specification
          const rest = line.slice(5);
          const value = rest.startsWith(" ") ? rest.slice(1) : rest;
          if (dataLines.length === 0 && value === "[DONE]") {
            doneTerminated = true;
            break;
          }
          dataLines.push(value);
        } else if (line.trim() === "") {
          yield* dispatch();
          if (doneTerminated) break;
        }
        // Lines starting with event:, id:, retry: are metadata; ignored for chat payload
      }
    }

    // Flush decoder stream tail
    buffer += decoder.decode();

    // Flush any residual buffer line not terminated by a newline
    if (!doneTerminated && buffer.trim()) {
      const line = buffer.replace(/\r$/, "");
      if (line.startsWith("data:")) {
        const rest = line.slice(5);
        dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
      }
    }

    // Flush any final event not terminated by a blank line
    if (!doneTerminated) yield* dispatch();
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore cancellation errors */
    }
  }
}

/** Reject if the wrapped read produces nothing within `ms`. Cleans up signal listeners strictly. */
function raceIdleTimeout<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    };

    onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    if (signal?.aborted) {
      return reject(new DOMException("Aborted", "AbortError"));
    }

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`No output from the provider for ${Math.round(ms / 1000)}s — connection stalled.`));
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });

    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      }
    );
  });
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface FetchWithRetryOptions {
  retries?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Fetch with bounded retry + exponential backoff for transient failures.
 * - Does not retry permanent client errors (400, 401, 403, 404).
 * - On 429, inspects body for quota exhaustion / insufficient funds to avoid useless retries.
 * - Parses `Retry-After` header as seconds or HTTP-date.
 * - Prevents listener leakage on per-attempt timeout and user signals.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: FetchWithRetryOptions
): Promise<Response> {
  const retries = opts?.retries ?? 2;
  const userSignal = opts?.signal ?? (init.signal as AbortSignal | undefined);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (userSignal?.aborted) throw new DOMException("Aborted", "AbortError");

    const timeoutMs = opts?.timeoutMs;
    const attemptTimeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const combined =
      userSignal && attemptTimeout
        ? (AbortSignal as any).any
          ? (AbortSignal as any).any([userSignal, attemptTimeout])
          : userSignal
        : attemptTimeout ?? userSignal;

    const { signal: _ignored, ...rest } = init;

    try {
      const res = await fetch(url, { ...rest, signal: combined });

      if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) {
        return res;
      }

      // Check if 429 is a permanent quota / billing exhaustion
      if (res.status === 429) {
        const cloned = res.clone();
        const bodyText = (await cloned.text().catch(() => "")).toLowerCase();
        const isQuotaExhausted =
          bodyText.includes("insufficient_quota") ||
          bodyText.includes("quota_exceeded") ||
          bodyText.includes("credit_balance") ||
          bodyText.includes("billing") ||
          bodyText.includes("exceeded your current quota") ||
          bodyText.includes("out of credits");

        if (isQuotaExhausted) {
          // Never retry permanent quota exhaustion!
          return res;
        }
      }

      // Read response body so socket can be reused
      await res.text().catch(() => {});

      // Parse Retry-After header (supports integer seconds and HTTP-date)
      const retryAfterSec = parseRetryAfter(res.headers.get("Retry-After"));
      lastError = new Error(`HTTP ${res.status}`);

      if (userSignal?.aborted) throw new DOMException("Aborted", "AbortError");

      const baseMs =
        retryAfterSec !== undefined && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 10000)
          : 700 * 2 ** attempt;

      await sleepAbortable(baseMs + Math.random() * 300, userSignal);
    } catch (e) {
      if (userSignal?.aborted) throw e;
      lastError = e;
      if (attempt === retries) throw e;

      await sleepAbortable(700 * 2 ** attempt + Math.random() * 300, userSignal).catch(() => {
        throw new DOMException("Aborted", "AbortError");
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleepAbortable(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    let t: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const cleanup = () => {
      if (t) {
        clearTimeout(t);
        t = undefined;
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    };

    onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

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
