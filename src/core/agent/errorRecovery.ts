import { randomUUID } from "node:crypto";

/**
 * Runtime Error Classification, Failure Recovery, and Tool-Failure Guardrails (P1 Item 6).
 *
 * Provides deterministic classification for provider/runtime errors so both the
 * Local Unified Engine (`runUnifiedTurn`) and Cloud Engine (`runCloudTurn`) handle:
 *  - Timeouts & stalled streams
 *  - Rate limits (HTTP 429)
 *  - Network errors & gateway failures (HTTP 502/503/504, ECONNRESET, fetch failed)
 *  - Local runtime crashes (Ollama / llama-server runner termination, ECONNREFUSED)
 *  - Permanent configuration / authentication / validation errors (HTTP 400/401/403/404/422)
 *  - User cancellation (AbortError / AbortSignal)
 *
 * Ensures bounded retries happen ONLY when retrying is safe and transient, and prevents
 * models from mistaking failed tool calls for completed actions.
 */

export type RuntimeErrorCategory =
  | "cancelled"
  | "auth"
  | "config_or_validation"
  | "rate_limit"
  | "timeout"
  | "network"
  | "local_runtime_crash"
  | "output_overflow"
  | "unknown";

export interface ClassifiedRuntimeError {
  category: RuntimeErrorCategory;
  /** True only for transient failures that are safe to retry when no side-effects occurred. */
  retryable: boolean;
  /** Recommended backoff delay before retrying (ms). */
  backoffMs: number;
  /** Clear, actionable message suitable for displaying to the user. */
  userMessage: string;
  /** Original raw error message. */
  rawMessage: string;
}

export function redactSecretsFromError(msg: string): string {
  if (!msg) return "";
  return msg
    .replace(/(?:sk-[a-zA-Z0-9_\-\.]{12,})/gi, "[REDACTED_KEY]")
    .replace(/(?:key|token|secret|password|bearer|auth[a-z_-]*)\s*[:=]\s*['"]?[a-zA-Z0-9_\-\.]{8,}['"]?/gi, (match) => {
      const parts = match.split(/[:=]/);
      return `${parts[0]}: [REDACTED]`;
    })
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{8,}/gi, "Bearer [REDACTED]");
}

export function extractRetryAfter(err: unknown, rawMessage: string): number | undefined {
  if (err && typeof err === "object") {
    const headers =
      (err as { headers?: Record<string, string> | { get?: (k: string) => string | null } }).headers ??
      (err as { response?: { headers?: Record<string, string> | { get?: (k: string) => string | null } } }).response?.headers;

    let headerVal: string | null | undefined;
    if (headers) {
      if (typeof (headers as { get?: unknown }).get === "function") {
        headerVal = (headers as { get: (k: string) => string | null }).get("retry-after");
      } else if (typeof headers === "object") {
        headerVal = (headers as Record<string, string>)["retry-after"] ?? (headers as Record<string, string>)["Retry-After"];
      }
    }
    if (headerVal) {
      const sec = parseFloat(headerVal);
      if (!isNaN(sec) && sec >= 0) return sec * 1000;
      const parsedDate = Date.parse(headerVal);
      if (!isNaN(parsedDate) && parsedDate > Date.now()) return parsedDate - Date.now();
    }

    const explicitRetryAfter = (err as { retryAfter?: number }).retryAfter;
    if (typeof explicitRetryAfter === "number" && explicitRetryAfter > 0) {
      return explicitRetryAfter <= 3600 ? explicitRetryAfter * 1000 : explicitRetryAfter;
    }
  }

  const m =
    rawMessage.match(/(?:retry-after|retry in|try again in|wait)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms)?/i) ??
    rawMessage.match(/\b(?:after|in)\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds)\b/i);
  if (m) {
    const val = parseFloat(m[1]);
    const unit = m[2]?.toLowerCase();
    if (!isNaN(val) && val > 0) {
      if (unit === "ms") return val;
      return val * 1000;
    }
  }
  return undefined;
}

