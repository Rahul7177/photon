# Photon Adaptive Intelligence — Audit, Strategy & Improvement Plan (v2)

> Audited against `Rahul7177/photon` @ `c697a9b` (shallow clone, Nov 2026), plus `ADAPTIVE_INTELLIGENCE.md` and `product_info.md`.
> **Part A** (this section) is the new audit and plan. **Part B** is the original v1 specification, kept intact as the implementation reference, with corrections noted at its top.
> Every finding below cites a file I actually read. Anything I could not verify is marked **(unverified)**. Numeric targets are *targets to validate*, not measurements.

---

## 0. Verdict

**The idea is right and the foundation is solid, but today it is a good *static* heuristic system, not yet a *self-correcting* one — and that gap is where the moat is.**

What exists is a well-engineered set of rules: tier → scaffolding level, hardware → context window, regex → task profile, 7 probes → capability profile. It works from the model's *name and size*. What it does not yet do is **observe how the model actually behaves on the user's machine and adapt**. The two things you want to be best-in-class need different engines:

| | Local 2–8B models | Cloud / frontier models |
|---|---|---|
| Failure mode | Hallucination, malformed tool calls, wandering, context overflow, slow prefill | Wasted tokens, cache misses, over-reading, over-thinking, wrong-size model |
| What helps | More structure, *less* clutter, host-side help, constrained output, measured reliability | Less instruction, stable cacheable prefix, smaller tool/result payloads, cheaper-model routing |
| What the code does today | One bundled "scaffolding level" by tier; all 17+ tools shown every step | Almost no adaptation: `cloudPlan` is a fixed profile; savings come from one cache breakpoint pair and history compaction |

The biggest opportunity is a **Reliability Governor**: a loop that measures real tool-call failures, repairs, narration nudges and truncations, and moves each (model, machine, task) up or down a scaffolding ladder *during the turn*. Nobody running Ollama-in-an-editor does this well. That is the part to build.

### Top 10 changes, ranked by impact ÷ effort

| # | Change | Track | Effort | Why it ranks here |
|---|---|---|---|---|
| 1 | Add **rolling cache breakpoint on conversation history** + move volatile content out of the cached prefix (§5.3.1) | Cloud | S | Directly cuts input spend on every multi-step turn; currently only system+tools are cached |
| 2 | Make **compaction cache-safe** (append-only, batched) (§5.3.2) | Cloud | M | Today's per-step history rewriting probably invalidates the cache it just paid for |
| 3 | **Per-step tool surface** + shortlist cards for small models (§5.2.1) | Local | S | Phase-aware ranking is effectively dead code in the main engine; 17–40 tool cards go to a 2B model every step |
| 4 | **Reliability Governor**: live failure counters → scaffolding ladder (§5.4.1) | Both | M | Turns static rules into feedback control; the core moat |
| 5 | **Host-driven orientation + verification** for small models (§5.2.2–5.2.3) | Local | M | Removes the two steps small models fail at most (finding the right file, remembering to verify) |
| 6 | **Fix the router's blind spots**: vision, achievable-context, hard-exclude `tight` (§4, R-1..R-3) | Both | S | Cheap, clearly wrong today |
| 7 | **Fix native-protocol gating** (bench tests block format but gates native) (§4, L-6) | Local | S | Wrong protocol silently hurts tool reliability |
| 8 | **Exact KV-cache math** from `/api/show` + measured prefill speed (§5.2.5) | Local | M | Bigger safe contexts where GQA allows; safer where it doesn't; fixes "huge prompt, minutes to first token" |
| 9 | **Bench v5**: multi-sample, under the real prompt, multi-turn (§5.4.3) | Both | M | Today's profile numbers come from one question per skill |
| 10 | **Eval + ablation harness in CI** (§5.4.4) | Both | L | Lets you *prove* each scaffold earns its tokens — and publish it |

---

## 1. Design principles (v1 principles kept, three added)

