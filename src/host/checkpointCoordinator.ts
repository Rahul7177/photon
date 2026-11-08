import type { HostMessage } from "../shared/protocol";
import type { SessionState } from "../shared/types";
import {
  CheckpointManager,
  type Checkpoint,
  type RecordBeforeChangeOptions,
} from "../core/checkpoints/checkpointManager";
import type { ProjectContextManager } from "../core/context/projectContext";
import { rewindMessagesToCheckpoint } from "./sessionCoordinator";

export type CheckpointSummary = ReturnType<CheckpointManager["getSessionCheckpointSummaries"]>[number];

export interface CheckpointCoordinatorDeps {
  getCheckpointManager: () => CheckpointManager | undefined;
  getContextManager: () => ProjectContextManager | undefined;
  getSession: () => SessionState;
  post: (msg: HostMessage) => void;
  persistSession: (session: SessionState) => Promise<void>;
  output: { appendLine: (line: string) => void };
  showInfo?: (message: string) => void;
}

/**
 * Coordinates turn-level checkpoints, rollback execution, and UI synchronization.
 * Isolates checkpoint orchestration from the primary controller.
 */
export class CheckpointCoordinator {
  constructor(private readonly deps: CheckpointCoordinatorDeps) {}

  beginTurn(sessionId: string, userMsgId: string, promptText: string): void {
    this.deps.getCheckpointManager()?.beginTurn(sessionId, userMsgId, promptText);
  }

  async recordBeforeChange(relPath: string, turnContext?: string | RecordBeforeChangeOptions): Promise<void> {
    await this.deps.getCheckpointManager()?.recordBeforeChange(relPath, turnContext);
  }

  async commitTurn(userMsgId: string): Promise<Checkpoint | null | undefined> {
    return await this.deps.getCheckpointManager()?.commitTurn(userMsgId);
  }

  cancelTurn(turnId?: string, sessionId?: string): void {
    this.deps.getCheckpointManager()?.cancelTurn(turnId, sessionId);
  }

  getSessionSummaries(sessionId: string): CheckpointSummary[] {
    return this.deps.getCheckpointManager()?.getSessionCheckpointSummaries(sessionId) ?? [];
  }

  openRevertModal(sessionId: string): void {
    const summaries = this.getSessionSummaries(sessionId);
    this.deps.post({ type: "openRevertModal", payload: { checkpoints: summaries } });
  }

  pushSessionCheckpoints(sessionId: string): void {
    const summaries = this.getSessionSummaries(sessionId);
    this.deps.post({ type: "checkpointsList", payload: { checkpoints: summaries } });
  }

  async rollbackToCheckpoint(checkpointId: string, rewindChat = true): Promise<boolean> {
    const checkpointMgr = this.deps.getCheckpointManager();
    if (!checkpointMgr) return false;
    this.deps.output.appendLine(
      `[checkpoint] Rolling back to checkpoint "${checkpointId}" (rewindChat=${rewindChat})`
    );

    const targetCp = checkpointMgr.getCheckpoint(checkpointId);
    const cpNum = targetCp?.checkpointNumber;
    const cpNumLabel = cpNum ? `Checkpoint #${cpNum}` : `checkpoint`;

    const result = await checkpointMgr.rollbackToCheckpoint(checkpointId);
    if (!result.success && result.revertedFiles.length === 0 && result.deletedFiles.length === 0) {
      this.deps.post({
        type: "error",
        payload: { message: `Rollback aborted (checkpoint preserved): ${result.errors.join("; ")}` },
      });
      return false;
    } else if (!result.success) {
      const failedOrConflict = result.fileResults.filter(
        (f) => f.status === "failed" || f.status === "conflict"
      );
      const detail = failedOrConflict
        .map((f) => `${f.relativePath} (${f.status}: ${f.reason || "unknown"})`)
        .join("; ");
      this.deps.post({
        type: "error",
        payload: {
          message: `Rollback partially completed: ${detail}. Checkpoint preserved for retry.`,
        },
      });
    }

    // Refresh symbol index for reverted/deleted files
    const ctxMgr = this.deps.getContextManager();
    if (ctxMgr) {
      for (const f of result.revertedFiles) void ctxMgr.indexSingleFile(f);
      for (const f of result.deletedFiles) ctxMgr.removeFile(f);
    }

    let restoredPrompt: string | undefined;
    const session = this.deps.getSession();

    if (rewindChat) {
      const rewound = rewindMessagesToCheckpoint(
        session.messages,
        checkpointId,
        result.targetTurnMessageId,
        result.label || ""
      );
      restoredPrompt = rewound.restoredPrompt;
      session.messages = rewound.rewoundMessages;
      session.updatedAt = Date.now();
      await this.deps.persistSession(session);
      this.deps.post({ type: "sessionLoaded", payload: session });
    }

    const summaries = checkpointMgr.getSessionCheckpointSummaries(session.id);

    this.deps.post({
      type: "checkpointRollbackDone",
      payload: {
        checkpointId: result.checkpointId,
        revertedFiles: result.revertedFiles,
        deletedFiles: result.deletedFiles,
        rewindChat,
        restoredPrompt,
        messages: session.messages,
        checkpoints: summaries,
      },
    });

    const fileSummary =
      result.revertedFiles.length > 0
        ? `Reverted ${result.revertedFiles.length} file(s)`
        : `Restored workspace`;
    const rewindSuffix = rewindChat ? " and rewound chat" : "";
    this.deps.showInfo?.(`Photon: ${fileSummary}${rewindSuffix} to ${cpNumLabel}.`);
    return true;
  }

  async revertToNumber(arg: string): Promise<boolean> {
    const checkpointMgr = this.deps.getCheckpointManager();
    if (!checkpointMgr) return false;
    const clean = arg.replace(/#/g, "").trim();
    const num = parseInt(clean, 10);
    if (isNaN(num)) {
      this.deps.post({
        type: "error",
        payload: { message: `Invalid checkpoint number: "${arg}". Use /revert or e.g. /revert 1.` },
      });
      return false;
    }
    const session = this.deps.getSession();
    const cp = checkpointMgr.getCheckpointByNumber(session.id, num);
    if (!cp) {
      this.deps.post({
        type: "error",
        payload: { message: `Checkpoint #${num} not found in this chat session.` },
      });
      return false;
    }
    return await this.rollbackToCheckpoint(cp.id, true);
  }

  async rewindLatest(): Promise<boolean> {
    const checkpointMgr = this.deps.getCheckpointManager();
    if (!checkpointMgr) return false;
    const session = this.deps.getSession();
    const latest = checkpointMgr.getLatestCheckpoint(session.id);
    if (!latest) {
      this.deps.post({
        type: "error",
        payload: { message: "No checkpoints recorded in this conversation yet." },
      });
      return false;
    }
    return await this.rollbackToCheckpoint(latest.id, true);
  }
}
