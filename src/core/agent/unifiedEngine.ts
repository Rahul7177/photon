import { randomUUID } from "node:crypto";
import type { AdaptivePlan, ChatMessage, ToolCall, ToolSpec, VerificationPlan } from "../../shared/types";
import type { LLMMessage } from "../llm/types";
import { buildSystemPrompt } from "../prompts/system";
import { fitToWindow } from "./contextManager";
import { estimateTokens } from "../adaptive/tokens";
import { getProjectContextManager } from "../context/projectContext";
import { parsePhotonBlocks, validateAgainstSpec, canonicalToolName, stripToolMarkup } from "../protocol/parse";
import { renderToolResult } from "../protocol/serialize";
import { renderToolInstructions, toNativeTools } from "../protocol/serialize";
import { executionFingerprint, recoveryDirective, buildVerificationPlan, isFreshInfoRequest, looksLikeNarration, selectToolSpecs, stripFencedCode, suggestFirstTool } from "../intelligence/policy";
import { ToolPipeline } from "../../photon-core/tools/pipeline";
import type { LLMProvider } from "../llm/types";
import type { TodoItem } from "../tools/types";

export interface UnifiedEngineDeps { provider:LLMProvider;tools:import("../tools/types").Tool[];workspaceName?:string;workspaceMap?:()=>Promise<string|undefined>;retrieveContext?:(query:string,signal:AbortSignal)=>Promise<string|undefined>;buildToolContext:(signal:AbortSignal)=>import("../tools/types").ToolContext;reserveOutputTokens?:number; }
export interface UnifiedEmitter { onAssistantStart(id:string):void;onDelta(id:string,delta:string):void;onThinkingDelta?(id:string,delta:string):void;onThinkingEnd?(id:string,elapsedMs:number):void;onContent(id:string,content:string):void;onAssistantCancel(id:string):void;onPhase(phase:"thinking"|"working",detail?:string):void;onToolCall(id:string,call:ToolCall):void;onToolUpdate(id:string,call:ToolCall):void;onUsage(usage:import("../../shared/types").TokenUsage):void;onGenerationStats(stats:import("../../shared/types").GenerationStats|null):void;onDone(id:string,notice?:string):void;onError(message:string):void; }
const MAX_OUTPUT_CHARS=200_000;

// Spec §5 hard caps
const MODE_CAPS:Record<string,number>={chat:6,plan:10,agent:25};
const CHECK_IN_INTERVAL=8;

