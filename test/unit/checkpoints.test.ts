import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after, beforeEach } from "node:test";
import {
  CheckpointManager,
  getCheckpointManager,
  _resetCheckpointManagersForTesting,
} from "../../src/core/checkpoints/checkpointManager";
import { writeFileTool, editFileTool, appendFileTool } from "../../src/core/tools/builtin/files";
import type { ToolContext } from "../../src/core/tools/types";

describe("Checkpoint & Rollback Manager", () => {
  let tmpDir: string;
  let customStorage: string;
  let mgr: CheckpointManager;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "photon-checkpoint-test-"));
    customStorage = path.join(tmpDir, ".photon", "checkpoints.json");
  });

  beforeEach(async () => {
    _resetCheckpointManagersForTesting();
    // Clean directory before each test
    const entries = await fs.readdir(tmpDir);
    for (const entry of entries) {
      await fs.rm(path.join(tmpDir, entry), { recursive: true, force: true });
    }
    mgr = new CheckpointManager(tmpDir, customStorage);
    await mgr.ensureInitialized();
  });

  after(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("discards empty turn when no files are modified", async () => {
    mgr.beginTurn("session-1", "msg-1", "Read-only turn");
    const cp = await mgr.commitTurn("msg-1");
    assert.strictEqual(cp, null);
    assert.strictEqual(mgr.listCheckpoints().length, 0);
  });

  it("captures existing file state and newly created file state on commit", async () => {
    // Setup initial file
    const existingFile = path.join(tmpDir, "hello.txt");
    await fs.writeFile(existingFile, "Original content", "utf8");

    mgr.beginTurn("session-1", "msg-1", "Update hello.txt and create new.txt");
    await mgr.recordBeforeChange("hello.txt");
    await mgr.recordBeforeChange("new.txt");

    // Perform file mutations
    await fs.writeFile(existingFile, "Mutated content", "utf8");
    await fs.writeFile(path.join(tmpDir, "new.txt"), "Brand new file", "utf8");

    const cp = await mgr.commitTurn("msg-1");
    assert.ok(cp);
    assert.strictEqual(cp.modifiedFilesCount, 2);
    assert.strictEqual(cp.files["hello.txt"].existed, true);
    assert.strictEqual(cp.files["hello.txt"].content, "Original content");
    assert.strictEqual(cp.files["new.txt"].existed, false);

    // Verify storage persistence on disk
    const raw = await fs.readFile(customStorage, "utf8");
    const saved = JSON.parse(raw);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].id, cp.id);
  });

  it("rolls back a single turn (reverts modified file and removes created file)", async () => {
    const existingFile = path.join(tmpDir, "app.ts");
    await fs.writeFile(existingFile, "const x = 10;", "utf8");

    mgr.beginTurn("session-1", "turn-1", "Edit app and add helper");
    await mgr.recordBeforeChange("app.ts");
    await mgr.recordBeforeChange("helper.ts");

    await fs.writeFile(existingFile, "const x = 999; // updated", "utf8");
    await fs.writeFile(path.join(tmpDir, "helper.ts"), "export const y = 20;", "utf8");

    const cp = await mgr.commitTurn("turn-1");
    assert.ok(cp);

    // Verify current state before rollback
    assert.strictEqual(await fs.readFile(existingFile, "utf8"), "const x = 999; // updated");
    const helperExistsBefore = await fs.stat(path.join(tmpDir, "helper.ts")).then(() => true).catch(() => false);
    assert.strictEqual(helperExistsBefore, true);

    // Rollback
    const res = await mgr.rollbackToCheckpoint(cp.id);
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(res.revertedFiles, ["app.ts"]);
    assert.deepStrictEqual(res.deletedFiles, ["helper.ts"]);

    // Verify file content restored
    assert.strictEqual(await fs.readFile(existingFile, "utf8"), "const x = 10;");

    // Verify created file deleted
    const helperExistsAfter = await fs.stat(path.join(tmpDir, "helper.ts")).then(() => true).catch(() => false);
    assert.strictEqual(helperExistsAfter, false);

    // Checkpoints list should now be empty
    assert.strictEqual(mgr.listCheckpoints().length, 0);
  });

  it("handles multi-turn cumulative rollback with repeated mutations to same file", async () => {
    const mainFile = path.join(tmpDir, "main.js");
    await fs.writeFile(mainFile, "console.log('v0');", "utf8");

    // Turn 1: update main.js to v1, create a.txt
    mgr.beginTurn("session-1", "turn-1", "Turn 1");
    await mgr.recordBeforeChange("main.js");
    await mgr.recordBeforeChange("a.txt");
    await fs.writeFile(mainFile, "console.log('v1');", "utf8");
    await fs.writeFile(path.join(tmpDir, "a.txt"), "A", "utf8");
    const cp1 = await mgr.commitTurn("turn-1");
    assert.ok(cp1);
    assert.strictEqual(cp1.checkpointNumber, 1);

    // Turn 2: update main.js to v2, create b.txt
    mgr.beginTurn("session-1", "turn-2", "Turn 2");
    await mgr.recordBeforeChange("main.js");
    await mgr.recordBeforeChange("b.txt");
    await fs.writeFile(mainFile, "console.log('v2');", "utf8");
    await fs.writeFile(path.join(tmpDir, "b.txt"), "B", "utf8");
    const cp2 = await mgr.commitTurn("turn-2");
    assert.ok(cp2);
    assert.strictEqual(cp2.checkpointNumber, 2);

    // Turn 3: update a.txt, create c.txt
    mgr.beginTurn("session-1", "turn-3", "Turn 3");
    await mgr.recordBeforeChange("a.txt");
    await mgr.recordBeforeChange("c.txt");
    await fs.writeFile(path.join(tmpDir, "a.txt"), "A updated", "utf8");
    await fs.writeFile(path.join(tmpDir, "c.txt"), "C", "utf8");
    const cp3 = await mgr.commitTurn("turn-3");
    assert.ok(cp3);
    assert.strictEqual(cp3.checkpointNumber, 3);

    // Test getCheckpointByNumber
    const found2 = mgr.getCheckpointByNumber("session-1", 2);
    assert.strictEqual(found2?.id, cp2.id);

    // Test getSessionCheckpointSummaries (returns newest first)
    const summaries = mgr.getSessionCheckpointSummaries("session-1");
    assert.strictEqual(summaries.length, 3);
    assert.strictEqual(summaries[0].checkpointNumber, 3);
    assert.strictEqual(summaries[1].checkpointNumber, 2);
    assert.strictEqual(summaries[2].checkpointNumber, 1);

    assert.strictEqual(mgr.listCheckpoints().length, 3);

    // Rollback to cp1 (before Turn 1 started):
    // - main.js should revert to "console.log('v0');" (earliest state in chain)
    // - a.txt should be deleted (it did not exist before Turn 1)
    // - b.txt should be deleted
    // - c.txt should be deleted
    const res = await mgr.rollbackToCheckpoint(cp1.id);
    assert.strictEqual(res.success, true);
    assert.ok(res.revertedFiles.includes("main.js"));
    assert.ok(res.deletedFiles.includes("a.txt"));
    assert.ok(res.deletedFiles.includes("b.txt"));
    assert.ok(res.deletedFiles.includes("c.txt"));

    assert.strictEqual(await fs.readFile(mainFile, "utf8"), "console.log('v0');");

    const aExists = await fs.stat(path.join(tmpDir, "a.txt")).then(() => true).catch(() => false);
    const bExists = await fs.stat(path.join(tmpDir, "b.txt")).then(() => true).catch(() => false);
    const cExists = await fs.stat(path.join(tmpDir, "c.txt")).then(() => true).catch(() => false);
    assert.strictEqual(aExists, false);
    assert.strictEqual(bExists, false);
    assert.strictEqual(cExists, false);

    assert.strictEqual(mgr.listCheckpoints().length, 0);
  });

  it("cancels active turn without committing any changes", async () => {
    mgr.beginTurn("session-1", "turn-x", "Aborted turn");
    await mgr.recordBeforeChange("temp.txt");
    mgr.cancelTurn();

    const cp = await mgr.commitTurn("turn-x");
    assert.strictEqual(cp, null);
    assert.strictEqual(mgr.listCheckpoints().length, 0);
  });

  it("loads existing checkpoints from disk on initialization", async () => {
    const filePath = path.join(tmpDir, "persisted.txt");
    await fs.writeFile(filePath, "initial", "utf8");

    mgr.beginTurn("session-1", "turn-p", "Persist test");
    await mgr.recordBeforeChange("persisted.txt");
    await fs.writeFile(filePath, "updated", "utf8");
    const cp = await mgr.commitTurn("turn-p");
    assert.ok(cp);

    // Instantiate a new manager instance pointing to the same storage
    const newMgr = new CheckpointManager(tmpDir, customStorage);
    await newMgr.ensureInitialized();

    const loaded = newMgr.listCheckpoints();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].id, cp.id);
    assert.strictEqual(loaded[0].label, "Persist test");
    assert.strictEqual(newMgr.getLatestCheckpoint()?.id, cp.id);
    assert.strictEqual(newMgr.getCheckpoint(cp.id)?.messageId, "turn-p");
  });

  it("integrates with file tools via checkpointTracker in ToolContext", async () => {
    const file = path.join(tmpDir, "code.ts");
    await fs.writeFile(file, "export function hello() { return 'world'; }\n", "utf8");

    mgr.beginTurn("session-1", "tool-turn", "Refactor hello");

    const ctx: ToolContext = {
      workspaceRoot: tmpDir,
      requestApproval: async () => true,
      signal: new AbortController().signal,
      log: () => {},
      webSearchProvider: "duckduckgo",
      findFiles: async () => [],
      capability: "medium",
      getDiagnostics: async () => [],
      todos: [],
      checkpointTracker: {
        recordBeforeChange: (p) => mgr.recordBeforeChange(p),
      },
    };

    // Edit file via editFileTool
    const editRes = await editFileTool.execute(
      {
        path: "code.ts",
        old_str: "return 'world';",
        new_str: "return 'photon';",
      },
      ctx
    );
    assert.strictEqual(editRes.ok, true);
    assert.strictEqual(await fs.readFile(file, "utf8"), "export function hello() { return 'photon'; }\n");

    // Write another file via writeFileTool
    const writeRes = await writeFileTool.execute(
      {
        path: "config.json",
        content: '{"enabled": true}',
      },
      ctx
    );
    assert.strictEqual(writeRes.ok, true);

    // Append to file via appendFileTool
    const appendRes = await appendFileTool.execute(
      {
        path: "code.ts",
        content: "// trailing note\n",
      },
      ctx
    );
    assert.strictEqual(appendRes.ok, true);

    const cp = await mgr.commitTurn("tool-turn");
    assert.ok(cp);
    assert.strictEqual(cp.modifiedFilesCount, 2); // code.ts and config.json

    // Rollback to verify tool mutations are completely undone
    const rb = await mgr.rollbackToCheckpoint(cp.id);
    assert.strictEqual(rb.success, true);
    assert.strictEqual(await fs.readFile(file, "utf8"), "export function hello() { return 'world'; }\n");
    const configExists = await fs.stat(path.join(tmpDir, "config.json")).then(() => true).catch(() => false);
    assert.strictEqual(configExists, false);
  });

  it("does not delete or prune checkpoint records if file restoration fails, allowing retry", async () => {
    const file1 = path.join(tmpDir, "file1.txt");
    const file2 = path.join(tmpDir, "file2.txt");
    await fs.writeFile(file1, "file1 v1", "utf8");
    await fs.writeFile(file2, "file2 v1", "utf8");

    mgr.beginTurn("session-1", "turn-fail", "Turn with partial failure");
    await mgr.recordBeforeChange("file1.txt");
    await mgr.recordBeforeChange("file2.txt");

    await fs.writeFile(file1, "file1 v2", "utf8");
    await fs.writeFile(file2, "file2 v2", "utf8");
    const cp = await mgr.commitTurn("turn-fail");
    assert.ok(cp);

    // Make file2 unwritable by replacing it with a directory containing a locked structure or bad target
    await fs.rm(file2);
    await fs.mkdir(file2); // Now writing to file2 as a file will throw EISDIR
    const sub = path.join(file2, "subfile");
    await fs.writeFile(sub, "locked", "utf8");

    // Attempt rollback
    const res = await mgr.rollbackToCheckpoint(cp.id);
    assert.strictEqual(res.success, false);
    assert.ok(res.errors.length > 0);
    assert.strictEqual(res.fileResults.find((r) => r.relativePath === "file2.txt")?.status, "failed");

    // CRITICAL: Checkpoint must NOT be deleted/pruned when restoration fails!
    assert.strictEqual(mgr.listCheckpoints().length, 1);
    assert.strictEqual(mgr.getCheckpoint(cp.id)?.id, cp.id);

    // Fix the condition (remove the directory blocking file2)
    await fs.rm(file2, { recursive: true, force: true });

    // Retry rollback: should succeed now!
    const retryRes = await mgr.rollbackToCheckpoint(cp.id);
    assert.strictEqual(retryRes.success, true);
    assert.strictEqual(await fs.readFile(file1, "utf8"), "file1 v1");
    assert.strictEqual(await fs.readFile(file2, "utf8"), "file2 v1");

    // Checkpoint is now safely pruned after full success
    assert.strictEqual(mgr.listCheckpoints().length, 0);
  });

  it("detects external modifications and prevents overwriting newer user work unless forced", async () => {
    const userFile = path.join(tmpDir, "usercode.ts");
    await fs.writeFile(userFile, "const baseline = true;", "utf8");

    mgr.beginTurn("session-1", "turn-ext", "Agent refactor");
    await mgr.recordBeforeChange("usercode.ts");
    await fs.writeFile(userFile, "const baseline = false; // agent edited", "utf8");
    const cp = await mgr.commitTurn("turn-ext");
    assert.ok(cp);

    // Simulate external edit by user after the checkpoint turn ended
    // Explicitly set disk mtime to 5 seconds in the future
    const futureTime = new Date(Date.now() + 5000);
    await fs.writeFile(userFile, "const userManualEdit = 42;", "utf8");
    await fs.utimes(userFile, futureTime, futureTime);

    // Normal rollback without force: MUST detect conflict and preserve user work
    const res = await mgr.rollbackToCheckpoint(cp.id);
    assert.strictEqual(res.success, false);
    const conflictResult = res.fileResults.find((r) => r.relativePath === "usercode.ts");
    assert.strictEqual(conflictResult?.status, "conflict");
    assert.ok(conflictResult?.reason?.includes("modified externally"));

    // User work was NOT overwritten
    assert.strictEqual(await fs.readFile(userFile, "utf8"), "const userManualEdit = 42;");

    // Checkpoint was preserved
    assert.strictEqual(mgr.listCheckpoints().length, 1);

    // Forced rollback: overwrites external edits intentionally
    const forceRes = await mgr.rollbackToCheckpoint(cp.id, { force: true });
    assert.strictEqual(forceRes.success, true);
    assert.strictEqual(await fs.readFile(userFile, "utf8"), "const baseline = true;");
    assert.strictEqual(mgr.listCheckpoints().length, 0);
  });

  it("handles oversized files (>2MB) safely with explicit unrestorable warnings", async () => {
    const bigFile = path.join(tmpDir, "large_dataset.bin");
    // Write 2.1 MB file
    const bigBuffer = Buffer.alloc(2.1 * 1024 * 1024, 0x41);
    await fs.writeFile(bigFile, bigBuffer);

    mgr.beginTurn("session-1", "turn-big", "Touch large file and small file");
    await mgr.recordBeforeChange("large_dataset.bin");

    const smallFile = path.join(tmpDir, "small.txt");
    await fs.writeFile(smallFile, "small v1", "utf8");
    await mgr.recordBeforeChange("small.txt");

    // Mutate files
    await fs.writeFile(bigFile, Buffer.alloc(100, 0x42));
    await fs.writeFile(smallFile, "small v2", "utf8");

    const cp = await mgr.commitTurn("turn-big");
    assert.ok(cp);
    assert.strictEqual(cp.hasUnrestorableFiles, true);
    assert.deepStrictEqual(cp.unrestorableFiles, ["large_dataset.bin"]);

    const summaries = mgr.getSessionCheckpointSummaries("session-1");
    assert.strictEqual(summaries[0].hasUnrestorableFiles, true);
    assert.deepStrictEqual(summaries[0].unrestorableFiles, ["large_dataset.bin"]);

    // Attempt rollback: should explicitly fail for the oversized file and preserve checkpoint
    const res = await mgr.rollbackToCheckpoint(cp.id);
    assert.strictEqual(res.success, false);
    const bigResult = res.fileResults.find((r) => r.relativePath === "large_dataset.bin");
    assert.strictEqual(bigResult?.status, "failed");
    assert.ok(bigResult?.reason?.includes("2 MB"));

    // Checkpoint preserved
    assert.strictEqual(mgr.listCheckpoints().length, 1);
  });

  it("isolates rollbacks across session boundaries without touching other sessions", async () => {
    const fileA = path.join(tmpDir, "fileA.txt");
    const fileB = path.join(tmpDir, "fileB.txt");
    await fs.writeFile(fileA, "v1_A", "utf8");
    await fs.writeFile(fileB, "v1_B", "utf8");

    // Session A creates checkpoint cpA
    mgr.beginTurn("session-A", "turn-A1", "Edit A");
    await mgr.recordBeforeChange("fileA.txt");
    await fs.writeFile(fileA, "v2_A", "utf8");
    const cpA = await mgr.commitTurn("turn-A1");
    assert.ok(cpA);

    // Session B creates checkpoint cpB
    mgr.beginTurn("session-B", "turn-B1", "Edit B");
    await mgr.recordBeforeChange("fileB.txt");
    await fs.writeFile(fileB, "v2_B", "utf8");
    const cpB = await mgr.commitTurn("turn-B1");
    assert.ok(cpB);

    assert.strictEqual(mgr.listCheckpoints().length, 2);

    // Rollback session A checkpoint
    const resA = await mgr.rollbackToCheckpoint(cpA.id);
    assert.strictEqual(resA.success, true);
    assert.strictEqual(await fs.readFile(fileA, "utf8"), "v1_A");

    // Session B's file and checkpoint MUST remain untouched and intact
    assert.strictEqual(await fs.readFile(fileB, "utf8"), "v2_B");
    const remaining = mgr.listCheckpoints();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, cpB.id);
    assert.strictEqual(remaining[0].sessionId, "session-B");
  });

  it("succeeds on delayed rollback retry without reporting false conflicts on already restored files", async () => {
    const file1 = path.join(tmpDir, "retry1.txt");
    const file2 = path.join(tmpDir, "retry2.txt");
    await fs.writeFile(file1, "original_1", "utf8");
    await fs.writeFile(file2, "original_2", "utf8");

    mgr.beginTurn("session-retry", "turn-r1", "Mutate both files");
    await mgr.recordBeforeChange("retry1.txt");
    await mgr.recordBeforeChange("retry2.txt");
    await fs.writeFile(file1, "mutated_1", "utf8");
    await fs.writeFile(file2, "mutated_2", "utf8");
    const cp = await mgr.commitTurn("turn-r1");
    assert.ok(cp);

    // Simulate partial restore: file1 is restored to original_1
    await fs.writeFile(file1, "original_1", "utf8");
    // Simulate elapsed time by touching file1 mtime forward by 5 seconds
    const futureTime = new Date(Date.now() + 5000);
    await fs.utimes(file1, futureTime, futureTime);

    // Verify file1 stat is > 1000ms after postMutationMtimes
    const stat1 = await fs.stat(file1);
    const postMtime = cp.postMutationMtimes?.["retry1.txt"] ?? 0;
    assert.ok(stat1.mtimeMs > postMtime + 1000);

    // Rollback should detect that retry1.txt already matches snapshot content and NOT flag a conflict
    const res = await mgr.rollbackToCheckpoint(cp.id);
    assert.strictEqual(res.success, true);
    assert.strictEqual(await fs.readFile(file1, "utf8"), "original_1");
    assert.strictEqual(await fs.readFile(file2, "utf8"), "original_2");
    assert.strictEqual(mgr.listCheckpoints().length, 0);
  });
});
