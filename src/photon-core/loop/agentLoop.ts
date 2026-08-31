import { randomUUID } from "node:crypto";
import type { PhotonAgent } from "../agent/agent";
import type { PhotonSession } from "../session/store";
import type { LlmAdapter } from "../llm/types.v2";
import type { ToolPipeline } from "../tools/pipeline";
import type { SystemPromptRegistry } from "../systemPrompt/registry";
import { buildSystemPrompt } from "../../core/prompts/system";
import { renderToolInstructions, renderToolResult, toNativeTools } from "../../core/protocol/serialize";
import { parsePhotonBlocks, stripToolMarkup, validateAgainstSpec } from "../../core/protocol/parse";
import { fitToWindow } from "../../core/agent/contextManager";
import { buildRepairPrompt, MAX_REPAIRS } from "../../core/agent/repair";
import { estimateTokens } from "../../core/adaptive/tokens";
import { buildWorkspaceMap } from "../../core/tools/workspaceMap";
import type { AdaptivePlan, ToolCall } from "../../shared/types";
import type { LLMMessage } from "../../core/llm/types";

type LoopDeps = {
  llm: LlmAdapter;
  tools: ToolPipeline;
  systemPrompt: SystemPromptRegistry;
  workspaceName?: string;
  retrieveContext?: (query: string, signal: AbortSignal) => Promise<string | undefined>;
  reserveOutputTokens: number;
  buildPlan: (prompt: string, mode: any, attachmentsCount: number) => AdaptivePlan | null;
  buildToolContext: (signal: AbortSignal, capability: any) => import("../../core/tools/types").ToolContext;
};

// Harness parity: turn/start -> agent/pre-step -> step/start -> llm/stream -> assistant/chunk* -> tool/call -> step/end -> turn/end
export class AgentLoop {
  // waterfall listeners for agent/pre-step and agent/request
  private preStepListeners: Array<(decision: any, next: () => Promise<any>) => Promise<any>> = [];
  constructor(private deps: LoopDeps) {}
  onPreStep(fn: any) { this.preStepListeners.push(fn); }

