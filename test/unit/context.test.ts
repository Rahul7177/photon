import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after } from "node:test";
import {
  ProjectContextManager,
  getProjectContextManager,
  _resetProjectContextManagersForTesting,
} from "../../src/core/context/projectContext";
import {
  queryProjectContextTool,
  updateProjectContextTool,
} from "../../src/core/tools/builtin/context";
import { editFileTool } from "../../src/core/tools/builtin/files";
import type { ToolContext } from "../../src/core/tools/types";

describe("Project Context & Cross-Model Memory", () => {
  let tmpDir: string;
  let mgr: ProjectContextManager;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-test-context-"));
    const storageFile = path.join(tmpDir, ".photon-context.json");

    // Create a mock codebase structure
    await fs.mkdir(path.join(tmpDir, "src", "services"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "src", "components"), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, "src", "index.ts"),
      `/** Main application entry point */\nexport function bootstrapApp(): void {\n  console.log("ready");\n}\n`,
      "utf8"
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "services", "auth.ts"),
      `export interface AuthUser {\n  id: string;\n  name: string;\n}\n\nexport class AuthService {\n  login() {}\n}\n`,
      "utf8"
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "components", "Button.tsx"),
      `export function PrimaryButton() { return null; }\n`,
      "utf8"
    );

    _resetProjectContextManagersForTesting();
    mgr = getProjectContextManager(tmpDir, storageFile)!;
    await mgr.ensureInitialized();
  });

  after(async () => {
    _resetProjectContextManagersForTesting();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("Workspace Scanning & Symbol Extraction", () => {
    it("indexes workspace files, languages, and extracted symbols", async () => {
      await mgr.scanWorkspace(true);
      const summary = mgr.getSummary();

      assert.ok(summary.totalFiles >= 3);
      assert.ok(summary.totalSymbols >= 3);
      assert.ok(summary.languages.includes("TypeScript"));
      assert.ok(summary.entryPoints.some((p) => p.includes("index.ts")));
    });

    it("extracts classes, functions, and interfaces into file symbol maps", () => {
      const outline = mgr.getFileSymbolOutline("src/services/auth.ts");
      assert.ok(outline);
      assert.ok(outline.includes("AuthService"));
      assert.ok(outline.includes("AuthUser"));
    });
  });

  describe("Smart Path Resolution", () => {
    it("resolves exact workspace paths", () => {
      const res = mgr.resolveSmartPath("src/index.ts");
      assert.equal(res.resolved, "src/index.ts");
      assert.equal(res.autoCorrected, false);
    });

    it("resolves case-insensitive paths", () => {
      const res = mgr.resolveSmartPath("SRC/INDEX.TS");
      assert.equal(res.resolved, "src/index.ts");
      assert.equal(res.autoCorrected, true);
    });

    it("resolves suffix and basename shortcuts", () => {
      const res = mgr.resolveSmartPath("Button.tsx");
      assert.equal(res.resolved, "src/components/Button.tsx");
      assert.equal(res.autoCorrected, true);
    });

    it("returns empty result when path is completely unknown", () => {
      const res = mgr.resolveSmartPath("unknown-file.txt");
      assert.equal(res.resolved, undefined);
    });
  });

  describe("Working Memory & Turn Handoff", () => {
    it("tracks file reads and edits in working memory", async () => {
      await mgr.recordFileRead("src/index.ts");
      await mgr.recordFileEdit("src/services/auth.ts", "Added login method");

      const summary = mgr.getSummary();
      const readEntry = summary.recentFiles.find((f) => f.path === "src/index.ts");
      const editEntry = summary.recentFiles.find((f) => f.path === "src/services/auth.ts");

      assert.ok(readEntry);
      assert.ok(editEntry);
      assert.equal(editEntry.lastAction, "edited");
    });

    it("records turn handoff and strips unsolicited foreign language translations", () => {
      const dirtyAssistantResponse = `
Here is what was accomplished:
- Implemented user authentication service (用户认证服务).
- Connected primary button to login handler (登录处理器).
- Added unit test fixtures for login verification.
      `.trim();

      mgr.recordTurnHandoff({
        fromModel: "gemma-27b",
        userPrompt: "Wire up the login flow",
        assistantResponse: dirtyAssistantResponse,
        toolsUsed: [
          { name: "read_file", args: { path: "src/services/auth.ts" }, ok: true },
        ],
      });

      const summary = mgr.getSummary();
      assert.ok(summary.latestHandoff);
      assert.equal(summary.latestHandoff.fromModel, "gemma-27b");
      assert.equal(summary.latestHandoff.taskSummary, "Wire up the login flow");

      // Verify that Chinese/Japanese characters were stripped from key findings
      for (const finding of summary.latestHandoff.keyFindings) {
        assert.ok(!/[\u4e00-\u9fff]/.test(finding), `Finding contained CJK characters: ${finding}`);
      }
    });

    it("clears working memory on request", () => {
      mgr.clearWorkingMemory();
      const summary = mgr.getSummary();
      assert.equal(summary.latestHandoff, null);
    });
  });

  describe("Project Notes Management", () => {
    it("adds, retrieves, and categorizes persistent notes", () => {
      mgr.addNote({
        category: "architecture",
        title: "Auth Architecture",
        content: "JWT-based session authentication with refresh tokens.",
        relatedFiles: ["src/services/auth.ts"],
      });

      const summary = mgr.getSummary();
      assert.equal(summary.notes.length, 1);
      const note = summary.notes[0];
      assert.equal(note.title, "Auth Architecture");
      assert.equal(note.category, "architecture");
    });

    it("deletes a note by id", () => {
      const noteId = mgr.getSummary().notes[0]?.id;
      assert.ok(noteId);
      mgr.deleteNote(noteId);
      assert.equal(mgr.getSummary().notes.length, 0);
    });
  });

  describe("Prompt Digest Generation & Cross-Model Handoff", () => {
    it("generates a compact Markdown digest within the allocated token budget", () => {
      mgr.addNote({
        category: "pattern",
        title: "Coding Standards",
        content: "Strict TypeScript types, no any.",
      });

      const digest = mgr.buildPromptDigest(400);
      assert.ok(digest);
      assert.ok(digest.includes("Maintained Project Context"));
      assert.ok(digest.includes("TypeScript"));
      assert.ok(digest.includes("Coding Standards"));
    });

    it("generates a Cross-Model Context Handoff briefing when switching models", () => {
      mgr.recordTurnHandoff({
        fromModel: "qwen2.5-coder:7b",
        userPrompt: "Refactor auth tokens to use refresh flow",
        assistantResponse: "Completed refresh token rotation in auth service.\nUpdated interface AuthUser.\nTested tokens with login flow.",
        toolsUsed: [
          { name: "read_file", args: { path: "src/services/auth.ts" }, ok: true },
          { name: "edit_file", args: { path: "src/services/auth.ts" }, ok: true },
        ],
        pendingTodos: ["Add integration test for token expiry"],
      });

      // Digest requested by a DIFFERENT model (cross-model switch)
      const digest = mgr.buildPromptDigest({
        activeModel: "claude-3-5-sonnet",
        userQuery: "Now write the integration test",
        maxTokens: 1200,
      });

      assert.ok(digest);
      assert.ok(digest.includes("Cross-Model Context Handoff (qwen2.5-coder:7b → claude-3-5-sonnet)"));
      assert.ok(digest.includes("Refactor auth tokens to use refresh flow"));
      assert.ok(digest.includes("auth.ts"));
      assert.ok(digest.includes("Pending Todos: Add integration test for token expiry"));
      assert.ok(digest.includes("Key Context from Previous Model:"));
    });
  });

  describe("Real-time File Indexing & Change Notifications", () => {
    it("indexes a new file dynamically and triggers update listeners", async () => {
      let notified = false;
      const unsubscribe = mgr.onDidUpdate((summary) => {
        if (summary.totalFiles > 0) notified = true;
      });

      const newFilePath = path.join(tmpDir, "src", "services", "payment.ts");
      await fs.writeFile(
        newFilePath,
        `export class PaymentGateway {\n  processPayment(amount: number): boolean {\n    return true;\n  }\n}\n`,
        "utf8"
      );

      const entry = await mgr.indexSingleFile("src/services/payment.ts");
      unsubscribe();

      assert.ok(entry);
      assert.equal(entry.symbols.length, 1);
      assert.equal(entry.symbols[0].name, "PaymentGateway");
      assert.equal(notified, true);
    });

    it("removes a deleted file from index and updates top directories", async () => {
      mgr.removeFile("src/services/payment.ts");
      assert.equal(mgr.getFileSymbolOutline("src/services/payment.ts"), undefined);
    });
  });

  describe("Builtin Context Tools & Smart Path Recovery", () => {
    const dummyCtx: ToolContext = {
      workspaceRoot: "",
      signal: new AbortController().signal,
      log: () => {},
      webSearchProvider: "duckduckgo",
      requestApproval: async () => true,
      findFiles: async () => [],
      capability: "high",
      getDiagnostics: async () => [],
      todos: [],
    };

    before(() => {
      dummyCtx.workspaceRoot = tmpDir;
    });

    it("query_project_context tool returns structured symbol and file records", async () => {
      const res = await queryProjectContextTool.execute(
        { query: "AuthService", scope: "symbols" },
        dummyCtx
      );
      assert.equal(res.ok, true);
      assert.ok(res.output.includes("AuthService"));
      assert.ok(res.output.includes("src/services/auth.ts"));
    });

    it("update_project_context tool persists architectural notes", async () => {
      const res = await updateProjectContextTool.execute(
        {
          category: "architecture",
          title: "Service Layer Pattern",
          content: "All business logic is isolated in src/services",
          related_files: "src/services/auth.ts",
        },
        dummyCtx
      );
      assert.equal(res.ok, true);
      assert.ok(res.output.includes("Saved to Project Context"));

      const summary = mgr.getSummary();
      assert.ok(summary.notes.some((n) => n.title === "Service Layer Pattern"));
    });

    it("edit_file automatically recovers and resolves path when directory prefix is omitted", async () => {
      // Pass bare filename "Button.tsx" instead of "src/components/Button.tsx"
      const res = await editFileTool.execute(
        {
          path: "Button.tsx",
          old_str: "export function PrimaryButton() { return null; }",
          new_str: "export function PrimaryButton() { return <button>Click</button>; }",
        },
        dummyCtx
      );

      assert.equal(res.ok, true);
      assert.ok(res.output.includes("Edited src/components/Button.tsx"));

      const updated = await fs.readFile(
        path.join(tmpDir, "src", "components", "Button.tsx"),
        "utf8"
      );
      assert.ok(updated.includes("<button>Click</button>"));
    });
  });

  describe("Disk Persistence & Reloading", () => {
    it("persists project context to disk and reloads on fresh manager instance", async () => {
      await mgr.saveToDisk();

      const freshMgr = new ProjectContextManager(tmpDir, path.join(tmpDir, ".photon-context.json"));
      await freshMgr.ensureInitialized();
      const freshSummary = freshMgr.getSummary();

      assert.ok(freshSummary.totalFiles >= 3);
      assert.ok(freshSummary.notes.some((n) => n.title === "Service Layer Pattern"));
      assert.ok(freshSummary.latestHandoff);
      assert.equal(freshSummary.latestHandoff?.fromModel, "qwen2.5-coder:7b");
    });
  });
});
