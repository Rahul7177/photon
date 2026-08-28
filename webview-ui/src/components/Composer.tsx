import { useRef, useState } from "react";
import type { Attachment } from "../../../src/shared/types";
import type { AppState, Actions } from "../state/store";
import { ContextMeter } from "./ContextMeter";
import { CapabilityBadges } from "./CapabilityBadges";
import { readFileToAttachment, formatBytes } from "../attachments";

export function Composer({ state, actions }: { state: AppState; actions: Actions }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = state.status === "thinking" || state.status === "running";
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !!state.selectedModel && !busy;
  const model = state.models.find((m) => m.name === state.selectedModel);
  const supportsVision = model?.vision === true;

  const submit = () => {
    if (!canSend) return;
    actions.send(text.trim(), attachments.length ? attachments : undefined);
    setText("");
    setAttachments([]);
    setAttachError(null);
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const handleFiles = async (files: File[] | FileList | null) => {
    if (!files) return;
    const arr = Array.from(files as FileList);
    setAttachError(null);
    const next: Attachment[] = [];
    for (const file of arr) {
      const { attachment, error } = await readFileToAttachment(file);
      if (error) setAttachError(error);
      else if (attachment) {
        if (attachment.kind === "image" && !supportsVision) {
          setAttachError(`${model?.name ?? "This model"} can't read images — attach text/code instead.`);
          continue;
        }
        next.push(attachment);
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next]);
    if (fileRef.current) fileRef.current.value = "";
  };
  const onPickFiles = (files: FileList | null) => void handleFiles(files);

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const files = items
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      await handleFiles(files);
    }
  };

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length) await handleFiles(files);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const autoGrow = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const modelCaps = state.models.find((m) => m.name === state.selectedModel);
  return (
    <div className="composer" onDrop={onDrop} onDragOver={onDragOver}>
      <ContextMeter usage={state.usage} plan={state.plan} stats={state.generationStats} compactBadgesModel={modelCaps} />

      {attachError && <div className="attach-error">{attachError}</div>}

      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a) => (
            <div key={a.id} className="attach-chip" title={a.name}>
              <span className="attach-kind">{a.kind === "image" ? "🖼" : "📄"}</span>
              <span className="attach-name">{a.name}</span>
              <span className="attach-size">{formatBytes(a.size)}</span>
              <button
                className="attach-remove"
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="input-wrap">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept={supportsVision ? "image/*,text/*,.md,.json,.csv,.log,.py,.ts,.tsx,.js,.jsx" : "text/*,.md,.json,.csv,.log,.py,.ts,.tsx,.js,.jsx"}
          onChange={(e) => onPickFiles(e.target.files)}
        />
        <button
          className="attach-btn"
          title={supportsVision ? "Attach image or file" : "Attach text or code file"}
          onClick={() => fileRef.current?.click()}
          disabled={busy || !state.selectedModel}
        >
          +
        </button>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={placeholder(state)}
          onChange={(e) => setText(e.target.value)}
          onInput={autoGrow}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {busy ? (
          <button className="send-btn stop" title="Stop" onClick={actions.cancel}>
            ■
          </button>
        ) : (
          <button className="send-btn" title="Send" disabled={!canSend} onClick={submit}>
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

function placeholder(state: AppState): string {
  if (!state.selectedModel) {
    const hint = state.config.interfaceMode === "cloud"
      ? "No cloud model — add one in Settings → Cloud providers…"
      : "No local model — start Ollama or llama.cpp and pull a model…";
    return hint;
  }
  const verb = { chat: "Ask", plan: "Describe what to plan", agent: "Describe a task" }[state.mode];
  return `${verb}… (${state.mode} mode)`;
}
