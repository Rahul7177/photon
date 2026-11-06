import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DISK_HEADROOM_BYTES,
  ModelInstaller,
  PullTracker,
  checkDiskSpace,
  classifyPullError,
  describeStatus,
  formatEta,
  ollamaModelsDir,
  type PullChunk,
} from "../../src/core/ollama/modelInstaller";
import type { PullProgress } from "../../src/shared/types";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("NDJSON pull parsing / progress math", () => {
  it("maps statuses to friendly stages", () => {
    assert.equal(describeStatus("pulling manifest"), "Pulling manifest");
    assert.match(describeStatus("pulling 2af3b81862c6", "sha256:2af3b81862c6abcdef"), /^Downloading layer 2af3b81862c6$/);
    assert.equal(describeStatus("verifying sha256 digest"), "Verifying sha256");
    assert.equal(describeStatus("writing manifest"), "Writing manifest");
    assert.equal(describeStatus("success"), "Installed");
  });

  it("aggregates bytes across layers and computes percent", () => {
    let t = 0;
    const tr = new PullTracker("m", () => t);
    tr.push({ status: "pulling a", digest: "a", total: 4 * GB, completed: 1 * GB });
    t = 1000;
    const p = tr.push({ status: "pulling b", digest: "b", total: 1 * GB, completed: 0 });
    assert.equal(p.totalBytes, 5 * GB);
    assert.equal(p.completedBytes, 1 * GB);
    assert.equal(p.percent, 20);
  });

  it("computes rolling 1s download rate and ETA", () => {
    let t = 0;
    const tr = new PullTracker("m", () => t);
    tr.push({ status: "pulling a", digest: "a", total: 1000 * MB, completed: 0 });
    t = 500;
    tr.push({ status: "pulling a", digest: "a", total: 1000 * MB, completed: 10 * MB });
    t = 1000;
    const p = tr.push({ status: "pulling a", digest: "a", total: 1000 * MB, completed: 30 * MB });
    // 30 MB over 1.0 s window
    assert.ok(Math.abs(p.bytesPerSec! - 30 * MB) < 1);
    assert.ok(Math.abs(p.etaSeconds! - (970 / 30)) < 0.01);
    assert.match(p.status, /30 MB \/ 1000 MB · 30\.0 MB\/s · ETA 00:32/);
  });

  it("old samples fall out of the rolling window", () => {
    let t = 0;
    const tr = new PullTracker("m", () => t);
    tr.push({ status: "pulling a", digest: "a", total: GB, completed: 0 });
    t = 10_000;
    tr.push({ status: "pulling a", digest: "a", total: GB, completed: 100 * MB });
    t = 11_000;
    const p = tr.push({ status: "pulling a", digest: "a", total: GB, completed: 150 * MB });
    assert.ok(Math.abs(p.bytesPerSec! - 50 * MB) < 1, "uses only the last second");
  });

  it("never exceeds 100% and ignores chunks without totals (manifest)", () => {
    const tr = new PullTracker("m", () => 0);
    const m = tr.push({ status: "pulling manifest" });
    assert.equal(m.percent, undefined);
    assert.equal(m.stage, "Pulling manifest");
    const p = tr.push({ status: "pulling a", digest: "a", total: 100, completed: 500 });
    assert.equal(p.percent, 100);
  });

  it("uses the estimated size for percent before layer totals arrive", () => {
    const tr = new PullTracker("m", () => 0, 1000, 5 * GB);
    // No layer totals yet: percent is derived from the estimate (0%), ETA unknown.
    const s = tr.snapshot();
    assert.equal(s.percent, 0);
    assert.equal(s.etaSeconds, undefined);
  });

  it("formats ETA mm:ss", () => {
    assert.equal(formatEta(42), "00:42");
    assert.equal(formatEta(125.4), "02:05");
  });
});

describe("pre-flight disk space", () => {
  it("blocks when free < size + 1.5GB with a clear message", () => {
    const r = checkDiskSpace("C:\\Users\\a\\.ollama\\models", 4.7 * GB, () => 2.1 * GB);
    assert.equal(r.ok, false);
    assert.match(r.message!, /Insufficient disk space: needs 4\.7 GB .* only 2\.1 GB available on C:/);
  });
  it("allows when there is enough space", () => {
    assert.equal(checkDiskSpace("/x", 4.7 * GB, () => 4.7 * GB + DISK_HEADROOM_BYTES + 1).ok, true);
  });
  it("boundary: exactly size+headroom passes, one byte less fails", () => {
    const need = 2 * GB + DISK_HEADROOM_BYTES;
    assert.equal(checkDiskSpace("/x", 2 * GB, () => need).ok, true);
    assert.equal(checkDiskSpace("/x", 2 * GB, () => need - 1).ok, false);
  });
  it("never blocks when free space or model size is unknown", () => {
    assert.equal(checkDiskSpace("/x", 4 * GB, () => undefined).ok, true);
    assert.equal(checkDiskSpace("/x", 4 * GB, () => { throw new Error("boom"); }).ok, true);
    assert.equal(checkDiskSpace("/x", undefined, () => 0).ok, true);
  });
  it("honours OLLAMA_MODELS", () => {
    assert.equal(ollamaModelsDir({ OLLAMA_MODELS: "D:\\m" }, "C:\\h"), "D:\\m");
    assert.match(ollamaModelsDir({}, "/home/u"), /\.ollama[\\/]models$/);
  });
});

