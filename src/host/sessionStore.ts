import * as vscode from "vscode";
import type { SessionState, SessionSummary } from "../shared/types";

const STORAGE_KEY = "photon.sessions";
const MAX_SESSIONS = 40;
// Persisted caps — prevent globalState blowup (critical audit). Live session keeps full content.
const MAX_PERSISTED_MSG_CONTENT = 8000;
const MAX_PERSISTED_TOOL_RESULT = 6000;
const MAX_PERSISTED_MESSAGES = 200; // per-session persisted cap (live keeps 400)

/** Persists chat sessions across window reloads via globalState. */
export class SessionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  loadAll(): SessionState[] {
    const raw = this.context.globalState.get<SessionState[]>(STORAGE_KEY, []);
    return [...raw].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async upsert(session: SessionState): Promise<void> {
    // Persist a capped clone — live session retains full fidelity, stored copy is truncated.
    const toPersist = capForStorage(session);
    const all = this.loadAll();
    const idx = all.findIndex((s) => s.id === toPersist.id);
    if (idx === -1) all.unshift(toPersist);
    else all[idx] = toPersist;

    all.sort((a, b) => b.updatedAt - a.updatedAt);
    const trimmed = all.slice(0, MAX_SESSIONS);
    // Hard JSON-size guard: drop oldest sessions if serialized payload exceeds ~4 MB.
    let payload = JSON.stringify(trimmed);
    let guard = [...trimmed];
    while (payload.length > 4_000_000 && guard.length > 1) {
      guard.pop();
      payload = JSON.stringify(guard);
    }
    await this.context.globalState.update(STORAGE_KEY, guard);
  }

  async remove(id: string): Promise<void> {
    const all = this.loadAll().filter((s) => s.id !== id);
    await this.context.globalState.update(STORAGE_KEY, all);
  }

  get(id: string): SessionState | undefined {
    return this.loadAll().find((s) => s.id === id);
  }

  summaries(): SessionSummary[] {
    return this.loadAll().map(toSummary);
  }
}

export function toSummary(session: SessionState): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    mode: session.mode,
    model: session.model,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

function capForStorage(s: SessionState): SessionState {
  const msgs = s.messages.length > MAX_PERSISTED_MESSAGES ? s.messages.slice(-MAX_PERSISTED_MESSAGES) : s.messages;
  return {
    ...s,
    messages: msgs.map((m) => ({
      ...m,
      content: m.content.length > MAX_PERSISTED_MSG_CONTENT ? m.content.slice(0, MAX_PERSISTED_MSG_CONTENT) + `\n… [truncated ${m.content.length - MAX_PERSISTED_MSG_CONTENT} chars for storage]` : m.content,
      toolCalls: m.toolCalls?.map((c) => ({
        ...c,
        result: c.result && c.result.length > MAX_PERSISTED_TOOL_RESULT ? c.result.slice(0, MAX_PERSISTED_TOOL_RESULT) + `… [truncated]` : c.result,
      })),
    })),
  };
}
