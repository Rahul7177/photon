import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { SessionState, SessionSummary } from "../shared/types";
import { pruneInlineImages } from "./sessionCoordinator";

const STORAGE_KEY = "photon.sessions";
export const SESSION_STORE_SCHEMA_VERSION = 2;
const MAX_SESSIONS = 40;
export const MAX_PINNED_SESSIONS = 3;
// Persisted caps — prevent globalState blowup (critical audit). Live session keeps full content.
const MAX_PERSISTED_MSG_CONTENT = 8000;
const MAX_PERSISTED_TOOL_RESULT = 6000;
const MAX_PERSISTED_THINKING = 2000;
const MAX_PERSISTED_ATTACHMENT_TEXT = 4000;
const MAX_PERSISTED_ATTACHMENT_BASE64 = 350_000;
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
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

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
      .sort(compareSessions);
  }

  async upsert(session: SessionState): Promise<void> {
    return this.enqueue(async () => {
      const toPersist = capForStorage(session);
      const all = this.loadAll();
      const idx = all.findIndex((s) => s.id === toPersist.id);
      if (idx === -1) {
        all.unshift(toPersist);
      } else {
        // Preserve existing pin state if caller didn't carry it
        const existing = all[idx];
        if (toPersist.pinned === undefined && existing.pinned) {
          toPersist.pinned = true;
          toPersist.pinnedAt = existing.pinnedAt;
        }
        all[idx] = toPersist;
      }

      all.sort(compareSessions);
      const trimmed = evictOverSessionCap(all, MAX_SESSIONS, toPersist.id);

      const droppedSessionTitles: string[] = [];
      const envelope: PersistedSessionStoreEnvelope = {
        version: SESSION_STORE_SCHEMA_VERSION,
        sessions: trimmed,
        updatedAt: Date.now(),
      };
      let payload = JSON.stringify(envelope);

      while (payload.length > 4_000_000 && trimmed.length > 1) {
        const dropIdx = findEvictableIndex(trimmed, toPersist.id);
        const [dropped] = trimmed.splice(dropIdx, 1);
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
    });
  }

  async remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const all = this.loadAll().filter((s) => s.id !== id);
      const envelope: PersistedSessionStoreEnvelope = {
        version: SESSION_STORE_SCHEMA_VERSION,
        sessions: all,
        updatedAt: Date.now(),
      };
      await this.context.globalState.update(STORAGE_KEY, envelope);
    });
  }

  async togglePin(id: string): Promise<{ ok: boolean; pinned: boolean; error?: string }> {
    return this.enqueue(async () => {
      const all = this.loadAll();
      const target = all.find((s) => s.id === id);
      if (!target) {
        return { ok: false, pinned: false, error: "Session not found in saved history." };
      }
      if (target.pinned) {
        target.pinned = false;
        target.pinnedAt = undefined;
      } else {
        const currentPinned = all.filter((s) => s.pinned && s.id !== id).length;
        if (currentPinned >= MAX_PINNED_SESSIONS) {
          return {
            ok: false,
            pinned: false,
            error: `You can pin up to ${MAX_PINNED_SESSIONS} conversations. Unpin one first.`,
          };
        }
        target.pinned = true;
        target.pinnedAt = Date.now();
      }
      all.sort(compareSessions);
      const envelope: PersistedSessionStoreEnvelope = {
        version: SESSION_STORE_SCHEMA_VERSION,
        sessions: all,
        updatedAt: Date.now(),
      };
      await this.context.globalState.update(STORAGE_KEY, envelope);
      return { ok: true, pinned: Boolean(target.pinned) };
    });
  }

  async rename(id: string, title: string): Promise<boolean> {
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!clean) return false;
    return this.enqueue(async () => {
      const all = this.loadAll();
      const target = all.find((s) => s.id === id);
      if (!target) return false;
      target.title = clean;
      const envelope: PersistedSessionStoreEnvelope = {
        version: SESSION_STORE_SCHEMA_VERSION,
        sessions: all,
        updatedAt: Date.now(),
      };
      await this.context.globalState.update(STORAGE_KEY, envelope);
      return true;
    });
  }

  get(id: string): SessionState | undefined {
    return this.loadAll().find((s) => s.id === id);
  }

  summaries(): SessionSummary[] {
    return this.loadAll().map(toSummary);
  }
}

function compareSessions(a: SessionState, b: SessionState): number {
  const aPinned = Boolean(a.pinned);
  const bPinned = Boolean(b.pinned);
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  if (aPinned && bPinned) {
    const pinDiff = (b.pinnedAt ?? b.updatedAt) - (a.pinnedAt ?? a.updatedAt);
    if (pinDiff !== 0) return pinDiff;
  }
  return b.updatedAt - a.updatedAt;
}

function findEvictableIndex(list: SessionState[], protectedId?: string): number {
  // Prefer oldest unpinned session (not matching protectedId), then oldest unpinned, then last entry.
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].pinned && list[i].id !== protectedId) return i;
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].pinned) return i;
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id !== protectedId) return i;
  }
  return list.length - 1;
}

function evictOverSessionCap(all: SessionState[], cap: number, protectedId?: string): SessionState[] {
  const result = [...all];
  while (result.length > cap) {
    const idx = findEvictableIndex(result, protectedId);
    result.splice(idx, 1);
  }
  return result;
}

