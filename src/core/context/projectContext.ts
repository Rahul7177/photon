import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ModelHandoffRecord,
  ProjectContextSummary,
  ProjectMemoryNote,
} from "../../shared/types";
import { estimateTokens } from "../adaptive/tokens";

export interface ProjectSymbol {
  name: string;
  kind: "class" | "function" | "interface" | "type" | "const" | "enum" | "component" | "method";
  line: number;
  endLine: number;
  exported: boolean;
  signature?: string;
}

export interface ProjectFileEntry {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  lineCount: number;
  summary: string;
  symbols: ProjectSymbol[];
  imports: string[];
  lastAccessedAt?: number;
  lastModifiedAt?: number;
  lastEditSummary?: string;
}

export interface PersistedProjectContext {
  version: number;
  workspaceRoot: string;
  lastUpdatedAt: number;
  languages: string[];
  frameworks: string[];
  scripts: Record<string, string>;
  entryPoints: string[];
  topDirectories: { path: string; fileCount: number; purpose: string }[];
  files: Record<string, ProjectFileEntry>;
  notes: ProjectMemoryNote[];
  latestHandoff: ModelHandoffRecord | null;
  recentEdits: { path: string; summary: string; timestamp: number }[];
  activeFiles: string[];
  estimatedTokensSaved: number;
  queryHits: number;
}

const CONTEXT_VERSION = 1;
const MAX_INDEXED_FILES = 1200;
const MAX_FILE_BYTES = 300 * 1024;

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  "coverage",
  ".cache",
  ".vscode-test",
  "target",
  "vendor",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".vue",
  ".svelte",
  ".md",
  ".json",
  ".yaml",
  ".yml",
]);

/**
 * Global registry of workspace ProjectContextManager instances so tools and engines
 * can access the live context layer without threading it through every legacy signature.
 */
const managersByRoot = new Map<string, ProjectContextManager>();

export function getProjectContextManager(
  workspaceRoot: string | undefined,
  storageFilePath?: string
): ProjectContextManager | undefined {
  if (!workspaceRoot) return undefined;
  const norm = path.resolve(workspaceRoot).toLowerCase();
  let mgr = managersByRoot.get(norm);
  const defaultStorage = storageFilePath || path.join(workspaceRoot, ".photon", "context.json");
  if (!mgr) {
    mgr = new ProjectContextManager(workspaceRoot, defaultStorage);
    managersByRoot.set(norm, mgr);
  } else if (!mgr.hasStoragePath()) {
    mgr.setStoragePath(defaultStorage);
  } else if (storageFilePath && mgr.hasStoragePath()) {
    mgr.setStoragePath(storageFilePath);
  }
  return mgr;
}

export function _resetProjectContextManagersForTesting(): void {
  managersByRoot.clear();
}

export class ProjectContextManager {
  private data: PersistedProjectContext;
  private storageFilePath?: string;
  private scanPromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private listeners = new Set<(summary: ProjectContextSummary) => void>();

  constructor(private readonly workspaceRoot: string, storageFilePath?: string) {
    this.storageFilePath = storageFilePath;
    this.data = {
      version: CONTEXT_VERSION,
      workspaceRoot,
      lastUpdatedAt: Date.now(),
      languages: [],
      frameworks: [],
      scripts: {},
      entryPoints: [],
      topDirectories: [],
      files: {},
      notes: [],
      latestHandoff: null,
      recentEdits: [],
      activeFiles: [],
      estimatedTokensSaved: 0,
      queryHits: 0,
    };
  }

  hasStoragePath(): boolean {
    return Boolean(this.storageFilePath);
  }

  setStoragePath(p: string): void {
    this.storageFilePath = p;
  }

