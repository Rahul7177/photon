import type { TokenUsage } from "../../shared/types";
import type { LLMMessage } from "../llm/types";
import { estimateTokensForModel, TOKENS_PER_IMAGE } from "../adaptive/tokens";
import { sanitizeToolPairing } from "./errorRecovery";

export interface FitOptions {
  /** If true, the first user message (conversation anchor) is preserved. Defaults to false. */
  preserveFirstUser?: boolean;
  /** Tokens consumed by native tool schemas (e.g. via `estimateToolSchemasTokens`). */
  toolSchemasTokens?: number;
  /** Provider-specific chat template / special token overhead. Defaults to 8 tokens. */
  providerFramingTokens?: number;
  /** Tokens reserved for model completion output. Defaults to 1000 tokens. */
  reserveOutputTokens?: number;
  /** Model context window limit according to model architecture/spec (e.g. 128000). */
  modelCapacity?: number;
  /** Configured runtime context window (e.g. Ollama num_ctx or session window). */
  runtimeCapacity?: number;
  /** Max characters for intermediate tool outputs before structured clamping. Defaults to 2400. */
  maxIntermediateToolChars?: number;
}

export interface FitResult {
  messages: LLMMessage[];
  droppedCount: number;
  usage: TokenUsage;
}

/**
 * Estimate token count for an LLM wire message, accounting for role framing,
 * text content, thinking traces, multimodal images, and structured tool calls.
 */
export function tokensOf(msg: LLMMessage, model?: string): number {
  // Provider message framing (~4 tokens per message)
  let t = 4 + estimateTokensForModel(msg.content, model);

  if (msg.thinking) {
    t += estimateTokensForModel(msg.thinking, model);
  }

  // Account for multimodal images in LLMMessage (800 tokens each)
  if (msg.images && msg.images.length > 0) {
    t += msg.images.length * TOKENS_PER_IMAGE;
  }

  // Account for tool call ID and tool name framing
  if (msg.tool_call_id) {
    t += 4;
  }
  if (msg.name) {
    t += estimateTokensForModel(msg.name, model);
  }

  // Account for assistant tool calls
  for (const call of msg.tool_calls ?? []) {
    t += 4 + estimateTokensForModel(call.function.name, model);
    const argsStr =
      typeof call.function.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call.function.arguments ?? {});
    t += estimateTokensForModel(argsStr, model);
    if (call.thoughtSignature) {
      t += estimateTokensForModel(call.thoughtSignature, model);
    }
  }

  return t;
}

/**
 * Clamps a tool output string to `maxChars` without cutting structured payloads
 * (JSON arrays, JSON objects, line-delimited records, diffs) mid-record.
 */
export function clampStructuredToolResult(content: string, maxChars = 2400): string {
  if (!content || content.length <= maxChars) return content;

  const trimmed = content.trim();

  // 1. JSON array clamping: keep complete elements
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 1) {
        let keptCount = 0;
        for (let i = 0; i < parsed.length; i++) {
          const candidate = JSON.stringify(parsed.slice(0, i + 1), null, 2);
          if (candidate.length > maxChars && i > 0) break;
          keptCount = i + 1;
        }
        if (keptCount < parsed.length) {
          const omitted = parsed.length - keptCount;
          const keptItems = parsed.slice(0, keptCount);
          keptItems.push({
            _photon_truncated: `... [${omitted} records omitted to fit context window] ...`,
          });
          return JSON.stringify(keptItems, null, 2);
        }
      }
    } catch {
      // JSON parse failed, fall through to boundary clamping
    }
  }

  // 2. JSON object with array property clamping (e.g. results, items, files)
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, val] of Object.entries(parsed)) {
          if (Array.isArray(val) && val.length > 2) {
            let keptCount = 1;
            for (let i = 1; i < val.length; i++) {
              const testObj = { ...parsed, [key]: val.slice(0, i + 1) };
              if (JSON.stringify(testObj, null, 2).length > maxChars) break;
              keptCount = i + 1;
            }
            if (keptCount < val.length) {
              const omitted = val.length - keptCount;
              const copy = {
                ...parsed,
                [key]: [
                  ...val.slice(0, keptCount),
                  { _photon_truncated: `... [${omitted} items omitted to fit context window] ...` },
                ],
              };
              return JSON.stringify(copy, null, 2);
            }
          }
        }
      }
    } catch {
      // JSON parse failed, fall through to boundary clamping
    }
  }

  // 3. Line-based / record-based clamping (code, diffs, logs, tables, grep output)
  const reserveNotice = 120;
  const targetChars = maxChars - reserveNotice;

  // If the target is large enough, do head + tail to preserve initial context and final outcome
  if (targetChars >= 1000) {
    const headLimit = Math.floor(targetChars * 0.65);
    const tailLimit = Math.floor(targetChars * 0.35);

    let headCut = content.lastIndexOf("\n", headLimit);
    if (headCut < headLimit * 0.5) headCut = headLimit;

    let tailCut = content.indexOf("\n", content.length - tailLimit);
    if (tailCut === -1 || tailCut > content.length - tailLimit * 0.5) {
      tailCut = content.length - tailLimit;
    }

    if (headCut < tailCut) {
      const omitted = content.length - (headCut + (content.length - tailCut));
      const head = content.slice(0, headCut);
      const tail = content.slice(tailCut);
      return `${head}\n\n... [Output truncated to stay within context budget: ${omitted} characters omitted] ...\n\n${tail}`;
    }
  }

  // Otherwise, single cut at last newline before targetChars
  let cutPoint = content.lastIndexOf("\n", targetChars);
  if (cutPoint < targetChars * 0.5) {
    cutPoint = content.lastIndexOf(" ", targetChars);
    if (cutPoint < targetChars * 0.5) {
      cutPoint = targetChars;
    }
  }

  const omitted = content.length - cutPoint;
  const truncated = content.slice(0, cutPoint);
  if (trimmed.startsWith("[") && !truncated.endsWith("]")) {
    return `${truncated}\n  // ... [${omitted} characters omitted to stay within context budget]\n]`;
  } else if (trimmed.startsWith("{") && !truncated.endsWith("}")) {
    return `${truncated}\n  // ... [${omitted} characters omitted to stay within context budget]\n}`;
  }
  return `${truncated}\n\n... [Output truncated to stay within context budget: ${omitted} characters omitted] ...`;
}

