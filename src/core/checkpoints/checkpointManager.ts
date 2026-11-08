import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { resolveInWorkspace } from "../tools/paths";

export function computeFingerprint(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export type SnapshotFailureReason =
  | "stat_error"
  | "permission_denied"
  | "oversized"
  | "read_error"
  | "is_directory"
  | "symlink"
  | "special_file"
  | "binary";

export interface FileSnapshot {
  relativePath: string;
  existed: boolean;
  content?: string;
  encoding?: "utf8" | "base64";
  fingerprint?: string;
  mtimeMs?: number;
  oversized?: boolean;
  sizeBytes?: number;
  error?: string;
  failureReason?: SnapshotFailureReason;
  isSymlink?: boolean;
  symlinkTarget?: string;
  isBinary?: boolean;
}

export class SnapshotError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly relativePath: string,
    public readonly reason: SnapshotFailureReason
  ) {
    super(`Checkpoint snapshot failed for "${relativePath}": ${message}`);
    this.name = "SnapshotError";
  }
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export interface RecordBeforeChangeOptions {
  sessionId?: string;
  messageId?: string;
  allowUnprotected?: boolean;
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
  postMutationFingerprints?: Record<string, string>;
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

export type TurnLifecycleStatus = "created" | "recording" | "committed" | "cancelled" | "failed";

export interface ActiveTurnRecord {
  turnKey: string;
  sessionId: string;
  messageId: string;
  label: string;
  turnIndex: number;
  files: Map<string, FileSnapshot>;
  status: TurnLifecycleStatus;
  createdAt: number;
}

export const CHECKPOINT_SCHEMA_VERSION = 2;
export const MAX_CHECKPOINTS_STORED = 60;
export const MAX_FILE_SNAPSHOT_BYTES = 2 * 1024 * 1024; // 2 MB per file
export const MAX_TOTAL_SNAPSHOT_BYTES = 50 * 1024 * 1024; // 50 MB total snapshots across all checkpoints
export const MAX_MANIFEST_SIZE_BYTES = 60 * 1024 * 1024; // 60 MB total manifest size

export interface CheckpointManifest {
  version: number;
  updatedAt: number;
  checkpoints: Checkpoint[];
}

export function validateAndSanitizeCheckpoint(raw: any, defaultIndex: number): Checkpoint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return null;

  const messageId = typeof raw.messageId === "string" ? raw.messageId : `turn-${defaultIndex}`;
  const turnIndex =
    typeof raw.turnIndex === "number" && Number.isFinite(raw.turnIndex) ? raw.turnIndex : defaultIndex;
  const checkpointNumber =
    typeof raw.checkpointNumber === "number" && Number.isFinite(raw.checkpointNumber)
      ? raw.checkpointNumber
      : defaultIndex;
  const timestamp =
    typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now();
  const label = typeof raw.label === "string" ? raw.label : "Checkpoint";

  if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) return null;

  const validFiles: Record<string, FileSnapshot> = {};
  const unrestorableFiles: string[] = [];

  for (const [key, snap] of Object.entries(raw.files)) {
    const norm = key.replace(/\\/g, "/").replace(/^\.\//, "");
    if (norm.startsWith("../") || norm.includes("/../") || path.isAbsolute(norm)) {
      continue;
    }
    if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
      continue;
    }
    const s = snap as any;
    const existed = Boolean(s.existed);
    const fileSnap: FileSnapshot = {
      relativePath: norm,
      existed,
      content: typeof s.content === "string" ? s.content : undefined,
      encoding: s.encoding === "base64" || s.encoding === "utf8" ? s.encoding : undefined,
      mtimeMs: typeof s.mtimeMs === "number" && Number.isFinite(s.mtimeMs) ? s.mtimeMs : undefined,
      oversized: Boolean(s.oversized),
      sizeBytes: typeof s.sizeBytes === "number" && Number.isFinite(s.sizeBytes) ? s.sizeBytes : undefined,
      error: typeof s.error === "string" ? s.error : undefined,
      failureReason: s.failureReason,
      isSymlink: Boolean(s.isSymlink),
      symlinkTarget: typeof s.symlinkTarget === "string" ? s.symlinkTarget : undefined,
      isBinary: Boolean(s.isBinary),
      fingerprint: typeof s.fingerprint === "string" ? s.fingerprint : undefined,
    };
    if (fileSnap.oversized || fileSnap.error || (fileSnap.existed && fileSnap.content === undefined)) {
      unrestorableFiles.push(norm);
    }
    validFiles[norm] = fileSnap;
  }

  const modifiedFilesCount = Object.keys(validFiles).length;
  if (modifiedFilesCount === 0) return null;

  return {
    id: raw.id,
    sessionId: raw.sessionId,
    messageId,
    turnIndex,
    checkpointNumber,
    timestamp,
    label,
    files: validFiles,
    modifiedFilesCount,
    hasUnrestorableFiles: unrestorableFiles.length > 0 ? true : undefined,
    unrestorableFiles: unrestorableFiles.length > 0 ? unrestorableFiles : undefined,
    postMutationMtimes:
      typeof raw.postMutationMtimes === "object" && raw.postMutationMtimes !== null
        ? raw.postMutationMtimes
        : undefined,
    postMutationFingerprints:
      typeof raw.postMutationFingerprints === "object" && raw.postMutationFingerprints !== null
        ? raw.postMutationFingerprints
        : undefined,
  };
}