export async function runUnifiedTurn(session:{messages:ChatMessage[]},plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal,deps:UnifiedEngineDeps):Promise<void>{
  const turnStart = Date.now(); // overall turn start for avg stats
  const pipeline=new ToolPipeline();pipeline.registerAll(deps.tools);
  const task=plan.task??{scope:"single_file",reasoning:"medium",risk:"low",verification:[],ambiguity:"low",estimatedSteps:1};
  const lastUserText=lastUser(session.messages)??"";
  // FIX: detect fresh-info requests upfront so we can wire it through
  // to tool selection (guarantees web_search/web_fetch are in the list)
  // and to the system prompt (injects explicit web-search directive).
  const freshInfo = isFreshInfoRequest(lastUserText);
  const workspaceMap=plan.mode!=="chat"&&deps.workspaceMap?await deps.workspaceMap().catch(()=>undefined):undefined;
  const retrieved=plan.mode!=="chat"&&deps.retrieveContext?await deps.retrieveContext(lastUserText,signal).catch(()=>undefined):undefined;
  const verificationPlan:VerificationPlan=plan.verification??buildVerificationPlan(task);

  // Spec §2: core loop — one tool call per turn, then stop
  // Spec §5: hard iteration caps, check-in every 8
  const maxSteps=MODE_CAPS[plan.mode] ?? 25;
  let mutationEpoch=0;
  const executed=new Set<string>();
  const executedTools: { name: string; args: Record<string, unknown>; ok: boolean }[] = [];
  let lastAssistantResponse = "";
  // OPT + FIX: one shared todos array for the whole turn. Previously todoState
  // came from a throwaway buildToolContext().todos while every tool execution
  // got a FRESH todos:[] — so todo_write mutations were lost every step and the
  // progress check-in always saw empty. Share one array via a helper.
  const sharedTodos:TodoItem[]=[];
  const todoState=sharedTodos;
  const baseToolCtx=deps.buildToolContext(signal);
  const sharedLog=baseToolCtx.log;
  const toolCtxFor=(pendingCallId:string)=>({...deps.buildToolContext(signal),todos:sharedTodos,pendingCallId});
  const ctxMgr=getProjectContextManager(baseToolCtx.workspaceRoot);
  if(ctxMgr) await ctxMgr.ensureInitialized().catch(()=>undefined);
  const projectContextDigest=!freshInfo?ctxMgr?.buildPromptDigest({userQuery:lastUserText,activeModel:plan.model,maxTokens:Math.min(1200,Math.floor(plan.numCtx*0.18))}):undefined;

  const commitTurnHandoff = () => {
    if (ctxMgr && (lastAssistantResponse || executedTools.length)) {
      ctxMgr.recordTurnHandoff({
        fromModel: plan.model,
        userPrompt: lastUserText,
        assistantResponse: lastAssistantResponse || (signal.aborted ? "Turn was stopped." : "Task completed."),
        toolsUsed: executedTools,
        pendingTodos: todoState.filter((t) => t.status === "pending" || t.status === "in_progress").map((t) => t.task),
      });
    }
  };
  // OPT: per-turn invariants hoisted out of the step loop. plan/freshInfo/
  // workspaceMap/retrieved/lastUserText are all fixed for the turn, so specs,
  // tool instructions, system prompt and native tools are identical every step.
  // Rebuilding them x25 steps wasted CPU and reallocated large strings.
  const allSpecs=deps.tools.map(t=>t.spec);
  const specs=selectToolSpecs(allSpecs,plan,"orient",freshInfo);
  // Names the model may actually call this turn. In chat mode this is just
  // the web tools — anything else is a mode violation, not a retryable error.
  const modeToolNames=new Set(specs.map(s=>s.name));
  const toolInstructions=plan.toolProtocol==="native"?"":renderToolInstructions(specs,plan);
  const system=buildSystemPrompt({mode:plan.mode,plan,toolInstructions,workspaceName:deps.workspaceName,workspaceMap,retrievedContext:retrieved,projectContextDigest,lastUserText:lastUserText,freshInfoRequest:freshInfo});
  const systemMsg:LLMMessage={role:"system",content:system};
  const budgetTokens=Math.max(512, plan.numCtx - 1000); // reserve 1000 for output per §4
  const nativeTools=plan.toolProtocol==="native"&&specs.length?toNativeTools(specs):undefined;
  const toolSpecByName=new Map(deps.tools.map(t=>[t.spec.name,t.spec] as const));
  // Track retries per logical step for §5 retry policy
  const retryCount = new Map<string, number>();
  let continueNudges = 0;
  const MAX_CONTINUE_NUDGES = 5;
  let finalAnswerNudges = 0;
  const MAX_FINAL_ANSWER_NUDGES = 2;
  // FIX: a first-step empty completion (no tools yet, nothing visible) used to
  // fall straight through to a bare onDone — a silent turn end with an
  // invisible bubble. Retry bounded like the legacy engine, then say so.
  let emptyStreak = 0;
  const MAX_EMPTY_RETRIES = 2;
  // FIX: count tools that actually ran this turn. Once a tool has run, the model
  // must conclude; if it keeps emitting tool calls instead, we nudge it to answer.
  let toolsRun = 0;
  let concludeNudges = 0;
  const MAX_CONCLUDE_NUDGES = 2;
  // FIX: track output truncation separately. When the stream is cut off
  // (done_reason "length") mid-tool-call, the parser finds no valid call and
  // the turn used to die silently. We now retry a bounded number of times.
  let truncationRetries = 0;
  const MAX_TRUNCATION_RETRIES = 2;
  // Turn-scoped output tally: raw is declared per step, but the closing stats
  // are emitted after the loop — sum here so the average is per turn, not per step.
  let generatedChars = 0;
  // FIX: single assistant message id reused across all steps of this turn so the UI
  // shows one continuous working message instead of a new bubble per tool call.
  let currentAssistantId = randomUUID();
  // FIX: when a small model emits 2+ tool calls in one response, the extras used
  // to be silently dropped — the model then believed they ran and got confused. We
  // now queue them and execute them in subsequent iterations without re-querying.
  const pendingCalls:ToolCall[]=[];

  for(let step=0;step<maxSteps&&!signal.aborted;step++){
    // FIX: drain any queued tool calls from a previous multi-call response BEFORE
    // querying the model again. Previously the extras were dropped silently.
    if(pendingCalls.length){
      const queuedRaw=pendingCalls.shift()!;
      const qId=currentAssistantId;

      // Chat mode can't run workspace tools — a queued extra the model
      // emitted alongside a web call must not become an error card either.
      if(plan.mode==="chat"&&!modeToolNames.has(queuedRaw.name)){
        emitter.onContent(qId,chatRedirectText(queuedRaw));
        emitter.onDone(qId);
        currentAssistantId=randomUUID();
        continue;
      }

      if(queuedRaw.status==="error"){
        emitter.onAssistantStart(qId);
        emitter.onToolCall(qId,queuedRaw);
        emitter.onToolUpdate(qId,queuedRaw);
        const spec=toolSpecByName.get(queuedRaw.name);
        const example=spec?renderCorrectExample(spec,queuedRaw.args):"";
        const errorResult=renderToolResult(queuedRaw.name, (queuedRaw.error||"Invalid tool call")+(example?`\n\nCorrect format for ${queuedRaw.name}:\n${example}`:""), false);
        session.messages.push({id:randomUUID(),role:"user",content:errorResult,createdAt:Date.now(),hidden:true});
        emitter.onDone(qId);
        currentAssistantId=randomUUID();
        continue;
      }

      const qFingerprint=executionFingerprint(queuedRaw,mutationEpoch);
      if(executed.has(qFingerprint)){
        emitter.onAssistantStart(qId);
        emitter.onToolCall(qId,queuedRaw);
        emitter.onToolUpdate(qId,{...queuedRaw,status:"error",statusDetail:undefined,error:"Duplicate call — already ran. Use the earlier result."});
        const dupResult=renderToolResult(queuedRaw.name, "You already ran this exact call. Use the earlier result. If the task is complete, give your final answer with no tool call.", false);
        session.messages.push({id:randomUUID(),role:"user",content:dupResult,createdAt:Date.now(),hidden:true});
        emitter.onDone(qId);
        currentAssistantId=randomUUID();
        continue;
      }
      executed.add(qFingerprint);

      // Normalize: the queued copy must start clean in its own bubble.
      const queued:ToolCall={...queuedRaw,status:"proposed",statusDetail:undefined} as ToolCall;
      emitter.onAssistantStart(qId);
      emitter.onPhase("working",queued.name);
      emitter.onToolCall(qId,queued);
      emitter.onToolUpdate(qId,{...queued,status:"running",statusDetail:undefined});
      const qCtx=toolCtxFor(queued.id);
      const qResults=await pipeline.executeMany([queued],qCtx,1);
      if(signal.aborted){
        emitter.onDone(qId, "Stopped.");
        return;
      }
      const qResult=qResults.get(queued.id);
      if(!qResult){
        // FIX: pipeline must always resolve one result per call. If it doesn't,
        // close the card as error instead of leaving it in "running" forever.
        emitter.onToolUpdate(qId,{...queued,status:"error",statusDetail:undefined,error:"Tool execution produced no result."});
        emitter.onDone(qId);
        currentAssistantId=randomUUID();
        continue;
      }
      {
        const qSpec=toolSpecByName.get(queued.name);
        if(qSpec?.sideEffecting&&qResult.ok)mutationEpoch++;
        toolsRun++;
        executedTools.push({ name: queued.name, args: queued.args, ok: qResult.ok });
        emitter.onToolUpdate(qId,{...queued,status:qResult.ok?"done":"error",statusDetail:undefined,result:qResult.ok?qResult.output:undefined,error:qResult.ok?undefined:qResult.output});
        if(plan.toolProtocol==="native"){
          session.messages.push({id:randomUUID(),role:"tool",content:qResult.output,toolCallId:queued.id,name:queued.name,createdAt:Date.now(),hidden:true} as ChatMessage);
        }else{
          session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(queued.name,qResult.output,qResult.ok),createdAt:Date.now(),hidden:true});
        }
        if(qSpec?.sideEffecting&&qResult.ok&&plan.mode!=="chat"){
          session.messages.push({id:randomUUID(),role:"user",content:mutationConcludeNudge(queued.name),createdAt:Date.now(),hidden:true});
        }
        emitter.onDone(qId);
        currentAssistantId=randomUUID();
      }
      continue;
    }
    // Spec §5: check-in every 8
    if(step>0 && step%CHECK_IN_INTERVAL===0 && step < maxSteps){
      // Post progress check-in via emitter if not done
      const pending = todoState.filter(t=>t.status==="pending"||t.status==="in_progress").length;
      if(pending>0){
        // Don't emit as error — just log
        sharedLog(`[progress] Step ${step}/${maxSteps}: ${pending} todos remaining`);
      }
    }

    // (specs/toolInstructions/systemMsg/budgetTokens/nativeTools hoisted per turn)
    emitter.onPhase("thinking");
    const history=historyToLLM(session.messages,plan);
    const fit=fitToWindow(systemMsg,history,budgetTokens,plan.numCtx,plan.model,true);
    emitter.onUsage(fit.usage);
    // FIX: reuse ONE assistant message id for the whole turn. Previously each
    // step created a fresh id, so every tool call spawned a new assistant bubble
    // that "stopped" and restarted — the user saw the conversation die between
    // steps. A single id keeps all tool calls in one streaming message.
    const id=currentAssistantId;
    emitter.onAssistantStart(id);
    let raw="";let thinkingStep="";const thinkingStart=Date.now();const nativeCalls:{id?:string;name:string;args:Record<string,unknown>;thoughtSignature?:string}[]=[];let doneReason:string|undefined;
    // Slow-machine progress: until the first chunk arrives the UI would sit on
    // a bare "thinking" with no sign of life while a cold model loads. Nudge
    // the status + output log every 20s so the user can tell loading apart
    // from stuck. Stops at the first chunk; always cleared on exit.
    const streamStart=Date.now();
    let gotFirstChunk=false;
    let hadExactUsage=false;
    let slowTimer:ReturnType<typeof setInterval>|undefined;
    const stopSlowTimer=()=>{if(slowTimer){clearInterval(slowTimer);slowTimer=undefined;}};
    slowTimer=setInterval(()=>{
      if(gotFirstChunk||signal.aborted)return;
      const elapsed=Math.round((Date.now()-streamStart)/1000);
      sharedLog(`[engine] still waiting for model response (${elapsed}s) — a cold or large model loading into memory can take minutes on first use.`);
      emitter.onPhase("thinking",`Waiting for model (${elapsed}s)…`);
    },20000);
    try{
      for await(const chunk of deps.provider.chatStream({
        model:plan.model,
        messages:fit.messages,
        // FIX: num_predict was hardcoded to 1000 — a write_file tool call with
        // real content easily exceeds that, so the stream was cut mid-call,
        // the parser saw a truncated block, and the turn died. Use the plan's
        // output budget (already sized per model tier + context window).
        options:{num_ctx:plan.numCtx,temperature:plan.temperature,top_p:plan.topP,num_predict:plan.maxOutputTokens,...(plan.seed!==undefined?{seed:plan.seed}:{})},
        tools:nativeTools
      },signal)){
        if(!gotFirstChunk){gotFirstChunk=true;stopSlowTimer();}
        // Native reasoning trace (Ollama thinking, R1 reasoning_content…):
        // display-only, never parsed as tool calls or fed back to the model.
        if(chunk.message?.thinking){
          thinkingStep+=chunk.message.thinking;
          emitter.onThinkingDelta?.(id,chunk.message.thinking);
        }
        if(chunk.message?.content){
          raw+=chunk.message.content;
          // Block-protocol output must stay buffered until parsing finishes.
          // Emitting it as deltas leaks BEGIN_ARG/tool_call logs into chat and
          // makes the UI appear to show events out of order.
          if(plan.toolProtocol==="native") emitter.onDelta(id,chunk.message.content);
        }
        for(const tc of chunk.message?.tool_calls??[])nativeCalls.push({id:tc.id,name:tc.function.name,args:tc.function.arguments??{},thoughtSignature:tc.thoughtSignature});
        if(chunk.done_reason)doneReason=chunk.done_reason;
        if(chunk.prompt_eval_count && chunk.prompt_eval_count > 0){
          hadExactUsage = true;
          const convTok = Math.max(0, chunk.prompt_eval_count - (fit.usage.breakdown[0]?.tokens ?? 0));
          emitter.onUsage({
            used: chunk.prompt_eval_count + (chunk.eval_count ?? 0),
            window: plan.numCtx,
            breakdown: [
              fit.usage.breakdown[0] ?? { label: "System + tools", tokens: 0 },
              { label: "Conversation (exact)", tokens: convTok + (chunk.eval_count ?? 0) },
            ],
          });
        }
        if(chunk.eval_count && chunk.eval_duration && chunk.eval_duration > 0){
          const exactTps = Math.round((chunk.eval_count / (chunk.eval_duration / 1e9)) * 10) / 10;
          emitter.onGenerationStats({ tps: exactTps, totalTokens: chunk.eval_count, elapsedMs: Math.round(chunk.eval_duration / 1e6) });
        }
        if(raw.length>MAX_OUTPUT_CHARS){doneReason="length";break;}
      }
      stopSlowTimer();
      if(!hadExactUsage && raw.trim()){
        const outputTok = estimateTokens(raw);
        emitter.onUsage({
          used: fit.usage.used + outputTok,
          window: plan.numCtx,
          breakdown: [
            fit.usage.breakdown[0] ?? { label: "System + tools", tokens: 0 },
            { label: "Conversation", tokens: (fit.usage.breakdown[1]?.tokens ?? 0) + outputTok },
          ],
        });
      }
    }catch(e){stopSlowTimer();if(thinkingStep)emitter.onThinkingEnd?.(id,Date.now()-thinkingStart);if(signal.aborted){emitter.onDone(id,raw.trim()?"Stopped.":"Stopped before the model replied.");return;}emitter.onAssistantCancel(id);emitter.onError(`Model error: ${(e as Error).message}`);return;}
    if(thinkingStep)emitter.onThinkingEnd?.(id,Date.now()-thinkingStart);
    generatedChars+=raw.length;

    const resolved=resolveCalls(raw,nativeCalls,specs,plan);
    const calls=resolved.calls;
    let visible=resolved.cleanedText;
    // The model attempted a tool call but the block was incomplete/malformed,
    // so the parser produced zero calls (e.g. a bare "TOOL_NAME: web_search"
    // with no args/close). Two problems if untreated: (1) the no-call path
    // below only nudges when tools already ran, so a FIRST-step attempt dies
    // silently; (2) cleanedText can retain protocol fragments that leak into
    // chat. Repair-nudge (bounded) instead, and never display the fragment.
    const failedAttempt=calls.length===0&&looksLikeFailedToolAttempt(raw);
    if(failedAttempt){
      visible=stripToolAttemptMarkup(visible);
      if(continueNudges<MAX_CONTINUE_NUDGES){
        continueNudges++;
        const firstTool=suggestFirstTool(specs,lastUserText);
        const spec=toolSpecByName.get(firstTool);
        const example=spec?`\n\nCorrect format:\n${renderCorrectExample(spec,{})}`:"";
        session.messages.push({id:randomUUID(),role:"user",content:`You tried to call a tool but the block was incomplete, so nothing ran. Do NOT explain — re-emit EXACTLY one complete tool block now, starting with ${firstTool}.${example}`,createdAt:Date.now(),hidden:true});
        continue;
      }
    }
    // Chat mode has no workspace tools (only web_search/web_fetch). A small
    // model often tries one anyway from memory — that used to fall into the
    // invalid-call repair loop and paint a wall of red "Unknown tool" cards.
    // Redirect gracefully instead: one plain message pointing at Agent mode,
    // no error cards, no retries. Placed before onContent so the redirect
    // replaces (not appends to) any narration the model wrote around the block.
    if(plan.mode==="chat"&&calls.length&&!modeToolNames.has(calls[0].name)){
      emitter.onContent(id,chatRedirectText(calls[0]));
      emitter.onDone(id);
      return;
    }
    if(plan.toolProtocol!=="native"){
      if(visible.trim()) emitter.onContent(id,visible);
    }else if(visible!==raw){
      emitter.onContent(id,visible);
    }
    if (visible.trim()) lastAssistantResponse = visible.trim();

    // Hard guard: greetings / small talk must never trigger a tool.
    if (isGreetingOnly(lastUserText ?? "")) {
      const text = visible || "Hello! How can I help you with your coding tasks today?";
      lastAssistantResponse = text;
      commitTurnHandoff();
      emitter.onContent(id, text);
      // The bubble id is already recorded in the session by the emitter;
      // pushing a second assistant message here rendered the greeting twice.
      emitter.onDone(id);
      return;
    }

    // No tool calls — plain text answer ends the turn per §2
    if(!calls.length){
      // FIX: if the stream was cut off mid-generation (done_reason "length")
      // and we're in a tool mode, the model was almost certainly mid-tool-call.
      // Treat it as a truncation, not a final answer: nudge it to re-emit the
      // call as a single compact block. Bounded so a stuck model can't loop.
      if(doneReason === "length" && plan.mode !== "chat" && truncationRetries < MAX_TRUNCATION_RETRIES){
        truncationRetries++;
        const firstTool = suggestFirstTool(specs, lastUserText);
        const nudge = `Your previous response was cut off before a complete tool call. Re-emit EXACTLY one tool block now (start with ${firstTool}) and nothing else. Keep it short.`;
        session.messages.push({id:randomUUID(),role:"user",content:nudge,createdAt:Date.now(),hidden:true});
        continue;
      }
      // OPT + FIX: use the turn-local toolsRun counter. The old
      // session.messages.filter(...tool_result) scan was O(n) per step AND
      // counted previous turns' results in a long session — wrong.
      const toolsRunThisTurn = toolsRun;
      // Small local models often emit an empty completion after receiving a
      // successful tool result. Do not silently end the turn: give the model a
      // bounded, explicit final-answer pass so the user gets a summary.
      // The same applies to a first-step empty completion (no tools yet):
      // without this the turn ends on an invisible bubble and looks stalled.
      if(!visible.trim()){
        if(toolsRunThisTurn > 0){
          if(finalAnswerNudges < MAX_FINAL_ANSWER_NUDGES){
            finalAnswerNudges++;
            session.messages.push({
              id:randomUUID(),
              role:"user",
              content:"The tool completed successfully. Now give the user a concise final answer based on the tool result. Do not call another tool unless it is necessary. Reply in plain text.",
              createdAt:Date.now(),
              hidden:true,
            });
            continue;
          }
          // Do not leave the user with a silent completed turn if a weak model
          // keeps returning empty/markup-only completions after the tool worked.
          const fallback = lastToolSucceeded(session.messages)
            ? "Done. The requested operation completed successfully."
            : "The tool step finished, but the model did not provide a final explanation.";
          emitter.onContent(id,fallback);
          emitter.onDone(id);
          return;
        }
        if(emptyStreak < MAX_EMPTY_RETRIES){
          emptyStreak++;
          session.messages.push({
            id:randomUUID(),
            role:"user",
            content:"Your previous reply arrived empty. Answer the user's request now in plain text, or call a tool first if you need information. Do not reply empty again.",
            createdAt:Date.now(),
            hidden:true,
          });
          continue;
        }
        emitter.onContent(id,"The model returned an empty response. Try rephrasing your request or try again.");
        emitter.onDone(id);
        return;
      }
      // After a tool result, Chat mode must also recover from narration. The
      // previous mode guard ended the turn on text like "I will search next",
      // and the host finalized the still-active bubble as "Stopped." Initial
      // Chat requests without tools still finish normally below.
      const shouldCheckNarration =
        (plan.mode !== "chat" || toolsRunThisTurn > 0) &&
        !isGreetingOnly(lastUserText ?? "") &&
        continueNudges < MAX_CONTINUE_NUDGES;
      if(raw.trim() && shouldCheckNarration){
        // The model may paste file/command output in a fence and narrate its
        // next tool call in the surrounding prose ("…I will use edit_file…
        // Let me proceed"). looksLikeNarration treats fenced output as a
        // deliverable, so also test the prose with fences stripped — otherwise
        // the turn ends right before the tool runs.
        const proseOnly=stripFencedCode(raw);
        const isNarration = looksLikeNarration(raw)
          || (proseOnly.length>=8&&looksLikeNarration(proseOnly));
        if(isNarration){
          // FIX: suggest the contextually appropriate first tool, not always list_dir.
          // When the model already named the tool it wants, point at that one.
          const firstTool = suggestFirstTool(specs, lastUserText);
          const namedTool=specs.map(s=>s.name).find(n=>new RegExp(`\\b${n}\\b`).test(raw));
          const nudge = toolsRunThisTurn === 0
            ? `You described what to do but did not call a tool. Do NOT answer from memory — call a tool now. Start with ${namedTool??firstTool}. Reply with EXACTLY one tool block and nothing else.`
            : namedTool
              ? `You said you would call ${namedTool} next but did not emit a tool call. Stop explaining — emit the ${namedTool} block now. Reply with EXACTLY one tool block and nothing else.`
              : `You narrated what to do next but did not emit a tool call. Stop explaining — call the tool now. Reply with EXACTLY one tool block and nothing else.`;
          session.messages.push({id:randomUUID(),role:"user",content:nudge,createdAt:Date.now(),hidden:true});
          continueNudges++;
          continue;
        }
      }
      commitTurnHandoff();
      emitter.onDone(id);
      return;
    }

    // In Chat mode, if a tool already ran, nudge the model to conclude with an answer instead of running endless tools
    if(plan.mode === "chat" && toolsRun >= 1 && concludeNudges < MAX_CONCLUDE_NUDGES){
      concludeNudges++;
      session.messages.push({
        id: randomUUID(),
        role: "user",
        content: "You have gathered the necessary information. Please provide your direct final answer to the user now in plain text without calling any more tools.",
        createdAt: Date.now(),
        hidden: true,
      });
      emitter.onDone(id);
      currentAssistantId = randomUUID();
      continue;
    }

    // Spec §2: ONE tool call per turn — enforce even if model emitted multiple
    const call=calls[0];
    if(calls.length>1){
      // FIX: queue the extras so they run next instead of being silently dropped.
      // Small models often emit several calls at once; dropping them made the model
      // believe they ran, then it got confused and the turn stalled.
      // NOTE: do NOT emit the queued copies here. They share the same call ids,
      // so emitting them into the current message (id) and then re-emitting the
      // same ids into a fresh message when draining leaves a stale "proposed"
      // (UI: "queued") duplicate in the first bubble that is never updated, and
      // the drain's message has no onAssistantStart so the webview drops it.
      // Queue silently; the drain path above emits each call exactly once, in
      // its own bubble, with running -> done transitions.
      const queuedBefore=pendingCalls.length;
      for(let i=1;i<calls.length;i++){
        // Chat-mode extras the model can't run are dropped silently here —
        // the redirect guard above handles the user-facing message.
        if(plan.mode==="chat"&&!modeToolNames.has(calls[i].name))continue;
        const queued={...calls[i],status:calls[i].status,statusDetail:undefined} as ToolCall;
        pendingCalls.push(queued);
      }
      const queuedNow=pendingCalls.length-queuedBefore;
      if(queuedNow)sharedLog(`[engine] Model emitted ${calls.length} calls — queued ${queuedNow} for sequential execution`);
    }
    // Handle invalid call — §5 retry policy
    if(call.status==="error"){
      const key=`${call.name}:${call.error}`;
      const count=(retryCount.get(key)||0)+1;
      retryCount.set(key,count);
      emitter.onToolCall(id,call);
      emitter.onToolUpdate(id,call);
      // FIX: small models rarely recover from a bare "Missing required argument"
      // error — they repeat the same mistake. Show the EXACT correct block for
      // this tool (with the args it already got, filled in) so it can copy it.
      const spec=toolSpecByName.get(call.name);
      const example=spec?renderCorrectExample(spec,call.args):"";
      const errorResult=renderToolResult(call.name, (call.error||"Invalid tool call")+(example?`\n\nCorrect format for ${call.name}:\n${example}`:""), false);
      session.messages.push({id:randomUUID(),role:"user",content:errorResult,createdAt:Date.now(),hidden:true});
      emitter.onDone(id);
      currentAssistantId=randomUUID();
      if(count>=2){
        // Spec §5: retry same logical step at most 2 times, then mark blocked
        if(plan.mode==="agent"){
          // Mark todo blocked if possible
          const pending=todoState.find(t=>t.status==="pending"||t.status==="in_progress");
          if(pending){
            pending.status="blocked";
            (pending as any).reason=call.error||"Invalid tool call after 2 retries";
          }
        }
        // Continue to next step or end if no independent items
        const hasIndependent=todoState.some(t=>t.status==="pending");
        if(!hasIndependent && step >= maxSteps-1){
          emitter.onError(`Blocked: ${call.error} — no independent steps remain.`);
          return;
        }
      }
      continue;
    }

    // Check duplicate — don't repeat identical failed call per §5
    const fingerprint=executionFingerprint(call,mutationEpoch);
    if(executed.has(fingerprint)){
      // FIX: previously only onToolCall (status "proposed") was emitted here,
      // so the card stayed "queued" in the UI forever. Emit a terminal error
      // update so it resolves instead of looking stuck.
      emitter.onToolCall(id,call);
      emitter.onToolUpdate(id,{...call,status:"error",statusDetail:undefined,error:"Duplicate call — already ran. Use the earlier result."});
      const dupResult=renderToolResult(call.name, "You already ran this exact call. Use the earlier result. If the task is complete, give your final answer with no tool call.", false);
      session.messages.push({id:randomUUID(),role:"user",content:dupResult,createdAt:Date.now(),hidden:true});
      emitter.onDone(id);
      currentAssistantId=randomUUID();
      continue;
    }
    executed.add(fingerprint);

    // Spec §7.3 rule 3: think before mutating — enforce if model skipped it
    const isMutating=["edit_file","append_file","write_file","move_path","run_command"].includes(call.name);
    // We don't block, but we log — the prompt already mandates think

    // Execute one tool
    const toolCtx=toolCtxFor(call.id);
    // FIX: emit "running" before execution so the UI shows progress instead of
    // staying stuck on "queued" for the entire duration of long-running tools.
    emitter.onPhase("working",call.name);
    emitter.onToolCall(id,call);
    emitter.onToolUpdate(id,{...call,status:"running"});
    const results=await pipeline.executeMany([call],toolCtx,1);
    if(signal.aborted){
      emitter.onDone(id, "Stopped.");
      return;
    }
    const result=results.get(call.id);
    if(!result){
      emitter.onToolUpdate(id,{...call,status:"error",error:"Tool execution produced no result."});
      emitter.onDone(id);
      currentAssistantId=randomUUID();
      continue;
    }

    // Track mutation epoch for fingerprinting
    const toolSpec=toolSpecByName.get(call.name);
    if(toolSpec?.sideEffecting&&result.ok) mutationEpoch++;
    toolsRun++;
    executedTools.push({ name: call.name, args: call.args, ok: result.ok });

    emitter.onToolUpdate(id,{...call,status:result.ok?"done":"error",result:result.ok?result.output:undefined,error:result.ok?undefined:result.output});

    // Spec §3.1: result envelope <tool_result tool="..." status="ok|error">
    const resultText=renderToolResult(call.name, result.output, result.ok);
    if(plan.toolProtocol==="native"){
      session.messages.push({id:randomUUID(),role:"tool",content:result.output,toolCallId:call.id,name:call.name,createdAt:Date.now(),hidden:true} as ChatMessage);
    }else{
      session.messages.push({id:randomUUID(),role:"user",content:resultText,createdAt:Date.now(),hidden:true});
    }
    // Off-ramp: after a mutation lands, weak models loop instead of concluding
    // (retry the same write with new args, invent follow-up appends) because no
    // step ever says "done". State the stop condition explicitly: answer now
    // unless a required step (e.g. diagnostics/verification the task needs)
    // is still outstanding. Read-only successes don't need this — answering
    // from a read result is already the model's default next move.
    if(toolSpec?.sideEffecting&&result.ok&&plan.mode!=="chat"){
      session.messages.push({id:randomUUID(),role:"user",content:mutationConcludeNudge(call.name),createdAt:Date.now(),hidden:true});
    }
    // Start the next model generation in a fresh assistant message. Keeping
    // one id for the entire turn placed the conclusion above its tool cards in
    // the UI because Message renders text before tool activity.
    emitter.onDone(id);
    currentAssistantId=randomUUID();

    // Spec §5: on error, track retry — don't repeat identical failed call
    if(!result.ok){
      const key=`${call.name}:${result.output.slice(0,100)}`;
      const count=(retryCount.get(key)||0)+1;
      retryCount.set(key,count);
      if(count>=3){
        // Third failure — mark blocked per §5
        if(plan.mode==="agent"){
          const pending=todoState.find(t=>t.status==="pending"||t.status==="in_progress");
          if(pending){
            pending.status="blocked";
            (pending as any).reason=result.output.slice(0,120);
          }
        }
        const hint=result.recovery?recoveryDirective(result):undefined;
        if(hint){
          session.messages.push({id:randomUUID(),role:"user",content:hint,createdAt:Date.now(),hidden:true});
        }
      } else {
        const hint=result.recovery?recoveryDirective(result):undefined;
        if(hint){
          session.messages.push({id:randomUUID(),role:"user",content:hint,createdAt:Date.now(),hidden:true});
        }
      }
    } else {
      // Success — reset retry for this tool
      retryCount.delete(`${call.name}:${result.output.slice(0,100)}`);
      truncationRetries = 0;
    }

    // Spec §7.3 rule 5: after edit_file/write_file, get_diagnostics is expected next — model will do it
    // Spec §8: todo re-injection — render current todo state at top of every Agent turn
    // This is handled by the next iteration's system prompt via todoState

    // Spec §8: todo re-injection — if in Agent mode, inject todo state as context
    if(plan.mode==="agent" && todoState.length>0){
      const todoLine=todoState.map(t=>`[${t.id}] ${t.status}`).join("  ");
      toolCtx.log(`[todo] ${todoLine}`);
    }
  }
  commitTurnHandoff();
  if(signal.aborted){
    emitter.onDone(currentAssistantId, "Stopped.");
  } else {
    // Emit final averaged generation stats before completing the turn.
    const finalElapsed = Date.now() - turnStart;
    const finalTokens = Math.ceil(generatedChars / 4);
    const finalTps = Math.round(finalTokens / (finalElapsed / 1000));
    emitter.onGenerationStats({ tps: finalTps, totalTokens: finalTokens, elapsedMs: finalElapsed, avg: true });
    emitter.onGenerationStats(null);
    emitter.onError(`Reached the ${maxSteps}-step limit for this turn.`);
    emitter.onDone(currentAssistantId);
  }
}

