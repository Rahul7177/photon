import { useRef, useState, useEffect, useMemo } from "react";
import type { Attachment, Mode, ThinkingSetting } from "../../../src/shared/types";
import type { AppState, Actions } from "../state/store";
import { ContextMeter, ContextIconTrigger } from "./ContextMeter";
import { PullProgressBar } from "./PullProgressBar";
import { formatBytes } from "../attachments";
import { CONTEXT_PRESETS, checkContextWindowOverflow, formatK, type ContextOverflowCheck } from "../contextPresets";
import {
  PaperclipIcon,
  SendArrowIcon,
  StopSquareIcon,
  ChatModeIcon,
  PlanModeIcon,
  AgentModeIcon,
  ChevronDownIcon,
  FileCodeIcon,
  ImageFileIcon,
  RefreshIcon,
  CloseIcon,
  BoltIcon,
  RewindIcon,
} from "./Icons";

const MODES: { id: Mode; label: string; hint: string; icon: JSX.Element }[] = [
  { id: "chat", label: "Chat", hint: "Direct conversation & code snippets without workspace edits", icon: <ChatModeIcon /> },
  { id: "plan", label: "Plan", hint: "Read-only investigation → step-by-step architecture plan", icon: <PlanModeIcon /> },
  { id: "agent", label: "Agent", hint: "Autonomous file edits, terminal execution, and verification", icon: <AgentModeIcon /> },
];

const THINKING_OPTIONS: Array<{ value: ThinkingSetting; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xtrahigh", label: "Extra High" },
];

const AUTO = "__auto__";

const SLASH_COMMANDS: Array<{
  cmd: string;
  desc: string;
  run: (actions: Actions, setText: (t: string) => void) => void;
}> = [
  {
    cmd: "/revert",
    desc: "Select a checkpoint (#1, #2, …) to restore files and rewind chat",
    run: (actions, setText) => {
      actions.openRevertModal();
      setText("");
    },
  },
  {
    cmd: "/rewind",
    desc: "Instantly rollback the most recent file changes and rewind chat",
    run: (actions, setText) => {
      actions.send("/rewind");
      setText("");
    },
  },
  {
    cmd: "/compact",
    desc: "Compact conversation history to optimize context window",
    run: (actions, setText) => {
      actions.compactContext();
      setText("");
    },
  },
];

function benchTps(results: { model: string; tokensPerSec: number }[], model: string): number | undefined {
  const r = results.find((b) => b.model === model);
  return r ? Math.round(r.tokensPerSec) : undefined;
}

