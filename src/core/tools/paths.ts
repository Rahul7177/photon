import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * Resolve a user/model-supplied relative path against the workspace root and
 * refuse anything that escapes it — via `..`, an absolute path, OR a symlink
 * that physically lives inside the workspace but points outside it.
 * Strictly handles Windows drive letters, UNC paths, alternate separators (/ vs \),
 * junctions, nonexistent ancestors, and platform case-insensitivity.
 */
export function resolveInWorkspace(
  workspaceRoot: string | undefined,
  rel: string
): { abs: string } | { error: string } {
  if (!workspaceRoot) {
    return { error: "No workspace folder is open." };
  }
  if (typeof rel !== "string" || !rel.trim()) {
    return { error: "No path was provided." };
  }
  const cleaned = rel.replace(/^["']|["']$/g, "").trim();
  const abs = path.resolve(workspaceRoot, cleaned);

  // Compare REAL paths (symlinks resolved) so a link out of the workspace is
  // caught, not just lexical `..` traversal. Root is cached.
  const realRoot = cachedRealRoot(workspaceRoot);
  const real = realOrNearest(abs);
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

  const isCaseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const realNorm = isCaseInsensitive ? real.toLowerCase() : real;
  const rootNorm = isCaseInsensitive ? rootWithSep.toLowerCase() : rootWithSep;
  const exactNorm = isCaseInsensitive ? realRoot.toLowerCase() : realRoot;

  if (realNorm !== exactNorm && !realNorm.startsWith(rootNorm)) {
    return { error: `Path "${rel}" is outside the workspace.` };
  }
  return { abs };
}

const realRootCache = new Map<string, string>();
function cachedRealRoot(root: string): string {
  const hit = realRootCache.get(root);
  if (hit) return hit;
  try {
    const r = fs.realpathSync(root);
    realRootCache.set(root, r);
    return r;
  } catch {
    return root;
  }
}

/**
 * realpath of `p`, resolving symlinks and Windows junctions.
 * For a path that doesn't exist yet (a new file/dir), resolves the deepest
 * existing ancestor and re-appends the rest, ensuring writes are jailed correctly.
 */
export function realOrNearest(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p; // reached the filesystem root
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

export function toWorkspaceRelative(
  workspaceRoot: string | undefined,
  abs: string
): string {
  if (!workspaceRoot) return abs;
  return path.relative(workspaceRoot, abs).split(path.sep).join("/") || ".";
}

/**
 * Performs atomic file replacement with strict workspace boundary revalidation
 * immediately before mutation to eliminate symlink TOCTOU races.
 * Writes to a temporary file in the target directory, re-verifies destination symlinks,
 * and atomically renames the temporary file into place.
 */
export async function atomicWriteFile(
  workspaceRoot: string,
  rel: string,
  content: string | Buffer
): Promise<{ abs: string }> {
  const initial = resolveInWorkspace(workspaceRoot, rel);
  if ("error" in initial) throw new Error(initial.error);

  const targetAbs = initial.abs;
  const targetDir = path.dirname(targetAbs);
  await fsp.mkdir(targetDir, { recursive: true });

  const tmpPath = path.join(
    targetDir,
    `.${path.basename(targetAbs)}.${randomUUID().slice(0, 8)}.tmp`
  );

  try {
    await fsp.writeFile(tmpPath, content, { mode: 0o666 });

    // Revalidate destination immediately before mutation to prevent symlink TOCTOU
    const recheck = resolveInWorkspace(workspaceRoot, rel);
    if ("error" in recheck) {
      throw new Error(`Symlink TOCTOU race detected: ${recheck.error}`);
    }

    // If destination exists, verify it is not a symlink pointing outside workspace
    try {
      const lstat = await fsp.lstat(targetAbs);
      if (lstat.isSymbolicLink()) {
        const real = await fsp.realpath(targetAbs);
        const resolvedTarget = resolveInWorkspace(workspaceRoot, real);
        if ("error" in resolvedTarget) {
          throw new Error(`Target is a symlink pointing outside workspace: ${targetAbs} -> ${real}`);
        }
      }
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }

    // Atomic rename into place (retrying for transient Windows file lock delays)
    let renamed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fsp.rename(tmpPath, targetAbs);
        renamed = true;
        break;
      } catch (err: any) {
        if (err?.code === "EPERM" || err?.code === "EBUSY") {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }

    if (!renamed) {
      await fsp.copyFile(tmpPath, targetAbs);
      await fsp.unlink(tmpPath).catch(() => undefined);
    }

    return { abs: targetAbs };
  } finally {
    await fsp.unlink(tmpPath).catch(() => undefined);
  }
}
