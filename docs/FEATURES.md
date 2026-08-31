# Photon — Feature Checklist

> Auto-generated from codebase audit, Aug 30 2026.
> Each item is an implemented, shipped feature. Check off items as you verify/review them.

---

## 1. Core Chat UI

- [ ] **Activity bar icon** — Photon has its own activity bar icon (`media/photon-activity.svg`) with a sidebar webview panel
- [ ] **Webview chat panel** — Full React-based chat UI rendered inside VS Code's WebviewView (`webview-ui/`)
- [ ] **Markdown rendering** — Assistant responses rendered as Markdown with syntax-highlighted code blocks (`Markdown.tsx`)
- [ ] **Message list** — Scrollable message history with user/assistant/tool messages (`MessageList.tsx`, `Message.tsx`)
- [ ] **Streaming display** — Real-time token streaming with live cursor indicator during generation
- [ ] **Context meter** — Visual token usage bar showing `used / window` with breakdown tooltip (`ContextMeter.tsx`)
- [ ] **Generation stats** — Live tok/s meter during streaming (`GenerationStats` → `tok/s · N tok`)
- [ ] **Status indicator** — Idle / thinking / running / error states with phase detail (`StatusIndicator.tsx`)
- [ ] **Error banner** — Non-fatal error display with dismiss (`ErrorBanner.tsx`)
- [ ] **Error boundary** — React error boundary prevents full UI crash (`ErrorBoundary.tsx`)
- [ ] **Offline banner** — Warns when Ollama is unreachable (`OfflineBanner.tsx`)
- [ ] **Auto-growing textarea** — Composer textarea grows with input, Shift+Enter for newlines (`Composer.tsx`)
- [ ] **Stop button** — Cancel an in-flight generation mid-stream

## 2. Modes

- [ ] **Chat mode** — Single-shot Q&A, no tool calls, temperature `chatTemp` from intelligence level
- [ ] **Plan mode** — Multi-step planning with tool access, up to 50 agent steps, detailed prompts
- [ ] **Agent mode** — Full agentic loop with tool calling, up to 100 steps, all tools available
- [ ] **Mode switcher** — Toggle between chat/plan/agent from the UI header

## 3. Model Management

- [ ] **Ollama auto-discovery** — Lists all locally pulled Ollama models automatically
- [ ] **Ollama model profiling** — Detects parameter size, quantization, family, context length, capabilities via `/api/show` (`modelProfiler.ts`)
- [ ] **Capability detection** — Auto-detects vision, audio, video, thinking, tool-trained capabilities per model
- [ ] **Model picker** — Dropdown to select the active model from all discovered/configured models
- [ ] **Model reachability ping** — Tests connectivity to Ollama server on startup
- [ ] **Model refresh** — Manual refresh button to re-scan available models
- [ ] **Model test** — Send a minimal completion request to verify a provider/model works (`testModel`)
- [ ] **Capability badges** — Visual badges for model capabilities: 🔧 tools, 👁 vision, 🧠 thinking, 🎵 audio, 🎬 video (`CapabilityBadges.tsx`)
- [ ] **Parameter size display** — Shows model size (e.g. "8B") and quantization in the UI

## 4. Multi-Provider Support

- [ ] **Ollama (local)** — Native adapter for local Ollama models (`OllamaProvider`)
- [ ] **llama.cpp (local)** — OpenAI-compatible adapter for llama.cpp server (`llamacpp` prefix)
- [ ] **Google Gemini** — Gemini API provider with live model listing (`GeminiProvider`)
- [ ] **Anthropic Claude** — Claude API provider (`AnthropicProvider`)
- [ ] **NVIDIA NIM** — Cloud provider with OpenAI-compatible API
- [ ] **OpenAI** — GPT-4o, o-series models via OpenAI API
- [ ] **OpenRouter** — Multi-model gateway
- [ ] **OpenCode Zen** — Cloud provider
- [ ] **Blackbox AI** — Cloud provider with static catalog + custom Agent-Id header
- [ ] **Custom OpenAI-compatible** — User-defined endpoints (Groq, Together, etc.) with dynamic model listing (`addCustomProvider`)
- [ ] **ProviderManager** — Unified routing layer: routes requests by model prefix to the correct provider (`providerManager.ts`)
- [ ] **Provider settings panel** — Enable/disable providers, enter API keys, view status (`CloudProviders.tsx`)
- [ ] **API key storage** — Secure storage via VS Code `SecretStorage`
- [ ] **Dynamic model fetching** — Fetch live model lists from cloud provider APIs (`fetchProviderModels`)
- [ ] **Add/remove cloud models** — Test and add validated models to the picker (`addAvailableModel`, `removeAvailableModel`)