1. **Inverse scaffolding** *(keep)* — weaker model ⇒ more structure. Tool *access* is never withheld; only guidance scales.
2. **Scaffold is a budget, not a constant** *(new)* — every token of scaffolding must beat its cost in context and prefill time on that hardware. For a 2–4B model on an 8k window, instructions compete directly with the code it needs to read.
3. **Measure, don't guess** *(new)* — name/size priors are the starting point; real behaviour (bench + live events) overrides them, per model **and** per machine **and** per quantization.
4. **Prefix stability is a feature** *(new)* — a stable, ordered prompt prefix is what makes cloud prompt caching work and what lets Ollama reuse its KV cache locally. Volatile content goes last.
5. **Progressive disclosure** *(refines #1)* — "complete tool access" ≠ "show all 17+ tool cards every step". Keep every tool callable; show full cards only for the likely next tools.

---

## 2. What is already strong — keep and build on

- **Inverse scaffolding as an explicit policy** (`deriveScaffoldingLevel`, `orchestrator.ts`) and the decision never to remove tools.
- **Tolerant tool-call parser** (`protocol/parse.ts`): fenced `tool` blocks, bare `TOOL_NAME:`, `call:` markers, missing fences. Very good for weak models.
- **Fuzzy `edit_file` matching** (`tools/builtin/files.ts`, `locateFuzzy`) with actionable repair messages and per-tool worked examples. Keep; don't re-solve.
- **Hardware-aware context calculator** with a 22.5 % RAM reserve and CPU-spill caps.
- **Controlled fallback** that refuses silent local → paid-cloud escalation (`selectFallbackModel`).
- **Recovery machinery**: duplicate-call fingerprints, narration detection, truncation/empty/stream retries, bounded nudges.
- **Cloud basics**: parallel read waves, usage/cost tracker (already records `cachedTokens`), request-aware tool surface, Anthropic ephemeral cache on system + last tool.
- **Compaction with ground-truth fact retention** and 75 % pre-turn trigger.
- **Transparency panel** — the right place to surface everything proposed below.

---

## 3. Corrections to the v1 spec (code ≠ doc)

| Spec says | Code says | Where |
|---|---|---|
| §3.7 "re-ranks tools **per phase**" | Main local engine calls `selectToolSpecs(allSpecs, plan, "orient", freshInfo)` **once per turn** with the phase hard-coded; comment says specs are "identical every step". Phase ranking only matters in other callers (`registry.ts`, `photon-core/tools/pipeline.ts`). | `unifiedEngine.ts:222` |
| Bench gates native protocol at `toolCallReliability ≥ 0.80` | Reliability comes from **3 attempts** ⇒ only 0 / .33 / .67 / 1.0 are possible, so "≥ 0.80" means **3/3**. | `bench.ts` `TOOLCALL_ATTEMPTS = 3` |
| Cloud `intelligence: "max"` | Label is metadata only; cloud prompt is `buildCloudSystemPrompt`, not the local scaffolding. Harmless, but it shows up in the UI as "max scaffolding" for cloud models. | `PhotonController.cloudPlan` |
| Context-fit uses hardware limits | `rankModels` uses the model's **advertised** `contextLength`, not the hardware-computed `numCtx`. | `autoMode.ts` `ctx = m.contextLength` |

---

## 4. Audit findings

Severity: **H** = hurts users now · **M** = leaves clear value on the table · **L** = polish.

### 4.1 Local engine (small models)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| L-1 | **H** | **All tools shown every step.** Local core (10) + extended (7) = 17 tool definitions, plus any MCP tools, up to `maxTools = 40`, rendered into the prompt each step for photon-block models. For a 2–4B model on an 8k window that is a large share of the prompt *and* more wrong-tool choices. Prompt size is **unmeasured** — see Phase 0. | `policy.ts` `LOCAL_CORE_TOOLS` / `LOCAL_EXTENDED_TOOLS`; `unifiedEngine.ts:222,226` |
| L-2 | **H** | **Scaffolding is one switch, chosen by tier.** Any `tiny`/`small` model gets `max` for every task — "what does this function do?" gets the same 42 % prompt budget as a multi-file refactor. The bundle (examples, framing, temp, nudges) can't be tuned piece by piece. | `orchestrator.ts` `deriveScaffoldingLevel`; `system.ts` `BUDGET_FRACTION` |
| L-3 | **M** | **Core prompt is never trimmed.** Budget only gates the *extras* (digest, map, RAG); identity + mode + tool cards + framing + workflow + formatting are always included, so on small windows the extras can be squeezed to nothing. | `system.ts` — `used = estimateTokens(core)` then extras added only if they fit |
| L-3b | **M** | **Language-integrity paragraph with Chinese/Japanese examples is in every prompt.** Useful for one model family's quirk; it costs tokens for all and (worse) puts the very characters you don't want into the prompt of a small model. Gate by model family or detect-and-strip on output. | `system.ts` `formattingRules`; `cloudSystem.ts` |
| L-4 | **M** | **Tiering = parameter count only.** `quantization` is captured but never used; MoE active-parameter size is special-cased only for `:eNb` tags (so, e.g., a 30B-total/3B-active model would be tiered `large`, **unverified for specific tags**); no family/generation signal (a recent 3B coder can beat an old 7B generalist). | `modelProfiler.ts` `parseEffectiveParams`, `classifyModel`; `policy.ts` `capabilityForModel` |
| L-5 | **H** | **Bench is too coarse to drive decisions.** One question per skill; `num_ctx: 4096`, `num_predict: 260`; no system prompt or tool cards in the probe; profile numbers are constants chosen by pass/fail (`reasoning: pass ? 0.9 : 0.35` from a single "3 × 2 items" question; `coding ≥ 0.85` if one edit passes). A 2B model passing trivial probes is scored like a capable one. Multi-turn, repo-task and routing-comparison helpers exist in the file but are **not part of `runBench`**. | `bench.ts` `runBench`, `evaluateRepoTaskInDisposableWorkspace`, `compareRoutingVsBaseline` |
| L-6 | **H** | **Protocol gate mismatch.** Bench measures the *photon-block* format (`parsePhotonBlocks`), then that number decides whether to switch to *native* JSON tool calling. Also: any local model whose Ollama `capabilities` include `"tools"` goes native regardless of measured reliability, and name hints (`mistral`, `gemma4`, …) mark models "tool-trained". | `bench.ts`; `policy.ts:175-182`; `modelProfiler.ts` `TOOL_TRAINED_HINTS` |
| L-7 | **M** | **Protocol is fixed per plan.** I found no mid-turn downgrade (native → block) or upgrade after repeated failures. **(unverified beyond `unifiedEngine.ts` branching on `plan.toolProtocol`)** | `unifiedEngine.ts` |
| L-8 | **M** | **No learning from real use.** The engine already counts nudges, repairs, truncation retries, empty streaks and duplicate calls — none of it feeds back into capability, scaffolding or routing. Capability changes only when the 30-day bench is re-run. | `unifiedEngine.ts` (`MAX_*_NUDGES`), `repair.ts`, `benchStore` |
| L-9 | **M** | **KV-cache cost is a rule of thumb** (`paramsB × 0.022 GB / 1k tokens`, clamped 0.04–0.40). Real cost depends on layers, KV heads, head dim and KV quantization — all derivable from Ollama `/api/show` `model_info`. Over-estimates for GQA models (wasted headroom), under-estimates for others (risk of swap). | `orchestrator.ts` `computeOptimalContextWindow` |
| L-10 | **M** | **Context cap ignores prefill speed.** On CPU/hybrid the real limit is prompt-eval tokens/s, not just memory: a 32k prompt at ~100 tok/s is ~5 min to first token. The core-count caps (16k/32k/64k) are a proxy; bench measures generation tok/s and first-token latency on a *tiny* prompt only. | `orchestrator.ts` `cpuPracticalCap`; `bench.ts` throughput probe |
| L-11 | **M** | **No constrained decoding.** Ollama structured `format` / llama.cpp GBNF grammars can make tool-call syntax valid by construction; the code uses neither (`format`, `grammar`, `json_schema` appear nowhere in `src/core` outside bench). Highest-leverage reliability lever for 2–4B models, with real caveats (see §5.2.4). | grep over `src/core` |
| L-12 | **M** | **One temperature per mode.** Tool-call turns and final-answer turns want different sampling; thinking-capable small models need a thinking on/off decision per task. | `orchestrator.ts` `temperature = mode==="chat" ? chatTemp : taskTemp` |
| L-13 | **L** | **Prompt prefix isn't ordered for Ollama KV reuse.** Workspace map, RAG and digest vary per turn; history is rebuilt through `fitToWindow` each step. Any change early in the prompt forces re-prefill — expensive on laptops. | `system.ts` assembly order; `unifiedEngine.ts` per-step `fitToWindow` |

### 4.2 Task analysis

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| T-1 | **M** | **File-reference regex over-matches.** I ran it: `"e.g. fix the bug in node.js handler, see v1.2 notes"` yields refs `e.g`, `node.js`, `v1.2` ⇒ `multi_file`, more estimated steps, bigger context demand — from a prompt that names no file. | `policy.ts:11`; test run |
| T-2 | **M** | **Keyword lists are English-only and broad.** `add`, `update`, `create`, `build` ⇒ `reasoning: medium`; `it`/`that` ⇒ ambiguity; `run`/`start`/`ui` ⇒ runtime verification. Cheap and mostly fine, but it is the only task signal driving scaffolding, context floors and routing. | `policy.ts` `analyzeTask` |
| T-3 | **M** | **No session signal in task profile.** "Has this model already failed twice this session?" and "how much of the answer is already in context?" are stronger predictors than keywords. | — |

### 4.3 Router

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| R-1 | **H** | **Vision isn't a routing signal.** An image attachment can route to a text-only model; `rankModels` never reads `vision`/`audio`. | `autoMode.ts` (no `vision` reference) |
| R-2 | **M** | **Context fit uses advertised, not achievable, context.** A model can "fit" a 12k floor on paper while the hardware plan gives it 8k. | `autoMode.ts` `fits = ctx >= minContextTokens` |
| R-3 | **M** | **`tight` hardware is only −8.** A model that won't comfortably load can still win on capability points (+18/+14/+10/…). It should be excluded, or at least down-ranked past any realistic capability gain. | `autoMode.ts` `hwFit === "tight"` |
| R-4 | **L** | **Weights are hand-set constants** (`WEIGHTS`) with no calibration against outcomes. Fine for v1; becomes the thing the eval harness should fit. | `autoMode.ts` |
| R-5 | **L** | **In Cloud mode the adaptive plan is computed and then replaced** by `cloudPlan` (only the *model choice* survives). Cost-aware cascade (cheap model first) isn't expressed. | `PhotonController.runPrompt` |

### 4.4 Cloud engine (token savings)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| C-1 | **H** | **No cache breakpoint on conversation history.** Anthropic provider marks the system block and the last tool; messages are not marked. In an agent loop the whole growing history is re-billed at full input price on every step. OpenAI-compat/Gemini rely on automatic prefix caching, which also wants a stable prefix. | `anthropicProvider.ts` (`cache_control` only on system & tools) |
| C-2 | **H** | **Cached prefix isn't stable across user turns.** The "token-optimised, stable prefix" comment is true *within* a turn, but the system text includes `workspaceMap` (rebuilt each turn) and `projectContextDigest` (built from `userQuery` + `activeModel`), so the system cache entry changes every user turn; only the tool block reliably hits across turns. | `PhotonController.runCloudTurn`; `cloudSystem.ts` |
| C-3 | **H** | **Compaction rewrites history every step.** `compactCloudHistory` runs inside the step loop, stubbing superseded `read_file` results and truncating old tool outputs. Editing an earlier message changes every cached byte after it, so savings from smaller messages can be cancelled by lost cache reads. Needs a break-even rule and append-only discipline. **(mechanism verified; net effect should be measured)** | `cloudEngine.ts` ~L555, `compactCloudHistory` |
| C-4 | **M** | **Agent/Plan always send every tool schema**, every step. Chat uses a regex classifier (`classifyCloudToolPolicy`). No progressive or task-based surface. | `cloudTools.ts` |
| C-5 | **M** | **`cloudPlan` ignores task and model.** Fixed `temperature 0.3`, `maxOutputTokens = 25 % of context`, `maxTools 100`; capability profile from tier priors with no bench; thinking level not derived from `TaskAnalysis`. A trivial read-only question and a root-cause debug get the same envelope. | `PhotonController.cloudPlan` |
| C-6 | **M** | **No budget guard or cascade.** Costs are *tracked* (`CloudUsageTracker`) but not *used* to steer: no per-turn/session cap, no "try the cheap model first, escalate on failure signals". | `cloudUsage.ts`; `autoMode.ts` |
| C-7 | **M** | **Tool-result size is the other half of the bill.** Outputs are clamped late (in `fitToWindow` / old-turn compaction) rather than shaped at source (default line ranges, result limits, summaries, diff-only re-reads). **(unverified per tool)** | `contextManager.ts`, `cloudEngine.ts` |

### 4.5 Evaluation and observability

| ID | Sev | Finding |
|---|---|---|
| E-1 | **H** | Unit tests are strong on *mechanics*, but there's no **behavioural eval** showing the scaffolding makes small models *succeed more*, or that cloud optimisations keep quality. Without it, weights and thresholds can't be tuned and the moat can't be shown to users. (`compareRoutingVsBaseline` exists but isn't wired to real model runs.) |
| E-2 | **M** | No per-section **prompt token breakdown**, no per-turn **reliability event log**, no **cache hit-rate** surfaced next to cost. |

