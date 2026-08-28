import type { BenchResult, BenchTaskOutcome, ToolSpec } from "../../shared/types";
import type { LLMProvider, LLMChatChunk, LLMMessage } from "../llm/types";
import { parsePhotonBlocks } from "../protocol/parse";
import { estimateTokens } from "../adaptive/tokens";

// Bump when the task set or scoring rubric changes, so results from different
// methodologies are never compared as if equivalent (M7 checklist).
export const BENCH_VERSION = 1;

// Keep bench generations short and deterministic so a run is a minute or two,
// not an open-ended wait, and so scores are comparable across runs.
const BENCH_OPTS = { temperature: 0, top_p: 1, num_ctx: 4096, num_predict: 160, seed: 7 };

// A single, minimal tool used only to probe whether the model can emit a
// well-formed structured call. Its shape mirrors the real read_file tool.
const PROBE_TOOL: ToolSpec = {
  name: "read_file",
  summary: "Read a file from the workspace.",
  params: [{ name: "path", type: "string", required: true, description: "File path to read." }],
  sideEffecting: false,
  priority: 1,
};

const TOOLCALL_ATTEMPTS = 2;

export interface BenchOptions {
  /** Machine tier (low/mid/high) — recorded as part of the comparison key. */
  hardwareClass: string;
  quantization?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/**
 * Run Photon Bench for one model: measure throughput + first-token latency,
 * probe structured tool-call reliability, and check a small reasoning task.
 * Pure w.r.t. VS Code — it only needs an LLMProvider. Throws on abort or a
 * hard model error; the caller decides how to surface that.
 */
export async function runBench(
  client: LLMProvider,
  model: string,
  opts: BenchOptions
): Promise<BenchResult> {
  const tasks: BenchTaskOutcome[] = [];

  // --- Task 1: throughput + first-token latency ---------------------------
  opts.onProgress?.("Measuring throughput…");
  const gen = await generate(
    client,
    model,
    [{ role: "user", content: "Write a TypeScript function `add(a, b)` that returns their sum. Code only." }],
    opts.signal
  );
  const tokensPerSec = gen.tokensPerSec;
  const firstTokenMs = gen.firstTokenMs;
  tasks.push({
    id: "throughput",
    passed: tokensPerSec > 0,
    detail: `${Math.round(tokensPerSec)} tok/s, first token ${Math.round(firstTokenMs)} ms`,
  });

  // --- Task 2: structured tool-call reliability ---------------------------
  opts.onProgress?.("Probing tool-call reliability…");
  const toolInstr = [
    "You can call a tool by writing exactly:",
    "[TOOL read_file]",
    "path: <the path>",
    "[/TOOL]",
    "Then stop. Only use the read_file tool.",
  ].join("\n");
  let toolPasses = 0;
  for (let i = 0; i < TOOLCALL_ATTEMPTS; i++) {
    if (opts.signal?.aborted) throw new Error("Benchmark cancelled.");
    const out = await generate(
      client,
      model,
      [
        { role: "system", content: toolInstr },
        { role: "user", content: "Read the file src/index.ts using the tool." },
      ],
      opts.signal
    );
    const { calls } = parsePhotonBlocks(out.text, [PROBE_TOOL]);
    const good = calls.some(
      (c) => c.name === "read_file" && !c.errors.length && typeof c.args.path === "string" && !!c.args.path
    );
    if (good) toolPasses++;
  }
  const toolCallReliability = toolPasses / TOOLCALL_ATTEMPTS;
  tasks.push({
    id: "toolcall",
    passed: toolCallReliability >= 0.5,
    detail: `${toolPasses}/${TOOLCALL_ATTEMPTS} well-formed calls`,
  });

  // --- Task 3: small reasoning check --------------------------------------
  opts.onProgress?.("Checking reasoning…");
  const reason = await generate(
    client,
    model,
    [
      {
        role: "user",
        content:
          "A list starts empty. A function is called 3 times; each call appends 2 items. " +
          "How many items are in the list at the end? Reply with only the number.",
      },
    ],
    opts.signal
  );
  const reasoningPass = /\b6\b/.test(reason.text);
  tasks.push({
    id: "reasoning",
    passed: reasoningPass,
    detail: reasoningPass ? "correct (6)" : `unexpected: "${reason.text.trim().slice(0, 40)}"`,
  });

  return {
    model,
    quantization: opts.quantization,
    hardwareClass: opts.hardwareClass,
    methodologyVersion: BENCH_VERSION,
    tokensPerSec: Math.round(tokensPerSec * 10) / 10,
    firstTokenMs: Math.round(firstTokenMs),
    toolCallReliability,
    reasoningPass,
    tasks,
    ranAt: nowMs(),
  };
}

interface GenResult {
  text: string;
  tokensPerSec: number;
  firstTokenMs: number;
}

/** Run one non-tool generation to completion, capturing timing. */
async function generate(
  client: LLMProvider,
  model: string,
  messages: LLMMessage[],
  signal?: AbortSignal
): Promise<GenResult> {
  const start = nowMs();
  let firstAt = 0;
  let text = "";
  let last: LLMChatChunk | undefined;

  for await (const chunk of client.chatStream({ model, messages, options: BENCH_OPTS }, signal)) {
    if (chunk.message?.content) {
      if (!firstAt) firstAt = nowMs();
      text += chunk.message.content;
    }
    last = chunk;
  }
  const end = nowMs();

  // Prefer Ollama's own eval timing (nanoseconds) for accuracy; fall back to a
  // wall-clock estimate when the server doesn't report it.
  let tokensPerSec = 0;
  if (last?.eval_count && last.eval_duration && last.eval_duration > 0) {
    tokensPerSec = last.eval_count / (last.eval_duration / 1e9);
  } else {
    const genMs = Math.max(1, end - (firstAt || start));
    tokensPerSec = (estimateTokens(text) / genMs) * 1000;
  }
  const firstTokenMs = (firstAt || end) - start;
  return { text, tokensPerSec, firstTokenMs };
}

// Date.now via an indirection so this module stays easy to reason about; the
// host owns the clock.
function nowMs(): number {
  return Date.now();
}