  onDidUpdate(listener: (summary: ProjectContextSummary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const summary = this.getSummary();
    for (const fn of this.listeners) {
      try {
        fn(summary);
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * Initialize by loading persisted context from disk and running an incremental scan.
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.loadFromDisk();
    await this.scanWorkspace(false);
  }

  /**
   * Perform a fast, incremental scan of the workspace. Only files whose mtime or
   * size changed since the last scan are re-read and parsed.
   */
  async scanWorkspace(forceFull = false): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.runScan(forceFull).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  private async runScan(forceFull: boolean): Promise<void> {
    if (!this.workspaceRoot) return;
    if (forceFull) {
      this.data.files = {};
    }

    await this.extractProjectMetadata();

    const seenPaths = new Set<string>();
    const queue: { abs: string; rel: string }[] = [{ abs: this.workspaceRoot, rel: "" }];
    let fileCount = 0;

    while (queue.length > 0 && fileCount < MAX_INDEXED_FILES) {
      const current = queue.shift()!;
      let entries;
      try {
        entries = await fs.readdir(current.abs, { withFileTypes: true });
      } catch {
        continue;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (fileCount >= MAX_INDEXED_FILES) break;
        if (entry.name.startsWith(".") && entry.name !== ".photon") continue;

        const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
        const abs = path.join(current.abs, entry.name);

        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          queue.push({ abs, rel });
          continue;
        }

        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;

        seenPaths.add(rel);
        fileCount++;

        try {
          const st = await fs.stat(abs);
          if (st.size > MAX_FILE_BYTES) continue;

          const existing = this.data.files[rel];
          if (
            !forceFull &&
            existing &&
            Math.abs(existing.mtimeMs - st.mtimeMs) < 1 &&
            existing.sizeBytes === st.size
          ) {
            continue;
          }

          const content = await fs.readFile(abs, "utf8");
          if (content.includes("\0")) continue;

          this.data.files[rel] = parseFileEntry(rel, content, st.mtimeMs, st.size, existing);
        } catch {
          // ignore transient file errors
        }
      }
    }

    // Prune deleted files
    for (const key of Object.keys(this.data.files)) {
      if (!seenPaths.has(key)) {
        delete this.data.files[key];
      }
    }

    this.computeTopDirectories();
    this.data.lastUpdatedAt = Date.now();
    this.scheduleSave();
    this.notify();
  }

  /**
   * Re-index a single file immediately (called when a file is read, edited, or created).
   */
  async indexSingleFile(relPath: string): Promise<ProjectFileEntry | undefined> {
    const normRel = normalizeRelPath(relPath);
    const abs = path.resolve(this.workspaceRoot, normRel);
    if (!abs.toLowerCase().startsWith(path.resolve(this.workspaceRoot).toLowerCase())) {
      return undefined;
    }
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
      const content = await fs.readFile(abs, "utf8");
      if (content.includes("\0")) return undefined;
      const existing = this.data.files[normRel];
      const entry = parseFileEntry(normRel, content, st.mtimeMs, st.size, existing);
      this.data.files[normRel] = entry;
      this.data.lastUpdatedAt = Date.now();
      this.scheduleSave();
      this.notify();
      return entry;
    } catch {
      return undefined;
    }
  }

  /**
   * Remove a deleted file from the project context index.
   */
  removeFile(relPath: string): void {
    const clean = normalizeRelPath(relPath);
    if (this.data.files[clean]) {
      delete this.data.files[clean];
      this.computeTopDirectories();
      this.data.lastUpdatedAt = Date.now();
      this.scheduleSave();
      this.notify();
    }
  }

  /**
   * Smart path resolution: if a model supplies a partial path like "core/adaptive/orchestrator.ts"
   * or a bare filename like "ContextMeter.tsx", resolve it against the indexed workspace files!
   */
  resolveSmartPath(rawPath: string): {
    resolved?: string;
    autoCorrected?: boolean;
    candidates?: string[];
  } {
    const clean = normalizeRelPath(rawPath);
    if (!clean) return {};

    // 1. Exact match
    if (this.data.files[clean]) {
      return { resolved: clean, autoCorrected: false };
    }

    const allPaths = Object.keys(this.data.files);
    const lowerClean = clean.toLowerCase();

    // 2. Case-insensitive exact match
    const caseMatch = allPaths.find((p) => p.toLowerCase() === lowerClean);
    if (caseMatch) {
      return { resolved: caseMatch, autoCorrected: true };
    }

    // 3. Suffix match (e.g., "core/adaptive/orchestrator.ts" -> "src/core/adaptive/orchestrator.ts")
    const suffixMatches = allPaths.filter(
      (p) => p.toLowerCase().endsWith(`/${lowerClean}`) || p.toLowerCase() === lowerClean
    );
    if (suffixMatches.length === 1) {
      return { resolved: suffixMatches[0], autoCorrected: true };
    }
    if (suffixMatches.length > 1) {
      return { candidates: suffixMatches.slice(0, 6) };
    }

    // 4. Basename match
    const base = path.posix.basename(lowerClean);
    const baseMatches = allPaths.filter((p) => path.posix.basename(p.toLowerCase()) === base);
    if (baseMatches.length === 1) {
      return { resolved: baseMatches[0], autoCorrected: true };
    }
    if (baseMatches.length > 1) {
      return { candidates: baseMatches.slice(0, 6) };
    }

    return {};
  }

  /**
   * Record that a file was read by a model.
   */
  async recordFileRead(relPath: string): Promise<void> {
    const norm = normalizeRelPath(relPath);
    let entry: ProjectFileEntry | undefined = this.data.files[norm];
    if (!entry) {
      entry = await this.indexSingleFile(norm);
    }
    if (entry) {
      entry.lastAccessedAt = Date.now();
    }
    this.touchActiveFile(norm);
    this.scheduleSave();
    this.notify();
  }

  /**
   * Record that a file was modified or created by a model.
   */
  async recordFileEdit(relPath: string, summary: string): Promise<void> {
    const norm = normalizeRelPath(relPath);
    const entry = await this.indexSingleFile(norm);
    const now = Date.now();
    if (entry) {
      entry.lastModifiedAt = now;
      entry.lastAccessedAt = now;
      entry.lastEditSummary = summary;
    }
    this.touchActiveFile(norm);
    this.data.recentEdits = [
      { path: norm, summary, timestamp: now },
      ...this.data.recentEdits.filter((e) => e.path !== norm),
    ].slice(0, 20);
    this.data.lastUpdatedAt = now;
    this.scheduleSave();
    this.notify();
  }

  private touchActiveFile(normPath: string): void {
    this.data.activeFiles = [
      normPath,
      ...this.data.activeFiles.filter((p) => p !== normPath),
    ].slice(0, 15);
  }

  /**
   * Add or update a persistent project memory note (by user or model).
   */
  addNote(note: {
    category: ProjectMemoryNote["category"];
    title: string;
    content: string;
    relatedFiles?: string[];
    createdBy?: string;
  }): ProjectMemoryNote {
    const now = Date.now();
    // If a note with the same title exists, update it
    const existingIdx = this.data.notes.findIndex(
      (n) => n.title.toLowerCase() === note.title.trim().toLowerCase()
    );
    const record: ProjectMemoryNote = {
      id: existingIdx >= 0 ? this.data.notes[existingIdx].id : randomUUID(),
      category: note.category,
      title: note.title.trim(),
      content: note.content.trim(),
      relatedFiles: note.relatedFiles?.map(normalizeRelPath),
      createdBy: note.createdBy || "user",
      updatedAt: now,
    };
    if (existingIdx >= 0) {
      this.data.notes[existingIdx] = record;
    } else {
      this.data.notes.unshift(record);
      if (this.data.notes.length > 50) this.data.notes.length = 50;
    }
    this.data.lastUpdatedAt = now;
    this.scheduleSave();
    this.notify();
    return record;
  }

  deleteNote(id: string): void {
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    this.data.lastUpdatedAt = Date.now();
    this.scheduleSave();
    this.notify();
  }

  clearWorkingMemory(): void {
    this.data.activeFiles = [];
    this.data.recentEdits = [];
    this.data.latestHandoff = null;
    this.data.lastUpdatedAt = Date.now();
    this.scheduleSave();
    this.notify();
  }

  /**
   * Record turn handoff state so if the user switches models on the next turn
   * (or continues working), the next model gets an instant briefing of what happened.
   */
  recordTurnHandoff(input: {
    fromModel: string;
    userPrompt: string;
    assistantResponse: string;
    toolsUsed: { name: string; args: Record<string, unknown>; ok: boolean }[];
    pendingTodos?: string[];
  }): void {
    const now = Date.now();
    for (const t of input.toolsUsed) {
      const p = (t.args.path ?? t.args.file_path ?? t.args.from) as string | undefined;
      if (p && typeof p === "string") {
        const resolved = this.resolveSmartPath(p).resolved ?? normalizeRelPath(p);
        this.touchActiveFile(resolved);
      }
    }

    // Extract concise findings from the assistant response (first 2-3 bullet points or sentences)
    const findings = extractKeyPoints(input.assistantResponse, 4);
    const prevFindings = this.data.latestHandoff?.keyFindings ?? [];
    const mergedFindings = [...findings, ...prevFindings]
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 6);

    this.data.latestHandoff = {
      fromModel: input.fromModel,
      timestamp: now,
      taskSummary: input.userPrompt.trim().slice(0, 240),
      activeFiles: [...this.data.activeFiles].slice(0, 10),
      recentEdits: [...this.data.recentEdits].slice(0, 8),
      pendingTodos: (input.pendingTodos ?? []).slice(0, 8),
      keyFindings: mergedFindings,
    };

    this.data.lastUpdatedAt = now;
    this.scheduleSave();
    this.notify();
  }