---

## 5. Target architecture — Adaptive Intelligence v2

```
                         ┌───────────────────────── Capability Passport ─────────────────────────┐
 Machine profile ───────▶│ (model, quant, runtime, hardware class) → measured capability vector   │
 Model profile  ────────▶│   prior (name/size) ⊕ Bench v5 ⊕ live EWMA from Reliability Governor   │
 Bench v5 results ──────▶│   + prefill tok/s, gen tok/s, exact KV cost, achievable ctx            │
 Live turn events ──────▶└──────────────────────────────────┬────────────────────────────────────┘
                                                            │
 Prompt ─▶ Task Profile v2 ─▶ Router (hard constraints → score → cost cascade) ─▶ Assist Vector
           (+ session signals)                                                    │
                                          ┌───────────────────────────────────────┴──────────┐
                                          ▼                                                  ▼
                              LOCAL: Guided Execution                            CLOUD: Lean Execution
                              • step-scoped working-memory card                  • cache-ordered prompt + rolling breakpoint
                              • shortlist tool cards (all tools callable)        • cache-safe, batched compaction
                              • host-side orientation & verification             • progressive tool schemas
                              • constrained decoding for tool turns              • task-scaled thinking/output budgets
                              • prefix-stable prompt for KV reuse                • result shaping at source, budget guard
                                          └───────────────────────────┬──────────────────────┘
                                                                      ▼
                                              Reliability Governor (live counters → ladder up/down)
                                                                      ▼
                                          Transparency panel: "why this setup" + savings ledger
```