## 5. Local vs Cloud Engine Stack

- [ ] **Local mode** — Ollama models + adaptive tuning + Photon block protocol + Ollama-specific options
- [ ] **Cloud mode** — Direct provider APIs + native tool calling + no adaptive limits + no local models
- [ ] **Interface mode toggle** — Switch between `local` and `cloud` from the settings panel
- [ ] **Chat participant** — `@photon` in VS Code Copilot Chat panel, routes to Photon's engine (`LmProvider.ts`)
- [ ] **LM API surface** — Photon models appear in VS Code's native model picker via `LanguageModelChatProvider`

## 6. Adaptive Engine (Module 8/12)

- [ ] **Machine profiling** — Detects RAM, CPU, GPU (nvidia-smi / rocm-smi / system_profiler), classifies as low/mid/high (`machineProfiler.ts`)
- [ ] **Model tier classification** — Maps model size to tiny/small/medium/large based on parameter count
- [ ] **Complexity assessment** — Heuristic rule-based classifier: simple/moderate/complex from prompt keywords, file refs, step estimation (`complexity.ts`)
- [ ] **Auto Mode** — Photon selects the best model per request based on complexity + model scores + bench data (`autoMode.ts`)
- [ ] **Model ranking** — Weighted scoring: context fit (40), tool reliability (22), throughput (18), tier match (20), headroom (8), efficiency (6), local preference (4)
- [ ] **Transparency panel** — Shows why a model was chosen: complexity signals, ranked candidates, one-click pin override (`TransparencyPanel.tsx`)
- [ ] **Model pinning** — Pin a specific model for the project, overriding Auto Mode (`pinModel`)
- [ ] **Per-intelligence-level profiles** — 4 tiers: low (5 tools, 768 output), medium (8, 2048), high (14, 4096), max (18, 8192)
- [ ] **Tool protocol selection** — Photon block protocol for local models, native function calling for cloud models
- [ ] **Adaptive plan generation** — Produces `AdaptivePlan` with context window, temperature, topP, max tools, tool protocol, rationale (`orchestrator.ts`)

## 7. Intelligence Levels (M12)

- [ ] **Low** — Compact prompts, 5 tools max, no parallel tools, 768-token output cap. For tiny/weak models.
- [ ] **Medium** — Standard prompts, 8 tools, no parallel, 2048 output cap. Default for most models.
- [ ] **High** — Elaborated prompts + multi-file guidance, 14 tools, parallel allowed, 4096 output cap.
- [ ] **Maximum** — Fully refined prompts, all tools, parallel allowed, 8192 output cap. For frontier models.
- [ ] **Auto intelligence** — Photon derives the level from model + machine + complexity (default)
- [ ] **Manual override** — User can pin intelligence level from the settings panel

## 8. Tools System (Module 11)

### 8.1 Built-in Tools (14 tools)
- [ ] **`read_file`** — Read file contents with optional line range, line-number gutter, binary detection (`files.ts`)
- [ ] **`edit_file`** — Surgical find-and-replace edit with fuzzy whitespace matching (`files.ts`)
- [ ] **`write_file`** — Create or overwrite a file (`files.ts`)
- [ ] **`find_files`** — Find files by name/glob pattern, respects `.gitignore` dirs (`search.ts`)
- [ ] **`list_dir`** — List directory contents, shallow recursive tree option (`files.ts`)
- [ ] **`search_code`** — Regex content search across workspace files (`search.ts`)
- [ ] **`get_diagnostics`** — Surface VS Code editor errors/warnings for a file or workspace (`verify.ts`)
- [ ] **`run_command`** — Execute shell command with approval, timeout, buffer cap (`terminal.ts`)
- [ ] **`move_path`** — Rename/move files and directories (`files.ts`)
- [ ] **`code_outline`** — Quick structural overview of a large file (headings/exports) (`search.ts`)
- [ ] **`todo_write`** — Task checklist for multi-step plans, replaces list on each call (`plan.ts`)
- [ ] **`think`** — Private reasoning scratchpad, not shown in final output (`plan.ts`)
- [ ] **`web_search`** — DuckDuckGo search, no API key required (`web.ts`)
- [ ] **`web_fetch`** — Fetch and extract readable text from a URL (`web.ts`)