function injectUser(session:{messages:ChatMessage[]},content:string):void{session.messages.push({id:randomUUID(),role:"user",content,createdAt:Date.now(),hidden:true});}

/** Graceful Chat-mode redirect when the model reaches for a workspace tool it
 *  doesn't have. Plain assistant text (never an error card): names what it
 *  tried, what file it was aiming at when known, and exactly how to get it
 *  done — switch the mode selector to Agent and ask again. */
function chatRedirectText(call:ToolCall):string{
  const target=[call.args?.path,call.args?.file,(call.args as any)?.query]
    .find(v=>typeof v==="string"&&(v as string).trim());
  const what=target?` to update \`${String(target).trim()}\``:"";
  return `I can't change files in **Chat** mode — here I can only answer questions and look things up on the web, so I couldn't run \`${call.name}\`${what}.\n\nSwitch the mode selector below from **Chat** to **Agent** and send your request again — I'll take care of it there.`;
}

/** Off-ramp after a mutation lands: without an explicit stop condition weak
 *  models loop (retry the write with new args, invent follow-up appends)
 *  instead of concluding. Read-only successes don't need this — answering
 *  from a read result is already the model's default next move. */
function mutationConcludeNudge(toolName:string):string{
  return `${toolName} succeeded. If the user's request is now fully complete, reply with a concise final answer in plain text and call no further tools. Only call another tool if a required step is still outstanding (for example verification the task needs).`;
}

