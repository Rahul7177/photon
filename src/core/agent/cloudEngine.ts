import { randomUUID } from "node:crypto";
import type { ChatMessage, ToolCall, TokenUsage } from "../../shared/types";
import type { LLMMessage, LLMProvider } from "../llm/types";
import { toNativeTools } from "../protocol/serialize";
import { estimateTokens } from "../adaptive/tokens";
import { clamp } from "../tools/types";
import type { Tool, ToolContext } from "../tools/types";

/**
 * CLOUD ENGINE — a turn loop completely independent of the local (Ollama)
 * AgentEngine. Designed for frontier models with native tool calling:
 *
 *  - Tools go over the wire in each provider's NATIVE format; the model's own
 *    tool-calling ability drives the loop (no block-protocol parsing to fail).
 *  - No adaptive limits: no intelligence tiers, no tool-count caps, no
 *    anti-"repeat" guards, no output clamps beyond what the provider itself
 *    enforces. The model decides when it's done — via attempt_completion or by
 *    replying without tool calls.
 *  - Context is the model's own window: history is only trimmed (at message
 *    boundaries that keep tool-call/result pairs intact) when it would
 *    overflow, reserving headroom for output.
 *  - A very high step ceiling exists purely as a runaway safety net.
 */

const MAX_STEPS = 200;
/** Fraction of the model's context window reserved for its output. */
const OUTPUT_RESERVE = 0.25;
/** Cap on a single tool result fed back into the conversation. */
const MAX_TOOL_RESULT_CHARS = 30_000;

/** Consecutive empty generations tolerated before giving up. */
const MAX_EMPTY_RETRIES = 2;
/** Mid-stream transport failures retried once per turn. */
const MAX_STREAM_RETRIES = 1;
/** Continuations when output is CUT OFF mid-stream. */
const MAX_CONTINUATIONS = 3;
/** Bounded nudges for prose-only replies that signal intent to continue. */
const MAX_CONTINUE_NUDGES = 2;
/** Absolute safety ceiling on a single streamed reply (~50k tokens). */
const MAX_OUTPUT_CHARS = 200_000;

/** Events the cloud engine emits (a subset of the host's TurnEmitter). */
export interface CloudEmitter {
  onAssistantStart(messageId: string): void;
  onDelta(messageId: string, delta: string): void;
  /** Replace a bubble's content (used for attempt_completion's final result). */
  onContent(messageId: string, content: string): void;
  /** Cancel an empty/failed assistant bubble so it's removed from the UI. */
  onAssistantCancel(messageId: string): void;
  onToolCall(messageId: string, call: ToolCall): void;
  onToolUpdate(messageId: string, call: ToolCall): void;
  onPhase(phase: "thinking" | "working", detail?: string): void;
  /** Token usage for the context meter. */
  onUsage(usage: TokenUsage): void;
  onGenerationStats(stats: import("../../shared/types").GenerationStats | null): void;
  onDone(messageId: string, notice?: string): void;
  onError(message: string): void;
}

export interface CloudTurnInput {
  /** The provider manager (routes by model prefix and strips it per API). */
  provider: LLMProvider;
  /** Prefixed model name, e.g. "openrouter:anthropic/claude-...". */
  model: string;
  system: string;
  history: LLMMessage[];
  tools: Tool[];
  /** The model's advertised context window (tokens). */
  contextWindow: number;
  ctx: ToolContext;
  emitter: CloudEmitter;
  signal: AbortSignal;
}

interface PendingCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** True when a generation ended because it hit an output-token cap. */
function isLengthCutoff(reason: string | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r === "length" || r === "max_tokens" || r === "maxoutputtokens";
}

