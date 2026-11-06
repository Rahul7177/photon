import { getProjectContextManager } from "../../context/projectContext";
import type { ProjectMemoryNote } from "../../../shared/types";
import { ok, toolError, type Tool } from "../types";

export const queryProjectContextTool: Tool = {
  spec: {
    name: "query_project_context",
    summary:
      "Search Photon's maintained Project Context (indexed files, exported classes/functions with exact line ranges, project architecture, recent edits, and cross-model memory) in a single low-token call. Use this FIRST before reading or searching multiple workspace files.",
    params: [
      {
        name: "query",
        type: "string",
        required: false,
        description:
          "Keywords, symbol/function/class name, file name, or concept to search (e.g. 'PhotonController', 'context window', 'auth'). Omit to get the overall project architecture and active working context.",
      },
      {
        name: "scope",
        type: "string",
        required: false,
        enum: ["all", "symbols", "files", "architecture", "changes", "memory"],
        description:
          "Optional filter: 'all' (default), 'symbols' (functions/classes + exact line numbers), 'files' (file summaries), 'architecture' (stack, scripts, folders), 'changes' (recent edits & handoff), or 'memory' (pinned notes).",
      },
    ],
    sideEffecting: false,
    priority: 0,
    minTier: "low",
    tags: ["context", "search", "read"],
    example:
      "```tool\nTOOL_NAME: query_project_context\nBEGIN_ARG: query\nContextMeter\nEND_ARG\nBEGIN_ARG: scope\nall\nEND_ARG\n```",
  },
  async execute(args, ctx) {
    if (!ctx.workspaceRoot) {
      return toolError("not_found", "No workspace folder is open.");
    }
    const mgr = getProjectContextManager(ctx.workspaceRoot);
    if (!mgr) {
      return toolError("execution_error", "Project context manager is unavailable.");
    }
    await mgr.ensureInitialized();
    const query = typeof args.query === "string" ? args.query : "";
    const rawScope = typeof args.scope === "string" ? args.scope : "all";
    const validScopes = new Set(["all", "symbols", "files", "architecture", "changes", "memory"]);
    const scope = (validScopes.has(rawScope) ? rawScope : "all") as
      | "all"
      | "symbols"
      | "files"
      | "architecture"
      | "changes"
      | "memory";

    const result = mgr.query({ query, scope });
    return ok(result);
  },
};

export const updateProjectContextTool: Tool = {
  spec: {
    name: "update_project_context",
    summary:
      "Persist an architectural insight, coding convention, design decision, or task handoff note into Photon's shared Project Context so future turns and other models immediately know it without re-reading the codebase.",
    params: [
      {
        name: "category",
        type: "string",
        required: true,
        enum: ["architecture", "convention", "decision", "task", "gotcha"],
        description: "Category of the project knowledge note.",
      },
      {
        name: "title",
        type: "string",
        required: true,
        description: "Short, clear title for the note (e.g. 'State Management Pattern').",
      },
      {
        name: "content",
        type: "string",
        required: true,
        description: "Concise details, key file paths, and findings to persist.",
      },
      {
        name: "related_files",
        type: "string",
        required: false,
        description: "Optional comma-separated list of workspace-relative file paths.",
      },
    ],
    sideEffecting: false,
    priority: 2,
    minTier: "low",
    tags: ["context", "memory"],
    example:
      "```tool\nTOOL_NAME: update_project_context\nBEGIN_ARG: category\narchitecture\nEND_ARG\nBEGIN_ARG: title\nMessage Turn Grouping\nEND_ARG\nBEGIN_ARG: content\nConsecutive assistant messages are grouped in MessageList.tsx into AssistantTurn and TurnProcess.\nEND_ARG\n```",
  },
  async execute(args, ctx) {
    if (!ctx.workspaceRoot) {
      return toolError("not_found", "No workspace folder is open.");
    }
    const mgr = getProjectContextManager(ctx.workspaceRoot);
    if (!mgr) {
      return toolError("execution_error", "Project context manager is unavailable.");
    }
    await mgr.ensureInitialized();

    const title = String(args.title ?? "").trim();
    const content = String(args.content ?? "").trim();
    if (!title || !content) {
      return toolError("invalid_args", 'Both "title" and "content" are required.');
    }

    const validCategories = new Set(["architecture", "convention", "decision", "task", "gotcha"]);
    const rawCat = String(args.category ?? "architecture").toLowerCase();
    const category = (validCategories.has(rawCat) ? rawCat : "architecture") as ProjectMemoryNote["category"];

    const relatedFiles =
      typeof args.related_files === "string" && args.related_files.trim()
        ? args.related_files
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

    const saved = mgr.addNote({
      category,
      title,
      content,
      relatedFiles,
      createdBy: "agent",
    });

    return ok(
      `Saved to Project Context [${saved.category.toUpperCase()}]: "${saved.title}" — available to all models and sessions in this workspace.`
    );
  },
};

