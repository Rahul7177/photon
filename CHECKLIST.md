# Photon — Optimization & Enhancement Checklist

> Review top-down: Division 1 first, Division 12 last. Check each file's
> **Review lens** while reading it, fix/optimize, then tick the box.
> Paths are relative to `Photon/`.

---

## Division 1 — Turn Lifecycle & Orchestration (HIGHEST PRIORITY)

Everything the user does flows through one turn: prompt → plan → engine →
tools → stream → persist. A bug here breaks all modes, leaks turns, or
corrupts sessions. Optimize for single-ownership, abort-correctness, and
zero stuck UI states.

- [x] `src/host/PhotonController.ts` — The brain: owns prompt queue, turn abort, emitter bridge, approvals, sessions, providers, MCP, index. Review lens: overlapping turns, `turnEpoch` guards, finalize-cards on abort, guarded idle posts, serialized persists, approval dedup/timeout.
- [x] `src/core/agent/unifiedEngine.ts` — Local turn loop (one tool/step, queued multi-call drain, nudges, retries, fingerprints). Review lens: hoisted per-turn invariants, shared `todos`, `toolsRun` counter, spec map, terminal tool updates, bounded nudges.
- [ ] `src/core/agent/cloudEngine.ts` — Cloud native-tool loop (model-driven done, 200-step net). Review lens: double tokenization, per-step usage recount, `assistantId` per step + `onDone` pairing, abort during `tool.execute`.
- [ ] `src/host/unifiedRuntime.ts` — Monkey-patches `AgentEngine.runTurn` → `runUnifiedTurn`, thinking plumbing, per-turn cloud policy save/restore. Review lens: patch idempotence, thinking double-write guards, policy re-entrancy.
- [ ] `src/host/ChatViewProvider.ts` — Webview host: `setPost` rebinding, `postInit` repaint, reveal/dispose. Review lens: remount repaints pending approvals, stale `rawPost` after resolve.
- [x] `src/extension.ts` — Activation: runtime install, output channel, view provider (`retainContextWhenHidden`), participant, 4 commands. Review lens: activation cost, dispose chain, command wiring.

## Division 2 — Prompting, Context & Tool Protocol

Determines whether small (3–8B) models can follow instructions at all. Optimize
for terse-but-complete prompts, correct budgets, and a parser that accepts
messy model output without ever crashing or misfiring on echoed JSON.

- [ ] `src/core/prompts/system.ts` — Dynamic system prompt (identity + mode + tools + map + retrieval + formatting, budget-clamped). Review lens: budget math, duplication with `cloudSystem.ts`, per-step rebuild avoidance.
- [ ] `src/core/prompts/cloudSystem.ts` — Cloud variant. Review lens: drift vs `system.ts`, policy-matched tool surface.
- [ ] `src/core/agent/contextManager.ts` — `fitToWindow` + 6-pair compaction + token accounting. Review lens: anchor preservation, `tokensOf` double-count in callers, summary fidelity.
- [ ] `src/core/protocol/parse.ts` — Multi-format tool parser (`[TOOL]`, `<tool_call>`, JSON fences, bare JSON, pipe/unclosed variants). Review lens: injection via echoed page JSON, `collectPipeUnclosed` giant-arg capture, lenient quote coercion, O(n²) caps.
- [ ] `src/core/protocol/serialize.ts` — `renderToolInstructions`, `toNativeTools`, `renderToolResult` envelopes. Review lens: verbosity per intelligence level, envelope consistency (`tool` vs `user` role).
- [ ] `src/core/protocol/format.ts` — Block instruction formatter. Review lens: example correctness per tool (weak models copy these verbatim).
- [ ] `src/core/protocol/serialize.v2.ts` — V2 serializer. Review lens: dead vs live path — delete or consolidate if unused.
- [ ] `src/core/agent/repair.ts` — Malformed-call corrective prompts (max 2). Review lens: prompt quality for tiny models, retry accounting vs engine's own.
- [ ] `src/core/agent/engine.ts` — Legacy engine (patched over by `unifiedRuntime`, still shipped). Review lens: delete or shrink — dead code in bundle, dual maintenance risk.

