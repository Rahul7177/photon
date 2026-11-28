# Photon VS Code Extension — Deep End-to-End Testing Report

**Date:** 2026-11-27  
**Workspace Tested:** `b:\Coding\Projects\Photon\Photon` (plus isolated sandbox workspaces for destructive file, checkpoint, and terminal tool tests)  
**Test Harness:** Live Photon Extension Workbench (`scripts/liveWorkbench.ts` on `http://127.0.0.1:4321`) + Real Google Chrome driven via Chrome DevTools Protocol (CDP)  
**Hardware Detected:** NVIDIA GeForce GTX 1660 Ti with Max-Q Design (`6.0 GB VRAM`), `15 GB System RAM`, `16 CPU Cores`, Windows  
**Models Tested:**
- **Local Engine (`AgentEngine` / `UnifiedEngine` via Ollama):** `gemma4:e4b` (active in GPU VRAM) & `qwen2.5-coder:7b` (16 local Ollama models detected)
- **Cloud Engine (`runCloudTurn` via `OpenAICompatProvider`):** `NVIDIA NIM` (`id: "nvidia"`, 30 live NIM catalog models fetched + live OpenAI-compatible `/v1/chat/completions` native tool-calling execution)

---

## 1. Executive Summary & Overall Scorecard

| Test Suite / Area | Checks Run | Passed | Failed (After Fixes) | Bugs Found & Fixed |
| :--- | :---: | :---: | :---: | :---: |
| **Phase 1: UI Views, Modals, Buttons, Dropdowns, & Settings Tabs** | 17 | **17** | 0 | 2 (`OnboardingModal.tsx`, `store.ts`) |
| **Phase 2A: All 17 Local Built-in Tools (`ToolPipeline` + `builtinTools`)** | 17 | **17** | 0 | 5 (`web.ts`, `mcpClient.ts`, `plan.ts` + `pipeline.ts`, `policy.ts` + `unifiedEngine.ts`, `parse.ts`) |
| **Phase 2B: Local Agent Behaviors (Modes, Manual Approval UI, Checkpoints, Overflow Guard)** | 5 | **5** | 0 | — |
| **Phase 3A: All 17 Cloud Tools & Security/Dedup Guards (`cloudTools`)** | 17 | **17** | 0 | — |
| **Phase 3B: Cloud Engine (`runCloudTurn`) + NVIDIA NIM Provider (`OpenAICompatProvider`)** | 3 | **3** | 0 | — |
| **Browser Runtime Health (Console Errors & Uncaught Page Exceptions)** | Continuous | **0 errors** | 0 | — |
| **TOTAL** | **60** | **60 (100%)** | **0** | **7 bugs fixed** |

---

## 2. Bugs & Edge Cases Discovered (and Fixed) During Testing