  async run(agent: PhotonAgent): Promise<void> {
    const ctrl = new AbortController();
    agent._setRunning(ctrl);
    const signal = ctrl.signal;
    const session = agent.session;

    try {
      while (!signal.aborted) {
        const inbox = agent.inbox.claim();
        if (!inbox) { await agent.inbox.waitForWake(signal).catch(()=>{}); if (signal.aborted) break; continue; }

        // turn/start — durable
        const turnId = randomUUID();
        session.append("turn/start", { turnId, at: Date.now() } as any);
        const userContents = inbox.map(i => i.content).join("\n\n");
        for (const item of inbox) {
          session.append("user/message", { id: item.id, content: item.content, attachments: item.attachments, source: item.source, createdAt: Date.now() } as any);
        }
        // title once
        if (session.allEvents().filter(e=>e.type==="user/message").length === inbox.length) session.setTitle(userContents.slice(0,40));

        // agent/pre-step waterfall — intelligence plugin computes AdaptivePlan here
        let plan: AdaptivePlan | null = this.deps.buildPlan(userContents, agent.options as any, inbox.reduce((n,i)=>n+(i.attachments?.length??0),0));
        if (!plan) { session.append("turn/end", { turnId, reason: "error", at: Date.now() } as any); continue; }
        // allow listeners to rewrite plan/decision
        let decision: any = { kind: "enter", messages: inbox, plan: plan! };
        for (const fn of this.preStepListeners) {
          let nextCalled = false;
          const next = async () => { nextCalled = true; return decision; };
          const out = await fn(decision, next);
          if (!nextCalled) { decision = out; break; }
          decision = out;
        }
        if (decision.kind === "reject") { session.append("turn/end", { turnId, reason: "aborted", at: Date.now() } as any); continue; }
        plan = (decision.plan ?? plan)!;

        // derive history + system
        const specs = this.deps.tools.specsForPlan(plan!);
        const toolInstructions = plan!.toolProtocol === "photon-block" ? renderToolInstructions(specs, plan!) : "";
        // workspace map + retrieved context — like engine.ts
        const wantsMap = plan!.mode !== "chat";
        const workspaceMap = wantsMap ? await buildWorkspaceMap(undefined).catch(()=>undefined) : undefined;
        const wantsRetrieval = wantsMap && plan!.intelligence !== "low";
        const retrievedContext = wantsRetrieval && this.deps.retrieveContext ? await this.deps.retrieveContext(userContents, signal).catch(()=>undefined) : undefined;
        const system = this.deps.systemPrompt.assemble({ mode: plan!.mode, plan: plan!, toolInstructions, workspaceName: this.deps.workspaceName, workspaceMap, retrievedContext } as any) || buildSystemPrompt({ mode: plan!.mode, plan: plan!, toolInstructions, workspaceName: this.deps.workspaceName, workspaceMap, retrievedContext } as any);
        session.append("request/header", { provider: this.deps.llm.id, model: plan!.model, systemPrompt: system, tools: plan!.toolProtocol==="native"? toNativeTools(specs): [], temperature: plan!.temperature, contextWindow: plan!.numCtx, reason: "initial" } as any);

        // step loop — bounded by mode
        const maxSteps: Record<string, number> = { chat: 1, plan: 50, agent: 100 };
        const max = (maxSteps[plan!.mode] ?? 10);
        let stepIdx = 0;
        let shouldContinue = true;
        const executed = new Set<string>();
        let turnsWithoutProgress = 0;

        while (shouldContinue && stepIdx < max && !signal.aborted) {
          const stepId = randomUUID();
          session.append("step/start", { stepId, turnId, at: Date.now() } as any);
          const history = sessionToLLM(session, plan!);
          // fitToWindow for local; cloud uses its own fit but we reuse
          const budget = plan!.numCtx - plan!.maxOutputTokens;
          const fit = fitToWindow({ role: "system", content: system } as LLMMessage, history, budget, plan!.numCtx, plan!.model);
          const messagesForLlm = fit.messages.slice(1); // system already in header
          const toolCtx = this.deps.buildToolContext(signal, plan!.intelligence);

          // stream — harness llm/stream waterfall would wrap here
          let raw = "";
          let toolCallsRaw: any[] = [];
          let doneReason: string | undefined;
          try {
            for await (const chunk of this.deps.llm.stream({ provider: this.deps.llm.id, model: plan!.model, messages: messagesForLlm, system, tools: plan!.toolProtocol==="native"? toNativeTools(specs): undefined, temperature: plan!.temperature, signal })) {
              if (chunk.type === "text-delta") { raw += chunk.text; session.append("assistant/chunk", { id: stepId, delta: chunk.text, model: plan!.model, seq: raw.length } as any); }
              else if (chunk.type === "tool-call-delta" && chunk.name) toolCallsRaw.push({ name: chunk.name, args: JSON.parse(chunk.argumentsDelta || "{}") });
              else if (chunk.type === "finish") doneReason = chunk.reason;
            }
          } catch (e) { if (signal.aborted) break; session.append("assistant/message", { id: stepId, content: `Model error: ${(e as Error).message}`, model: plan!.model, createdAt: Date.now() } as any); break; }

          // resolve tool calls — FIX: repair truncated single-line content issue (parseBody fence handling)
          let calls = resolveCalls(raw, toolCallsRaw, specs, plan!);
          // strip tool markup for visible assistant message
          const visible = stripToolMarkup(raw);
          if (visible.trim() || calls.length===0) session.append("assistant/message", { id: stepId, content: visible, model: plan!.model, createdAt: Date.now() } as any);

          if (calls.length===0) {
            // continuation / cut-off guards — generous like DeepSeek/Opencode (up to 5)
            const cutOff = isLengthCutoff(doneReason) || hasUnclosedFence(raw);
            if (cutOff && stepIdx < 5) { session.append("user/message", { id: randomUUID(), content: "Your reply was cut off mid-output. Continue EXACTLY where you stopped.", source: { kind: "injected" }, createdAt: Date.now() } as any); stepIdx++; session.append("step/end", { stepId, turnId, at: Date.now() } as any); continue; }
            const intent = plan!.mode!=="chat" ? continuationIntent(raw, specs) : undefined;
            if (intent && stepIdx < 5) { session.append("user/message", { id: randomUUID(), content: intent==="format"?"Your reply described a tool use but contained no valid call. Use [TOOL name] format.":"You stopped after describing next steps but made no tool call. Call the next tool or summarize.", source: { kind: "injected" }, createdAt: Date.now() } as any); stepIdx++; session.append("step/end", { stepId, turnId, at: Date.now() } as any); continue; }
            session.append("step/end", { stepId, turnId, at: Date.now() } as any); break;
          }

          // repair when all error
          if (!calls.some(c=>c.status!=="error")) {
            const repaired = await attemptRepair(calls, session, plan!, specs, signal, toolCtx);
            if (repaired.length) calls = repaired; else { session.append("step/end", { stepId, turnId, at: Date.now() } as any); break; }
          }

          let ranNew = false;
          const toRun = plan!.allowParallelTools? calls : calls.slice(0,1);
          for (const call of toRun) {
            // Path-keyed dedup (mirrors engine.ts dupKey) — avoids hashing huge write content
            const sigKey = (call.name==="write_file"||call.name==="read_file"||call.name==="edit_file") ? `${call.name}|${(call.args as any).path}` : `${call.name}|${JSON.stringify(call.args)}`;
            const sig = sigKey;
            if (executed.has(sig)) {
              session.append("tool/result", { callId: call.id, name: call.name, output: "You already ran this exact call. Use earlier result.", ok: false } as any);
              continue;
            }
            executed.add(sig);
            session.append("tool/call", { id: call.id, name: call.name, args: call.args, attempt: 1 } as any);
            const res = await this.deps.tools.execute(call as any, toolCtx);
            session.append("tool/result", { callId: call.id, name: call.name, output: res.output, ok: res.ok } as any);
            ranNew = true;
          }
          session.append("step/end", { stepId, turnId, at: Date.now() } as any);
          if (!ranNew && ++turnsWithoutProgress >=5) break;
          // loop to next step — model sees tool results via deriveMessages
          stepIdx++;
          // if chat mode, one step is enough
          if (plan!.mode==="chat") shouldContinue=false;
          else shouldContinue = true; // continue until model replies without tools
          // but break if no tools were run and not cut off
          if (calls.length===0) shouldContinue=false;
        }
        session.append("turn/end", { turnId, reason: "stop", at: Date.now() } as any);
      }
    } finally {
      agent._setIdle();
    }
  }
}

