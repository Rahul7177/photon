import { useState, useEffect } from "react";
import { useAppState } from "./state/store";
import { onHostMessage, post } from "./vscode";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { Hero } from "./components/Hero";
import { LocalProviderHub } from "./components/LocalProviderHub";
import { SettingsPanel } from "./components/SettingsPanel";
import { Approval } from "./components/Approval";
import { StatusIndicator } from "./components/StatusIndicator";
import { ProjectContextModal } from "./components/ProjectContextModal";
import { HardwareMetricsModal } from "./components/HardwareMetricsModal";
import { ContextWarningModal } from "./components/ContextWarningModal";
import { RevertModal } from "./components/RevertModal";
import { OnboardingModal } from "./components/OnboardingModal";
import type { ContextOverflowCheck } from "./contextPresets";
import type { Attachment } from "../../src/shared/types";
import { readFileToAttachment } from "./attachments";

/** Extract file paths/URIs from every drag format VS Code (and the OS) may
 *  carry: standard File lists (handled by caller), resourceurls (JSON),
 *  uri-lists (newline text), and the Explorer's own tree payload. */
function collectDroppedPaths(dt: DataTransfer): string[] {
  const out: string[] = [];
  const candidates = [
    dt.getData("resourceurls"),
    dt.getData("application/vnd.code.uri-list"),
    dt.getData("text/uri-list"),
    dt.getData("codefiles"),
    dt.getData("application/vnd.code.tree.explorer"),
    dt.getData("DownloadURL"),
    dt.getData("downloadurl"),
  ];
  for (let i = 0; i < candidates.length; i++) {
    const raw = candidates[i];
    if (!raw) continue;
    // JSON payloads (resourceurls, tree.explorer)
    try {
      const parsed = JSON.parse(raw);
      const uris = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.resources)
          ? parsed.resources.map((r: any) => r?.uri ?? r?.fsPath ?? r?.path)
          : Array.isArray(parsed?.context)
            ? parsed.context.map((r: any) => r?.uri ?? r?.fsPath ?? r?.path)
            : [];
      for (const u of uris) if (typeof u === "string" && u) out.push(u);
      if (out.length) return out;
      continue;
    } catch {
      /* not JSON — treat as uri-list text */
    }
    // The first five candidates are real URI formats: accept bare lines.
    // text/plain and DownloadURL are last-resort: only path/URI-looking lines,
    // so dropping selected prose can't turn into bogus file lookups.
    const strict = i >= 5;
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      // DownloadURL lines look like "mime:filename:url" — take the url part.
      const m = s.match(/^(?:[^:]+:[^:]+:)?(.*:\/\/\S+)$/);
      const candidate = m ? m[1] : s;
      if (!strict || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith("/") || candidate.startsWith("\\\\")) {
        out.push(candidate);
      }
    }
    if (out.length) return out;
  }
  return out;
}

