import { randomUUID } from "node:crypto";
import type {
  AdaptivePlan,
  ChatMessage,
  SessionState,
  ToolCall,
  ToolSpec,
} from "../../shared/types";
import type { LLMProvider, LLMMessage } from "../llm/types";
import { buildSystemPrompt } from "../prompts/system";
import { parsePhotonBlocks, stripToolMarkup, validateAgainstSpec } from "../protocol/parse";
import { renderToolInstructions, renderToolResult, toNativeTools } from "../protocol/serialize";
import type { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { fitToWindow } from "./contextManager";
import { buildRepairPrompt, MAX_REPAIRS } from "./repair";
import { estimateTokens } from "../adaptive/tokens";

/** Events the engine emits so the host can drive the webview UI. */
export interface TurnEmitter {
  onAssistantStart(messageId: string): void;
  onDelta(messageId: string, delta: string): void;
  /** Replace streamed content once tool blocks are stripped / finalized. */
  onContent(messageId: string, content: string): void;
  /** The generation produced nothing — discard its (empty) UI bubble. */
  onAssistantCancel(messageId: string): void;
  /** Coarse activity phase for the UI indicator (thinking = generating, working = tool). */
  onPhase(phase: "thinking" | "working", detail?: string): void;
  onToolCall(messageId: string, call: ToolCall): void;
  onToolUpdate(messageId: string, call: ToolCall): void;
  onUsage(usage: import("../../shared/types").TokenUsage): void;
  onGenerationStats(stats: import("../../shared/types").GenerationStats | null): void;
  onDone(messageId: string, notice?: string): void;
  onError(message: string): void;
}

export interface EngineDeps {
  client: LLMProvider;
  registry: ToolRegistry;
  toolContext: (signal: AbortSignal) => ToolContext;
  workspaceName: string | undefined;
  /** Compact project file tree for multi-file navigation (agent/plan modes). */
  workspaceMap: () => Promise<string | undefined>;
  /** Optional semantic retrieval over the local workspace index (M10). Returns a
   *  compact, relevance-ranked code block to inject, or undefined if unavailable. */
  retrieveContext?: (query: string, signal: AbortSignal) => Promise<string | undefined>;
  reserveOutputTokens: number;
}

const MAX_STEPS: Record<AdaptivePlan["mode"], number> = {
  chat: 1,
  plan: 50,
  agent: 100, // increased from 10
};

// Absolute safety ceiling on a single streamed reply (~50k tokens — far beyond
// any real answer). `num_predict` is -1 (no cap) so the model streams to its
// natural stop, but a model stuck in a token-repetition loop would otherwise
// grow the buffer without bound and freeze the UI. This bounds that.
const MAX_OUTPUT_CHARS = 200_000;

/** Consecutive empty generations tolerated before giving up (with a nudge
 *  between each). Free/tier-limited endpoints occasionally return HTTP 200
 *  with zero content under load; without this the agent stopped silently. */
const MAX_EMPTY_RETRIES = 2;

/** Bounded nudges for prose-only replies that look like the model intended to
 *  keep working (narrated next steps / fumbled tool format) and for identical
 *  repeated responses. Generous like DeepSeek/Opencode — only stop after 4-5 repeats. */
const MAX_CONTINUE_NUDGES = 5;
/** Mid-stream transport failures (dropped connection, gateway reset) retried
 *  once per turn before surfacing an error. */
const MAX_STREAM_RETRIES = 1;
/** Continuations when output is CUT OFF mid-stream (token-limit caps, dropped
 *  connections, unbalanced code fences). Each continuation asks the model to
 *  resume exactly where it stopped, so long outputs survive provider caps. */
const MAX_CONTINUATIONS = 5;

export class AgentEngine {
  constructor(private deps: EngineDeps) {}

  /** Run one user turn to completion (possibly many tool steps). */
  async runTurn(
    session: SessionState,
    plan: AdaptivePlan,
    emitter: TurnEmitter,
    signal: AbortSignal
  ): Promise<void> {
    const specs = this.deps.registry.specsForPlan(plan);
    const toolInstructions =
      plan.toolProtocol === "photon-block" ? renderToolInstructions(specs, plan) : "";
    const ctx = this.deps.toolContext(signal);
    // A file map helps every acting mode — including low tiers, which get only
    // a sliver (buildSystemPrompt caps lines per level and drops it entirely if
    // the window can't afford it). Retrieval costs an embedding call, so it
    // stays reserved for medium+ models.
    const wantsMap = plan.mode !== "chat";
    const wantsRetrieval = wantsMap && plan.intelligence !== "low";
    const workspaceMap = wantsMap
      ? await this.deps.workspaceMap().catch(() => undefined)
      : undefined;
    // M10: pull the most relevant indexed code for the latest user request and
    // inject it. Best-effort — a missing/empty index just means no injection.
    const lastUser = lastUserContent(session.messages);
    const retrievedContext =
      wantsRetrieval && lastUser && this.deps.retrieveContext
        ? await this.deps.retrieveContext(lastUser, signal).catch(() => undefined)
        : undefined;
    const systemContent = buildSystemPrompt({
      mode: plan.mode,
      plan,
      toolInstructions,
      workspaceName: this.deps.workspaceName,
      workspaceMap,
      retrievedContext,
    });
    const systemMsg: LLMMessage = { role: "system", content: systemContent };
    // Observability: makes "why does my 8k model forget everything" debuggable
    // from the Photon output channel.
    ctx.log(
      `[prompt] system ≈${estimateTokens(systemContent)} tokens of ${plan.numCtx} (${plan.intelligence}, ${plan.mode})`
    );

    // Working transcript for the model, seeded from the session history.
    const working = historyToLLM(session.messages, plan);
    const maxSteps = MAX_STEPS[plan.mode];

    // Anti-loop guards: small models often repeat the same call or the same
    // reply forever. Track what's been run and bail if it stalls.
    const executed = new Set<string>();
    let repeats = 0;
    let lastRaw = "";
    // Consecutive failures per tool name. A model that keeps fumbling the SAME
    // tool doesn't need another generic error — it needs teaching. At 2+
    // consecutive failures we inject the tool's schema and a worked example
    // into the next error feedback (see buildFailureHelp).
    const failStreak = new Map<string, number>();
    // Older messages dropped by the context-window fitter across this turn's
    // steps. Surfaced on the final message so silent trimming isn't silent.
    let trimmedTotal = 0;
    // Consecutive empty generations (see MAX_EMPTY_RETRIES).
    let emptyStreak = 0;
    // Recovery budgets for the guards below.
    let continueNudges = 0;
    let repeatStreak = 0;
    let streamRetries = 0;
    let continuations = 0;
    // Tool calls actually executed this turn — prose-intent nudges only apply
    // once real work has started (a first-reply prose answer is legitimate).
    let toolsRun = 0;

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return;

      // Activity indicator: back to "thinking" while the next generation runs
      // (after a tool step this flips the UI from "Running x" to "Thinking").
      emitter.onPhase("thinking");

      const budget = plan.numCtx - plan.maxOutputTokens;
      const fit = fitToWindow(systemMsg, working, budget, plan.numCtx, plan.model);
      emitter.onUsage(fit.usage);
      trimmedTotal += fit.droppedCount;

      const assistantId = randomUUID();
      emitter.onAssistantStart(assistantId);

      // Live tok/s metering — throttled to ~4Hz so webview isn't spammed
      let genStart = Date.now();
      let accChars = 0;
      let lastEmit = 0;
      const emitStats = (forcing = false) => {
        const now = Date.now();
        if (!forcing && now - lastEmit < 250) return;
        lastEmit = now;
        const elapsedMs = Math.max(1, now - genStart);
        const totalTokens = Math.ceil(accChars / 4);
        const tps = Math.round((totalTokens / elapsedMs) * 1000);
        emitter.onGenerationStats({ tps, totalTokens, elapsedMs });
      };

      let raw: string;
      let truncated: boolean;
      let nativeCalls: NativeCall[];
      let doneReason: string | undefined;
      try {
        const gen = await this.stream(fit.messages, plan, specs, signal, (d) => {
          accChars += d.length;
          emitter.onDelta(assistantId, d);
          emitStats();
        });
        raw = gen.raw;
        truncated = gen.truncated;
        nativeCalls = gen.nativeCalls;
        doneReason = gen.doneReason;
        emitStats(true);
      } catch (e) {
        if (signal.aborted) return;
        // Mid-stream transport failures (connection reset, gateway timeout)
        // used to end the whole turn. The partial text is discarded and the
        // generation retried once from the same conversation state.
        if (streamRetries < MAX_STREAM_RETRIES) {
          streamRetries++;
          ctx.log(`[engine] generation failed mid-stream (${(e as Error).message}) — retrying.`);
          emitter.onAssistantCancel(assistantId);
          step--;
          continue;
        }
        emitter.onError(`Model error: ${(e as Error).message}`);
        emitter.onDone(assistantId);
        return;
      }

      if (truncated) {
        const { content } = this.resolveCalls(raw, nativeCalls, specs, plan);
        emitter.onContent(assistantId, content);
        working.push({ role: "assistant", content: raw });
        emitter.onDone(assistantId, "Response was very long and was stopped.");
        emitter.onGenerationStats(null);
        emitter.onError(
          "The model produced an unusually long response and was stopped — it may be stuck repeating itself. Try a shorter request or a different model."
        );
        return;
      }

      ctx.log(`[engine] step ${step} gen done — ${raw.length} chars, ${nativeCalls.length} nativeCalls, done_reason=${doneReason ?? "none"}`);
      // Resolve tool calls from whichever protocol is active.
      const resolved = this.resolveCalls(raw, nativeCalls, specs, plan);
      let calls = resolved.calls;
      ctx.log(`[engine] step ${step} resolved ${calls.length} calls, cleaned ${resolved.content.length} chars`);
      if (resolved.content !== raw) emitter.onContent(assistantId, resolved.content);

      // Empty generation guard: some endpoints return 200 with zero content
      // (load shedding, filters, truncation). Ending the turn here made the
      // agent stop silently right after tool results. Discard the empty bubble
      // and nudge the model to continue, bounded times, before giving up.
      if (calls.length === 0 && !raw.trim()) {
        emptyStreak++;
        emitter.onAssistantCancel(assistantId);
        if (emptyStreak <= MAX_EMPTY_RETRIES) {
          ctx.log(`[engine] empty generation ${emptyStreak}/${MAX_EMPTY_RETRIES} — nudging the model to continue.`);
          working.push({
            role: "user",
            content:
              plan.mode === "chat"
                ? "Your previous reply arrived empty. Answer the user's last message now."
                : "Your previous reply arrived empty (the endpoint returned no content). Continue the task from the tool results above: call the next tool if steps remain, or reply with your final answer. Do not repeat tool calls you already made.",
          });
          continue;
        }
        emitter.onGenerationStats(null);
        emitter.onError(
          "The model returned an empty response several times in a row and stopped. This usually means the endpoint is overloaded or refuses the request — try again, or switch to a different model."
        );
        return;
      }
      emptyStreak = 0;

      // Persist this assistant step into the working transcript.
      working.push({ role: "assistant", content: raw });

      // Prose with no tool call. That's a legitimate final answer — UNLESS the
      // model is clearly mid-task: it narrated a next step ("Now let me read
      // …"), fumbled the tool-call format, OR the output was CUT OFF by a
      // token cap / dropped connection. All three used to END the turn silently
      // mid-task, which looked like the agent just stopping.
      if (calls.length === 0) {
        // Cut-off detection: a length-ish done reason, an unbalanced code
        // fence, or a stream that ended without any finish reason at all
        // (providers always send one on a clean finish).
        const cutOff =
          isLengthCutoff(doneReason) ||
          hasUnclosedFence(raw) ||
          (!doneReason && plan.mode !== "chat" && toolsRun > 0);
        if (cutOff && continuations < MAX_CONTINUATIONS) {
          continuations++;
          emitter.onDone(assistantId); // close the partial bubble; output continues in the next
          ctx.log(
            `[engine] output cut off (reason: ${doneReason ?? "none"}, ${raw.length} chars) — asking the model to continue (${continuations}/${MAX_CONTINUATIONS}).`
          );
          working.push({
            role: "user",
            content:
              "Your reply was cut off mid-output. Continue EXACTLY where you stopped — do not repeat earlier content and do not restate the task. If you were writing a file, continue the file from the next line.",
          });
          continue;
        }

        const intent =
          plan.mode !== "chat" && toolsRun > 0 ? continuationIntent(raw, specs) : undefined;
        if (intent && continueNudges < MAX_CONTINUE_NUDGES) {
          continueNudges++;
          emitter.onDone(assistantId); // close the narration bubble; work continues
          ctx.log(`[engine] prose-only stop (${intent}) — nudging the model to act.`);
          working.push({
            role: "user",
            content:
              intent === "format"
                ? "Your reply described a tool use but contained no valid tool call, so nothing ran. Call the tool with EXACTLY this format, then stop and wait for the result:\n[TOOL tool_name]\narg_name: value\n[/TOOL]\nIf the task is already complete, reply with your final summary instead."
                : "You stopped after describing next steps but made no tool call. Either call the next tool now, or — if the task is fully complete — reply with a short final summary of what changed.",
          });
          continue;
        }
        emitter.onGenerationStats(null);
        emitter.onDone(
          assistantId,
          trimmedTotal > 0
            ? `${trimmedTotal} earlier message${trimmedTotal === 1 ? " was" : "s were"} trimmed to fit the model's context window.`
            : undefined
        );
        return;
      }

      // Guard: the model re-emitted an identical response with tool calls.
      // Nudge it toward the NEXT step instead of ending the turn immediately;
      // stop only if it keeps looping 4-5 times (generous, like DeepSeek/Opencode).
      if (raw.trim() && raw === lastRaw) {
        repeatStreak++;
        if (repeatStreak <= 4) {
          emitter.onDone(assistantId);
          ctx.log(`[engine] identical response repeated (${repeatStreak}/5) — nudging for the next step.`);
          working.push({
            role: "user",
            content:
              "You repeated the same response. Take the NEXT step (a tool call you have not made yet), or reply with your final answer. Do not repeat calls you already made.",
          });
          continue;
        }
        emitter.onDone(assistantId);
        emitter.onGenerationStats(null);
        emitter.onError("Stopped: the model repeated the same response 5 times. Try rephrasing your request.");
        return;
      }
      // reset streak on new content
      if (raw.trim() && raw !== lastRaw) repeatStreak = 0;
      lastRaw = raw;

      // M9 tool-call repair: if EVERY proposed call is malformed, run a bounded
      // corrective sub-loop before giving up, instead of burning a whole step.
      // (A mixed batch keeps its invalid calls so the model still gets that
      // error signal via the normal execution path below.)
      if (!calls.some((c) => c.status !== "error")) {
        const repaired = await this.attemptRepair(
          invalidErrors(calls),
          systemMsg,
          working,
          plan,
          specs,
          ctx,
          signal
        );
        if (signal.aborted) return;
        if (repaired.length) {
          calls = repaired;
        } else {
          emitter.onDone(assistantId, "Could not form a valid tool call.");
          emitter.onGenerationStats(null);
          emitter.onError(
            "I couldn't produce a valid tool call after retrying. Try rephrasing, or switch to a more capable model."
          );
          return;
        }
      }

      // Execute tool calls (one at a time unless the plan allows parallel).
      const toRun = plan.allowParallelTools ? calls : calls.slice(0, 1);
      let ranSomethingNew = false;
      for (const call of toRun) {
        if (signal.aborted) return;
        const sig = dupKey(call); // path-keyed for file tools (audit)
        if (executed.has(sig)) {
          // Already ran this exact call — don't repeat it; nudge the model.
          repeats++;
          working.push({
            role: toolResultRole(plan),
            content: renderToolResult(
              call.name,
              "You already ran this exact call. Use the earlier result. If the task is complete, give your final answer with no tool call.",
              false
            ),
          });
          continue;
        }
        executed.add(sig);
        ranSomethingNew = true;
        toolsRun++;
        emitter.onPhase("working", call.name);
        emitter.onToolCall(assistantId, call);
        const spec = specs.find((s) => s.name === call.name);
        const res = await this.executeCall(call, ctx, emitter, assistantId);
        let text = res.text;
        if (!res.ok) {
          const streak = (failStreak.get(call.name) ?? 0) + 1;
          failStreak.set(call.name, streak);
          if (streak >= 2) text += buildFailureHelp(spec, streak);
        } else {
          failStreak.delete(call.name);
        }
        working.push({ role: toolResultRole(plan), content: text });
      }

      emitter.onDone(assistantId);

      // Only stop after 5 duplicate tool calls — generous like DeepSeek/Opencode.
      // 2-3 duplicates are common while a small model self-corrects; we nudge instead of killing the turn.
      if (!ranSomethingNew && repeats >= 5) {
        emitter.onGenerationStats(null);
        emitter.onError("Stopped: the model kept repeating the same tool call 5 times. Try rephrasing your request.");
        return;
      }
      // Continue to the next step so the model can react to tool output.
    }

    emitter.onGenerationStats(null);
    emitter.onError(
      `Reached the ${maxSteps}-step limit for this turn. Ask me to continue if more work is needed.`
    );
  }

  /**
   * Run one model generation to completion. Shared by the main step loop and the
   * repair sub-loop. Streams content to `onDelta` when provided (main loop) and
   * stays silent otherwise (internal repair). Enforces the runaway-output ceiling.
   */
  private async stream(
    messages: LLMMessage[],
    plan: AdaptivePlan,
    specs: ToolSpec[],
    signal: AbortSignal,
    onDelta?: (delta: string) => void
  ): Promise<{ raw: string; nativeCalls: NativeCall[]; truncated: boolean; doneReason?: string }> {
    let raw = "";
    let truncated = false;
    let doneReason: string | undefined;
    const nativeCalls: NativeCall[] = [];
    for await (const chunk of this.deps.client.chatStream(
      {
        model: plan.model,
        messages,
        options: {
          num_ctx: plan.numCtx,
          temperature: plan.temperature,
          top_p: plan.topP,
          // No hard output cap — let the model stream to its natural EOS so
          // replies are never truncated mid-thought. (plan.maxOutputTokens is
          // still used to reserve context-window space in the caller.)
          num_predict: -1,
        },
        tools: plan.toolProtocol === "native" && specs.length ? toNativeTools(specs) : undefined,
      },
      signal
    )) {
      if (chunk.message?.content) {
        raw += chunk.message.content;
        onDelta?.(chunk.message.content);
      }
      for (const tc of chunk.message?.tool_calls ?? []) {
        nativeCalls.push({ name: tc.function.name, args: tc.function.arguments ?? {} });
      }
      // Why the generation ended — "stop" (clean), "length"/"max_tokens"
      // (cut off by a token cap), etc. The continuation guard below needs
      // this to tell a finished reply from a severed one.
      if (chunk.done_reason) doneReason = chunk.done_reason;
      // Safety ceiling: a runaway/looping model must not grow the buffer without
      // bound. Breaking here runs the generator's cleanup (reader.cancel()).
      if (raw.length > MAX_OUTPUT_CHARS) {
        truncated = true;
        break;
      }
    }
    return { raw, nativeCalls, truncated, doneReason };
  }

  /**
   * M9 repair loop: when a tool-call batch is entirely malformed, send a terse
   * corrective micro-prompt (exact schema + the specific errors) and retry, up
   * to MAX_REPAIRS times. Returns the first batch of valid calls, or [] if it
   * can't be repaired (caller then degrades gracefully). Repair generations are
   * silent (not streamed to the UI) and are recorded in `working` so the
   * transcript stays coherent for subsequent steps.
   */
  private async attemptRepair(
    initialErrors: string[],
    systemMsg: LLMMessage,
    working: LLMMessage[],
    plan: AdaptivePlan,
    specs: ToolSpec[],
    ctx: ToolContext,
    signal: AbortSignal
  ): Promise<ToolCall[]> {
    let errors = initialErrors;
    for (let attempt = 1; attempt <= MAX_REPAIRS; attempt++) {
      if (signal.aborted) return [];
      ctx.log(`[repair ${attempt}/${MAX_REPAIRS}] ${errors.join("; ")}`);
      // The corrective prompt is guidance, not a tool result — always a user turn.
      working.push({ role: "user", content: buildRepairPrompt(errors, specs, plan) });

      const budget = plan.numCtx - plan.maxOutputTokens;
      const fit = fitToWindow(systemMsg, working, budget, plan.numCtx, plan.model);
      let gen: { raw: string; nativeCalls: NativeCall[]; truncated: boolean };
      try {
        gen = await this.stream(fit.messages, plan, specs, signal);
      } catch {
        return [];
      }
      working.push({ role: "assistant", content: gen.raw });

      const resolved = this.resolveCalls(gen.raw, gen.nativeCalls, specs, plan);
      const valid = resolved.calls.filter((c) => c.status !== "error");
      if (valid.length) return valid;
      errors = resolved.calls.length ? invalidErrors(resolved.calls) : ["No tool call was produced."];
    }
    return [];
  }

  private resolveCalls(
    raw: string,
    nativeCalls: { name: string; args: Record<string, unknown> }[],
    specs: ToolSpec[],
    plan: AdaptivePlan
  ): { content: string; calls: ToolCall[] } {
    // Chat mode has no tools; just scrub any stray tool markup a model emits
    // (without touching legitimate code/JSON it may be showing).
    if (plan.mode === "chat") return { content: stripToolMarkup(raw), calls: [] };

    // Native structured calls take priority when present. Validate + coerce
    // their args against the spec (same as text calls) so a missing/mistyped
    // arg is reported, never passed to a tool raw.
    if (plan.toolProtocol === "native" && nativeCalls.length) {
      return {
        content: stripToolMarkup(raw),
        calls: nativeCalls.map((c) => {
          const { args, errors } = validateAgainstSpec(c.name, c.args ?? {}, specs);
          return this.toToolCall(c.name, args, specs, errors);
        }),
      };
    }

    // Otherwise parse the text for any tool-call format the model used
    // (`[TOOL]`, `<tool_call>`, ```json, bare JSON). This also covers a
    // "native" model that emitted its calls as text instead of structured.
    const parsed = parsePhotonBlocks(raw, specs);
    const calls = parsed.calls.map((p) => this.toToolCall(p.name, p.args, specs, p.errors));
    return { content: parsed.cleanedText, calls };
  }

  private toToolCall(
    name: string,
    args: Record<string, unknown>,
    specs: ToolSpec[],
    errors: string[]
  ): ToolCall {
    const spec = specs.find((s) => s.name === name);
    return {
      id: randomUUID(),
      name,
      args,
      status: errors.length ? "error" : "proposed",
      error: errors.length ? errors.join(" ") : undefined,
      sideEffecting: spec?.sideEffecting ?? false,
    };
  }

  private async executeCall(
    call: ToolCall,
    ctx: ToolContext,
    emitter: TurnEmitter,
    messageId: string
  ): Promise<{ text: string; ok: boolean }> {
    // Invalid parse → feed the error back so the model can self-correct.
    if (call.status === "error" && call.error) {
      emitter.onToolUpdate(messageId, call);
      return {
        text: renderToolResult(call.name, `Invalid call: ${call.error}`, false),
        ok: false,
      };
    }

    const tool = this.deps.registry.get(call.name);
    if (!tool) {
      const updated = { ...call, status: "error" as const, error: `Unknown tool "${call.name}".` };
      emitter.onToolUpdate(messageId, updated);
      return {
        text: renderToolResult(
          call.name,
          `Unknown tool "${call.name}". Use one of the tools listed in your instructions — names must match exactly.`,
          false
        ),
        ok: false,
      };
    }

    emitter.onToolUpdate(messageId, { ...call, status: "running" });
    try {
      const result = await tool.execute(call.args, ctx);
      emitter.onToolUpdate(messageId, {
        ...call,
        status: result.ok ? "done" : "error",
        result: result.output,
        error: result.ok ? undefined : result.output,
      });
      return {
        text: renderToolResult(call.name, result.output, result.ok),
        ok: result.ok,
      };
    } catch (e) {
      const msg = (e as Error).message;
      emitter.onToolUpdate(messageId, { ...call, status: "error", error: msg });
      return { text: renderToolResult(call.name, msg, false), ok: false };
    }
  }
}