## Division 3 — Tool Safety & Execution

Tools touch files, shell, and network with model-supplied arguments. Optimize
for jail-correctness first (traversal, injection, SSRF), then for output bounds
and helpful errors. A bypass here is a security incident, not a perf nit.

- [ ] `src/core/tools/builtin/terminal.ts` — `run_command` + quote-aware chaining guard. Review lens: `; || | & $() backtick > < newline` coverage, quoted-arg false positives, timeout/buffer/abort.
- [ ] `src/core/tools/builtin/files.ts` — `read/list/write/edit/append/move`, fuzzy edit, nearby suggestions. Review lens: `resolveInWorkspace` on every path incl. suggestions, 2 MB + binary guards, TOCTOU on move, error-message quality.
- [ ] `src/core/tools/paths.ts` — `resolveInWorkspace` jail (lexical + `realpath` symlink). Review lens: `realRootCache` invalidation on workspace change, non-existent-path nearest-ancestor logic.
- [ ] `src/core/tools/registry.ts` — Central registry, priority/minTier selection. Review lens: prefix unregister correctness (MCP), duplicate registration.
- [ ] `src/core/tools/types.ts` — `Tool`, `ToolContext` (`pendingCallId`!), budgets, clamp helpers. Review lens: budget constants (`TOOL_RESULT_CHAR_BUDGET`) vs per-capability caps.
- [ ] `src/photon-core/tools/pipeline.ts` — Pre/post hooks, `execute`/`executeMany` waves. Review lens: shared-`ctx` (`todos`, `pendingCallId`) across parallel waves, silent `break` dropping pending on partial failure.
- [ ] `src/core/tools/cloud/cloudTools.ts` — Cloud aliases + `classifyCloudToolPolicy` + policy get/set. Review lens: chaining guard parity with terminal, approval parity, policy single-source-of-truth.
- [ ] `src/core/tools/builtin/plan.ts` — `todo_write` + `think`. Review lens: `ctx.todos` shared-array contract with engines, forgiving item parsing.
- [ ] `src/core/tools/builtin/verify.ts` — `get_diagnostics` via VS Code API. Review lens: path filter, caps (20/50 shown, 200 hard), severity mapping.
- [ ] `src/core/tools/builtin/search.ts` — `find/find_files/search_code/outline` with byte/file/depth guards. Review lens: `MAX_FILE_BYTES` parity with `files.ts`, parallel batch errors.
- [ ] `src/core/tools/builtin/web.ts` — `web_search` + `web_fetch` + hardened `isPublicUrl` + redirect re-check. Review lens: decimal/hex/octal + IPv6-mapped + `.internal` coverage, `Location` resolution, 2 MB slice.
- [ ] `src/core/tools/builtin/index.ts` — Tool registration hub. Review lens: missing-tool wiring, ordering/priority sanity.
- [ ] `src/core/tools/workspaceMap.ts` — BFS file-tree map (120 entries, depth 3). Review lens: per-turn rebuild cost vs staleness cache, ignore-list completeness.

## Division 4 — Providers & Streaming

Every token and tool call crosses this layer. Optimize for fail-loud (never
silent bare-done), bounded waits, and clean routing. Silent truncation here
looks like "the model just stopped" everywhere else.

