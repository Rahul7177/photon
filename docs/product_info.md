# Photon — Product Info

## What Is Photon?
Photon is a **VS Code extension for agentic coding with small local models** — and with cloud models when you need them. It makes 3–8B models on everyday laptops actually finish multi-file tasks by automatically tuning the prompt, the tools, and the context window to your exact machine and model. No prompt engineering. No context math.

**Local-first.** Your code stays on your machine via **Ollama** (`http://localhost:11434`) and **llama.cpp** (`http://localhost:8080` OpenAI-compatible) by default. Add a cloud key only if you want an overflow. No pool-of-free-keys trick — you use only keys you own.

---

## The Three Ways to Work
Switch anytime in the header.

| Mode | What happens | Best for |
|------|--------------|----------|
| **Chat** | Pure conversation. No tools. Photon answers with text and code snippets. | Questions, explainers, `let vs const?` |
| **Plan** | Read-only investigation (`read_file`, `list_dir`, `find_files`, `search_code`). Photon returns a **numbered plan** naming exact files and functions. Nothing is changed. | “Plan the auth refactor” |
| **Agent** | Photon **edits files and runs commands**, one small verified step at a time, asking before every write/execute. | “Migrate X, fix tests, handle errors” |

Limits: `Chat 1 step / Plan 50 steps / Agent 100 steps`. You can say *continue* if it hits the cap.

---

## How Photon Chooses for You (and Shows Its Work)

### Auto Mode (Recommended)
Photon classifies your task as **simple / moderate / complex** from words (`refactor, migrate, throughout` vs `explain, summarize`) + file references + estimated steps. Then it ranks every installed model:

**Context fit (dominant) + headroom + measured speed + measured tool reliability + tier match + local preference (tiny bonus) + efficiency.**  

Scores are weighted constants, not magic — e.g. `toolReliability 22 pts`, `throughput 18`, `contextMisfit -24`. A pinned model always wins, but is still ranked so you see *why* the alternative was skipped. Everything appears in the **Transparency Panel** (`◎` in the header): chosen model, why (signals, required context), top-6 ranked with context warnings, and a one-click **Pin** per project.

### Manual Intelligence
Override with `Auto / Low / Medium / High / Max` in Settings. Each level is a real knob set:

| Level | Tools exposed | One vs parallel | Output cap | Prompt detail | Map lines | Output budget |
|-------|---------------|-----------------|------------|---------------|-----------|---------------|
| Low | 5 | one/turn | 768 | terse, directive | 18 | 4000 |
| Medium | 8 | one/turn | 2048 | standard | 50 | 8000 |
| High | 14 | parallel allowed | 4096 | elaborated + multi-file guide | 90 | 16000 |
| Max | 18 | parallel allowed | 8192 | fully scaffolded | 130 | 32000 |

All temperature/topP are also level-specific (`taskTemp 0.2 → 0.4`, `chatTemp 0.5 → 0.7`).

### The Plan It Builds For You
From `(machine + model + mode + intelligence)` Photon decides:

* **Context window** — `model.contextLength ?? 8192`, capped by your RAM (`low 8192 / mid 16384 / high 32768` via `PowerShell / nvidia-smi / system_profiler`). Your per-model or global override (`numCtx`) wins over the cap. Visible rationale: *“Capped context to 16k for mid-tier (7GB free); model supports 32k.”*
* **Tool protocol** — Forgiving **`[TOOL name] arg: value [/TOOL]`** for weak models; tool-trained `medium|large` can auto-upgrade to **native** function calling. Cloud defaults to block unless you opt-in `cloudNativeTools`.
* **System prompt budget** — `budget = floor(numCtx × 0.16→0.32)`, min 256. Core (identity + mode + tools + formatting) always kept; file map and retrieved code are added only while they fit.
* **Max output** — `clamp(256 … min(outputCap, numCtx-reserve, numCtx*0.5))`.

