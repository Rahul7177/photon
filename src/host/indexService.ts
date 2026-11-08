import * as vscode from "vscode";
import type { OllamaClient } from "../core/ollama/client";
import { VectorStore } from "../core/index/vectorStore";
import { WorkspaceIndex, shouldIndexFile, MAX_INDEXABLE_FILE_BYTES } from "../core/index/indexer";
import type { IndexStatus } from "../shared/types";

// Bounds so a huge repo never freezes the host or blows memory (M10 checklist).
const MAX_FILES = 1500;
const MAX_FILE_BYTES = MAX_INDEXABLE_FILE_BYTES;
const MAX_TOTAL_BYTES = 40_000_000; // 40MB total indexed workspace bytes
const MAX_PENDING_QUEUE = 2000;
const FILE_GLOB =
  "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,cc,cpp,h,hpp,cs,rb,php,swift,kt,scala,vue,svelte,md,json,yaml,yml,toml,sh}";
const EXCLUDE_GLOB =
  "**/{node_modules,.git,.photon,dist,out,build,.next,.venv,__pycache__,.turbo,coverage,.cache,target,vendor}/**";
const DEBOUNCE_MS = 800;
const SAVE_DEBOUNCE_MS = 4000;

function isIgnoredPath(rel: string): boolean {
  return !shouldIndexFile(rel).indexable;
}

function isNotFoundError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  const name = (e as Error)?.name;
  const msg = (e as Error)?.message?.toLowerCase() ?? "";
  return (
    code === "ENOENT" ||
    code === "FileNotFound" ||
    name === "EntryNotFound" ||
    msg.includes("not found") ||
    msg.includes("enoent")
  );
}

/**
 * Offline-first workspace indexing (M10). Chunks + embeds files via a LOCAL
 * Ollama embedding model into a pure-TS vector store; no cloud, no server
 * process. Runs in the background with progress, is fully abortable, watches for
 * incremental changes, and persists across reloads so we don't re-embed every
 * time. Retrieval feeds the agent engine's context injection.
 */
export class IndexService {
  private store = new VectorStore();
  private index?: WorkspaceIndex;
  private watcher?: vscode.FileSystemWatcher;
  private renameSub?: vscode.Disposable;
  private activeAbort?: AbortController;
  private freshnessAbort?: AbortController;
  private readonly pendingFiles = new Set<string>();
  private readonly fileModEpoch = new Map<string, number>();
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  private saveChain: Promise<void> = Promise.resolve();
  private saveVersion = 0;
  private lastSavedVersion = 0;

