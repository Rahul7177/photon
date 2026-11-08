import { randomUUID } from "node:crypto";
import type { ChatMessage, Role } from "../../shared/types";
import type { LLMMessage, LLMProvider } from "../llm/types";
import {
  estimateTokens,
  estimateMessagesTokens,
} from "../adaptive/tokens";
import { redactSecretsFromError } from "./errorRecovery";

export interface CompactionCandidateSet {
  anchor: ChatMessage | null;
  toCompact: ChatMessage[];
  recent: ChatMessage[];
  canCompact: boolean;
}

export interface CompactionRetainedItems {
  anchorPreserved: boolean;
  taskPreserved: boolean;
  userDirectivesCount: number;
  constraintsCount: number;
  modifiedFiles: string[];
  modifiedFilesCount: number;
  inspectedFiles: string[];
  inspectedFilesCount: number;
  commandsCount: number;
  unresolvedCount: number;
  recentMessagesKept: number;
}

export interface CompactionResult {
  compacted: boolean;
  reason?: "not_needed" | "too_few_messages" | "already_compacted" | "threshold_met" | "manual";
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  pctSaved: number;
  strategy: "provider-model" | "native-heuristic";
  summary?: string;
  compactionNotice?: string;
  retained?: CompactionRetainedItems;
  newMessages: ChatMessage[];
}

export interface CompactionOptions {
  messages: ChatMessage[];
  contextWindow: number;
  model?: string;
  provider?: LLMProvider;
  force?: boolean;
  focus?: string;
  threshold?: number;
  recentTurnsToKeep?: number;
  keepRecentUserTurns?: number;
}

export type StructuredCompactionData = ReturnType<typeof extractStructuredCompactionData>;

/** Default context fill ratio to trigger auto-compaction (75% like Copilot / Claude Code) */
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.75;

/** Minimum messages in conversation required before compaction is meaningful */
export const MIN_MESSAGES_FOR_COMPACTION = 4;

/**
 * Checks whether a message is a synthetic tool-result wrapper rather than a genuine user prompt.
 */
export function isToolResultMessage(m: ChatMessage): boolean {
  if (m.role === "tool") return true;
  const trimmed = (m.content || "").trim();
  return (
    trimmed.startsWith("[tool:") ||
    trimmed.startsWith("[TOOL_RESULT") ||
    trimmed.startsWith("<photon:result") ||
    trimmed.startsWith("<tool_result") ||
    Boolean((m as any).toolCallId)
  );
}

/**
 * Determine if the conversation context is full enough to trigger automatic compaction.
 * Mirrors Claude Code and GitHub Copilot threshold heuristics:
 * triggers when current conversation tokens >= threshold (default 75%) of active model's context window.
 */
export function shouldAutoCompact(
  messages: ChatMessage[],
  contextWindow: number,
  model?: string,
  threshold = DEFAULT_AUTO_COMPACT_THRESHOLD
): boolean {
  if (!messages || messages.length < MIN_MESSAGES_FOR_COMPACTION) return false;
  if (!contextWindow || contextWindow <= 0) return false;

  const currentTokens = estimateMessagesTokens(messages, model);
  const ratio = currentTokens / contextWindow;
  return ratio >= threshold;
}

/**
 * Partitions conversation messages into:
 * 1. Anchor: First genuine user prompt establishing the overall task/intent.
 * 2. ToCompact: Middle messages to be folded into a structured summary.
 * 3. Recent: Latest turns kept verbatim, strictly preserving tool-call/tool-result pairing.
 */
