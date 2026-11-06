# Photon — Comprehensive Documentation

> Version 0.1.0 · VS Code `^1.90.0` · License MIT
> Agentic coding with small local LLMs — tuned so low-end models actually cope,
> with cloud frontier models available as BYOK overflow.

This document is a complete inventory of what Photon implements, how it is
architected, the design theme it uses, and how to build / configure / extend it.
It reflects the codebase as shipped in `photon-0.1.0.vsix` (312 KB, 14 files).

---

## 1. Overview & Philosophy

Photon flips the usual AI-extension priorities: instead of designing for
frontier cloud models and bolting local support on afterwards, it is built
**local-first for the 3B–16B parameter class** (Qwen2.5-Coder, Qwen3,
DeepSeek-Coder-V2-Lite, Gemma 3, Devstral Small) and adapts prompts, tool
protocols, and context budgets down to the machine + model at hand.

- **Local-first.** Ollama (`http://localhost:11434`) and llama.cpp
  (`http://localhost:8080/v1`) are first-class. Code stays on-machine.
- **Adaptive down.** Terse prompts, fewer tools, capped budgets for small
  windows; rich scaffolding only for capable models.
- **Forgiving protocols.** The `[TOOL name] arg: value [/TOOL]` block protocol
  plus a multi-format parser lets weak models call tools reliably; repair loops
  correct mistakes instead of dying silently.
- **Cloud when needed.** Gemini, Claude, OpenAI, NVIDIA NIM, OpenRouter,
  OpenCode Zen, Blackbox AI, and any OpenAI-compatible endpoint — keys in VS Code
  `SecretStorage`, never plaintext.

See `README.md`, `docs/product_info.md`, `docs/Usecase.md`.

---

## 2. Feature Inventory

### 2.1 Interaction modes (header tabs)

| Mode | File | Behavior | Step cap |
|------|------|----------|----------|
| Chat | `src/core/agent/*` | Pure conversation, coding Q&A, code snippets, no side effects | 6 |
| Plan | `src/core/agent/*` | Read-only investigation (`read_file`, `list_dir`, `find_files`, `search_code`), numbered plan, nothing changed | 10 |
| Agent | `src/core/agent/*` | Full autonomous coding: edits + commands, one verified step at a time, approval-gated | 25 (cloud safety net 200) |

`Chat 6 / Plan 10 / Agent 25` are hard caps (`MODE_CAPS` in
`src/core/agent/unifiedEngine.ts`). Saying *continue* starts another turn.

### 2.2 Adaptive engine (Auto Mode)

Five-stage plan per session (`src/core/adaptive/`):

1. **Machine profiling** (`machineProfiler.ts`) — RAM/CPU/GPU
   (`nvidia-smi` / registry / `system_profiler`), tier low/mid/high; caps context
   (`low 8192 / mid 16384 / high 32768`).
2. **Model profiling** (`modelProfiler.ts`) — params, quantization, family,
   `context_length` (from `model_info`, else `num_ctx` in modelfile, else family
   guess), tool/vision/audio/video/thinking flags, tier
   (`tiny <4B / small <8.5B / medium <20B / large`). Results cached by
   `name@digest` (10-min TTL, 50 entries) to avoid repeat `/api/show`.
3. **Task analysis** (`intelligence/policy.ts`, `adaptive/complexity.ts`) —
   scope (`single_file / multi_file / codebase`), reasoning, risk, verification
   kinds, ambiguity, estimated steps from keywords + file refs.
4. **Benchmark integration** (`core/bench/bench.ts`, `host/benchStore.ts`) —
   measured `tok/s`, tool reliability, reasoning pass; keyed
   `model+hardwareClass+methodologyVersion`.
5. **Optimization** (`adaptive/orchestrator.ts`, `adaptive/autoMode.ts`) —
   picks model + intelligence level with human-readable `rationale` shown in the
   **Transparency Panel** (`◎`).

Intelligence levels (`intelligence/`): `auto / low (5 tools, 768 out) /
medium (8, 2048) / high (14, 4096) / max (18, 8192)`, each with temperature/topP,
prompt detail, map lines, and output budget.

### 2.3 Tool system (14 built-in + cloud + MCP)

Registry: `src/core/tools/registry.ts` (priority selection, `minTier` gating).