async function atomicRename(oldPath: string, newPath: string, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fs.rename(oldPath, newPath);
      return;
    } catch (err: any) {
      if (attempt === maxRetries || (err?.code !== "EPERM" && err?.code !== "EBUSY")) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private activeTurns = new Map<string, ActiveTurnRecord>();
  private activeTurnsByMessageId = new Map<string, ActiveTurnRecord>();
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
   * Backward-compatibility accessor for the current/most-recent active turn.
   */
  get activeTurn(): ActiveTurnRecord | null {
    const list = Array.from(this.activeTurns.values()).filter(
      (t) => t.status === "created" || t.status === "recording"
    );
    return list.length > 0 ? list[list.length - 1] : null;
  }

  /**
   * Helper to locate an active turn record by messageId, turnKey, or session.
   */
  findActiveTurn(messageIdOrKey: string, sessionId?: string): ActiveTurnRecord | undefined {
    if (sessionId) {
      const compositeKey = `${sessionId}:${messageIdOrKey}`;
      const found = this.activeTurns.get(compositeKey);
      if (found) return found;
    }
    const direct = this.activeTurns.get(messageIdOrKey);
    if (direct) return direct;

    const byMsg = this.activeTurnsByMessageId.get(messageIdOrKey);
    if (byMsg) return byMsg;

    for (const turn of this.activeTurns.values()) {
      if (turn.messageId === messageIdOrKey) {
        if (!sessionId || turn.sessionId === sessionId) {
          return turn;
        }
      }
    }
    return undefined;
  }

  /**
   * Look up an active turn record.
   */
  getActiveTurn(messageIdOrKey?: string, sessionId?: string): ActiveTurnRecord | undefined {
    if (messageIdOrKey) {
      return this.findActiveTurn(messageIdOrKey, sessionId);
    }
    return this.activeTurn ?? undefined;
  }

  /**
   * Ensure checkpoint manifest is loaded from disk.
   * Validates manifest schema, paths, timestamps, file records, and version.
   * Migrates legacy v1 (bare JSON array) to v2 schema cleanly.
   */
  async ensureInitialized(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw);
      let rawList: any[] = [];
      if (Array.isArray(parsed)) {
        // Legacy v1 schema: bare array of checkpoints
        rawList = parsed;
      } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.checkpoints)) {
        // v2+ schema envelope
        rawList = parsed.checkpoints;
      }

      const validCheckpoints: Checkpoint[] = [];
      for (let i = 0; i < rawList.length; i++) {
        const validated = validateAndSanitizeCheckpoint(rawList[i], i + 1);
        if (validated) {
          validCheckpoints.push(validated);
        }
      }

      this.checkpoints = validCheckpoints;
      this.turnCounter = this.checkpoints.reduce(
        (max, cp) => Math.max(max, cp.turnIndex || 0),
        0
      );
    } catch {
      this.checkpoints = [];
    }
    this.loaded = true;
  }

  /**
   * Start a new turn checkpoint record.
   * Any file mutations occurring during this turn will be recorded before writes happen.
   * Does NOT overwrite another in-flight turn's snapshot state.
   */
  beginTurn(sessionId: string, messageId: string, label: string): string {
    const turnKey = `${sessionId}:${messageId}`;
    const existing = this.activeTurns.get(turnKey);
    if (existing && (existing.status === "created" || existing.status === "recording")) {
      // Preserve existing in-flight turn's snapshots instead of overwriting
      return turnKey;
    }

    this.turnCounter++;
    const record: ActiveTurnRecord = {
      turnKey,
      sessionId,
      messageId,
      label: label.length > 100 ? label.slice(0, 97) + "…" : label,
      turnIndex: this.turnCounter,
      files: new Map<string, FileSnapshot>(),
      status: "created",
      createdAt: Date.now(),
    };

    this.activeTurns.set(turnKey, record);
    this.activeTurnsByMessageId.set(messageId, record);
    return turnKey;
  }

  /**
   * Captures the pre-mutation state of a file if not already captured in the active turn.
   * Called by file tools (edit_file, write_file, replace_in_file, append_file, etc.)
   * immediately before writing to disk.
   *
   * Binds to the originating turn context when provided, avoiding recording into
   * whatever turn happens to be active globally.
   *
   * Fails closed: distinguishes ENOENT from other stat/read errors. Only ENOENT
   * means the file did not exist. For permission/I/O errors, directories, or special files,
   * it preserves typed failure reasons and blocks unprotected mutations unless allowUnprotected is set.
   */
  async recordBeforeChange(
    relPath: string,
    turnContextOrOptions?: RecordBeforeChangeOptions | string
  ): Promise<void> {
    const opts: RecordBeforeChangeOptions =
      typeof turnContextOrOptions === "string"
        ? { messageId: turnContextOrOptions }
        : turnContextOrOptions || {};

    let turn: ActiveTurnRecord | undefined;
    if (opts.messageId) {
      turn = this.findActiveTurn(opts.messageId, opts.sessionId);
    } else if (opts.sessionId) {
      turn = Array.from(this.activeTurns.values()).find(
        (t) => t.sessionId === opts.sessionId && (t.status === "created" || t.status === "recording")
      );
    } else {
      const activeList = Array.from(this.activeTurns.values()).filter(
        (t) => t.status === "created" || t.status === "recording"
      );
      if (activeList.length === 1) {
        turn = activeList[0];
      } else if (activeList.length > 1) {
        turn = activeList[activeList.length - 1];
      }
    }

    if (!turn) return;
    if (turn.status !== "created" && turn.status !== "recording") return;
    turn.status = "recording";

    const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");

    // If already snapshotted in this turn, keep the first pre-turn ground truth
    if (turn.files.has(norm)) return;

    const r = resolveInWorkspace(this.workspaceRoot, norm);
    if ("error" in r) {
      const errorMsg = `Cannot resolve path in workspace: ${r.error}`;
      turn.files.set(norm, {
        relativePath: norm,
        existed: true,
        oversized: true,
        error: errorMsg,
        failureReason: "stat_error",
      });
      if (!opts.allowUnprotected) {
        throw new SnapshotError(errorMsg, "INVALID_PATH", norm, "stat_error");
      }
      return;
    }

    if (turn.status !== "recording") return;

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(r.abs);
    } catch (err: any) {
      if (turn.status !== "recording") return;
      if (err?.code === "ENOENT") {
        // STRICT: Only ENOENT proves the file did not exist before this turn!
        turn.files.set(norm, {
          relativePath: norm,
          existed: false,
        });
        return;
      }

      // Any other stat failure (EACCES, EPERM, EBUSY, EIO, etc.) must NEVER be treated as existed: false!
      const reason: SnapshotFailureReason =
        err?.code === "EACCES" || err?.code === "EPERM" ? "permission_denied" : "stat_error";
      const errorMsg = `Failed to stat file (${err?.code || "UNKNOWN"}): ${err?.message || String(err)}`;
      turn.files.set(norm, {
        relativePath: norm,
        existed: true,
        oversized: true,
        error: errorMsg,
        failureReason: reason,
      });
      if (!opts.allowUnprotected) {
        throw new SnapshotError(errorMsg, err?.code || "STAT_ERROR", norm, reason);
      }
      return;
    }

    if (turn.status !== "recording") return;

    // Handle symlinks
    if (stat.isSymbolicLink()) {
      try {
        const target = await fs.readlink(r.abs);
        const realStat = await fs.stat(r.abs).catch(() => null);
        if (!realStat) {
          // Broken symlink
          turn.files.set(norm, {
            relativePath: norm,
            existed: true,
            isSymlink: true,
            symlinkTarget: target,
          });
          return;
        }
        if (realStat.isDirectory()) {
          const errorMsg = `Path "${norm}" is a symlink pointing to a directory ("${target}")`;
          turn.files.set(norm, {
            relativePath: norm,
            existed: true,
            isSymlink: true,
            symlinkTarget: target,
            error: errorMsg,
            failureReason: "is_directory",
          });
          if (!opts.allowUnprotected) {
            throw new SnapshotError(errorMsg, "IS_DIR_SYMLINK", norm, "is_directory");
          }
          return;
        }
        if (realStat.size > MAX_FILE_SNAPSHOT_BYTES) {
          turn.files.set(norm, {
            relativePath: norm,
            existed: true,
            isSymlink: true,
            symlinkTarget: target,
            mtimeMs: realStat.mtimeMs,
            oversized: true,
            sizeBytes: realStat.size,
            failureReason: "oversized",
          });
          return;
        }
        const rawBuf = await fs.readFile(r.abs);
        if (turn.status !== "recording") return;
        const isBinary = isBinaryBuffer(rawBuf);
        const fingerprint = computeFingerprint(rawBuf);
        turn.files.set(norm, {
          relativePath: norm,
          existed: true,
          isSymlink: true,
          symlinkTarget: target,
          content: isBinary ? rawBuf.toString("base64") : rawBuf.toString("utf8"),
          encoding: isBinary ? "base64" : "utf8",
          fingerprint,
          mtimeMs: realStat.mtimeMs,
          sizeBytes: realStat.size,
          isBinary,
        });
        return;
      } catch (symErr: any) {
        if (turn.status !== "recording") return;
        const errorMsg = `Failed to snapshot symlink "${norm}": ${symErr?.message || String(symErr)}`;
        turn.files.set(norm, {
          relativePath: norm,
          existed: true,
          isSymlink: true,
          error: errorMsg,
          failureReason: "symlink",
        });
        if (!opts.allowUnprotected) {
          throw new SnapshotError(errorMsg, symErr?.code || "SYMLINK_ERROR", norm, "symlink");
        }
        return;
      }
    }

    // Handle directories
    if (stat.isDirectory()) {
      const errorMsg = `Path "${norm}" is a directory, not a regular file`;
      turn.files.set(norm, {
        relativePath: norm,
        existed: true,
        error: errorMsg,
        failureReason: "is_directory",
      });
      if (!opts.allowUnprotected) {
        throw new SnapshotError(errorMsg, "EISDIR", norm, "is_directory");
      }
      return;
    }

    // Handle special files (FIFOs, sockets, devices)
    if (!stat.isFile()) {
      const errorMsg = `Path "${norm}" is a special file, not a regular file`;
      turn.files.set(norm, {
        relativePath: norm,
        existed: true,
        error: errorMsg,
        failureReason: "special_file",
      });
      if (!opts.allowUnprotected) {
        throw new SnapshotError(errorMsg, "SPECIAL_FILE", norm, "special_file");
      }
      return;
    }

    // Bound snapshot size to prevent giant binaries from bloating memory
    if (stat.size > MAX_FILE_SNAPSHOT_BYTES) {
      turn.files.set(norm, {
        relativePath: norm,
        existed: true,
        mtimeMs: stat.mtimeMs,
        oversized: true,
        sizeBytes: stat.size,
        failureReason: "oversized",
      });
      return;
    }

    try {
      const rawBuf = await fs.readFile(r.abs);
      if (turn.status !== "recording") return;

      const isBinary = isBinaryBuffer(rawBuf);
      const fingerprint = computeFingerprint(rawBuf);
      turn.files.set(norm, {
        relativePath: norm,
        existed: true,
        content: isBinary ? rawBuf.toString("base64") : rawBuf.toString("utf8"),
        encoding: isBinary ? "base64" : "utf8",
        fingerprint,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        isBinary,
      });
    } catch (readErr: any) {
      if (turn.status !== "recording") return;
      const reason: SnapshotFailureReason =
        readErr?.code === "EACCES" || readErr?.code === "EPERM" ? "permission_denied" : "read_error";
      const errorMsg = `Failed to read file pre-mutation state (${readErr?.code || "UNKNOWN"}): ${readErr?.message || String(readErr)}`;
      turn.files.set(norm, {
        relativePath: norm,
        existed: true,
        oversized: true,
        error: errorMsg,
        failureReason: reason,
      });
      if (!opts.allowUnprotected) {
        throw new SnapshotError(errorMsg, readErr?.code || "READ_ERROR", norm, reason);
      }
    }
  }

  /**
   * Finalizes the active turn. If files were modified, commits a Checkpoint and persists it.
   * If messageId is stale/mismatched, it is a no-op and never clears another turn's record.
   */
  async commitTurn(messageId: string, sessionId?: string): Promise<Checkpoint | null> {
    const turn = this.findActiveTurn(messageId, sessionId);
    if (!turn) {
      return null;
    }

    if (turn.status === "committed" || turn.status === "cancelled" || turn.status === "failed") {
      return null;
    }

    this.activeTurns.delete(turn.turnKey);
    this.activeTurnsByMessageId.delete(turn.messageId);

    if (turn.files.size === 0) {
      turn.status = "committed";
      return null;
    }

    const filesObj: Record<string, FileSnapshot> = {};
    const unrestorable: string[] = [];
    const postMutationMtimes: Record<string, number> = {};
    const postMutationFingerprints: Record<string, string> = {};

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
            if (stat.size <= MAX_FILE_SNAPSHOT_BYTES) {
              const buf = await fs.readFile(r.abs).catch(() => null);
              if (buf) {
                postMutationFingerprints[k] = computeFingerprint(buf);
              }
            }
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
      postMutationFingerprints:
        Object.keys(postMutationFingerprints).length > 0 ? postMutationFingerprints : undefined,
    };

    const prevCheckpoints = [...this.checkpoints];
    try {
      this.checkpoints.push(checkpoint);
      await this.persist();
      turn.status = "committed";
      return checkpoint;
    } catch (err) {
      // Revert in-memory checkpoints so we never retain an unpersisted or failed checkpoint
      this.checkpoints = prevCheckpoints;
      turn.status = "failed";
      throw err;
    }
  }

  /**
   * Discards the active turn without committing.
   */
  cancelTurn(messageIdOrKey?: string, sessionId?: string): void {
    if (messageIdOrKey) {
      const turn = this.findActiveTurn(messageIdOrKey, sessionId);
      if (turn) {
        turn.status = "cancelled";
        this.activeTurns.delete(turn.turnKey);
        this.activeTurnsByMessageId.delete(turn.messageId);
      }
      return;
    }

    if (sessionId) {
      for (const turn of Array.from(this.activeTurns.values())) {
        if (turn.sessionId === sessionId) {
          turn.status = "cancelled";
          this.activeTurns.delete(turn.turnKey);
          this.activeTurnsByMessageId.delete(turn.messageId);
        }
      }
      return;
    }

    for (const turn of this.activeTurns.values()) {
      turn.status = "cancelled";
    }
    this.activeTurns.clear();
    this.activeTurnsByMessageId.clear();
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

    // Track the latest known post-mutation time and content fingerprint recorded by checkpoints for each file
    const latestPostMtimes = new Map<string, number>();
    const latestPostFingerprints = new Map<string, string>();

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
      if (cp.postMutationFingerprints) {
        for (const [rel, fp] of Object.entries(cp.postMutationFingerprints)) {
          latestPostFingerprints.set(rel, fp);
        }
      }
    }

    const fileResults: FileRollbackResult[] = [];
    const revertedFiles: string[] = [];
    const deletedFiles: string[] = [];
    const errors: string[] = [];

    for (const [rel, snap] of fileStates.entries()) {
      // Revalidate path immediately before restore to reduce TOCTOU races
      const r = resolveInWorkspace(this.workspaceRoot, rel);
      if ("error" in r) {
        const msg = `Could not resolve "${rel}": ${r.error}`;
        errors.push(msg);
        fileResults.push({ relativePath: rel, status: "failed", reason: msg });
        continue;
      }

      // Check if path is an escaping symlink
      const destLstat = await fs.lstat(r.abs).catch(() => null);
      if (destLstat?.isSymbolicLink()) {
        const realTarget = await fs.realpath(r.abs).catch(() => null);
        if (realTarget) {
          const realRel = path.relative(this.workspaceRoot, realTarget);
          if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
            const msg = `Security warning: path "${rel}" is a symlink escaping workspace boundary`;
            errors.push(msg);
            fileResults.push({ relativePath: rel, status: "failed", reason: msg });
            continue;
          }
        }
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
      let currentBuf: Buffer | null = null;
      let currentFp: string | null = null;
      if (currentStat && currentStat.isFile()) {
        currentBuf = await fs.readFile(r.abs).catch(() => null);
        if (currentBuf) {
          currentFp = computeFingerprint(currentBuf);
        }
      }

      // 3. Verify content equality before reporting external modification conflict:
      // If a previous partial rollback attempt already restored this file, its content on disk
      // already matches snap.content, but its mtime is newer. Detect content equality first!
      let alreadyRestored = false;
      if (currentStat && snap.existed && snap.content !== undefined) {
        if (snap.fingerprint && currentFp) {
          alreadyRestored = snap.fingerprint === currentFp;
        } else if (currentBuf) {
          const snapBuf =
            snap.encoding === "base64"
              ? Buffer.from(snap.content, "base64")
              : Buffer.from(snap.content, "utf8");
          alreadyRestored = currentBuf.equals(snapBuf);
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
        const expectedFp = latestPostFingerprints.get(rel);
        const knownPostMtime = latestPostMtimes.get(rel) || target.timestamp;
        const matchesPostMutation = Boolean(expectedFp && currentFp && expectedFp === currentFp);

        if (!matchesPostMutation && currentStat.mtimeMs > knownPostMtime + 1000) {
          const msg = `File was modified externally after checkpoint was created (last modified: ${new Date(
            currentStat.mtimeMs
          ).toLocaleTimeString()}). Pass force=true to overwrite.`;
          errors.push(`Conflict on "${rel}": ${msg}`);
          fileResults.push({ relativePath: rel, status: "conflict", reason: msg });
          continue;
        }
      }

      // 5. Restore or delete atomically
      try {
        if (snap.existed && snap.content !== undefined) {
          await fs.mkdir(path.dirname(r.abs), { recursive: true });
          if (snap.isSymlink && snap.symlinkTarget) {
            await fs.rm(r.abs, { force: true, recursive: true });
            await fs.symlink(snap.symlinkTarget, r.abs);
          } else {
            const data = snap.encoding === "base64" ? Buffer.from(snap.content, "base64") : snap.content;
            const tmpFile = `${r.abs}.${randomUUID()}.restore.tmp`;
            await fs.writeFile(tmpFile, data, snap.encoding === "base64" ? undefined : "utf8");
            await atomicRename(tmpFile, r.abs);
          }
          revertedFiles.push(rel);
          fileResults.push({ relativePath: rel, status: "restored" });
        } else if (!snap.existed) {
          // File was created in or after this checkpoint; remove it
          if (currentStat) {
            await fs.rm(r.abs, { force: true, recursive: true });
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
    const prev = [...this.checkpoints];
    this.checkpoints = this.checkpoints.filter((c) => c.id !== checkpointId);
    try {
      await this.persist();
    } catch (err) {
      this.checkpoints = prev;
      throw err;
    }
  }

  /**
   * Enforces total checkpoint count, total snapshot bytes, and total manifest size bounds.
   */
  enforceStorageLimits(): void {
    if (this.checkpoints.length > MAX_CHECKPOINTS_STORED) {
      this.checkpoints = this.checkpoints.slice(-MAX_CHECKPOINTS_STORED);
    }

    let totalBytes = this.calculateTotalSnapshotBytes();
    while (this.checkpoints.length > 1 && totalBytes > MAX_TOTAL_SNAPSHOT_BYTES) {
      this.checkpoints.shift();
      totalBytes = this.calculateTotalSnapshotBytes();
    }
  }

  calculateTotalSnapshotBytes(): number {
    let total = 0;
    for (const cp of this.checkpoints) {
      for (const snap of Object.values(cp.files)) {
        if (snap.content) {
          total += Buffer.byteLength(snap.content, snap.encoding || "utf8");
        } else if (snap.sizeBytes) {
          total += snap.sizeBytes;
        }
      }
    }
    return total;
  }

  private async persist(): Promise<void> {
    this.enforceStorageLimits();
    const manifest: CheckpointManifest = {
      version: CHECKPOINT_SCHEMA_VERSION,
      updatedAt: Date.now(),
      checkpoints: this.checkpoints,
    };
    let jsonStr = JSON.stringify(manifest, null, 2);
    while (this.checkpoints.length > 1 && Buffer.byteLength(jsonStr, "utf8") > MAX_MANIFEST_SIZE_BYTES) {
      this.checkpoints.shift();
      manifest.checkpoints = this.checkpoints;
      jsonStr = JSON.stringify(manifest, null, 2);
    }

    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    const tmpPath = `${this.storagePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmpPath, jsonStr, "utf8");
      await atomicRename(tmpPath, this.storagePath);
    } catch (err: any) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      console.error(`[checkpoints] Failed to persist checkpoints to ${this.storagePath}:`, err);
      throw err;
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

