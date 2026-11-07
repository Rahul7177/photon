import type { ChatMessage, SessionState } from "../shared/types";

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
        a.dataBase64 && toStrip-- > 0 ? { ...a, dataBase64: undefined } : a
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