export function extractCompactionCandidates(
  messages: ChatMessage[],
  recentTurnsToKeep?: number
): CompactionCandidateSet {
  if (!messages || messages.length < MIN_MESSAGES_FOR_COMPACTION) {
    return { anchor: null, toCompact: [], recent: messages || [], canCompact: false };
  }

  // 1. Locate anchor (first genuine user message)
  const firstUserIdx = messages.findIndex((m) => m.role === "user" && !isToolResultMessage(m));
  const anchor = firstUserIdx >= 0 ? messages[firstUserIdx] : null;
  const minCompactIdx = firstUserIdx >= 0 ? firstUserIdx + 1 : 0;

  // Decide how many recent genuine user turns to preserve:
  const effectiveRecentTurns = recentTurnsToKeep ?? (messages.length <= 8 ? 1 : 2);

  // 2. Count backwards across genuine user turns (never splitting a tool-result from its assistant tool-call)
  let userTurnsSeen = 0;
  let recentStartIdx = messages.length;

  for (let i = messages.length - 1; i >= minCompactIdx; i--) {
    const m = messages[i];
    if (m.role === "user" && !isToolResultMessage(m) && !m.isCompacted) {
      userTurnsSeen++;
      if (userTurnsSeen === effectiveRecentTurns) {
        recentStartIdx = i;
        break;
      }
    }
  }

  // Fallback if not enough genuine user turns found after anchor
  if (recentStartIdx >= messages.length || recentStartIdx <= minCompactIdx) {
    recentStartIdx = Math.max(minCompactIdx, messages.length - 2);
  }

  // 3. Enforce strict tool-call / tool-result pairing:
  // Never start `recent` on a tool-result message or leave an assistant tool-call in `toCompact`
  // whose result is in `recent`. Walk `recentStartIdx` backwards until clean boundary.
  while (recentStartIdx > minCompactIdx) {
    const firstRecent = messages[recentStartIdx];
    const prevMsg = messages[recentStartIdx - 1];
    const firstIsToolResult = firstRecent && isToolResultMessage(firstRecent);
    const prevHasToolCalls =
      prevMsg && prevMsg.role === "assistant" && (prevMsg.toolCalls?.length ?? 0) > 0;

    if (firstIsToolResult || (prevHasToolCalls && firstRecent?.role !== "user")) {
      recentStartIdx--;
    } else if (prevHasToolCalls && firstRecent && isToolResultMessage(firstRecent)) {
      recentStartIdx--;
    } else {
      break;
    }
  }

  const toCompact = messages.slice(minCompactIdx, recentStartIdx);
  const recent = messages.slice(recentStartIdx);

  const canCompact = toCompact.length >= 1;

  return {
    anchor,
    toCompact,
    recent,
    canCompact,
  };
}

export type CompactionCommandStatus =
  | "completed"
  | "failed"
  | "not_executed"
  | "awaiting_approval"
  | "in_progress"
  | "denied"
  | "unknown";

export function mapToolStatusToCompactionStatus(
  status: string | undefined
): CompactionCommandStatus {
  switch (status) {
    case "done":
      return "completed";
    case "error":
      return "failed";
    case "proposed":
      return "not_executed";
    case "pending":
      return "awaiting_approval";
    case "running":
      return "in_progress";
    case "denied":
      return "denied";
    default:
      return "unknown";
  }
}

/**
 * Extracts structured metadata from messages being compacted so we can both
 * build the native summary and verify that provider summaries retain all critical facts.
 */
