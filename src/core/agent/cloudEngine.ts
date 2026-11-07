import { randomUUID } from "node:crypto";
import type { ChatMessage, ToolCall, TokenUsage } from "../../shared/types";
import type { LLMMessage, LLMProvider } from "../llm/types";
import { toNativeTools } from "../protocol/serialize";
import { estimateTokens } from "../adaptive/tokens";
import { clamp } from "../tools/types";
import type { Tool, ToolContext } from "../tools/types";
import { classifyRuntimeError, formatNativeToolOutcome, sanitizeToolPairing } from "./errorRecovery";

/**
 * CLOUD ENGINE — token-economical native tool-calling loop for frontier cloud models.
 *
 * Key optimizations for cloud APIs:
 *  - Mode & intent-pruned native tool schemas (0 schemas on greetings, read-only on Chat/Plan).
 *  - Automatic deduplication of repeated `read_file` results and compaction of stale
 *    tool outputs from older turns to prevent quadratic token bloat.
 *  - Parallel execution of read-only tool calls emitted in the same turn so the model
 *    can inspect multiple files in 1 round-trip instead of N round-trips.
 *  - Transparent tool normalization & aliasing so standard industry names (edit_file,
 *    str_replace_editor, bash, write_file, etc.) map directly without error round-trips.
 *  - Unhindered native reasoning: frontier models deliver final outputs or ask questions
 *    directly in Markdown without being forced into pseudo-tool ceremony turns.
 *  - Exact provider token accounting (input, output, cached, and saved tokens).
 */

const MAX_STEPS = 200;
/** Fraction of the model's context window reserved for its output. */
const OUTPUT_RESERVE = 0.25;
/** Cap on a single tool result fed back into the conversation (~5,000 tokens). */
const MAX_TOOL_RESULT_CHARS = 20_000;
/** Full cloud tool count baseline used to measure schema-pruning token savings. */
const FULL_CLOUD_TOOL_COUNT = 11;
const TOKENS_PER_TOOL_SCHEMA = 180;

const MAX_EMPTY_RETRIES = 2;
const MAX_STREAM_RETRIES = 1;
const MAX_CONTINUATIONS = 3;
const MAX_OUTPUT_CHARS = 200_000;

export interface CloudEmitter {
  onAssistantStart(messageId: string): void;
  onDelta(messageId: string, delta: string): void;
  onThinkingDelta?(messageId: string, delta: string): void;
  onThinkingEnd?(messageId: string, elapsedMs: number): void;
  onContent(messageId: string, content: string): void;
  onAssistantCancel(messageId: string): void;
  onToolCall(messageId: string, call: ToolCall): void;
  onToolUpdate(messageId: string, call: ToolCall): void;
  onPhase(phase: "thinking" | "working", detail?: string): void;
  onUsage(usage: TokenUsage): void;
  onGenerationStats(stats: import("../../shared/types").GenerationStats | null): void;
  onDone(messageId: string, notice?: string): void;
  onError(message: string): void;
}

export interface CloudStepUsageEvent {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  savedTokens: number;
}

export interface CloudTurnInput {
  provider: LLMProvider;
  model: string;
  system: string;
  history: LLMMessage[];
  tools: Tool[];
  contextWindow: number;
  ctx: ToolContext;
  emitter: CloudEmitter;
  signal: AbortSignal;
  onStepUsage?: (usage: CloudStepUsageEvent) => void;
}

export interface PendingCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

/**
 * Normalizes tool calls emitted by frontier cloud models.
 * High-end models (Claude, GPT, Gemini) may emit standard industry tool names
 * (e.g. edit_file, str_replace_editor, bash, write_file, list_dir, search_code)
 * or alternative argument spellings (file_path instead of path, old_str instead of find, cmd instead of command).
 * This transparently aliases them to Photon's tool suite so models operate at peak speed
 * with zero error round-trips.
 */