You see the whole plan chip in the footer: `high (auto) · block tools · 32,787 ctx` with the full rationale on hover.

---

## Model Support — See Capabilities Before You Send

### Capability Badges (everywhere)
Next to the context meter, on the model picker, and on every Cloud card:

`◈ Tools` (always, via block) · `◉ Vision` · `♫ Audio` · `▶ Video` · `✦ Think` · `32k ctx`

Compact in the header, full in **Settings → Machine & model** and **Composer**. Detected from Ollama `capabilities`/`model_info`/`template` and from name hints, with cloud live-list `inputTokenLimit` passthrough.

### Local — Ollama + llama.cpp (both first-class)
* **Ollama** — any `ollama pull`’d model. Photon profiles it: `context_length` from `model_info`, else `num_ctx` from `modelfile`, else family guess (`qwen 32768, llama/gemma 8192, phi 16384`). Tier `tiny <4B / small <8.5B / medium <20B / large`. `keepAlive 30m` so models stay resident between turns.
* **llama.cpp** — run `llama-server -m model.gguf --port 8080`. Photon hits `http://localhost:8080/v1/models` and **auto-discovers** `llamacpp:*` models — no manual “Add” needed. Appears alongside Ollama under **Local**. No API key required.
* **Visibility:** `Local` shows `ollama + llamacpp`; `Cloud` hides both. No leaky mixing after the recent picker fix. Short display strips provider prefix (`gemma-4-E4B-it-GGUF:Q4_0 · medium · 7 tok/s`) with full name on hover.

### Cloud — Bring Your Own Key (BYOK)
Keys live in **VS Code SecretStorage** (`photon.provider.<id>.apiKey`), never in `settings.json`.

| Provider | Endpoint | Live listing | Catalog |
|----------|----------|--------------|---------|
| **Gemini** | `generativelanguage.googleapis.com` | `v1beta/models` (`generateContent` filter) | all `generateContent` models |
| **Claude** | `api.anthropic.com` | `v1/models?limit=100` paginated | all |
| **OpenAI** | `api.openai.com/v1` | `GET /models` | all |
| **NVIDIA NIM** | `integrate.api.nvidia.com/v1` | `GET /models` | all |
| **OpenRouter** | `openrouter.ai/api/v1` + `HTTP-Referer/X-Title` | `GET /models` | all |
| **OpenCode Zen** | `opencode.ai/zen/v1` | `GET /models` | all |
| **Blackbox** | `api.blackbox.ai` (`keyInBody`, `Agent-Id`) | **no** live (manual) | 4 curated: `blackboxai-pro (+ plus 128k, vision+think), 1.5-8b, llama-3.3-70b` |
| **Custom** | any OpenAI-compatible | `GET /models` | inferred tier/cap via regex |

Flow: Enable → paste key → **Refresh** fetches *only* what your key can use → **Test** (tiny `ok` completion, measures `ms`) → **Add to picker** (`globalState photon.customModels`). Remove with `✕`. Custom endpoints are `id` derived from label.

### What Auto Considers When Ranking
`contextWindow` vs task `minContext (simple 2k / moderate 6k / complex 12k)` plus your machine tier + bench-measured `tok/s` & tool reliability. Local gets +4 `localPreference` tie-break; simple tasks get `efficiency +6` for smaller models that still fit.

---

## Tools — What Photon Can Do For You

Weak models get **5 tools**, capable local gets **14**, `max` gets **18**, cloud gets **100**. Filtering is hard-gated by `minTier` and sorted by `priority`.

**Core workspace (priority order, low → high):**

