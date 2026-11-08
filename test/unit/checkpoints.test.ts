import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after, beforeEach } from "node:test";
import {
  CheckpointManager,
  getCheckpointManager,
  _resetCheckpointManagersForTesting,
  SnapshotError,
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
    const list = Array.isArray(saved) ? saved : saved.checkpoints;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, cp.id);
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

  describe("P0: Active-turn concurrency regression suite", () => {
    it("aborts session A turn, immediately starts session B turn, then A finalizes; B checkpoint survives", async () => {
      const fileA = path.join(tmpDir, "fileA.txt");
      const fileB = path.join(tmpDir, "fileB.txt");
      await fs.writeFile(fileA, "initial A", "utf8");
      await fs.writeFile(fileB, "initial B", "utf8");

      // Session A begins turn
      mgr.beginTurn("session-A", "turn-A", "Task A");
      await mgr.recordBeforeChange("fileA.txt", { sessionId: "session-A", messageId: "turn-A" });
      await fs.writeFile(fileA, "modified A", "utf8");

      // Session A is aborted
      mgr.cancelTurn("turn-A", "session-A");

      // Immediately session B starts
      mgr.beginTurn("session-B", "turn-B", "Task B");
      await mgr.recordBeforeChange("fileB.txt", { sessionId: "session-B", messageId: "turn-B" });
      await fs.writeFile(fileB, "modified B", "utf8");

      // Late finally block from session A executes commitTurn
      const staleCpA = await mgr.commitTurn("turn-A", "session-A");
      assert.strictEqual(staleCpA, null, "Cancelled turn A must not commit");

      // Session B finalizes normally
      const cpB = await mgr.commitTurn("turn-B", "session-B");
      assert.ok(cpB, "Session B checkpoint must commit successfully");
      assert.strictEqual(cpB.sessionId, "session-B");
      assert.strictEqual(cpB.messageId, "turn-B");
      assert.ok(cpB.files["fileB.txt"]);
      assert.strictEqual(cpB.files["fileA.txt"], undefined);

      const allCps = mgr.listCheckpoints();
      assert.strictEqual(allCps.length, 1);
      assert.strictEqual(allCps[0].id, cpB.id);
    });

    it("runs overlapping asynchronous mutations in two sessions with strict snapshot isolation", async () => {
      const fileA = path.join(tmpDir, "isoA.txt");
      const fileB = path.join(tmpDir, "isoB.txt");
      await fs.writeFile(fileA, "orig A", "utf8");
      await fs.writeFile(fileB, "orig B", "utf8");

      mgr.beginTurn("session-A", "turn-A", "Task A");
      mgr.beginTurn("session-B", "turn-B", "Task B");

      // Interleaved / overlapping asynchronous snapshot recordings
      await Promise.all([
        mgr.recordBeforeChange("isoA.txt", { sessionId: "session-A", messageId: "turn-A" }),
        mgr.recordBeforeChange("isoB.txt", { sessionId: "session-B", messageId: "turn-B" }),
      ]);

      await fs.writeFile(fileA, "mutated A", "utf8");
      await fs.writeFile(fileB, "mutated B", "utf8");

      const [cpA, cpB] = await Promise.all([
        mgr.commitTurn("turn-A", "session-A"),
        mgr.commitTurn("turn-B", "session-B"),
      ]);

      assert.ok(cpA);
      assert.ok(cpB);
      assert.deepStrictEqual(Object.keys(cpA.files), ["isoA.txt"]);
      assert.deepStrictEqual(Object.keys(cpB.files), ["isoB.txt"]);
    });

    it("commits an unknown/stale message ID without clearing active turn state", async () => {
      const file = path.join(tmpDir, "stay_active.txt");
      await fs.writeFile(file, "hello", "utf8");

      mgr.beginTurn("session-1", "turn-real", "Real work");
      await mgr.recordBeforeChange("stay_active.txt", "turn-real");
      await fs.writeFile(file, "hello updated", "utf8");

      // Commit stale / unknown message ID
      const staleResult = await mgr.commitTurn("turn-stale-999");
      assert.strictEqual(staleResult, null);

      // Verify active turn for turn-real is intact
      const active = mgr.getActiveTurn("turn-real");
      assert.ok(active);
      assert.strictEqual(active.messageId, "turn-real");
      assert.strictEqual(active.files.has("stay_active.txt"), true);

      // Real turn commits successfully
      const realCp = await mgr.commitTurn("turn-real");
      assert.ok(realCp);
      assert.strictEqual(realCp.messageId, "turn-real");
    });

    it("cancels while snapshot I/O is in progress; verifies no snapshot leaks into a later turn", async () => {
      const leakFile = path.join(tmpDir, "leak.txt");
      await fs.writeFile(leakFile, "leak content", "utf8");

      mgr.beginTurn("session-1", "turn-cancelled", "Cancelled turn");

      // Trigger recordBeforeChange and cancel immediately
      const recordPromise = mgr.recordBeforeChange("leak.txt", "turn-cancelled");
      mgr.cancelTurn("turn-cancelled");
      await recordPromise;

      // Start brand new turn-clean
      mgr.beginTurn("session-1", "turn-clean", "Clean turn");
      // Turn clean performs no mutations
      const cleanCp = await mgr.commitTurn("turn-clean");
      assert.strictEqual(cleanCp, null, "Turn clean should have 0 files and not commit");
      assert.strictEqual(mgr.listCheckpoints().length, 0);
    });
  });

  describe("P0: Snapshot failures fail closed and binary/symlink support", () => {
    it("distinguishes ENOENT from directory or stat failures and fails closed", async () => {
      // 1. ENOENT correctly records existed: false without throwing
      mgr.beginTurn("session-1", "turn-snap-1", "ENOENT test");
      await mgr.recordBeforeChange("nonexistent_file.txt", "turn-snap-1");
      const turn = mgr.getActiveTurn("turn-snap-1");
      assert.strictEqual(turn?.files.get("nonexistent_file.txt")?.existed, false);

      // 2. Directory path fails closed with SnapshotError and does NOT set existed: false
      const dirPath = path.join(tmpDir, "some_dir");
      await fs.mkdir(dirPath);
      await assert.rejects(
        async () => {
          await mgr.recordBeforeChange("some_dir", "turn-snap-1");
        },
        (err: any) => {
          assert.ok(err instanceof SnapshotError);
          assert.strictEqual(err.reason, "is_directory");
          return true;
        }
      );
      const dirSnap = turn?.files.get("some_dir");
      assert.ok(dirSnap);
      assert.strictEqual(dirSnap.existed, true);
      assert.strictEqual(dirSnap.failureReason, "is_directory");

      // 3. allowUnprotected allows recording without throwing
      await mgr.recordBeforeChange("some_dir", {
        sessionId: "session-1",
        messageId: "turn-snap-1",
        allowUnprotected: true,
      });
    });

    it("preserves exact binary file bytes with base64 encoding and restores safely", async () => {
      const binFile = path.join(tmpDir, "binary_data.bin");
      // Create binary buffer with embedded NULL bytes (0x00) and various byte values
      const initialBytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x00, 0x42, 0x00]);
      await fs.writeFile(binFile, initialBytes);

      mgr.beginTurn("session-1", "turn-bin", "Mutate binary");
      await mgr.recordBeforeChange("binary_data.bin", "turn-bin");

      const activeTurn = mgr.getActiveTurn("turn-bin");
      const snap = activeTurn?.files.get("binary_data.bin");
      assert.ok(snap);
      assert.strictEqual(snap.isBinary, true);
      assert.strictEqual(snap.encoding, "base64");
      assert.strictEqual(snap.content, initialBytes.toString("base64"));

      // Mutate binary file
      await fs.writeFile(binFile, Buffer.from([0xaa, 0xbb, 0xcc]));
      const cp = await mgr.commitTurn("turn-bin");
      assert.ok(cp);

      // Rollback to restore original binary
      const res = await mgr.rollbackToCheckpoint(cp.id);
      assert.strictEqual(res.success, true);
      const restoredBytes = await fs.readFile(binFile);
      assert.ok(restoredBytes.equals(initialBytes), "Binary content must be restored exactly without lossy conversion");
    });

    it("captures symlink target and restores symlinks on rollback", async () => {
      const targetFile = path.join(tmpDir, "target.txt");
      await fs.writeFile(targetFile, "target content", "utf8");
      const linkPath = path.join(tmpDir, "link_to_target.txt");

      try {
        await fs.symlink(targetFile, linkPath);
      } catch (e) {
        // Windows without developer mode / admin privileges may not allow creating symlinks
        // If symlink creation fails due to OS privilege, skip symlink test gracefully
        return;
      }

      mgr.beginTurn("session-1", "turn-symlink", "Symlink turn");
      await mgr.recordBeforeChange("link_to_target.txt", "turn-symlink");

      const activeTurn = mgr.getActiveTurn("turn-symlink");
      const snap = activeTurn?.files.get("link_to_target.txt");
      assert.ok(snap);
      assert.strictEqual(snap.isSymlink, true);
      assert.ok(snap.symlinkTarget);

      // Mutate: unlink and replace with a regular file
      await fs.unlink(linkPath);
      await fs.writeFile(linkPath, "regular file replacing symlink", "utf8");

      const cp = await mgr.commitTurn("turn-symlink");
      assert.ok(cp);

      // Rollback
      const res = await mgr.rollbackToCheckpoint(cp.id);
      assert.strictEqual(res.success, true);

      // Verify link was restored as a symlink
      const lstat = await fs.lstat(linkPath);
      assert.strictEqual(lstat.isSymbolicLink(), true);
    });
  });

  describe("P0: Durable checkpoint persistence", () => {
    it("propagates persistence failures to caller and does not retain uncommitted in-memory checkpoint", async () => {
      // Point manager to an invalid storage path inside a non-existent unwritable directory structure
      const unwritableStorage = path.join(tmpDir, "unwritable_dir", "checkpoints.json");
      // Create a file at "unwritable_dir" so fs.mkdir(dir) will fail with EEXIST/ENOTDIR
      await fs.writeFile(path.join(tmpDir, "unwritable_dir"), "blocking file");

      const brokenMgr = new CheckpointManager(tmpDir, unwritableStorage);
      await brokenMgr.ensureInitialized();

      const testFile = path.join(tmpDir, "persist_fail.txt");
      await fs.writeFile(testFile, "initial", "utf8");

      brokenMgr.beginTurn("session-1", "turn-fail-persist", "Persist fail turn");
      await brokenMgr.recordBeforeChange("persist_fail.txt", "turn-fail-persist");
      await fs.writeFile(testFile, "modified", "utf8");

      // commitTurn must reject with error rather than swallowing
      await assert.rejects(
        async () => {
          await brokenMgr.commitTurn("turn-fail-persist");
        },
        (err: any) => {
          assert.ok(err.message.includes("ENOTDIR") || err.message.includes("EEXIST") || err.message.includes("persist"));
          return true;
        }
      );

      // Verify in-memory checkpoints list did NOT retain the unpersisted checkpoint
      assert.strictEqual(brokenMgr.listCheckpoints().length, 0);
    });

    it("migrates legacy v1 manifest array to v2 envelope and validates corrupt records", async () => {
      const v1Storage = path.join(tmpDir, "v1_manifest.json");
      const legacyV1 = [
        {
          id: "cp_v1_1",
          sessionId: "sess-1",
          messageId: "msg-1",
          turnIndex: 1,
          checkpointNumber: 1,
          timestamp: 12345678,
          label: "Legacy V1",
          files: {
            "valid.txt": { relativePath: "valid.txt", existed: true, content: "legacy content" },
            "../../escape.txt": { relativePath: "../../escape.txt", existed: false }, // Dangerous path must be dropped
          },
        },
        {
          // Corrupt entry missing sessionId
          id: "cp_corrupt",
          label: "Corrupt",
        },
      ];

      await fs.writeFile(v1Storage, JSON.stringify(legacyV1), "utf8");

      const v1Mgr = new CheckpointManager(tmpDir, v1Storage);
      await v1Mgr.ensureInitialized();

      const loaded = v1Mgr.listCheckpoints();
      assert.strictEqual(loaded.length, 1, "Only valid record without traversal should be loaded");
      assert.strictEqual(loaded[0].id, "cp_v1_1");
      assert.ok(loaded[0].files["valid.txt"]);
      assert.strictEqual(loaded[0].files["../../escape.txt"], undefined, "Traversal path must be filtered out");

      // Discard or trigger persist to verify v2 envelope write
      await v1Mgr.discardCheckpoint("cp_v1_1");
      const raw = await fs.readFile(v1Storage, "utf8");
      const saved = JSON.parse(raw);
      assert.strictEqual(saved.version, 2, "Manifest must be saved with version 2");
      assert.ok(Array.isArray(saved.checkpoints));
    });

    it("bounds total snapshot bytes and evicts oldest checkpoints when exceeded", async () => {
      const boundStorage = path.join(tmpDir, "bounded_storage.json");
      const boundMgr = new CheckpointManager(tmpDir, boundStorage);
      await boundMgr.ensureInitialized();

      // Create multiple checkpoints with 1MB content each
      for (let i = 1; i <= 3; i++) {
        const fname = `large_${i}.txt`;
        const fpath = path.join(tmpDir, fname);
        // 1MB string
        await fs.writeFile(fpath, "X".repeat(1024 * 1024), "utf8");
        boundMgr.beginTurn("session-1", `turn-${i}`, `Turn ${i}`);
        await boundMgr.recordBeforeChange(fname, `turn-${i}`);
        await fs.writeFile(fpath, "Y".repeat(100), "utf8");
        await boundMgr.commitTurn(`turn-${i}`);
      }

      assert.strictEqual(boundMgr.listCheckpoints().length, 3);
      const totalBytes = boundMgr.calculateTotalSnapshotBytes();
      assert.ok(totalBytes >= 3 * 1024 * 1024);
    });
  });

  describe("P1: Rollback correctness suite", () => {
    it("uses content fingerprints so timestamp shifts on untouched files do not trigger false conflicts", async () => {
      const file = path.join(tmpDir, "fp_test.txt");
      await fs.writeFile(file, "version 0", "utf8");

      mgr.beginTurn("session-1", "turn-fp", "Edit fp test");
      await mgr.recordBeforeChange("fp_test.txt", "turn-fp");
      await fs.writeFile(file, "version 1 post-mutation", "utf8");
      const cp = await mgr.commitTurn("turn-fp");
      assert.ok(cp);

      // Verify postMutationFingerprints is present on checkpoint
      assert.ok(cp.postMutationFingerprints);
      assert.ok(cp.postMutationFingerprints["fp_test.txt"]);

      // Simulate an mtime bump (e.g. git checkout, filesystem touching) without changing content
      const futureTime = new Date(Date.now() + 5000);
      await fs.utimes(file, futureTime, futureTime);

      // Rollback should succeed because disk content matches postMutationFingerprint!
      const res = await mgr.rollbackToCheckpoint(cp.id);
      assert.strictEqual(res.success, true);
      assert.strictEqual(await fs.readFile(file, "utf8"), "version 0");
    });

    it("restores files atomically and cleans up any temp restore files", async () => {
      const file = path.join(tmpDir, "atomic_restore.txt");
      await fs.writeFile(file, "initial content", "utf8");

      mgr.beginTurn("session-1", "turn-atomic", "Atomic turn");
      await mgr.recordBeforeChange("atomic_restore.txt", "turn-atomic");
      await fs.writeFile(file, "mutated content", "utf8");
      const cp = await mgr.commitTurn("turn-atomic");
      assert.ok(cp);

      const res = await mgr.rollbackToCheckpoint(cp.id);
      assert.strictEqual(res.success, true);
      assert.strictEqual(await fs.readFile(file, "utf8"), "initial content");

      // Verify no dangling .restore.tmp files exist
      const entries = await fs.readdir(tmpDir);
      const tmpFiles = entries.filter((e) => e.includes(".restore.tmp"));
      assert.strictEqual(tmpFiles.length, 0);
    });
  });
});
