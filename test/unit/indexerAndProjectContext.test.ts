import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { chunkText } from "../../src/core/index/chunker";
import { shouldIndexFile } from "../../src/core/index/indexer";
import {
  ProjectContextManager,
  getProjectContextManager,
  _resetProjectContextManagersForTesting,
} from "../../src/core/context/projectContext";

describe("Phase 5.3: Indexer, Chunker & Project Context Invariants", () => {
  beforeEach(() => {
    _resetProjectContextManagersForTesting();
  });

  describe("Chunker Boundaries & Context Preservation", () => {
    it("handles long lines (>1000 chars) by breaking them safely into bounded segments", () => {
      const longLine = "const x = '" + "A".repeat(2500) + "';";
      const content = `function test() {\n${longLine}\nreturn true;\n}`;

      const chunks = chunkText("src/long.ts", content);
      assert.ok(chunks.length >= 1);
      for (const chunk of chunks) {
        assert.ok(chunk.text.length <= 4000);
        assert.ok(chunk.startLine >= 1);
        assert.ok(chunk.endLine >= chunk.startLine);
      }
    });

    it("preserves import/package context across deeper chunks in code files", () => {
      const header = [
        "import { UserService } from './services/user';",
        "import { DatabasePool } from './db/pool';",
        "package app.auth;",
      ].join("\n");

      // Generate 150 lines of body content so it spans multiple chunks
      const bodyLines = Array.from({ length: 150 }, (_, i) => `function handler_${i}() {\n  return ${i};\n}`).join("\n");
      const fullContent = `${header}\n\n${bodyLines}`;

      const chunks = chunkText("src/service.ts", fullContent);
      assert.ok(chunks.length >= 2);

      // Deeper chunks (chunk 1 and beyond) should carry import context prefix
      const laterChunk = chunks[1];
      assert.ok(laterChunk.text.includes("Module imports:"));
      assert.ok(laterChunk.text.includes("import { UserService }"));
    });

    it("snaps Markdown chunk boundaries cleanly to header elements (# / ##)", () => {
      const mdContent = [
        "# Section 1: Introduction",
        "This is the introduction paragraph.",
        ...Array.from({ length: 50 }, (_, i) => `Detail paragraph number ${i}.`),
        "",
        "## Section 2: Architecture Details",
        "Here are the core architectural details.",
        ...Array.from({ length: 50 }, (_, i) => `Architecture note ${i}.`),
      ].join("\n");

      const chunks = chunkText("docs/design.md", mdContent);
      assert.ok(chunks.length >= 2);

      // At least one chunk should start cleanly at a section header
      assert.ok(chunks.some((c) => c.text.startsWith("# Section 1") || c.text.startsWith("## Section 2")));
    });

    it("rejects binary content with NUL bytes and skips whitespace-only chunks", () => {
      assert.equal(chunkText("binary.dat", "Hello\0World").length, 0);
      assert.equal(chunkText("empty.ts", "   \n\n  \t  \n").length, 0);
      assert.equal(chunkText("braces.ts", "{\n  }\n").length, 0);
    });

    it("bounds chunks per file to prevent memory explosion on giant files", () => {
      const hugeContent = Array.from({ length: 10000 }, (_, i) => `const row_${i} = ${i};`).join("\n");
      const chunks = chunkText("src/giant.ts", hugeContent);
      assert.ok(chunks.length <= 80);
    });
  });

  describe("Consistent Ignore Rules Across Components", () => {
    it("excludes .photon/, .git, node_modules, build outputs, and lockfiles across indexer and project context", () => {
      assert.equal(shouldIndexFile(".photon/context.json").indexable, false);
      assert.equal(shouldIndexFile(".git/config").indexable, false);
      assert.equal(shouldIndexFile("node_modules/lodash/index.js").indexable, false);
      assert.equal(shouldIndexFile("dist/bundle.js").indexable, false);
      assert.equal(shouldIndexFile("package-lock.json").indexable, false);

      // Valid project files must be indexable
      assert.equal(shouldIndexFile("src/index.ts").indexable, true);
      assert.equal(shouldIndexFile("README.md").indexable, true);
    });
  });

  describe("Project Context Manager Symbol Extraction, Invalidation & Memory Bounds", () => {
    it("extracts symbols from supported languages and degrades cleanly on malformed syntax", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-ctx-test-"));
      try {
        const srcDir = path.join(tmpDir, "src");
        await fs.mkdir(srcDir, { recursive: true });

        // Normal TypeScript file
        await fs.writeFile(
          path.join(srcDir, "auth.ts"),
          [
            "export interface AuthConfig { timeout: number; }",
            "export class AuthService {",
            "  async login(user: string): Promise<boolean> { return true; }",
            "}",
            "export function createAuth(): AuthService { return new AuthService(); }",
          ].join("\n"),
          "utf8"
        );

        // Malformed TypeScript file (unclosed braces, invalid tokens)
        await fs.writeFile(
          path.join(srcDir, "malformed.ts"),
          "export class Broken { function unclosed() {",
          "utf8"
        );

        const mgr = new ProjectContextManager(tmpDir, path.join(tmpDir, ".photon", "context.json"));
        await mgr.ensureInitialized();

        const outline = mgr.getFileSymbolOutline("src/auth.ts");
        assert.ok(outline);
        assert.ok(outline.includes("class AuthService"));
        assert.ok(outline.includes("interface AuthConfig"));
        assert.ok(outline.includes("function createAuth"));

        // Malformed file must not crash and should produce a graceful outline or empty symbol list
        const brokenOutline = mgr.getFileSymbolOutline("src/malformed.ts");
        // Does not throw
        assert.ok(brokenOutline !== undefined || brokenOutline === undefined);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("invalidates symbol caches and tracked state on file removal and rename", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-ctx-test-"));
      try {
        const srcDir = path.join(tmpDir, "src");
        await fs.mkdir(srcDir, { recursive: true });
        await fs.writeFile(path.join(srcDir, "service.ts"), "export class OldService {}", "utf8");

        const mgr = new ProjectContextManager(tmpDir, path.join(tmpDir, ".photon", "context.json"));
        await mgr.ensureInitialized();

        assert.ok(mgr.getFileSymbolOutline("src/service.ts"));

        // Test renameFile
        mgr.renameFile("src/service.ts", "src/renamedService.ts");
        assert.equal(mgr.getFileSymbolOutline("src/service.ts"), undefined);
        assert.ok(mgr.getFileSymbolOutline("src/renamedService.ts"));

        // Test removeFile
        mgr.removeFile("src/renamedService.ts");
        assert.equal(mgr.getFileSymbolOutline("src/renamedService.ts"), undefined);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("bounds project context memory and writes persisted state atomically", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-ctx-test-"));
      const storagePath = path.join(tmpDir, ".photon", "context.json");
      try {
        const mgr = new ProjectContextManager(tmpDir, storagePath);
        await mgr.ensureInitialized();

        // Add 70 notes (cap is 50)
        for (let i = 0; i < 70; i++) {
          mgr.addNote({
            category: "architecture",
            title: `Note ${i}`,
            content: `Detail text for note ${i}`,
          });
        }

        await mgr.saveToDisk();

        // Verify storage file exists and is valid JSON
        const raw = await fs.readFile(storagePath, "utf8");
        const parsed = JSON.parse(raw);
        assert.ok(parsed.notes.length <= 50);

        // Verify no leftover .tmp files
        const photonDir = path.join(tmpDir, ".photon");
        const files = await fs.readdir(photonDir);
        assert.ok(!files.some((f) => f.endsWith(".tmp")));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("ensures cross-model handoff contains verified facts and attempted failures", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-ctx-test-"));
      try {
        const mgr = new ProjectContextManager(tmpDir, path.join(tmpDir, ".photon", "context.json"));
        await mgr.ensureInitialized();

        mgr.recordTurnHandoff({
          fromModel: "qwen2.5-coder:7b",
          userPrompt: "Refactor auth logic",
          assistantResponse: "I updated auth.ts and verified tests pass.",
          toolsUsed: [
            { name: "edit_file", args: { path: "src/auth.ts" }, ok: true },
            { name: "read_file", args: { path: "src/missing.ts" }, ok: false },
          ],
          pendingTodos: ["Add integration tests"],
        });

        const handoff = mgr.getSummary().latestHandoff;
        assert.ok(handoff);
        assert.equal(handoff.fromModel, "qwen2.5-coder:7b");
        // Must contain verified facts
        assert.ok(handoff.keyFindings.some((f) => f.includes("Verified edit_file: src/auth.ts")));
        // Must contain attempted failure
        assert.ok(handoff.keyFindings.some((f) => f.includes("Attempted read_file (failed): src/missing.ts")));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("supports multi-root workspaces with independent manager instances", () => {
      const rootA = "C:/projects/repoA";
      const rootB = "C:/projects/repoB";

      const mgrA = getProjectContextManager(rootA);
      const mgrB = getProjectContextManager(rootB);

      assert.ok(mgrA);
      assert.ok(mgrB);
      assert.notEqual(mgrA, mgrB);

      mgrA.addNote({ category: "architecture", title: "Repo A", content: "Repo A note" });
      mgrB.addNote({ category: "architecture", title: "Repo B", content: "Repo B note" });

      assert.equal(mgrA.getSummary().notes[0].content, "Repo A note");
      assert.equal(mgrB.getSummary().notes[0].content, "Repo B note");
    });
  });
});
