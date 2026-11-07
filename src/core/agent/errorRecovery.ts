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

/**
 * Classify any error thrown during model streaming or provider requests.
 */
export function classifyRuntimeError(
  err: unknown,
  signal?: AbortSignal
): ClassifiedRuntimeError {
  const rawMessage =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "Unknown error");
  const name = err instanceof Error ? err.name : "";
  const status = typeof (err as { status?: unknown })?.status === "number"
    ? ((err as { status: number }).status)
    : extractHttpStatus(rawMessage);

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

  // 3. Authentication & Permission errors (Permanent — never retry)
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

  // 4. Permanent configuration / validation / model-not-found errors (Permanent — never retry)
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

  // 5. Rate limits (HTTP 429) — retryable unless permanent billing/quota exhaustion
  if (
    status === 429 ||
    /\b(?:rate[_\s-]?limit|too many requests|resource_exhausted|quota)\b/i.test(rawMessage)
  ) {
    const isPermanentBilling = /\b(?:billing|insufficient_quota|exceeded your current quota|plan and billing)\b/i.test(
      rawMessage
    );
    return {
      category: "rate_limit",
      retryable: !isPermanentBilling,
      backoffMs: 1200,
      userMessage: isPermanentBilling
        ? `Provider quota exhausted: ${rawMessage}. Check your provider billing settings.`
        : `Rate limit reached: ${rawMessage}. Please wait a moment and try again.`,
      rawMessage,
    };
  }

  // 6. Local runtime crashes (Ollama runner crash / out-of-memory / daemon stopped)
  if (
    /\b(?:llama runner process has terminated|runner process|out of memory|cuda error|ggml_assert|ollama.*not reachable|econnrefused.*11434)\b/i.test(
      rawMessage
    )
  ) {
    const isOom = /\b(?:out of memory|cuda error|cannot allocate)\b/i.test(rawMessage);
    return {
      category: "local_runtime_crash",
      retryable: !isOom,
      backoffMs: 800,
      userMessage: isOom
        ? `Local model ran out of memory: ${rawMessage}. Try reducing the context window or selecting a smaller model.`
        : `Local runtime error: ${rawMessage}`,
      rawMessage,
    };
  }

  // 7. Timeouts & stalled streams (Transient — safe to retry if no partial output/side-effects)
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
      backoffMs: 700,
      userMessage: `Request timed out: ${rawMessage}`,
      rawMessage,
    };
  }

  // 8. Transient network / gateway errors (HTTP 500/502/503, ECONNRESET, fetch failed)
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
      backoffMs: 700,
      userMessage: `Network or provider error: ${rawMessage}`,
      rawMessage,
    };
  }

  // 9. Unknown / unclassified error — do not blindly retry
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

      // If any tool_calls were not responded to, insert synthesized fallback tool outcomes
      for (const tc of m.tool_calls) {
        if (tc.id && !answeredIds.has(tc.id)) {
          out.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `[TOOL_OUTCOME: "${tc.function.name}" completed or output omitted to fit context window]`,
          });
        }
      }
      continue;
    }

    out.push(m);
  }

  return out;
}


