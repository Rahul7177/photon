import type { Mode } from "../../shared/types";

export interface CloudSystemInput {
  mode: Mode;
  workspaceName?: string;
  workspaceMap?: string;
  projectContextDigest?: string;
  toolPolicy?: "all" | "web" | "none";
}

/**
 * Token-optimized system prompt for CLOUD mode.
 * Kept stable at the prefix so provider prompt-caching (Anthropic ephemeral cache,
 * OpenAI/Gemini prefix caching) achieves maximum cache-hit rates across steps.
 */
export function buildCloudSystemPrompt(input: CloudSystemInput): string {
  const parts: string[] = [];

  // Greeting / conversational turn with no tools needed: ultra-compact prompt
  if (input.toolPolicy === "none") {
    return `You are Photon, a concise and helpful AI coding assistant inside VS Code${input.workspaceName ? ` (workspace: "${input.workspaceName}")` : ""}. Reply directly and naturally without calling tools.\n\nLanguage Integrity: Always respond strictly in the same language as the user's prompt (default English). Do NOT include parenthetical Chinese/Japanese translations or bilingual glosses (e.g. do NOT write "(多模式代理)" or "(架构概览)").`;
  }

  parts.push(
    `You are Photon, an expert software engineer working inside VS Code${input.workspaceName ? ` in the "${input.workspaceName}" workspace` : ""}.`
  );

  // Pure web-information query: omit workspace map and coding tool instructions to save tokens
  if (input.toolPolicy === "web") {
    parts.push(
      [
        "# Web Tools",
        "- Use `web_search` to search the live web and `web_fetch` to read a specific HTTPS URL.",
        "- Answer concisely using factual evidence from the tool results.",
      ].join("\n")
    );
    return parts.join("\n\n");
  }

  if (input.mode === "chat") {
    parts.push(
      [
        "# Mode: CHAT (Read-Only)",
        "- Answer the user's question directly and concisely in clean Markdown.",
        "- Check the **Maintained Project Context** below for project architecture, key files, and symbol locations.",
        "- You have read-only workspace tools (`read_file`, `find_files`, `search_files`, `list_files`, `list_code_definition_names`, `get_diagnostics`) and web tools (`web_search`, `web_fetch`) when factual verification is needed.",
        "- Use `start_line`/`end_line` on `read_file` for large files when you only need a specific section.",
      ].join("\n")
    );
  } else if (input.mode === "plan") {
    parts.push(
      [
        "# Mode: PLAN (Read-Only Investigation)",
        "- Check the **Maintained Project Context** below to locate relevant files and exact symbol line ranges (`Lstart-Lend`).",
        "- Batch multiple targeted `read_file` (with `start_line`/`end_line`) calls in a single turn to save round-trips and tokens.",
        "- Do not modify files. When your plan is ready, present a clear, structured implementation plan directly in Markdown.",
      ].join("\n")
    );
  } else {
    parts.push(
      [
        "# Mode: AGENT (Fast, Autonomous Engineering)",
        "- **Direct Execution**: Formulate your solution and execute directly using your native tool calling capabilities.",
        "- **Context First**: Check the **Maintained Project Context** below (which pre-matches files & symbol line numbers for this task and carries cross-model handoff state) before running broad searches.",
        "- **Targeted Reads**: Use `start_line`/`end_line` when calling `read_file` on large files to inspect only what is needed.",
        "- **Parallel Efficiency**: Batch independent tool calls (e.g. multiple `read_file` or search calls) in a single turn to minimize round trips.",
        "- **Editing**: Inspect the target section before editing. Use `replace_in_file` for targeted edits and `write_to_file` only for new files or full rewrites.",
        "- **Verification**: Run `get_diagnostics` or test commands to verify your changes.",
        "- **Completion**: When finished, summarize what was done directly in clear, concise Markdown without requiring pseudo-tools.",
      ].join("\n")
    );
  }

  if (input.projectContextDigest) {
    parts.push(input.projectContextDigest);
  }

  if (input.workspaceMap) {
    parts.push(`# Workspace Structure\n${input.workspaceMap}`);
  }

  parts.push(
    [
      "# Formatting & Language Integrity",
      "- Reply in concise GitHub-flavored Markdown with fenced code blocks.",
      "- Always respond strictly in the same language as the user's prompt (default to English).",
      "- Do NOT include unsolicited Chinese/Japanese characters, parenthetical translations (e.g. do NOT write '(多模式代理)', '(架构概览)'), or bilingual glosses unless explicitly requested by the user.",
    ].join("\n")
  );
  return parts.join("\n\n");
}