- [ ] `src/core/llm/sse.ts` — `streamSse` framing + `fetchWithRetry` (backoff, `Retry-After`, per-attempt timeout). Review lens: abort-throws (not breaks), retryable-status set, body drain on retry.
- [ ] `src/core/llm/providerManager.ts` — Prefix routing, thinking injection, bounded `ping`/`listModels`. Review lens: unknown prefix falls back to ollama (Ollama `name:tag` convention — never throw), dangling losers of `Promise.race`.
- [ ] `src/core/llm/providers/openaiCompatProvider.ts` — OpenAI-compat incl. llama.cpp/NIM/OpenRouter. Review lens: index-collision allocator, malformed-args drop, `keyInBody` leak surface, detail truncation.
- [ ] `src/core/llm/providers/anthropicProvider.ts` — Claude SSE (`content_block_*`, `message_delta/stop`). Review lens: `type:error` throw, `tool_use_id` fallback, delta-index fallback, `stopReason` propagation.
- [ ] `src/core/llm/providers/geminiProvider.ts` — `streamGenerateContent` + thinking budgets. Review lens: `promptFeedback.blockReason` throw, single-candidate assumption, finish-reason mapping.
- [ ] `src/core/llm/providers/ollamaProvider.ts` — Local adapter + profiled `listModels`. Review lens: concurrency-4 + `allSettled` kept, `mapOllamaThink` coverage.
- [ ] `src/core/ollama/client.ts` — REST client (tags/show/embed/chat NDJSON). Review lens: connect vs idle (never total) timeouts, wrapped JSON errors, truncated details, `parseChunk` strictness vs partial-text loss.
- [ ] `src/core/ollama/types.ts` — Wire types (`digest` used for profile cache). Review lens: field drift vs server API.
- [ ] `src/core/llm/types.ts` — `LLMProvider`, `LLMChatRequest/Chunk`, `ProviderModel`. Review lens: `done_reason` contract honored by all providers.
- [ ] `src/core/llm/catalogs.ts` — Static catalogs (Blackbox, custom inference). Review lens: stale entries, tier/cap regex drift.
- [ ] `src/core/adaptive/tokens.ts` — `estimateTokens` heuristic + pluggable tokenizer. Review lens: `split(/\s+/)` cost in hot loops, `estimateMessageTokens` reuse in engines.

## Division 5 — Adaptive Planning & Intelligence

Decides *which* model + settings each request gets. Optimize for ranking
correctness and plan-budget coherence; a bad rank wastes the whole turn.

- [ ] `src/core/adaptive/orchestrator.ts` — Builds `AdaptivePlan` (ctx, temp, tools, protocol, rationale). Review lens: RAM-cap vs per-model override precedence, rationale accuracy.
- [ ] `src/core/adaptive/autoMode.ts` — Per-request model pick + scoring transparency. Review lens: weight constants, pinned-model path, top-6 payload size.
- [ ] `src/core/intelligence/policy.ts` — Mode tool sets, caps, `suggestFirstTool`, fingerprints, recovery directives. Review lens: `ASK/PLAN/AGENT_TOOLS` drift vs registry, fingerprint stability across epochs.
- [ ] `src/core/intelligence/index.ts` — Level definitions. Review lens: level knob coherence (tools/parallel/caps/temps).
- [ ] `src/core/adaptive/complexity.ts` — Prompt → simple/moderate/complex signals. Review lens: keyword false-positives, non-English prompts.
- [ ] `src/core/adaptive/modelProfiler.ts` — Params/quant/family/caps profiler + digest cache. Review lens: cache TTL/size, guess fallbacks for unknown families.
- [ ] `src/core/adaptive/machineProfiler.ts` — RAM/CPU/GPU tiering. Review lens: WSL/remote, `nvidia-smi` absence, caching of results.

## Division 6 — State, Sessions & Shared Contracts

Owns what survives a reload — and what gets lost. Optimize for no silent loss:
serialize writes, cap before (not after) failure, and keep webview/host schemas
in lockstep.