/** An odd number of ``` fences means the reply stopped inside a code block. */
function hasUnclosedFence(text: string): boolean {
  const fences = text.match(/```/g);
  return !!fences && fences.length % 2 === 1;
}

/** Run one cloud turn to completion. */
export async function runCloudTurn(input: CloudTurnInput): Promise<void> {
  const { provider, model, system, tools, contextWindow, ctx, emitter, signal } = input;
  const nativeTools = toNativeTools(tools.map((t) => t.spec));
  const history = [...input.history];
  const systemTokens = estimateTokens(system);

  // Recovery state — matching the local engine's robustness.
  let emptyStreak = 0;
  let streamRetries = 0;
  let continuations = 0;
  let continueNudges = 0;
  let toolsRun = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return;

    const messages = fitToWindow(system, history, contextWindow);
    // Emit usage for the context meter.
    const historyTokens = messages.slice(1).reduce((sum, m) => sum + estimateTokens(m.content) + 8, 0);
    emitter.onUsage({ used: systemTokens + historyTokens, window: contextWindow, breakdown: [
      { label: "System", tokens: systemTokens },
      { label: "Conversation", tokens: historyTokens },
    ] });
    const assistantId = randomUUID();
    emitter.onAssistantStart(assistantId);
    emitter.onPhase("thinking");
    let genStart = Date.now();
    let accChars = 0;
    let lastEmit = 0;
    const emitStats = (forcing=false) => {
      const now = Date.now();
      if (!forcing && now - lastEmit < 250) return;
      lastEmit = now;
      const elapsedMs = Math.max(1, now - genStart);
      const totalTokens = Math.ceil(accChars / 4);
      const tps = Math.round((totalTokens / elapsedMs) * 1000);
      emitter.onGenerationStats({ tps, totalTokens, elapsedMs });
    };

    // One model response: streamed text + (optionally) native tool calls.
    let content = "";
    const calls: PendingCall[] = [];
    let streamError: unknown = null;
    let doneReason: string | undefined;
    try {
      for await (const chunk of provider.chatStream(
        { model, messages, tools: nativeTools },
        signal
      )) {
        if (chunk.message?.content) {
          content += chunk.message.content;
          accChars += chunk.message.content.length;
          emitter.onDelta(assistantId, chunk.message.content);
          emitStats();
        }
        for (const tc of chunk.message?.tool_calls ?? []) {
          calls.push({
            id: tc.id ?? randomUUID(),
            name: tc.function.name,
            args: tc.function.arguments ?? {},
          });
        }
        if (chunk.done_reason) doneReason = chunk.done_reason;
        // Safety ceiling: prevent runaway output from freezing the UI.
        if (content.length > MAX_OUTPUT_CHARS) {
          streamError = new Error("Model produced excessively long output — likely stuck in a loop.");
          break;
        }
      }
    } catch (e) {
      streamError = e;
    }
    emitStats(true);
    if (signal.aborted) {
      emitter.onDone(assistantId);
      emitter.onGenerationStats(null);
      return;
    }
    if (streamError) {
      // Retry once on mid-stream transport failures (matches local engine).
      if (streamRetries < MAX_STREAM_RETRIES) {
        streamRetries++;
        ctx.log(`[cloud] stream error (${(streamError as Error).message}) — retrying.`);
        emitter.onAssistantCancel(assistantId);
        step--;
        continue;
      }
      emitter.onError(`Model error: ${(streamError as Error).message}`);
      emitter.onDone(assistantId);
      return;
    }

    // Empty generation guard — some endpoints return 200 with zero content.
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
      return;
    }
    emptyStreak = 0;

    // No tool calls → the model is done talking (or was cut off).
    if (calls.length === 0) {
      // Cut-off detection: length cap, unclosed fence, or stream ended without finish reason.
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

      emitter.onGenerationStats(null);
      emitter.onDone(assistantId);
      return;
    }

    // Echo the assistant's tool requests into the conversation so providers
    // can match results to calls.
    history.push({
      role: "assistant",
      content,
      tool_calls: calls.map((c) => ({
        id: c.id,
        function: { name: c.name, arguments: c.args },
      })),
    });

    let completion: string | null = null;
    let followup: string | null = null;

    for (const c of calls) {
      if (signal.aborted) {
        emitter.onDone(assistantId);
        return;
      }

      // Lifecycle tools end the turn instead of touching the workspace.
      if (c.name === "attempt_completion") {
        completion = typeof c.args.result === "string" ? c.args.result : "";
        continue;
      }
      if (c.name === "ask_followup_question") {
        followup = typeof c.args.question === "string" ? c.args.question : "I have a question.";
        continue;
      }

      emitter.onPhase("working", c.name);
      const spec = tools.find((t) => t.spec.name === c.name)?.spec;
      const call: ToolCall = {
        id: c.id,
        name: c.name,
        args: c.args,
        status: "proposed",
        sideEffecting: spec?.sideEffecting ?? false,
      };
      emitter.onToolCall(assistantId, call);

      const tool = tools.find((t) => t.spec.name === c.name);
      let output: string;
      let okResult: boolean;
      if (!tool) {
        output = `Unknown tool "${c.name}". Available: ${tools.map((t) => t.spec.name).join(", ")}.`;
        okResult = false;
      } else {
        try {
          const r = await tool.execute(c.args, ctx);
          output = r.output;
          okResult = r.ok;
        } catch (e) {
          output = (e as Error).message;
          okResult = false;
        }
      }

      toolsRun++;
      emitter.onToolUpdate(assistantId, {
        ...call,
        status: okResult ? "done" : "error",
        result: okResult ? output : undefined,
        error: okResult ? undefined : output,
      });
      history.push({
        role: "tool",
        tool_call_id: c.id,
        name: c.name,
        content: clamp(output, MAX_TOOL_RESULT_CHARS),
      });
    }

    if (completion !== null) {
      emitter.onContent(assistantId, completion);
      emitter.onDone(assistantId);
      return;
    }
    if (followup !== null) {
      emitter.onContent(assistantId, followup);
      emitter.onDone(assistantId);
      return;
    }

    emitter.onDone(assistantId);
    // Loop: the model sees its tool results and continues.
  }

  if (!signal.aborted) {
    emitter.onError(
      `Reached the ${MAX_STEPS}-step safety limit in cloud mode. Ask me to continue if more work is needed.`
    );
  }
}

/**
 * Trim history so system + history fit comfortably in the model's window,
 * reserving headroom for output. Cutting happens at USER-message boundaries so
 * an assistant tool_call is never separated from its tool results (which would
 * break provider-side validation).
 */
function fitToWindow(system: string, history: LLMMessage[], window: number): LLMMessage[] {
  const budget =
    Math.max(2048, Math.floor(window * (1 - OUTPUT_RESERVE))) - estimateTokens(system);
  const tokens = history.map((m) => {
    let t = estimateTokens(m.content) + 8;
    for (const tc of m.tool_calls ?? []) t += estimateTokens(tc.function.name) + estimateTokens(JSON.stringify(tc.function.arguments));
    if (m.tool_call_id) t += 4;
    if (m.name) t += estimateTokens(m.name);
    return t;
  });
  let total = tokens.reduce((s, t) => s + t, 0);
  if (total <= budget) return [systemMsg(system), ...history];
  // Preserve the ORIGINAL user task (history[0] if user) at all costs — audit fix.
  const keepFirst = history.length > 0 && history[0].role === "user" ? 1 : 0;
  let cut = keepFirst;
  while (total > budget && cut < history.length) {
    let k = cut;
    while (k < history.length && history[k].role !== "user") { total -= tokens[k]; k++; }
    if (k >= history.length) break;
    // Never cut the preserved first message
    if (k === 0 && keepFirst) { k = 1; while (k < history.length && history[k].role !== "user") { total -= tokens[k]; k++; } if (k >= history.length) break; }
    cut = k;
    if (total <= budget) break;
    total -= tokens[cut];
    cut++;
    if (keepFirst && cut === 1) cut = 2; // skip over preserved
  }
  if (keepFirst) return [systemMsg(system), history[0], ...history.slice(Math.max(cut, 1))];
  return [systemMsg(system), ...history.slice(cut)];
}

function systemMsg(content: string): LLMMessage {
  return { role: "system", content };
}

/**
 * Flatten the UI session transcript into provider-neutral messages for the
 * cloud engine, expanding assistant tool calls + their results into the
 * native assistant(tool_calls) / tool(result) message pairs.
 */
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
      const calls = (m.toolCalls ?? []).filter((c) => c.status !== "error" || c.result !== undefined);
      if (calls.length) {
        out.push({
          role: "assistant",
          content: m.content,
          tool_calls: calls.map((c) => ({
            id: c.id,
            function: { name: c.name, arguments: c.args },
          })),
        });
        for (const c of calls) {
          if (c.result !== undefined) {
            out.push({
              role: "tool",
              tool_call_id: c.id,
              name: c.name,
              content: c.result,
            });
          }
        }
      } else if (m.content.trim()) {
        out.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool") {
      out.push({ role: "tool", content: m.content });
    }
  }
  return out;
}
