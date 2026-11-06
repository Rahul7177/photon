import { randomUUID } from "node:crypto";
import type { ChatMessage, Role } from "../../shared/types";
import type { LLMMessage, LLMProvider } from "../llm/types";
import {
  estimateTokens,
  estimateTokensForModel,
  estimateMessageTokens,
  estimateMessagesTokens,
} from "../adaptive/tokens";

export interface CompactionCandidateSet {
  anchor: ChatMessage | null;
  toCompact: ChatMessage[];
  recent: ChatMessage[];
  canCompact: boolean;
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
}

/** Default context fill ratio to trigger auto-compaction (75% like Copilot / Claude Code) */
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.75;

/** Minimum messages in conversation required before compaction is meaningful */
export const MIN_MESSAGES_FOR_COMPACTION = 4;

/**
 * Determine if the conversation context is full enough to trigger automatic compaction.
 * Mirrors Claude Code and GitHub Copilot threshold heuristics:
 * triggers when current conversation tokens >= threshold (default 75%) of context window.
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
 * 1. Anchor: First user prompt establishing the overall task/intent.
 * 2. ToCompact: Middle messages to be folded into a structured summary.
 * 3. Recent: Latest turns (default last 1-2 user turns and immediate assistant responses) kept verbatim.
 */
export function extractCompactionCandidates(
  messages: ChatMessage[],
  recentTurnsToKeep?: number
): CompactionCandidateSet {
  if (!messages || messages.length < MIN_MESSAGES_FOR_COMPACTION) {
    return { anchor: null, toCompact: [], recent: messages || [], canCompact: false };
  }

  // 1. Locate anchor (first user message)
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  const anchor = firstUserIdx >= 0 ? messages[firstUserIdx] : null;

  // Decide how many recent user turns to preserve:
  // If messages count is <= 8, keep 1 recent user turn (the active turn);
  // for longer conversations, keep up to recentTurnsToKeep (default 2).
  const effectiveRecentTurns = recentTurnsToKeep ?? (messages.length <= 8 ? 1 : 2);

  // 2. Count backwards to locate start of recent turns
  let userTurnsSeen = 0;
  let recentStartIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen === effectiveRecentTurns) {
        recentStartIdx = i;
        break;
      }
    }
  }

  // Fallback if not enough user turns found: keep at least the last 2 messages intact
  if (recentStartIdx >= messages.length || recentStartIdx <= (firstUserIdx >= 0 ? firstUserIdx + 1 : 1)) {
    recentStartIdx = Math.max(firstUserIdx >= 0 ? firstUserIdx + 1 : 1, messages.length - 2);
  }

  const sliceStart = firstUserIdx >= 0 ? firstUserIdx + 1 : 0;
  const toCompact = messages.slice(sliceStart, recentStartIdx);
  const recent = messages.slice(recentStartIdx);

  const canCompact = toCompact.length >= 1;

  return {
    anchor,
    toCompact,
    recent,
    canCompact,
  };
}

/**
 * Deterministic Native Compaction Engine:
 * Analyzes conversation turns without network or LLM latency.
 * Accurately extracts:
 * - Original user goal & intermediate instructions
 * - Files modified & written (with exact paths & edit nature)
 * - Files inspected & read
 * - Terminal commands executed & exit status
 * - Key technical decisions made by assistant
 * - Error states and unresolved checklist items
 * - Rollover from any earlier compaction blocks so no context is lost over long sessions.
 */
