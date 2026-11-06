import { memo } from "react";
import type { Attachment, ChatMessage, ToolCall } from "../../../src/shared/types";
import type { Actions } from "../state/store";
import { Markdown } from "./Markdown";
import { TurnProcess } from "./TurnProcess";
import { AttachmentThumb, MessageActions, NoticeBubble, hasVisibleText } from "./Message";

/**
 * Renders an entire assistant turn (which may span multiple agentic steps,
 * tool calls, thinking blocks, and final answer content).
 *
 * All intermediate tool calls and thoughts are abstracted into a single,
 * clean collapsible TurnProcess header so the chat remains uncluttered.
 */
export const AssistantTurn = memo(function AssistantTurn({
  messages,
  pendingApproval,
  actions,
}: {
  messages: ChatMessage[];
  pendingApproval?: ToolCall | null;
  actions?: Actions;
}) {
  const allAttachments: Attachment[] = [];
  const notices: string[] = [];
  let isStreaming = false;
  let hasContent = false;
  let hasThinking = false;
  let hasTools = false;

  for (const m of messages) {
    if (m.attachments?.length) allAttachments.push(...m.attachments);
    if (m.streaming) isStreaming = true;
    if (hasVisibleText(m.content)) hasContent = true;
    if (hasVisibleText(m.thinking)) hasThinking = true;
    if (m.toolCalls?.length) hasTools = true;
    if (hasVisibleText(m.notice)) notices.push(m.notice!);
  }

  const showCursor = isStreaming && !hasContent && !hasThinking && !hasTools;

  // Nothing to paint at all
  if (
    !allAttachments.length &&
    !hasContent &&
    !hasThinking &&
    !hasTools &&
    !notices.length &&
    !showCursor
  ) {
    return null;
  }

  // Combine visible content across messages for the copy button
  const fullContent = messages
    .map((m) => m.content?.trim())
    .filter(Boolean)
    .join("\n\n");

  return (
    <div className="msg assistant">
      {allAttachments.length > 0 && (
        <div className="msg-attachments">
          {allAttachments.map((a) => (
            <AttachmentThumb key={a.id} attachment={a} />
          ))}
        </div>
      )}

      {/* Abstracted tool calls and thinking trace */}
      <TurnProcess
        messages={messages}
        pendingApproval={pendingApproval}
        actions={actions}
        isStreaming={isStreaming}
        hasContent={hasContent}
      />

      {/* Actual answer content */}
      {messages.map((m) => {
        if (!hasVisibleText(m.content)) return null;
        return (
          <div key={m.id} className="msg-body">
            <Markdown text={m.content} streaming={m.streaming === true} />
          </div>
        );
      })}

      {showCursor && (
        <div className="msg-body">
          <span className="cursor-blink" />
        </div>
      )}

      {notices.map((n, i) => (
        <NoticeBubble key={i} notice={n} />
      ))}

      {!isStreaming && hasContent && (
        <MessageActions content={fullContent} isUser={false} />
      )}
    </div>
  );
});

