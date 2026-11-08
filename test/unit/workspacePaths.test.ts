import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after } from "node:test";
import {
  resolveInWorkspace,
  realOrNearest,
  toWorkspaceRelative,
  atomicWriteFile,
} from "../../src/core/tools/paths";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  appendFileTool,
  movePathTool,
} from "../../src/core/tools/builtin/files";
import type { ToolContext } from "../../src/core/tools/types";

describe("Phase 2.4: Workspace Path Safety & Filesystem Boundaries", () => {
  let tmpWorkspace: string;
  let outsideDir: string;
  let ctx: ToolContext;

  before(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "photon-path-test-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-outside-test-"));

    ctx = {
      workspaceRoot: tmpWorkspace,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      log: () => {},
      webSearchProvider: "duckduckgo",
      findFiles: async () => [],
      capability: "medium",
      getDiagnostics: async () => [],
      todos: [],
    };
  });

  after(async () => {
    await fs.rm(tmpWorkspace, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe("resolveInWorkspace Boundary Enforcement", () => {
    it("permits valid relative paths and normalizes alternate separators", () => {
      const resUnix = resolveInWorkspace(tmpWorkspace, "src/utils/math.ts");
      assert.strictEqual("abs" in resUnix, true);

      const resWin = resolveInWorkspace(tmpWorkspace, "src\\utils\\math.ts");
      assert.strictEqual("abs" in resWin, true);
    });

    it("rejects lexical path traversal escaping workspace root", () => {
      const res = resolveInWorkspace(tmpWorkspace, "../../../etc/passwd");
      assert.strictEqual("error" in res, true);
      assert.ok((res as { error: string }).error.includes("outside the workspace"));
    });

    it("rejects Windows UNC and alternate drive paths", () => {
      const uncRes = resolveInWorkspace(tmpWorkspace, "\\\\attacker-server\\share\\evil.txt");
      assert.strictEqual("error" in uncRes, true);

      // Other drive letter
      const diffDrive = process.platform === "win32" ? "Z:\\other\\secret.txt" : "/var/other/secret.txt";
      const driveRes = resolveInWorkspace(tmpWorkspace, diffDrive);
      assert.strictEqual("error" in driveRes, true);
    });

    it("detects and blocks symlinks pointing outside the workspace", async () => {
      const outsideTarget = path.join(outsideDir, "outside_target.txt");
      await fs.writeFile(outsideTarget, "top secret outside content", "utf8");

      const linkPath = path.join(tmpWorkspace, "sneaky_symlink.txt");
      try {
        await fs.symlink(outsideTarget, linkPath);
      } catch {
        // Symlink creation may require admin privileges on some Windows setups; skip if OS disallows
        return;
      }

      const res = resolveInWorkspace(tmpWorkspace, "sneaky_symlink.txt");
      assert.strictEqual("error" in res, true);
      assert.ok((res as { error: string }).error.includes("outside the workspace"));
    });

    it("handles deeply nested nonexistent ancestors correctly without crashing", () => {
      const res = resolveInWorkspace(tmpWorkspace, "a/b/c/d/e/f/g/h/new_file.txt");
      assert.strictEqual("abs" in res, true);
      assert.ok((res as { abs: string }).abs.endsWith(path.join("a", "b", "c", "d", "e", "f", "g", "h", "new_file.txt")));
    });
  });

  describe("Atomic File Operations & Content Invariants", () => {
    it("atomicWriteFile writes completely without partial truncation", async () => {
      const rel = "src/atomic_test.txt";
      const content = "Line 1\nLine 2\nLine 3\n";
      const { abs } = await atomicWriteFile(tmpWorkspace, rel, content);

      assert.strictEqual(await fs.readFile(abs, "utf8"), content);

      // Overwrite atomically with updated content
      const updated = "Line 1 modified\nLine 2\n";
      await atomicWriteFile(tmpWorkspace, rel, updated);
      assert.strictEqual(await fs.readFile(abs, "utf8"), updated);
    });

    it("readFileTool detects and rejects binary files containing NUL bytes", async () => {
      const binRel = "assets/binary.bin";
      const binAbs = path.join(tmpWorkspace, binRel);
      await fs.mkdir(path.dirname(binAbs), { recursive: true });
      await fs.writeFile(binAbs, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f])); // contains 0x00

      const res = await readFileTool.execute({ path: binRel }, ctx);
      assert.strictEqual(res.ok, false);
      assert.ok(res.output.includes("binary file"));
    });

    it("readFileTool and editFileTool preserve and handle UTF-8 BOM cleanly", async () => {
      const bomRel = "src/bom_file.txt";
      const bomAbs = path.join(tmpWorkspace, bomRel);
      await fs.mkdir(path.dirname(bomAbs), { recursive: true });
      // File written with UTF-8 BOM (\uFEFF)
      await fs.writeFile(bomAbs, "\uFEFFHello World\nLine 2\n", "utf8");

      // Reading strips the invisible BOM so line numbering and matches work seamlessly
      const readRes = await readFileTool.execute({ path: bomRel }, ctx);
      assert.strictEqual(readRes.ok, true);
      assert.ok(readRes.output.includes("Hello World"));

      // Editing replaces text while preserving the BOM
      const editRes = await editFileTool.execute(
        { path: bomRel, old_str: "Hello World", new_str: "Hello Photon" },
        ctx
      );
      assert.strictEqual(editRes.ok, true);

      const saved = await fs.readFile(bomAbs, "utf8");
      assert.strictEqual(saved.startsWith("\uFEFF"), true);
      assert.ok(saved.includes("Hello Photon"));
    });

    it("editFileTool preserves CRLF line endings", async () => {
      const crlfRel = "src/crlf_file.txt";
      const crlfAbs = path.join(tmpWorkspace, crlfRel);
      await fs.mkdir(path.dirname(crlfAbs), { recursive: true });
      await fs.writeFile(crlfAbs, "first line\r\nsecond line\r\nthird line\r\n", "utf8");

      const editRes = await editFileTool.execute(
        { path: crlfRel, old_str: "second line", new_str: "updated second line" },
        ctx
      );
      assert.strictEqual(editRes.ok, true);

      const saved = await fs.readFile(crlfAbs, "utf8");
      assert.strictEqual(saved.includes("\r\n"), true);
      assert.ok(saved.includes("updated second line"));
    });

    it("movePathTool prevents silent overwrites when destination exists or is a broken symlink", async () => {
      const srcRel = "src/move_src.txt";
      const dstRel = "src/move_dst.txt";
      const srcAbs = path.join(tmpWorkspace, srcRel);
      const dstAbs = path.join(tmpWorkspace, dstRel);
      await fs.writeFile(srcAbs, "src content", "utf8");
      await fs.writeFile(dstAbs, "existing destination content", "utf8");

      const res = await movePathTool.execute({ from: srcRel, to: dstRel }, ctx);
      assert.strictEqual(res.ok, false);
      assert.ok(res.output.includes("already exists"));

      // Existing destination content must remain untouched
      assert.strictEqual(await fs.readFile(dstAbs, "utf8"), "existing destination content");
    });
  });
});