describe("error classification", () => {
  it("disk full / network / not found / unreachable", () => {
    assert.equal(classifyPullError(new Error("write: no space left on device"), "C:").kind, "disk_full");
    assert.match(classifyPullError(new Error("ENOSPC"), "C:").message, /free up at least 3 GB on drive C:/);
    const net = classifyPullError(new Error("fetch failed"));
    assert.equal(net.kind, "network");
    assert.equal(net.resumable, true);
    assert.match(net.message, /Download interrupted/);
    assert.equal(classifyPullError(new Error("pull model manifest: file does not exist")).kind, "not_found");
    const refused = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    assert.equal(classifyPullError(refused).kind, "unreachable");
    assert.equal(classifyPullError(new Error("weird")).kind, "other");
  });
});

function installerWith(pull: (m: string, on: (c: PullChunk) => void, s: AbortSignal) => Promise<void>, free = () => 100 * GB) {
  return new ModelInstaller({ pull, freeSpace: free, modelsDir: "/m", minProgressIntervalMs: 0 });
}

describe("ModelInstaller", () => {
  it("streams progress then reports done", async () => {
    const seen: PullProgress[] = [];
    const inst = installerWith(async (_m, on) => {
      on({ status: "pulling manifest" });
      on({ status: "pulling a", digest: "a", total: 100, completed: 50 });
      on({ status: "pulling a", digest: "a", total: 100, completed: 100 });
      on({ status: "verifying sha256 digest" });
      on({ status: "success" });
    });
    const r = await inst.install("m:1", { onProgress: (p) => seen.push(p) });
    assert.equal(r.status, "done");
    assert.ok(seen.some((p) => p.percent === 50));
    assert.ok(seen.some((p) => p.stage === "Verifying sha256"));
    assert.equal(inst.activeModel, undefined, "lock released");
  });

  it("blocks without starting the pull when disk is insufficient", async () => {
    let pulled = false;
    const inst = installerWith(async () => { pulled = true; }, () => 1 * GB);
    const r = await inst.install("m:1", { estimatedSizeBytes: 4.7 * GB, onProgress: () => {} });
    assert.equal(r.status, "blocked");
    assert.equal(pulled, false);
    assert.equal(inst.activeModel, undefined);
  });

  it("cancel aborts the underlying signal and resets cleanly", async () => {
    let signalSeen: AbortSignal | undefined;
    const inst = installerWith(
      (_m, _on, signal) =>
        new Promise((_res, rej) => {
          signalSeen = signal;
          signal.addEventListener("abort", () => rej(new Error("This operation was aborted")));
        })
    );
    const p = inst.install("m:1", { onProgress: () => {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(inst.activeModel, "m:1");
    assert.equal(inst.cancel(), true);
    const r = await p;
    assert.equal(r.status, "cancelled");
    assert.equal(signalSeen!.aborted, true);
    assert.equal(inst.activeModel, undefined);
    assert.equal(inst.cancel(), false, "nothing left to cancel");
    // A new install works afterwards (no dangling lock).
    const again = await installerWith(async () => {}).install("m:2", { onProgress: () => {} });
    assert.equal(again.status, "done");
  });

  it("rejects a second concurrent install", async () => {
    let release!: () => void;
    const inst = installerWith(() => new Promise<void>((r) => { release = r; }));
    const first = inst.install("a", { onProgress: () => {} });
    await new Promise((r) => setImmediate(r));
    const second = await inst.install("b", { onProgress: () => {} });
    assert.equal(second.status, "blocked");
    release();
    assert.equal((await first).status, "done");
  });

  it("network failure is resumable; lock released", async () => {
    const inst = installerWith(async () => { throw new Error("fetch failed"); });
    const r = await inst.install("m", { onProgress: () => {} });
    assert.equal(r.status, "error");
    assert.ok(r.status === "error" && r.resumable);
    assert.equal(inst.activeModel, undefined);
  });

  it("a throwing progress listener cannot break the download", async () => {
    const inst = installerWith(async (_m, on) => { on({ status: "pulling a", digest: "a", total: 10, completed: 5 }); });
    const r = await inst.install("m", { onProgress: () => { throw new Error("ui gone"); } });
    assert.equal(r.status, "done");
  });
});