- [ ] `src/host/sessionStore.ts` — `globalState` sessions (40 max, 200 msgs persisted, 4 MB guard). Review lens: `capForStorage` fidelity, sort-then-trim cost per upsert.
- [ ] `src/host/projectStore.ts` — Per-workspace pinned model / approved MCP. Review lens: key scoping on multi-root, migration on rename.
- [ ] `src/host/projectConfig.ts` — `.photon/config.*` reader + watcher. Review lens: flat-YAML parsing, hot-reload loops, precedence (file < per-model).
- [ ] `src/host/modelConfigStore.ts` — Per-model `numCtx`/llama flags. Review lens: stale entries for removed models, `effectiveNumCtxFor` precedence.
- [ ] `src/host/benchStore.ts` — 200 versioned bench results. Review lens: key (`model+hw+method`) collisions, prune cost.
- [ ] `src/core/bench/bench.ts` — Throughput/reliability/reasoning probes. Review lens: never-competes-with-turn guarantee, seed determinism, timeout handling.
- [ ] `src/shared/types.ts` — `ToolCall` statuses, `ChatMessage`, plans, configs. Review lens: `proposed→running→done/error/denied` transitions honored by every emitter.
- [ ] `src/shared/protocol.ts` — Host↔view message union. Review lens: exhaustive reducer handling, payload versioning.

## Division 7 — Offline Index / RAG

Makes agent/plan answers workspace-aware without network. Optimize for index
freshness vs build cost, and retrieval precision vs prompt-budget burn.

- [ ] `src/host/indexService.ts` — Watcher, embed queue, persist, status. Review lens: burst debouncing, embed-model absence UX, `retrieveContext` latency on every turn.
- [ ] `src/core/index/indexer.ts` — File enumeration + orchestration. Review lens: 1500-file / 256 KB caps, ignore-list parity with `workspaceMap`.
- [ ] `src/core/index/chunker.ts` — 60-line / 12-overlap sliding windows. Review lens: 4000-char / 80-per-file caps, empty-chunk filtering.
- [ ] `src/core/index/vectorStore.ts` — Pure-TS cosine store, 8000-chunk FIFO. Review lens: linear-scan cost at cap, normalization correctness.
- [ ] `src/core/index/types.ts` — Chunk/vector schemas. Review lens: `dim` validation on load.
- [ ] `src/core/index.ts` — Index barrel exports. Review lens: public surface minimality.

## Division 8 — MCP (External Tool Surface)

Highest-risk external surface: third-party code + processes. Optimize for
least-privilege (default-deny approvals), no zombie processes, and no SSRF via
redirects.

- [ ] `src/core/tools/mcp/bridge.ts` — Server lifecycle, allowlist, `inferRisk`, tool bridging. Review lens: default-`workspace_write` noise vs safety, `BLOCKED_ARG_RE` (`-y/--yes/install`) false positives, env filter.
- [ ] `src/core/tools/mcp/mcpStdioClient.ts` — Stdio JSON-RPC + lifecycle. Review lens: SIGKILL fallback timing, stderr drain, 1 MB line cap, `rpc` timeout rejection + child survival.
- [ ] `src/core/tools/mcp/mcpClient.ts` — HTTP JSON-RPC (+SSE parse). Review lens: same-host redirect guard, session-id handling, 202 handling.
- [ ] `src/core/tools/mcp/transport.ts` — Transport abstraction. Review lens: interface completeness for future transports.

## Division 9 — Webview Shell & State

The frame every pixel renders in. Optimize for stable identities (memo works),
no dropped tool cards, and bounded memory across long sessions.

- [ ] `webview-ui/src/state/store.ts` — Reducer + `useAppState` (`useMemo` actions). Review lens: `toolUpdate` unknown-bubble cap (500), `mergeMessages` streaming preservation, `MAX_CONTENT_CHARS` coherence with host caps.
- [ ] `webview-ui/src/App.tsx` — Layout + message routing. Review lens: prop drilling vs context, error paths to `ErrorBanner`.
- [ ] `webview-ui/src/main.tsx` — React mount. Review lens: `StrictMode` double-effect safety (`ready` posted twice?).
- [ ] `webview-ui/src/vscode.ts` — `post`/`onHostMessage` bridge. Review lens: listener leaks on remount, message validation.
- [ ] `webview-ui/src/attachments.ts` — Chips via `readFileToAttachment`, drag-drop/paste. Review lens: large-file guards, vision-gated accept messaging.