function ModeDropdown({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const currentMode = MODES.find((m) => m.id === mode) || MODES[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  return (
    <div className={`mode-dropdown${open ? " open" : ""}`} ref={wrapperRef}>
      <button
        type="button"
        className="mode-dropdown-trigger"
        onClick={() => setOpen(!open)}
        title={currentMode.hint}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mode-dropdown-icon">{currentMode.icon}</span>
        <span>{currentMode.label}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <ul className="mode-dropdown-menu" role="listbox">
          {MODES.map((m) => (
            <li key={m.id} role="option" aria-selected={mode === m.id}>
              <button
                type="button"
                className={`mode-dropdown-item${mode === m.id ? " active" : ""}`}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                title={m.hint}
              >
                <span className="mode-dropdown-icon">{m.icon}</span>
                <div className="mode-dropdown-item-text">
                  <span className="mode-dropdown-item-label">{m.label}</span>
                  <span className="mode-dropdown-item-hint">{m.hint}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ModelDropdown({
  state,
  actions,
  onPullModel,
}: {
  state: AppState;
  actions: Actions;
  onPullModel: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const isDisabled =
    state.models.length === 0 &&
    (!state.recommendations || state.recommendations.models.length === 0);

  const currentLabel = useMemo(() => {
    if (!state.ready) return "Loading models…";
    if (state.config.autoSelectModel) return "Auto-Select";
    if (!state.selectedModel) {
      return state.models.length === 0 ? "No models configured" : "Select model";
    }
    const cleanName =
      state.config.interfaceMode === "cloud" && state.selectedModel.includes(":")
        ? state.selectedModel.split(":").slice(1).join(":")
        : state.selectedModel;
    return cleanName;
  }, [state.ready, state.config.autoSelectModel, state.selectedModel, state.config.interfaceMode, state.models.length]);

  return (
    <div className={`model-dropdown${open ? " open" : ""}`} ref={wrapperRef}>
      <button
        type="button"
        className="model-dropdown-trigger"
        onClick={() => setOpen((prev) => !prev)}
        disabled={isDisabled}
        title={
          state.config.autoSelectModel
            ? `Auto — Photon picks the model per request${state.selectedModel ? ` (last: ${state.selectedModel})` : ""}`
            : state.selectedModel
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-dropdown-label">{currentLabel}</span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="model-dropdown-menu" role="listbox">
          {!state.ready && (
            <div className="model-dropdown-empty">Loading models…</div>
          )}
          {state.ready && state.models.length === 0 && (!state.recommendations || state.recommendations.models.length === 0) && (
            <div className="model-dropdown-empty">No models configured</div>
          )}

          {state.ready && state.models.length > 0 && (
            <button
              type="button"
              className={`model-dropdown-item${state.config.autoSelectModel ? " active" : ""}`}
              onClick={() => {
                actions.setAutoSelect(true);
                setOpen(false);
              }}
            >
              <span className="model-dropdown-item-title">Auto-Select</span>
            </button>
          )}

          {state.config.interfaceMode === "local" ? (
            <>
              {state.models.length > 0 && (
                <div className="model-dropdown-section-header">Installed Local Models</div>
              )}
              {state.models.map((m) => {
                const isSelected = !state.config.autoSelectModel && state.selectedModel === m.name;
                const tps = benchTps(state.benchResults, m.name);
                return (
                  <button
                    key={m.name}
                    type="button"
                    className={`model-dropdown-item${isSelected ? " active" : ""}`}
                    onClick={() => {
                      actions.setModel(m.name);
                      setOpen(false);
                    }}
                    title={m.name}
                  >
                    <span className="model-dropdown-item-title">{m.name}</span>
                    {(m.tier || tps) && (
                      <span className="model-dropdown-item-meta">
                        {m.tier ? `${m.tier}` : ""}
                        {m.tier && tps ? " · " : ""}
                        {tps ? `${tps} tok/s` : ""}
                      </span>
                    )}
                  </button>
                );
              })}

              {(() => {
                const uninstalled = (state.recommendations?.models || []).filter(
                  (rec) => !state.models.some((m) => m.name.toLowerCase() === rec.name.toLowerCase())
                );
                if (uninstalled.length === 0) return null;
                return (
                  <>
                    <div className="model-dropdown-section-header">Recommended to Install</div>
                    {uninstalled.map((rec) => (
                      <button
                        key={`PULL:${rec.name}`}
                        type="button"
                        className="model-dropdown-item pull"
                        onClick={() => {
                          onPullModel(rec.name);
                          setOpen(false);
                        }}
                        title={`${rec.name} — ${rec.fit.label}`}
                      >
                        <span className="model-dropdown-item-title">+ {rec.name}</span>
                        <span className="model-dropdown-item-meta">
                          {rec.sizeGb} GB · {rec.recommended ? "Recommended" : rec.fit.badge}
                        </span>
                      </button>
                    ))}
                  </>
                );
              })()}
            </>
          ) : (
            <>
              {state.models.map((m) => {
                const isSelected = !state.config.autoSelectModel && state.selectedModel === m.name;
                const cleanName =
                  m.name.includes(":") ? m.name.split(":").slice(1).join(":") : m.name;
                return (
                  <button
                    key={m.name}
                    type="button"
                    className={`model-dropdown-item${isSelected ? " active" : ""}`}
                    onClick={() => {
                      actions.setModel(m.name);
                      setOpen(false);
                    }}
                    title={m.name}
                  >
                    <span className="model-dropdown-item-title">{cleanName}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Composer({
  state,
  actions,
  attachments,
  setAttachments,
  attachError,
  setAttachError,
  addFiles,
  onOpenHardwareModal,
  onContextWarn,
}: {
  state: AppState;
  actions: Actions;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  attachError: string | null;
  setAttachError: (msg: string | null) => void;
  addFiles: (files: File[]) => Promise<void>;
  onOpenHardwareModal: () => void;
  onContextWarn: (check: ContextOverflowCheck) => void;
}) {
  const [text, setText] = useState("");
  const [tuningOpen, setTuningOpen] = useState(false);
  const [confirmInstallModel, setConfirmInstallModel] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Automatically insert draft prompt (e.g. from checkpoint rollback / rewind chat)
  useEffect(() => {
    if (typeof state.draftPrompt === "string" && state.draftPrompt.length > 0) {
      setText(state.draftPrompt);
      actions.clearDraftPrompt();
      if (taRef.current) {
        taRef.current.focus();
        setTimeout(() => {
          if (taRef.current) {
            taRef.current.style.height = "auto";
            taRef.current.style.height = Math.min(taRef.current.scrollHeight, 160) + "px";
          }
        }, 30);
      }
    }
  }, [state.draftPrompt, actions]);

  const filteredSlash = useMemo(() => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/") || slashDismissed) return [];
    const query = trimmed.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(query) || query === "/");
  }, [text, slashDismissed]);

  const showSlashMenu = filteredSlash.length > 0;

  const busy = state.status === "thinking" || state.status === "running";
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !!state.selectedModel && !busy;
  const model = state.models.find((m) => m.name === state.selectedModel);
  const supportsVision = model?.vision === true;

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "/revert") {
      actions.openRevertModal();
      setText("");
      if (taRef.current) taRef.current.style.height = "auto";
      return;
    }
    if (trimmed.startsWith("/revert ")) {
      const num = parseInt(trimmed.slice(8).replace(/#/g, "").trim(), 10);
      if (!isNaN(num)) {
        actions.revertToNumber(num);
        setText("");
        if (taRef.current) taRef.current.style.height = "auto";
        return;
      }
    }
    if (!canSend) return;
    actions.send(trimmed, attachments.length ? attachments : undefined);
    setText("");
    setAttachments([]);
    setAttachError(null);
    setTuningOpen(false);
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const onPickFiles = (files: FileList | null) => {
    if (files) void addFiles(Array.from(files));
    if (fileRef.current) fileRef.current.value = "";
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter((it) => it.kind === "file");

    if (fileItems.length === 0) return;

    e.preventDefault();
    const files: File[] = [];
    for (const item of fileItems) {
      let file = item.getAsFile();
      if (!file && item.type.startsWith("image/")) {
        file = new File(
          [new Blob([], { type: item.type })],
          `clipboard-${Date.now()}.${item.type.split("/")[1] ?? "png"}`,
          { type: item.type }
        );
      }
      if (file) files.push(file);
    }
    if (files.length) await addFiles(files);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredSlash.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredSlash.length) % filteredSlash.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const selected = filteredSlash[slashIndex] || filteredSlash[0];
        if (selected) {
          selected.run(actions, setText);
          if (taRef.current) taRef.current.style.height = "auto";
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }

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
  const thinkingLevels = modelCaps?.thinkingLevels ?? [];
  const thinkingSupported = thinkingLevels.length > 0;
  const thinkingOptions = thinkingSupported
    ? THINKING_OPTIONS.filter((option) => option.value === "auto" || thinkingLevels.includes(option.value as Exclude<ThinkingSetting, "auto">))
    : [{ value: "auto" as ThinkingSetting, label: "Auto" }];

  return (
    <div className="composer">
      {/* Progressive-Disclosure Context & Runtime Tuning Popover */}
      {tuningOpen && (
        <div className="tuning-popover">
          <div className="tuning-popover-head">
            <span className="tuning-popover-title">Context &amp; Runtime</span>
            <div className="tuning-popover-actions">
              <button
                type="button"
                className="icon-btn"
                onClick={actions.refreshModels}
                title="Refresh available models"
              >
                <RefreshIcon />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setTuningOpen(false)}
                title="Close"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          <ContextMeter
            usage={state.usage}
            plan={state.plan}
            stats={state.generationStats}
            ollamaRuntime={state.ollamaRuntime}
            onCompact={() => {
              actions.compactContext();
              setTuningOpen(false);
            }}
            onOpenHardwareModal={() => {
              setTuningOpen(false);
              onOpenHardwareModal();
            }}
          />

          <div className="tuning-grid">
            <div className="tuning-field">
              <label className="tuning-label">Context Limit</label>
              <select
                className="tuning-select"
                value={
                  state.config.interfaceMode === "cloud"
                    ? 0
                    : CONTEXT_PRESETS.some((p) => p.value === (state.config.numCtxOverride || 0))
                      ? state.config.numCtxOverride || 0
                      : state.config.numCtxOverride
                }
                disabled={state.config.interfaceMode === "cloud"}
                onChange={(e) => {
                  if (state.config.interfaceMode === "cloud") return;
                  const val = parseInt(e.target.value, 10) || 0;
                  actions.setContextWindow(val);
                  if (val > 0) {
                    const check = checkContextWindowOverflow(val, modelCaps, state.machine);
                    if (check.overflows) onContextWarn(check);
                  }
                }}
              >
                {CONTEXT_PRESETS.map((p) => (
                  <option
                    key={p.value}
                    value={p.value}
                    disabled={state.config.interfaceMode === "cloud" && p.value !== 0}
                  >
                    {p.value === 0
                      ? state.config.interfaceMode === "cloud"
                        ? `${formatK(modelCaps?.contextLength ?? state.plan?.contextWindow ?? 128000)} (Native)`
                        : `Auto (${state.plan ? formatK(state.plan.numCtx) : "8k"})`
                      : p.label}
                  </option>
                ))}
                {state.config.interfaceMode !== "cloud" &&
                  state.config.numCtxOverride > 0 &&
                  !CONTEXT_PRESETS.some((p) => p.value === state.config.numCtxOverride) && (
                    <option value={state.config.numCtxOverride}>
                      {formatK(state.config.numCtxOverride)} ctx
                    </option>
                  )}
              </select>
            </div>

            <div className="tuning-field">
              <label className="tuning-label">Reasoning</label>
              <select
                className="tuning-select"
                value={
                  thinkingSupported && thinkingOptions.some((o) => o.value === state.config.thinkingLevel)
                    ? state.config.thinkingLevel
                    : "auto"
                }
                onChange={(e) => actions.setThinkingSetting(e.target.value as ThinkingSetting)}
                disabled={!thinkingSupported}
              >
                {thinkingOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {attachError && <div className="attach-error">{attachError}</div>}

      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a) => (
            <div key={a.id} className="attach-chip" title={a.name}>
              <span className="attach-kind">
                {a.kind === "image" ? <ImageFileIcon /> : <FileCodeIcon />}
              </span>
              <span className="attach-name">{a.name}</span>
              <span className="attach-size">{formatBytes(a.size)}</span>
              <button
                type="button"
                className="attach-remove"
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                title="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Real-Time Pull Progress Bar in Composer (Phase 5.4) */}
      <PullProgressBar state={state} actions={actions} />

      {/* Model Install Prompt Confirmation (Phase 5.3) */}
      {confirmInstallModel && (
        <div className="model-install-prompt-banner">
          <div className="prompt-left">
            <BoltIcon />
            <span>Install <strong>{confirmInstallModel}</strong> now?</span>
            {(() => {
              const rec = state.recommendations?.models.find((m) => m.name === confirmInstallModel);
              return rec ? <span className="prompt-fit">({rec.sizeGb} GB · {rec.fit.label})</span> : null;
            })()}
          </div>
          <div className="prompt-actions">
            <button
              type="button"
              className="btn primary prompt-btn"
              onClick={() => {
                actions.pullModel(confirmInstallModel);
                setConfirmInstallModel(null);
              }}
            >
              Install Now
            </button>
            <button
              type="button"
              className="btn ghost prompt-btn"
              onClick={() => setConfirmInstallModel(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Slash Commands Dropdown Menu */}
      {showSlashMenu && (
        <div className="slash-menu-popover">
          <div className="slash-menu-head">
            <span>Commands</span>
            <span className="slash-menu-hint">↑↓ to navigate · Enter to select · Esc to dismiss</span>
          </div>
          <div className="slash-menu-list">
            {filteredSlash.map((item, idx) => (
              <button
                key={item.cmd}
                type="button"
                className={`slash-menu-item${idx === slashIndex ? " active" : ""}`}
                onClick={() => {
                  item.run(actions, setText);
                  if (taRef.current) taRef.current.focus();
                }}
                onMouseEnter={() => setSlashIndex(idx)}
              >
                <div className="slash-item-left">
                  <span className="slash-item-icon">
                    {item.cmd === "/revert" || item.cmd === "/rewind" ? (
                      <RewindIcon size={13} />
                    ) : (
                      <BoltIcon />
                    )}
                  </span>
                  <span className="slash-item-cmd">{item.cmd}</span>
                </div>
                <span className="slash-item-desc">{item.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Unified Elevated Composer Card */}
      <div className="composer-card">
        <div className="composer-input-area">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={placeholder(state)}
            onChange={(e) => {
              setText(e.target.value);
              setSlashDismissed(false);
              setSlashIndex(0);
            }}
            onInput={autoGrow}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>

        <div className="composer-bottom-bar">
          <div className="composer-controls-left">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept={supportsVision ? "image/*,text/*,.md,.json,.csv,.log,.py,.ts,.tsx,.js,.jsx" : "text/*,.md,.json,.csv,.log,.py,.ts,.tsx,.js,.jsx"}
              onChange={(e) => onPickFiles(e.target.files)}
            />
            <button
              type="button"
              className="attach-btn"
              title={supportsVision ? "Attach image or code file" : "Attach text or code file"}
              onClick={() => fileRef.current?.click()}
              disabled={busy || !state.selectedModel}
            >
              <PaperclipIcon />
            </button>

            <ModeDropdown mode={state.mode} onChange={(m) => actions.setMode(m)} />

            <span className="composer-divider" />

            <div className="iface-toggle" title="Switch between Local (Ollama/llama.cpp) and Cloud provider APIs">
              <button
                type="button"
                className={state.config.interfaceMode === "local" ? "active" : ""}
                onClick={() => actions.setInterfaceMode("local")}
              >
                Local
              </button>
              <button
                type="button"
                className={state.config.interfaceMode === "cloud" ? "active" : ""}
                onClick={() => actions.setInterfaceMode("cloud")}
              >
                Cloud
              </button>
            </div>

            <ModelDropdown
              state={state}
              actions={actions}
              onPullModel={(model) => setConfirmInstallModel(model)}
            />
          </div>

          <div className="composer-controls-right">
            <ContextIconTrigger
              usage={state.usage}
              plan={state.plan}
              active={tuningOpen}
              onClick={() => setTuningOpen((o) => !o)}
            />
            {busy ? (
              <button type="button" className="send-btn stop" title="Stop generation" onClick={actions.cancel}>
                <StopSquareIcon />
              </button>
            ) : (
              <button type="button" className="send-btn" title="Send message (Enter)" disabled={!canSend} onClick={submit}>
                <SendArrowIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function placeholder(state: AppState): string {
  if (!state.selectedModel) {
    return state.config.interfaceMode === "cloud"
      ? "Configure a cloud provider in Settings → Providers to begin…"
      : "Start Ollama or llama.cpp and select a local model to begin…";
  }
  const verb = {
    chat: "Ask a question about your codebase",
    plan: "Describe a feature or refactor to plan",
    agent: "Describe a task to build, debug, or verify",
  }[state.mode];
  return `${verb}…`;
}
