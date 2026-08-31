import { useState, useRef, useCallback } from "react";
import type { Attachment, ChatMessage } from "../../../src/shared/types";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

export function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const attachments = message.attachments ?? [];
  // Whitespace-only streamed/tool-call messages must not create an empty
  // full-width assistant bubble. Tool cards remain visible independently.
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