| Tool | What you see | When it appears | Safety |
|------|--------------|-----------------|--------|
| `read_file path, start_line?, end_line?` | File with `0001 │` gutters, `lines 1-600 of 3421 [continues…]`; auto-chunks (`600/1200/2500/4000` lines by capability). | Low+ | read-only |
| `edit_file path, find!, replace!, replace_all?` | Exact find→replace; tries exact → gutter-stripped → whitespace-trimmed fuzzy; errors if ambiguous. Preserves `EOL`. | Low+ | **asks** |
| `write_file path, content!` | Full create/overwrite; `Created/Overwrote N lines M bytes` | Low+ | **asks** |
| `find_files query!` | `vscode.workspace.findFiles` substring or `**/*.test.ts` glob, `cap 25→150` by capability | Low+ | — |
| `list_dir path?, recursive?` | Sorted dirs-first; recursive BFS depth ≤2 capped 400 | Low+ | — |
| `search_code query!, is_regex?, case_sensitive?, path?, include? (*.ts), context_lines 0-4` | `N matches in F files` with `bytes` & `depth` guards `4000 files / 512KB / 25 depth`, parallel batches of 4, `15k` clamp | Low+ | — |
| `get_diagnostics path?, errors_only?` | `ERROR file:line:col [source]: msg` via `vscode.languages.getDiagnostics`, capped `20/50` shown, hard `200` | Low+ | — |
| `run_command command!, description?, timeout_ms?` | Shell in workspace root, `windowsHide`, `1MB` buffer, timeout `60s` (max 300s cloud is 180/600s), `Exit code N` | Medium+ | **asks** |
| `move_path from!, to!` | Rename/move, cross-device `cp+rm` fallback | Medium+ | **asks** |
| `code_outline path!` | Functions/classes/types with line numbers, 200 hits max | Medium+ | — |
| `todo_write items!` | Checklist `[ ]/[>]/[x]` per line, forgiving (`- ` prefix stripped, unprefixed → pending), persists in `ctx.todos` | Medium+ | — |
| `think thought!` | Private scratchpad (no output to you) → `Noted. Continue…` | Medium+ | — |
| `web_search query!` | DuckDuckGo HTML fetch `15s`, `result__a / result__snippet` parse, `max 5→8` by capability; disabled if `webSearch=none` | High+ | — |
| `web_fetch url! (https?), start_line?` | Fetches page, `htmlToText` strips scripts/nav, `2M` slice, `400` non-empty lines paged | High+ | — |

All tool outputs are **clamped** (`Tools 4k/8k/16k/32k` by capability) with `… [truncated N]` so a huge log never blows your window.

**Cloud-only names for frontier models (same power, familiar names):** `write_to_file`, `replace_in_file`, `execute_command`, `search_files`, `list_files`, `list_code_definition_names`, plus lifecycle `ask_followup_question` and `attempt_completion` (“call when fully done with Markdown summary”) which end the turn without touching the workspace.

**Anything else via MCP:** Any `mcp` server from `.vscode/mcp.json` (`stdio` via `npx/node/python/uvx/bun/deno` allowlist, or `http` `http(s)://`). Its tools become `mcp_<id>_<tool>` (`priority 9`, `minTier medium`, `tags [mcp]`), always require approval, shown as `pending → approved → connected / error / revoked`. Revoke is one click.

---

## Context & Performance You Can See

**Meter:** `used / window` bar under the chat, amber at `>80%`. `window` is the *effective budget* (`numCtx - reservedOutput 1024`), not the raw window. Tooltip: `System 1.2k + History 2.8k / Budget 7k`. The original task message is **never** dropped.

**Live `tok/s`:** While streaming you see `⚡ 42 tok/s · 128 tok` next to the meter (`accChars/4`, throttled `250ms`). Clears to idle.

**Token math:** Lightweight heuristic `max(chars/4, words×1.3)` including `4` overhead per message + tool-call overhead — good enough for small windows, swappable per-model later.

---

## Workspace Understanding (Offline-First)

Photon watches your workspace and builds a **local vector index** — no network, no server.

