import type { ChatMessage, SessionState } from "../shared/types";
import { buildNativeCompactionSummary } from "../core/agent/compactor";

/** Inline base64 images kept in PERSISTED sessions. Images dominate storage —
 *  a few screenshots would otherwise bloat every globalState rewrite forever.
 *  The live in-memory session keeps everything; only the stored copy is pruned. */
export const KEEP_INLINE_IMAGES = 4;

/** Cap messages kept per session (memory + persisted-blob size). */
export const MAX_SESSION_MESSAGES = 400;

/**
 * Strip inline base64 payloads from older message attachments beyond `keepCount`
 * before persisting a session to disk/globalState.
 */
export function pruneInlineImages(
  session: SessionState,
  keepCount = KEEP_INLINE_IMAGES
): SessionState {
  let remaining = keepCount;
  const messages = [...session.messages]
    .reverse()
    .map((m) => {
      const imageCount = m.attachments?.filter((a) => a.dataBase64).length ?? 0;
      if (!imageCount) return m;
      const keep = Math.max(0, remaining);
      remaining -= imageCount;
      if (keep >= imageCount) return m;
      let toStrip = imageCount - keep;
      const attachments = m.attachments!.map((a) =>
        a.dataBase64 && toStrip-- > 0
          ? {
              ...a,
              dataBase64: undefined,
              isPruned: true,
              text:
                a.text || "[Image pruned from storage to conserve disk space]",
            }
          : a
      );
      return { ...m, attachments };
    })
    .reverse();
  return { ...session, messages };
}

/**
 * Finalize messages left mid-stream by an abort/error and remove empty assistant placeholders.
 * Returns true if any message in the session was modified or removed.
 */
export function finalizeTurnMessages(session: SessionState): boolean {
  let touched = false;
  for (const m of session.messages) {
    if (m.streaming) {
      m.streaming = false;
      m.notice ??= "Stopped.";
      touched = true;
    }
  }
  const before = session.messages.length;
  session.messages = session.messages.filter(
    (m) => !(m.role === "assistant" && !m.content.trim() && !m.toolCalls?.length && !m.notice)
  );
  return touched || session.messages.length !== before;
}

/**
 * Resolve the user message index and prompt text when rewinding a conversation
 * to a specific checkpoint. Truncates the returned messages array to BEFORE that turn.
 */
export function rewindMessagesToCheckpoint(
  messages: ChatMessage[],
  checkpointId: string,
  targetTurnMessageId?: string,
  fallbackLabel = ""
): {
  rewoundMessages: ChatMessage[];
  restoredPrompt: string;
  userMessageIndex: number;
} {
  let userMsgIdx = messages.findIndex(
    (m) =>
      (m.role === "user" && m.checkpointId === checkpointId) ||
      (m.role === "user" && m.id === targetTurnMessageId)
  );

  if (userMsgIdx === -1) {
    const asstIdx = messages.findIndex((m) => m.checkpointId === checkpointId);
    if (asstIdx >= 0) {
      for (let i = asstIdx - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          userMsgIdx = i;
          break;
        }
      }
    }
  }

  if (userMsgIdx >= 0) {
    return {
      rewoundMessages: messages.slice(0, userMsgIdx),
      restoredPrompt: messages[userMsgIdx].content,
      userMessageIndex: userMsgIdx,
    };
  }

  return {
    rewoundMessages: [...messages],
    restoredPrompt: fallbackLabel,
    userMessageIndex: -1,
  };
}

/**
 * Cap messages kept per session.
 * Reserves a slot for the archive digest so the post-cap length is at most maxMessages.
 * Prevents nested/re-archiving digests across repeated archive cycles, while preserving
 * the original task objective, user constraints, verified facts, and unresolved items.
 */
export function enforceSessionMessageCap(
  session: SessionState,
  maxMessages = MAX_SESSION_MESSAGES
): boolean {
  if (session.messages.length <= maxMessages) return false;
  if (maxMessages <= 0) return false;

  // Reserve 1 slot for the archive digest message so total messages <= maxMessages
  const targetRemaining = Math.max(1, maxMessages - 1);
  const excessCount = session.messages.length - targetRemaining;
  if (excessCount <= 0) return false;

  const toArchive = session.messages.slice(0, excessCount);
  const remaining = session.messages.slice(excessCount);

  // Extract prior archive content and original anchor prompt to avoid nesting
  let priorArchiveSummary = "";
  let accumulatedMessagesCount = 0;
  const newTurnsToArchive: ChatMessage[] = [];

  for (const m of toArchive) {
    if (
      m.isCompacted ||
      m.id.startsWith("archive_") ||
      m.compactStats?.strategy === "session-persistence-archive"
    ) {
      accumulatedMessagesCount += m.compactStats?.messagesCount ?? 1;
      const stripped = m.content.replace(
        /^⚡ \*\*\[Context Compaction Summary\]\*\* \(Archived session history\)\n\n/,
        ""
      );
      if (stripped.trim()) {
        priorArchiveSummary = stripped.trim();
      }
    } else {
      newTurnsToArchive.push(m);
      accumulatedMessagesCount++;
    }
  }

  // Preserve original task objective from first user prompt in history or prior summary
  let anchorPrompt: string | undefined;
  if (priorArchiveSummary) {
    const matchObj = priorArchiveSummary.match(/Original objective:\s*(.*?)(?:\n|$)/);
    if (matchObj) {
      anchorPrompt = matchObj[1].trim();
    }
  }
  if (!anchorPrompt) {
    const firstUser = session.messages.find((m) => m.role === "user");
    anchorPrompt = firstUser?.content;
  }

  let summaryContent = "";
  if (newTurnsToArchive.length > 0) {
    const newSummary = buildNativeCompactionSummary(
      newTurnsToArchive,
      "Archived history from earlier turns in this session",
      anchorPrompt
    );
    if (priorArchiveSummary) {
      summaryContent = `${priorArchiveSummary}\n\n---\n**Later Archived Progress:**\n${newSummary}`;
    } else {
      summaryContent = newSummary;
    }
  } else {
    summaryContent = priorArchiveSummary;
  }

  const archiveDigestMessage: ChatMessage = {
    id: `archive_${Date.now()}`,
    role: "assistant",
    content: `⚡ **[Context Compaction Summary]** (Archived session history)\n\n${summaryContent}`,
    createdAt: Date.now(),
    isCompacted: true,
    notice: `Context archived: ${accumulatedMessagesCount} earlier messages folded into digest`,
    compactStats: {
      messagesCount: accumulatedMessagesCount,
      tokensSaved: 0,
      pctSaved: 0,
      strategy: "session-persistence-archive",
    },
  };

  session.messages = [archiveDigestMessage, ...remaining];
  return true;
}

