import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after } from "node:test";
import {
  appendFileTool,
  editFileTool,
  listDirTool,
  movePathTool,
  readFileTool,
  writeFileTool,
} from "../../src/core/tools/builtin/files";
import { findFilesTool, searchCodeTool } from "../../src/core/tools/builtin/search";
import type { ToolContext } from "../../src/core/tools/types";

describe("Built-in Workspace Tools", () => {
  let tmpDir: string;
  let ctx: ToolContext;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-test-tools-"));
    ctx = {
      workspaceRoot: tmpDir,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      log: () => {},
      webSearchProvider: "duckduckgo",
      findFiles: async (query: string) => {
        const found: string[] = [];
        const scan = async (dir: string) => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            const rel = path.relative(tmpDir, path.join(dir, e.name)).replace(/\\/g, "/");
            if (e.isDirectory()) {
              await scan(path.join(dir, e.name));
            } else if (rel.includes(query) || query === "*" || query.includes(e.name)) {
              found.push(rel);
            }
          }
        };
        await scan(tmpDir);
        return found;
      },
      capability: "medium",
      getDiagnostics: async () => [],
      todos: [],
    };
  });

  after(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("writeFileTool", () => {
    it("creates a new file and any missing parent directories", async () => {
      const res = await writeFileTool.execute(
        { path: "src/nested/hello.txt", content: "Hello from Photon!" },
        ctx
      );
      assert.equal(res.ok, true);
      const content = await fs.readFile(path.join(tmpDir, "src/nested/hello.txt"), "utf8");
      assert.equal(content, "Hello from Photon!");
    });

    it("prevents directory traversal outside the workspace boundary", async () => {
      const res = await writeFileTool.execute(
        { path: "../../outside.txt", content: "forbidden" },
        ctx
      );
      assert.equal(res.ok, false);
      assert.ok(res.output.toLowerCase().includes("outside") || res.output.toLowerCase().includes("denied") || res.output.includes("EACCES"));
    });
  });

  describe("readFileTool", () => {
    before(async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: Content`);
      await fs.writeFile(path.join(tmpDir, "sample.txt"), lines.join("\n"), "utf8");
    });

    it("reads the entire file with line numbering", async () => {
      const res = await readFileTool.execute({ path: "sample.txt" }, ctx);
      assert.equal(res.ok, true);
      assert.ok(res.output.includes("Line 1: Content"));
      assert.ok(res.output.includes("Line 30: Content"));
    });

    it("reads a targeted line slice with start_line and end_line", async () => {
      const res = await readFileTool.execute(
        { path: "sample.txt", start_line: 5, end_line: 8 },
        ctx
      );
      assert.equal(res.ok, true);
      assert.ok(res.output.includes("Line 5: Content"));
      assert.ok(res.output.includes("Line 8: Content"));
      assert.ok(!res.output.includes("Line 1: Content"));
      assert.ok(!res.output.includes("Line 10: Content"));
    });

    it("returns a helpful error when a file is not found", async () => {
      const res = await readFileTool.execute({ path: "nonexistent.txt" }, ctx);
      assert.equal(res.ok, false);
      assert.ok(res.output.includes("ENOENT") || res.output.includes("no file"));
    });
  });

  describe("editFileTool", () => {
    it("performs exact match replacement", async () => {
      await fs.writeFile(
        path.join(tmpDir, "editable.ts"),
        "function foo() {\n  return 1;\n}\n",
        "utf8"
      );

      const res = await editFileTool.execute(
        {
          path: "editable.ts",
          old_str: "return 1;",
          new_str: "return 42;",
        },
        ctx
      );
      assert.equal(res.ok, true);
      const updated = await fs.readFile(path.join(tmpDir, "editable.ts"), "utf8");
      assert.ok(updated.includes("return 42;"));
      assert.ok(!updated.includes("return 1;"));
    });

    it("handles fuzzy whitespace differences between old_str and file contents", async () => {
      await fs.writeFile(
        path.join(tmpDir, "fuzzy.ts"),
        "function bar() {\n    const x = 10;   \n    return x;\n}\n",
        "utf8"
      );

      const res = await editFileTool.execute(
        {
          path: "fuzzy.ts",
          old_str: "const x = 10;\nreturn x;",
          new_str: "const x = 99;\nreturn x * 2;",
        },
        ctx
      );
      assert.equal(res.ok, true);
      const updated = await fs.readFile(path.join(tmpDir, "fuzzy.ts"), "utf8");
      assert.ok(updated.includes("const x = 99;"));
    });

    it("fails safely if old_str matches multiple times without replace_all", async () => {
      await fs.writeFile(
        path.join(tmpDir, "dup.ts"),
        "let a = 1;\nlet b = 1;\n",
        "utf8"
      );

      const res = await editFileTool.execute(
        {
          path: "dup.ts",
          old_str: "= 1;",
          new_str: "= 2;",
        },
        ctx
      );
      assert.equal(res.ok, false);
      assert.ok(res.output.toLowerCase().includes("multiple") || res.output.toLowerCase().includes("replace_all") || res.output.toLowerCase().includes("ambiguous"));
    });

    it("replaces all occurrences when replace_all is set to true", async () => {
      const res = await editFileTool.execute(
        {
          path: "dup.ts",
          old_str: "= 1;",
          new_str: "= 2;",
          replace_all: true,
        },
        ctx
      );
      assert.equal(res.ok, true);
      const updated = await fs.readFile(path.join(tmpDir, "dup.ts"), "utf8");
      assert.equal(updated, "let a = 2;\nlet b = 2;\n");
    });

    it("allows whole-file replacement shortcut on short files (<= 40 lines)", async () => {
      await fs.writeFile(path.join(tmpDir, "short.ts"), "old content\n", "utf8");
      const res = await editFileTool.execute(
        {
          path: "short.ts",
          new_str: "new full file content\n",
        },
        ctx
      );
      assert.equal(res.ok, true);
      const updated = await fs.readFile(path.join(tmpDir, "short.ts"), "utf8");
      assert.equal(updated, "new full file content\n");
    });

    it("protects long files (> 40 lines) by requiring old_str", async () => {
      const longLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      await fs.writeFile(path.join(tmpDir, "long.ts"), longLines, "utf8");

      const res = await editFileTool.execute(
        {
          path: "long.ts",
          new_str: "wipe file\n",
        },
        ctx
      );
      assert.equal(res.ok, false);
      assert.ok(res.output.toLowerCase().includes("old_str"));
    });
  });

  describe("appendFileTool", () => {
    it("appends text to an existing file", async () => {
      await fs.writeFile(path.join(tmpDir, "append.txt"), "First line\n", "utf8");
      const res = await appendFileTool.execute(
        { path: "append.txt", content: "Second line\n" },
        ctx
      );
      assert.equal(res.ok, true);
      const content = await fs.readFile(path.join(tmpDir, "append.txt"), "utf8");
      assert.equal(content, "First line\nSecond line\n");
    });

    it("fails with not_found when appending to non-existent file", async () => {
      const res = await appendFileTool.execute(
        { path: "does_not_exist.txt", content: "Should fail" },
        ctx
      );
      assert.equal(res.ok, false);
      assert.ok(res.output.includes("ENOENT") || res.output.includes("no file"));
    });
  });

  describe("movePathTool", () => {
    it("renames a file cleanly within the workspace", async () => {
      await fs.writeFile(path.join(tmpDir, "initial.txt"), "move me", "utf8");
      const res = await movePathTool.execute(
        { from: "initial.txt", to: "moved.txt" },
        ctx
      );
      assert.equal(res.ok, true);
      const moved = await fs.readFile(path.join(tmpDir, "moved.txt"), "utf8");
      assert.equal(moved, "move me");
      await assert.rejects(fs.readFile(path.join(tmpDir, "initial.txt"), "utf8"));
    });
  });

  describe("listDirTool & searchCodeTool & findFilesTool", () => {
    it("lists directory files and subdirectories", async () => {
      const res = await listDirTool.execute({ path: "." }, ctx);
      assert.equal(res.ok, true);
      assert.ok(res.output.includes("editable.ts"));
      assert.ok(res.output.includes("src/"));
    });

    it("finds files by glob/substring pattern", async () => {
      const res = await findFilesTool.execute({ query: "editable" }, ctx);
      assert.equal(res.ok, true);
      assert.ok(res.output.includes("editable.ts"));
    });

    it("searches code contents across files with line numbers", async () => {
      const res = await searchCodeTool.execute({ query: "return 42" }, ctx);
      assert.equal(res.ok, true);
      assert.ok(res.output.includes("editable.ts"));
      assert.ok(res.output.includes("return 42"));
    });
  });
});