| Tool | File | Notes |
|------|------|-------|
| `read_file path, start_line?, end_line?` | `builtin/files.ts` | Gutter `0001 │` output, 200-line default cap, 2 MB + binary guard, range guidance |
| `edit_file path, find!, replace!` | `builtin/files.ts` | Exact → gutter-stripped → fuzzy match, EOL-preserving, ambiguity errors |
| `write_file path, content!` | `builtin/files.ts` | Create/overwrite, approval-gated |
| `append_file`, `move_path from!, to!` | `builtin/files.ts` | `cp+rm` cross-device fallback, approval-gated |
| `list_dir path?, recursive?` | `builtin/files.ts` | Dirs-first sort, ignores `node_modules/.git/dist/...`, BFS ≤ depth 2 / 400 entries |
| `find_files pattern!` | `builtin/search.ts` + VS Code index | Substring or `**/*.test.ts` glob, cap 25→150 by capability |
| `search_code query!` | `builtin/search.ts` | Regex, 4000 files / 512 KB / depth 25 guards, batches of 4, 15k clamp |
| `code_outline path!` | `builtin/search.ts` | Functions/classes/types, 200 hits max |
| `run_command command!` | `builtin/terminal.ts` | Single-command only (quote-aware chaining guard rejects `&& \|\| ; \| & $() backtick > <`), 60 s timeout (max 300 s), 1 MB buffer, approval-gated |
| `get_diagnostics` | `builtin/verify.ts` | `vscode.languages.getDiagnostics`, capped display |
| `web_search query!` | `builtin/web.ts` | DuckDuckGo (+Google fallback), 15 s, 5→8 results |
| `web_fetch url!` | `builtin/web.ts` | HTTPS-only, SSRF guard incl. decimal/hex/octal IP + IPv6-mapped + `.internal/.local`, manual redirect re-check per hop (max 3), 2 MB slice, script/nav stripped |
| `todo_write` | `builtin/plan.ts` | Checklist persisted in shared per-turn `ctx.todos` |
| `think` | `builtin/plan.ts` | Private scratchpad |

Cloud-native aliases for frontier models (`cloud/cloudTools.ts`):
`write_to_file`, `replace_in_file`, `execute_command` (same chaining guard),
`search_files`, `list_files`, `list_code_definition_names`, plus lifecycle
`ask_followup_question` / `attempt_completion`.

**MCP** (`tools/mcp/`): `.vscode/mcp.json` servers (`stdio` allowlist
`npx/node/python/uvx/bun/deno`, `BLOCKED_ARG_RE` incl. `-y/--yes/install`,
env filtered to `PATH/NODE_ENV/PYTHONPATH/MCP_*`; `http` HTTPS-only +
same-host redirect guard). Bridged as `mcp_<id>_<tool>`, default-deny
(`inferRisk` defaults unknown to `workspace_write` → approval required).
Stdio client: stderr drained, 1 MB line cap, SIGTERM + 2 s SIGKILL fallback,
stream destroy.

**Pipeline** (`photon-core/tools/pipeline.ts`): pre/post hooks, bounded retry,
single-wave sequential execution in the engines (`maxConcurrent=1`).

**Repair** (`core/agent/repair.ts`, `unifiedEngine.ts`): malformed calls get a
rendered correct-example nudge, ≤2 retries per logical step, then
`blocked` todo marking.

### 2.4 Providers (local + cloud)

| Provider | File | Notes |
|----------|------|-------|
| Ollama (local, primary) | `llm/providers/ollamaProvider.ts`, `ollama/client.ts` | NDJSON stream, connect/idle (not total) timeouts, `keepAlive 30m`, `listModels` concurrency-4 + `allSettled`, JSON errors wrapped, details truncated |
| llama.cpp (local) | `openaiCompatProvider.ts` (`llamacpp` id) | Auto-discovery via `/v1/models`, no key |
| OpenAI-compatible | `openaiCompatProvider.ts` | Groq/Together/NIM/OpenRouter/custom; per-attempt timeouts, `Retry-After` honor, tool-index collision fix, malformed-args drop |
| Gemini | `providers/geminiProvider.ts` | `streamGenerateContent` SSE, `blockReason` surfaced, live `v1beta/models` listing |
| Claude | `providers/anthropicProvider.ts` | `/v1/messages` SSE, `type:error` surfaced, no empty `tool_use_id`, paginated `v1/models` |
| NVIDIA / OpenAI / OpenRouter / OpenCode Zen / Blackbox / Custom | `openaiCompatProvider.ts` + `catalogs.ts` | BYOK, `GET /models` live listing (Blackbox static catalog), `keyInBody` + extra headers supported |

