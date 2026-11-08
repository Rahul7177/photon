import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { SessionState, SessionSummary } from "../shared/types";

const STORAGE_KEY = "photon.sessions";
export const SESSION_STORE_SCHEMA_VERSION = 2;
const MAX_SESSIONS = 40;
// Persisted caps — prevent globalState blowup (critical audit). Live session keeps full content.
const MAX_PERSISTED_MSG_CONTENT = 8000;
const MAX_PERSISTED_TOOL_RESULT = 6000;
const MAX_PERSISTED_THINKING = 2000;
const MAX_PERSISTED_MESSAGES = 200; // per-session persisted cap (live keeps 400)

export interface PersistedSessionStoreEnvelope {
  version: number;
  sessions: SessionState[];
  trimmedCount?: number;
  updatedAt: number;
}

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_\-\.]{20,}/gi,
  /sk-[a-zA-Z0-9_\-]{20,}/g,
  /sk-ant-[a-zA-Z0-9_\-]{20,}/g,
  /AIzaSy[a-zA-Z0-9_\-]{33}/g,
  /gh[pousr]_[A-Za-z0-9_]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?:api[_-]?key|secret|token|password|auth)\s*[:=]\s*["']?([A-Za-z0-9_\-\.]{16,})["']?/gi,
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.startsWith("Bearer ") || match.startsWith("bearer ")) {
        return "Bearer [REDACTED]";
      }
      return "[REDACTED_SECRET]";
    });
  }
  return redacted;
}