export interface ShouldRetryOpts {
  sideEffectsOccurred?: boolean;
  streamRetries: number;
  maxRetries: number;
  hasContent: boolean;
  toolCallsCount: number;
}

/**
 * Determines whether a stream failure should be retried.
 * Retrying is strictly prohibited if any side effects have occurred, if partial
 * text was already emitted to the user, or if tool calls are pending.
 */
export function shouldRetryStep(
  classified: ClassifiedRuntimeError,
  opts: ShouldRetryOpts
): { shouldRetry: boolean; reason?: string } {
  if (!classified.retryable) {
    return { shouldRetry: false, reason: "Error is not classified as retryable" };
  }
  if (opts.sideEffectsOccurred) {
    return { shouldRetry: false, reason: "Side effects or mutations have already occurred in this turn/step" };
  }
  if (opts.streamRetries >= opts.maxRetries) {
    return { shouldRetry: false, reason: `Exceeded maximum retries (${opts.maxRetries})` };
  }
  if (opts.hasContent) {
    return { shouldRetry: false, reason: "Model already emitted partial assistant text content" };
  }
  if (opts.toolCallsCount > 0) {
    return { shouldRetry: false, reason: "Tool calls were already parsed or underway" };
  }
  return { shouldRetry: true };
}

/**
 * Await backoff delay while remaining responsive to user cancellation.
 * Resolves false if cancelled during backoff.
 */
export async function waitWithBackoff(backoffMs: number, signal?: AbortSignal): Promise<boolean> {
  if (backoffMs <= 0) return !signal?.aborted;
  if (signal?.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(!signal?.aborted);
    }, backoffMs);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isContextOverflowError(err: unknown, rawMessage?: string): boolean {
  const msg =
    rawMessage ??
    (err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? ""));
  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : extractHttpStatus(msg);
  if (status === 413) return true;
  return /\b(?:context[_\s-]?length[_\s-]?exceeded|maximum context length|prompt is too long|too many tokens|request too large|input length.*exceeds|exceeds (?:the )?(?:maximum )?(?:context|token|input)|context window.*exceeded)\b/i.test(
    msg
  );
}

/**
 * Classify any error thrown during model streaming or provider requests.
 */
