import * as fs from "node:fs/promises";
import * as path from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "out", ".venv", "__pycache__", ".next", "build",
  ".turbo", "coverage", ".cache",
]);

/**
 * Build a compact, indented file tree of the workspace, breadth-first and
 * capped, so a small model gets a navigable map of the project without
 * spending its whole context on it.
 */
export async function buildWorkspaceMap(
  root: string | undefined,
  maxEntries = 120
): Promise<string | undefined> {
  if (!root) return undefined;

  interface Node {
    abs: string;
    rel: string;
    depth: number;
  }

  const lines: string[] = [];
  const queue: Node[] = [{ abs: root, rel: "", depth: 0 }];
  let count = 0;
  let truncated = false;

  while (queue.length && count < maxEntries) {
    const node = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(node.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
    );

    for (const e of entries) {
      if (count >= maxEntries) {
        truncated = true;
        break;
      }
      if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
      if (e.name.startsWith(".") && e.isFile()) continue; // skip dotfiles

      const rel = node.rel ? `${node.rel}/${e.name}` : e.name;
      const indent = "  ".repeat(node.depth);
      lines.push(`${indent}${e.name}${e.isDirectory() ? "/" : ""}`);
      count++;

      // Only descend two levels deep to keep the map shallow and cheap.
      if (e.isDirectory() && node.depth < 2) {
        queue.push({ abs: path.join(node.abs, e.name), rel, depth: node.depth + 1 });
      }
    }
  }

  if (queue.length || truncated) lines.push("  … (more files not shown; use find_files/search_code)");
  return lines.join("\n");
}