## Division 10 — Webview Components

Directly felt UX. Optimize for render cost during streaming (memo discipline)
and unmissable approvals. Check in visual order: header → messages → composer →
panels.

- [ ] `webview-ui/src/components/Composer.tsx` — Auto-grow input, meter, chips, send/stop, shortcuts. Review lens: `Enter/Shift+Enter`, disabled states mid-turn, attachment errors.
- [ ] `webview-ui/src/components/MessageList.tsx` — Filter `!hidden`, near-bottom autoscroll. Review lens: scroll-yank during streaming, 400-message render cost (needs virtualization?).
- [ ] `webview-ui/src/components/Message.tsx` — `memo` message renderer. Review lens: prop stability (`pendingApproval` identity), notice/copy actions.
- [ ] `webview-ui/src/components/Markdown.tsx` — `memo` + memoized fence-split, no-backtrack inline scan. Review lens: unclosed-fence streaming path, `CodeBlock` copy hover.
- [ ] `webview-ui/src/components/ToolCard.tsx` — Status dot/label, 4000-char cap, inline Allow/Deny. Review lens: `statusDetail` visibility, arg-summary truncation for huge args.
- [ ] `webview-ui/src/components/Approval.tsx` — Bottom approval dialog + `remember`. Review lens: single-slot `pendingApproval` clobber on parallel approvals (host supports N).
- [ ] `webview-ui/src/components/Header.tsx` — Tabs, mode toggle, picker, ◎/🕒/↻/+/⚙. Review lens: 320 px ellipsis, prefix-stripped display vs full-name hover.
- [ ] `webview-ui/src/components/SettingsPanel.tsx` — Full settings page. Review lens: blur-commit for ctx override, section load cost.
- [ ] `webview-ui/src/components/TransparencyPanel.tsx` — Rankings + Pin. Review lens: `⚠ ctx` warnings, pinned vs auto badge clarity.
- [ ] `webview-ui/src/components/SessionHistory.tsx` — Popover list. Review lens: sort/delete hover, empty-state.
- [ ] `webview-ui/src/components/ContextMeter.tsx` — Usage bar + `tok/s` pill. Review lens: >80% amber threshold, tooltip breakdown math.
- [ ] `webview-ui/src/components/StatusIndicator.tsx` — Thinking/running/error. Review lens: stuck-spinner on missed `onDone`.
- [ ] `webview-ui/src/components/CapabilityBadges.tsx` — `◈◉♫▶✦` badges. Review lens: compact vs full variants duplication.
- [ ] `webview-ui/src/components/ModelConfigs.tsx` — Per-model ctx + llama flags + server-cmd preview. Review lens: preview correctness (`-ngl/-np/-fa/-ctk/-ctv`).
- [ ] `webview-ui/src/components/CloudProviders.tsx` — Enable/key/refresh/test/add/remove cards. Review lens: error banners per provider, manual Blackbox input.
- [ ] `webview-ui/src/components/Hero.tsx` — Empty-state suggestions grid. Review lens: mode-specific card relevance.
- [ ] `webview-ui/src/components/ErrorBanner.tsx` — Dismissible errors. Review lens: auto-dismiss vs sticky severity.
- [ ] `webview-ui/src/components/ErrorBoundary.tsx` — Crash containment. Review lens: reset path back to working UI.
- [ ] `webview-ui/src/components/OfflineBanner.tsx` — Ollama unreachable. Review lens: false-positive flapping.
- [ ] `webview-ui/src/components/Icons.tsx` — SVG set. Review lens: duplicate paths, stroke consistency.
- [ ] `webview-ui/src/components/Toggle.tsx` — Switch control. Review lens: keyboard/ARIA support.

