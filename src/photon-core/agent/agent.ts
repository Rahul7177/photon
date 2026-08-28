import { randomUUID } from "node:crypto";
import type { PhotonSession, SessionRegistry } from "../session/store";
import type { SessionId } from "../session/types";
import { Inbox } from "./inbox";
import type { AgentOptions, AgentStatus } from "./types";

export class PhotonAgent {
  readonly id: string;
  readonly session: PhotonSession;
  readonly inbox = new Inbox();
  status: AgentStatus = "idle";
  options: AgentOptions;
  // scoped context — registrations made via agent.ctx (tools, prompt sections)
  // Harness parity: Agent.ctx isolates per-agent capability sets (presets)
  readonly ctx: PhotonAgentContext;

  private abortCtrl?: AbortController;
  private idleResolvers: Set<() => void> = new Set();

  constructor(id: string, session: PhotonSession, options: AgentOptions, ctx: PhotonAgentContext) {
    this.id = id;
    this.session = session;
    this.options = options;
    this.ctx = ctx;
  }

  followup(content: string, source: { kind: "user" } | { kind: "plugin"; plugin: string } = { kind: "user" }, attachments?: any[]): void {
    this.inbox.push({ content, attachments, source, wake: true });
  }
  steer(content: string, source: { kind: "plugin"; plugin: string } = { kind: "plugin", plugin: "photon" }): void {
    this.inbox.push({ content, source, wake: true });
  }
  inject(content: string): void {
    this.inbox.push({ content, source: { kind: "injected" }, wake: false });
  }

  cancel(cause?: string, opts?: { keepInbox?: boolean }): void {
    this.abortCtrl?.abort(cause ?? "cancelled");
    if (!opts?.keepInbox) this.inbox.clear();
    this.status = "cancelling";
  }

  whenIdle(): Promise<void> {
    if (this.status === "idle") return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.add(resolve));
  }

  // Driver-owned — called by AgentLoop
  _setRunning(ctrl: AbortController) { this.abortCtrl = ctrl; this.status = "running"; }
  _setIdle() {
    this.status = "idle";
    this.abortCtrl = undefined;
    for (const r of this.idleResolvers) r();
    this.idleResolvers.clear();
  }
  get signal(): AbortSignal | undefined { return this.abortCtrl?.signal; }
}

export class PhotonAgentContext {
  // Per-agent registries — shallow copy of global, then mutated via agent.ctx
  tools: Map<string, any> = new Map();
  promptSections: Map<string, { content: string; priority: number }> = new Map();
  private disposers: (() => void)[] = [];

  registerTool(name: string, tool: any): () => void {
    this.tools.set(name, tool);
    return () => this.tools.delete(name);
  }
  registerPromptSection(id: string, content: string, priority = 0): () => void {
    this.promptSections.set(id, { content, priority });
    return () => this.promptSections.delete(id);
  }
  dispose() { for (const d of this.disposers.splice(0)) d(); this.tools.clear(); this.promptSections.clear(); }
}

export class AgentRegistry {
  private agents = new Map<string, PhotonAgent>();
  private sessions: SessionRegistry;

  constructor(sessions: SessionRegistry) { this.sessions = sessions; }

  create(sessionId?: string, options: AgentOptions = { provider: "ollama", model: "" }, meta: any = {}): PhotonAgent {
    const sid = (sessionId ?? randomUUID()) as SessionId;
    let session = this.sessions.get(sid);
    if (!session) session = this.sessions.create(sid, meta);
    const ctx = new PhotonAgentContext();
    const agent = new PhotonAgent(randomUUID(), session, options, ctx);
    this.agents.set(agent.id, agent);
    return agent;
  }

  resume(sessionId: SessionId, options?: Partial<AgentOptions>): PhotonAgent | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const ctx = new PhotonAgentContext();
    const agent = new PhotonAgent(randomUUID(), session, { provider: "ollama", model: "", ...options } as AgentOptions, ctx);
    this.agents.set(agent.id, agent);
    return agent;
  }

  get(id: string) { return this.agents.get(id); }
  list() { return [...this.agents.values()]; }
  delete(agent: PhotonAgent) { agent.ctx.dispose(); this.agents.delete(agent.id); }
}