export function App() {
  const { state, dispatch, actions } = useAppState();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "tools" | "models" | "providers" | "advanced">("general");
  const openSettings = (tab?: "general" | "tools" | "models" | "providers" | "advanced") => {
    if (tab) setSettingsTab(tab);
    setShowSettings(true);
  };
  const [showContextModal, setShowContextModal] = useState(false);
  const [showHardwareModal, setShowHardwareModal] = useState(false);
  const [ctxWarn, setCtxWarn] = useState<ContextOverflowCheck | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const [dragTypes, setDragTypes] = useState<string[]>([]);

  const model = state.models.find((m) => m.name === state.selectedModel);
  const supportsVision = model?.vision === true;

  // Explorer drops arrive as URIs (see onDrop) → host reads them → results
  // land here. Apply the same vision filter the picker/paste path uses.
  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.type !== "attachmentsAdded") return;
      const usable = msg.payload.attachments.filter(
        (a) => a.kind !== "image" || supportsVision
      );
      const skippedImages = msg.payload.attachments.length - usable.length;
      if (msg.payload.errors.length) setAttachError(msg.payload.errors[0]);
      else if (skippedImages > 0)
        setAttachError(`${model?.name ?? "This model"} can't read images — skipped ${skippedImages} image file(s).`);
      if (usable.length) setAttachments((a) => [...a, ...usable]);
    });
  }, [supportsVision, model?.name]);

  /** Read dropped/picked files into attachments, keeping only what the
   *  selected model can actually consume: images only for vision models,
   *  text/code always. Rejections surface as a one-line notice. */
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setAttachError(null);
    const next: Attachment[] = [];
    for (const file of files) {
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
  };

  // VS Code Explorer drags don't reliably expose their types to webviews
  // during dragover, so accept any drag: always preventDefault to allow the
  // drop, and decide what to do with the payload at drop time.
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    // Record the formats on offer so a failed drop can report them.
    setDragTypes(Array.from(e.dataTransfer.types ?? []));
    setDragDepth((d) => d + 1);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  const onDragLeave = () => setDragDepth((d) => Math.max(0, d - 1));
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragDepth(0);
    const seenTypes = Array.from(e.dataTransfer.types ?? []);
    setDragTypes(seenTypes);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) {
      void addFiles(files);
      return;
    }
    const paths = collectDroppedPaths(e.dataTransfer);
    if (paths.length) {
      post({ type: "attachPaths", payload: { paths } });
      return;
    }
    // Surface the formats we saw so a failed drop is diagnosable, not silent.
    const types = seenTypes.join(", ") || "(none)";
    setAttachError(`Nothing attachable in that drop (formats seen: ${types}). Try dragging from the Explorer, or use the paperclip button.`);
  };

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Header
        state={state}
        actions={actions}
        onOpenSettings={() => openSettings("general")}
        onOpenContextModal={() => {
          actions.requestProjectContext();
          setShowContextModal(true);
        }}
      />
      {showSettings ? (
        <SettingsPanel
          state={state}
          actions={actions}
          initialTab={settingsTab}
          onClose={() => setShowSettings(false)}
        />
      ) : (
        <>
          {state.messages.length === 0 ? (
            <Hero
              state={state}
              actions={actions}
              onOpenSettings={openSettings}
              onOpenHardwareModal={() => setShowHardwareModal(true)}
            />
          ) : (
            <>
              {!state.ollamaReachable && state.ready && state.config.interfaceMode === "local" && (
                <LocalProviderHub state={state} actions={actions} collapsible />
              )}
              <MessageList state={state} dispatch={dispatch} actions={actions} />
            </>
          )}
          {state.pendingApproval && (
            <div className="approval-dock">
              <Approval
                call={state.pendingApproval}
                actions={actions}
                onResolved={() => dispatch({ type: "_clearApproval" })}
              />
            </div>
          )}
          <Composer
            state={state}
            actions={actions}
            attachments={attachments}
            setAttachments={setAttachments}
            attachError={attachError}
            setAttachError={setAttachError}
            addFiles={addFiles}
            onOpenHardwareModal={() => setShowHardwareModal(true)}
            onContextWarn={setCtxWarn}
          />
        </>
      )}
      {showContextModal && (
        <ProjectContextModal
          context={state.projectContext}
          selectedModel={state.selectedModel}
          actions={actions}
          onClose={() => setShowContextModal(false)}
        />
      )}
      {showHardwareModal && (
        <HardwareMetricsModal
          state={state}
          actions={actions}
          onClose={() => setShowHardwareModal(false)}
        />
      )}
      {ctxWarn && (
        <ContextWarningModal
          title={ctxWarn.title}
          explanation={ctxWarn.explanation}
          recommendedTokens={ctxWarn.recommendedTokens}
          onUseRecommended={() => {
            actions.setContextWindow(ctxWarn.recommendedTokens);
            setCtxWarn(null);
          }}
          onKeepSelected={() => setCtxWarn(null)}
        />
      )}
      {state.revertModalOpen && (
        <RevertModal
          state={state}
          actions={actions}
          onClose={actions.closeRevertModal}
        />
      )}
      {state.showOnboarding && (
        <OnboardingModal
          state={state}
          actions={actions}
        />
      )}
      {dragDepth > 0 && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">
            <div className="drop-overlay-title">Drop files to attach as context</div>
            <div className="drop-overlay-hint">
              {supportsVision
                ? "Images and text/code files are supported by this model."
                : "This model reads text/code only — images will be rejected."}
            </div>
            {dragTypes.length > 0 && (
              <div className="drop-overlay-formats">formats: {dragTypes.join(", ")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