## Division 11 — Theme, Manifest & Build (LOWEST RUNTIME PRIORITY, STILL REVIEW)

Look, packaging, and contribution points. Optimize for token-size (bundle),
startup cost, and settings discoverability. Review last — but don't skip:
a wrong `activationEvents` or bloated bundle affects every install.

- [ ] `webview-ui/src/theme/photon.css` — Void-black + red→orange→amber system (860px column, 10/7px radii, inner-only scrollbars). Review lens: dead selectors (2359 lines), contrast on light VS Code themes, `72ch` markdown cap.
- [ ] `package.json` — Manifest: views, commands, 20+ `photon.*` settings, scripts. Review lens: setting defaults vs docs, `engines.vscode` floor, script parity (`compile`/`build:ui` names in README don't exist — actual: `typecheck/build:webview/build:ext/build/package`).
- [ ] `tsconfig.json` + `webview-ui/tsconfig.json` — Strictness. Review lens: `noUnusedLocals` on (catches `_ignored`-style leftovers), `strict` null checks in hot paths.
- [ ] `esbuild.mjs` — Extension bundle (~242 KB). Review lens: treeshaking `engine.ts` legacy + harness when flag-off, sourcemaps off in prod.
- [ ] `vite.config.ts` — Webview bundle (~215 KB JS). Review lens: chunk splitting, `manualChunks` for vendor, map files shipped in vsix.
- [ ] `webview-ui/index.html` + `webview-ui/src/state/store.compat.d.ts` — Shell + compat types. Review lens: CSP meta, stale compat declarations.

## Division 12 — Harness (Experimental) & Tests

Future engine + regression safety. Lowest priority because it's flag-gated
(`photon.experimental.harness`) — but keep it compiling and honest.

- [ ] `src/photon-core/agent/agent.ts` — `AgentRegistry`, per-agent `ctx` isolation. Review lens: parity with controller todos/tools.
- [ ] `src/photon-core/agent/inbox.ts` — Wake/injected claim semantics. Review lens: bounded batch growth.
- [ ] `src/photon-core/agent/types.ts` — Harness agent types. Review lens: drift vs `shared/types.ts`.
- [ ] `src/photon-core/loop/agentLoop.ts` — Compat shell (delegates to `unifiedEngine`). Review lens: pre-step listener ordering.
- [ ] `src/photon-core/loop/toolCallAssembler.ts` — Delta buffering + `parseToolArguments`. Review lens: `index:` fallback ID collisions.
- [ ] `src/photon-core/session/store.ts` + `types.ts` — Append-only event store + fork. Review lens: unbounded event growth, fork slice correctness.
- [ ] `src/photon-core/systemPrompt/registry.ts` — Template assembly. Review lens: duplication with `core/prompts/`.
- [ ] `src/photon-core/intelligence/plugin.ts` — Pre-step hooks. Review lens: hook error isolation (one bad plugin must not kill turn).
- [ ] `src/photon-core/llm/types.v2.ts` — Legacy→harness bridge. Review lens: `thoughtSignature` passthrough.
- [ ] `src/photon-core/boot/index.ts` — Harness wiring (`requestApproval: () => true`!). Review lens: auto-approve stub must never reach prod path.
- [ ] `src/core/protocol/parse.test.ts` + `src/photon-core/loop/agentLoop.test.ts` + `src/core/llm/imagePath.test.ts` — Only 3 test files for ~100 source files. Review lens: add coverage for parser edge cases, queue drain, approval epoch, SSRF guard, chaining guard.

---

## How to work this list

1. Go division by division, file by file, top to bottom.
2. For each file: read fully, apply the **Review lens**, run `npm run typecheck`.
3. After each division: `npm run build:ext` + `npm run build:webview`.
4. After all divisions: `npm run package`, reinstall the vsix, smoke-test Chat → Plan → Agent, approval Allow/Deny, Cancel mid-tool, session switch mid-turn, offline Ollama, and one cloud model.