export function sanitizeArgs(args?: Record<string, unknown>): Record<string, unknown> {
  if (!args) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const lowerKey = k.toLowerCase();
    if (
      lowerKey.includes("key") ||
      lowerKey.includes("token") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("password") ||
      lowerKey.includes("auth")
    ) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "string") {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Persists chat sessions across window reloads via globalState. */
export class SessionStore {
  onDidTrim?: (trimmedCount: number, titles: string[]) => void;
  lastTrimmedSessions: string[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  loadAll(): SessionState[] {
    const raw = this.context.globalState.get<unknown>(STORAGE_KEY, []);
    let rawList: unknown[] = [];
    if (Array.isArray(raw)) {
      // Legacy v1 schema
      rawList = raw;
    } else if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).sessions)) {
      // v2+ envelope
      rawList = (raw as Record<string, unknown>).sessions as unknown[];
    }

    return rawList
      .map(validateAndSanitizeRestoredSession)
      .filter((s): s is SessionState => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async upsert(session: SessionState): Promise<void> {
    const toPersist = capForStorage(session);
    const all = this.loadAll();
    const idx = all.findIndex((s) => s.id === toPersist.id);
    if (idx === -1) all.unshift(toPersist);
    else all[idx] = toPersist;

    all.sort((a, b) => b.updatedAt - a.updatedAt);
    const trimmed = all.slice(0, MAX_SESSIONS);

    const droppedSessionTitles: string[] = [];
    const envelope: PersistedSessionStoreEnvelope = {
      version: SESSION_STORE_SCHEMA_VERSION,
      sessions: trimmed,
      updatedAt: Date.now(),
    };
    let payload = JSON.stringify(envelope);

    while (payload.length > 4_000_000 && trimmed.length > 1) {
      const dropped = trimmed.pop();
      if (dropped) {
        droppedSessionTitles.push(dropped.title || dropped.id);
      }
      envelope.sessions = trimmed;
      envelope.trimmedCount = (envelope.trimmedCount || 0) + 1;
      payload = JSON.stringify(envelope);
    }

    if (droppedSessionTitles.length > 0) {
      this.lastTrimmedSessions = droppedSessionTitles;
      this.onDidTrim?.(droppedSessionTitles.length, droppedSessionTitles);
      console.warn(
        `[sessionStore] Trimmed ${droppedSessionTitles.length} session(s) to remain within storage limit: ${droppedSessionTitles.join(", ")}`
      );
    }

    await this.context.globalState.update(STORAGE_KEY, envelope);
  }

  async remove(id: string): Promise<void> {
    const all = this.loadAll().filter((s) => s.id !== id);
    const envelope: PersistedSessionStoreEnvelope = {
      version: SESSION_STORE_SCHEMA_VERSION,
      sessions: all,
      updatedAt: Date.now(),
    };
    await this.context.globalState.update(STORAGE_KEY, envelope);
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

export function validateAndSanitizeRestoredSession(raw: unknown): SessionState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawObj = raw as Record<string, unknown>;
  if (typeof rawObj.id !== "string" || !rawObj.id.trim()) return null;

  const title = typeof rawObj.title === "string" ? rawObj.title : "Untitled Session";
  const mode = ["chat", "code", "architect", "ask"].includes(rawObj.mode as string) ? (rawObj.mode as any) : "chat";
  const model = typeof rawObj.model === "string" ? rawObj.model : "";
  const createdAt =
    typeof rawObj.createdAt === "number" && Number.isFinite(rawObj.createdAt) ? rawObj.createdAt : Date.now();
  const updatedAt =
    typeof rawObj.updatedAt === "number" && Number.isFinite(rawObj.updatedAt) ? rawObj.updatedAt : createdAt;

  const rawMessages = Array.isArray(rawObj.messages) ? rawObj.messages : [];
  const validMessages = rawMessages
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string")
    .map((m) => {
      const role = ["user", "assistant", "system"].includes(m.role as string) ? (m.role as any) : "user";
      const content = typeof m.content === "string" ? m.content : "";
      const validToolCalls = Array.isArray(m.toolCalls)
        ? (m.toolCalls as unknown[])
            .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string")
            .map((c) => ({
              id: typeof c.id === "string" ? c.id : `call_${randomUUID()}`,
              name: String(c.name),
              args: typeof c.args === "object" && c.args !== null ? (c.args as Record<string, unknown>) : {},
              status: c.status === "done" ? ("done" as const) : ("error" as const),
              result: typeof c.result === "string" ? c.result : undefined,
              error: c.status === "done" ? undefined : (typeof c.error === "string" ? c.error : "Interrupted before completion."),
            }))
        : undefined;

      const validAttachments = Array.isArray(m.attachments)
        ? (m.attachments as unknown[])
            .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
            .map((a) => ({
              id: typeof a.id === "string" ? a.id : `att_${randomUUID()}`,
              kind: a.kind === "text" ? ("text" as const) : ("image" as const),
              name: typeof a.name === "string" ? a.name : "attachment",
              mime: typeof a.mime === "string" ? a.mime : typeof a.mimeType === "string" ? a.mimeType : "application/octet-stream",
              size: typeof a.size === "number" ? a.size : 0,
              url: typeof a.url === "string" ? a.url : undefined,
              dataBase64: typeof a.dataBase64 === "string" ? a.dataBase64 : undefined,
              text: typeof a.text === "string" ? a.text : undefined,
              isPruned: Boolean(a.isPruned),
            }))
        : undefined;

      return {
        id: String(m.id),
        role,
        content,
        createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
        streaming: false,
        toolCalls: validToolCalls,
        attachments: validAttachments,
        notice: typeof m.notice === "string" ? m.notice : undefined,
        isCompacted: Boolean(m.isCompacted),
        compactStats:
          m.compactStats && typeof m.compactStats === "object"
            ? {
                messagesCount: Number((m.compactStats as Record<string, unknown>).messagesCount ?? 0),
                tokensSaved: Number((m.compactStats as Record<string, unknown>).tokensSaved ?? 0),
                pctSaved: Number((m.compactStats as Record<string, unknown>).pctSaved ?? 0),
                strategy:
                  typeof (m.compactStats as Record<string, unknown>).strategy === "string"
                    ? String((m.compactStats as Record<string, unknown>).strategy)
                    : undefined,
              }
            : undefined,
        checkpointId: typeof m.checkpointId === "string" ? m.checkpointId : undefined,
        checkpointFiles: Array.isArray(m.checkpointFiles) ? m.checkpointFiles : undefined,
        checkpointNumber: typeof m.checkpointNumber === "number" ? m.checkpointNumber : undefined,
      };
    });

  return {
    id: String(rawObj.id),
    title,
    mode,
    model,
    createdAt,
    updatedAt,
    messages: validMessages,
  };
}

export function capForStorage(s: SessionState): SessionState {
  const msgs =
    s.messages.length > MAX_PERSISTED_MESSAGES
      ? s.messages.slice(-MAX_PERSISTED_MESSAGES)
      : s.messages;
  return {
    ...s,
    messages: msgs.map((m) => {
      let content = redactSecrets(m.content);
      if (content.length > MAX_PERSISTED_MSG_CONTENT) {
        content =
          content.slice(0, MAX_PERSISTED_MSG_CONTENT) +
          `\n… [truncated ${content.length - MAX_PERSISTED_MSG_CONTENT} chars for storage]`;
      }
      let thinking = m.thinking ? redactSecrets(m.thinking) : undefined;
      if (thinking && thinking.length > MAX_PERSISTED_THINKING) {
        thinking = thinking.slice(0, MAX_PERSISTED_THINKING) + `\n… [truncated]`;
      }
      const toolCalls = m.toolCalls?.map((c) => {
        let result = c.result ? redactSecrets(c.result) : undefined;
        if (result && result.length > MAX_PERSISTED_TOOL_RESULT) {
          result = result.slice(0, MAX_PERSISTED_TOOL_RESULT) + `… [truncated]`;
        }
        return {
          ...c,
          args: sanitizeArgs(c.args),
          result,
        };
      });
      return {
        ...m,
        streaming: false,
        content,
        thinking,
        toolCalls,
      };
    }),
  };
}
