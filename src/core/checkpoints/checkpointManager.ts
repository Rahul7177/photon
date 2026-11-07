import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveInWorkspace } from "../tools/paths";

export interface FileSnapshot {
  relativePath: string;
  existed: boolean;
  content?: string;
  mtimeMs?: number;
  oversized?: boolean;
  sizeBytes?: number;
  error?: string;
}

export type FileRollbackStatus = "restored" | "deleted" | "skipped" | "conflict" | "failed";

export interface FileRollbackResult {
  relativePath: string;
  status: FileRollbackStatus;
  reason?: string;
}

export interface RollbackOptions {
  /** If true, overwrite external modifications and ignore conflict detection */
  force?: boolean;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  messageId: string;
  turnIndex: number;
  checkpointNumber: number;
  timestamp: number;
  label: string;
  files: Record<string, FileSnapshot>;
  modifiedFilesCount: number;
  hasUnrestorableFiles?: boolean;
  unrestorableFiles?: string[];
  postMutationMtimes?: Record<string, number>;
}

export interface CheckpointRollbackResult {
  success: boolean;
  checkpointId: string;
  label: string;
  revertedFiles: string[];
  deletedFiles: string[];
  fileResults: FileRollbackResult[];
  errors: string[];
  targetTurnMessageId: string;
}

interface ActiveTurnRecord {
  sessionId: string;
  messageId: string;
  label: string;
  turnIndex: number;
  files: Map<string, FileSnapshot>;
}

