import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PullProgress } from "../../shared/types";

/** Free space required on top of the model size (checklist 4.2). */
export const DISK_HEADROOM_BYTES = 1.5 * 1024 ** 3;
const GB = 1024 ** 3;

export interface PullChunk {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// 4.1 Progress tracking
// ---------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

export function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Map a raw Ollama status line to a short, friendly phase label. */
export function describeStatus(status: string, digest?: string): string {
  const s = (status ?? "").toLowerCase();
  if (s.startsWith("pulling manifest")) return "Pulling manifest";
  if (s.startsWith("pulling")) return `Downloading layer ${(digest ?? status.replace(/^pulling\s+/i, "")).replace(/^sha256:/, "").slice(0, 12)}`;
  if (s.includes("verifying")) return "Verifying sha256";
  if (s.includes("writing manifest")) return "Writing manifest";
  if (s.includes("removing")) return "Cleaning up";
  if (s === "success") return "Installed";
  return status || "Working…";
}

/**
 * Aggregates Ollama's per-layer NDJSON into one overall progress figure.
 * Speed is computed over a rolling window (default 1 s).
 */
export class PullTracker {
  private readonly layers = new Map<string, { total: number; completed: number }>();
  private readonly samples: { t: number; bytes: number }[] = [];
  private status = "";
  private digest: string | undefined;

  constructor(
    private readonly model: string,
    private readonly now: () => number = Date.now,
    private readonly windowMs = 1000,
    /** Estimated model size for ETA / percent before layer totals are known. */
    private readonly estimatedTotalBytes?: number
  ) {}

  push(chunk: PullChunk): PullProgress {
    this.status = chunk.status ?? this.status;
    this.digest = chunk.digest ?? this.digest;
    if (chunk.digest && chunk.total && chunk.total > 0) {
      this.layers.set(chunk.digest, {
        total: chunk.total,
        completed: Math.min(chunk.completed ?? 0, chunk.total),
      });
    }
    return this.snapshot();
  }