export function extractStructuredCompactionData(messages: ChatMessage[]) {
  const userDirectives: string[] = [];
  const userConstraints: string[] = [];
  const filesModified = new Map<string, string[]>();
  const filesInspected = new Set<string>();
  const toolFindings: string[] = [];
  const negativeFindings: string[] = [];
  const commandsRun: Array<{
    command: string;
    status: CompactionCommandStatus;
    rawStatus?: string;
    error?: string;
  }> = [];
  const modelDecisions: string[] = [];
  const unresolvedItems: string[] = [];
  const existingSummarySections: string[] = [];

  for (const msg of messages) {
    if (
      msg.content.includes("[Context Compaction Summary]") ||
      msg.notice?.includes("Context compacted")
    ) {
      const cleanSummary = redactSecretsFromError(
        msg.content.replace(/^⚡\s*\*\*\[Context Compaction Summary\]\*\*\s*/i, "").trim()
      );
      if (cleanSummary && !existingSummarySections.includes(cleanSummary)) {
        existingSummarySections.push(cleanSummary);
      }
      continue;
    }

    if (msg.role === "user") {
      const clean = redactSecretsFromError(msg.content.trim());
      if (isToolResultMessage(msg)) {
        // Extract concise tool result facts
        const snippet = clean.replace(/\s+/g, " ").slice(0, 140);
        if (snippet && toolFindings.length < 8) {
          toolFindings.push(snippet);
        }
      } else if (!clean.startsWith("```json") && clean.length > 0) {
        const truncated = clean.length > 240 ? clean.slice(0, 237) + "…" : clean;
        if (!userDirectives.includes(truncated)) {
          userDirectives.push(truncated);
        }
        if (/\b(?:do not|never|must not|cannot|should not|dont|don't|preserve|keep|avoid|prevent)\b/i.test(clean)) {
          if (!userConstraints.includes(truncated)) {
            userConstraints.push(truncated);
          }
        }
      }
    }

    if (msg.role === "tool" && msg.content) {
      const cleanContent = redactSecretsFromError(msg.content.trim());
      const snippet = cleanContent.replace(/\s+/g, " ").slice(0, 140);
      if (snippet && toolFindings.length < 8) {
        toolFindings.push(snippet);
      }
    }

    for (const call of msg.toolCalls ?? []) {
      const name = call.name;
      const args = call.args || {};
      const metaPath = (call as any).metadata?.path;
      const filePath =
        metaPath ||
        String(args.path || args.file_path || args.filePath || args.file || (name === "move_path" ? args.from : ""));

      const isSuccess =
        call.status === "done" &&
        !call.error &&
        !(typeof call.result === "string" && call.result.includes("[TOOL_ERROR"));

      if (name === "move_path") {
        const fromPath = String(args.from || args.source || filePath);
        const toPath = String(args.to || args.destination || "");
        if (isSuccess && fromPath && toPath) {
          const fromNotes = filesModified.get(fromPath) ?? [];
          const fromDesc = `Moved to \`${toPath}\``;
          if (!fromNotes.includes(fromDesc)) fromNotes.push(fromDesc);
          filesModified.set(fromPath, fromNotes);

          const toNotes = filesModified.get(toPath) ?? [];
          const toDesc = `Created by moving from \`${fromPath}\``;
          if (!toNotes.includes(toDesc)) toNotes.push(toDesc);
          filesModified.set(toPath, toNotes);
        }
      } else if (
        name === "replace_in_file" ||
        name === "edit_file" ||
        name === "write_to_file" ||
        name === "write_file" ||
        name === "append_file" ||
        name === "delete_file"
      ) {
        if (filePath && isSuccess) {
          const notes = filesModified.get(filePath) ?? [];
          const linesInfo = (call as any).metadata?.changedLines
            ? ` (lines ${(call as any).metadata.changedLines.start}-${(call as any).metadata.changedLines.end})`
            : "";
          const editDesc =
            name === "delete_file"
              ? "Deleted file"
              : args.find || args.old_str
                ? `Edited block (${String(args.find || args.old_str).slice(0, 40).trim()}…)${linesInfo}`
                : name === "write_to_file" || name === "write_file"
                  ? `Created / overwritten file${linesInfo}`
                  : `Updated file contents${linesInfo}`;
          if (!notes.includes(editDesc)) notes.push(editDesc);
          filesModified.set(filePath, notes);
        }
      } else if (
        name === "read_file" ||
        name === "search_files" ||
        name === "search_code" ||
        name === "find_files" ||
        name === "list_dir" ||
        name === "code_outline"
      ) {
        if (filePath) filesInspected.add(filePath);
        if (args.pattern) filesInspected.add(`pattern: "${args.pattern}"`);
        if (args.query) filesInspected.add(`query: "${args.query}"`);
      } else if (
        name === "execute_command" ||
        name === "run_command" ||
        name === "bash" ||
        name === "terminal"
      ) {
        const cmd = redactSecretsFromError(String(args.command || args.cmd || ""));
        if (cmd) {
          const mappedStatus = mapToolStatusToCompactionStatus(call.status);
          commandsRun.push({
            command: cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd,
            status: mappedStatus,
            rawStatus: call.status,
            error: call.error ? redactSecretsFromError(String(call.error).slice(0, 80)) : undefined,
          });
        }
      }

      // Negative findings (file not found, 0 results)
      if (call.name === "read_file" && call.error && /ENOENT|not found/i.test(call.error)) {
        const nf = `File not found: \`${filePath}\``;
        if (!negativeFindings.includes(nf)) negativeFindings.push(nf);
      } else if (
        (call.name === "find_files" || call.name === "search_code") &&
        call.result &&
        /no matches|0 results|not found/i.test(call.result)
      ) {
        const nf = `Search for "${args.pattern || args.query}" yielded 0 matches`;
        if (!negativeFindings.includes(nf)) negativeFindings.push(nf);
      }

      const isToolError =
        call.status === "error" ||
        (typeof call.result === "string" && call.result.includes("[TOOL_ERROR"));

      if (isToolError && (call.error || call.result)) {
        const errDetail = call.error ? String(call.error) : String(call.result);
        const errNote = `Tool ${name}${filePath ? ` (${filePath})` : ""} failed: ${redactSecretsFromError(errDetail.slice(0, 120))}`;
        if (!unresolvedItems.includes(errNote)) unresolvedItems.push(errNote);
      } else if (
        call.status === "running" ||
        (call.status as string) === "pending" ||
        call.status === "proposed"
      ) {
        const rawStatus = call.status as string;
        const statusText =
          rawStatus === "running"
            ? "in progress"
            : rawStatus === "pending"
              ? "awaiting approval"
              : "not executed";
        const pendingNote = `Tool ${name}${filePath ? ` (${filePath})` : ""} was left ${statusText}`;
        if (!unresolvedItems.includes(pendingNote)) unresolvedItems.push(pendingNote);
      } else if (call.status === "denied") {
        const deniedNote = `Tool ${name}${filePath ? ` (${filePath})` : ""} was denied by user`;
        if (!unresolvedItems.includes(deniedNote)) unresolvedItems.push(deniedNote);
      } else if ((call.status as string) === "unknown" || !call.status) {
        const unknownNote = `Tool ${name}${filePath ? ` (${filePath})` : ""} status was unknown`;
        if (!unresolvedItems.includes(unknownNote)) unresolvedItems.push(unknownNote);
      } else if (call.result && typeof call.result === "string" && toolFindings.length < 8) {
        const firstLine = redactSecretsFromError(call.result.trim().split(/\r?\n/)[0]?.slice(0, 120));
        if (firstLine) {
          toolFindings.push(`${name}${filePath ? `(${filePath})` : ""}: ${firstLine}`);
        }
      }
    }

    if (msg.role === "assistant" && msg.content) {
      const lines = msg.content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          /^(?:[-*]|\d+\.)\s+(?:Fixed|Implemented|Configured|Added|Updated|Verified|Resolved|Adopted|Selected|Refactored|Created|Decided|Assumed)/i.test(
            trimmed
          ) ||
          /^(?:Decision|Architecture|Key finding|Root cause|Assumption|Constraint):/i.test(trimmed) ||
          /\b(?:decided to|assumed|chosen because|for backward compatibility)\b/i.test(trimmed)
        ) {
          const clean = redactSecretsFromError(trimmed.replace(/^(?:[-*]|\d+\.)\s+/, ""));
          if (clean.length > 10 && !modelDecisions.includes(clean)) {
            modelDecisions.push(clean.length > 150 ? clean.slice(0, 147) + "…" : clean);
          }
        }
        // Unresolved todos or open questions
        if (
          /^[-*]\s+\[\s\]\s+/.test(trimmed) ||
          /^(?:TODO|Remaining|Unresolved|Open question|Next step):/i.test(trimmed)
        ) {
          const clean = redactSecretsFromError(trimmed.replace(/^[-*]\s+\[\s\]\s+/, ""));
          if (clean.length > 5 && !unresolvedItems.includes(clean)) {
            unresolvedItems.push(clean.length > 140 ? clean.slice(0, 137) + "…" : clean);
          }
        }
      }
    }

    if (msg.notice && (msg.notice.startsWith("⚠️") || /error|failed/i.test(msg.notice))) {
      const errStr = redactSecretsFromError(msg.notice.slice(0, 120));
      if (!unresolvedItems.includes(errStr)) {
        unresolvedItems.push(errStr);
      }
    }
  }

  const retainedItems: CompactionRetainedItems = {
    anchorPreserved: true,
    taskPreserved: true,
    userDirectivesCount: userDirectives.length,
    constraintsCount: userDirectives.length,
    modifiedFiles: [...filesModified.keys()],
    modifiedFilesCount: filesModified.size,
    inspectedFiles: [...filesInspected],
    inspectedFilesCount: filesInspected.size,
    commandsCount: commandsRun.length,
    unresolvedCount: unresolvedItems.length,
    recentMessagesKept: 0,
  };

  return {
    userDirectives,
    userConstraints,
    filesModified,
    filesInspected,
    toolFindings,
    negativeFindings,
    commandsRun,
    modelDecisions,
    unresolvedItems,
    existingSummarySections,
    retainedItems,
  };
}

