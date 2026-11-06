import { memo, useState, useRef, useCallback } from "react";
import type { Attachment, ChatMessage, ToolCall } from "../../../src/shared/types";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./ToolCard";
import { TurnProcess } from "./TurnProcess";
import { FileCodeIcon, ErrorCrossIcon, ChevronRightIcon } from "./Icons";
import type { Actions } from "../state/store";

export const Message = memo(function Message({ message, pendingApproval, actions }: {
  message: ChatMessage;
  pendingApproval?: ToolCall | null;
  actions?: Actions;
}) {
  const isUser = message.role === "user";
  const attachments = message.attachments ?? [];
  const toolCalls = message.toolCalls ?? [];
  // Whitespace-only streamed/tool-call messages must not create an empty
  // full-width assistant bubble. Tool cards remain visible independently.
  // String#trim() keeps zero-width/control characters (ZWSP, soft hyphen…),
  // so test for *visible* characters instead — otherwise an invisible-only
  // message still paints an empty box.
  const hasContent = hasVisibleText(message.content);
  const isStreaming = message.streaming === true;
  const hasThinking = hasVisibleText(message.thinking);
  const notice = hasVisibleText(message.notice) ? message.notice! : "";
  // The trace is "live" only while no answer/tool activity has started yet.
  const thinkingLive = isStreaming && !hasContent && toolCalls.length === 0;
  const showCursor = isStreaming && !hasContent && !hasThinking && !isUser && toolCalls.length === 0;

  // Nothing to paint (empty user bubble, empty notice, stripped message):
  // render no wrapper at all so no bordered box or stray gap is left behind.
  if (!attachments.length && !hasContent && !hasThinking && !toolCalls.length && !notice && !showCursor) {
    return null;
  }

  return (
    <div className={`msg ${isUser ? "user" : "assistant"}`}>
      {attachments.length > 0 && (
        <div className="msg-attachments">
          {attachments.map((a) => (
            <AttachmentThumb key={a.id} attachment={a} />
          ))}
        </div>
      )}

      {!isUser && (hasThinking || toolCalls.length > 0) && (
        <TurnProcess
          messages={[message]}
          pendingApproval={pendingApproval}
          actions={actions}
          isStreaming={isStreaming}
          hasContent={hasContent}
        />
      )}

      {hasContent && (
        <div className="msg-body">
          {isUser ? (
            <span>{message.content}</span>
          ) : (
            <Markdown text={message.content} streaming={isStreaming} />
          )}
        </div>
      )}

      {showCursor && (
        <div className="msg-body">
          <span className="cursor-blink" />
        </div>
      )}

      {isUser && toolCalls.map((call) => (
        <ToolCard key={call.id} call={call} pendingApproval={pendingApproval} actions={actions} />
      ))}

      {notice && <NoticeBubble notice={notice} />}

      {!message.streaming && hasContent && (
        <MessageActions content={message.content} isUser={isUser} />
      )}
    </div>
  );
});

function summarizeErrorNotice(raw: string): { summary: string; detail: string } {
  const cleaned = raw.replace(/^⚠️\s*/, "").trim();
  const braceIdx = cleaned.indexOf("{");
  if (braceIdx > 0) {
    const prefix = cleaned.slice(0, braceIdx).replace(/[.:-\s]+$/, "").trim();
    return {
      summary: prefix || "Request failed — click to view error",
      detail: cleaned,
    };
  }
  const firstLine = cleaned.split(/\r?\n/)[0]?.trim() || "Error";
  if (firstLine.length > 72) {
    return {
      summary: firstLine.slice(0, 70).trimEnd() + "…",
      detail: cleaned,
    };
  }
  return {
    summary: firstLine,
    detail: cleaned,
  };
}

export function NoticeBubble({ notice }: { notice: string }) {
  const [open, setOpen] = useState(false);
  const isError = notice.startsWith("⚠️") || /error|failed|exception|quota/i.test(notice);

  if (!isError) {
    return <div className="notice">{notice}</div>;
  }

  const { summary, detail } = summarizeErrorNotice(notice);

  return (
    <div className={`msg-body error-bubble${open ? " open" : ""}`}>
      <button
        type="button"
        className="error-bubble-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? "Hide error details" : "Click to view full error details"}
      >
        <span className="error-bubble-cross">
          <ErrorCrossIcon />
        </span>
        <span className="error-bubble-summary">{summary}</span>
        <span className={`error-bubble-chevron${open ? " open" : ""}`}>
          <ChevronRightIcon />
        </span>
      </button>
      {open && <div className="error-bubble-detail">{detail}</div>}
    </div>
  );
}

/** Whitespace plus zero-width/control characters: everything String#trim()
 *  leaves behind that still paints no glyph. */
export const NO_GLYPH = /[\s\u00A0\u180E\u200B-\u200F\u2028\u2029\u2060-\u2064\u206A-\u206F\uFEFF]/g;

/** True when the string would actually paint a glyph. */
export function hasVisibleText(s?: string): boolean {
  if (!s) return false;
  return s.replace(NO_GLYPH, "").length > 0;
}

export function MessageActions({ content, isUser }: { content: string; isUser: boolean }) {
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

export function AttachmentThumb({ attachment }: { attachment: Attachment }) {
  const name = attachment.name?.trim() || (attachment.kind === "image" ? "image" : "attachment");
  if (attachment.kind === "image" && attachment.dataBase64) {
    return (
      <img
        className="msg-image"
        src={`data:${attachment.mime};base64,${attachment.dataBase64}`}
        alt={name}
        title={name}
      />
    );
  }
  return (
    <div className="msg-doc" title={name}>
      <FileCodeIcon />
      <span>{name}</span>
    </div>
  );
}