export function buildNativeCompactionSummary(
  messages: ChatMessage[],
  focus?: string,
  anchorPrompt?: string
): string {
  const userDirectives: string[] = [];
  const filesModified = new Map<string, string[]>();
  const filesInspected = new Set<string>();
  const commandsRun: Array<{ command: string; status: "success" | "error"; error?: string }> = [];
  const decisions: string[] = [];
  const activeErrors: string[] = [];
  const existingSummarySections: string[] = [];

  for (const msg of messages) {
    // Check if this message is a prior compaction summary to preserve historical continuity
    if (msg.content.includes("[Context Compaction Summary]") || msg.notice?.includes("Context compacted")) {
      existingSummarySections.push(msg.content.replace(/^⚡\s*\*\*\[Context Compaction Summary\]\*\*\s*/i, "").trim());
      continue;
    }

    if (msg.role === "user") {
      const clean = msg.content.trim();
      // Don't include tool-result user turns as user directives
      if (!clean.startsWith("[tool:") && !clean.startsWith("```json") && clean.length > 0) {
        if (!userDirectives.includes(clean)) {
          userDirectives.push(clean.length > 200 ? clean.slice(0, 197) + "…" : clean);
        }
      }
    }

    // Inspect tool calls made by assistant or recorded on message
    for (const call of msg.toolCalls ?? []) {
      const name = call.name;
      const args = call.args || {};
      const filePath = String(args.path || args.file_path || args.filePath || args.file || "");

      if (name === "replace_in_file" || name === "edit_file" || name === "write_to_file" || name === "write_file" || name === "append_file") {
        if (filePath) {
          const notes = filesModified.get(filePath) ?? [];
          const editDesc = args.find
            ? `Replaced target block (${String(args.find).slice(0, 40).trim()}…)`
            : name === "write_to_file" || name === "write_file"
              ? "Created / overwritten file"
              : "Updated file contents";
          if (!notes.includes(editDesc)) notes.push(editDesc);
          filesModified.set(filePath, notes);
        }
      } else if (name === "read_file" || name === "search_files" || name === "find_files" || name === "list_dir") {
        if (filePath) filesInspected.add(filePath);
        if (args.pattern) filesInspected.add(`pattern: "${args.pattern}"`);
        if (args.query) filesInspected.add(`query: "${args.query}"`);
      } else if (name === "execute_command" || name === "bash" || name === "terminal") {
        const cmd = String(args.command || args.cmd || "");
        if (cmd) {
          commandsRun.push({
            command: cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd,
            status: call.status === "error" ? "error" : "success",
            error: call.error ? String(call.error).slice(0, 80) : undefined,
          });
        }
      }
    }

    if (msg.role === "assistant" && msg.content) {
      // Extract high-signal decision lines (bullet points, "I will", "Configured", "Fixed", "Implemented")
      const lines = msg.content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          /^(?:[-*]|\d+\.)\s+(?:Fixed|Implemented|Configured|Added|Updated|Verified|Resolved|Adopted|Selected|Refactored|Created)/i.test(trimmed) ||
          /^(?:Decision|Architecture|Key finding|Root cause):/i.test(trimmed)
        ) {
          const clean = trimmed.replace(/^(?:[-*]|\d+\.)\s+/, "");
          if (clean.length > 10 && !decisions.includes(clean)) {
            decisions.push(clean.length > 140 ? clean.slice(0, 137) + "…" : clean);
          }
        }
      }
    }

    if (msg.notice && (msg.notice.startsWith("⚠️") || /error|failed/i.test(msg.notice))) {
      activeErrors.push(msg.notice.slice(0, 120));
    }
  }

  // Construct structured Markdown brief
  const sections: string[] = [];

  // Goal & Focus
  if (anchorPrompt) {
    sections.push(`### 🎯 Task Objective & Scope\n${anchorPrompt.trim()}`);
  }
  if (focus) {
    sections.push(`### 📌 Compaction Focus\n${focus.trim()}`);
  }

  // Incorporate rolled-over history if present
  if (existingSummarySections.length > 0) {
    sections.push(`### 📜 Previous Conversation History\n${existingSummarySections.join("\n\n")}`);
  }

  // User Directives
  if (userDirectives.length > 0) {
    const list = userDirectives.slice(-8).map((d) => `- ${d}`).join("\n");
    sections.push(`### 📝 User Directives & Constraints\n${list}`);
  }

  // Files Modified
  if (filesModified.size > 0) {
    const entries = [...filesModified.entries()]
      .slice(-12)
      .map(([f, notes]) => `- \`${f}\`: ${notes.join("; ")}`)
      .join("\n");
    sections.push(`### 🛠️ Files Modified & Created\n${entries}`);
  }

  // Files Inspected
  if (filesInspected.size > 0) {
    const entries = [...filesInspected]
      .slice(-10)
      .map((f) => (f.startsWith("pattern:") || f.startsWith("query:") ? `- ${f}` : `- \`${f}\``))
      .join("\n");
    sections.push(`### 🔍 Key Files & Searches Inspected\n${entries}`);
  }

  // Commands Executed
  if (commandsRun.length > 0) {
    const entries = commandsRun
      .slice(-6)
      .map((c) => `- \`${c.command}\` → ${c.status === "success" ? "✓ Success" : `✗ Failed (${c.error ?? "error"})`}`)
      .join("\n");
    sections.push(`### 💻 Commands & Validations\n${entries}`);
  }

  // Key Technical Decisions
  if (decisions.length > 0) {
    const list = decisions.slice(-8).map((d) => `- ${d}`).join("\n");
    sections.push(`### 💡 Key Technical Decisions & Progress\n${list}`);
  }

  // Active Errors / Warnings
  if (activeErrors.length > 0) {
    const list = activeErrors.slice(-3).map((e) => `- ⚠️ ${e}`).join("\n");
    sections.push(`### ⚠️ Attention & Errors Noted\n${list}`);
  }

  // Fallback if very little structured data was extracted
  if (sections.length === 0) {
    sections.push(
      `### 📋 Conversation Digest\n- Compacted ${messages.length} intermediate turns.\n- All file changes and previous test executions remain intact in the workspace.`
    );
  }

  return sections.join("\n\n");
}