/**
 * Deterministic Native Compaction Engine:
 * Analyzes conversation turns without network or LLM latency.
 * Explicitly separates:
 * - Original task objective & user constraints
 * - Verified Repository Facts (actual file edits, reads, command outputs, tool results)
 * - Model Decisions & Working Assumptions (assistant statements/hypotheses)
 * - Unresolved Questions & Active Errors
 */
export function buildNativeCompactionSummary(
  messages: ChatMessage[],
  focus?: string,
  anchorPrompt?: string
): string {
  const data = extractStructuredCompactionData(messages);
  const sections: string[] = [];

  // 1. Original Task Objective & Scope
  if (anchorPrompt) {
    sections.push(`### 🎯 Original Task & Objective\n${anchorPrompt.trim()}`);
  }
  if (focus) {
    sections.push(`### 📌 Compaction Focus\n${focus.trim()}`);
  }

  // 2. Rolled-over History from earlier compactions (deduplicated across repeated compactions)
  if (data.existingSummarySections.length > 0) {
    const rolledOverLines: string[] = [];
    const seenLines = new Set<string>();
    for (const sec of data.existingSummarySections) {
      for (const line of sec.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("###")) continue;
        if (!seenLines.has(trimmed)) {
          seenLines.add(trimmed);
          rolledOverLines.push(line);
        }
      }
    }
    if (rolledOverLines.length > 0) {
      sections.push(
        `### 📜 Prior Compacted History\n${rolledOverLines.slice(-16).join("\n")}`
      );
    }
  }

  // 3. User Constraints & Preservation Rules (structurally separated)
  if (data.userConstraints.length > 0) {
    const list = data.userConstraints
      .slice(-8)
      .map((c) => `- ${c}`)
      .join("\n");
    sections.push(`### 🚫 Negative & Preservation Constraints\n${list}`);
  }

  // 4. User Directives & Instructions
  if (data.userDirectives.length > 0) {
    const list = data.userDirectives
      .slice(-10)
      .map((d) => `- ${d}`)
      .join("\n");
    sections.push(`### 📝 User Instructions & Constraints\n${list}`);
  }

  // 5. Verified Repository Facts (Files Modified, Inspected, Negative Findings, Commands, Tool Results)
  const repoFactLines: string[] = [];
  if (data.filesModified.size > 0) {
    repoFactLines.push("**Files Modified / Created (Confirmed):**");
    for (const [f, notes] of [...data.filesModified.entries()].slice(-15)) {
      repoFactLines.push(`- \`${f}\`: ${notes.join("; ")}`);
    }
  }
  if (data.filesInspected.size > 0) {
    repoFactLines.push("**Files & Paths Inspected:**");
    for (const f of [...data.filesInspected].slice(-10)) {
      repoFactLines.push(
        f.startsWith("pattern:") || f.startsWith("query:") ? `- ${f}` : `- \`${f}\``
      );
    }
  }
  if (data.negativeFindings.length > 0) {
    repoFactLines.push("**Negative Findings & Missing Items:**");
    for (const nf of data.negativeFindings.slice(-6)) {
      repoFactLines.push(`- ${nf}`);
    }
  }
  if (data.commandsRun.length > 0) {
    repoFactLines.push("**Commands Executed / Attempted:**");
    for (const c of data.commandsRun.slice(-8)) {
      let statusLabel: string;
      switch (c.status) {
        case "completed":
          statusLabel = "✓ Completed";
          break;
        case "failed":
          statusLabel = `✗ Failed (${c.error ?? "error"})`;
          break;
        case "not_executed":
          statusLabel = "⏸ Not executed";
          break;
        case "awaiting_approval":
          statusLabel = "⏳ Awaiting approval";
          break;
        case "in_progress":
          statusLabel = "▶ In progress";
          break;
        case "denied":
          statusLabel = "⛔ Denied";
          break;
        default:
          statusLabel = "❓ Outcome unknown";
          break;
      }
      repoFactLines.push(`- \`${c.command}\` → ${statusLabel}`);
    }
  }
  if (data.toolFindings.length > 0) {
    repoFactLines.push("**Key Tool Results:**");
    for (const tf of data.toolFindings.slice(-6)) {
      repoFactLines.push(`- ${tf}`);
    }
  }
  if (repoFactLines.length > 0) {
    sections.push(`### ✅ Verified Repository Facts (Ground Truth)\n${repoFactLines.join("\n")}`);
  }

  // 6. Model Decisions & Working Assumptions (distinguished from verified repo facts)
  if (data.modelDecisions.length > 0) {
    const list = data.modelDecisions
      .slice(-8)
      .map((d) => `- ${d}`)
      .join("\n");
    sections.push(`### 🧠 Model Decisions & Assumptions (Unverified Claims / Rationale)\n${list}`);
  }

  // 7. Unresolved Questions, Pending Work & Active Errors
  if (data.unresolvedItems.length > 0) {
    const list = data.unresolvedItems
      .slice(-8)
      .map((e) => `- ${e}`)
      .join("\n");
    sections.push(`### ⚠️ Unresolved Issues & Pending Items\n${list}`);
  }

  if (sections.length === 0) {
    sections.push(
      `### 📋 Conversation Digest\n- Compacted ${messages.length} intermediate turns.\n- All file changes and previous tool executions remain intact in the workspace.`
    );
  }

  return sections.join("\n\n");
}