/** True when the model clearly attempted a tool block but the parser yielded
 *  zero calls — a bare header, unclosed fence, or arg markers with no valid
 *  call. Only consulted when calls.length===0, so complete blocks never match. */
function looksLikeFailedToolAttempt(text:string):boolean{
  return /(TOOL_NAME\s*:|BEGIN_ARG\s*:|END_ARG|\[TOOL|tool_call|```\s*tool)/i.test(text);
}

/** Drop protocol-fragment lines (fence remnants, headers, arg markers) so a
 *  malformed attempt is never displayed as chat text. Other prose survives. */
function stripToolAttemptMarkup(text:string):string{
  const dropRe=/(TOOL_NAME\s*:|BEGIN_ARG\s*:|END_ARG\b|\[TOOL|tool_call|^\s*```\s*tool\s*$|^\s*tool\s*$)/i;
  return text.split("\n").filter(l=>!dropRe.test(l)).join("\n").trim();
}
function resolveCalls(raw:string,native:{id?:string;name:string;args:Record<string,unknown>;thoughtSignature?:string}[],specs:ToolSpec[],plan:AdaptivePlan):{calls:ToolCall[];cleanedText:string}{
  if(plan.toolProtocol==="native"&&native.length){
    const calls:ToolCall[]=native.map(c=>{
      const name=canonicalToolName(c.name,specs)??c.name;
      const v=validateAgainstSpec(name,c.args,specs);
      return{id:c.id??randomUUID(),name,args:v.args,status:(v.errors.length?"error":"proposed") as ToolCall["status"],error:v.errors.join(" "),sideEffecting:specs.find(s=>s.name===name)?.sideEffecting,thoughtSignature:c.thoughtSignature};
    });
    return{calls,cleanedText:stripToolMarkup(raw)};
  }
  const parsed=parsePhotonBlocks(raw,specs);
  const calls:ToolCall[]=parsed.calls.map(p=>({id:randomUUID(),name:p.name,args:p.args,status:(p.errors.length?"error":"proposed") as ToolCall["status"],error:p.errors.join(" "),sideEffecting:specs.find(s=>s.name===p.name)?.sideEffecting}));
  return{calls,cleanedText:parsed.cleanedText};
}
function historyToLLM(messages:ChatMessage[],plan:AdaptivePlan):LLMMessage[]{const out:LLMMessage[]=[];for(const m of messages){if(m.role==="user")out.push({role:"user",content:m.content,images:m.attachments?.filter(a=>a.kind==="image"&&a.dataBase64).map(a=>a.dataBase64 as string)});else if(m.role==="assistant"){const calls=(m.toolCalls??[]).filter(c=>c.status!=="error");if(m.content.trim()||calls.length)out.push({role:"assistant",content:m.content,tool_calls:plan.toolProtocol==="native"&&calls.length?calls.map(c=>({id:c.id,function:{name:c.name,arguments:c.args},thoughtSignature:c.thoughtSignature})):undefined});}else if(m.role==="tool")out.push({role:"tool",content:m.content,tool_call_id:m.toolCallId,name:(m as any).name});}return out;}
function lastUser(messages:ChatMessage[]):string|undefined{for(let i=messages.length-1;i>=0;i--)if(messages[i].role==="user")return messages[i].content;return undefined;}
function lastToolSucceeded(messages:ChatMessage[]):boolean{
  for(let i=messages.length-1;i>=0;i--){
    const message=messages[i];
    if(message.role==="tool")return !/^error:/i.test(message.content.trim());
    if(message.role!=="user"||!message.hidden||!message.content.includes("<tool_result"))continue;
    return /<tool_result\b[^>]*status="ok"/i.test(message.content);
  }
  return false;
}

/** Build a copy-paste-ready tool block for a failed call, reusing the args the
 *  model already supplied and marking the missing required ones. Small models
 *  copy a concrete example far more reliably than they follow an error message. */
function renderCorrectExample(spec:ToolSpec,args:Record<string,unknown>):string{
  const lines=["```tool",`TOOL_NAME: ${spec.name}`];
  for(const p of spec.params){
    const v=args[p.name];
    const val=(v!==undefined&&v!==null&&String(v).trim()!=="")?String(v):`<${p.name}>`;
    lines.push(`BEGIN_ARG: ${p.name}`,val,"END_ARG");
  }
  lines.push("```");
  return lines.join("\n");
}

function isGreetingOnly(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.,?]+$/g, "").trim();
  if (!t) return true;
  const greetingRe = /^(hi|hello|hey|hiya|howdy|yo|sup|greetings|good\s*(morning|afternoon|evening)|thanks|thank\s*you|thx|bye|goodbye|ok|okay|cool|nice|great|awesome|hello\s*there|hi\s*there|what's\s*up|whats\s*up)[\s!.,?]*$/i;
  return greetingRe.test(t);
}