export function normalizeCloudToolCall(call: PendingCall, _availableTools?: Tool[]): PendingCall {
  const name = call.name.trim();
  const args = { ...call.args };

  // If the tool is already an exact match, normalize common argument variations
  if (name === "replace_in_file") {
    if (!args.find && (args.old_str || args.old_string || args.target || args.search)) {
      args.find = args.old_str ?? args.old_string ?? args.target ?? args.search;
    }
    if (args.replace === undefined && (args.new_str !== undefined || args.new_string !== undefined || args.replacement !== undefined)) {
      args.replace = args.new_str ?? args.new_string ?? args.replacement;
    }
    if (!args.path && (args.file_path || args.filePath || args.file)) {
      args.path = args.file_path ?? args.filePath ?? args.file;
    }
    return { ...call, args };
  }

  if (name === "write_to_file") {
    if (!args.path && (args.file_path || args.filePath || args.file)) {
      args.path = args.file_path ?? args.filePath ?? args.file;
    }
    if (args.content === undefined && (args.contents !== undefined || args.text !== undefined || args.file_text !== undefined)) {
      args.content = args.contents ?? args.text ?? args.file_text;
    }
    return { ...call, args };
  }

  if (name === "read_file") {
    if (!args.path && (args.file_path || args.filePath || args.file)) {
      args.path = args.file_path ?? args.filePath ?? args.file;
    }
    if (args.start_line === undefined && (args.startLine !== undefined || args.line_start !== undefined || args.from_line !== undefined)) {
      args.start_line = args.startLine ?? args.line_start ?? args.from_line;
    }
    if (args.end_line === undefined && (args.endLine !== undefined || args.line_end !== undefined || args.to_line !== undefined)) {
      args.end_line = args.endLine ?? args.line_end ?? args.to_line;
    }
    return { ...call, args };
  }

  if (name === "execute_command") {
    if (!args.command && (args.cmd || args.script)) {
      args.command = args.cmd ?? args.script;
    }
    if (args.timeout_ms === undefined && (args.timeoutMs !== undefined || args.timeout !== undefined)) {
      args.timeout_ms = args.timeoutMs ?? args.timeout;
    }
    return { ...call, args };
  }

  if (name === "search_files") {
    if (!args.query && (args.pattern || args.regex || args.text)) {
      args.query = args.pattern ?? args.regex ?? args.text;
    }
    return { ...call, args };
  }

  if (name === "find_files") {
    if (!args.pattern && (args.glob || args.query || args.name)) {
      args.pattern = args.glob ?? args.query ?? args.name;
    }
    return { ...call, args };
  }

  // Common aliases for frontier cloud models:
  // 1. File editing
  if (
    name === "edit_file" ||
    name === "str_replace_editor" ||
    name === "editFile" ||
    name === "patch_file" ||
    name === "replace_file_content"
  ) {
    const hasFind = !!(args.find || args.old_str || args.old_string || args.target || args.search);
    const filePath = (args.path ?? args.file_path ?? args.filePath ?? args.file) as string;
    if (hasFind || (!args.content && !args.contents)) {
      return {
        ...call,
        name: "replace_in_file",
        args: {
          path: filePath,
          find: args.find ?? args.old_str ?? args.old_string ?? args.target ?? args.search,
          replace: args.replace ?? args.new_str ?? args.new_string ?? args.replacement ?? "",
          ...(args.replace_all !== undefined || args.replaceAll !== undefined
            ? { replace_all: args.replace_all ?? args.replaceAll }
            : {}),
        },
      };
    } else {
      return {
        ...call,
        name: "write_to_file",
        args: {
          path: filePath,
          content: args.content ?? args.contents ?? args.text ?? "",
        },
      };
    }
  }

  // 2. Full file creation or overwriting
  if (name === "write_file" || name === "create_file" || name === "writeFile" || name === "save_file") {
    return {
      ...call,
      name: "write_to_file",
      args: {
        path: args.path ?? args.file_path ?? args.filePath ?? args.file,
        content: args.content ?? args.contents ?? args.text ?? args.file_text ?? "",
      },
    };
  }

  // 3. Reading files
  if (name === "view" || name === "cat" || name === "readFile" || name === "show_file" || name === "open_file") {
    return {
      ...call,
      name: "read_file",
      args: {
        path: args.path ?? args.file_path ?? args.filePath ?? args.file,
        ...(args.start_line !== undefined || args.startLine !== undefined || args.line_start !== undefined
          ? { start_line: args.start_line ?? args.startLine ?? args.line_start }
          : {}),
        ...(args.end_line !== undefined || args.endLine !== undefined || args.line_end !== undefined
          ? { end_line: args.end_line ?? args.endLine ?? args.line_end }
          : {}),
      },
    };
  }

  // 4. Running commands / terminal
  if (
    name === "bash" ||
    name === "run_command" ||
    name === "execute_bash" ||
    name === "terminal" ||
    name === "sh" ||
    name === "shell" ||
    name === "exec_command"
  ) {
    return {
      ...call,
      name: "execute_command",
      args: {
        command: args.command ?? args.cmd ?? args.script ?? "",
        ...(args.timeout_ms !== undefined || args.timeoutMs !== undefined || args.timeout !== undefined
          ? { timeout_ms: args.timeout_ms ?? args.timeoutMs ?? args.timeout }
          : {}),
      },
    };
  }

  // 5. Listing files / directories
  if (name === "list_dir" || name === "listFiles" || name === "list_directory" || name === "ls" || name === "dir") {
    return {
      ...call,
      name: "list_files",
      args: {
        path: args.path ?? args.dir ?? args.directory ?? args.folder,
        ...(args.recursive !== undefined ? { recursive: args.recursive } : {}),
      },
    };
  }

  // 6. Searching file contents
  if (name === "search_code" || name === "grep" || name === "search" || name === "ripgrep" || name === "searchFiles") {
    return {
      ...call,
      name: "search_files",
      args: {
        query: args.query ?? args.pattern ?? args.regex ?? args.text ?? "",
        path: args.path ?? args.dir,
        include: args.include ?? args.filter,
        is_regex: args.is_regex ?? args.regex,
      },
    };
  }

  // 7. Finding files by pattern
  if (name === "find_files" || name === "findFiles" || name === "glob" || name === "locate_file") {
    return {
      ...call,
      name: "find_files",
      args: {
        pattern: args.pattern ?? args.glob ?? args.query ?? args.name ?? "",
        path: args.path ?? args.dir,
      },
    };
  }

  // 8. Diagnostics
  if (name === "diagnostics" || name === "getDiagnostics" || name === "get_errors" || name === "check_errors") {
    return {
      ...call,
      name: "get_diagnostics",
      args: {
        path: args.path ?? args.file_path ?? args.filePath,
      },
    };
  }

  return call;
}