Routing (`llm/providerManager.ts`): `model.split(":")[0]` prefix; prefix-less
names fall back to Ollama; unknown prefixes throw (no silent local misroute).
`ping`/`listModels` bounded (15 s / 20 s race) so one hung provider can't stall.
Streaming (`llm/sse.ts`): SSE framing (multi-`data:` reassembly), idle watchdog
(300 s), abort throws `AbortError` (no silent bare-done), retryable
`429/500/502/503/504` with backoff.

### 2.5 Engines & turn lifecycle

- **Local/agent loop** (`core/agent/unifiedEngine.ts`, installed over
  `AgentEngine` by `host/unifiedRuntime.ts`): one tool per step, multi-call
  queue drained sequentially without re-querying, duplicate/invalid handling,
  truncation/narration/empty-response nudges (all bounded), per-turn cached
  specs/system/native-tools + shared todos + spec map.
- **Cloud loop** (`core/agent/cloudEngine.ts`): native function calling, model
  decides done via `attempt_completion` or tool-free reply, history trimmed at
  user boundaries keeping call/result pairs intact, 200-step safety net.
- **Controller** (`host/PhotonController.ts`): single-owner `promptQueue`
  drain (`sendPrompt` delegates to `onPrompt`), session-pinned emitter
  (record-always, post-if-live), `turnEpoch` approval guards, serialized
  persists, mid-turn cards finalized to `error` on abort, guarded idle posts.
- **Harness (experimental, behind `photon.experimental.harness`)**:
  `photon-core/` event-sourced `SessionRegistry` + `AgentRegistry/Inbox` +
  `AgentLoop` + `ToolPipeline` + `SystemPromptRegistry`.

### 2.6 Workspace understanding (offline RAG)

`host/indexService.ts` + `core/index/`: watches workspace, chunks sliding
`60 lines / 12 overlap`, caps `4000 chars/chunk`, `80/file`, `8000` chunks,
`1500 files × 256 KB`, ignores build dirs; embeds batched ×24 via local
`nomic-embed-text` (or `photon.index.embeddingModel`); pure-TS cosine store;
retrieves top-6 (threshold 0.2, ≤4000 chars) into agent/plan prompts
(medium+ only). Persisted `globalStorage/index-<hash>.json` with dim check.
Status `idle/indexing/ready/unavailable/error` + manual re-index.

### 2.7 Sessions, persistence, safety

| Store | Location | Limits |
|-------|----------|--------|
| Sessions | `globalState photon.sessions`, `updatedAt desc` | 40 sessions; persisted 200 msgs / 8k chars / 6k tool result; `KEEP_INLINE_IMAGES 4`; 4 MB guard drops oldest; live 400 msgs; webview 250k/msg |
| Bench | `globalState photon.bench` | 200 latest `ranAt` |
| Per-model configs | `globalState photon.perModelConfigs` | `numCtx`, llama.cpp flags |
| Custom models | `globalState photon.customModels` | post-test added |
| Secrets | `secrets photon.provider.<id>.apiKey` | never plaintext |
| Project | `workspaceState` | pinned model, approved MCP ids |
| Index | `globalStorage/index-<hash>.json` | dim-validated |
| Project config | `.photon/config.json\|yaml\|yml` | `model, intelligence, numCtx, indexing, autoApprove`; file wins over defaults, per-model wins over file; watcher hot-reloads |

Approval: every `sideEffecting` tool → `requestApproval` → UI card/bottom
`Approval` → promise; 5-min fail-safe timeout; abort resolves pending as denied;
`tools.autoApprove` bypass. Paths jailed by `resolveInWorkspace` (lexical `..`
+ `realpath` symlink check); suggestion probes jailed too.

### 2.8 Diagnostics & bench

- Status bar `Photon: <model> | Auto | (error)` + reasoning tooltip.
- `Photon: Run Machine + Model Diagnostics` dumps Ollama/provider reachability,
  machine tier, model tiers, active plan.
- Photon Bench (M7): `num_ctx 4096, num_predict 160, seed 7` — throughput via
  `eval_count/eval_duration`, 2× `read_file` reliability, reasoning check;
  live `tok/s` pill (`accChars/4`, 250 ms throttle) in `ContextMeter`.