### 8.2 Cloud-Native Tools
- [ ] **`read_file`** — Same semantics, cloud-compatible shape
- [ ] **`write_to_file`** — Full file write (cloud convention)
- [ ] **`replace_in_file`** — Surgical replacement (cloud convention)
- [ ] **`execute_command`** — Shell execution with approval
- [ ] **`attempt_completion`** — Signal task completion (intercepted by engine)
- [ ] **`ask_followup_question`** — Ask user a question (intercepted by engine)

### 8.3 Tool Infrastructure
- [ ] **ToolRegistry** — Central registry with priority-based selection for weak models (`registry.ts`)
- [ ] **specsForPlan** — Returns the right tool subset for the current adaptive plan (max tools, minTier gating)
- [ ] **Tool approval system** — Side-effecting tools (writes, commands) require explicit user approval via `requestApproval`
- [ ] **Auto-approve mode** — Optional per-project or global auto-approval of side-effecting tools
- [ ] **Tool card UI** — Visual card for each tool call showing name, args, status, result (`ToolCard.tsx`)
- [ ] **Tool result budget** — Output capped per capability level to prevent context overflow
- [ ] **Tool examples** — Worked examples injected into repair prompts after repeated failures

### 8.4 MCP Servers (Module 11)
- [ ] **MCP manager** — Full lifecycle: pending → approved → connected → revoked (`McpManager`)
- [ ] **HTTP transport** — Connect to remote MCP servers via HTTP
- [ ] **Stdio transport** — Connect to local MCP servers via stdio (`McpStdioClient`)
- [ ] **Tool discovery** — MCP tools auto-registered with `mcp_` prefix
- [ ] **Approval workflow** — Untrusted servers start "pending", require explicit user approval
- [ ] **Revocation** — Revoke an approved server; its tools are immediately removed
- [ ] **Server status UI** — Shows connection status, tool count, error messages (`McpServerInfo`)

## 9. Tool Call Repair (M9)

- [ ] **Multi-format parser** — Parses `[TOOL]` blocks, `<tool_call>` XML, `<tool_call>` tags, `|tool_call>`, JSON fences, bare JSON (`parsePhotonBlocks`)
- [ ] **Regression-tolerant parsing** — Handles unclosed tags, malformed JSON, pipe-prefixed tags from Gemma/Qwen
- [ ] **Repair prompt** — Corrective micro-prompt with exact schema + worked examples after malformed calls (`buildRepairPrompt`)
- [ ] **Max 2 retries** — Bounded repair loop to prevent infinite retry spirals (`MAX_REPAIRS`)
- [ ] **Graceful degradation** — After max repairs, returns errors instead of looping
- [ ] **Tool call validation** — Validates parsed calls against tool specs (unknown tools, missing required params)
- [ ] **Stream retries** — Retries on mid-stream transport failures (dropped connection, gateway reset)
- [ ] **Empty generation retries** — Handles HTTP 200 with zero content (free/tier-limited endpoints under load)
- [ ] **Continue nudges** — Prose-only replies nudged to continue (up to 5 nudges)
- [ ] **Continuations** — Resumes when output is cut off mid-stream (token limit, unbalanced fences, up to 5 continuations)

## 10. Context Management

- [ ] **fitToWindow** — Drops oldest messages to fit system + history + user request within the context budget (`contextManager.ts`)
- [ ] **Newest-first retention** — Always keeps the newest user message; drops from the front
- [ ] **System + tools always kept** — System prompt is never trimmed
- [ ] **Token estimation** — Heuristic chars/4 + word-count fallback (`estimateTokens`)
- [ ] **Per-model tokenizer hook** — Pluggable `ModelTokenizer` interface for model-specific estimation (`estimateTokensForModel`)
- [ ] **Usage breakdown** — TokenUsage breakdown: "System + tools: X, Conversation: Y" shown in tooltip
- [ ] **Context window override** — User can override the context window per-model or globally (`setContextWindow`)
- [ ] **Output reserve** — Configurable tokens reserved for the model's reply (default 1024)

## 11. Adaptive System Prompt

