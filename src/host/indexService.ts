import * as vscode from "vscode";
import type { OllamaClient } from "../core/ollama/client";
import { VectorStore } from "../core/index/vectorStore";
import { WorkspaceIndex } from "../core/index/indexer";
import type { IndexStatus } from "../shared/types";

// Bounds so a huge repo never freezes the host or blows memory (M10 checklist).
const MAX_FILES = 1500;
const MAX_FILE_BYTES = 256 * 1024;
const FILE_GLOB =
  "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,cc,cpp,h,hpp,cs,rb,php,swift,kt,scala,vue,svelte,md,json,yaml,yml,toml,sh}";
const EXCLUDE_GLOB = "**/{node_modules,.git,dist,out,build,.next,.venv,__pycache__,.turbo,coverage,.cache}/**";
const DEBOUNCE_MS = 800;
const SAVE_DEBOUNCE_MS = 4000;

/** Directory segments never indexed — mirrors EXCLUDE_GLOB for watcher events. */
const IGNORED_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", ".venv",
  "__pycache__", ".turbo", "coverage", ".cache",
]);

function isIgnoredPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg));
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
  private abort?: AbortController;
  private readonly pendingFiles = new Set<string>();
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

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
    // Cancel any in-flight indexing before reconfiguring so a config change can't
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
    // If we loaded nothing from disk, do a full background index.
    if (this.store.stats.chunks === 0) void this.reindex();
    else this.publishReady();
  }

  /** (Re)bind the index to the current store + a local-Ollama embed function. */
  private makeIndex(): void {
    this.index = new WorkspaceIndex(this.store, (texts) =>
      this.client.embed(this.embeddingModel, texts, 120_000)
    );
  }

  /** Full (re)index in the background. Abortable; never blocks the caller. */
  async reindex(): Promise<void> {
    if (!this.enabled || !this.index || this.disposed) return;
    this.teardownWork();
    const abort = new AbortController();
    this.abort = abort;

    let files: vscode.Uri[];
    try {
      files = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, MAX_FILES);
    } catch (e) {
      this.setStatus({ ...this.status, phase: "error", message: (e as Error).message });
      return;
    }

    this.store.clear();
    let done = 0;
    this.setStatus({ phase: "indexing", filesIndexed: 0, chunks: 0, pending: files.length });

    for (const uri of files) {
      if (abort.signal.aborted || this.disposed) return;
      const rel = vscode.workspace.asRelativePath(uri, false);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) {
          done++;
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString("utf8");
        await this.index.indexFile(rel, content, abort.signal);
      } catch (e) {
        this.log(`[index] skip ${rel}: ${(e as Error).message}`);
      }
      done++;
      // Publish progress periodically and yield so the UI stays responsive.
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
    if (this.saveTimer) clearTimeout(this.saveTimer);
    void this.save();
  }

  private disposeWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  /* ------------------------------- internals ------------------------------ */

  private ensureWatcher(): void {
    if (this.watcher) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, FILE_GLOB));
    // The watcher glob can't carry an exclude clause, so apply the same ignore
    // list here — otherwise saving a file under node_modules queues indexing
    // that findFiles' EXCLUDE_GLOB would never have returned.
    const touch = (uri: vscode.Uri) => {
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (isIgnoredPath(rel)) return;
      this.queueFile(rel);
    };
    w.onDidCreate(touch);
    w.onDidChange(touch);
    w.onDidDelete((uri) => {
      if (!this.index) return;
      this.index.removeFile(vscode.workspace.asRelativePath(uri, false));
      this.publishReady();
      this.scheduleSave();
    });
    this.watcher = w;
  }

  /** Debounced incremental re-index of changed files. */
  private queueFile(rel: string): void {
    if (!this.enabled || !this.index) return;
    this.pendingFiles.add(rel);
    this.setStatus({ ...this.status, pending: this.pendingFiles.size });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flushPending(), DEBOUNCE_MS);
  }

  private async flushPending(): Promise<void> {
    if (!this.index || this.disposed) return;
    const files = [...this.pendingFiles];
    this.pendingFiles.clear();
    const signal = new AbortController().signal; // incremental work isn't user-cancelled
    for (const rel of files) {
      try {
        const uri = this.relToUri(rel);
        if (!uri) continue;
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) continue;
        const bytes = await vscode.workspace.fs.readFile(uri);
        await this.index.indexFile(rel, Buffer.from(bytes).toString("utf8"), signal);
      } catch (e) {
        // Only a genuinely missing file evicts its chunks. Transient errors
        // (Windows EBUSY/EPERM while an editor or compiler holds the file)
        // used to silently drop the file from RAG until its next edit.
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "FileNotFound") {
          this.index.removeFile(rel);
        } else {
          this.log(`[index] deferred ${rel}: ${(e as Error).message}`);
        }
      }
    }
    this.publishReady();
    this.scheduleSave();
  }

  private publishReady(): void {
    const { files, chunks } = this.store.stats;
    this.setStatus({
      phase: "ready",
      filesIndexed: files,
      chunks,
      pending: this.pendingFiles.size,
      embeddingModel: this.embeddingModel,
    });
  }

  private setStatus(status: IndexStatus): void {
    this.status = status;
    if (!this.disposed) this.onStatus(status);
  }

  private teardownWork(): void {
    this.abort?.abort();
    this.abort = undefined;
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
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DEBOUNCE_MS);
  }

  private async load(): Promise<void> {
    const uri = this.storageUri();
    if (!uri) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const data = JSON.parse(Buffer.from(bytes).toString("utf8"));
      this.store = VectorStore.fromJSON(data);
    } catch {
      // No saved index yet (or unreadable) — start empty.
    }
  }

  private async save(): Promise<void> {
    const uri = this.storageUri();
    if (!uri || this.store.stats.chunks === 0) return;
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      const json = JSON.stringify(this.store.toJSON());
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));
    } catch (e) {
      this.log(`[index] save failed: ${(e as Error).message}`);
    }
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