* **What it indexes:** `**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cs,…}` up to **1500 files × 256KB**, ignoring `node_modules/.git/dist/out/.next/.venv/__pycache__/.turbo/coverage`.
* **How it chunks:** Sliding window `60 lines` with `12 overlap` (step 48), drops empty chunks, caps `4000 chars` per chunk and **80 per file**.
* **How it embeds:** Batched `24` texts per `ollama /api/embed` via local `nomic-embed-text` (or your `photon.index.embeddingModel`). Vectors are unit-normalized; store is pure-TS dot-product linear scan, capped **8000 chunks** (fifo drops oldest *file*).
* **How it helps:** On each agent/plan turn Photon retrieves top **6** chunks (cosine, threshold `0.2`) bounded to **4000 chars**, injected as `Relevant code … path:start-end` into the system prompt. Medium+ only — `low` skips retrieval to save budget.
* **You see:** `idle / indexing / ready / unavailable / error` with `files, chunks, pending` in Settings, plus a manual **Re-index now**. Persisted to `globalStorage/index-<hash>.json` (workspace path hash) with `dim` validation.

---

## Per-Model Personalization (Local Power Users)

**Settings → Per-model configuration** lists *only* local models (`ollama`/`llamacpp`). Expand a row:

* **Every local model:** `Context window` (`numCtx`), `Note`
* **llama.cpp only:** `-ngl` (`all` or `0..N`), `--fit` on/off, `-np` (slots), `-fa` on/off, `-ctk` (`q8_0`), `-ctv` (`q8_0`), `Extra args` (`--jinja …`). Live preview builds the exact `llama-server -m <gguf> -c 32768 -ngl all --fit -np 1 -fa on -ctk q8_0 -ctv q8_0 --port …` — **Copy** and restart `llama-server` with it.

Resolution: **per-model `ctx`/`llamacpp.ctx` → global `userNumCtx` → `.photon/config.yaml` → adaptive RAM cap**. Both the turn plan (`buildPlan`) and `cloudPlan` respect the per-model ctx.

Teams can also check in `.photon/config.json|yaml|yml` (flat YAML, versioned) with `model, intelligence, numCtx, indexing, autoApprove` — file wins over defaults, personal per-model wins over file, and the file watcher hot-reloads without restart.

---

## User Interface — Every Surface

**Shell:** Centered `860px` column even when you stretch the VS Code panel wide; `gutter 10px`. Your bubbles align **right** (`var(--space-700)`), Photon left; code blocks inside user bubbles expand to full width. Markdown is capped at `72ch` for scan.

**Header** (two-row, calm):
- *Top*: `Chat | Plan | Agent` tabs (red underline) left, **Photon** orbital wordmark right at the same baseline.
- *Bottom left*: `Local | ☁ Cloud` toggle + **Model picker** (`Auto 🤖` + `display = without provider prefix`, `tier · tok/s` suffix, `max-width 320px` ellipsis). 
- *Bottom right*: `Auto Mode ◎`, `History 🕒`, `Refresh ↻`, `New +`, `Settings ⚙`.

**Hero (empty state):** Title *Start a conversation*, subtitle, model line, and **3 mode-specific suggestion** cards that are now `grid auto-fit 240px` so they don’t stretch.

**Messages:** Streaming `Markdown` (`inline code`, `fenced block` with language tag + **Copy** on hover), **Tool Cards** (collapsible, dot `proposed grey / running amber pulse / done green / error red`, mono args ellipsis, `max-height 220px` result), **Approval cards** (write/execute → `Approve / Deny` + optional *remember*). Attachment thumbnails (`180px` image or `📄` doc chip).

**Composer:** `ContextMeter` top inside the input area, optional compact badges (now merged into the meter line to avoid duplication), `attach-error`, `attach chips` (`×` now `22×22`), `input-wrap` (`+ Attach` — now `space-700`, transparent border — + auto-grow `textarea 160px` + `↑ Send / ■ Stop`). **Drag-drop** anywhere on the composer + **paste (Ctrl+V)** of screenshots/files create chips via `readFileToAttachment`. Vision-gated `accept`: blocks images if `!model.vision` with a clear error. `Enter` sends, `Shift+Enter` newline.