### 5.1 Core data structures

**5.1.1 Assist Vector** (replaces the single `low|medium|high|max` enum; levels remain as named presets for UI/back-compat)

| Dimension | Range | Local small default | Cloud default |
|---|---|---|---|
| `toolCardMode` | `names_only` · `shortlist` · `full` | `shortlist` | `full` (schemas) |
| `examples` | `0 / per-shortlist / all` | per-shortlist | 0 |
| `stateCard` | `off` · `compact` · `rich` | `rich` | `off` |
| `hostOrient` | bool | on (agent/plan) | off |
| `hostVerify` | `off` · `diagnostics` · `diagnostics+tests` | on | off |
| `constrainedTools` | bool | on if probe-passed | n/a |
| `promptBudgetFrac` | 0.10–0.45 | scales with task *and* window | 0.05–0.15 |
| `samplingProfile` | tool-turn / answer-turn temps, top-k, repeat-penalty | split | provider default |
| `thinking` | `off` · `low` · `med` · `high` | off for tiny unless task=high | from task profile |

Presets map as: `max` ≈ everything on; `low` ≈ everything off. The **task** and the **live reliability score** move individual dimensions, not just the preset.

**5.1.2 Capability Passport** — persisted per `(model digest, quantization, runtime, hardware class)`:
`{ prior, bench{…, n, ci}, live{toolValidRate, repairRate, narrationRate, dupRate, truncRate, nativeOk, blockOk}, prefillTokPerSec, genTokPerSec, kvBytesPerToken, achievableCtx, lastSeen }`. Capabilities are `0.5·prior → bench → live` blended by evidence count (Bayesian-style shrinkage, so one bad turn doesn't condemn a model and one lucky probe doesn't crown one).