interface NativeCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * True when a generation ended because it hit an output-token cap rather than
 * finishing naturally. Providers name this differently: OpenAI-style
 * "length", Anthropic "max_tokens", Gemini "MAX_TOKENS", Ollama "length".
 */
function isLengthCutoff(reason: string | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r === "length" || r === "max_tokens" || r === "maxoutputtokens";
}

/** An odd number of ``` fences means the reply stopped inside a code block —
 *  a strong signal the output was severed mid-file. */
function hasUnclosedFence(text: string): boolean {
  const fences = text.match(/```/g);
  return !!fences && fences.length % 2 === 1;
}

/**
 * Detect whether a prose-only reply signals that the model meant to KEEP
 * WORKING rather than finish. Returns the intent kind or undefined.
 *
 * "format" — a known tool name appears in a call-shaped context (a [TOOL tag,
 * a JSON "name"/"tool" field, or name( … ) style) but no call was parsed, i.e.
 * the model fumbled the syntax. The parser deliberately leaves unknown-tool
 * JSON as text, so this is the only place that catch happens.
 *
 * "continue" — narrated next steps ("Now let me check the tests…"), the classic
 * weak-model failure of describing work instead of doing it.
 */
function continuationIntent(
  raw: string,
  specs: ToolSpec[]
): "format" | "continue" | undefined {
  for (const s of specs) {
    const callShaped = new RegExp(
      `(?:\\[TOOL\\s*|<tool_call>|\"(?:name|tool|tool_name)\"\\s*:\\s*\"|\\b)${s.name}\\s*\\(`,
      "i"
    );
    if (callShaped.test(raw)) return "format";
  }
  if (
    /\b(let me|i'll|i will|i am going to|going to|next,|now let|now i|then,|first,|start by|begin by)\b/i.test(
      raw
    )
  ) {
    return "continue";
  }
  return undefined;
}

/**
 * Escalating help appended to a tool's error feedback once the same tool has
 * failed 2+ times in a row. This is the "help the model when it struggles"
 * mechanism: instead of repeating a generic error, we re-teach the exact
 * contract — required arguments and a worked example copied from the spec.
 * Deliberately compact so it fits the context that caused the failure.
 */
function buildFailureHelp(spec: ToolSpec | undefined, attempt: number): string {
  if (!spec) return "";
  const required = spec.params.filter((p) => p.required);
  const lines = [
    "",
    `--- HELP: ${spec.name} has failed ${attempt}x in a row ---`,
    `${spec.summary}`,
    required.length
      ? `Required arguments: ${required.map((p) => `${p.name} (${p.type})`).join(", ")}.`
      : "This tool takes no required arguments.",
  ];
  if (spec.params.some((p) => !p.required)) {
    lines.push(
      `Optional: ${spec.params
        .filter((p) => !p.required)
        .map((p) => `${p.name}`)
        .join(", ")}.`
    );
  }
  if (spec.example) lines.push(`Correct usage — copy this shape exactly:\n${spec.example}`);
  return lines.join("\n");
}

/** Human-readable error lines for a batch of invalid calls (for repair prompts). */
function invalidErrors(calls: ToolCall[]): string[] {
  return calls
    .filter((c) => c.status === "error")
    .map((c) => `${c.name}: ${c.error ?? "invalid call"}`);
}

/** The most recent user message's text — the query for M10 retrieval. */
function lastUserContent(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return undefined;
}

/** Stable signature for repeat detection — path-keyed for file tools to avoid hashing huge content. */
function dupKey(call: ToolCall): string {
  const keyArgs: Record<string, unknown> = {};
  // File tools: duplicate is same path + same operation, not same full content
  if (["read_file", "list_dir", "find_files", "get_diagnostics", "code_outline"].includes(call.name)) {
    keyArgs.path = call.args.path ?? call.args.query ?? call.args.command ?? "";
  } else if (call.name === "edit_file") {
    keyArgs.path = call.args.path; keyArgs.find = call.args.find;
  } else if (call.name === "write_file") {
    keyArgs.path = call.args.path; // content intentionally excluded — same-file rewrite is duplicate
  } else if (call.name === "run_command") {
    keyArgs.command = call.args.command;
  } else {
    return `${call.name}|${signature(call.args)}`;
  }
  try { return `${call.name}|${JSON.stringify(keyArgs, Object.keys(keyArgs).sort())}`; } catch { return `${call.name}|${String(Object.values(keyArgs).join("|"))}`; }
}
function signature(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return String(Object.values(args).join("|"));
  }
}