/**
 * Model-Assisted Compaction:
 * Attempts to summarize conversation turns using the provider's fastest/lightest model
 * (e.g. Gemini Flash Lite, Claude Haiku, GPT-4o-mini, or active model).
 * Includes timeout and error handling, seamlessly returning null if unavailable.
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
    // Select the best lightweight summarizer model name for the provider
    const summarizerModel = chooseSummarizerModel(provider.id, model);

    const systemPrompt =
      "You are Photon's context compaction engine (inspired by Claude Code & GitHub Copilot). " +
      "Summarize the conversation history concisely, retaining all critical facts, user objectives, " +
      "files inspected/modified, commands run, architectural choices, and pending work. " +
      "Be dense, factual, and strictly technical. Use markdown bullet points.";

    // Convert messages to text transcript for the summarizer
    let transcript = "";
    if (anchorPrompt) transcript += `INITIAL TASK:\n${anchorPrompt}\n\n`;
    if (focus) transcript += `COMPACTION FOCUS INSTRUCTION:\n${focus}\n\n`;
    transcript += "CONVERSATION HISTORY TO COMPACT:\n";

    for (const m of messages) {
      if (m.content.includes("[Context Compaction Summary]")) continue;
      const role = m.role.toUpperCase();
      let text = m.content.slice(0, 1000);
      if (m.toolCalls?.length) {
        text += `\n[Tool calls: ${m.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join(", ")}]`;
      }
      transcript += `${role}: ${text}\n`;
    }

    // Limit input transcript to ~6000 chars to ensure lightning-fast completion
    if (transcript.length > 6000) {
      transcript = transcript.slice(0, 3000) + "\n... [intermediate turns omitted for summary] ...\n" + transcript.slice(-3000);
    }

    const llmMessages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Please synthesize this conversation into an ultra-dense, structured context compaction digest:\n\n${transcript}`,
      },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let result = "";
    try {
      for await (const chunk of provider.chatStream(
        { model: summarizerModel, messages: llmMessages, options: { num_predict: 800 } },
        controller.signal
      )) {
        if (chunk.message?.content) result += chunk.message.content;
      }
    } finally {
      clearTimeout(timeout);
    }

    const trimmed = result.trim();
    if (trimmed.length > 40) {
      return trimmed;
    }
    return null;
  } catch {
    // Graceful fallback to native compactor
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
 * Automatically chooses between provider-assisted summarization and native deterministic compaction.
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
  } = options;

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

  const candidates = extractCompactionCandidates(messages, recentTurnsToKeep);
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

  // Determine role for compaction message:
  // Anthropic requires strictly alternating user/assistant turns.
  // If `recent[0]` is user, compaction message should be assistant; otherwise user.
  const nextRole: Role = recent.length > 0 && recent[0].role === "user" ? "assistant" : "user";

  const tokensSavedEstimate = Math.max(0, estimateMessagesTokens(toCompact, model) - estimateTokens(summary));
  const pctSaved = contextWindow > 0 ? Math.min(100, Math.round((tokensSavedEstimate / contextWindow) * 100)) : 0;

  const compactionNotice = `⚡ Context compacted: ${toCompact.length} messages compressed · Freed ~${formatCompactTokens(tokensSavedEstimate)} tokens (${pctSaved}% of window)`;

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
  if (anchor && (!anchor.content.includes("[Context Compaction Summary]"))) {
    newMessages.push(anchor);
  }
  newMessages.push(compactionMessage);
  newMessages.push(...recent);

  const tokensAfter = estimateMessagesTokens(newMessages, model);
  const realTokensSaved = Math.max(0, tokensBefore - tokensAfter);
  const realPctSaved = contextWindow > 0 ? Math.min(100, Math.round((realTokensSaved / contextWindow) * 100)) : 0;

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
    newMessages,
  };
}

function formatCompactTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}