  /**
   * Fast, multi-scope query over the maintained Project Context.
   * Returns a compact, structured markdown response with exact file paths, symbol line numbers,
   * summaries, recent edits, and architectural notes.
   */
  query(options: {
    query?: string;
    scope?: "all" | "symbols" | "files" | "architecture" | "changes" | "memory";
    maxResults?: number;
  }): string {
    const q = (options.query ?? "").trim();
    const scope = options.scope ?? "all";
    const maxResults = Math.min(25, Math.max(3, options.maxResults ?? 10));

    this.data.queryHits++;
    // Each context query replaces ~3-5 blind read_file / search_code calls (~1,600 tokens saved)
    this.data.estimatedTokensSaved += 1600;
    this.scheduleSave();
    this.notify();

    const sections: string[] = [];

    // 1. Architecture / Overview scope
    if (scope === "architecture" || (scope === "all" && !q)) {
      sections.push(this.formatArchitectureSection());
    }

    // 2. Memory Notes
    if (scope === "memory" || scope === "architecture" || scope === "all") {
      const matchedNotes = q
        ? this.scoreNotes(q).slice(0, 5)
        : this.data.notes.slice(0, 6);
      if (matchedNotes.length > 0) {
        const lines = matchedNotes.map(
          (n) =>
            `- **[${n.category.toUpperCase()}] ${n.title}**: ${n.content}${
              n.relatedFiles?.length ? ` *(files: ${n.relatedFiles.join(", ")})*` : ""
            }`
        );
        sections.push(`## Project Memory & Decisions\n${lines.join("\n")}`);
      }
    }

    // 3. Recent Changes & Working Memory
    if (scope === "changes" || (scope === "all" && !q)) {
      if (this.data.recentEdits.length > 0) {
        const editLines = this.data.recentEdits
          .slice(0, 8)
          .map((e) => `- \`${e.path}\`: ${e.summary}`);
        sections.push(`## Recent File Modifications\n${editLines.join("\n")}`);
      }
      if (this.data.latestHandoff) {
        const h = this.data.latestHandoff;
        sections.push(
          `## Active Working Context (Last Model: ${h.fromModel})\n` +
            `- **Last Task**: ${h.taskSummary}\n` +
            (h.activeFiles.length ? `- **Active Files**: ${h.activeFiles.map((f) => `\`${f}\``).join(", ")}\n` : "") +
            (h.keyFindings.length ? `- **Key Findings**:\n${h.keyFindings.map((f) => `  - ${f}`).join("\n")}` : "")
        );
      }
    }

    // 4. Symbol Search
    if (q && (scope === "all" || scope === "symbols")) {
      const symbolMatches = this.scoreSymbols(q).slice(0, maxResults);
      if (symbolMatches.length > 0) {
        const symLines = symbolMatches.map(
          (m) =>
            `- \`${m.symbol.name}\` (${m.symbol.kind}${m.symbol.exported ? ", exported" : ""}) in \`${m.filePath}\` **L${m.symbol.line}–L${m.symbol.endLine}**${
              m.symbol.signature ? ` — \`${m.symbol.signature}\`` : ""
            }`
        );
        sections.push(
          `## Matching Symbols (with exact line ranges for targeted \`read_file\`)\n${symLines.join("\n")}`
        );
      }
    }

    // 5. File Search
    if (scope === "all" || scope === "files") {
      const fileMatches = q
        ? this.scoreFiles(q).slice(0, maxResults)
        : Object.values(this.data.files)
            .sort((a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0) || b.symbols.length - a.symbols.length)
            .slice(0, maxResults);

      if (fileMatches.length > 0) {
        const fileLines = fileMatches.map((f) => {
          const topSyms = f.symbols
            .slice(0, 6)
            .map((s) => `${s.name} (L${s.line}-${s.endLine})`)
            .join(", ");
          const editNote = f.lastEditSummary ? ` | Recent edit: ${f.lastEditSummary}` : "";
          return `- \`${f.path}\` (${f.lineCount} lines) — ${f.summary}${
            topSyms ? `\n  Symbols: ${topSyms}` : ""
          }${editNote}`;
        });
        sections.push(`## Relevant Project Files\n${fileLines.join("\n")}`);
      }
    }

    if (sections.length === 0) {
      return `No matches in maintained project context for "${q}". Use \`find_files\` or \`search_code\` to search raw workspace files.`;
    }

    return sections.join("\n\n");
  }

  /**
   * Builds a compact, high-signal Project Context Digest to inject directly into the
   * system prompt. Automatically selects the files and symbols most relevant to the
   * user's current query and includes a Cross-Model Handoff Briefing when switching models!
   */
  buildPromptDigest(options: {
    userQuery?: string;
    activeModel?: string;
    maxTokens: number;
  } | number): string | undefined {
    const opts =
      typeof options === "number"
        ? { maxTokens: options, activeModel: "unknown", userQuery: undefined }
        : { ...options, activeModel: options.activeModel ?? "unknown" };

    const fileList = Object.values(this.data.files);
    if (fileList.length === 0 && this.data.notes.length === 0 && !this.data.latestHandoff) {
      return undefined;
    }

    const blocks: string[] = [];
    let usedTokens = 0;

    const tryAdd = (block: string): boolean => {
      const t = estimateTokens(block);
      if (usedTokens + t > opts.maxTokens) return false;
      blocks.push(block);
      usedTokens += t;
      return true;
    };

    // 1. Cross-Model Handoff Briefing (if model changed or active working context exists)
    const handoff = this.data.latestHandoff;
    if (handoff) {
      const isModelSwitch =
        Boolean(opts.activeModel && opts.activeModel !== "unknown") &&
        Boolean(handoff.fromModel) &&
        handoff.fromModel.toLowerCase() !== opts.activeModel.toLowerCase();

      const header = isModelSwitch
        ? `## Cross-Model Context Handoff (${handoff.fromModel} → ${opts.activeModel})\nYou are taking over an active project session from \`${handoff.fromModel}\`. Use this shared context immediately without re-reading the whole project:`
        : `## Active Working Context`;

      const lines: string[] = [header];
      if (handoff.taskSummary) lines.push(`- Recent Task: ${handoff.taskSummary}`);
      if (this.data.recentEdits.length > 0) {
        lines.push(
          `- Recent File Edits: ${this.data.recentEdits
            .slice(0, 5)
            .map((e) => `\`${e.path}\` (${e.summary})`)
            .join("; ")}`
        );
      } else if (handoff.activeFiles.length > 0) {
        lines.push(
          `- Recently Inspected Files: ${handoff.activeFiles
            .slice(0, 6)
            .map((f) => `\`${f}\``)
            .join(", ")}`
        );
      }
      if (handoff.pendingTodos.length > 0) {
        lines.push(`- Pending Todos: ${handoff.pendingTodos.join("; ")}`);
      }
      if (isModelSwitch && handoff.keyFindings.length > 0) {
        lines.push(`- Key Context from Previous Model: ${handoff.keyFindings.slice(0, 3).join(" | ")}`);
      }

      if (lines.length > 1) {
        tryAdd(lines.join("\n"));
        if (isModelSwitch) {
          this.data.estimatedTokensSaved += 2400;
        }
      }
    }

    // 2. Compact Project Architecture Overview
    const archLines: string[] = [`## Maintained Project Context (${fileList.length} indexed files)`];
    if (this.data.languages.length || this.data.frameworks.length) {
      archLines.push(
        `- Stack: ${[...this.data.languages, ...this.data.frameworks].join(", ")}`
      );
    }
    const scriptKeys = Object.keys(this.data.scripts).slice(0, 5);
    if (scriptKeys.length > 0) {
      archLines.push(
        `- Scripts: ${scriptKeys.map((k) => `\`npm run ${k}\` (${this.data.scripts[k]})`).join(", ")}`
      );
    }
    if (this.data.topDirectories.length > 0) {
      archLines.push(
        `- Structure: ${this.data.topDirectories
          .slice(0, 6)
          .map((d) => `\`${d.path}/\` (${d.fileCount} files: ${d.purpose})`)
          .join(", ")}`
      );
    }
    archLines.push(
      `- **Fast Lookup Rule**: Before running multiple \`find_files\`/\`read_file\` calls to explore, check the matched files below or call \`query_project_context\` to get exact file paths and symbol line ranges (\`Lstart-Lend\`) in one step.`
    );
    tryAdd(archLines.join("\n"));

    // 3. Pinned Project Memory Notes
    if (this.data.notes.length > 0) {
      const noteLines = this.data.notes
        .slice(0, 5)
        .map((n) => `- [${n.category}] **${n.title}**: ${n.content}`);
      tryAdd(`## Pinned Project Notes\n${noteLines.join("\n")}`);
    }

    // 4. Query-Matched Files & Symbols for the user's current prompt
    if (opts.userQuery && opts.userQuery.trim().length > 2) {
      const matchedFiles = this.scoreFiles(opts.userQuery).slice(0, 6);
      const matchedSyms = this.scoreSymbols(opts.userQuery).slice(0, 6);

      if (matchedFiles.length > 0 || matchedSyms.length > 0) {
        const matchLines: string[] = [
          `## Pre-Matched Project Context for This Request (use exact paths & line ranges):`,
        ];
        for (const f of matchedFiles) {
          const syms = f.symbols
            .slice(0, 5)
            .map((s) => `${s.name}:L${s.line}-${s.endLine}`)
            .join(", ");
          matchLines.push(
            `- \`${f.path}\` (${f.lineCount}L) — ${f.summary}${syms ? ` [${syms}]` : ""}`
          );
        }
        for (const sm of matchedSyms) {
          if (matchedFiles.some((f) => f.path === sm.filePath)) continue;
          matchLines.push(
            `- Symbol \`${sm.symbol.name}\` (${sm.symbol.kind}) -> \`${sm.filePath}\` L${sm.symbol.line}-${sm.symbol.endLine}`
          );
        }
        if (tryAdd(matchLines.join("\n"))) {
          this.data.estimatedTokensSaved += 800;
        }
      }
    }

    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  }

  /**
   * Returns a concise outline of a file's symbols and line ranges (used by `read_file`
   * when truncating large files so the model can jump directly to the right lines).
   */
  getFileSymbolOutline(relPath: string): string | undefined {
    const norm = normalizeRelPath(relPath);
    const entry = this.data.files[norm];
    if (!entry || entry.symbols.length === 0) return undefined;
    const list = entry.symbols
      .slice(0, 20)
      .map((s) => `  ${s.kind} ${s.name}: lines ${s.line}-${s.endLine}`)
      .join("\n");
    return `Symbol outline for ${norm}:\n${list}`;
  }

  getSummary(): ProjectContextSummary {
    const files = Object.values(this.data.files);
    const totalSymbols = files.reduce((acc, f) => acc + f.symbols.length, 0);
    const totalLines = files.reduce((acc, f) => acc + f.lineCount, 0);

    const recentFiles = files
      .map((f) => {
        const editTs = f.lastModifiedAt ?? 0;
        const readTs = f.lastAccessedAt ?? 0;
        const lastAction: "edited" | "read" | "indexed" =
          editTs > 0 && editTs >= readTs ? "edited" : readTs > 0 ? "read" : "indexed";
        const timestamp = Math.max(editTs, readTs, f.mtimeMs);
        return {
          path: f.path,
          summary: f.lastEditSummary ? `${f.summary} (Edited: ${f.lastEditSummary})` : f.summary,
          lineCount: f.lineCount,
          symbolCount: f.symbols.length,
          lastAction,
          timestamp,
        };
      })
      .sort((a, b) => {
        const aActive = a.lastAction !== "indexed" ? 1 : 0;
        const bActive = b.lastAction !== "indexed" ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return b.timestamp - a.timestamp;
      })
      .slice(0, 15);

    return {
      workspaceName: path.basename(this.workspaceRoot),
      totalFiles: files.length,
      totalSymbols,
      totalLines,
      lastUpdatedAt: this.data.lastUpdatedAt,
      languages: this.data.languages,
      frameworks: this.data.frameworks,
      scripts: this.data.scripts,
      entryPoints: this.data.entryPoints,
      topDirectories: this.data.topDirectories,
      recentFiles,
      notes: this.data.notes,
      latestHandoff: this.data.latestHandoff,
      estimatedTokensSaved: this.data.estimatedTokensSaved,
      queryHits: this.data.queryHits,
    };
  }

  /* ------------------------------ Internal Helpers ------------------------------ */

  private formatArchitectureSection(): string {
    const lines: string[] = [
      `## Project Architecture (${path.basename(this.workspaceRoot)})`,
    ];
    if (this.data.languages.length) {
      lines.push(`- **Languages**: ${this.data.languages.join(", ")}`);
    }
    if (this.data.frameworks.length) {
      lines.push(`- **Frameworks & Libraries**: ${this.data.frameworks.join(", ")}`);
    }
    if (this.data.entryPoints.length) {
      lines.push(`- **Entry Points**: ${this.data.entryPoints.map((e) => `\`${e}\``).join(", ")}`);
    }
    const scriptEntries = Object.entries(this.data.scripts).slice(0, 8);
    if (scriptEntries.length) {
      lines.push(
        `- **Scripts**: ${scriptEntries.map(([k, v]) => `\`${k}\`: \`${v}\``).join(" | ")}`
      );
    }
    if (this.data.topDirectories.length) {
      lines.push(
        `- **Key Directories**:\n` +
          this.data.topDirectories
            .map((d) => `  - \`${d.path}/\` (${d.fileCount} files) — ${d.purpose}`)
            .join("\n")
      );
    }
    return lines.join("\n");
  }

  private scoreFiles(queryText: string): ProjectFileEntry[] {
    const tokens = tokenizeQuery(queryText);
    if (tokens.length === 0) return [];

    const activeSet = new Set(this.data.activeFiles);
    const results: { file: ProjectFileEntry; score: number }[] = [];

    for (const file of Object.values(this.data.files)) {
      let score = 0;
      const lowerPath = file.path.toLowerCase();
      const baseName = path.posix.basename(lowerPath, path.posix.extname(lowerPath));
      const lowerSummary = file.summary.toLowerCase();

      for (const tok of tokens) {
        if (baseName === tok) score += 90;
        else if (baseName.includes(tok)) score += 50;
        else if (lowerPath.includes(tok)) score += 30;

        if (lowerSummary.includes(tok)) score += 20;

        for (const sym of file.symbols) {
          const symLower = sym.name.toLowerCase();
          if (symLower === tok) score += 70;
          else if (symLower.includes(tok)) score += 30;
        }
      }

      if (score > 0) {
        if (activeSet.has(file.path)) score += 15;
        if (file.lastModifiedAt) score += 10;
        results.push({ file, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).map((r) => r.file);
  }

  private scoreSymbols(queryText: string): { filePath: string; symbol: ProjectSymbol; score: number }[] {
    const tokens = tokenizeQuery(queryText);
    if (tokens.length === 0) return [];

    const results: { filePath: string; symbol: ProjectSymbol; score: number }[] = [];

    for (const file of Object.values(this.data.files)) {
      for (const sym of file.symbols) {
        let score = 0;
        const symLower = sym.name.toLowerCase();
        const subWords = splitIdentifier(sym.name);

        for (const tok of tokens) {
          if (symLower === tok) score += 100;
          else if (symLower.startsWith(tok)) score += 60;
          else if (subWords.includes(tok)) score += 50;
          else if (symLower.includes(tok)) score += 30;
        }

        if (score > 0) {
          if (sym.exported) score += 10;
          results.push({ filePath: file.path, symbol: sym, score });
        }
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  private scoreNotes(queryText: string): ProjectMemoryNote[] {
    const tokens = tokenizeQuery(queryText);
    if (tokens.length === 0) return this.data.notes;

    const scored: { note: ProjectMemoryNote; score: number }[] = [];
    for (const note of this.data.notes) {
      let score = 0;
      const hay = `${note.title} ${note.content} ${(note.relatedFiles ?? []).join(" ")}`.toLowerCase();
      for (const tok of tokens) {
        if (hay.includes(tok)) score += 30;
      }
      if (score > 0) scored.push({ note, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.note);
  }

  private async extractProjectMetadata(): Promise<void> {
    const langs = new Set<string>(this.data.languages);
    const frameworks = new Set<string>(this.data.frameworks);
    const entryPoints = new Set<string>();

    // Check package.json
    try {
      const pkgRaw = await fs.readFile(path.join(this.workspaceRoot, "package.json"), "utf8");
      const pkg = JSON.parse(pkgRaw);
      if (pkg.scripts && typeof pkg.scripts === "object") {
        this.data.scripts = { ...pkg.scripts };
      }
      if (pkg.main) entryPoints.add(normalizeRelPath(String(pkg.main)));
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if (allDeps.typescript) langs.add("TypeScript");
      if (allDeps.react) frameworks.add("React");
      if (allDeps.vite) frameworks.add("Vite");
      if (allDeps.next) frameworks.add("Next.js");
      if (allDeps.vue) frameworks.add("Vue");
      if (allDeps.svelte) frameworks.add("Svelte");
      if (allDeps.express) frameworks.add("Express");
      if (allDeps.tailwindcss) frameworks.add("Tailwind CSS");
      if (allDeps["@types/vscode"] || pkg.engines?.vscode) frameworks.add("VS Code Extension");
      if (allDeps.esbuild) frameworks.add("esbuild");
    } catch {
      // no package.json
    }

    // Check Python / Rust / Go markers
    try {
      await fs.access(path.join(this.workspaceRoot, "pyproject.toml"));
      langs.add("Python");
    } catch { /* ignore */ }
    try {
      await fs.access(path.join(this.workspaceRoot, "Cargo.toml"));
      langs.add("Rust");
    } catch { /* ignore */ }
    try {
      await fs.access(path.join(this.workspaceRoot, "go.mod"));
      langs.add("Go");
    } catch { /* ignore */ }

    this.data.languages = [...langs];
    this.data.frameworks = [...frameworks];
    if (entryPoints.size > 0) {
      this.data.entryPoints = [...entryPoints];
    }
  }

  private computeTopDirectories(): void {
    const dirCounts = new Map<string, { count: number; samples: string[] }>();
    const langs = new Set<string>(this.data.languages);
    const entryCandidates: string[] = [...this.data.entryPoints];

    for (const file of Object.values(this.data.files)) {
      const ext = path.posix.extname(file.path).toLowerCase();
      if (ext === ".ts" || ext === ".tsx") langs.add("TypeScript");
      else if (ext === ".js" || ext === ".jsx") langs.add("JavaScript");
      else if (ext === ".py") langs.add("Python");
      else if (ext === ".rs") langs.add("Rust");
      else if (ext === ".go") langs.add("Go");

      const base = path.posix.basename(file.path).toLowerCase();
      if (
        ["extension.ts", "index.ts", "index.tsx", "main.ts", "main.tsx", "app.tsx", "main.py", "main.go", "main.rs"].includes(
          base
        ) &&
        file.path.split("/").length <= 3
      ) {
        if (!entryCandidates.includes(file.path)) entryCandidates.push(file.path);
      }

      const parts = file.path.split("/");
      if (parts.length > 1) {
        const dirKey = parts.length >= 3 && (parts[0] === "src" || parts[0] === "webview-ui")
          ? `${parts[0]}/${parts[1]}`
          : parts[0];
        const cur = dirCounts.get(dirKey) ?? { count: 0, samples: [] };
        cur.count++;
        if (cur.samples.length < 4) cur.samples.push(path.posix.basename(file.path, ext));
        dirCounts.set(dirKey, cur);
      }
    }

    this.data.languages = [...langs];
    this.data.entryPoints = entryCandidates.slice(0, 6);
    this.data.topDirectories = [...dirCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([dirPath, info]) => ({
        path: dirPath,
        fileCount: info.count,
        purpose: inferDirectoryPurpose(dirPath, info.samples),
      }));
  }

  private scheduleSave(): void {
    if (!this.storageFilePath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.saveToDisk();
    }, 1500);
  }

  async saveToDisk(): Promise<void> {
    if (!this.storageFilePath) return;
    try {
      await fs.mkdir(path.dirname(this.storageFilePath), { recursive: true });
      await fs.writeFile(this.storageFilePath, JSON.stringify(this.data), "utf8");
    } catch {
      // ignore disk write errors
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.storageFilePath) return;
    try {
      const raw = await fs.readFile(this.storageFilePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedProjectContext;
      if (parsed && parsed.version === CONTEXT_VERSION && parsed.files) {
        this.data = {
          ...this.data,
          ...parsed,
          workspaceRoot: this.workspaceRoot,
        };
      }
    } catch {
      // no existing context file
    }
  }
}

/* ------------------------------ File & Symbol Parser ------------------------------ */

function parseFileEntry(
  relPath: string,
  content: string,
  mtimeMs: number,
  sizeBytes: number,
  previous?: ProjectFileEntry
): ProjectFileEntry {
  const lines = content.split(/\r?\n/);
  const lineCount = lines.length;
  const ext = path.posix.extname(relPath).toLowerCase();

  const symbols = extractSymbols(lines, ext);
  const imports = extractImports(lines);
  const summary = extractSummary(relPath, lines, symbols);

  return {
    path: relPath,
    mtimeMs,
    sizeBytes,
    lineCount,
    summary,
    symbols,
    imports,
    lastAccessedAt: previous?.lastAccessedAt,
    lastModifiedAt: previous?.lastModifiedAt,
    lastEditSummary: previous?.lastEditSummary,
  };
}

function extractSymbols(lines: string[], ext: string): ProjectSymbol[] {
  const symbols: ProjectSymbol[] = [];
  if (ext === ".md" || ext === ".json" || ext === ".yaml" || ext === ".yml") {
    return symbols;
  }

  const isPython = ext === ".py";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("#") || line.startsWith("*")) continue;

    if (isPython) {
      const pyMatch = /^(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?/.exec(line);
      if (pyMatch) {
        const kind = pyMatch[1] === "class" ? "class" : "function";
        const name = pyMatch[2];
        const endLine = findPythonBlockEnd(lines, i);
        symbols.push({
          name,
          kind,
          line: i + 1,
          endLine,
          exported: !name.startsWith("_"),
          signature: `${pyMatch[1]} ${name}${pyMatch[3] ?? ""}`.slice(0, 90),
        });
      }
      continue;
    }

    // TypeScript / JavaScript / Go / Rust / Java / C#
    const isExported = /^export\s+/.test(line) || /^pub\s+/.test(line);
    const cleaned = line.replace(/^export\s+(default\s+)?/, "").replace(/^pub(\([^)]*\))?\s+/, "");

    let match: RegExpExecArray | null = null;
    let kind: ProjectSymbol["kind"] | null = null;

    if ((match = /^(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(cleaned))) {
      kind = "class";
    } else if ((match = /^interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(cleaned))) {
      kind = "interface";
    } else if ((match = /^type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(cleaned))) {
      kind = "type";
    } else if ((match = /^enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(cleaned))) {
      kind = "enum";
    } else if ((match = /^(?:async\s+)?(?:function|fn|func)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(cleaned))) {
      kind = /^[A-Z]/.test(match[1]) && (ext === ".tsx" || ext === ".jsx") ? "component" : "function";
    } else if (
      (match = /^(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?\s*=\s*(?:memo\(|forwardRef\(|async\s*\(|\([^)]*\)\s*=>|function\b)/.exec(
        cleaned
      ))
    ) {
      kind = /^[A-Z]/.test(match[1]) && (ext === ".tsx" || ext === ".jsx") ? "component" : "function";
    } else if (isExported && (match = /^const\s+([A-Z][A-Za-z0-9_$]*)\b/.exec(cleaned))) {
      kind = "const";
    } else if ((match = /^struct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(cleaned))) {
      kind = "class";
    }

    if (match && kind) {
      const name = match[1];
      const endLine = findBraceBlockEnd(lines, i);
      symbols.push({
        name,
        kind,
        line: i + 1,
        endLine,
        exported: isExported,
        signature: line.replace(/\{.*$/, "").trim().slice(0, 100),
      });
      if (symbols.length >= 40) break;
    }
  }

  return symbols;
}

function findBraceBlockEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let opened = false;
  const maxLookahead = Math.min(lines.length, startIndex + 500);

  for (let i = startIndex; i < maxLookahead; i++) {
    const l = lines[i];
    for (let c = 0; c < l.length; c++) {
      const ch = l[c];
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
        if (opened && depth <= 0) {
          return i + 1;
        }
      }
    }
    if (!opened && l.trim().endsWith(";")) {
      return i + 1;
    }
  }
  return Math.min(lines.length, startIndex + 25);
}

function findPythonBlockEnd(lines: string[], startIndex: number): number {
  const startLine = lines[startIndex];
  const baseIndent = startLine.length - startLine.trimStart().length;
  const maxLookahead = Math.min(lines.length, startIndex + 400);
  let lastNonEmpty = startIndex + 1;

  for (let i = startIndex + 1; i < maxLookahead; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    if (indent <= baseIndent) {
      return lastNonEmpty;
    }
    lastNonEmpty = i + 1;
  }
  return lastNonEmpty;
}

function extractImports(lines: string[]): string[] {
  const imports: string[] = [];
  const cap = Math.min(lines.length, 80);
  for (let i = 0; i < cap; i++) {
    const l = lines[i].trim();
    const m =
      /from\s+["']([^"']+)["']/.exec(l) ??
      /require\(\s*["']([^"']+)["']\s*\)/.exec(l);
    if (m && m[1]) {
      imports.push(m[1]);
      if (imports.length >= 12) break;
    }
  }
  return imports;
}

function extractSummary(relPath: string, lines: string[], symbols: ProjectSymbol[]): string {
  // 1. Check top lines for leading comment or markdown header
  const commentLines: string[] = [];
  const cap = Math.min(lines.length, 30);

  for (let i = 0; i < cap; i++) {
    const t = lines[i].trim();
    if (!t) {
      if (commentLines.length > 0) break;
      continue;
    }
    if (t.startsWith("//")) {
      const cleaned = t.replace(/^\/\/+\s*/, "").trim();
      if (cleaned && !cleaned.startsWith("---") && !cleaned.startsWith("===")) {
        commentLines.push(cleaned);
      }
    } else if (t.startsWith("/*") || t.startsWith("*")) {
      const cleaned = t
        .replace(/^\/\*+\s*/, "")
        .replace(/\*+\/$/, "")
        .replace(/^\*+\s*/, "")
        .trim();
      if (cleaned && !cleaned.startsWith("@")) {
        commentLines.push(cleaned);
      }
    } else if (relPath.endsWith(".md") && t.startsWith("#")) {
      commentLines.push(t.replace(/^#+\s*/, "").trim());
      break;
    } else if (commentLines.length > 0) {
      break;
    }
    if (commentLines.length >= 2) break;
  }

  const docSummary = commentLines.join(" ").slice(0, 140).trim();
  const exportedSyms = symbols.filter((s) => s.exported).slice(0, 4);
  const symText =
    exportedSyms.length > 0
      ? `Exports ${exportedSyms.map((s) => `${s.name}`).join(", ")}`
      : symbols.length > 0
        ? `Defines ${symbols
            .slice(0, 3)
            .map((s) => s.name)
            .join(", ")}`
        : "";

  if (docSummary && symText) {
    return `${docSummary} (${symText})`;
  }
  if (docSummary) return docSummary;
  if (symText) return symText;
  return `${path.posix.basename(relPath)} (${lines.length} lines)`;
}

function inferDirectoryPurpose(dirPath: string, sampleFiles: string[]): string {
  const lower = dirPath.toLowerCase();
  const samples = sampleFiles.slice(0, 3).join(", ");
  if (lower.includes("component")) return `UI components (${samples})`;
  if (lower.includes("state") || lower.includes("store")) return `State management (${samples})`;
  if (lower.includes("theme") || lower.includes("style")) return `Styling & theme (${samples})`;
  if (lower.includes("host")) return `Extension host & controllers (${samples})`;
  if (lower.includes("core")) return `Core engine, tools & providers (${samples})`;
  if (lower.includes("shared")) return `Shared types & protocol (${samples})`;
  if (lower.includes("test")) return `Test suites (${samples})`;
  if (lower.includes("tool")) return `Agent tools (${samples})`;
  return `Modules (${samples})`;
}

function normalizeRelPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "how",
  "what",
  "where",
  "when",
  "why",
  "who",
  "can",
  "you",
  "please",
  "explain",
  "show",
  "tell",
  "fix",
  "make",
  "add",
  "update",
  "change",
  "file",
  "files",
  "code",
  "project",
]);

function tokenizeQuery(q: string): string[] {
  const rawWords = q
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  const fullTokens = q
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return [...new Set([...fullTokens, ...rawTokensWithSubwords(rawWords)])];
}

function rawTokensWithSubwords(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    if (w.includes("_")) {
      for (const part of w.split("_")) {
        if (part.length >= 2 && !STOP_WORDS.has(part)) out.push(part);
      }
    }
  }
  return out;
}

function extractKeyPoints(markdown: string, maxItems: number): string[] {
  if (!markdown || !markdown.trim()) return [];
  const cleaned = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/#+\s*/g, "")
    .trim();
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
    .map((l) => l.replace(/\([\u4e00-\u9fff\s]+\)/g, "").replace(/[\u4e00-\u9fff]+/g, "").trim())
    .filter((l) => l.length >= 20 && l.length <= 180);
  return lines.slice(0, maxItems);
}
