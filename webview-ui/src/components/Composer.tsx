import { useRef, useState } from "react";
import type { Attachment, Mode, ThinkingSetting } from "../../../src/shared/types";
import type { AppState, Actions } from "../state/store";
import { ContextMeter } from "./ContextMeter";
import { CapabilityBadges } from "./CapabilityBadges";
import { readFileToAttachment, formatBytes } from "../attachments";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Talk & get code, no tools" },
  { id: "plan", label: "Plan", hint: "Read-only investigation → step-by-step plan" },
  { id: "agent", label: "Agent", hint: "Uses tools to edit files and run commands" },
];

const THINKING_OPTIONS: Array<{ value: ThinkingSetting; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xtrahigh", label: "Extra High" },
];

// Sentinel value for the "Auto" model-picker option.
const AUTO = "__auto__";

function benchTps(results: { model: string; tokensPerSec: number }[], model: string): number | undefined {
  const r = results.find((b) => b.model === model);
  return r ? Math.round(r.tokensPerSec) : undefined;
}

// Custom dropdown component that opens upwards
function ModeDropdown({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const currentMode = MODES.find((m) => m.id === mode) || MODES[0];

  const handleClickOutside = (e: MouseEvent) => {
    if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  };

  if (typeof window !== "undefined") {
    const handlerRef = useRef(handleClickOutside);
    handlerRef.current = handleClickOutside;
  }

  return (
    <div className="mode-dropdown" ref={wrapperRef}>
      <button
        className="mode-dropdown-trigger"
        onClick={() => setOpen(!open)}
        title={currentMode.hint}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{currentMode.label}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <ul className="mode-dropdown-menu" role="listbox">
          {MODES.map((m) => (
            <li key={m.id} role="option" aria-selected={mode === m.id}>
              <button
                className={`mode-dropdown-item${mode === m.id ? " active" : ""}`}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                title={m.hint}
              >
                {m.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
    const fileItems = items.filter((it) => it.kind === "file");

    if (fileItems.length === 0) return;

    e.preventDefault();
    setAttachError(null);
    const next: Attachment[] = [];

    for (const item of fileItems) {
      let file = item.getAsFile();
      if (!file && item.type.startsWith("image/")) {
        file = new File(
          [new Blob([], { type: item.type })],
          `clipboard-${Date.now()}.${item.type.split("/")[1] ?? "png"}`,
          { type: item.type }
        );
      }

      if (file) {
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
    }

    if (next.length) setAttachments((a) => [...a, ...next]);
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

      <div className="composer-toolbar">
        <div className="iface-toggle" title="Local: Ollama/llama.cpp with adaptive tuning. Cloud: direct provider APIs.">
          <button
            className={state.config.interfaceMode === "local" ? "active" : ""}
            onClick={() => actions.setInterfaceMode("local")}
          >
            Local
          </button>
          <button
            className={state.config.interfaceMode === "cloud" ? "active cloud" : "cloud"}
            onClick={() => actions.setInterfaceMode("cloud")}
          >
            ☁ Cloud
          </button>
        </div>
        <div className="model-picker">
          <select
            value={state.config.autoSelectModel ? AUTO : state.selectedModel}
            onChange={(e) => {
              if (e.target.value === AUTO) actions.setAutoSelect(true);
              else actions.setModel(e.target.value);
            }}
            disabled={state.models.length === 0}
            title={
              state.config.autoSelectModel
                ? `Auto — Photon picks the model per request${state.selectedModel ? ` (last: ${state.selectedModel})` : ""}`
                : state.selectedModel
            }
          >
            {!state.ready && <option value="">Loading models…</option>}
            {state.ready && state.models.length === 0 && <option value="">No models — check Local / Cloud</option>}
            {state.ready && state.models.length > 0 && <option value={AUTO}>🤖 Auto</option>}
            {state.models.map((m) => {
              const tps = benchTps(state.benchResults, m.name);
              const display = m.name.includes(":") ? m.name.split(":").slice(1).join(":") : m.name;
              return (
                <option key={m.name} value={m.name} title={m.name}>
                  {display}
                  {m.tier ? ` · ${m.tier}` : ""}
                  {tps ? ` · ${tps} tok/s` : ""}
                </option>
              );
            })}
          </select>
        </div>

        {modelCaps?.thinking && (
          <div className="model-picker thinking-picker" title="Reasoning level">
            <select
              value={state.config.thinkingLevel}
              onChange={(e) => actions.setThinkingSetting(e.target.value as ThinkingSetting)}
              aria-label="Reasoning level"
            >
              {THINKING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        )}

        {modelCaps && <CapabilityBadges model={modelCaps} compact />}
      </div>

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
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 7.5l-5.8 5.8a3.5 3.5 0 01-5-5l5.8-5.8a2.3 2.3 0 013.3 3.3L6.1 11.5a1.2 1.2 0 01-1.7-1.7l5-5" />
          </svg>
        </button>
        <div className="input-mode-tabs" role="tablist">
          <ModeDropdown mode={state.mode} onChange={(m) => actions.setMode(m)} />
        </div>
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
  const tTag = state.config.thinkingLevel !== "off" && state.config.thinkingLevel !== "auto" ? ` +${state.config.thinkingLevel}` : "";
  return `${verb}… (${state.mode}${tTag} mode)`;
}