function sessionToLLM(session: PhotonSession, plan: AdaptivePlan): LLMMessage[] {
  const msgs = session.deriveMessages().filter(m=>m.role!=="system");
  return msgs.map(m => ({
    role: m.role as any,
    content: m.content,
    tool_calls: (m as any).tool_calls,
    tool_call_id: (m as any).tool_call_id,
    name: (m as any).name,
  }));
}
function resolveCalls(raw: string, nativeCalls: any[], specs: any[], plan: AdaptivePlan): any[] {
  if (plan.mode==="chat") return [];
  if (plan.toolProtocol==="native" && nativeCalls.length) {
    return nativeCalls.map((c:any)=>{ const {args, errors}=validateAgainstSpec(c.name, c.args??{}, specs); return { id: randomUUID(), name:c.name, args, status: errors.length?"error":"proposed", error: errors.join(" ") }; });
  }
  const parsed = parsePhotonBlocks(raw, specs);
  return parsed.calls.map(p=>({ id: randomUUID(), name:p.name, args:p.args, status: p.errors.length?"error":"proposed", error:p.errors.join(" ") }));
}
async function attemptRepair(calls: any[], session: PhotonSession, plan: AdaptivePlan, specs: any[], signal: AbortSignal, ctx: any): Promise<any[]> {
  let errors = calls.filter(c=>c.status==="error").map(c=>`${c.name}: ${c.error}`);
  for (let attempt=1; attempt<=MAX_REPAIRS; attempt++) {
    if (signal.aborted) return [];
    session.append("user/message", { id: randomUUID(), content: buildRepairPrompt(errors, specs, plan), source: { kind: "injected" }, createdAt: Date.now() } as any);
    // single-shot repair stream omitted for brevity — return [] to degrade gracefully
    return [];
  }
  return [];
}
function isLengthCutoff(r?: string){ if(!r) return false; const s=r.toLowerCase(); return s==="length"||s==="max_tokens"||s==="maxoutputtokens"; }
function hasUnclosedFence(t: string){ const m=t.match(/```/g); return !!m && m.length%2===1; }
function continuationIntent(raw: string, specs: any[]): "format"|"continue"|undefined {
  for (const s of specs) {
    const re = new RegExp(`(?:\\[TOOL\\s*|<tool_call>|\"(?:name|tool)\"\\s*:\\s*\"|\\b)${s.name}\\s*\\(`, "i");
    if (re.test(raw)) return "format";
  }
  if (/\b(let me|i'll|i will|going to|now let|then,|first,)\b/i.test(raw)) return "continue";
  return undefined;
}