const MAX_CHECKPOINTS_STORED = 60;
const MAX_FILE_SNAPSHOT_BYTES = 2 * 1024 * 1024; // 2 MB per file

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private activeTurn: ActiveTurnRecord | null = null;
  private turnCounter = 0;
  private loaded = false;
  private readonly storagePath: string;

  constructor(
    private readonly workspaceRoot: string,
    customStoragePath?: string
  ) {
    this.storagePath =
      customStoragePath || path.join(workspaceRoot, ".photon", "checkpoints.json");
  }

  /**
   * Ensure checkpoint manifest is loaded from disk.
   */
  async ensureInitialized(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.checkpoints = parsed.map((cp, idx) => ({
          ...cp,
          checkpointNumber: typeof cp.checkpointNumber === "number" ? cp.checkpointNumber : idx + 1,
        }));
        this.turnCounter = this.checkpoints.reduce(
          (max, cp) => Math.max(max, cp.turnIndex || 0),
          0
        );
      }
    } catch {
      this.checkpoints = [];
    }
    this.loaded = true;
  }

  /**
   * Start a new turn checkpoint record.
   * Any file mutations occurring during this turn will be recorded before writes happen.
   */
  beginTurn(sessionId: string, messageId: string, label: string): void {
    this.turnCounter++;
    this.activeTurn = {
      sessionId,
      messageId,
      label: label.length > 100 ? label.slice(0, 97) + "…" : label,
      turnIndex: this.turnCounter,
      files: new Map<string, FileSnapshot>(),
    };
  }

  /**
   * Captures the pre-mutation state of a file if not already captured in the active turn.
   * Called by file tools (edit_file, write_file, replace_in_file, append_file, etc.)
   * immediately before writing to disk.
   */
  async recordBeforeChange(relPath: string): Promise<void> {
    if (!this.activeTurn) return;
    const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");

    // If already snapshotted in this turn, keep the first pre-turn ground truth
    if (this.activeTurn.files.has(norm)) return;

    const r = resolveInWorkspace(this.workspaceRoot, norm);
    if ("error" in r) return;

    try {
      const stat = await fs.stat(r.abs).catch(() => null);
      if (!stat) {
        // File does not exist yet (will be created in this turn)
        this.activeTurn.files.set(norm, {
          relativePath: norm,
          existed: false,
        });
        return;
      }

      if (stat.isDirectory()) return;

      // Bound snapshot size to prevent giant binaries from bloating memory
      if (stat.size > MAX_FILE_SNAPSHOT_BYTES) {
        this.activeTurn.files.set(norm, {
          relativePath: norm,
          existed: true,
          mtimeMs: stat.mtimeMs,
          oversized: true,
          sizeBytes: stat.size,
        });
        return;
      }

      const content = await fs.readFile(r.abs, "utf8");
      this.activeTurn.files.set(norm, {
        relativePath: norm,
        existed: true,
        content,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    } catch (err: any) {
      // Record failed snapshot explicitly so tool mutations are not treated as silently restorable
      this.activeTurn.files.set(norm, {
        relativePath: norm,
        existed: true,
        oversized: true,
        error: `Failed to snapshot pre-mutation state: ${err.message || String(err)}`,
      });
    }
  }

  /**
   * Finalizes the active turn. If files were modified, commits a Checkpoint and persists it.
   */
  async commitTurn(messageId: string): Promise<Checkpoint | null> {
    if (!this.activeTurn || this.activeTurn.messageId !== messageId) {
      this.activeTurn = null;
      return null;
    }

    const turn = this.activeTurn;
    this.activeTurn = null;

    if (turn.files.size === 0) {
      return null;
    }

    const filesObj: Record<string, FileSnapshot> = {};
    const unrestorable: string[] = [];
    const postMutationMtimes: Record<string, number> = {};

    for (const [k, v] of turn.files.entries()) {
      filesObj[k] = v;
      if (v.oversized) {
        unrestorable.push(k);
      }
      const r = resolveInWorkspace(this.workspaceRoot, k);
      if (!("error" in r)) {
        try {
          const stat = await fs.stat(r.abs).catch(() => null);
          if (stat) {
            postMutationMtimes[k] = stat.mtimeMs;
          }
        } catch {
          // ignore
        }
      }
    }

    await this.ensureInitialized();
    const sessionCheckpoints = this.checkpoints.filter((c) => c.sessionId === turn.sessionId);
    const checkpointNumber = sessionCheckpoints.length + 1;

    const checkpoint: Checkpoint = {
      id: `cp_${randomUUID()}`,
      sessionId: turn.sessionId,
      messageId: turn.messageId,
      turnIndex: turn.turnIndex,
      checkpointNumber,
      timestamp: Date.now(),
      label: turn.label,
      files: filesObj,
      modifiedFilesCount: turn.files.size,
      hasUnrestorableFiles: unrestorable.length > 0 ? true : undefined,
      unrestorableFiles: unrestorable.length > 0 ? unrestorable : undefined,
      postMutationMtimes,
    };

    this.checkpoints.push(checkpoint);

    // Keep bounded history
    if (this.checkpoints.length > MAX_CHECKPOINTS_STORED) {
      this.checkpoints = this.checkpoints.slice(-MAX_CHECKPOINTS_STORED);
    }

    await this.persist();
    return checkpoint;
  }

  /**
   * Discards the active turn without committing.
   */
  cancelTurn(): void {
    this.activeTurn = null;
  }

  /**
   * Rollback the workspace files to the exact state before the specified checkpoint.
   * Walks backward through all checkpoints from the latest down to targetId,
   * restoring the earliest pre-mutation file state for each touched file.
   *
   * If any file restoration fails or encounters external conflict, the checkpoint
   * records are PRESERVED so that the user can retry without losing recovery state.
   */
  async rollbackToCheckpoint(
    checkpointId: string,
    options?: RollbackOptions
  ): Promise<CheckpointRollbackResult> {
    await this.ensureInitialized();

    const targetIdx = this.checkpoints.findIndex((cp) => cp.id === checkpointId);
    if (targetIdx === -1) {
      return {
        success: false,
        checkpointId,
        label: "",
        revertedFiles: [],
        deletedFiles: [],
        fileResults: [],
        errors: [`Checkpoint "${checkpointId}" not found.`],
        targetTurnMessageId: "",
      };
    }

    const target = this.checkpoints[targetIdx];
    // Restrict rollback strictly to the target checkpoint's session.
    // Checkpoint records from OTHER sessions in the shared workspace must NOT be touched or pruned.
    const sessionCheckpoints = this.checkpoints.filter((cp) => cp.sessionId === target.sessionId);
    const targetSessionIdx = sessionCheckpoints.findIndex((cp) => cp.id === checkpointId);
    const affectedCheckpoints = sessionCheckpoints.slice(targetSessionIdx);
    const affectedIds = new Set(affectedCheckpoints.map((cp) => cp.id));

    // For every file touched across these checkpoints in THIS session, find the earliest snapshot
    // (i.e. its state right before the target checkpoint turn began).
    const fileStates = new Map<string, FileSnapshot>();

    // Track the latest known post-mutation time recorded by checkpoints for each file
    const latestPostMtimes = new Map<string, number>();

    // Process from oldest in the affected range to newest: earliest snapshot wins
    for (const cp of affectedCheckpoints) {
      for (const [rel, snap] of Object.entries(cp.files)) {
        if (!fileStates.has(rel)) {
          fileStates.set(rel, snap);
        }
      }
      if (cp.postMutationMtimes) {
        for (const [rel, mt] of Object.entries(cp.postMutationMtimes)) {
          latestPostMtimes.set(rel, mt);
        }
      }
    }

    const fileResults: FileRollbackResult[] = [];
    const revertedFiles: string[] = [];
    const deletedFiles: string[] = [];
    const errors: string[] = [];

    for (const [rel, snap] of fileStates.entries()) {
      const r = resolveInWorkspace(this.workspaceRoot, rel);
      if ("error" in r) {
        const msg = `Could not resolve "${rel}": ${r.error}`;
        errors.push(msg);
        fileResults.push({ relativePath: rel, status: "failed", reason: msg });
        continue;
      }

      // 1. Files larger than 2MB where content could not be retained or read failed
      if (snap.oversized || (snap.existed && snap.content === undefined)) {
        const sizeDesc = snap.sizeBytes
          ? ` (${Math.round((snap.sizeBytes / (1024 * 1024)) * 10) / 10} MB)`
          : "";
        const detail = snap.error ? `: ${snap.error}` : ` exceeds 2 MB limit${sizeDesc}; original content was not retained for rollback.`;
        const msg = `File${detail}`;
        errors.push(`Cannot restore "${rel}": ${msg}`);
        fileResults.push({ relativePath: rel, status: "failed", reason: msg });
        continue;
      }

      // 2. Check current status on disk
      const currentStat = await fs.stat(r.abs).catch(() => null);

      // 3. Verify content equality before reporting external modification conflict:
      // If a previous partial rollback attempt already restored this file, its content on disk
      // already matches snap.content, but its mtime is newer. Detect content equality first!
      let alreadyRestored = false;
      if (currentStat && snap.existed && snap.content !== undefined) {
        try {
          const currentContent = await fs.readFile(r.abs, "utf8");
          if (currentContent === snap.content) {
            alreadyRestored = true;
          }
        } catch {
          // ignore read error
        }
      } else if (!currentStat && !snap.existed) {
        alreadyRestored = true;
      }

      if (alreadyRestored) {
        fileResults.push({
          relativePath: rel,
          status: "skipped",
          reason: "Already in target checkpoint state (restored in earlier attempt or unchanged)",
        });
        continue;
      }

      // 4. Detect external modifications (newer user work after checkpoint)
      if (currentStat && !options?.force) {
        const knownPostMtime = latestPostMtimes.get(rel) || target.timestamp;
        // If current file has an mtime > 1000ms after the checkpoint/mutation time, user edited it externally
        if (currentStat.mtimeMs > knownPostMtime + 1000) {
          const msg = `File was modified externally after checkpoint was created (last modified: ${new Date(
            currentStat.mtimeMs
          ).toLocaleTimeString()}). Pass force=true to overwrite.`;
          errors.push(`Conflict on "${rel}": ${msg}`);
          fileResults.push({ relativePath: rel, status: "conflict", reason: msg });
          continue;
        }
      }

      // 5. Restore or delete
      try {
        if (snap.existed && snap.content !== undefined) {
          // Restore file content
          await fs.mkdir(path.dirname(r.abs), { recursive: true });
          await fs.writeFile(r.abs, snap.content, "utf8");
          revertedFiles.push(rel);
          fileResults.push({ relativePath: rel, status: "restored" });
        } else if (!snap.existed) {
          // File was created in or after this checkpoint; remove it
          if (currentStat) {
            await fs.rm(r.abs, { force: true });
            deletedFiles.push(rel);
            fileResults.push({ relativePath: rel, status: "deleted" });
          } else {
            fileResults.push({
              relativePath: rel,
              status: "skipped",
              reason: "File was already absent",
            });
          }
        }
      } catch (e) {
        const msg = `Failed to process "${rel}": ${(e as Error).message}`;
        errors.push(msg);
        fileResults.push({ relativePath: rel, status: "failed", reason: msg });
      }
    }

    const hasFailure =
      errors.length > 0 ||
      fileResults.some((r) => r.status === "failed" || r.status === "conflict");

    // Only prune checkpoint history if ALL file restorations succeeded!
    // Prune ONLY the checkpoints belonging to this session; preserve other sessions' history!
    if (!hasFailure) {
      this.checkpoints = this.checkpoints.filter((cp) => !affectedIds.has(cp.id));
      await this.persist();
    }

    return {
      success: !hasFailure,
      checkpointId: target.id,
      label: target.label,
      revertedFiles,
      deletedFiles,
      fileResults,
      errors,
      targetTurnMessageId: target.messageId,
    };
  }

  /**
   * List checkpoints for a session (or all if not filtered), newest first.
   */
  listCheckpoints(sessionId?: string): Checkpoint[] {
    const list = sessionId
      ? this.checkpoints.filter((c) => c.sessionId === sessionId)
      : this.checkpoints;
    return [...list].reverse();
  }

  /**
   * Look up a checkpoint by its ID.
   */
  getCheckpoint(checkpointId: string): Checkpoint | undefined {
    return this.checkpoints.find((c) => c.id === checkpointId);
  }

  /**
   * Look up a checkpoint by its session-specific number (e.g. 1 for Checkpoint #1).
   */
  getCheckpointByNumber(sessionId: string, num: number): Checkpoint | undefined {
    return this.checkpoints.find(
      (c) => c.sessionId === sessionId && c.checkpointNumber === num
    );
  }

  /**
   * Get summaries of all checkpoints for a session (newest first).
   */
  getSessionCheckpointSummaries(sessionId: string): Array<{
    id: string;
    checkpointNumber: number;
    timestamp: number;
    label: string;
    filesCount: number;
    files: string[];
    messageId: string;
    hasUnrestorableFiles?: boolean;
    unrestorableFiles?: string[];
  }> {
    return this.listCheckpoints(sessionId).map((cp) => ({
      id: cp.id,
      checkpointNumber: cp.checkpointNumber,
      timestamp: cp.timestamp,
      label: cp.label,
      filesCount: cp.modifiedFilesCount,
      files: Object.keys(cp.files),
      messageId: cp.messageId,
      hasUnrestorableFiles: cp.hasUnrestorableFiles,
      unrestorableFiles: cp.unrestorableFiles,
    }));
  }

  /**
   * Get the most recent checkpoint.
   */
  getLatestCheckpoint(sessionId?: string): Checkpoint | undefined {
    const list = this.listCheckpoints(sessionId);
    return list[0];
  }

  /**
   * Delete a single checkpoint record without modifying files.
   */
  async discardCheckpoint(checkpointId: string): Promise<void> {
    await this.ensureInitialized();
    this.checkpoints = this.checkpoints.filter((c) => c.id !== checkpointId);
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
      await fs.writeFile(this.storagePath, JSON.stringify(this.checkpoints, null, 2), "utf8");
    } catch (err: any) {
      console.error(`[checkpoints] Failed to persist checkpoints to ${this.storagePath}:`, err);
    }
  }
}

const managers = new Map<string, CheckpointManager>();

export function getCheckpointManager(workspaceRoot?: string): CheckpointManager | undefined {
  if (!workspaceRoot) return undefined;
  let mgr = managers.get(workspaceRoot);
  if (!mgr) {
    mgr = new CheckpointManager(workspaceRoot);
    managers.set(workspaceRoot, mgr);
  }
  return mgr;
}

/** Reset helper for testing */
export function _resetCheckpointManagersForTesting(): void {
  managers.clear();
}

