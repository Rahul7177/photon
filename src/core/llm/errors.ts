/**
 * Typed LLM provider error classifications and credential redaction.
 * Ensures API keys, bearer tokens, and credentials are never exposed in error
 * messages, logs, diagnostics, or UI cards.
 */

export type LLMErrorCode =
  | "authentication_failed"
  | "permission_denied"
  | "invalid_request"
  | "quota_exhausted"
  | "rate_limit"
  | "not_found"
  | "timeout"
  | "network_error"
  | "server_error"
  | "unknown";

export class LLMProviderError extends Error {
  readonly code: LLMErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(opts: {
    message: string;
    code: LLMErrorCode;
    provider: string;
    status?: number;
    retryable?: boolean;
    retryAfterSeconds?: number;
  }) {
    super(opts.message);
    this.name = "LLMProviderError";
    this.code = opts.code;
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.retryable = opts.retryable ?? isCodeRetryable(opts.code);
  }
}

function isCodeRetryable(code: LLMErrorCode): boolean {
  switch (code) {
    case "rate_limit":
    case "server_error":
    case "network_error":
    case "timeout":
      return true;
    case "authentication_failed":
    case "permission_denied":
    case "invalid_request":
    case "quota_exhausted":
    case "not_found":
    case "unknown":
    default:
      return false;
  }
}

/**
 * Redact secret tokens, API keys, and sensitive headers/query parameters from text.
 */
export function redactSecrets(text: string, explicitSecrets?: (string | undefined)[]): string {
  if (!text) return "";
  let redacted = text;

  // 1. Redact explicit secrets if provided (min length 4 to avoid false-replacing short noise)
  if (explicitSecrets?.length) {
    for (const secret of explicitSecrets) {
      if (secret && typeof secret === "string" && secret.trim().length >= 4) {
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        redacted = redacted.replace(new RegExp(escaped, "g"), "[REDACTED]");
      }
    }
  }

  // 2. Redact Bearer tokens: Bearer <token>
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9_\-\.]{6,}/gi, "Bearer [REDACTED]");

  // 3. Redact common header patterns: (authorization, x-api-key, x-goog-api-key, etc.)
  redacted = redacted.replace(
    /(?:x-api-key|x-goog-api-key|api-key|authorization)\s*:\s*[^\r\n,\s]+/gi,
    (match) => {
      const parts = match.split(":");
      return `${parts[0]}: [REDACTED]`;
    }
  );

  // 4. Redact URL query parameters: ?key=..., &token=..., etc.
  redacted = redacted.replace(
    /([?&](?:api[_-]?key|key|token|access[_-]?token|auth|password|secret)=)[^&\s]+/gi,
    "$1[REDACTED]"
  );

  // 5. Redact typical raw API key patterns (OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter)
  redacted = redacted.replace(/\b(?:sk-[a-zA-Z0-9_\-]{16,}|nvapi-[a-zA-Z0-9_\-]{16,}|AIza[a-zA-Z0-9_\-]{30,})\b/g, "[REDACTED]");

  return redacted;
}

/**
 * Parse Retry-After header as either integer seconds or HTTP-date.
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, 300); // clamp max wait to 5 minutes
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diffSec = Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
    return Math.min(diffSec, 300);
  }
  return undefined;
}

/**
 * Classify HTTP response errors into structured LLMProviderError.
 */
export function classifyHttpError(
  provider: string,
  status: number,
  bodyText: string,
  headers?: Headers,
  explicitSecrets?: (string | undefined)[]
): LLMProviderError {
  const sanitized = redactSecrets(bodyText, explicitSecrets).slice(0, 500).trim();
  const lowerBody = sanitized.toLowerCase();
  const retryAfter = parseRetryAfter(headers?.get("Retry-After"));

  // 401: Authentication failure (invalid API key)
  if (status === 401) {
    return new LLMProviderError({
      message: `${provider} authentication failed (401): invalid or expired API key. ${sanitized}`,
      code: "authentication_failed",
      provider,
      status,
      retryable: false,
    });
  }

  // 403: Forbidden / permission denied
  if (status === 403) {
    return new LLMProviderError({
      message: `${provider} access denied (403): insufficient permissions. ${sanitized}`,
      code: "permission_denied",
      provider,
      status,
      retryable: false,
    });
  }

  // 404: Not found (model or endpoint missing)
  if (status === 404) {
    return new LLMProviderError({
      message: `${provider} resource not found (404): model or endpoint does not exist. ${sanitized}`,
      code: "not_found",
      provider,
      status,
      retryable: false,
    });
  }

  // 400: Bad request / invalid parameters
  if (status === 400) {
    return new LLMProviderError({
      message: `${provider} bad request (400): ${sanitized}`,
      code: "invalid_request",
      provider,
      status,
      retryable: false,
    });
  }

  // 429: Rate limit vs Quota / Billing exhaustion
  if (status === 429) {
    const isQuotaExhausted =
      lowerBody.includes("insufficient_quota") ||
      lowerBody.includes("quota_exceeded") ||
      lowerBody.includes("credit_balance") ||
      lowerBody.includes("billing") ||
      lowerBody.includes("exceeded your current quota") ||
      lowerBody.includes("out of credits");

    if (isQuotaExhausted) {
      return new LLMProviderError({
        message: `${provider} quota or credit balance exhausted (429). ${sanitized}`,
        code: "quota_exhausted",
        provider,
        status,
        retryable: false,
      });
    }

    return new LLMProviderError({
      message: `${provider} rate limit exceeded (429). ${retryAfter ? `Retry after ${retryAfter}s. ` : ""}${sanitized}`,
      code: "rate_limit",
      provider,
      status,
      retryable: true,
      retryAfterSeconds: retryAfter,
    });
  }

  // 5xx: Server errors (transient)
  if (status >= 500 && status < 600) {
    return new LLMProviderError({
      message: `${provider} server error (${status}). ${sanitized}`,
      code: "server_error",
      provider,
      status,
      retryable: true,
      retryAfterSeconds: retryAfter,
    });
  }

  return new LLMProviderError({
    message: `${provider} request failed (${status}). ${sanitized}`,
    code: "unknown",
    provider,
    status,
    retryable: false,
  });
}