**Panels:**
* **History** (from `Clock`): popover `260×320`, sorted `updatedAt desc`, `title` ellipsis + `mode · count · time`, `×` delete on hover.
* **Transparency** (from `◎`): `Auto-select` checkbox, chosen model + `auto/pinned` badge, reason line, `level · files · steps · needs ctx` chips, ranked `scores` (warn `⚠ ctx` if `!fits`) with **Pin** per row. One click to pin.
* **Settings** (full-page): `Intelligence grid` (Auto/Maximum/High/Medium/Low), `Adaptive engine` toggle + `rationale ul`, `Global context override` (commits on blur) + per-model hints, **Per-model configuration** section, `Tools` (auto-approve, web search `duckduckgo/none`, tool list with `writes` badge), `Workspace index` (toggle, status, Re-index, embedding model), `MCP servers` (`pending→connected` + `Approve/Revoke`), `Model benchmarks` table (`tok/s · tools% · reason ✓/✕ · ↻`), `Machine & model` (`tier RAM cores GPU`, model `tier param quant`, badges, raw caps, *View full diagnostics*), `Connection` (`ollamaBaseUrl` + reachable), `Cloud providers` intro + cards per provider.

**Cloud Provider Cards:** Letter logo color, `✓ Connected / No key`, `N added`, `› Expand + Toggle`; inside: hint, **API Key** (`password` + `👁/🙈` reveal + `Connect / Clear` + `Get key ↗` docs), **Models available to your key** + `↻ Refresh` + error banner + manual input for `blackbox` + chip rows (`mono id + compact badges + Test › + spinner ⧗ / ✓ Nms / ✗ error + Add to picker / ✓ Added ✕ remove`).

**System chrome:** `OfflineBanner` (local unreachable), `ErrorBanner` dismissible, `StatusIndicator` (`Thinking` / `Running toolName` + spinner + animated dots), `MCP/Bench/Settings` hints dim.

**Focus & scroll:** `*:focus-visible` red `1.5px`, icon buttons `28×28`, custom `6px` scrollbar `space-500`.

---

## Persistence & Safety

| Store | What | Where | Limit |
|-------|------|-------|-------|
| **Sessions** | Every turn | `globalState photon.sessions` sorted `updatedAt desc` | `40 sessions`, persisted **200 msgs / 8k chars msg / 6k tool result**, `KEEP_INLINE_IMAGES 4` newest base64, JSON `4MB` guard drops oldest. Live cap `400 msgs` (`MAX_CONTENT 250k` per message in webview). |
| **Project** | Pinned model, approved MCP ids | `workspaceState` per workspace | — |
| **Bench** | `tok/s, firstTokenMs, toolCallReliability, reasoningPass` | `globalState photon.bench` key `model+hardwareClass+methodologyVersion 1` | `200` latest `ranAt` |
| **Per-model configs** | `numCtx, llamacpp` per model | `globalState photon.perModelConfigs` | — |
| **Custom models** | After-test added cloud models | `globalState photon.customModels` | — |
| **Secrets** | All cloud (+ optional llamacpp) keys | `secrets photon.provider.<id>.apiKey` | never plaintext |
| **Index** | Vectors | `globalStorage/index-<hash>.json` `version 1, dim` | validation drops mismatched dims |
| **Queues** | In-flight prompt queue | in-memory `promptQueue` | inbox-style drain sequential |

**Approval:** Every `sideEffecting` tool (`write/edit/move/run_command` + MCP) goes through `requestApproval` → `ToolApprovalRequest` UI → promise → `projectState` can remember. Abort `turnAbort` cancels generation (`reader.cancel`) and resolves pending approvals as denied.

---

## Protocol & Prompting (Why Small Models Still Follow)