function isLengthCutoff(reason: string | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r === "length" || r === "max_tokens" || r === "maxoutputtokens";
}

function hasUnclosedFence(text: string): boolean {
  const fences = text.match(/```/g);
  return !!fences && fences.length % 2 === 1;
}

/**
 * Deduplicate repeated `read_file` tool outputs and compact large tool outputs
 * from older turns (>1 user turn ago) to prevent cloud token price surges.
 */
function compactCloudHistory(history: LLMMessage[]): {
  compacted: LLMMessage[];
  savedTokens: number;
} {
  const out: LLMMessage[] = history.map((m) => ({ ...m }));
  let savedChars = 0;

  // 1. Map tool_call_id -> read_file key ("path:start:end")
  const callIdToReadKey = new Map<string, string>();
  for (const m of out) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function.name === "read_file") {
          const p = String(tc.function.arguments?.path ?? "").trim();
          const s = tc.function.arguments?.start_line ?? "";
          const e = tc.function.arguments?.end_line ?? "";
          if (p) callIdToReadKey.set(tc.id, `${p}:${s}:${e}`);
        }
      }
    }
  }

  // Find the LAST index for each read_file key so earlier identical reads can be stubbed
  const latestReadIdxByKey = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role === "tool" && m.tool_call_id) {
      const key = callIdToReadKey.get(m.tool_call_id);
      if (key && m.content.length > 300) {
        latestReadIdxByKey.set(key, i);
      }
    }
  }

  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role === "tool" && m.tool_call_id) {
      const key = callIdToReadKey.get(m.tool_call_id);
      if (key && latestReadIdxByKey.get(key) !== undefined && latestReadIdxByKey.get(key)! > i) {
        const filePath = key.split(":")[0];
        const stub = `[Earlier read_file("${filePath}") superseded by newer read below — omitted to save tokens.]`;
        if (m.content.length > stub.length) {
          savedChars += m.content.length - stub.length;
          m.content = stub;
        }
      }
    }
  }

  // 2. Find the start of the 3rd-most-recent user turn so the current and last 2 user turns stay 100% intact
  let userCount = 0;
  let cutoffIdx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      userCount++;
      if (userCount === 3) {
        cutoffIdx = i;
        break;
      }
    }
  }

  // Compact oversized tool outputs from 3+ turns ago (before cutoffIdx)
  if (cutoffIdx > 0) {
    const OLD_TOOL_MAX = 2400;
    for (let i = 0; i < cutoffIdx; i++) {
      const m = out[i];
      if (m.role === "tool" && m.content.length > OLD_TOOL_MAX) {
        const head = m.content.slice(0, 1400);
        const tail = m.content.slice(-600);
        const compactedText = `${head}\n\n… [Compacted ${m.content.length - 2000} chars from earlier turn to save cloud tokens] …\n\n${tail}`;
        savedChars += m.content.length - compactedText.length;
        m.content = compactedText;
      }
    }
  }

  return {
    compacted: out,
    savedTokens: Math.max(0, Math.ceil(savedChars / 4)),
  };
}

/** Run one cloud turn to completion. */
export async function runCloudTurn(input: CloudTurnInput): Promise<void> {
  const { provider, model, system, tools, contextWindow, ctx, emitter, signal, onStepUsage } = input;
  const nativeTools = tools.length > 0 ? toNativeTools(tools.map((t) => t.spec)) : undefined;
  const history = [...input.history];
  const systemTokens = estimateTokens(system);
  const schemaSavedTokens = Math.max(0, (FULL_CLOUD_TOOL_COUNT - tools.length) * TOKENS_PER_TOOL_SCHEMA);

  let emptyStreak = 0;
  let streamRetries = 0;
  let continuations = 0;
  let toolsRun = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return;

    const { compacted, savedTokens: compactionSavedTokens } = compactCloudHistory(history);
    const messages = fitToWindow(system, compacted, contextWindow, model);

    const historyTokens = messages.slice(1).reduce((sum, m) => sum + estimateTokens(m.content) + 8, 0);
    emitter.onUsage({
      used: systemTokens + historyTokens,
      window: contextWindow,
      breakdown: [
        { label: "System", tokens: systemTokens },
        { label: "Conversation", tokens: historyTokens },
      ],
    });

    const assistantId = randomUUID();
    emitter.onAssistantStart(assistantId);
    emitter.onPhase("thinking");
    const genStart = Date.now();
    let accChars = 0;
    let lastEmit = 0;
    let thinkingStart = 0;
    let thinkingDoneEmitted = false;
    let exactPromptTokens = 0;
    let exactOutputTokens = 0;
    let exactCachedTokens = 0;

    const emitStats = (forcing = false) => {
      const now = Date.now();
      if (!forcing && now - lastEmit < 250) return;
      lastEmit = now;
      const elapsedMs = Math.max(1, now - genStart);
      const totalTokens = exactOutputTokens > 0 ? exactOutputTokens : Math.ceil(accChars / 4);
      const tps = Math.round((totalTokens / elapsedMs) * 1000);
      emitter.onGenerationStats({ tps, totalTokens, elapsedMs });
    };

    let content = "";
    const calls: PendingCall[] = [];
    let streamError: unknown = null;
    let doneReason: string | undefined;
    try {
      for await (const chunk of provider.chatStream(
        { model, messages, ...(nativeTools ? { tools: nativeTools } : {}) },
        signal
      )) {
        if (chunk.message?.thinking) {
          if (!thinkingStart) thinkingStart = Date.now();
          emitter.onThinkingDelta?.(assistantId, chunk.message.thinking);
        }
        if (chunk.message?.content) {
          if (thinkingStart && !thinkingDoneEmitted) {
            thinkingDoneEmitted = true;
            emitter.onThinkingEnd?.(assistantId, Math.max(1, Date.now() - thinkingStart));
          }
          content += chunk.message.content;
          accChars += chunk.message.content.length;
          emitter.onDelta(assistantId, chunk.message.content);
          emitStats();
        }
        for (const tc of chunk.message?.tool_calls ?? []) {
          if (thinkingStart && !thinkingDoneEmitted) {
            thinkingDoneEmitted = true;
            emitter.onThinkingEnd?.(assistantId, Math.max(1, Date.now() - thinkingStart));
          }
          calls.push({
            id: tc.id ?? randomUUID(),
            name: tc.function.name,
            args: tc.function.arguments ?? {},
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          });
        }
        if (chunk.done_reason) doneReason = chunk.done_reason;
        if (typeof chunk.prompt_eval_count === "number" && chunk.prompt_eval_count > 0) {
          exactPromptTokens = chunk.prompt_eval_count;
        }
        if (typeof chunk.eval_count === "number" && chunk.eval_count > 0) {
          exactOutputTokens = chunk.eval_count;
        }
        if (typeof chunk.cached_tokens === "number" && chunk.cached_tokens > 0) {
          exactCachedTokens = chunk.cached_tokens;
        }
        if (content.length > MAX_OUTPUT_CHARS) {
          streamError = new Error("Model produced excessively long output — likely stuck in a loop.");
          break;
        }
      }
    } catch (e) {
      streamError = e;
    }
    if (thinkingStart && !thinkingDoneEmitted) {
      thinkingDoneEmitted = true;
      emitter.onThinkingEnd?.(assistantId, Math.max(1, Date.now() - thinkingStart));
    }
    emitStats(true);

    // Record step token usage (exact provider usage when available, else estimated)
    const stepInputTokens = exactPromptTokens > 0 ? exactPromptTokens : systemTokens + historyTokens;
    const stepOutputTokens = exactOutputTokens > 0 ? exactOutputTokens : Math.ceil(accChars / 4);
    if (exactPromptTokens > 0 || exactOutputTokens > 0) {
      emitter.onUsage({
        used: stepInputTokens + stepOutputTokens,
        window: contextWindow,
        breakdown: [
          { label: "Prompt (input)", tokens: stepInputTokens },
          { label: "Completion (output)", tokens: stepOutputTokens },
          ...(exactCachedTokens > 0 ? [{ label: "Cached input", tokens: exactCachedTokens }] : []),
        ],
      });
    }
    if (stepInputTokens > 0 || stepOutputTokens > 0) {
      onStepUsage?.({
        model,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        cachedTokens: exactCachedTokens,
        savedTokens: schemaSavedTokens + compactionSavedTokens + exactCachedTokens,
      });
    }

    if (signal.aborted) {
      emitter.onGenerationStats(null);
      emitter.onDone(
        assistantId,
        !content.trim() && calls.length === 0 ? "Stopped before the model replied." : "Stopped."
      );
      return;
    }
    if (streamError) {
      const classified = classifyRuntimeError(streamError, signal);
      if (classified.category === "cancelled" || signal.aborted) {
        emitter.onGenerationStats(null);
        emitter.onDone(
          assistantId,
          !content.trim() && calls.length === 0 ? "Stopped before the model replied." : "Stopped."
        );
        return;
      }
      if (
        classified.retryable &&
        streamRetries < MAX_STREAM_RETRIES &&
        !content.trim() &&
        calls.length === 0
      ) {
        streamRetries++;
        ctx.log(`[cloud] transient ${classified.category} error (${classified.rawMessage}) — retrying (${streamRetries}/${MAX_STREAM_RETRIES}).`);
        emitter.onAssistantCancel(assistantId);
        step--;
        continue;
      }
      emitter.onGenerationStats(null);
      emitter.onError(classified.userMessage);
      emitter.onDone(assistantId);
      return;
    }

    if (calls.length === 0 && !content.trim()) {
      emptyStreak++;
      emitter.onAssistantCancel(assistantId);
      if (emptyStreak <= MAX_EMPTY_RETRIES) {
        ctx.log(`[cloud] empty generation ${emptyStreak}/${MAX_EMPTY_RETRIES} — nudging.`);
        history.push({
          role: "user",
          content:
            "Your previous reply arrived empty. Continue the task from the tool results above: call the next tool if steps remain, or reply with your final answer. Do not repeat tool calls you already made.",
        });
        continue;
      }
      emitter.onError(
        "The model returned an empty response several times and stopped. Try a different model or try again later."
      );
      emitter.onGenerationStats(null);
      return;
    }
    emptyStreak = 0;

    if (calls.length === 0) {
      const cutOff =
        isLengthCutoff(doneReason) ||
        hasUnclosedFence(content) ||
        (!doneReason && toolsRun > 0);
      if (cutOff && continuations < MAX_CONTINUATIONS) {
        continuations++;
        emitter.onDone(assistantId);
        ctx.log(
          `[cloud] output cut off (reason: ${doneReason ?? "none"}, ${content.length} chars) — asking model to continue (${continuations}/${MAX_CONTINUATIONS}).`
        );
        history.push({
          role: "user",
          content:
            "Your reply was cut off mid-output. Continue EXACTLY where you stopped — do not repeat earlier content. If you were writing a file, continue from the next line.",
        });
        continue;
      }

      // High-end cloud models deliver their conversational answers, explanations, or questions
      // directly in Markdown without requiring artificial narration interruptions or pseudo-tools.
      emitter.onGenerationStats(null);
      emitter.onDone(assistantId);
      return;
    }

    const normalizedCalls = calls.map((c) => normalizeCloudToolCall(c, tools));

    history.push({
      role: "assistant",
      content,
      tool_calls: normalizedCalls.map((c) => ({
        id: c.id,
        function: { name: c.name, arguments: c.args },
        ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
      })),
    });

    let completion: string | null = null;
    let followup: string | null = null;

    // Separate lifecycle calls (for legacy/external models) from executable tool calls
    const executableCalls: { pending: PendingCall; tool?: Tool; callObj: ToolCall }[] = [];
    for (const c of normalizedCalls) {
      if (c.name === "attempt_completion") {
        completion = typeof c.args.result === "string" ? c.args.result : "";
        continue;
      }
      if (c.name === "ask_followup_question") {
        followup = typeof c.args.question === "string" ? c.args.question : "I have a question.";
        continue;
      }
      const tool = tools.find((t) => t.spec.name === c.name);
      const callObj: ToolCall = {
        id: c.id,
        name: c.name,
        args: c.args,
        status: "proposed",
        sideEffecting: tool?.spec.sideEffecting ?? false,
        ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
      };
      emitter.onToolCall(assistantId, callObj);
      executableCalls.push({ pending: c, tool, callObj });
    }

    // Can we run all executable calls in parallel? Yes if all of them are read-only!
    const allReadOnly =
      executableCalls.length > 1 &&
      executableCalls.every((ec) => ec.tool && !ec.tool.spec.sideEffecting);

    const runOneCall = async (ec: { pending: PendingCall; tool?: Tool; callObj: ToolCall }) => {
      const { pending: c, tool, callObj } = ec;
      emitter.onPhase("working", c.name);
      emitter.onToolUpdate(assistantId, { ...callObj, status: "running" });
      let output: string;
      let okResult: boolean;
      if (!tool) {
        output = `Unknown tool "${c.name}". Available: ${tools.map((t) => t.spec.name).join(", ")}.`;
        okResult = false;
      } else {
        try {
          const r = await tool.execute(c.args, { ...ctx, pendingCallId: c.id });
          output = r.output;
          okResult = r.ok;
        } catch (e) {
          output = (e as Error).message;
          okResult = false;
        }
      }
      toolsRun++;
      emitter.onToolUpdate(assistantId, {
        ...callObj,
        status: okResult ? "done" : "error",
        result: okResult ? output : undefined,
        error: okResult ? undefined : output,
      });
      return {
        role: "tool" as const,
        tool_call_id: c.id,
        name: c.name,
        content: formatNativeToolOutcome(c.name, clamp(output, MAX_TOOL_RESULT_CHARS), okResult),
      };
    };

    if (allReadOnly) {
      const results = await Promise.all(executableCalls.map(runOneCall));
      for (const r of results) history.push(r);
    } else {
      for (const ec of executableCalls) {
        if (signal.aborted) {
          emitter.onDone(assistantId, "Stopped.");
          return;
        }
        const r = await runOneCall(ec);
        history.push(r);
      }
    }

    if (completion !== null) {
      emitter.onGenerationStats(null);
      emitter.onContent(assistantId, completion);
      emitter.onDone(assistantId);
      return;
    }
    if (followup !== null) {
      emitter.onGenerationStats(null);
      emitter.onContent(assistantId, followup);
      emitter.onDone(assistantId);
      return;
    }

    emitter.onDone(assistantId);
  }

  if (!signal.aborted) {
    emitter.onGenerationStats(null);
    emitter.onError(
      `Reached the ${MAX_STEPS}-step safety limit in cloud mode. Ask me to continue if more work is needed.`
    );
  }
}

function fitToWindow(system: string, history: LLMMessage[], window: number, _model?: string): LLMMessage[] {
  const budget =
    Math.max(2048, Math.floor(window * (1 - OUTPUT_RESERVE))) - estimateTokens(system);
  const tokens = history.map((m) => {
    let t = estimateTokens(m.content) + 8;
    for (const tc of m.tool_calls ?? []) {
      t += estimateTokens(tc.function.name) + estimateTokens(JSON.stringify(tc.function.arguments));
    }
    if (m.tool_call_id) t += 4;
    if (m.name) t += estimateTokens(m.name);
    return t;
  });
  let total = tokens.reduce((s, t) => s + t, 0);
  if (total <= budget) return [systemMsg(system), ...history];
  const keepFirst = history.length > 0 && history[0].role === "user" ? 1 : 0;
  let cut = keepFirst;
  while (total > budget && cut < history.length) {
    let k = cut;
    while (k < history.length && history[k].role !== "user") {
      total -= tokens[k];
      k++;
    }
    if (k >= history.length) break;
    if (k === 0 && keepFirst) {
      k = 1;
      while (k < history.length && history[k].role !== "user") {
        total -= tokens[k];
        k++;
      }
      if (k >= history.length) break;
    }
    cut = k;
    if (total <= budget) break;
    total -= tokens[cut];
    cut++;
    if (keepFirst && cut === 1) cut = 2;
  }
  const rawFitted = keepFirst
    ? [systemMsg(system), history[0], ...history.slice(Math.max(cut, 1))]
    : [systemMsg(system), ...history.slice(cut)];
  return sanitizeToolPairing(rawFitted);
}

function systemMsg(content: string): LLMMessage {
  return { role: "system", content };
}

export function cloudHistoryFromSession(messages: ChatMessage[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const docs = (m.attachments ?? []).filter((a) => a.kind === "text" && a.text);
      let content = m.content;
      for (const d of docs) {
        content += `\n\n--- Attached file: ${d.name} ---\n${d.text}\n--- end ${d.name} ---`;
      }
      const msg: LLMMessage = { role: "user", content };
      const images = (m.attachments ?? [])
        .filter((a) => a.kind === "image" && a.dataBase64)
        .map((a) => a.dataBase64 as string);
      if (images.length) msg.images = images;
      out.push(msg);
    } else if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      if (calls.length) {
        out.push({
          role: "assistant",
          content: m.content,
          tool_calls: calls.map((c) => ({
            id: c.id,
            function: { name: c.name, arguments: c.args },
            ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
          })),
        });
        for (const c of calls) {
          const outcome =
            c.result !== undefined
              ? c.result
              : c.error !== undefined
              ? c.error
              : c.status === "denied"
              ? "Tool execution declined by user."
              : "Tool execution was cancelled.";
          out.push({
            role: "tool",
            tool_call_id: c.id,
            name: c.name,
            content: outcome,
          });
        }
      } else if (m.content.trim()) {
        out.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool") {
      out.push({ role: "tool", content: m.content, tool_call_id: (m as any).toolCallId, name: (m as any).name });
    }
  }
  return sanitizeToolPairing(out);
}