export function toSummary(session: SessionState): SessionSummary {
  let searchText = "";
  for (const m of session.messages) {
    if (m.hidden || (m.role !== "user" && m.role !== "assistant")) continue;
    const raw = (m.content || "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const snippet = redactSecrets(raw);
    searchText = searchText ? `${searchText} ${snippet}` : snippet;
    if (searchText.length >= 500) {
      searchText = searchText.slice(0, 500);
      break;
    }
  }
  return {
    id: session.id,
    title: session.title,
    mode: session.mode,
    model: session.model,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    ...(session.pinned ? { pinned: true, pinnedAt: session.pinnedAt } : {}),
    ...(searchText ? { searchText } : {}),
  };
}

export function validateAndSanitizeRestoredSession(raw: unknown): SessionState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawObj = raw as Record<string, unknown>;
  if (typeof rawObj.id !== "string" || !rawObj.id.trim()) return null;

  const title = typeof rawObj.title === "string" ? rawObj.title : "Untitled Session";
  const rawMode = typeof rawObj.mode === "string" ? rawObj.mode : "";
  const mode =
    rawMode === "chat" || rawMode === "plan" || rawMode === "agent"
      ? (rawMode as SessionState["mode"])
      : rawMode === "code"
        ? "agent"
        : rawMode === "architect"
          ? "plan"
          : "chat";
  const model = typeof rawObj.model === "string" ? rawObj.model : "";
  const createdAt =
    typeof rawObj.createdAt === "number" && Number.isFinite(rawObj.createdAt) ? rawObj.createdAt : Date.now();
  const updatedAt =
    typeof rawObj.updatedAt === "number" && Number.isFinite(rawObj.updatedAt) ? rawObj.updatedAt : createdAt;
  const pinned = rawObj.pinned === true ? true : undefined;
  const pinnedAt =
    pinned && typeof rawObj.pinnedAt === "number" && Number.isFinite(rawObj.pinnedAt)
      ? rawObj.pinnedAt
      : pinned
        ? updatedAt
        : undefined;

  const rawMessages = Array.isArray(rawObj.messages) ? rawObj.messages : [];
  const validMessages = rawMessages
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string")
    .map((m) => {
      const role = ["user", "assistant", "system", "tool"].includes(m.role as string) ? (m.role as any) : "user";
      const content = typeof m.content === "string" ? m.content : "";
      const validToolCalls = Array.isArray(m.toolCalls)
        ? (m.toolCalls as unknown[])
            .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string")
            .map((c) => {
              const status =
                c.status === "done"
                  ? ("done" as const)
                  : c.status === "denied"
                    ? ("denied" as const)
                    : ("error" as const);
              return {
                id: typeof c.id === "string" ? c.id : `call_${randomUUID()}`,
                name: String(c.name),
                args: typeof c.args === "object" && c.args !== null ? (c.args as Record<string, unknown>) : {},
                status,
                result: typeof c.result === "string" ? c.result : undefined,
                error:
                  status === "done" || status === "denied"
                    ? undefined
                    : typeof c.error === "string"
                      ? c.error
                      : "Interrupted before completion.",
                ...(typeof c.statusDetail === "string" ? { statusDetail: c.statusDetail } : {}),
                ...(typeof c.sideEffecting === "boolean" ? { sideEffecting: c.sideEffecting } : {}),
                ...(typeof c.thoughtSignature === "string" && c.thoughtSignature
                  ? { thoughtSignature: c.thoughtSignature }
                  : {}),
              };
            })
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
        ...(typeof m.name === "string" && m.name ? { name: m.name } : {}),
        content,
        createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
        streaming: false,
        toolCalls: validToolCalls,
        attachments: validAttachments,
        notice: typeof m.notice === "string" ? m.notice : undefined,
        ...(typeof m.hidden === "boolean" ? { hidden: m.hidden } : {}),
        ...(typeof m.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
        ...(typeof m.thinking === "string" ? { thinking: m.thinking } : {}),
        ...(typeof m.thinkingElapsedMs === "number" && Number.isFinite(m.thinkingElapsedMs)
          ? { thinkingElapsedMs: m.thinkingElapsedMs }
          : {}),
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

  const rawUsage = rawObj.usage as Record<string, unknown> | undefined;
  const usage =
    rawUsage &&
    typeof rawUsage === "object" &&
    typeof rawUsage.used === "number" &&
    typeof rawUsage.window === "number" &&
    Array.isArray(rawUsage.breakdown)
      ? (rawObj.usage as SessionState["usage"])
      : undefined;

  return {
    id: String(rawObj.id),
    title,
    mode,
    model,
    createdAt,
    updatedAt,
    messages: validMessages,
    ...(usage ? { usage } : {}),
    ...(pinned ? { pinned: true, pinnedAt } : {}),
  };
}

export function capForStorage(s: SessionState): SessionState {
  const pruned = pruneInlineImages(s);
  const msgs =
    pruned.messages.length > MAX_PERSISTED_MESSAGES
      ? pruned.messages.slice(-MAX_PERSISTED_MESSAGES)
      : pruned.messages;
  return {
    ...pruned,
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
      const attachments = m.attachments?.map((a) => {
        let text = a.text ? redactSecrets(a.text) : undefined;
        if (text && text.length > MAX_PERSISTED_ATTACHMENT_TEXT) {
          text =
            text.slice(0, MAX_PERSISTED_ATTACHMENT_TEXT) +
            `\n… [truncated ${text.length - MAX_PERSISTED_ATTACHMENT_TEXT} chars for storage]`;
        }
        const oversizedBase64 = Boolean(a.dataBase64 && a.dataBase64.length > MAX_PERSISTED_ATTACHMENT_BASE64);
        return {
          ...a,
          ...(oversizedBase64
            ? {
                dataBase64: undefined,
                isPruned: true,
                text: text || "[Attachment payload omitted from storage to preserve history]",
              }
            : { text }),
        };
      });
      return {
        ...m,
        streaming: false,
        content,
        thinking,
        toolCalls,
        ...(attachments ? { attachments } : {}),
      };
    }),
  };
}
