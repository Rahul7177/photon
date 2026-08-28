import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Resolve a user/model-supplied relative path against the workspace root and
 * refuse anything that escapes it — via `..`, an absolute path, OR a symlink
 * that physically lives inside the workspace but points outside it. Small
 * models frequently emit odd paths; this keeps a stray `../../etc/passwd` (or a
 * sneaky symlink) from being read or written.
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
  // caught, not just lexical `..` traversal. Root is cached (audit: sync block).
  const realRoot = cachedRealRoot(workspaceRoot);
  const real = realOrNearest(abs);
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (real !== realRoot && !real.startsWith(rootWithSep)) {
    return { error: `Path "${rel}" is outside the workspace.` };
  }
  return { abs };
}

const realRootCache = new Map<string, string>();
function cachedRealRoot(root: string): string {
  const hit = realRootCache.get(root);
  if (hit) return hit;
  try { const r = fs.realpathSync(root); realRootCache.set(root, r); return r; } catch { return root; }
}

/**
 * realpath of `p`, resolving symlinks. For a path that doesn't exist yet (a new
 * file/dir), resolve the deepest existing ancestor and re-append the rest, so
 * writes are still jailed correctly.
 */
function realOrNearest(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) { // 4096 was DoS surface; 64 suffices for any real path
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p; // reached the fs root; nothing resolvable
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