**5.1.3 Task Profile v2** — v1 fields plus: `needsVision/needsAudio`, `readOnly`, `expectedFiles` (from index/ProjectContext hits, not regex), `contextNeedTokens` (estimated from expected files' sizes), `sessionFailures` (this model, this session), `languageHint`.

### 5.2 Local: Guided Execution (the small-model engine)

**5.2.1 Per-step, shortlist tool surface** *(fixes L-1; quick win)*
- Call `selectToolSpecs` **each step** with the real phase (orient → edit → verify → final), inferred from the last tool results (e.g. just-edited file ⇒ `verify`).
- For `toolCardMode = shortlist`: render full cards + the worked example for ≤ 5–6 tools likely next; list the remaining tool **names with a one-line purpose** (≈ 10 tokens each). The parser already accepts any registered tool, so *access stays complete* — this honours principle #1 while cutting prompt size.
- MCP tools: names-only unless the task or user mentions them.
- **Acceptance:** median tool-card tokens per step ↓ ≥ 50 % on `tiny/small`; invalid/wrong-tool rate not worse than baseline on the eval suite.

**5.2.2 Host-driven orientation** *(new; biggest anti-hallucination lever)*
For Plan/Agent with `hostOrient` on, Photon (not the model) runs a deterministic pre-step: use index + ProjectContext + `search_code`/`find_files` on identifiers in the prompt, read the top 1–3 candidate files' relevant ranges, and place the result in the state card as "**Photon pre-read** — verified from disk". The model starts with real code in front of it instead of guessing paths. Mark clearly in the UI so it's auditable, and make it skippable when the task is a pure question.

**5.2.3 Host-driven verification + checkpoint guard** *(new)*
After any successful mutation, Photon itself runs `get_diagnostics` on the touched files and injects the result; for `tests`/`build` in the task profile it offers (or, in autoApprove, runs) the command. If diagnostics got **worse** than the pre-edit baseline, auto-restore via the existing checkpoint and tell the model "your edit increased errors from N to M; here they are". Small models forget to verify; this removes the dependency.

**5.2.4 Constrained tool-call decoding** *(R&D with a capability probe)*
- **Ollama:** structured outputs (`format` with a JSON schema) for the *tool-selection turn*; **llama.cpp:** GBNF/json-schema grammar where `root ::= prose | toolblock`.
- Caveats to verify before shipping: interaction with thinking models, with streaming, with prose-before-tool patterns, and with the extra latency of grammar sampling. Use the bench to decide per model whether constraining helps (some models degrade). Fall back to today's tolerant parser always.
- **Acceptance:** malformed-call rate (parse errors + repairs per 100 calls) ↓ ≥ 60 % on `tiny` models with no drop in task success.

**5.2.5 Step-scoped working memory (state card)** *(core of Guided Execution for ≤ 4B)*
Instead of letting the raw transcript grow, rebuild a compact card each step and drop stale raw tool output for tiny models:
```
GOAL: <user ask, verbatim>      CONSTRAINTS: <negatives from the user>
PLAN: [x] locate  [>] edit  [ ] verify          (from todo_write or host plan)
KNOWN: files read + line ranges · last tool result (clamped) · edits applied
NEXT: <one sentence from host policy, e.g. "verify src/a.ts with get_diagnostics">
```
This is the "recitation" idea: restate goal and progress at the *end* of context every step, where small models actually attend. The existing compactor already extracts the right facts (modified files, command outcomes, anchors) — reuse `buildNativeCompactionSummary` as the card source.

**5.2.6 Memory & speed model (fixes L-9, L-10, L-13)**
- **Exact KV cost** from `/api/show` `model_info`: `bytes/token = 2 × block_count × head_count_kv × head_dim × bytes_per_elem` (f16 = 2; q8_0/q4_0 if the runtime uses KV quant). Fall back to the current rule of thumb when keys are missing.
- **Calibrate with reality:** after first load, read Ollama `/api/ps` (`size`, `size_vram`) to see actual GPU/CPU split, and record it in the passport.
- **Prefill probe** in bench: time-to-first-token on a ~2k and ~6k-token prompt ⇒ `prefillTokPerSec`. Cap auto context so `ctx / prefillTokPerSec ≤ target TTFT` (e.g. 20–30 s worst case, configurable), instead of core-count buckets.
- **Prefix-stable layout** for Ollama's KV reuse: `[identity + mode rules + tool cards (shortlist stable within a phase)] → [project digest] → [history] → [volatile: retrieved RAG + state card + per-step nudge]`. Avoid rewriting older messages between steps unless over budget.

**5.2.7 Planner/executor micro-steps for `tiny` models in Agent mode** *(later, only if eval shows gain)*
One Plan-mode pass produces a 3–6 step checklist (stored via `todo_write`); each step then runs with a *fresh*, small context (state card + only that step's files). Costs more calls, wins on reliability for 2–4B. Gate by Bench v5 multi-turn score.

**5.2.8 Small fixes**
- Gate the **Language Integrity** paragraph by model family or replace with output post-filter (L-3b).
- Split sampling: tool turns `temp ≈ 0–0.1`, answer turns `≈ 0.2`; set `repeat_penalty`/`top_k` per tier; **disable thinking for tiny models** on `reasoning: low/medium` tasks (saves tokens and context).
- Trim the core prompt too when `numCtx` is small; make `buildSystemPrompt` return a section-level token report (feeds Phase 0 / E-2).

### 5.3 Cloud: Lean Execution (token savings first)

**5.3.1 Cache-ordered prompt with breakpoints** *(C-1, C-2; top quick win)*
Order the request from most- to least-stable, and place Anthropic `cache_control` breakpoints (up to four) accordingly:
1. **Tools** (stable per mode) — breakpoint #1 (already present on last tool)
2. **Static system instructions** (mode rules, formatting) — breakpoint #2
3. **Project digest / workspace map**, *rebuilt only when the workspace changed*, not per user query — breakpoint #3
4. **Conversation history** — **rolling breakpoint on the last stable message** each step — breakpoint #4
5. **Volatile per-turn context** (query-matched digest lines, timestamps, "relevant files for this query") as a trailing block of the **latest user message**, never in the system prompt.

For OpenAI-compatible/Gemini, the same ordering benefits automatic prefix caching; also pass provider cache-routing hints where the API supports them. Respect provider minimum-cacheable-prefix sizes and TTLs, and surface `cachedTokens / inputTokens` in the usage meter. **Acceptance:** cache-read share of input tokens ≥ 70 % on 5+ step agent turns (target; measure first).

**5.3.2 Cache-safe compaction** *(C-3)*
- Make compaction **append-only and idempotent**: once an old tool result is stubbed, it stays stubbed *the same way* so the prefix is byte-identical afterwards.
- **Batch it**: don't re-compact each step; compact when the saved tokens exceed a break-even threshold (≈ cost of re-writing the cache from the first modified message onward), or at turn boundaries.
- Prefer shaping results **at source** over rewriting them later (§5.3.5).

**5.3.3 Progressive tool schemas** *(C-4)*
Agent/Plan: send a **core schema set** (read/search/edit/run) and add specialised or MCP schemas only when the task profile or an earlier step calls for them; keep tool descriptions terse. Replace the regex `classifyCloudToolPolicy` with the shared Task Profile v2. Remember that changing the tool set invalidates the tool cache — change it rarely and at turn boundaries.

**5.3.4 Task-scaled budgets** *(C-5)*
Derive from Task Profile + model metadata: `thinking level` (off for read-only Q&A, low/med for implement, high only for debug/architecture), `max_tokens` by task kind (not 25 % of context), temperature per provider/model rules (**verify** which reasoning models reject it), and step budget from `estimatedSteps` with a guard on runaway loops.

**5.3.5 Result shaping at source** *(C-7)*
`read_file` default to symbol/line ranges with "N more lines" hints; `search_code` result caps with counts; `run_command` output head+tail with error-first ordering; `list_dir` depth caps; "unchanged since last read" stubs generated **at tool-return time** (not by later history rewrites). Add a per-tool token budget in the registry.

**5.3.6 Cost-aware cascade and budget guard** *(C-6, R-5)*
- Cascade within the user's configured providers: **cheap tier first** for read-only/simple tasks (e.g. a small/fast model of the same vendor), **escalate** to the stronger model on governor signals (≥ 2 invalid tool calls, repeated duplicate calls, failed verification). Never escalate local → cloud silently (keep current rule); cloud → cloud within a user-enabled "allow cascade" setting is fine.
- Optional **per-turn and per-session spend caps** using `CloudUsageTracker`; warn before, stop after, never mid-edit without checkpointing.

**5.3.7 Savings ledger**
Show, per session: tokens saved by *(cache reads · compaction · result shaping · tool-surface trimming · cascade)* vs. a naive baseline (full tools, no cache, no compaction). This is user-visible proof of the value of the feature and the data you need to prioritise future work.

### 5.4 Cross-cutting: Reliability Governor, bench, evals

**5.4.1 Reliability Governor** *(the moat)*
- **Signals per step:** parse failure, repair prompt issued, narration nudge, duplicate call blocked, truncation, empty response, tool error of class `invalid_args`, post-edit diagnostics regression, user "stop"/revert after a turn.
- **Ladder (local):** `L0 lean → L1 +state card → L2 +shortlist examples → L3 +constrained tools → L4 +host-orient/verify everything → L5 step-scoped micro-steps`. Move **up** after N signals in a window; move **down** after M clean steps (hysteresis prevents flapping). Start rung from passport + task profile.
- **Ladder (cloud):** `trim → full tools → cascade to stronger model → text-only conclude`. Reuse existing "force text-only next step" machinery.
- **Persist** the outcome into the passport (EWMA per signal) so the *next* session starts at the right rung. Keep it local-only by default (fits the local-first promise).
- **Transparency:** show "escalated scaffolding after 2 invalid tool calls" in the turn, and a settings toggle to freeze the level.

**5.4.2 Router v2** *(R-1..R-5)*
1. **Hard constraints first:** needs vision/audio, local-only privacy, hardware `tight`/won't load, achievable context < task floor ⇒ excluded (not just penalised).
2. **Score** the survivors with the existing weights, using `achievableCtx` and passport capability (bench ⊕ live).
3. **Cost cascade** for cloud (5.3.6).
4. Keep `decision.scores[]` fully explainable in the Transparency panel.

**5.4.3 Bench v5**
- **Multi-sample** (≥ 5 per skill, pass-rate with confidence interval) instead of single shots; seed varied.
- **Under the real prompt:** run probes with the *actual* system prompt, tool cards and a realistic window (not `num_ctx: 4096`).
- **Test the protocol you'll use:** probe photon-block **and** native separately; store both (fixes L-6).
- **Multi-turn mini-agent tasks** in a disposable workspace (reuse `evaluateRepoTaskInDisposableWorkspace`): find file → edit → verify, 3–5 tasks of rising difficulty; score by success, steps, and malformed-call count.
- **Prefill and context-retention probes** at 2k / 6k / 12k.
- **Continuous scores** feeding the capability profile instead of constants chosen by one pass/fail.
- Run in the background after model pull / on first use; resumable; < 2–3 min on a typical laptop for a 3B (target).

**5.4.4 Eval + ablation harness (CI + local CLI)**
- A fixed suite of 30–50 small repo tasks (bug fix, add param, rename across files, explain code, write test, fresh-info question) with automatic pass/fail.
- Matrix: 3–5 local models (≈ 2B, 3–4B, 7–8B, 14B) × scaffolding on/off × each Assist-Vector dimension (**ablation**), and 2–3 cloud models × cache/compaction/tool-surface settings.
- Outputs: task success, steps, invalid-call rate, tokens (in/out/cached), cost, TTFT. Use results to **fit the policy table and router weights** instead of hand-tuning, and to publish a "Photon scaffold lifts qwen-3B success from X → Y" scorecard — a real marketing asset for the moat.
- Gate releases: no regression > 1–2 points on any tier.

**5.4.5 Observability**
- Per-turn **prompt token breakdown** (identity / mode / tool cards / state card / digest / map / RAG / history) in the Transparency panel and logs.
- **Reliability event log** and **cache hit-rate** shown with cost.

---

## 6. Roadmap

Effort: **S** ≤ 2 days · **M** ≈ 1 week · **L** ≈ 2+ weeks. Sequence assumes one main developer; items in a phase are mostly independent.

### Phase 0 — Truth and instrumentation (≈ 1 week)
| Task | Files | Done when |
|---|---|---|
| P0.1 Prompt token breakdown per section (local & cloud) | `system.ts`, `cloudSystem.ts`, engines, ContextMeter | Breakdown visible in logs + Transparency panel |
| P0.2 Reliability event counters (parse fail, repair, narration, dup, trunc, empty, regress) per turn | `unifiedEngine.ts`, `cloudEngine.ts`, `repair.ts` | Events logged with model, protocol, task profile |
| P0.3 Surface `cachedTokens / inputTokens` next to cloud cost | `cloudUsage.ts`, UI | Hit-rate shown per turn and session |
| P0.4 Baseline eval run (even 10 tasks, 2 models) | new `test/eval/` | A committed baseline table to beat |
| P0.5 Correct the v1 doc (§3 above) | docs | Spec matches code |

### Phase 1 — Quick wins (≈ 1–1.5 weeks)
| Task | Finding | Files | Acceptance |
|---|---|---|---|
| P1.1 Per-step phase + shortlist tool cards | L-1 | `unifiedEngine.ts`, `policy.ts`, `renderToolInstructions` | −50 % tool-card tokens on `tiny/small`; no success loss |
| P1.2 Rolling history breakpoint; move volatile text out of system prompt | C-1, C-2 | `anthropicProvider.ts`, `PhotonController.runCloudTurn`, `cloudSystem.ts` | Cache-read share ↑ on multi-step turns |
| P1.3 File-ref regex fix (require path separator, `@`, or known extension; strip versions/`e.g.`) | T-1 | `policy.ts` | Unit tests for false positives |
| P1.4 Router: vision/audio hard constraint; use `numCtx` for fit; exclude `tight` | R-1..3 | `autoMode.ts` | New routing tests; image attach never picks text-only model |
| P1.5 Gate native protocol on a native probe; add runtime downgrade after N bad native turns | L-6, L-7 | `policy.ts`, `bench.ts`, engine | No local model on native without evidence or provider flag + guard |
| P1.6 Language-integrity text gated by family/post-filter | L-3b | `system.ts`, `cloudSystem.ts` | Tokens saved; no regression in output language |
| P1.7 Tiering: quant penalty, MoE `aNb`/`-a3b` tags, family hints | L-4 | `modelProfiler.ts`, `policy.ts` | Table-driven tests incl. real tag examples |

### Phase 2 — Local Guided Execution (≈ 3–4 weeks)
P2.1 Assist Vector + presets (back-compat with 4 levels) · P2.2 State card (reuse compactor facts) · P2.3 Host orientation · P2.4 Host verification + checkpoint guard · P2.5 Exact KV math + `/api/ps` calibration · P2.6 Prefill probe + TTFT-based context cap · P2.7 Prefix-stable prompt layout · P2.8 Split sampling + thinking policy · P2.9 Constrained decoding spike (per-model probe, feature-flagged).
**Exit criteria:** on the eval suite, `tiny`/`small` task success ≥ +X points over Phase-0 baseline (set X after P0.4; aim for double-digit), invalid-call rate −60 %, median TTFT within target on mid-tier laptops.

### Phase 3 — Cloud Lean Execution (≈ 2–3 weeks, can overlap with Phase 2)
P3.1 OpenAI/Gemini prefix-cache ordering + hints · P3.2 Cache-safe, batched compaction · P3.3 Progressive tool schemas on shared Task Profile · P3.4 Task-scaled thinking/output/temperature · P3.5 Result shaping at source · P3.6 Cascade + budget guard · P3.7 Savings ledger.
**Exit criteria:** input-token cost per *solved* task ↓ ≥ 30–40 % vs. Phase-0 baseline at equal or better success (target; validate), cache-read share ≥ 70 % on 5+ step turns.

### Phase 4 — Reliability Governor, Bench v5, Passport (≈ 3 weeks)
P4.1 Capability Passport store · P4.2 Governor ladder + hysteresis · P4.3 Bench v5 (multi-sample, real prompt, both protocols, multi-turn, prefill) · P4.4 Router v2 using passport · P4.5 Eval/ablation CI and policy fitting · P4.6 Planner/executor micro-steps (if ablation justifies).

### Phase 5 — Product surface (≈ 1–2 weeks)
"Why this setup" card per turn (model, assist vector, context window, protocol, why) · Savings ledger · Governor timeline · "Freeze adaptivity" per project · onboarding step that runs Bench v5 with a progress bar and explains results in plain language · public scorecard page generated from the eval harness.

---

## 7. How we'll know it's working

| Track | Metric | Source |
|---|---|---|
| Local | Task success by tier (`tiny/small/medium`) | Eval suite |
| Local | Malformed/repaired tool calls per 100 calls | Governor events |
| Local | Narration/duplicate/truncation nudges per turn | Governor events |
| Local | Median steps to success; time to first token; swap/OOM incidents | Eval + passport |
| Cloud | Input / output / cached tokens per solved task; cache-read share | `CloudUsageTracker` |
| Cloud | Cost per solved task; quality parity vs. baseline (≤ 1–2 pt drop) | Eval |
| Both | Router regret: cases where a different model would have succeeded cheaper | Eval replay |
| UX | % of turns where adaptive setup was overridden by the user | Settings telemetry (local only) |

---

## 8. Risks and open questions

- **Scaffolding can backfire.** More instructions can hurt some models. That's why ablation (5.4.4) comes before trusting any new rule, and why each Assist-Vector dimension is independently switchable.
- **Cache economics differ per provider** (breakpoint count, TTL, minimum prefix, write surcharge). Re-check current docs per provider when implementing P1.2/P3.1; don't hard-code assumptions.
- **Constrained decoding** can reduce quality or conflict with thinking/streaming on some models — treat as probe-gated, per-model.
- **Host-driven orientation** can pre-read the wrong file. Keep it visible, clamp it, and let the model override; track when it was wrong.
- **Privacy:** the Passport and Governor logs stay on-device by default. Any shared "community prior" must be opt-in and anonymised — decide this deliberately because local-first is a core promise.
- **Unmeasured today:** actual size of the local tool-instruction block, real cache hit rates, and the net effect of per-step compaction on cloud cache reads. Phase 0 exists to replace these guesses with numbers before large changes land.
- **Not audited:** `indexService.ts` retrieval quality, `compactor.ts` summarisation quality, `errorRecovery.ts`, and the webview. The plan touches them only via the interfaces named above.

---
