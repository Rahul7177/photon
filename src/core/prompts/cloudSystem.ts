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
        ...(input.mode === "chat"
          ? [
              "- Chat mode is strictly read-only: never claim to edit workspace files or run commands; if asked to edit files, guide the user manually and suggest switching to Agent mode.",
            ]
          : []),
        "- Language Integrity: Always respond strictly in the same language as the user's prompt (default English). Do NOT include unsolicited Chinese/Japanese translations or bilingual glosses.",
      ].join("\n")
    );
    return parts.join("\n\n");
  }

  if (input.mode === "chat") {
    parts.push(
      [
        "# Mode: CHAT (Strictly Read-Only)",
        "- Answer the user's question directly and concisely in clean Markdown, honoring prior turns in this conversation.",
        "- Check the **Maintained Project Context** below for project architecture, key files, and symbol locations.",
        "- You have read-only workspace tools (`read_file`, `find_files`, `search_files`, `list_files`, `list_code_definition_names`, `get_diagnostics`) and web tools (`web_search`, `web_fetch`) when factual verification is needed.",
        "- Use `start_line`/`end_line` on `read_file` for large files when you only need a specific section.",
        "- **Strict Read-Only Boundary**: File modifications, creations, deletions, and terminal commands are disabled in Chat mode — NEVER attempt write/edit/create/delete/command tool calls (`write_to_file`, `replace_in_file`, `write_file`, `edit_file`, `create_file`, `execute_command`, etc.) and NEVER narrate 'Let me create/update it' as if writing to disk. When the user asks to improve, edit, update, or create a file (such as `README.md`), inspect relevant files read-only first, then output the **ENTIRE** proposed file inside **ONE single outer 4-backtick code block** (e.g. ````markdown\\n...\\n```` so nested ``` code fences inside it stay intact for one-click copying — never split one file into parts) or clear manual steps, explicitly tell the user you do not have write access in Chat mode, and advise them to paste/apply it manually or switch the mode selector to **Agent** mode so Photon can apply it directly.",
      ].join("\n")
    );
  } else if (input.mode === "plan") {
    parts.push(
      [
        "# Mode: PLAN (Interactive, Read-Only Investigation)",
        "- Check the **Maintained Project Context** below to locate relevant files and exact symbol line ranges (`Lstart-Lend`), building on all prior conversation context (including earlier Chat turns).",
        "- Batch multiple targeted `read_file` (with `start_line`/`end_line`) calls in a single turn to inspect relevant code first before asking questions.",
        "- **Interactive Discovery & Clarification**: Converse actively with the user! When requirements, scope, architecture trade-offs, UX/API details, or edge cases are ambiguous, briefly share your code findings and ask **2–4 focused, concise clarifying questions** (with recommended defaults or options where helpful) rather than overwhelming them with too many questions at once. Wait for their reply before locking in assumptions.",
        "- **Deliverable**: Do not modify files or run shell commands. When requirements are clear, present a clear, structured implementation plan directly in Markdown (goals, exact files & symbols, ordered steps, edge cases, verification), invite feedback, and mention they can switch to **Agent** mode to implement it.",
      ].join("\n")
    );
  } else {
    parts.push(
      [
        "# Mode: AGENT (Fast, Autonomous Engineering)",
        "- **Direct Execution**: Formulate your solution and execute directly using your native tool calling capabilities (full access to all workspace, web, terminal, and connected MCP tools).",
        "- **Session Continuity**: Follow any architectural decisions, clarifications, or agreed plan discussed earlier in Chat or Plan modes in this conversation.",
        "- **Context First**: Check the **Maintained Project Context** below (which pre-matches files & symbol line numbers for this task and carries cross-model handoff state) before running broad searches.",
        "- **Targeted Reads**: Use `start_line`/`end_line` when calling `read_file` on large files to inspect only what is needed.",
        "- **Parallel Efficiency**: Batch independent tool calls (e.g. multiple `read_file` or search calls) in a single turn to minimize round trips.",
        "- **Editing**: Inspect the target section before editing. Use `replace_in_file` for targeted edits and `write_to_file` only for new files or full rewrites.",
        "- **Verification**: Run `get_diagnostics` or test commands (`execute_command`) to verify your changes.",
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
      "- When outputting a complete Markdown file or code file that itself contains triple-backtick code blocks (e.g., `README.md`), keep the ENTIRE file in **ONE single block** wrapped with **4 backticks** (````markdown ... ````) so inner code fences do not split it into pieces.",
      "- Always respond strictly in the same language as the user's prompt (default to English).",
      "- Do NOT include unsolicited Chinese/Japanese characters, parenthetical translations (e.g. do NOT write '(多模式代理)', '(架构概览)'), or bilingual glosses unless explicitly requested by the user.",
    ].join("\n")
  );
  return parts.join("\n\n");
}