export function classifyRuntimeError(
  err: unknown,
  signal?: AbortSignal
): ClassifiedRuntimeError {
  const unredacted =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "Unknown error");
  const rawMessage = redactSecretsFromError(unredacted);
  const name = err instanceof Error ? err.name : "";
  const status = typeof (err as { status?: unknown })?.status === "number"
    ? ((err as { status: number }).status)
    : extractHttpStatus(rawMessage);

  const retryAfterMs = extractRetryAfter(err, rawMessage);
  const boundedBackoff = (fallbackMs: number): number => {
    if (retryAfterMs !== undefined) {
      return Math.min(30_000, Math.max(500, Math.round(retryAfterMs)));
    }
    return Math.min(30_000, Math.max(500, Math.round(fallbackMs)));
  };

  // 1. User cancellation / AbortSignal
  if (signal?.aborted || name === "AbortError" || /\baborted\b/i.test(rawMessage)) {
    return {
      category: "cancelled",
      retryable: false,
      backoffMs: 0,
      userMessage: "Stopped.",
      rawMessage,
    };
  }

  // 2. Output overflow / runaway generation loop
  if (/excessively long output|stuck in a loop/i.test(rawMessage)) {
    return {
      category: "output_overflow",
      retryable: false,
      backoffMs: 0,
      userMessage: `Generation stopped: ${rawMessage}`,
      rawMessage,
    };
  }

  // 3. Permanent quota, billing, balance exhaustion (Permanent — NEVER retry)
  const isPermanentBilling =
    status === 402 ||
    /\b(?:billing|insufficient_quota|exceeded your current quota|plan and billing|quota exceeded|credit_balance_too_low|balance is too low|payment required|spending limit|account suspended)\b/i.test(
      rawMessage
    );
  if (isPermanentBilling) {
    return {
      category: "rate_limit",
      retryable: false,
      backoffMs: 0,
      userMessage: `Provider quota exhausted: ${rawMessage}. Check your provider billing settings.`,
      rawMessage,
    };
  }

  // 4. Authentication & Permission errors (Permanent — never retry)
  if (
    status === 401 ||
    status === 403 ||
    /\b(?:unauthorized|invalid[_\s-]?api[_\s-]?key|incorrect api key|authentication failed|permission[_\s-]?denied|api key not valid|missing api key)\b/i.test(
      rawMessage
    )
  ) {
    return {
      category: "auth",
      retryable: false,
      backoffMs: 0,
      userMessage: `Authentication error: ${rawMessage}. Please verify your API key in Photon Settings.`,
      rawMessage,
    };
  }

  // 5. Permanent configuration / validation / model-not-found errors (Permanent — never retry)
  if (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    /\b(?:model\s+['"][^'"]+['"]\s+not found|unknown model|does not exist|invalid[_\s-]?argument|invalid[_\s-]?request|context_length_exceeded|unsupported parameter)\b/i.test(
      rawMessage
    )
  ) {
    return {
      category: "config_or_validation",
      retryable: false,
      backoffMs: 0,
      userMessage: `Configuration or request error: ${rawMessage}`,
      rawMessage,
    };
  }

  // 6. Rate limits (HTTP 429) — transient rate limit with bounded backoff
  if (
    status === 429 ||
    /\b(?:rate[_\s-]?limit|too many requests|resource_exhausted|quota)\b/i.test(rawMessage)
  ) {
    return {
      category: "rate_limit",
      retryable: true,
      backoffMs: boundedBackoff(1500),
      userMessage: `Rate limit reached: ${rawMessage}. Please wait a moment and try again.`,
      rawMessage,
    };
  }

  // 7. Local runtime crashes (Ollama runner crash / out-of-memory / daemon stopped)
  if (
    /\b(?:llama runner process has terminated|runner process|out of memory|cuda error|ggml_assert|ollama.*not reachable|econnrefused.*11434)\b/i.test(
      rawMessage
    )
  ) {
    const isOom = /\b(?:out of memory|cuda error|cannot allocate)\b/i.test(rawMessage);
    return {
      category: "local_runtime_crash",
      retryable: !isOom,
      backoffMs: isOom ? 0 : boundedBackoff(800),
      userMessage: isOom
        ? `Local model ran out of memory: ${rawMessage}. Try reducing the context window or selecting a smaller model.`
        : `Local runtime error: ${rawMessage}`,
      rawMessage,
    };
  }

  // 8. Timeouts & stalled streams (Transient — safe to retry if no partial output/side-effects)
  if (
    status === 408 ||
    status === 504 ||
    name === "TimeoutError" ||
    /\b(?:timed?\s*out|etimedout|connection stalled|no output from the provider|gateway timeout)\b/i.test(
      rawMessage
    )
  ) {
    return {
      category: "timeout",
      retryable: true,
      backoffMs: boundedBackoff(1000),
      userMessage: `Request timed out: ${rawMessage}`,
      rawMessage,
    };
  }

  // 9. Transient network / gateway errors (HTTP 500/502/503, ECONNRESET, fetch failed)
  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    /\b(?:econnreset|econnrefused|enotfound|ehostunreach|epipe|socket hang up|fetch failed|network error|bad gateway|service unavailable|overloaded|internal server error)\b/i.test(
      rawMessage
    )
  ) {
    return {
      category: "network",
      retryable: true,
      backoffMs: boundedBackoff(1000),
      userMessage: `Network or provider error: ${rawMessage}`,
      rawMessage,
    };
  }

  // 10. Unknown / unclassified error — do not blindly retry
  return {
    category: "unknown",
    retryable: false,
    backoffMs: 0,
    userMessage: `Model error: ${rawMessage}`,
    rawMessage,
  };
}