/**
 * Fit a conversation into the model context window while strictly enforcing:
 * 1. System prompt is never removed.
 * 2. Active user request (the most recent user instruction) is never removed.
 * 3. Conversation anchor (first user message) is preserved when `preserveFirstUser` is enabled.
 * 4. Active trailing interaction and tool-call/result pairings are strictly preserved.
 * 5. Truncation priorities: clamp oversized intermediate tool results first, then trim
 *    oldest intermediate turns.
 * 6. Structured tool outputs are never cut mid-record.
 * 7. Model context capacity is distinguished from configured runtime capacity.
 */
export function fitToWindow(
  system: LLMMessage | string,
  history: LLMMessage[],
  budgetTokens: number,
  window: number,
  model?: string,
  preserveFirstUserOrOptions: boolean | FitOptions = false
): FitResult {
  const systemMsg: LLMMessage =
    typeof system === "string" ? { role: "system", content: system } : system;

  const options: FitOptions =
    typeof preserveFirstUserOrOptions === "boolean"
      ? { preserveFirstUser: preserveFirstUserOrOptions }
      : (preserveFirstUserOrOptions ?? {});

  const preserveFirstUser = options.preserveFirstUser ?? false;
  const toolSchemasTokens = Math.max(0, options.toolSchemasTokens ?? 0);
  const providerFramingTokens = Math.max(0, options.providerFramingTokens ?? 8);
  const reserveOutputTokens = Math.max(256, options.reserveOutputTokens ?? 1000);

  // Distinguish model context capacity from configured runtime capacity
  const modelCapacity =
    options.modelCapacity && options.modelCapacity > 0 ? options.modelCapacity : undefined;
  const runtimeCapacity =
    options.runtimeCapacity && options.runtimeCapacity > 0
      ? options.runtimeCapacity
      : window > 0
      ? window
      : modelCapacity ?? 8192;

  // Effective window is bounded by model context capacity if known
  const effectiveWindow = modelCapacity
    ? Math.min(modelCapacity, runtimeCapacity)
    : runtimeCapacity;

  // Effective budget for input messages
  let effectiveBudget =
    budgetTokens > 0 ? budgetTokens : Math.max(512, effectiveWindow - reserveOutputTokens);

  if (effectiveBudget > effectiveWindow - reserveOutputTokens) {
    effectiveBudget = Math.max(512, effectiveWindow - reserveOutputTokens);
  }

  const systemTokens = tokensOf(systemMsg, model);
  const overheadTokens = systemTokens + toolSchemasTokens + providerFramingTokens;
  const available = Math.max(0, effectiveBudget - overheadTokens);

  if (history.length === 0) {
    const usage: TokenUsage = {
      used: overheadTokens,
      window: effectiveWindow,
      breakdown: [
        { label: "System prompt", tokens: systemTokens },
        ...(toolSchemasTokens > 0 ? [{ label: "Tool schemas", tokens: toolSchemasTokens }] : []),
        ...(providerFramingTokens > 0
          ? [{ label: "Provider framing", tokens: providerFramingTokens }]
          : []),
      ],
    };
    return { messages: [systemMsg], droppedCount: 0, usage };
  }

  // Clone history to avoid mutating caller objects
  const working: LLMMessage[] = history.map((m) => ({
    ...m,
    tool_calls: m.tool_calls
      ? m.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function } }))
      : undefined,
  }));

  const firstUserIndex = working.findIndex((m) => m.role === "user");
  let activeUserIndex = -1;
  for (let i = working.length - 1; i >= 0; i--) {
    if (working[i].role === "user") {
      activeUserIndex = i;
      break;
    }
  }
  const newestIndex = working.length - 1;

  // Priority 1: Clamp oversized intermediate tool results (both native role:"tool" and photon-block <tool_result> wrappers)
  let currentConvTokens = working.reduce((s, m) => s + tokensOf(m, model), 0);
  const maxChars = options.maxIntermediateToolChars ?? 2400;

  if (currentConvTokens > available) {
    for (let i = 0; i < working.length; i++) {
      const m = working[i];
      if (isToolOutputMessage(m)) {
        const isOldTurn = activeUserIndex >= 0 && i < activeUserIndex;
        const threshold = isOldTurn ? maxChars : maxChars * 2;
        if (m.content.length > threshold) {
          m.content = clampStructuredToolResult(m.content, threshold);
        }
      }
    }
    currentConvTokens = working.reduce((s, m) => s + tokensOf(m, model), 0);
  }

  // Priority 2: Trim oldest intermediate conversational turns if still exceeding budget
  const protectedIndices = new Set<number>();
  protectedIndices.add(newestIndex);
  if (activeUserIndex >= 0) protectedIndices.add(activeUserIndex);
  if (preserveFirstUser && firstUserIndex >= 0) protectedIndices.add(firstUserIndex);

  // Protect trailing active turn messages (active assistant tool calls and trailing tool responses)
  for (let i = working.length - 1; i >= Math.max(0, activeUserIndex); i--) {
    if (isToolOutputMessage(working[i]) || working[i].tool_calls) {
      protectedIndices.add(i);
    } else if (i !== newestIndex && working[i].role === "user") {
      break;
    }
  }

  let droppedCount = 0;
  const keptMap = new Map<number, LLMMessage>();
  for (let i = 0; i < working.length; i++) {
    keptMap.set(i, working[i]);
  }

  if (currentConvTokens > available) {
    for (let i = 0; i < working.length; i++) {
      if (currentConvTokens <= available) break;
      if (protectedIndices.has(i)) continue;

      const msg = keptMap.get(i);
      if (msg) {
        const t = tokensOf(msg, model);
        keptMap.delete(i);
        currentConvTokens -= t;
        droppedCount++;
      }
    }
  }

  // Priority 3: If still exceeding available after dropping all unprotected turns,
  // clamp large protected tool outputs
  if (currentConvTokens > available) {
    for (const [, msg] of keptMap.entries()) {
      if (currentConvTokens <= available) break;
      if (isToolOutputMessage(msg) && msg.content.length > 800) {
        const oldT = tokensOf(msg, model);
        msg.content = clampStructuredToolResult(msg.content, 800);
        const newT = tokensOf(msg, model);
        currentConvTokens -= oldT - newT;
      }
    }
  }

  const rawKept = [...keptMap.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  const sanitizedMessages = sanitizeToolPairing(rawKept);

  const convTokens = sanitizedMessages.reduce((sum, m) => sum + tokensOf(m, model), 0);
  const totalUsed = overheadTokens + convTokens;
  const breakdown = [
    { label: "System prompt", tokens: systemTokens },
    ...(toolSchemasTokens > 0 ? [{ label: "Tool schemas", tokens: toolSchemasTokens }] : []),
    ...(providerFramingTokens > 0
      ? [{ label: "Provider framing", tokens: providerFramingTokens }]
      : []),
    { label: "Conversation", tokens: convTokens },
  ];

  const usage: TokenUsage = {
    used: totalUsed,
    window: effectiveWindow,
    breakdown,
  };

  return {
    messages: [systemMsg, ...sanitizedMessages],
    droppedCount,
    usage,
  };
}

function isToolOutputMessage(m: LLMMessage): boolean {
  if (m.role === "tool") return true;
  if (m.role !== "user") return false;
  const trimmed = (m.content ?? "").trimStart();
  return (
    trimmed.startsWith("<tool_result") ||
    trimmed.startsWith("<photon:result") ||
    trimmed.startsWith("[TOOL_RESULT") ||
    trimmed.startsWith("[tool:")
  );
}
