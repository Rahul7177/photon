import { useState, useRef, useCallback } from "react";
import type { Attachment, ChatMessage } from "../../../src/shared/types";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

export function Message({ message }: { message: ChatMessage }) {
  // Internal orchestration messages are intentionally kept in the session so
  // the model can reason from tool results, but they are not conversation
  // content and should never be rendered as user/assistant bubbles.
  if (message.internal || isInternalOrchestrationMessage(message)) return null;

  const isUser = message.role === "user";
  const attachments = message.attachments ?? [];
  const hasContent = Boolean(message.content?.trim());
  const isStreaming = message.streaming === true;

  return (
    <div className={`msg ${isUser ? "user" : "assistant"}`}>
      {attachments.length > 0 && (
        <div className="msg-attachments">
          {attachments.map((a) => (
            <AttachmentThumb key={a.id} attachment={a} />
          ))}
        </div>
      )}

      {(hasContent || isUser) && (
        <div className="msg-body">
          {isUser ? (
            <span>{message.content}</span>
          ) : (
            <Markdown text={message.content} streaming={isStreaming} />
          )}
        </div>
      )}

      {isStreaming && !hasContent && !isUser && (message.toolCalls ?? []).length === 0 && (
        <div className="msg-body">
          <span className="cursor-blink" />
        </div>
      )}

      {(message.toolCalls ?? []).map((call) => (
        <ToolCard key={call.id} call={call} />
      ))}

      {message.notice && (
        <div className={`notice${message.notice.startsWith("⚠️") ? " notice-error" : ""}`}>
          {message.notice}
        </div>
      )}

      {!message.streaming && message.content && (
        <MessageActions content={message.content} isUser={isUser} />
      )}
    </div>
  );
}

function isInternalOrchestrationMessage(message: ChatMessage): boolean {
  const text = (message.content ?? "").trim();
  if (!text) return false;

  // Unified local loop stores block-protocol tool results as user messages so
  // they can be fed back into weak models. Hide those implementation details
  // from the UI while preserving them in the session transcript.
  if (message.toolCallId && /^\{\s*"type"\s*:\s*"tool_(?:result|error)"\b/i.test(text)) return true;
  if (/^\{\s*"type"\s*:\s*"tool_(?:result|error)"\b/i.test(text)) return true;

  // Photon-generated control nudges used to recover weak-model tool turns.
  return /^(?:Your previous reply arrived empty\.|Continue the task\.|You stopped after describing next steps but made no tool call\.|Your reply was cut off\.|That exact tool call already ran\.|That exact operation already ran\.|Fix the tool call\.\s*Use exactly:|Correct the invalid tool call and retry\.|Verification is still required before finishing:|The workspace changed successfully\.)/i.test(text);
}

function MessageActions({ content, isUser }: { content: string; isUser: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    });
  }, [content]);

  return (
    <div className={`msg-actions${isUser ? " user" : " assistant"}`}>
      <button
        className="msg-action-btn"
        title={copied ? "Copied!" : "Copy message"}
        onClick={handleCopy}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3.5 8 6.5 11 12.5 5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
            <path d="M3 10.5V3.5a1.5 1.5 0 011.5-1.5H10.5" />
          </svg>
        )}
      </button>
    </div>
  );
}

function AttachmentThumb({ attachment }: { attachment: Attachment }) {
  if (attachment.kind === "image" && attachment.dataBase64) {
    return (
      <img
        className="msg-image"
        src={`data:${attachment.mime};base64,${attachment.dataBase64}`}
        alt={attachment.name}
        title={attachment.name}
      />
    );
  }
  return (
    <div className="msg-doc" title={attachment.name}>
      📄 {attachment.name}
    </div>
  );
}