- [ ] **Dynamic system prompt** — Built per-request based on mode, intelligence level, tools, workspace (`buildSystemPrompt`)
- [ ] **Tool instructions** — Rendered tool schemas injected for photon-block protocol (`renderToolInstructions`)
- [ ] **Workspace map** — Compact project file tree injected for plan/agent modes (`workspaceMap.ts`)
- [ ] **Retrieved context** — Semantic code retrieval from workspace index injected into prompt (medium+ tiers)
- [ ] **Project files injection** — Key project files (package.json, README, etc.) included in prompt for context
- [ ] **Prompt budget** — System prompt truncated to fit within the context window, per intelligence level

## 12. Workspace Indexing (M10)

- [ ] **Offline-first indexing** — Local vector store, no cloud, no server process
- [ ] **File chunking** — Splits source files into embeddable chunks (`chunker.ts`)
- [ ] **Local embedding** — Uses Ollama embedding model (default: `nomic-embed-text`)
- [ ] **Vector store** — Pure-TS cosine-similarity vector store (`vectorStore.ts`)
- [ ] **Incremental updates** — File watcher detects changes, re-embeds only changed files
- [ ] **Debounced re-indexing** — File save debounce (4s) to avoid re-embedding on rapid edits
- [ ] **Aborted-safe** — Indexing is fully abortable
- [ ] **Indexed file cap** — Max 1500 files, 256KB per file, 80 chunks per file
- [ ] **Persistence** — Indexed chunks survive reloads (stored in extension state)
- [ ] **Retrieval** — Semantic search feeds relevant code into the agent's context injection
- [ ] **Index status UI** — Shows phase (idle/indexing/ready/error), file/chunk counts, pending count
- [ ] **Excluded directories** — Ignores node_modules, .git, dist, build, .venv, __pycache__, etc.

## 13. Benchmarking (M7)

- [ ] **Photon Bench** — Measures throughput (tok/s), first-token latency, tool-call reliability, reasoning (`bench.ts`)
- [ ] **Versioned methodology** — `BENCH_VERSION` bumped on rubric changes to prevent cross-version comparison
- [ ] **Machine-classed results** — Results keyed by `model × hardwareClass × methodologyVersion`
- [ ] **Per-model bench** — Run benchmark for a single model or all detected models
- [ ] **Bench progress** — Real-time progress messages during benchmark runs
- [ ] **Abortable** — Benchmark runs can be cancelled
- [ ] **BenchStore** — Persists results across reloads, up to 200 results (`benchStore.ts`)
- [ ] **Bench results UI** — Display throughput, latency, tool reliability scores per model

## 14. Session Management

- [ ] **Session creation** — New session with unique ID, title, mode, model, timestamps
- [ ] **Session persistence** — Stored in VS Code `globalState`, survives window reloads (`SessionStore`)
- [ ] **Session list** — Sidebar history with title, mode, model, message count, last updated (`SessionHistory.tsx`)
- [ ] **Session switching** — Click to load any previous session
- [ ] **Session deletion** — Delete individual sessions
- [ ] **Session title** — Auto-generated from first user message
- [ ] **Session cap** — Max 40 sessions persisted; oldest dropped first
- [ ] **Message cap** — Max 400 messages per live session, 200 per persisted session
- [ ] **Content pruning** — Persisted messages capped at 8000 chars, tool results at 6000 chars
- [ ] **Image pruning** — Only last 4 inline images kept in persisted sessions (prevents storage bloat)
- [ ] **Storage size guard** — Hard 4MB JSON-size cap on persisted sessions

## 15. Project Configuration (M5)

- [ ] **`.photon/config.json`** — Checked-in, team-shareable project config (model, intelligence, numCtx, indexing, autoApprove)
- [ ] **`.photon/config.yaml` / `.photon/config.yml`** — Flat YAML alternative (key: value only, no nesting)
- [ ] **Schema versioning** — `version` field for forward-compatible evolution
- [ ] **File watcher** — Config changes apply without reload
- [ ] **Precedence** — User settings > project config > defaults (UI choices always win)

## 16. Per-Model Configuration

- [ ] **Per-model config UI** — Edit context window, llama.cpp flags, sampling per model (`ModelConfigs.tsx`)
- [ ] **Context window override** — Per-model `numCtx`
- [ ] **llama.cpp settings** — `-c` (ctx), `-ngl` (GPU layers), `--fit/--no-fit`, `-np` (parallel), `-fa` (flash attention), `-ctk/-ctv` (cache types), extra args
- [ ] **Sampling overrides** — Per-model `temperature`, `top_p`, `seed`
- [ ] **Launch preview** — Shows the equivalent `llama-server` command for current settings
- [ ] **File-wins merge** — `.photon/config.json` `modelConfigs` merged with `globalState`; file wins on conflict
- [ ] **Per-model config in project file** — Team can commit per-model overrides: `{ "modelConfigs": { "llamacpp:gemma": { "numCtx": 32768, "ngl": "all" } } }`