- Context meter: `used / (numCtx − reserve 1024)` bar, amber >80%, tooltip
  `System + History / Budget`; first user message never dropped; history
  compacted past ~6 tool pairs into one-line summaries.

### 2.9 VS Code integration

`src/extension.ts` + `src/host/`: `ChatViewProvider` (retained webview),
`@photon` chat participant + `LanguageModelChatProvider` surface
(`LmProvider.ts`), commands `photon.openChat / newSession / refreshModels /
runDiagnostics`, status-bar updater, config-change hot reload, deterministic
dispose (abort + resolve approvals + MCP/index teardown).

---

## 3. Design Theme — "Void Black + Photon Gradient"

Source of truth: `webview-ui/src/theme/photon.css` (2359 lines), aligned with
the `photon-website/` palette.

**Palette (CSS variables).**

- Surfaces: `--space-900 #07070A` (app bg), `-850 #0a0a0e`, `-800 #0e0e12`,
  `-700 #151519` (user bubble), `-600 #1c1c22`, `-500 #27272f`; hairline
  `--line rgba(255,255,255,.07)`.
- Text: `--text #ececf0`, `--text-dim 55%`, `--text-faint 35%` (alpha-based,
  website-consistent).
- Brand: `--red #ff2d2d`, `--orange #ff6b2d`, `--amber #ffc02e`;
  `--grad-brand linear-gradient(92deg, red 0%, orange 46%, amber 100%)` —
  used sparingly (accents, active tab underline, focus rings, wordmark).
- Status: `--ok #34d399`, `--warn amber`, `--err red`.
- Type: system stack (`-apple-system … Inter`), mono
  (`SFMono / JetBrains Mono / Cascadia Code / Consolas`); radius
  `10px / 7px`; spacing scale `4/8/12/16px`; app column `max-width 860px`.

**Layout & chrome.**

- Centered 860 px column even in wide panels (`gutter 10px`); user bubbles
  right-aligned (`space-700`), Photon left; message markdown capped `72ch`.
- Header two-row: top `Chat | Plan | Agent` tabs (red underline) + orbital
  **Photon** wordmark; bottom `Local | ☁ Cloud` toggle + model picker
  (`Auto 🤖`, prefix-stripped display, `tier · tok/s`, 320 px ellipsis) and
  `Auto ◎ / History 🕒 / Refresh ↻ / New + / Settings ⚙`.
- Hero empty state: title, subtitle, model line, 3 mode-specific suggestion
  cards (`grid auto-fit 240px`).
- Messages: streaming `Markdown` (fenced code + lang tag + hover **Copy**),
  `ToolCard` (status dot grey/amber-pulse/green/red, mono arg ellipsis,
  220 px result, 4000-char UI cap), approval cards
  (`Approve / Deny` + remember), 180 px image / `📄` doc chips.
- Composer: meter inside input, attach chips (`22×22` ×), `+ Attach`
  (`space-700`), auto-grow textarea (160 px), `↑ Send / ■ Stop`;
  drag-drop + paste screenshots via `readFileToAttachment`; vision-gated accept;
  `Enter` send / `Shift+Enter` newline.
- Panels: History popover (260×320, `updatedAt desc`), Transparency
  (ranked scores + per-row **Pin**), full-page Settings (intelligence grid,
  adaptive rationale, ctx overrides, per-model `numCtx` + llama.cpp
  `-ngl/--fit/-np/-fa/-ctk/-ctv` with live `llama-server` preview + copy,
  tools, index, MCP `pending→connected`, bench table, machine/model,
  connection, cloud provider cards with letter logos, key `password + 👁`,
  `Refresh/Test/Add/✕`).
- System: `OfflineBanner`, dismissible `ErrorBanner`, `StatusIndicator`
  (`Thinking / Running tool + spinner + dots`), `*:focus-visible` red 1.5 px,
  28×28 icon buttons, thin 6 px `space-500` inner scrollbars only
  (`html overflow hidden`).

---

## 4. Configuration Reference

All keys under `photon.*` (`package.json` → Settings UI). Most used:

| Setting | Default | Effect |
|---------|---------|--------|
| `ollama.baseUrl` | `http://localhost:11434` | Ollama server |
| `ollama.requestTimeoutMs` | `180000` | Idle gap between tokens (not total cap) |
| `ollama.connectTimeoutMs` | `300000` | Wait for first response — covers cold model loads on slow disks/VRAM |
| `ollama.keepAlive` | `"30m"` | Model residency after use; longer = fewer cold loads, more VRAM held (empty = server default) |
| `ollama.preloadOnStartup` | `true` | Background warmup of selected local model after refresh (first prompt skips cold load) |
| `llamacpp.baseUrl` | `http://localhost:8080` | llama.cpp OpenAI-compat base (no `/v1`) |
| `llamacpp.requestTimeoutMs` | `300000` | Stream idle gap for llama.cpp (big prompt evals go quiet for minutes) |
| `providers.llamacpp.enabled` | `false` | Expose auto-discovered `llamacpp:*` |
| `defaultModel / defaultMode / interfaceMode` | `""/chat/local` | Startup model/mode/engine stack |
| `context.reserveOutputTokens` | `1024` | Budget subtracted from `numCtx` |
| `tools.autoApprove` | `false` | Skip approval prompts |
| `adaptive.enabled / intelligence.level` | `true/auto` | Auto-tune vs `max/high/medium/low` |
| `webSearch.provider` | `duckduckgo` | `duckduckgo/google/none` |
| `index.enabled / index.embeddingModel` | `false/nomic-embed-text` | Offline RAG |
| `providers.{gemini,claude,nvidia,openai,openrouter,opencode,blackbox}.enabled` | `false` | Cloud toggles (keys in Secrets) |
| `providers.custom` | `[]` | `{id,label,baseUrl,apiKey?,models?,extraHeaders?,keyInBody?}` |
| `experimental.harness` | `false` | Event-sourced loop (restart) |

---

## 5. Build / Develop / Package

```bash
npm install
npm run typecheck   # tsc -p tsconfig.json + webview-ui/tsconfig.json
npm run build:webview  # vite → dist/webview (55 modules, ~215 KB JS)
npm run build:ext      # esbuild --production → dist/extension.js (~242 KB)
npm run build          # both
npm run package        # build + vsce package → photon-0.1.0.vsix (14 files, ~312 KB)
code --install-extension photon-0.1.0.vsix
```

Structure: `src/core/` (adaptive, agent, bench, index, intelligence, llm,
ollama, prompts, protocol, tools) · `src/host/` (provider, controller,
ChatViewProvider, stores, services) · `src/photon-core/` (harness) ·
`src/shared/` (types, protocol) · `webview-ui/src/` (App, state/store,
theme, components) · `docs/` · `media/` · `dist/`.

---

## 6. What Changed in This Session (stability + optimization pass)

- **Queued-call fix** (`unifiedEngine.ts`, `store.ts`): no premature queued
  preview (duplicate IDs), drain emits `onAssistantStart` + `running→done/error`
  in its own bubble, duplicate path closes to `error`, missing-result closes to
  `error`, webview creates unknown bubbles (capped 500) instead of dropping.
- **Turn lifecycle** (`PhotonController.ts`): single-owner prompt queue,
  `turnEpoch`, abort-aware approvals with dedup, dispose resolves approvals,
  serialized persists, abort finalizes cards, guarded idle/session posts.
- **Injection/SSRF** (`terminal.ts`, `cloudTools.ts`, `web.ts`, `mcp/*`,
  `paths.ts`): quote-aware chaining guard; hardened IP/redirect checks;
  jailed path suggestions; MCP same-host redirect guard.
- **Providers** (`sse.ts`, 4 providers, manager, `ollama/client.ts`): abort
  throws, per-attempt timeouts, `Retry-After`, error surfacing, arg validation,
  bounded aggregation, strict routing, wrapped JSON, truncated details.
- **Bounds** (`files.ts`, `ToolCard.tsx`, `store.ts`, `mcpStdioClient.ts`):
  2 MB/binary read guards, 4k card cap, 1 MB MCP line cap, SIGKILL fallback.
- **Optimizations**: per-turn cached specs/system/native-tools + shared todos
  + spec map + `toolsRun` counter (`unifiedEngine.ts`); profiler cache
  (`modelProfiler.ts`); unified `classifyCloudToolPolicy` (`cloudTools.ts`);
  memoized webview (`store.ts` actions, `Message`, `Markdown`).

Verified: `typecheck` + `build:ext` + `build:webview` + `vsce package` green.