  snapshot(): PullProgress {
    let total = 0;
    let completed = 0;
    for (const l of this.layers.values()) {
      total += l.total;
      completed += l.completed;
    }
    const t = this.now();
    if (total > 0) {
      this.samples.push({ t, bytes: completed });
      while (this.samples.length > 1 && t - this.samples[0].t > this.windowMs) this.samples.shift();
    }
    let bytesPerSec: number | undefined;
    if (this.samples.length >= 2) {
      const first = this.samples[0];
      const last = this.samples[this.samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0) bytesPerSec = Math.max(0, (last.bytes - first.bytes) / dt);
    }
    const effectiveTotal = total > 0 ? total : this.estimatedTotalBytes ?? 0;
    const percent = effectiveTotal > 0 ? Math.min(100, Math.floor((completed / effectiveTotal) * 100)) : undefined;
    const etaSeconds =
      bytesPerSec && bytesPerSec > 0 && effectiveTotal > completed
        ? (effectiveTotal - completed) / bytesPerSec
        : undefined;

    const label = describeStatus(this.status, this.digest);
    let detail = label;
    if (total > 0 && /downloading/i.test(label)) {
      detail = `${label} — ${formatBytes(completed)} / ${formatBytes(total)}`;
      if (bytesPerSec) detail += ` · ${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
      if (etaSeconds !== undefined) detail += ` · ETA ${formatEta(etaSeconds)}`;
    }
    return {
      model: this.model,
      phase: "pulling",
      status: detail,
      percent,
      completedBytes: total > 0 ? completed : undefined,
      totalBytes: total > 0 ? total : undefined,
      bytesPerSec,
      etaSeconds,
      stage: label,
    };
  }
}

// ---------------------------------------------------------------------------
// 4.2 Disk space
// ---------------------------------------------------------------------------

/** Where Ollama stores models: $OLLAMA_MODELS or ~/.ollama/models. */
export function ollamaModelsDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.OLLAMA_MODELS?.trim() || path.join(home, ".ollama", "models");
}

export interface DiskCheck {
  ok: boolean;
  /** undefined when free space could not be determined (never blocks a pull). */
  freeBytes?: number;
  requiredBytes: number;
  drive?: string;
  message?: string;
}

export type FreeSpaceFn = (dir: string) => number | undefined;

/** Free bytes on the volume containing `dir` (walks up to the nearest existing folder). */
export const defaultFreeSpace: FreeSpaceFn = (dir) => {
  let cur = dir;
  for (let i = 0; i < 12; i++) {
    try {
      if (fs.existsSync(cur)) {
        const s = fs.statfsSync(cur);
        return Number(s.bavail) * Number(s.bsize);
      }
    } catch {
      return undefined;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
};

export function checkDiskSpace(
  modelsDir: string,
  modelSizeBytes: number | undefined,
  freeSpace: FreeSpaceFn = defaultFreeSpace
): DiskCheck {
  const requiredBytes = (modelSizeBytes ?? 0) + DISK_HEADROOM_BYTES;
  if (!modelSizeBytes) return { ok: true, requiredBytes }; // unknown size: can't pre-check
  let free: number | undefined;
  try {
    free = freeSpace(modelsDir);
  } catch {
    free = undefined;
  }
  const drive = /^[A-Za-z]:/.test(modelsDir) ? modelsDir.slice(0, 2) : undefined;
  if (free === undefined) return { ok: true, requiredBytes, drive };
  if (free < requiredBytes) {
    return {
      ok: false,
      freeBytes: free,
      requiredBytes,
      drive,
      message: `Insufficient disk space: needs ${formatBytes(modelSizeBytes)} (plus 1.5 GB headroom), only ${formatBytes(free)} available${drive ? ` on ${drive}` : ""}.`,
    };
  }
  return { ok: true, freeBytes: free, requiredBytes, drive };
}

// ---------------------------------------------------------------------------
// Error classification (Phase 6 recovery messages)
// ---------------------------------------------------------------------------

export interface ClassifiedPullError {
  message: string;
  /** True when re-running the pull resumes from Ollama's layer cache. */
  resumable: boolean;
  kind: "disk_full" | "network" | "not_found" | "unreachable" | "other";
}

export function classifyPullError(err: unknown, drive?: string): ClassifiedPullError {
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  if (/no space left|disk full|not enough space|ENOSPC/i.test(raw) || code === "ENOSPC") {
    return {
      kind: "disk_full",
      resumable: true,
      message: `Disk full: free up at least 3 GB${drive ? ` on drive ${drive}` : ""} to finish, then click Resume.`,
    };
  }
  if (/manifest.*not found|file does not exist|pull model manifest|404/i.test(raw)) {
    return { kind: "not_found", resumable: false, message: `Model not found in the Ollama library. Check the name and try again.` };
  }
  if (
    /ECONNREFUSED/i.test(raw) ||
    code === "ECONNREFUSED" ||
    (/fetch failed/i.test(raw) && code === "ECONNREFUSED")
  ) {
    return { kind: "unreachable", resumable: false, message: "Ollama isn't running. Start it first, then retry." };
  }
  if (
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|fetch failed|terminated|network|timeout|socket|stream|EOF|aborted/i.test(raw) ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "UND_ERR_SOCKET"].includes(code ?? "")
  ) {
    return {
      kind: "network",
      resumable: true,
      message: "Download interrupted — click Resume. Already-downloaded layers are kept.",
    };
  }
  return { kind: "other", resumable: false, message: raw };
}

// ---------------------------------------------------------------------------
// 4.3 Installer with abort + single-flight lock
// ---------------------------------------------------------------------------

export type PullFn = (
  model: string,
  onChunk: (c: PullChunk) => void,
  signal: AbortSignal
) => Promise<void>;

export type InstallOutcome =
  | { status: "done"; model: string }
  | { status: "cancelled"; model: string }
  | { status: "blocked"; model: string; message: string }
  | { status: "error"; model: string; message: string; resumable: boolean };

export interface InstallerDeps {
  pull: PullFn;
  freeSpace?: FreeSpaceFn;
  modelsDir?: string;
  now?: () => number;
  /** Throttle for progress callbacks. */
  minProgressIntervalMs?: number;
}

export class ModelInstaller {
  private active: { model: string; controller: AbortController } | null = null;

  constructor(private readonly deps: InstallerDeps) {}

  get activeModel(): string | undefined {
    return this.active?.model;
  }

  /** Abort the in-flight pull, if any. Safe to call at any time. */
  cancel(): boolean {
    if (!this.active) return false;
    this.active.controller.abort();
    return true;
  }

  async install(
    model: string,
    opts: { estimatedSizeBytes?: number; onProgress: (p: PullProgress) => void }
  ): Promise<InstallOutcome> {
    if (this.active) {
      return {
        status: "blocked",
        model,
        message:
          this.active.model === model
            ? `${model} is already downloading.`
            : `Another download (${this.active.model}) is in progress. Cancel it first.`,
      };
    }

    const modelsDir = this.deps.modelsDir ?? ollamaModelsDir();
    const disk = checkDiskSpace(modelsDir, opts.estimatedSizeBytes, this.deps.freeSpace);
    if (!disk.ok) return { status: "blocked", model, message: disk.message! };

    const controller = new AbortController();
    this.active = { model, controller }; // lock acquired
    const now = this.deps.now ?? Date.now;
    const tracker = new PullTracker(model, now, 1000, opts.estimatedSizeBytes);
    const minInterval = this.deps.minProgressIntervalMs ?? 100;
    let lastEmit = 0;
    const safeEmit = (p: PullProgress) => {
      try {
        opts.onProgress(p);
      } catch {
        /* a broken listener must never abort the download */
      }
    };

    try {
      safeEmit({ ...tracker.snapshot(), status: "Pulling manifest", stage: "Pulling manifest", percent: 0 });
      await this.deps.pull(
        model,
        (chunk) => {
          const p = tracker.push(chunk);
          const t = now();
          if (t - lastEmit >= minInterval || !/downloading/i.test(p.stage ?? "")) {
            lastEmit = t;
            safeEmit(p);
          }
        },
        controller.signal
      );
      if (controller.signal.aborted) return { status: "cancelled", model };
      return { status: "done", model };
    } catch (e) {
      if (controller.signal.aborted) return { status: "cancelled", model };
      const c = classifyPullError(e, disk.drive);
      return { status: "error", model, message: c.message, resumable: c.resumable };
    } finally {
      this.active = null; // lock always released
    }
  }
}