### Bug #1 (CRITICAL): `web_search` DuckDuckGo HTTP 202 Anti-Bot Challenge & Missing Live Currency Rate Resolver
- **Location:** [src/core/tools/builtin/web.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/tools/builtin/web.ts#L31-L82)
- **Symptom:** Queries like `"USD to INR conversion rate today"` and `"current president of India"` returned `"No results found. Try different keywords."`
- **Root Cause:**
  1. `web.ts` sent a bare `Chrome/120.0.0.0` `User-Agent` without `Sec-CH-UA` or browser navigation headers (`Accept`, `Accept-Language`, `Sec-Fetch-Dest`, `Sec-Fetch-Mode`, `Sec-Fetch-Site`, `Sec-Fetch-User`, `Upgrade-Insecure-Requests`). DuckDuckGo's anomaly filter flags bare Chrome UAs and returns an empty **HTTP 202** challenge page, while Google's HTML endpoint serves a JavaScript challenge page.
  2. Even when organic links are returned for currency queries (`xe.com`, `wise.com`), their search snippets only contain generic SEO meta-descriptions without the live numeric exchange rate.
  3. The globally installed VS Code extension copy (`~/.vscode/extensions/photon.photon-0.1.0/dist/extension.js`) was running a stale Nov 11 bundle.
- **Fix Applied & Verified:** Added `BROWSER_HEADERS` (Firefox navigation header set returning HTTP 200 with 10 organic results on both `html.duckduckgo.com` and `lite.duckduckgo.com`), added `parseDuckDuckGoLite`, added direct live currency conversion (`extractCurrencyQuery` + `fetchCurrencyExchangeRate` via `open.er-api.com` and `api.frankfurter.app`), upgraded Wikipedia fallback to `generator=search` with `prop=extracts&exintro=1`, and synced the rebuilt bundle to `~/.vscode/extensions/photon.photon-0.1.0/dist`.

### Bug #2 (CRITICAL): `web_fetch` 20-Second Timeout Deadlock in `fetchPublicHttps` & IPv6-First DNS Pinning
- **Location:** [src/core/tools/builtin/web.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/tools/builtin/web.ts#L159-L164) and [src/core/tools/mcp/mcpClient.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/tools/mcp/mcpClient.ts#L74-L93)
- **Symptom:** Every live call to `web_fetch` (e.g. `https://en.wikipedia.org/wiki/Droupadi_Murmu`) hung for 20,000ms and failed with `web_fetch error: The operation was aborted due to timeout`.
- **Root Cause:**
  1. In `fetchPublicHttps`, the `try` block executed `return res;` while the `finally` block executed `await dispatcher.close().catch(() => {});`. In Undici, `Agent.close()` returns a Promise that waits for all active response body streams to finish draining before resolving. Because `finally` awaited `dispatcher.close()` *before* returning `res` to `webFetchTool.execute`, the caller could never call `await res.text()` to drain `res.body` — creating a 100% deterministic deadlock until the 20s `AbortSignal.timeout` fired!
  2. In `createPinnedDispatcher` (`mcpClient.ts`), `dns.lookup(cleanHost, { all: true })` returned IPv6 (`AAAA`) records before IPv4 (`A`) records on dual-stack hosts like `en.wikipedia.org`. When `opts.all` was false, `cb(null, records[0].address, records[0].family)` handed back only the IPv6 address, stalling on networks without global IPv6 connectivity.
- **Fix Applied & Verified:** Changed `await dispatcher.close()` in `fetchPublicHttps` to non-blocking `void dispatcher.close().catch(() => {})` (which closes the agent cleanly once the caller finishes reading `res.text()`) and sorted IPv4 (`family === 4`) before IPv6 (`family === 6`) in `createPinnedDispatcher`. `web_fetch` on Wikipedia now completes in ~350ms.

### Bug #3 (HIGH): `todo_write` Unreachable `JSON.parse` Dead Code & `ToolPipeline` Array Rejection
- **Location:** [src/core/tools/builtin/plan.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/tools/builtin/plan.ts#L42-L77) and [src/photon-core/tools/pipeline.ts](file:///b:/Coding/Projects/Photon/Photon/src/photon-core/tools/pipeline.ts#L67-L74)
- **Symptom:** Passing `items` as a JSON string `'[{"id":1,"task":"Test","status":"done"}]'` caused `todo_write` to output `[ ] [1] [{"id":1,"task":"Test","status":"done"}] (0/1 done)` (treating the raw JSON string as a single pending todo item!). Passing `items` as a parsed JSON array `[{ id: 1, ... }]` through `ToolPipeline.execute` failed with `Parameter "items" must be a string, got object`.
- **Root Cause:**
  1. In `todoWriteTool.execute` (`plan.ts`), `parseTodoLines(raw)` was called *before* `JSON.parse(raw)`, and `parseTodoLines` had an unconditional `else out.push({ status: "pending", text: t })` fallback for any non-empty string. Thus `items.length === 0` was never true for any non-empty string, making the `JSON.parse(raw)` block completely unreachable dead code.
  2. `ToolPipeline.validateToolArgs` strictly rejected `Array.isArray(val)` for `todo_write.items` because `spec.params` declared `type: "string"`.
- **Fix Applied & Verified:** Updated `todoWriteTool.execute` to attempt `JSON.parse` first when `raw.trim().startsWith("[")`, and updated `ToolPipeline.validateToolArgs` to accept array values for `todo_write.items`.

### Bug #4 (MEDIUM): Premature Cloud Interface Switch in Onboarding Wizard & Misleading Header Copy
- **Location:** [webview-ui/src/components/OnboardingModal.tsx](file:///b:/Coding/Projects/Photon/Photon/webview-ui/src/components/OnboardingModal.tsx#L228-L236) and [OnboardingModal.tsx](file:///b:/Coding/Projects/Photon/Photon/webview-ui/src/components/OnboardingModal.tsx#L387-L395)
- **Symptom:** If a user with 16 local Ollama models clicked `"Set Up Cloud Providers"` on Step 1 of the Onboarding Wizard just to inspect the cloud providers list, and then clicked `"Skip"` or `"Finish Setup"` without entering an API key, Photon remained stuck in `interfaceMode: "cloud"` displaying `"No models configured"` and a disabled composer.
- **Root Cause:** The `"Set Up Cloud Providers"` card called `actions.setInterfaceMode("cloud")` immediately on click, even when 0 cloud providers were configured. Additionally, line 344 told users they could switch between Local and Cloud engines `"from the header"`, whereas the `Local | Cloud` toggle is in the **composer bottom bar**.
- **Fix Applied & Verified:** Only switch `interfaceMode` to `"cloud"` when at least one cloud provider is configured, when saving a cloud API key (`handleSaveCloudKey`), or when selecting a cloud model (`handleSelectCloudModel`), and updated the copy to reference the composer bar.

### Bug #5 (LOW-MEDIUM): `planUpdated` HostMessage Mode Sync, Recursive `list_dir` Double-Slash, & `webSearch.provider` Default Alignment
- **Location:** [webview-ui/src/state/store.ts](file:///b:/Coding/Projects/Photon/Photon/webview-ui/src/state/store.ts#L202), [src/core/tools/builtin/files.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/tools/builtin/files.ts#L302-L306), and [src/host/PhotonController.ts](file:///b:/Coding/Projects/Photon/Photon/src/host/PhotonController.ts#L2515-L2517)
- **Symptom:**
  1. When `setMode` was triggered via `PhotonController`, `this.pushPlan()` emitted `planUpdated` with `payload.mode = "agent"`, but the webview reducer only updated `state.plan` and left `state.mode` on `"chat"`.
  2. Recursive `list_dir` / `list_files` appended `prefix: \`${line}/\`` when `line` already ended with `"/"` for directories, producing double slashes (`src//service.ts`).
  3. `PhotonController.ts` fell back to `"google"` for `webSearch.provider` when unconfigured instead of `"duckduckgo"` (the default declared in `package.json` and `store.ts`).
- **Fix Applied & Verified:**
  1. Updated `case "planUpdated"` in `webview-ui/src/state/store.ts` to `{ ...state, plan: msg.payload, mode: msg.payload.mode ?? state.mode }`.
  2. Updated `listDirTool` in `src/core/tools/builtin/files.ts` to pass `prefix: line` so recursive paths format cleanly as `src/service.ts`.
  3. Aligned both `webSearch.provider` fallback defaults in `PhotonController.ts` to `"duckduckgo"`.

### Bug #6 (HIGH): Model Deflecting User to External Links After `web_search` Instead of Calling `web_fetch` (e.g. `"Whats the price of Nifty 50 as of now?"`)
- **Location:** [src/core/intelligence/policy.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/intelligence/policy.ts#L168-L195), [src/core/adaptive/stateCard.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/adaptive/stateCard.ts#L38-L55), [src/core/tools/builtin/web.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/tools/builtin/web.ts#L222-L386), [src/core/prompts/rulebook.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/prompts/rulebook.ts#L106), [src/core/agent/unifiedEngine.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/agent/unifiedEngine.ts#L1035-L1085), and [src/core/agent/cloudEngine.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/agent/cloudEngine.ts#L510-L535)
- **Symptom:** When asked `"Whats the price of Nifty 50 as of now?"`, the model executed `web_search` once and then replied: *"To get the most accurate, real-time price, I recommend checking one of the live tracking pages... Here are a few links where you can check the live price: NSE India / TradingView / Moneycontrol"* instead of calling `web_fetch` to read the page and extract the quote.
- **Root Cause:**
  1. In `inferStepPhase` (`policy.ts`), `mode === "chat"` immediately transitioned from `"orient"` to `"final"` as soon as 1 tool (`web_search`) succeeded. That caused `buildStepStateCard` (`stateCard.ts`) to inject `PHASE: final — Provide a concise, grounded Markdown final response with no unnecessary tool calls.` right after `web_search`.
  2. `web_search` returned JS-only SPA shells (`in.tradingview.com/symbols/NSE-NIFTY/` and `nseindia.in/market-data/...`) at positions #1 and #2 ahead of server-rendered pages containing the live quote in HTML (`moneycontrol.com/indian-indices/nifty-50-9.html`, `niftytrader.in/nifty-today`).
  3. In `htmlToText` (`web.ts`), HTML comments (`<!--...-->`) and `<header>` navigation blocks were not stripped, so the first ~4,800 characters of Moneycontrol were consumed by `Start -->` comments and site mega-menus before reaching `NIFTY 50 25,607.20 -277.30 (-1.07%)`.
- **Fix Applied & Verified:**
  1. Updated `inferStepPhase("chat", executedTools)` in `policy.ts` to remain in `"orient"` phase when only `web_search` has run, and updated `buildStepStateCard` (`stateCard.ts`) to explicitly instruct calling `web_fetch` when `web_search` snippets lack the requested live number/fact.
  2. Added `rankWebResultsForFetchability` in `web.ts` to rank server-rendered data pages (`moneycontrol.com`, `niftytrader.in`, `reuters.com`, `cnbc.com`, `investing.com`, `wikipedia.org`, etc.) ahead of client-only SPA shells (`nseindia.in/market-data`, `tradingview.com/symbols`), and appended a `[Next step: ... you MUST call web_fetch on the best URL above right now]` directive to `web_search` output.
  3. Upgraded `htmlToText` in `web.ts` to extract `<title>` and `<meta name="description" | property="og:description">`, strip HTML comments (`<!--[\s\S]*?-->`), `<header>`, `<aside>`, `<svg>`, and `<noscript>`, and send `BROWSER_HEADERS` in `web_fetch`.
  4. Added `looksLikeWebLinkDeflection` in `policy.ts` and an anti-deflection guard in both `runUnifiedTurn` (`unifiedEngine.ts`) and `runCloudTurn` (`cloudEngine.ts`) that intercepts link-deflection answers after `web_search` and nudges the model to call `web_fetch` on the best search result URL.
  5. Verified live with `gemma4:e4b`: asking `"Whats the price of Nifty 50 as of now?"` now executes `web_search` -> `web_fetch("https://www.moneycontrol.com/indian-indices/nifty-50-9.html")` and reports **`Current Price: 25,607.20 (-277.30 / -1.07%) As of 27 Nov, 2026 | 16:10 IST`**.

### Bug #7 (CRITICAL): Small/Tiny Models (`phi4-mini:latest` 3.8B) Failing `Missing required argument "query"`, Repeating 8x `Duplicate call`, and Leaking Raw JSON/`[SYS]`/`[]` Markup
- **Location:** [src/core/intelligence/policy.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/intelligence/policy.ts#L164-L178), [policy.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/intelligence/policy.ts#L330-L346), [src/core/protocol/parse.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/protocol/parse.ts#L188-L482), [src/core/agent/unifiedEngine.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/agent/unifiedEngine.ts#L954-L962), [unifiedEngine.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/agent/unifiedEngine.ts#L1184-L1195), [unifiedEngine.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/agent/unifiedEngine.ts#L1347-L1386), [unifiedEngine.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/agent/unifiedEngine.ts#L1561-L1596), and [src/core/tools/builtin/web.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/tools/builtin/web.ts#L26-L37)
- **Symptom:** When using a smaller local model (`phi4-mini:latest` 3.8B) on `"Tell me the weather of mysore today"`, Step 1 failed with `Missing required argument "query"`, Step 2 completed `web_search(query="Mysore weather today")`, Steps 3–10 failed 8 consecutive times with `Duplicate call — already ran. Use the earlier result.`, and the final assistant bubble dumped raw `[SYS]web_search: "Mysore weather today"[/SYS]`, truncated `{"type":"function","function":` JSON fences, eight empty `[]` lines, `[]{\"query\":\"Mysore weather today\"}`, and `[{"name":"web_search","arguments":{"query`.
- **Root Cause:**
  1. **Unbenchmarked Tiny Models Forced into Native Tool Protocol:** In `shouldUseNativeToolProtocol` (`policy.ts`), `if (model.capabilities?.some(c => c === "tools")) return true;` forced `toolProtocol: "native"` on 3B–4B `tiny` models whenever Ollama's Modelfile template included `.Tools`. Small models like `phi4-mini:latest` failed to emit structured `tool_calls` and instead echoed the tool's JSON Schema or repeated raw JSON tool-call arrays `[{"name":"web_search",...}]` 8–10 times in `message.content`.
  2. **Small-Model Syntax Variants Rejected with `Missing required argument "query"`:**
     - In `photon-block` mode, `phi4-mini:latest` emitted `BEGIN_ARG: weather in Mysore today\nEND_ARG` (placing the argument value directly on the `BEGIN_ARG:` header line instead of `BEGIN_ARG: query`), which `extractBeginArgArgs` parsed as `args["weather in Mysore today"] = ""`, leaving `args.query` undefined.
     - In JSON/hybrid mode, small models emitted `[SYS]web_search: "Mysore weather today"[/SYS]` and split adjacent JSON objects `[{"name":"web_search"}]{"query":"Mysore weather today"}` (where `{"name":"web_search"}` had empty `args: {}`, causing Step 1's `Missing required argument "query"`).
  3. **Intra-Response Repetition Flood Queued into `pendingCalls`:** When a small model emitted 9 identical `[{"name":"web_search","arguments":{"query":"Mysore weather today"}}]` objects in one response, `parsePhotonBlocks` returned all 9 calls and `unifiedEngine.ts` pushed 8 duplicates into `pendingCalls`, which then drained across Steps 3–10 as 8 consecutive `Duplicate call — already ran` error cards and exhausted the step budget.
  4. **Array Brackets Left Behind by `collectBareJson`:** `scanBalancedJson` only claimed `{...}` inside `[{...}]`, leaving eight empty `[]` pairs and truncated JSON fragments in `cleanedText`.
  5. **Direct Weather/Currency Answers Left in `"orient"` Phase:** When `web_search` resolved weather or currency directly (with no URLs to `web_fetch`), `inferStepPhase("chat", ...)` stayed in `"orient"` instead of transitioning to `"final"`.
- **Fix Applied & Verified:**
  1. Gated `shouldUseNativeToolProtocol` in `policy.ts` so `tiny` local models (`tier === "tiny"` or `paramsB <= 4.5`) use `photon-block` unless verified by a Bench v5 `nativeToolCallReliability >= 0.80` score.
  2. Upgraded `parse.ts` to support `BEGIN_ARG: <positional value>\nEND_ARG`, `BEGIN_ARG: key: value\nEND_ARG`, `[SYS]tool: "arg"[/SYS]`, flat JSON tool arguments, string `arguments`, echoed JSON schemas with custom examples, and split adjacent JSON `[{"name":"web_search"}]{"query":"..."}`, while consuming enclosing `[` and `]` around tool-call JSON objects and stripping truncated JSON tool fragments in `stripToolMarkup`.
  3. Added `dedupResponseCalls` in `unifiedEngine.ts` to collapse duplicate calls within a single response, drop broken error duplicates when a valid call for the same tool exists in the same response, cap Chat mode to 1 call per response, and skip already-executed fingerprints when populating `pendingCalls`.
  4. Added a duplicate-call circuit breaker in `unifiedEngine.ts` (`duplicateStreak`) that immediately forces a tool-free final plain-text answer (`forceConclude = true`) if a small model repeats an already-executed tool call after a tool has succeeded in Chat mode (or after 2 duplicates in any mode).
  5. Marked direct live weather/currency `web_search` results with `directAnswer: true` so `inferStepPhase("chat", ...)` and `buildStepStateCard` transition immediately to `"final"` phase.
  6. Verified live with `phi4-mini:latest`: `"Tell me the weather of mysore today"` now completes in **2 steps (`rung=0 steps=2 events=tool_ok=1`, 0 errors, 0 duplicates, 0 leaked markup)** and replies: *"The weather in Mysore today is patchy with rain nearby. The current temperature is 24°C, and it feels like 25°C. The humidity is at 75%, with a wind speed of 14 km/h. The UV index is at 4."*

---

## 3. Phase 1: Complete UI, Button, Modal, Dropdown, & Settings Audit

Every button, modal, dropdown, popover, theme option, and settings tab was clicked and visually verified in Google Chrome (`1366x940 @ 2x DPI` and `460px` VS Code Sidebar width).

| Check ID | UI Area / Component | Action Performed | Result | Details | Screenshot |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **UI-01** | **Onboarding Wizard (Step 1: Choose Mode)** | Inspect initial onboarding modal, hardware detection banner (`NVIDIA GeForce GTX 1660 Ti · 6.0 GB VRAM · 15 GB RAM`), active model pill (`gemma4:e4b`), and Local/Cloud option cards | **PASS** | Onboarding modal rendered with hardware summary, `16 local models sensed` badge, `Skip`, and `Start Coding` buttons. | `ui_01_onboarding_step1.png` |
| **UI-02** | **Onboarding Wizard (Local Models Setup)** | Click `Set Up Local Models` card, test `Scan Providers` button, and inspect sensed local runtimes & hardware fit badges | **PASS** | Displayed running Ollama on port 11434, stopped llama.cpp, LM Studio, vLLM, and 16 local models with VRAM fit badges. | `ui_02_onboarding_local.png` |
| **UI-03** | **Onboarding Wizard (Cloud Providers & NVIDIA NIM)** | Click `< Back`, click `Set Up Cloud Providers`, and click the **NVIDIA NIM** provider pill | **PASS** | Rendered Cloud Setup view with provider pills (`Google Gemini`, `Anthropic Claude`, `NVIDIA NIM`, `OpenAI`, `OpenRouter`, `OpenCode Zen`, `Blackbox AI`, `+ Custom Endpoint`) and encrypted API key field. | `ui_03_onboarding_cloud_nvidia.png` |
| **UI-04** | **Main Chat Hero & Starter Suggestions** | Click `Finish Setup` / `Start Coding` and inspect Hero screen and starter prompt pills | **PASS** | Rendered Photon gradient wordmark and 3 starter buttons: `"Explain project architecture & key files"`, `"Find potential bugs and edge cases"`, `"Help me refactor and optimize code"`. | `ui_04_hero_main.png` |
| **UI-05** | **Header -> Project Context & Memory Modal** | Click `BrainIcon` (`.ctx-header-btn`) in header to open `ProjectContextModal` | **PASS** | Modal opened showing `INDEXED FILES`, `SYMBOLS EXTRACTED`, `EST. CONTEXT SAVED`, and tabs for `Memory & Files`, `Modules & Index`, and `Notes`. | `ui_05_project_context_modal.png` |
| **UI-06A** | **Header -> Auto-Routing Transparency Panel** | Enable `autoSelectModel` and click `LightbulbIcon` in header | **PASS** | Lightbulb icon dynamically appeared in header and opened `TransparencyPanel` showing model routing logic. | `ui_06a_transparency_panel.png` |
| **UI-06B** | **Header -> Session History Popover** | Click `ClockIcon` in header to open `SessionHistory` popover | **PASS** | Popover opened with session search input, session list, pin/rename/delete actions, and new session trigger. | `ui_06b_session_history_popover.png` |
| **UI-07** | **Composer -> Mode Dropdown (`Chat` / `Plan` / `Agent`)** | Click `.mode-dropdown-trigger`, inspect all 3 mode cards & badges, and switch across `Plan`, `Agent`, and `Chat` | **PASS** | Menu displayed `Chat (No file edits)`, `Plan (Interactive plan)`, `Agent (Edits & commands)`, and updated textarea placeholder for each mode. | `ui_07_mode_dropdown.png` |
| **UI-08** | **Composer -> Model Picker Dropdown** | Click `.model-dropdown-trigger` in composer bottom bar | **PASS** | Popover displayed `Auto-Select (Adaptive per task)` and all 16 installed local Ollama models with tier tags (`tiny`, `small`, `medium`). | `ui_08_model_dropdown.png` |
| **UI-09** | **Composer -> Context Meter & Reasoning Tuning Popover** | Click `ContextIconTrigger` in composer bottom-right | **PASS** | Popover opened with Context Window selector (`Auto (8k)`..`256k`) and Reasoning level dropdown (`Auto`, `Off`, `Low`, `Medium`, `High`). | `ui_09_context_tuning_popover.png` |
| **UI-10** | **Composer -> Slash Commands Autocomplete (` / `)** | Type `/` into composer textarea | **PASS** | `.slash-menu-popover` opened above composer showing `/revert`, `/rewind`, `/compact` with keyboard navigation hints. | `ui_10_slash_commands_menu.png` |
| **UI-11A** | **Settings -> General Tab (Appearance Themes)** | Switch between `Auto (VS Code)`, `Soft Dark`, and `Soft Light` themes | **PASS** | `Soft Light` applied warm-stone frosted light theme cleanly; `Soft Dark` restored `#181818` charcoal frosted dark theme. | `ui_11a_settings_light_theme.png` |
| **UI-11B** | **Settings -> General Tab (256k Context Memory Overflow Guard)** | Click `256k` context preset on 6.0 GB VRAM GPU with `gemma4:e4b` selected | **PASS** | Triggered `High Context Window (256k) — Memory Overflow Warning` modal calculating `~28.7 GB` required vs `7.5 GB` safe available memory and offering `Use Recommended (8k)`. | `ui_14_settings_tools_tab.png` |
| **UI-11C** | **Settings -> General Tab (AI Guidance, Adaptive Engine, Project Config)** | Toggle `Max`/`High`/`Balanced`/`Minimal`/`Auto`, adaptive toggles, and click `Create Config` | **PASS** | Created `.photon/config.json` on disk and updated UI status to `Active .photon/config.json`. | `ui_11c_settings_general_project_config.png` |
| **UI-12** | **Settings -> Models Tab** | Inspect `Active Model`, `Unload` button, `16 Installed Local Models`, `Recommended Local Models` (`Code`/`Reason`/`Vision`/`Fast`), `Model Parameters`, and `Speed & Reliability Test` | **PASS** | All sections expanded and rendered hardware fit badges, per-model temperature/context overrides, and benchmark runner. | `ui_12_settings_models_tab.png` |
| **UI-13** | **Settings -> Providers Tab (Local Runtimes & Cloud Providers)** | Inspect `LocalProviderHub`, `Detected Local Runtimes`, and all Cloud Provider cards (`Gemini`, `Claude`, `NVIDIA NIM`, `OpenAI`, `OpenRouter`, `OpenCode Zen`, `Blackbox AI`, `+ Add Custom / Preset Endpoint`) | **PASS** | All local runtime cards and cloud provider configuration cards rendered cleanly. | `ui_13a_settings_providers_local.png`, `ui_13b_settings_providers_cloud_nvidia.png` |
| **UI-14** | **Settings -> Tools & Advanced Tabs** | Inspect `Auto-approve` toggle, `Web Search` provider select (`Google`/`DuckDuckGo`/`Disabled`), `Built-in Tools (17)` list, `Codebase Indexing`, `Embedding model` select, `MCP Servers`, and `Diagnostics -> Open Logs` | **PASS** | Listed all `17/17` built-in tools with `writes` badges and wrote full system/hardware diagnostics to the Photon Output channel. | `ui_15b_settings_advanced_tab.png` |
| **UI-15** | **VS Code Sidebar Responsive Layout (`460px` width)** | Switch workbench frame to `460px` sidebar width and audit DOM geometry | **PASS** | `clientWidth: 458px`, `scrollWidth: 458px`, `hasHorizontalOverflow: false`. Zero clipping or overflow. | `06_sidebar_460px_responsive.png` |

---

## 4. Phase 2: Local Model (`gemma4:e4b`) & All 17 Built-in Local Tools Audit

### 4.1 All 17 Built-in Local Tools — One-by-One Execution Matrix

Every tool registered in [src/core/tools/builtin/index.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/tools/builtin/index.ts) was executed through `ToolPipeline.execute` with real filesystem, terminal, checkpoint, project context, and network operations:

| # | Tool Name | Category | Arguments Tested | Result | Verified Outcome & Side Effect | Output Preview |
| :-: | :--- | :--- | :--- | :---: | :--- | :--- |
| 1 | `list_dir` | Filesystem (Read) | `{"path":"."}` | **PASS** | Listed workspace root entries (`src/`, `CHANGELOG.md`, `package.json`) | `src/ CHANGELOG.md package.json` |
| 2 | `find_files` | Search & Navigation | `{"pattern":"calculator"}` | **PASS** | Located `src/calculator.ts` by name pattern | `src/calculator.ts` |
| 3 | `read_file` | Filesystem (Read) | `{"path":"src/calculator.ts","start_line":1,"end_line":10}` | **PASS** | Read numbered lines 1–10 accurately | `1 │ export function add(a: number, b: number): number { 2 │ return a + b; ...` |
| 4 | `search_code` | Search & Navigation | `{"query":"multiply","path":"src"}` | **PASS** | Matched `multiply` in `src/calculator.ts` with exact line numbers | `2 matches in 1 file: src/calculator.ts:4: export function multiply...` |
| 5 | `code_outline` | Search & Navigation | `{"path":"src/calculator.ts"}` | **PASS** | Extracted AST symbol outline (`add`, `multiply`, class `Calculator`) | `# Outline of src/calculator.ts 1 │ export function add... 4 │ export function multiply... 7 │ export class Calculator` |
| 6 | `get_diagnostics` | Verification | `{"path":"src/calculator.ts"}` | **PASS** | Surfaced compiler/linter warning at `src/calculator.ts:4:10` | `1 diagnostic(s): WARNING .../src/calculator.ts:4:10 — Unused parameter 'precision'` |
| 7 | `write_file` | Filesystem (Write) | `{"path":"src/greeter.ts","content":"export const greetUser = (u: string) => \`Hi \${u}\`;\n"}` | **PASS** | Atomically created `src/greeter.ts` on disk & recorded pre-change checkpoint | `Created src/greeter.ts — 2 lines, 51 bytes.` |
| 8 | `edit_file` | Filesystem (Write) | `{"path":"src/calculator.ts","old_str":"return a + b;","new_str":"return Number(a) + Number(b);"}` | **PASS** | Replaced target block in `src/calculator.ts` & recorded checkpoint | `Edited src/calculator.ts at line ~2. File is now 10 lines.` |
| 9 | `append_file` | Filesystem (Write) | `{"path":"CHANGELOG.md","content":"- Added greeter module\n"}` | **PASS** | Appended line to `CHANGELOG.md` while preserving existing content | `Appended content to CHANGELOG.md. Existing content was preserved.` |
| 10 | `move_path` | Filesystem (Write) | `{"from":"CHANGELOG.md","to":"docs/CHANGELOG.md"}` | **PASS** | Created parent `docs/` directory and moved `CHANGELOG.md` -> `docs/CHANGELOG.md` | `Moved CHANGELOG.md → docs/CHANGELOG.md.` |
| 11 | `run_command` | Terminal Execution | `{"command":"node -e \"console.log('PHOTON_CMD_OK_' + (6 * 7))\""}` | **PASS** | Spawned shell process in workspace root and captured stdout | `Exit code 0. PHOTON_CMD_OK_42` |
| 12 | `todo_write` | Planning & Reasoning | `{"action":"set","items":[{"id":1,"task":"Audit calculator module","status":"done"},{"id":2,"task":"Add unit tests","status":"in_progress"}]}` | **PASS** | Parsed checklist items (both JSON string and JSON array) and updated `ctx.todos` | `[x] [1] Audit calculator module [>] [2] Add unit tests (1/2 done).` |
| 13 | `think` | Planning & Reasoning | `{"thought":"Checking edge cases for division by zero before editing calculator.ts"}` | **PASS** | Recorded structured scratchpad reasoning step with zero side effects | `Noted. Continue with your next tool call — act on this reasoning now.` |
| 14 | `update_project_context` | Project Memory | `{"category":"architecture","title":"Calculator Precision Policy","content":"All arithmetic helpers coerce inputs with Number() before calculation.","related_files":"src/calculator.ts"}` | **PASS** | Persisted architecture note to `.photon/context.json` | `Saved to Project Context [ARCHITECTURE]: "Calculator Precision Policy"` |
| 15 | `query_project_context` | Project Memory | `{"query":"Calculator"}` | **PASS** | Retrieved persisted architecture note & indexed symbols for `Calculator` | `## Project Memory & Decisions - **[ARCHITECTURE] Calculator Precision Policy**...` |
| 16 | `web_search` | Web & Live Data | `{"query":"USD to INR conversion rate today"}` | **PASS** | Resolved live USD -> INR rate (`1 USD = 92.5204 INR`) + organic search results (`Droupadi Murmu` for President of India) | `Live exchange rate (Fri, 27 Nov 2026, source: ExchangeRate-API): 1 USD = 92.5204 INR` |
| 17 | `web_fetch` | Web & Live Data | `{"url":"https://en.wikipedia.org/wiki/Droupadi_Murmu"}` | **PASS** | Fetched public HTTPS Wikipedia article via DNS-pinned SSRF-guarded dispatcher and stripped HTML | `Droupadi Murmu - Wikipedia ... Indian politician who has served as the 15th president of India since 2022...` |

### 4.2 Live Local Model Conversations & Behavioral Flows in Chrome

| Scenario | Prompt / Action in Chrome UI | Model | Observed Tool Call & UI Behavior | Final Assistant Output / Verification | Screenshot |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Live FX Rate (`web_search`)** | `"whats the USD conversion rate to INR today?"` | `gemma4:e4b` | Executed `web_search(query="USD to INR conversion rate today")`, rendered expandable `Done · 1 tool used` step card | *"The current USD to INR conversion rate is approximately **1 USD = 92.5204 INR**."* | `03_prompt1_usd_to_inr.png` |
| **Live Factual Search (`web_search`)** | `"tell me the current president of India"` | `gemma4:e4b` | Executed `web_search(query="current president of India")`, retrieved 8 organic results (`Droupadi Murmu - Wikipedia`, `presidentofindia.gov.in`) | *"The current President of India is **Droupadi Murmu**. She took office on July 25, 2022."* | `04_prompt2_president_of_india.png` |
| **Workspace Inspection (`read_file`)** | `"Use read_file to read the first 20 lines of package.json and tell me the name, displayName, and version."` | `gemma4:e4b` | Executed `read_file(path="package.json", end_line=20)` | *"The requested information from `package.json` is: **name**: `photon`, **displayName**: `Photon`, **version**: `0.1.0`"* | `05_prompt3_workspace_read_file.png` |
| **Manual Tool Approval (`autoApprove=false`)** | `"Use write_file to create a file named hello.txt with the exact content: Hello World"` | `gemma4:e4b` | Paused turn at `Status: running (Waiting for approval: write_file)` and rendered `<Approval>` card with file preview and `Allow` / `Always allow in session` / `Deny` buttons. Clicking `Allow` created `hello.txt` and attached `↩ Checkpoint #1 (1 file) Revert ›` pills. | *"The file `hello.txt` has been created successfully with the content "Hello World"."* | `local_01_manual_tool_approval_card.png`, `local_02_agent_write_file_completed.png` |
| **Checkpoint Rollback (`/revert`)** | Type `/revert` in composer and select from slash menu | `gemma4:e4b` | Opened `Revert to Checkpoint` modal listing `Checkpoint #1 just now (1 file: hello.txt)` with `↩ Revert & Rewind Chat` and `Files Only` buttons. | Verified pre-mutation snapshot tracking and rollback modal UI. | `local_03_checkpoint_revert_modal.png` |

---

## 5. Phase 3: Cloud Engine (`runCloudTurn`), NVIDIA NIM Provider, & All Cloud Tools Audit

### 5.1 NVIDIA NIM Provider UI & Live Catalog Discovery (`cloud_01` & `cloud_02`)
- Expanded **NVIDIA NIM** (`id: "nvidia"`, base URL `https://integrate.api.nvidia.com/v1`) in **Settings -> Providers -> Cloud Providers** (`cloud_01_nvidia_provider_expanded.png`).
- Tested API key storage (`setProviderApiKey`) and live model catalog discovery (`fetchProviderModels` for `nvidia`).
- Verified that Photon fetches and displays **30 NVIDIA NIM models** with category filter pills (`All (30)`, `Recommended (10)`, `In Picker (2)`, `Reasoning (3)`, `Vision (3)`, `Fast (9)`), `⚡ Auto Ping`, `↻ Refresh`, search box, and custom model ID addition (`cloud_02_nvidia_auth_validation.png`).

### 5.2 All 17 Cloud Tools & Security/Loop Guards — One-by-One Execution Matrix

Every tool and guard in [src/core/tools/cloud/cloudTools.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/tools/cloud/cloudTools.ts) and [src/core/agent/cloudEngine.ts](file:///b:/Coding/Projects/Photon/Photon/src/core/agent/cloudEngine.ts) was tested individually:

| # | Cloud Tool / Guard | Category | Arguments Tested | Result | Verified Behavior | Output Preview |
| :-: | :--- | :--- | :--- | :---: | :--- | :--- |
| 1 | `read_file` | Cloud Filesystem (Read) | `{"path":"src/service.ts","start_line":1,"end_line":10}` | **PASS** | Read `src/service.ts` lines 1–10 with line numbers | `1 │ export function fetchData(): string { 2 │ return 'ok'; ...` |
| 2 | `list_files` | Cloud Filesystem (Read) | `{"path":".","recursive":true}` | **PASS** | Listed workspace directory tree recursively | `src/ src/service.ts` |
| 3 | `find_files` | Cloud Search | `{"pattern":"service"}` | **PASS** | Matched `src/service.ts` by pattern | `src/service.ts` |
| 4 | `search_files` | Cloud Search | `{"query":"fetchData","path":"src"}` | **PASS** | Located `fetchData` occurrences in `src/service.ts` | `2 matches in 1 file: src/service.ts:1: export function fetchData...` |
| 5 | `list_code_definition_names` | Cloud Code Intelligence | `{"path":"src/service.ts"}` | **PASS** | Extracted top-level function `fetchData` and class `ApiService` | `# Outline of src/service.ts 1 │ export function fetchData... 4 │ export class ApiService` |
| 6 | `get_diagnostics` | Cloud Verification | `{"path":"src/service.ts"}` | **PASS** | Returned workspace diagnostics for `src/service.ts` | `1 diagnostic(s): INFO .../src/service.ts:2:5: Service endpoint can be memoized` |
| 7 | `write_to_file` | Cloud Filesystem (Write) | `{"path":"src/config.ts","content":"export const API_TIMEOUT = 5000;\n"}` | **PASS** | Atomically wrote `src/config.ts` & recorded pre-change checkpoint | `Wrote src/config.ts (2 lines).` |
| 8 | `replace_in_file` | Cloud Filesystem (Write) | `{"path":"src/service.ts","find":"return 'ok';","replace":"return 'ok_v2';"}` | **PASS** | Replaced target snippet in `src/service.ts` & recorded checkpoint | `Edited src/service.ts (1 replacement).` |
| 9 | `execute_command` | Cloud Terminal Execution | `{"command":"node -e \"console.log('CLOUD_EXEC_OK')\""}` | **PASS** | Executed command and captured `stdout=CLOUD_EXEC_OK` | `Exit code 0. CLOUD_EXEC_OK` |
| 10 | `execute_command` (Chaining Guard) | Cloud Security Guard | `{"command":"echo first && echo second"}` | **PASS** | Blocked shell chaining (`&&`) and instructed model to split into separate calls | `Run one command at a time — chaining/substitution with "&&" is not allowed...` |
| 11 | `todo_write` | Cloud Planning | `{"action":"set","items":"[{\"id\":1,\"task\":\"Inspect service.ts\",\"status\":\"done\"},{\"id\":2,\"task\":\"Update timeout config\",\"status\":\"done\"}]"}` | **PASS** | Parsed JSON string checklist and updated `ctx.todos` (`2/2 done`) | `[x] [1] Inspect service.ts [x] [2] Update timeout config (2/2 done).` |
| 12 | `web_search` (Cloud + Dedup Cache) | Cloud Web & Loop Guard | `{"query":"USD to INR conversion rate today"}` (called twice in same turn) | **PASS** | Resolved live FX rate on call 1 and returned cached evidence with loop-prevention directive on repeated call 2 | `Live exchange rate... [Photon reused the existing web evidence for this repeated query. Stop calling web_search...]` |
| 13 | `web_fetch` | Cloud Web Fetch | `{"url":"https://en.wikipedia.org/wiki/President_of_India"}` | **PASS** | Fetched Wikipedia HTTPS page via DNS-pinned dispatcher & extracted clean text | `President of India - Wikipedia ... Droupadi Murmu is the 15th and current president...` |
| 14 | `web_fetch` (SSRF Guard) | Cloud Security Guard | `{"url":"https://127.0.0.1:8080/secret"}` | **PASS** | Blocked loopback/private IPv4 address (`127.0.0.1`) against SSRF | `Blocked URL: Photon only fetches public HTTPS hosts, not localhost/private/link-local addresses.` |
| 15 | `ask_followup_question` | Cloud Lifecycle | `{"question":"Should API_TIMEOUT be configurable via environment variables?"}` | **PASS** | Returned structured follow-up question | `Should API_TIMEOUT be configurable via environment variables?` |
| 16 | `attempt_completion` | Cloud Lifecycle | `{"result":"Completed all service and configuration updates."}` | **PASS** | Finalized task completion summary | `Completed all service and configuration updates.` |
| 17 | `normalizeCloudToolCall` | Cloud Protocol Aliasing | `str_replace_editor(file_path,old_str,new_str)` & `bash(cmd)` | **PASS** | Transparently normalized `str_replace_editor` -> `replace_in_file` and `bash` -> `execute_command` | `norm1=replace_in_file({"path":"a.ts","find":"x","replace":"y"}), norm2=execute_command({"command":"npm test"})` |

### 5.3 Live Cloud Engine (`runCloudTurn`) + `OpenAICompatProvider (id: "nvidia")` Turn Execution
- **Provider Instance:** `OpenAICompatProvider` (`id: "nvidia"`, `label: "NVIDIA NIM"`) streaming over OpenAI-compatible `/v1/chat/completions` SSE with native `tools` JSON schemas.
- **System Prompt:** `buildCloudSystemPromptWithReport({ mode: "agent" })`
- **Native Tool Call Emitted:** `web_search({"query":"USD to INR conversion rate today"})`
- **Final Cloud Engine Response:** `"The current USD to INR conversion rate is:\n\n**1 USD = 92.5204 INR** (as of Fri, 27 Nov 2026, source: ExchangeRate-API)."`
- **Cloud Token Accounting:** `inputTokens: 1143`, `outputTokens: 30`
