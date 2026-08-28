import type { Attachment, ChatMessage } from "../../../src/shared/types";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

export function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const attachments = message.attachments ?? [];
  return (
    <div className={`msg ${isUser ? "user" : "assistant"}`}>
      {attachments.length > 0 && (
        <div className="msg-attachments">
          {attachments.map((a) => (
            <AttachmentThumb key={a.id} attachment={a} />
          ))}
        </div>
      )}

      <div className="msg-body">
        {isUser ? (
          <span>{message.content}</span>
        ) : (
          <>
            {message.content && <Markdown text={message.content} streaming={message.streaming} />}
            {message.streaming && !message.content && <span className="cursor-blink" />}
          </>
        )}
      </div>

      {(message.toolCalls ?? []).map((call) => (
        <ToolCard key={call.id} call={call} />
      ))}

      {message.notice && <div className="notice">{message.notice}</div>}
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
