import type { Tool } from "../types";
import {
  editFileTool,
  listDirTool,
  movePathTool,
  readFileTool,
  writeFileTool,
} from "./files";
import { codeOutlineTool, findFilesTool, searchCodeTool } from "./search";
import { runCommandTool } from "./terminal";
import { webFetchTool, webSearchTool } from "./web";
import { getDiagnosticsTool } from "./verify";
import { thinkTool, todoWriteTool } from "./plan";

/**
 * All built-in tools, ordered by priority (lower = kept for weak models).
 *
 * The set is deliberately dual-mode: the first ~7 entries form a complete,
 * forgiving core (read → edit → write → locate → verify) that fits inside a
 * tiny model's tool budget, while the rest unlock progressively for capable
 * models — whose larger context windows and better instruction-following let
 * them exploit shell access, web tools, and planning aids without derailing.
 */
export function builtinTools(): Tool[] {
  return [
    readFileTool,        // 1 — ground truth for every other action
    editFileTool,        // 2 — surgical change
    writeFileTool,       // 3 — create / full rewrite
    findFilesTool,       // 4 — locate by name/glob
    listDirTool,         // 5 — explore structure
    searchCodeTool,      // 6 — locate by content (grep)
    getDiagnosticsTool,  // 7 — verify edits against the editor
    runCommandTool,      // 8 — build/test/execute
    movePathTool,        // 9 — rename/move refactors
    codeOutlineTool,     // 10 — navigate big files cheaply
    todoWriteTool,       // 11 — stable multi-step plan
    thinkTool,           // 12 — private reasoning scratchpad
    webSearchTool,       // 13 — external knowledge
    webFetchTool,        // 14 — read docs/raw files
  ];
}