/**
 * Validates whether a provider-generated summary is usable or if it should be rejected
 * in favor of the deterministic native summary.
 */
export function isUsableProviderSummary(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;
  // Reject common LLM refusal or error outputs
  if (
    /^(?:error\b|failed\b|sorry\b|i apologize|i cannot|i'm sorry|unable to|rate limit|bad request)/i.test(
      trimmed
    ) ||
    /\b(?:cannot fulfill|cannot summarize|unable to summarize|safety guidelines)\b/i.test(
      trimmed.slice(0, 160)
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Model-Assisted Compaction:
 * Attempts to summarize conversation turns using the provider's fastest/lightest model.
 * Includes timeout, output validation, and deterministic fact-preservation fallback.
 */
export async function summarizeWithProviderModel(
  provider: LLMProvider,
  model: string,
  messages: ChatMessage[],
  focus?: string,
  anchorPrompt?: string,
  timeoutMs = 9000
): Promise<string | null> {
  try {
    const summarizerModel = chooseSummarizerModel(provider.id, model);

    const systemPrompt =
      "You are Photon's context compaction engine. " +
      "Summarize the conversation history concisely while preserving: " +
      "(1) Original task & user constraints, " +
      "(2) Verified repository facts (exact file paths read/modified, commands run, tool results), " +
      "(3) Model decisions & assumptions (explicitly distinguished from verified repository facts), and " +
      "(4) Unresolved questions or errors. " +
      "Be dense, factual, and strictly technical. Use markdown sections and bullet points.";

    let transcript = "";
    if (anchorPrompt) transcript += `INITIAL TASK:\n${anchorPrompt}\n\n`;
    if (focus) transcript += `COMPACTION FOCUS INSTRUCTION:\n${focus}\n\n`;
    transcript += "CONVERSATION HISTORY TO COMPACT:\n";

    for (const m of messages) {
      const role = m.role.toUpperCase();
      let text = m.content.slice(0, 1200);
      if (m.toolCalls?.length) {
        text += `\n[Tool calls: ${m.toolCalls
          .map((t) => {
            const mappedStatus = mapToolStatusToCompactionStatus(t.status);
            const statusDetail =
              mappedStatus === "completed"
                ? "completed"
                : mappedStatus === "failed"
                  ? `failed: ${t.error ?? "error"}`
                  : mappedStatus === "awaiting_approval"
                    ? "awaiting approval"
                    : mappedStatus === "in_progress"
                      ? "in progress"
                      : mappedStatus === "not_executed"
                        ? "not executed"
                        : mappedStatus === "denied"
                          ? "denied"
                          : "unknown";
            return `${t.name}(${JSON.stringify(t.args)}) [status: ${statusDetail}]`;
          })
          .join(", ")}]`;
      }
      transcript += `${role}: ${text}\n`;
    }

    // Preserve head and tail if transcript is very long
    if (transcript.length > 8000) {
      transcript =
        transcript.slice(0, 4000) +
        "\n... [middle turns condensed] ...\n" +
        transcript.slice(-4000);
    }

    const llmMessages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Synthesize this conversation into a structured context compaction digest:\n\n${transcript}`,
      },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let result = "";
    try {
      for await (const chunk of provider.chatStream(
        { model: summarizerModel, messages: llmMessages, options: { num_predict: 900 } },
        controller.signal
      )) {
        if (chunk.message?.content) result += chunk.message.content;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!isUsableProviderSummary(result)) {
      return null;
    }

    let finalSummary = result.trim();

    // Ensure critical repository facts (modified file paths & anchor goal) are never lost
    // even if the provider model forgot to mention a file path.
    const data = extractStructuredCompactionData(messages);
    const missingModFiles = [...data.filesModified.keys()].filter(
      (f) => !finalSummary.includes(f)
    );
    if (missingModFiles.length > 0) {
      const fileLines = missingModFiles
        .map((f) => `- \`${f}\`: ${(data.filesModified.get(f) ?? []).join("; ")}`)
        .join("\n");
      finalSummary += `\n\n### 🛠️ Verified Modified Files (Retained)\n${fileLines}`;
    }

    if (data.userConstraints.length > 0) {
      const missingConstraints = data.userConstraints.filter(
        (c) => !finalSummary.toLowerCase().includes(c.toLowerCase().slice(0, 30))
      );
      if (missingConstraints.length > 0) {
        finalSummary += `\n\n### 🚫 Preserved User Constraints (Retained)\n${missingConstraints.map((c) => `- ${c}`).join("\n")}`;
      }
    }

    if (data.unresolvedItems.length > 0) {
      const missingUnresolved = data.unresolvedItems.filter(
        (item) => !finalSummary.includes(item)
      );
      if (missingUnresolved.length > 0) {
        finalSummary += `\n\n### ⚠️ Unresolved Issues & Pending Items (Retained)\n${missingUnresolved.map((u) => `- ${u}`).join("\n")}`;
      }
    }

    return redactSecretsFromError(finalSummary);
  } catch {
    // Graceful fallback to native compactor on timeout, network error, or crash
    return null;
  }
}

/**
 * Chooses the fastest model suited for compaction from the provider.
 */
function chooseSummarizerModel(providerId: string, activeModel: string): string {
  const p = providerId.toLowerCase();
  const m = activeModel.toLowerCase();

  if (p === "gemini" || m.startsWith("gemini:")) {
    return "gemini:gemini-3.1-flash-lite-preview";
  }
  if (p === "claude" || m.startsWith("claude:")) {
    return "claude:claude-3-5-haiku-20241022";
  }
  if (p === "openai" || m.startsWith("openai:")) {
    return "openai:gpt-4o-mini";
  }
  if (p === "openrouter" || m.startsWith("openrouter:")) {
    return "openrouter:google/gemini-2.5-flash";
  }
  if (p === "groq" || m.startsWith("groq:")) {
    return "groq:llama-3.3-70b-versatile";
  }
  return activeModel;
}

/**
 * Main compaction orchestrator:
 * Executes automatic or manual context compaction on session messages.
 * Preserves anchor task, tool-call/result pairing, role alternation, and repository facts.
 */
export async function compactSessionMessages(options: CompactionOptions): Promise<CompactionResult> {
  const {
    messages,
    contextWindow,
    model,
    provider,
    force = false,
    focus,
    threshold = DEFAULT_AUTO_COMPACT_THRESHOLD,
    recentTurnsToKeep,
    keepRecentUserTurns,
  } = options;

  const effectiveRecentTurns = recentTurnsToKeep ?? keepRecentUserTurns;
  const tokensBefore = estimateMessagesTokens(messages, model);

  // Check if compaction is required / allowed
  if (!force && !shouldAutoCompact(messages, contextWindow, model, threshold)) {
    return {
      compacted: false,
      reason: "not_needed",
      messagesBefore: messages.length,
      messagesAfter: messages.length,
      tokensBefore,
      tokensAfter: tokensBefore,
      tokensSaved: 0,
      pctSaved: 0,
      strategy: "native-heuristic",
      newMessages: messages,
    };
  }

  const candidates = extractCompactionCandidates(messages, effectiveRecentTurns);
  if (!candidates.canCompact) {
    return {
      compacted: false,
      reason: "too_few_messages",
      messagesBefore: messages.length,
      messagesAfter: messages.length,
      tokensBefore,
      tokensAfter: tokensBefore,
      tokensSaved: 0,
      pctSaved: 0,
      strategy: "native-heuristic",
      newMessages: messages,
    };
  }

  const { anchor, toCompact, recent } = candidates;
  const anchorText = anchor ? anchor.content : undefined;
  const structuredData = extractStructuredCompactionData(toCompact);

  let summary: string | null = null;
  let strategy: "provider-model" | "native-heuristic" = "native-heuristic";

  // Try model-assisted provider compaction if available
  if (provider && provider.isConfigured() && model) {
    summary = await summarizeWithProviderModel(provider, model, toCompact, focus, anchorText);
    if (summary) strategy = "provider-model";
  }

  // Fallback to native deterministic compaction
  if (!summary) {
    summary = buildNativeCompactionSummary(toCompact, focus, anchorText);
    strategy = "native-heuristic";
  }

  const keepAnchor = Boolean(anchor && !anchor.content.includes("[Context Compaction Summary]"));

  // Determine role for compaction message to preserve valid user/assistant ordering:
  // If anchor (role="user") is kept, the message immediately following anchor should be "assistant".
  // Otherwise, if recent[0] is "user", compaction message is "assistant"; else "user".
  const nextRole: Role = keepAnchor
    ? "assistant"
    : recent.length > 0 && recent[0].role === "user"
      ? "assistant"
      : "user";

  const tokensSavedEstimate = Math.max(
    0,
    estimateMessagesTokens(toCompact, model) - estimateTokens(summary)
  );
  const pctSaved =
    contextWindow > 0 ? Math.min(100, Math.round((tokensSavedEstimate / contextWindow) * 100)) : 0;

  const retained: CompactionRetainedItems = {
    anchorPreserved: keepAnchor,
    taskPreserved: keepAnchor,
    userDirectivesCount: structuredData.userDirectives.length,
    constraintsCount: structuredData.userDirectives.length,
    modifiedFiles: [...structuredData.filesModified.keys()],
    modifiedFilesCount: structuredData.filesModified.size,
    inspectedFiles: [...structuredData.filesInspected],
    inspectedFilesCount: structuredData.filesInspected.size,
    commandsCount: structuredData.commandsRun.length,
    unresolvedCount: structuredData.unresolvedItems.length,
    recentMessagesKept: recent.length,
  };

  const triggerDesc = force
    ? "manual /compact"
    : `auto ≥${Math.round(threshold * 100)}% of ${formatCompactTokens(contextWindow)} window`;

  const retainedDescParts: string[] = ["task"];
  if (retained.modifiedFiles.length > 0) {
    retainedDescParts.push(`${retained.modifiedFiles.length} modified file(s)`);
  }
  if (retained.userDirectivesCount > 0) {
    retainedDescParts.push(`${retained.userDirectivesCount} directive(s)`);
  }
  retainedDescParts.push(`${recent.length} recent msg(s)`);

  const compactionNotice =
    `⚡ Context compacted (${triggerDesc}): ${toCompact.length} msgs compressed · ` +
    `Freed ~${formatCompactTokens(tokensSavedEstimate)} tokens (${pctSaved}%) · ` +
    `Retained ${retainedDescParts.join(", ")}`;

  const compactionMessage: ChatMessage = {
    id: randomUUID(),
    role: nextRole,
    content: `⚡ **[Context Compaction Summary]**\n\n${summary}`,
    createdAt: Date.now(),
    notice: compactionNotice,
    isCompacted: true,
    compactStats: {
      messagesCount: toCompact.length,
      tokensSaved: tokensSavedEstimate,
      pctSaved,
      strategy,
    },
  };

  // Assemble new message history:
  // [Anchor (if preserved), Compaction Message, ...Recent Turns]
  const newMessages: ChatMessage[] = [];
  if (keepAnchor && anchor) {
    newMessages.push(anchor);
  }
  newMessages.push(compactionMessage);
  newMessages.push(...recent);

  const tokensAfter = estimateMessagesTokens(newMessages, model);
  const realTokensSaved = Math.max(0, tokensBefore - tokensAfter);
  const realPctSaved =
    contextWindow > 0 ? Math.min(100, Math.round((realTokensSaved / contextWindow) * 100)) : 0;

  return {
    compacted: true,
    reason: force ? "manual" : "threshold_met",
    messagesBefore: messages.length,
    messagesAfter: newMessages.length,
    tokensBefore,
    tokensAfter,
    tokensSaved: realTokensSaved,
    pctSaved: realPctSaved,
    strategy,
    summary,
    compactionNotice,
    retained,
    newMessages,
  };
}

function formatCompactTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}