function toolResultRole(plan: AdaptivePlan): LLMMessage["role"] {
  // Tool-trained models understand the dedicated "tool" role; weaker models on
  // the block protocol do better when results arrive as a user turn.
  return plan.toolProtocol === "native" ? "tool" : "user";
}

/** Flatten the UI transcript into provider-neutral LLM messages, inlining tool results. */
function historyToLLM(messages: ChatMessage[], plan: AdaptivePlan): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push(buildUserMessage(m));
    } else if (m.role === "assistant") {
      if (m.content.trim()) out.push({ role: "assistant", content: m.content });
      for (const call of m.toolCalls ?? []) {
        if (call.result !== undefined) {
          out.push({
            role: toolResultRole(plan),
            content: renderToolResult(call.name, call.result, call.status !== "error"),
          });
        }
      }
    } else if (m.role === "tool") {
      out.push({ role: toolResultRole(plan), content: m.content });
    }
  }
  return out;
}

/** Build a user message, inlining text attachments and passing images through. */
function buildUserMessage(m: ChatMessage): LLMMessage {
  const attachments = m.attachments ?? [];
  const textDocs = attachments.filter((a) => a.kind === "text" && a.text);
  const images = attachments
    .filter((a) => a.kind === "image" && a.dataBase64)
    .map((a) => a.dataBase64 as string);

  let content = m.content;
  for (const doc of textDocs) {
    content += `\n\n--- Attached file: ${doc.name} ---\n${doc.text}\n--- end ${doc.name} ---`;
  }

  const msg: LLMMessage = { role: "user", content };
  if (images.length) msg.images = images;
  return msg;
}