function extractHttpStatus(message: string): number | undefined {
  const m =
    message.match(/\bHTTP\s+(\d{3})\b/i) ??
    message.match(/\bstatus(?:\s+code)?[:\s]+(\d{3})\b/i) ??
    message.match(/\b\((\d{3})\)/);
  if (!m) return undefined;
  const code = Number(m[1]);
  return Number.isFinite(code) ? code : undefined;
}

/**
 * Formats a tool execution result for native/cloud tool messages so that failed tool calls
 * are unambiguously marked as failed and can never be mistaken by the model for completed actions.
 */
export function formatNativeToolOutcome(
  toolName: string,
  output: string,
  ok: boolean
): string {
  if (ok) return output;
  const trimmed = output.trim();
  if (trimmed.startsWith("[TOOL_ERROR")) return output;
  return `[TOOL_ERROR: "${toolName}" FAILED — the requested action was NOT completed]\n${output}`;
}

/**
 * Enforces strict tool-call and tool-result pairing across all messages sent to LLM providers.
 *
 * Provider API invariants (OpenAI, Anthropic Claude, Google Gemini, Ollama native tools):
 *  1. Every `role: "tool"` message MUST be preceded by an assistant message containing
 *     a `tool_calls` entry with the matching `tool_call_id`.
 *  2. Every `tool_call` entry in an assistant message MUST have a corresponding `role: "tool"`
 *     response before the conversation continues.
 *  3. An orphaned tool message (e.g. when context window fitting truncates the assistant message)
 *     or an un-responded assistant tool call triggers an immediate HTTP 400 error from frontier APIs.
 *
 * This function guarantees valid sequence pairing regardless of history trimming or compaction.
 */
export function sanitizeToolPairing(messages: import("../llm/types").LLMMessage[]): import("../llm/types").LLMMessage[] {
  if (!messages || messages.length === 0) return [];
  const out: import("../llm/types").LLMMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === "tool") {
      // Check if preceding message in `out` is an assistant with a matching tool_call
      const last = out[out.length - 1];
      const hasPrecedingCall =
        last &&
        last.role === "assistant" &&
        Boolean(last.tool_calls?.some((tc) => tc.id === m.tool_call_id));

      if (!hasPrecedingCall) {
        // Orphaned tool message — drop it to prevent HTTP 400 schema rejection
        continue;
      }
      out.push(m);
      continue;
    }

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      // Ensure all tool_calls have unique non-empty IDs to prevent provider API schema rejection
      const seenIds = new Set<string>();
      for (const tc of m.tool_calls) {
        if (!tc.id || seenIds.has(tc.id)) {
          tc.id = randomUUID();
        }
        seenIds.add(tc.id);
      }
      out.push(m);
      // Collect all following tool responses for this assistant message
      const toolIds = new Set(m.tool_calls.map((tc) => tc.id).filter(Boolean));
      const answeredIds = new Set<string>();

      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        const toolMsg = messages[j];
        if (toolMsg.tool_call_id && toolIds.has(toolMsg.tool_call_id)) {
          answeredIds.add(toolMsg.tool_call_id);
          out.push(toolMsg);
        }
        j++;
      }
      i = j - 1; // Advance past the processed tool messages

      // If any tool_calls were not responded to, insert synthesized fallback tool outcomes.
      // Unknown outcome must never be represented as successful or completed.
      for (const tc of m.tool_calls) {
        if (tc.id && !answeredIds.has(tc.id)) {
          out.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `[TOOL_ERROR: "${tc.function.name}" execution outcome unavailable or omitted from context window — action was NOT confirmed and must NOT be assumed successful]`,
          });
        }
      }
      continue;
    }

    out.push(m);
  }

  return out;
}