## 17. Image / Vision Support

- [ ] **Paste images** — Ctrl+V to paste clipboard images into the composer
- [ ] **Drop images** — Drag-and-drop images onto the composer
- [ ] **File picker** — Attach images via the file picker button
- [ ] **Firefox clipboard fallback** — Handles `getAsFile()` returning null for pasted images (`readClipboardBlobToAttachment`)
- [ ] **Image size guard** — Max 6MB per image, clear error on oversized
- [ ] **OpenAI vision format** — Images sent as `image_url` with base64 data URI for OpenAI-compatible providers
- [ ] **Gemini vision format** — Images sent as `inlineData` with mimeType for Gemini
- [ ] **Ollama vision format** — Images passed as base64 strings in the `images` array
- [ ] **Vision model detection** — Auto-detects vision capability; warns if attaching images to non-vision model
- [ ] **Image attachments stripped on persist** — Only last 4 images kept in stored sessions to prevent bloat

## 18. Text Attachments

- [ ] **Text file attachment** — Attach .txt, .md, .json, .csv, .py, .ts, etc. (200KB max)
- [ ] **Text inlining** — Text attachments inlined as context in the user message
- [ ] **Supported extensions** — Explicit allowlist: txt, md, json, yaml, csv, log, py, ts, tsx, js, jsx, c, cpp, go, rs, java, etc.
- [ ] **Attachment chips** — Visual chips with name, size, remove button (`Composer.tsx`)

## 19. Chat Participant (`@photon`)

- [ ] **VS Code Chat Participant** — Registers as `photon` in Copilot Chat panel (`LmProvider.ts`)
- [ ] **`@photon` invocation** — Type `@photon` in native chat to route to Photon's engine
- [ ] **Attachment forwarding** — Images and text from native chat attachments forwarded to Photon
- [ ] **Markdown streaming** — Responses streamed as Markdown in the native chat panel
- [ ] **Reference handling** — `request.references` mapped to Photon `Attachment` objects

## 20. Webview ↔ Host Protocol

- [ ] **Typed message protocol** — Full bidirectional typed protocol: `HostMessage` (host→webview) + `ViewMessage` (webview→host) (`protocol.ts`)
- [ ] **Init payload** — On webview mount, full state snapshot sent (models, sessions, config, bench results, index status, MCP servers, plan)
- [ ] **Streaming deltas** — `messageDelta` for live token streaming, `messageDone` for finalization
- [ ] **Tool lifecycle** — `toolUpdate` messages for proposed → running → done/error status
- [ ] **Tool approval flow** — `toolApprovalRequest` → user approves/denies → `toolApproval` response
- [ ] **Config sync** — `config` message pushes full `PhotonConfig` to webview on every change
- [ ] **Error forwarding** — Engine errors surfaced as `error` messages in the webview

## 21. Settings Panel

- [ ] **Intelligence level selector** — Grid of auto/max/high/medium/low with descriptions
- [ ] **Adaptive engine toggle** — Enable/disable auto-tuning of settings + tools
- [ ] **Rationale display** — Shows the adaptive plan's rationale (why these settings were chosen)
- [ ] **Context window override** — Global num_ctx override input
- [ ] **Auto-approve toggle** — Enable/disable auto-approval of side-effecting tools
- [ ] **Web search provider** — DuckDuckGo or none
- [ ] **Cloud provider cards** — Enable/disable each cloud provider, enter API keys
- [ ] **Custom endpoint management** — Add/remove custom OpenAI-compatible endpoints
- [ ] **Interface mode toggle** — Local vs Cloud engine stack
- [ ] **Indexing toggle** — Enable/disable workspace indexing, shows embedding model
- [ ] **Model configs** — Per-model settings editor for local models

## 22. Diagnostics

- [ ] **Machine diagnostics** — Full machine profile: RAM, CPU, GPU, tier classification
- [ ] **Model diagnostics** — Provider connectivity, model availability, context window
- [ ] **Run diagnostics command** — `Photon: Run Machine + Model Diagnostics` from command palette
- [ ] **Status bar item** — Shows active model + reachability status