**Canonical:** ` [TOOL name] arg: value [/TOOL]` with `arg: value` per line; multi-line via ` ``` fence`. Rendered verbosity scales by intelligence (`low` one-line specs vs full bullets with `[changes workspace]`). Native `tools` JSON (`type: function, parameters + required`) is only sent when `toolTrained && tier medium|large`.

**Forgiving parser** accepts *all* of these and maps to the same `ToolCall` (overlap-deduped, start-sorted):

* `[TOOL]…[/TOOL]` + truncated unclosed tail
* `<tool_call> JSON | <|tool_call>call:NAME \n path: .` (Gemma pipe + plain key: value, with unclosed-trail handler)
* ```json / `tool_call` / `tool` fences
* bare `{ "name":…, "arguments":{…}}` balanced-JSON scan (capped `50` objects, `200` brace attempts O(n²) guard)

Greedy `content/find/replace` fence fallback, `coerce` (`string→String, number→Number, boolean yes/true/1 → true`), `Missing required` / `expected type` errors fed back. `tool result` → `[RESULT/ERROR name]…[/RESULT]` (`tool` role for native, `user` for block). Truncation noted on final message.

**System prompt builder:** Identity + workspace name + mode prompt + tool instructions + (if `mode≠chat`+`level≠low`) multi-file guide + *budget-checked* `workspaceMap` (`MAP_LINES`) + *bounded* retrieved code (`fitBlock 40 token min`) + formatting. Budget `floor(numCtx × fraction)` clamped `256`.

---

## Diagnostics & Performance

**Status bar:** `Photon: <model> | Auto | (error)` (+ tooltip reasoning).

**Bench (Photon Bench, M7):** Short deterministic `num_ctx 4096, num_predict 160, seed 7`: 1) throughput (`Write add(a,b)` via `eval_count/eval_duration`), 2) `2×` tool-call `read_file` reliability, 3) reasoning (`[]+3×2 → 6`). Auto-kicks for local models without a result; never competes with a turn; one-click **Benchmark all** / `↻` per row; hardware class derived (`totalRam ≥32 or vram≥12 → high, ≥16 or vram≥6 → mid else low` via `nvidia-smi` / registry `QP...MemorySize` / `system_profiler`).

**Live tok/s:** `tps = ceil(accChars/4)/elapsedMs×1000`, throttled `250ms`, emitted via `onGenerationStats` (`cloudEngine` + `engine` `250ms`), cleared on `onDone`/`onError`/abort. Shown as `⚡ 42 tok/s · 128 tok` pill.

**Engine resilience:** `streamRetries 1`, `emptyStreak ≤2` (“Your reply arrived empty…”), `continuations ≤5` for `length/max_tokens` or unclosed ` ``` ` or `!doneReason && toolsRun>0` (“Continue EXACTLY where you stopped”), `continueNudges ≤5` for `format` (`[TOOL` in prose) / `continue` (`let me, now let…`), duplicate `path-keyed` guard `5× → stop`, identical `raw` loop `4→nudge else stop`, `failStreak 2+` appends `spec.example`.

---

## Security & Privacy
Local by default, no telemetry required. Indexed code never leaves the machine. Cloud keys encrypted in `SecretStorage`; MCP `stdio` allowlist `npx/node/python/uvx/bun/deno` + `BLOCKED_ARG_RE` (`rm -rf|sud o|chmod +x| |sh|;`) + env filtered to `PATH/NODE_ENV/PYTHONPATH/MCP_*`, http only `https?://`. Official MCP SDK imports are `pending → approved → connected`.

---

## Why Photon Exists (in one paragraph)
Cloud-first agents assume strong models and large contexts. On small local models they drown the context, expose too many tools, and fail on malformed tool calls. Photon does the opposite — it **adapts down**: terse prompts for small windows, fewer tools, capped budgets, and forgiving parsing with repair. That’s why a 7–8B model can finish multi-file edits here when it stalls elsewhere — and when you *do* need a frontier model, your own cloud key is one click away without ever pooling free tiers.