  private enabled = false;
  private embeddingModel = "";
  private status: IndexStatus = { phase: "idle", filesIndexed: 0, chunks: 0, pending: 0 };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: OllamaClient,
    private readonly log: (msg: string) => void,
    private readonly onStatus: (status: IndexStatus) => void
  ) {}

  getStatus(): IndexStatus {
    return this.status;
  }

  /** Enable/disable indexing. `modelAvailable` = embedding model present in Ollama. */
  async configure(enabled: boolean, embeddingModel: string, modelAvailable: boolean): Promise<void> {
    this.embeddingModel = embeddingModel;
    if (!enabled) {
      this.enabled = false;
      this.teardownWork();
      this.disposeWatcher();
      this.store.clear();
      this.setStatus({ phase: "idle", filesIndexed: 0, chunks: 0, pending: 0 });
      return;
    }
    this.enabled = true;
    // Cancel any in-flight indexing or freshness validation before reconfiguring so a config change can't
    // race two index loops (or swap the store out from under a running one).
    this.teardownWork();
    if (!modelAvailable) {
      this.disposeWatcher();
      this.setStatus({
        phase: "unavailable",
        filesIndexed: 0,
        chunks: 0,
        pending: 0,
        embeddingModel,
        message: `Embedding model "${embeddingModel}" isn't installed. Run: ollama pull ${embeddingModel}`,
      });
      return;
    }
    await this.load(); // may replace this.store with a persisted one
    this.makeIndex();
    this.ensureWatcher();

    // If we loaded nothing from disk (or persisted store was invalidated due to embedding model mismatch),
    // do a full background index.
    if (this.store.stats.chunks === 0) {
      void this.reindex();
    } else {
      // Do not prematurely publish "ready" while freshness validation is still pending.
      // Publish "validating" state so the UI accurately communicates background status.
      this.setStatus({
        phase: "validating",
        filesIndexed: this.store.stats.files,
        chunks: this.store.stats.chunks,
        pending: 0,
        embeddingModel,
        message: "Validating index freshness...",
      });
      void this.validateFreshnessAndReindexStale();
    }
  }

  /** (Re)bind the index to the current store + a local-Ollama embed function. */
  private makeIndex(): void {
    this.store.setEmbeddingModel(this.embeddingModel);
    this.index = new WorkspaceIndex(this.store, (texts) =>
      this.client.embed(this.embeddingModel, texts, 120_000)
    );
  }

  /** Full (re)index in the background. Abortable; never blocks the caller. */
  async reindex(): Promise<void> {
    if (!this.enabled || !this.index || this.disposed) return;
    this.teardownWork();
    const abort = new AbortController();
    this.activeAbort = abort;

    let files: vscode.Uri[];
    try {
      // Find candidate files and sort deterministically so indexing subsets are reproducible.
      const found = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB);
      found.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
      if (found.length > MAX_FILES) {
        files = found.slice(0, MAX_FILES);
        this.log(
          `[index] workspace contains ${found.length} candidate files; indexing top ${MAX_FILES} deterministically (${found.length - MAX_FILES} excluded due to budget).`
        );
      } else {
        files = found;
      }
    } catch (e) {
      this.setStatus({ ...this.status, phase: "error", message: (e as Error).message });
      return;
    }

    this.store.clear();
    let done = 0;
    let totalBytes = 0;
    this.setStatus({ phase: "indexing", filesIndexed: 0, chunks: 0, pending: files.length });

    for (const uri of files) {
      if (abort.signal.aborted || this.disposed) return;
      const rel = vscode.workspace.asRelativePath(uri, false);
      const startEpoch = this.fileModEpoch.get(rel) ?? 0;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) {
          done++;
          continue;
        }
        if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
          this.log(
            `[index] total indexed bytes budget reached (${Math.round(totalBytes / 1024 / 1024)}MB) — stopping full index.`
          );
          break;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString("utf8");

        await this.index.indexFile(rel, content, abort.signal);

        // Check whether a newer watcher event touched this file while indexing was in-flight
        const latestEpoch = this.fileModEpoch.get(rel) ?? 0;
        if (latestEpoch > startEpoch) {
          this.log(`[index] skipping stale commit for ${rel} — newer file event arrived during indexing.`);
          this.queueFile(rel);
        } else {
          this.store.setFileMtime(rel, stat.mtime);
          this.store.setFileSize(rel, stat.size);
          totalBytes += stat.size;
        }
      } catch (e) {
        this.log(`[index] skip ${rel}: ${(e as Error).message}`);
      }
      done++;
      if (done % 10 === 0 || done === files.length) {
        const { files: f, chunks } = this.store.stats;
        this.setStatus({
          phase: "indexing",
          filesIndexed: f,
          chunks,
          pending: files.length - done,
          embeddingModel: this.embeddingModel,
        });
        await delay(0);
      }
    }

    if (abort.signal.aborted || this.disposed) return;
    this.publishReady();
    this.scheduleSave();
    this.log(`[index] ready: ${this.store.stats.files} files, ${this.store.stats.chunks} chunks.`);
  }

  /** Semantic retrieval for the agent engine's context injection. */
  async retrieveContext(query: string, signal: AbortSignal): Promise<string | undefined> {
    if (!this.enabled || !this.index || this.store.stats.chunks === 0) return undefined;
    try {
      return await this.index.retrieveContext(query, 4000, signal);
    } catch (e) {
      this.log(`[index] retrieve failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.teardownWork();
    this.disposeWatcher();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    void this.save();
  }

  private disposeWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.renameSub?.dispose();
    this.renameSub = undefined;
  }

  /* ------------------------------- internals ------------------------------ */

  private ensureWatcher(): void {
    if (this.watcher) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, FILE_GLOB));
    const touch = (uri: vscode.Uri) => {
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (isIgnoredPath(rel)) return;
      this.fileModEpoch.set(rel, Date.now());
      this.queueFile(rel);
    };
    w.onDidCreate(touch);
    w.onDidChange(touch);
    w.onDidDelete((uri) => {
      if (!this.index) return;
      const rel = vscode.workspace.asRelativePath(uri, false);
      this.fileModEpoch.set(rel, Date.now());
      this.index.removeFile(rel);
      this.publishReady();
      this.scheduleSave();
    });
    this.renameSub = vscode.workspace.onDidRenameFiles((event) => {
      if (!this.index) return;
      for (const { oldUri, newUri } of event.files) {
        const oldRel = vscode.workspace.asRelativePath(oldUri, false);
        const newRel = vscode.workspace.asRelativePath(newUri, false);
        this.fileModEpoch.set(oldRel, Date.now());
        this.fileModEpoch.set(newRel, Date.now());
        this.index.removeFile(oldRel);
        if (!isIgnoredPath(newRel)) {
          this.queueFile(newRel);
        }
      }
      this.publishReady();
      this.scheduleSave();
    });
    this.watcher = w;
  }

  /** Debounced incremental re-index of changed files. */
  private queueFile(rel: string): void {
    if (!this.enabled || !this.index || this.disposed) return;

    // Coalesce events and bound pending file queue growth during file storms (e.g. git checkout)
    if (this.pendingFiles.size >= MAX_PENDING_QUEUE) {
      this.log(
        `[index] watcher event storm (${this.pendingFiles.size} pending) — coalescing into full freshness validation.`
      );
      this.pendingFiles.clear();
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void this.validateFreshnessAndReindexStale(), DEBOUNCE_MS * 2);
      return;
    }

    this.pendingFiles.add(rel);
    this.setStatus({ ...this.status, pending: this.pendingFiles.size });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flushPending(), DEBOUNCE_MS);
  }

  private async flushPending(): Promise<void> {
    if (!this.index || this.disposed) return;
    const files = [...this.pendingFiles];
    this.pendingFiles.clear();
    const abort = new AbortController();
    const signal = abort.signal;

    for (const rel of files) {
      if (this.disposed) return;
      const startEpoch = this.fileModEpoch.get(rel) ?? 0;
      try {
        const uri = this.relToUri(rel);
        if (!uri) continue;
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) {
          this.index.removeFile(rel);
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        await this.index.indexFile(rel, Buffer.from(bytes).toString("utf8"), signal);

        // Check if newer watcher event arrived for this file while embedding
        const latestEpoch = this.fileModEpoch.get(rel) ?? 0;
        if (latestEpoch > startEpoch) {
          this.log(`[index] skipping stale commit for ${rel} — newer file event arrived during indexing.`);
          this.queueFile(rel);
        } else {
          this.store.setFileMtime(rel, stat.mtime);
          this.store.setFileSize(rel, stat.size);
        }
      } catch (e) {
        // Distinguish deletion from transient I/O or permissions errors (EPERM, EBUSY)
        if (isNotFoundError(e)) {
          this.index.removeFile(rel);
        } else {
          this.log(`[index] deferred ${rel} due to transient error: ${(e as Error).message}`);
        }
      }
    }
    this.publishReady();
    this.scheduleSave();
  }

  private publishReady(): void {
    if (this.disposed) return;
    const { files, chunks } = this.store.stats;
    this.setStatus({
      phase: "ready",
      filesIndexed: files,
      chunks,
      pending: this.pendingFiles.size,
      embeddingModel: this.embeddingModel,
      message: undefined,
    });
  }

  private setStatus(status: IndexStatus): void {
    this.status = status;
    if (!this.disposed) this.onStatus(status);
  }

  private teardownWork(): void {
    this.activeAbort?.abort();
    this.activeAbort = undefined;
    this.freshnessAbort?.abort();
    this.freshnessAbort = undefined;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.pendingFiles.clear();
  }

  private relToUri(rel: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, ...rel.split("/")) : undefined;
  }

  /* ----------------------------- persistence ------------------------------ */

  private storageUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    return vscode.Uri.joinPath(this.context.globalStorageUri, `index-${hash(folder.uri.fsPath)}.json`);
  }

  private scheduleSave(): void {
    if (this.disposed) return;
    this.saveVersion++;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DEBOUNCE_MS);
  }

  /**
   * Startup freshness validation:
   * 1. Detects files modified while offline (mtime + size comparison with 1s safety window).
   * 2. Detects new files created while offline and indexes them.
   * 3. Detects files deleted while offline by explicitly verifying on-disk stat (never inferring
   *    deletion from absence in a capped findFiles enumeration).
   * 4. Abortable; does not prematurely publish 'ready' until validation finishes.
   */
  async validateFreshnessAndReindexStale(): Promise<void> {
    if (!this.enabled || !this.index || this.disposed) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    this.freshnessAbort?.abort();
    const abort = new AbortController();
    this.freshnessAbort = abort;

    try {
      const files = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, MAX_FILES);
      if (abort.signal.aborted || this.disposed || !this.enabled) return;

      const currentFileUris = new Map<string, vscode.Uri>();
      const staleOrNewUris: Array<{ rel: string; uri: vscode.Uri; mtime: number; size: number }> = [];

      for (const uri of files) {
        if (abort.signal.aborted || this.disposed) return;
        const rel = vscode.workspace.asRelativePath(uri, false);
        currentFileUris.set(rel, uri);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          const storedMtime = this.store.getFileMtime(rel);
          const storedSize = this.store.getFileSize(rel);

          // Change detection using mtime + size accounting for coarse timestamp resolution
          const isStale =
            !this.store.hasFile(rel) ||
            storedMtime === undefined ||
            Math.abs(stat.mtime - storedMtime) > 1000 ||
            (storedSize !== undefined && stat.size !== storedSize);

          if (isStale && stat.size <= MAX_FILE_BYTES) {
            staleOrNewUris.push({ rel, uri, mtime: stat.mtime, size: stat.size });
          }
        } catch {
          // Ignore stat errors for unreadable files
        }
      }

      // Evict files deleted while Photon was offline:
      // CRITICAL: Do NOT infer deletion from absence in a capped findFiles result!
      // Explicitly check whether the file actually exists on disk.
      const existingPaths = this.store.getFilePaths();
      let evictedCount = 0;
      for (const existingPath of existingPaths) {
        if (abort.signal.aborted || this.disposed) return;
        if (!currentFileUris.has(existingPath)) {
          const uri = this.relToUri(existingPath);
          if (!uri) continue;
          try {
            await vscode.workspace.fs.stat(uri);
            // File actually exists on disk — do NOT evict!
          } catch (e) {
            if (isNotFoundError(e)) {
              this.store.removeFile(existingPath);
              evictedCount++;
            } else {
              this.log(`[index] transient error verifying ${existingPath}: ${(e as Error).message}`);
            }
          }
        }
      }

      if (staleOrNewUris.length === 0 && evictedCount === 0) {
        this.publishReady();
        return;
      }

      this.log(
        `[index] startup freshness check: updating ${staleOrNewUris.length} modified/new files, evicted ${evictedCount} removed files.`
      );

      for (const item of staleOrNewUris) {
        if (abort.signal.aborted || this.disposed || !this.enabled) return;
        const startEpoch = this.fileModEpoch.get(item.rel) ?? 0;
        try {
          const bytes = await vscode.workspace.fs.readFile(item.uri);
          const content = Buffer.from(bytes).toString("utf8");
          await this.index.indexFile(item.rel, content, abort.signal);

          const latestEpoch = this.fileModEpoch.get(item.rel) ?? 0;
          if (latestEpoch > startEpoch) {
            this.log(`[index] skipping stale commit for ${item.rel} — newer file event arrived during reindexing.`);
            this.queueFile(item.rel);
          } else {
            this.store.setFileMtime(item.rel, item.mtime);
            this.store.setFileSize(item.rel, item.size);
          }
        } catch (e) {
          this.log(`[index] failed reindexing stale ${item.rel}: ${(e as Error).message}`);
        }
        await delay(5);
      }

      if (abort.signal.aborted || this.disposed) return;
      this.publishReady();
      this.scheduleSave();
    } catch (e) {
      this.log(`[index] freshness validation error: ${(e as Error).message}`);
      if (!this.disposed) this.publishReady();
    }
  }

  private async load(): Promise<void> {
    const uri = this.storageUri();
    if (!uri) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const data = JSON.parse(Buffer.from(bytes).toString("utf8"));
      this.store = VectorStore.fromJSON(data, this.embeddingModel);
      this.store.setEmbeddingModel(this.embeddingModel);
    } catch {
      // No saved index yet (or unreadable) — start empty.
    }
  }

  /** Serialized snapshot save: ensures older saves never overwrite newer snapshots. */
  private async save(): Promise<void> {
    const versionToSave = this.saveVersion;
    if (versionToSave <= this.lastSavedVersion || this.disposed) return;
    const uri = this.storageUri();
    if (!uri || this.store.stats.chunks === 0) return;

    this.saveChain = this.saveChain.then(async () => {
      if (versionToSave <= this.lastSavedVersion || this.disposed) return;
      try {
        await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
        const json = JSON.stringify(this.store.toJSON());
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));
        this.lastSavedVersion = versionToSave;
      } catch (e) {
        this.log(`[index] save failed: ${(e as Error).message}`);
      }
    });

    await this.saveChain;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Small stable hash for the workspace path (persistence file name). */
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