## 23. Harness (Event-Sourced Engine)

- [ ] **SessionRegistry** — Durable, append-only event store for sessions (`session/store.ts`)
- [ ] **AgentRegistry** — Creates and manages Photon agents with inbox queues (`agent/agent.ts`)
- [ ] **ToolPipeline** — Registered tools with priority and capability gating (`tools/pipeline.ts`)
- [ ] **SystemPromptRegistry** — Assembles system prompts from templates (`systemPrompt/registry.ts`)
- [ ] **AgentLoop** — Event-sourced agent loop with step/turn lifecycle (`loop/agentLoop.ts`)
- [ ] **Boot module** — Wires up all harness components with legacy provider bridge (`boot/index.ts`)
- [ ] **Feature flag** — `photon.experimental.harness` enables the new engine path
- [ ] **LLM adapter bridge** — Bridges legacy `LLMProvider` to harness `LlmAdapter` interface (`types.v2.ts`)
- [ ] **Pre-step waterfall** — Plugin-style pre-step hooks for plan rewriting

## 24. Prompt Protocol

- [ ] **Photon block protocol** — `[TOOL name] arg: value [/TOOL]` format for small models
- [ ] **Native function calling** — Standard OpenAI-style function calling for capable models
- [ ] **Tool instruction rendering** — Generates tool schemas with examples for block protocol (`renderToolInstructions`)
- [ ] **Tool result rendering** — Formats tool results for block protocol (`renderToolResult`)
- [ ] **Native tool conversion** — Converts `ToolSpec` to OpenAI function-call schema (`toNativeTools`)

## 25. Security

- [ ] **MCP approval gate** — Untrusted MCP servers require explicit approval before exposing tools
- [ ] **Tool approval** — Side-effecting tools (file writes, commands) require user confirmation
- [ ] **Path traversal prevention** — `resolveInWorkspace` validates paths stay within workspace root
- [ ] **Workspace-scoped operations** — All file tools are constrained to the workspace
- [ ] **SecretStorage** — API keys stored in VS Code's encrypted SecretStorage, never in settings JSON

## 26. Performance

- [ ] **Model keep-alive** — Ollama models kept resident for 30 minutes between turns
- [ ] **Debounced indexing** — File save debounce prevents re-embedding on rapid edits
- [ ] **Batched embedding** — Embeddings sent in batches of 24 to avoid large API requests
- [ ] **Chunk cap** — Max 80 chunks per file, 4000 files scanned, 1500 files indexed
- [ ] **Throttled tok/s meter** — Generation stats emitted at ~4Hz to avoid webview spam
- [ ] **retainedContextWhenHidden** — Webview context preserved when panel is hidden
- [ ] **Prompt budget** — System prompt truncated per intelligence level to fit context window

---

## Module Reference (from `photon-blueprint.md`)

| Module | Status | Description |
|--------|--------|-------------|
| M1 | ✅ Done | Monorepo boundaries (esbuild boundary guard) |
| M2 | ✅ Done | Ollama client + model profiling |
| M3 | ✅ Done | Chat Participant + LM API surface |
| M5 | ✅ Done | Project config (`.photon/config.yaml`) |
| M6 | ✅ Done | Engine package boundary (guard in esbuild) |
| M7 | ✅ Done | Photon Bench (throughput, tool-call, reasoning) |
| M8 | ✅ Done | Auto Mode (complexity assessment + model ranking) |
| M9 | ✅ Done | Tool-call repair + multi-format parser |
| M10 | ✅ Done | Workspace indexing (offline vector store) |
| M11 | ✅ Done | MCP server lifecycle + tool registry |
| M12 | ✅ Done | Intelligence levels + transparency panel |
| M13+ | ⬜ Phase 3 | Cloud SaaS (if pursued) |
| M20 | ⬜ Phase 4 | Curated Skills Registry |
| M21 | ⬜ Phase 4 | Telemetry opt-in |
| M23 | ⬜ Phase 4 | JetBrains port |
| M24 | ⬜ Phase 4 | Public leaderboard |
| M25 | ⬜ Phase 4 | Marketplace |
| M26 | ⬜ Phase 2 | CI/CD + observability |
| M27 | ⬜ Phase 2 | Security pass |
| M28 | ⬜ Phase 2 | CI/CD pipelines |
