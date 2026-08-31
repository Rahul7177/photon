import { randomUUID } from "node:crypto";
import type { SessionEvent, SessionEventMap, SessionEventType, SessionId, DerivedMessage } from "./types";

export class PhotonSession {
  readonly id: SessionId;
  private events: SessionEvent[] = [];
  private seq = 0;
  private listeners: Set<(e: SessionEvent) => void> = new Set();
  meta: { cwd?: string; workspaceName?: string; createdAt: number };

  constructor(id: SessionId, meta: { cwd?: string; workspaceName?: string }) {
    this.id = id;
    this.meta = { ...meta, createdAt: Date.now() };
    this.append("session/created", { sessionId: id, meta: this.meta } as any, { at: this.meta.createdAt });
  }
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], opts?: { at?: number }): SessionEvent<T> {
    const ev: SessionEvent<T> = { seq: this.seq++, type, data: structuredClone(data) as any, at: opts?.at ?? Date.now() };
    try { JSON.stringify(ev.data); } catch { throw new Error(`SessionEvent ${type} payload not JSON-serializable`); }
    this.events.push(ev as SessionEvent);
    for (const l of this.listeners) l(ev as SessionEvent);
    return ev;
  }
  onEvent(listener: (e: SessionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  allEvents(): readonly SessionEvent[] { return this.events; }
  fork(boundarySeq?: number, childId?: SessionId): PhotonSession {
    const boundary = boundarySeq ?? this.events.length - 1;
    const slice = this.events.filter(e => e.seq <= boundary);
    const openTurn = slice.filter(e=>e.type==="turn/start").length !== slice.filter(e=>e.type==="turn/end").length;
    if (openTurn) throw new Error("fork boundary must end outside an open turn");
    const child = new PhotonSession((childId ?? randomUUID()) as SessionId, this.meta);
    for (const e of slice) if (e.type !== "session/created") (child as any).events.push({ ...e, seq: child.seq++ });
    return child;
  }
  deriveMessages(): DerivedMessage[] {
    const out: DerivedMessage[] = [];
    let system: string | undefined;
    for (const e of this.events) if (e.type === "request/header") system = (e.data as any).systemPrompt;
    if (system) out.push({ role: "system", content: system });
    for (const e of this.events) {
      if (e.type === "user/message") {
        const d = e.data as SessionEventMap["user/message"];
        let content = d.content;
        for (const a of d.attachments ?? []) if (a.kind === "text" && a.text) content += `\n\n--- Attached file: ${a.name} ---\n${a.text}\n--- end ${a.name} ---`;
        out.push({ role: "user", content, id: d.id });
      } else if (e.type === "assistant/message") {
        const d = e.data as SessionEventMap["assistant/message"];
        if (d.content.trim() || d.toolCalls?.length) out.push({
          role: "assistant", content: d.content, id: d.id,
          tool_calls: d.toolCalls?.map(c => ({ id: c.id, function: { name: c.name, arguments: c.args } }))
        });
      } else if (e.type === "tool/result") {
        const d = e.data as SessionEventMap["tool/result"];
        out.push({ role: "tool", content: d.output, tool_call_id: d.callId, name: d.name });
      }
    }
    return out;
  }
  title(): string | undefined { for (let i=this.events.length-1;i>=0;i--) if(this.events[i].type==="session/title") return (this.events[i].data as any).title; return undefined; }
  setTitle(title: string) { this.append("session/title", { title } as any); }
}

export class SessionRegistry {
  private sessions = new Map<SessionId, PhotonSession>();
  create(id?: string, meta: { cwd?: string; workspaceName?: string } = {}): PhotonSession { const sid=(id??randomUUID()) as SessionId; const s=new PhotonSession(sid,meta); this.sessions.set(sid,s); return s; }
  get(id: SessionId) { return this.sessions.get(id); }
  list() { return [...this.sessions.values()]; }
  delete(id: SessionId) { this.sessions.delete(id); }
  hydrate(events: SessionEvent[], meta: any): PhotonSession {
    const id=(events.find(e=>e.type==="session/created")?.data as any)?.sessionId as SessionId;
    if(!id) throw new Error("hydrate: missing session/created");
    const s=new PhotonSession(id,meta); (s as any).events=[...events]; (s as any).seq=events.length; this.sessions.set(id,s); return s;
  }
}
