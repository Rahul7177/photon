# Photon Codebase Audit: Bugs, Reliability Gaps & High-Impact Optimizations

> **Scope & Perspective:** Deep codebase audit of `b:\Coding\Projects\Photon\Photon` evaluated from a real end-user perspective (local Ollama / llama.cpp workflows, cloud provider workflows, file/terminal safety, settings integrity, UI usability, and scalability). Minor style/polish items are intentionally omitted.
>
> **Baseline Test Health:** `npm run typecheck; npm test` passed (`180` suites, `568` passed, `0` failed, `0` skipped) at the start of the audit; the issues below sit in gaps outside existing unit test coverage.

---

## Summary Matrix

| Priority | Category | Count | Key Themes |
| --- | --- | --- | --- |
| **P0 / Critical-High** | Security & Approval Enforcement | 5 | Blanket session auto-approve escalation, MCP risk bypass, cloud tool TOCTOU/non-atomic writes, `web_fetch` DNS-rebinding SSRF, API key precedence |
| **P1 / High** | Data Integrity, State & Rollback | 5 | Orphaned `.photon/context.json.*.tmp` files, turn abort concurrency race, `edit_file` checkpoint gaps, session restore stripping & attachment bloat, cross-session state leaks |
| **P1 / High** | Broken Settings & Dead UI Flows | 4 | Overwritten `photon.defaultMode`, ignored Ollama/llama.cpp timeouts & `keepAlive`, orphaned MCP trust UI, missing `llama.cpp` UI controls & Windows binary fallback bug |
| **P2 / Medium-High** | Provider, Multimodal & Webview Bugs | 4 | Hardcoded `image/png` on all cloud providers, 0-byte clipboard image paste, silent dropping of malformed tool JSON, leaked `PhotonController` + offline font dependency |
| **P2 / Medium** | Performance & Scalability | 2 | Index byte-budget loop bug + monolithic snapshot persistence, hardcoded 30s compaction timeout + stale sibling model candidates |

---

## 1. Security & Approval Enforcement Gaps

### 1.1 "Always allow in session" silently enables blanket approval for every non-critical tool
- **Files:** `src/host/approvalService.ts:64-109`, `webview-ui/src/components/Approval.tsx:153-162`, `src/core/tools/builtin/terminal.ts:117`, `src/core/tools/cloud/cloudTools.ts:215`
- **User Impact:** Clicking **"Always allow in session"** (whose tooltip explicitly states *"Always allow this tool for this session"*) on a single tool (for instance `write_file`, an MCP read, or even a shell command) silently activates `sessionAutoApprove = true`. For the rest of the session, **all** non-critical tools—including file writes, edits, moves, and unattended `run_command` calls—auto-execute without asking. Conversely, because `terminal.ts:117` and `cloudTools.ts:215` mark *every* non-allowlisted command as `"critical"` (`secAnalysis.isDangerous ? "critical" : isUnattended ? "execute" : "critical"`), users who explicitly enable global Auto-Approve still get prompted on routine commands like `pytest`, `npm run build`, or `git commit`.
- **Root Cause:** `ApprovalService.resolveApproval()` (`src/host/approvalService.ts:97-109`) excludes `"run_command"` from `sessionApprovedToolNames` specifically to prevent blanket shell approval, then immediately sets `this.sessionAutoApprove = true` on line `104`, overriding `autoApprove` globally across all non-critical tools.
- **Recommended Fix:** Scope "Always allow in session" strictly to `sessionApprovedToolNames.add(toolName)` instead of mutating `sessionAutoApprove` (or add a distinct, explicitly labeled *"Auto-approve all edits this session"* action). Separate non-allowlisted `run_command` risk from destructive commands so global Auto-Approve behaves predictably while still gating genuinely dangerous commands.

### 1.2 MCP tool calls omit `risk` and silently bypass Auto-Approve safety gates
- **Files:** `src/core/tools/mcp/bridge.ts:325, 364-371`, `src/host/approvalService.ts:64-74`
- **User Impact:** Destructive external MCP server actions (deleting records, triggering deployments, mutating external services) can execute without confirmation whenever `autoApprove` or `sessionAutoApprove` is enabled.
- **Root Cause:** `bridge.ts:325` computes `const risk = inferRisk(mcp);` (which classifies `"destructive"` and `"execute"` operations), but the `ctx.requestApproval({ ... })` call at `bridge.ts:365-371` omits the `risk` property on the `ToolCall`. `ApprovalService.requestApproval()` checks `call.risk === "critical" || call.risk === "destructive"` (`approvalService.ts:64`), sees `undefined`, and treats the call as non-critical.
- **Recommended Fix:** Pass `risk` (and descriptive `statusDetail`) into `ctx.requestApproval(...)` in `src/core/tools/mcp/bridge.ts`, and treat `"destructive"`/`"critical"` MCP calls consistently with built-in destructive tools.

### 1.3 Cloud file tools bypass atomic writes, post-approval symlink validation, and BOM preservation
- **Files:** `src/core/tools/cloud/cloudTools.ts:110-173`, `src/core/tools/paths.ts:92-157`, `src/core/tools/builtin/files.ts:546-549, 663`
- **User Impact:** In Cloud mode (`cloud_write_file` / `cloud_replace_in_file`), crashes during disk writes can truncate/corrupt files, symlinks created or swapped while waiting for user approval are followed without re-checking workspace containment (TOCTOU symlink escape), and UTF-8 BOM headers (`\uFEFF`) on Windows/C#/.NET files are silently stripped on edits.
- **Root Cause:** Local `files.ts` uses `atomicWriteFile()` (temp file + symlink guard + Windows `EPERM`/`EBUSY` rename retry) and re-validates `resolveInWorkspace` + BOM restoration, whereas `cloudTools.ts:124` and `171` write directly with raw `fs.writeFile(...)` after `await ctx.requestApproval(...)` without re-checking paths/symlinks or preserving BOM.
- **Recommended Fix:** Route `cloudWriteFile` and `cloudReplaceInFile` through `atomicWriteFile(...)` and re-run `resolveInWorkspace` immediately before writing, sharing BOM-preserving helper logic with `editFileTool`.

### 1.4 `web_fetch` SSRF check does not validate resolved DNS or pin sockets
- **Files:** `src/core/tools/builtin/web.ts:85-108, 153-180`, `src/core/tools/mcp/mcpClient.ts:40-89`
- **User Impact:** Malicious links, prompt-injected URLs, or DNS-rebinding domains (such as `127.0.0.1.nip.io` or public hostnames resolving to `169.254.169.254` / `127.0.0.1` / RFC1918 addresses) can coerce `web_fetch` into probing local developer services or cloud metadata endpoints.
- **Root Cause:** `isPublicUrl()` (`web.ts:85-108`) only parses literal hostname/IP strings before calling `fetch()`. By contrast, `mcpClient.ts:40-89` already implements `createPinnedDispatcher()` using DNS resolution + `isPrivateOrReservedIp()` to block private targets at connect time.
- **Recommended Fix:** Reuse DNS-pinned IP validation / `createPinnedDispatcher` in `web_fetch` (including across HTTP redirects) so connections are rejected if any resolved IP is private, loopback, or link-local.

### 1.5 Custom endpoint plaintext `apiKey` overrides SecretStorage and cannot be cleared via UI
- **Files:** `src/host/providerCatalogService.ts:249-251, 407`, `webview-ui/src/components/CloudProviders.tsx:244-250`
- **User Impact:** A user editing a custom OpenAI-compatible provider cannot erase a stored API key (e.g., when switching a local endpoint to keyless mode), and any legacy plaintext `apiKey` left in `settings.json` overrides `SecretStorage`.
- **Root Cause:** `CloudProviders.tsx` sends `key.trim() || undefined` when saving, `updateCustomProvider()` ignores `undefined`/empty keys instead of deleting from `SecretStorage` when cleared, and `buildCloudProviders()` (`providerCatalogService.ts:407`) evaluates `c.apiKey || (await apiKey(c.id))`.
- **Recommended Fix:** Prioritize `SecretStorage` over `c.apiKey` (migrating & stripping plaintext `c.apiKey` if present) and support explicit key clearing (e.g., `clearApiKey` flag or empty string deletion) from the edit modal.

---

## 2. Data Integrity, State & Rollback Bugs

### 2.1 `ProjectContextManager.saveToDisk()` leaks `.photon/context.json.*.tmp` files on Windows
- **Files:** `src/core/context/projectContext.ts:1115-1121`, `src/core/tools/paths.ts:133-151`, `src/core/checkpoints/checkpointManager.ts:205-217`
- **User Impact:** Workspaces accumulate orphaned `.photon/context.json.<uuid>.tmp` clutter files (observed directly in this repository) and silently drop project-context updates whenever Windows file indexers/antivirus briefly lock `.photon/context.json`.
- **Root Cause:** `saveToDisk()` executes a single-attempt `fs.rename(tmpPath, this.storageFilePath)` without the `EPERM`/`EBUSY` backoff retry already implemented in `paths.ts` and `checkpointManager.ts`, and catches/ignores exceptions without cleaning up `tmpPath` in a `finally` block.
- **Recommended Fix:** Reuse a shared atomic-write utility with retry + `finally` `unlink` cleanup (`atomicWriteFile` or `checkpointManager`'s `atomicRename`), and ensure concurrent `saveToDisk()` calls are serialized.

### 2.2 Turn abort resets `turnRunning` prematurely, enabling concurrent overlapping turns
- **Files:** `src/host/turnCoordinator.ts:38-44`
- **User Impact:** Clicking **Stop** and immediately sending a follow-up prompt can run two turns simultaneously against the same active session—interleaving streamed messages, corrupting tool/checkpoint ordering, and letting the aborted turn's `finally` block clear the newly started turn's `turnRunning`/`turnAbort` state.
- **Root Cause:** `abortTurn()` immediately assigns `this.turnAbort = undefined` and `this.turnRunning = false` instead of letting the active turn's `finally` cleanup reset state after async tool termination, checkpoint saving, and session persistence complete.
- **Recommended Fix:** Signal abort without prematurely clearing `turnRunning`, track turn generation/Promise completion, and reject/queue new turns until the unwinding turn's `finally` block settles.

### 2.3 `edit_file` (`append` and `<40`-line fast paths) skips checkpoint & modified-file tracking
- **Files:** `src/core/tools/builtin/files.ts:591-610, 629-636`
- **User Impact:** When the agent edits a file using `edit_file` with `append: true`, **Revert / Rollback** cannot restore the file's previous contents, and turn handoff/audit tracking misses the edit. Similarly, the `<40`-line whole-file branch (`629-636`) omits `recordFileEdit`.
- **Root Cause:** The `append: true` early-return branch writes via `fs.appendFile` without calling `ctx.checkpointTracker?.recordBeforeChange(rel)` or `ctx.recordFileEdit?.(rel, ...)`. Note also that `fs.appendFile` is non-atomic and can concatenate onto a line lacking a trailing newline without checkpoint recovery.
- **Recommended Fix:** Call `ctx.checkpointTracker?.recordBeforeChange(rel)` and `ctx.recordFileEdit` across every mutating branch in `editFileTool` (`append: true`, `<40`-line replacement, and hunk replacement), or extract one shared write+track helper.

### 2.4 Session restore strips Gemini `thoughtSignature` & tool names, while uncapped attachments evict chat history
- **Files:** `src/host/sessionStore.ts:130-140, 328-394, 419-457`, `src/core/llm/normalizeMessages.ts:172`
- **User Impact:**
  1. Reopening a Gemini session after restarting VS Code breaks multi-turn thinking tool replay (`thoughtSignature` missing) and degrades historical tool results to generic `"tool"` names (`normalizeGeminiMessages` falls back to `"tool"`).
  2. Attaching large files or pasted images causes older sessions to disappear unexpectedly from Session History, and unredacted secrets inside attachment text persist verbatim in VS Code `globalState`.
- **Root Cause:** `validateAndSanitizeRestoredSession` (`sessionStore.ts:328-394`) drops `toolCall.thoughtSignature` and `msg.name` on `"tool"` role messages during restoration. Meanwhile, `capForStorage()` (`419-457`) caps and runs `redactSecrets()` on `content`, `thinking`, and `toolCalls[].result`, but leaves `attachments` (`.text`) and `images` untouched—quickly exhausting the `4_000_000`-byte total envelope budget (`130`) and triggering session eviction.
- **Recommended Fix:** Preserve `thoughtSignature` and `tool` message `name` in `validateAndSanitizeRestoredSession`, and cap/redact `attachments[].text` (plus bound or offload large base64 `images`) inside `capForStorage()`.

### 2.5 Cross-session routing telemetry leak and bloated per-turn handoff `toolsUsed`
- **Files:** `src/host/PhotonController.ts:1694-1719, 2511-2527`
- **User Impact:** Switching sessions retains the previous session's adaptive routing banner/decision (`lastDecision`) until a new turn runs, and `ProjectContext` turn handoffs accumulate *every* tool ever invoked across the entire chat history rather than tools used in the just-completed turn.
- **Root Cause:** `loadSession()` (`2511-2527`) does not reset `this.lastDecision` (and notify the webview), and `recordTurnHandoff()` (`1699-1717`) collects `toolCalls` over all `session.messages` instead of slicing to the current turn.
- **Recommended Fix:** Clear `this.lastDecision` on `loadSession` / `newSession`, and slice `session.messages` from the active turn start index when collecting `toolsUsed` for `recordTurnHandoff()`.

---

## 3. Broken Settings & Dead / Incomplete UI Flows

### 3.1 `photon.defaultMode` setting is read and immediately overwritten with `"chat"`
- **Files:** `src/host/PhotonController.ts:214, 474`, `package.json:143-152`
- **User Impact:** Configuring `"photon.defaultMode": "agent"` or `"plan"` in VS Code settings has no effect on startup—Photon always resets to `"chat"`.
- **Root Cause:** Constructor initializes `this.mode = cfg.get<Mode>("defaultMode", "chat")` (`214`), then `initializeOnce()` unconditionally executes `this.mode = "chat";` (`474`).
- **Recommended Fix:** Remove the hardcoded `this.mode = "chat"` assignment in `initializeOnce()`.

### 3.2 Ollama `keepAlive`, `connectTimeoutMs`, and llama.cpp `requestTimeoutMs` settings are not wired
- **Files:** `package.json:99-132`, `src/host/PhotonController.ts:203-209, 405-411`, `src/host/providerCatalogService.ts:297-312`, `src/core/llm/providers/openaiCompatProvider.ts:300`
- **User Impact:**
  - `photon.ollama.keepAlive` (documented default `"-1"`, keep loaded indefinitely) is ignored because `"30m"` is hardcoded at startup and never updated on config change—models unload after 30 minutes even when set to `"-1"`.
  - `photon.ollama.connectTimeoutMs` (default `300000` ms / 5 min for slow cold loads) is never passed to `OllamaClient`.
  - `photon.llamacpp.requestTimeoutMs` (default `300000` ms) is ignored in `buildLlamaCppProvider()`, trapping llama.cpp users on `OpenAICompatProvider`'s hardcoded `90_000` ms timeout so long local prompt evaluations abort prematurely.
- **Root Cause:** `PhotonController` hardcodes `keepAlive: "30m"` (`208`), omits `connectTimeoutMs` (`203-209`), omits both inside `syncClientConfig()` (`405-411`), and `buildLlamaCppProvider()` omits `idleTimeoutMs` (`providerCatalogService.ts:297-312`).
- **Recommended Fix:** Pass `photon.ollama.keepAlive` and `photon.ollama.connectTimeoutMs` at initialization and inside `syncClientConfig()`, and pass `photon.llamacpp.requestTimeoutMs` as `idleTimeoutMs` when constructing `OpenAICompatProvider`.

### 3.3 MCP trust approval/revocation handlers have zero UI controls
- **Files:** `webview-ui/src/components/SettingsPanel.tsx:957-976`, `webview-ui/src/state/store.ts:466-467`, `src/host/PhotonController.ts:1080-1087`, `src/host/mcpCoordinator.ts:60-100`
- **User Impact:** Project `.vscode/mcp.json` servers are gated behind user trust approval for security, and Settings displays their status, **but there is no button anywhere in the webview UI to approve or revoke a server**. Users cannot enable workspace MCP servers from Photon's UI.
- **Root Cause:** `store.ts:466-467` defines `approveMcpServer` and `revokeMcpServer` and `mcpCoordinator.ts:60-100` implements both backend handlers, yet zero components under `webview-ui/src/` invoke them.
- **Recommended Fix:** Add **Approve / Connect** and **Revoke** action buttons (with config fingerprint verification matching `approveMcpServer(id, expectedFingerprint)`) inside the MCP server rows in `SettingsPanel.tsx`.

### 3.4 Missing `llama.cpp` server controls in UI & broken Windows `ollama app.exe` fallback / arg splitting
- **Files:** `webview-ui/src/components/SettingsPanel.tsx:785-795`, `webview-ui/src/components/LocalProviderHub.tsx:24`, `src/host/localProcessManager.ts:60, 115-128`
- **User Impact:**
  - Users running `llama.cpp` have no **Start** button in `SettingsPanel` when the server is stopped, and `LocalProviderHub` is locked to `"ollama"`.
  - Quoted paths/flags inside `photon.llamacpp.extraArgs` (e.g. `--lora "C:\My Models\..."`) break because `extraArgs.split(/\s+/)` splits on spaces inside quotes.
  - On Windows, if `photon.ollama.binaryPath` is set and fails, the fallback scan for `%LOCALAPPDATA%\Programs\Ollama\ollama app.exe` never runs.
- **Root Cause:** `SettingsPanel.tsx` restricts the Start control to `provider === "ollama"`, `localProcessManager.ts:60` uses naive whitespace splitting, and lines `119-128` execute an unconditional `break` on the first iteration of the `candidates` loop if `bin` was non-empty.
- **Recommended Fix:** Expose `llama.cpp` start/stop/status controls in `SettingsPanel` and `LocalProviderHub`, parse `extraArgs` with shell-quote awareness, and remove the unconditional `break` in `buildLaunchPlans()`.

---

## 4. LLM Provider, Multimodal & Webview UI Bugs

### 4.1 All cloud providers hardcode `image/png` regardless of actual image MIME type
- **Files:** `src/core/llm/normalizeMessages.ts:89-98, 201-203`, `src/core/llm/providers/openaiCompatProvider.ts:227-232`
- **User Impact:** Pasting or attaching JPEG, WebP, or GIF images in Cloud mode sends mismatched `image/png` headers—causing strict vision endpoints (especially Anthropic Claude) to reject requests with invalid-media errors.
- **Root Cause:** `normalizeAnthropicMessages()`, `normalizeGeminiMessages()`, and `OpenAICompatProvider` accept raw base64 strings (`images?: string[]`) and hardcode `"image/png"` / `data:image/png;base64,...`.
- **Recommended Fix:** Carry MIME metadata alongside image payloads (or inspect magic bytes `/9j/` = JPEG, `R0lGOD` = GIF, `UklGR` = WebP, `iVBOR` = PNG) before serializing provider payloads.

### 4.2 Pasting images can produce empty 0-byte attachments
- **Files:** `webview-ui/src/components/Composer.tsx:553-562`, `webview-ui/src/state/attachments.ts:57-84`
- **User Impact:** Certain clipboard sources / screenshot utilities populate `clipboardData.items` with an `image/*` MIME entry where `item.getAsFile()` returns `null`. Photon silently attaches a corrupted 0-byte image (`new File([new Blob([], ...)])`) instead of reading the file or warning the user.
- **Root Cause:** Fallback in `Composer.tsx:553-562` constructs an empty `Blob([])` rather than checking `clipboardData.files`, reading asynchronously, or skipping null files with a user-visible warning.
- **Recommended Fix:** Fall back to `e.clipboardData.files` / async clipboard item reading and reject/warn on 0-byte results before adding to attachment state.

### 4.3 Malformed streamed tool-call JSON is silently dropped instead of surfacing a self-correction error
- **Files:** `src/core/llm/providers/anthropicProvider.ts:266-270`, `src/core/llm/providers/openaiCompatProvider.ts:364-370`
- **User Impact:** If Anthropic or an OpenAI-compatible/llama.cpp model emits slightly truncated or invalid JSON in tool arguments, the provider drops the tool call completely (`return null`). The assistant turn ends prematurely without executing the tool or letting the agentic loop report the malformed JSON back to the model.
- **Root Cause:** Both providers discard tool calls whenever `tryJson(...)` returns `undefined`.
- **Recommended Fix:** Preserve unparsed tool calls with a structured parse-error marker/raw string so the tool pipeline returns an actionable validation error tool-result, enabling the model to retry cleanly.

### 4.4 `ChatViewProvider.dispose()` leaks `PhotonController`, and external Google Fonts break offline UX
- **Files:** `src/host/ChatViewProvider.ts:16, 50-54, 73-75, 86-88`, `webview-ui/index.html:6-8`
- **User Impact:**
  1. Disposing/deactivating the extension view cleans up VS Code message listeners but never calls `controller.dispose()`, leaving file watchers, MCP child processes, timers, and background indexing active until extension host shutdown.
  2. Photon's primary audience (airgapped / local Ollama / llama.cpp users) incurs network stalls or CSP-permitted requests to `fonts.googleapis.com` and `fonts.gstatic.com` on webview load.
- **Root Cause:** `ChatViewProvider.dispose()` (`50-54`) omits `this.controller.dispose()`, and both `ChatViewProvider.ts` CSP (`73-75, 86-88`) and `webview-ui/index.html` (`6-8`) load 5 font families from Google Fonts.
- **Recommended Fix:** Dispose `this.controller` inside `ChatViewProvider.dispose()` (and register disposal cleanly in `extension.ts`), and bundle woff2 fonts locally or default to VS Code system/editor font stacks.

---

## 5. High-Impact Performance & Scalability Optimizations

### 5.1 Indexing byte-budget check only breaks inner 8-file slice & saves VectorStore monolithically
- **Files:** `src/host/indexService.ts:343-362, 578-597`
- **User Impact:**
  - In large repositories exceeding `MAX_TOTAL_BYTES`, indexing does not stop when the cap is reached—it continues looping over every remaining 8-file slice, hashing/stat'ing files and spamming budget-reached logs.
  - Every debounced save calls `JSON.stringify(this.store.toJSON())` and rewrites the entire embedding index file in one blob, creating noticeable extension-host CPU/GC pauses and large disk I/O during active edits.
- **Root Cause:** `break` inside `for (const item of slice)` (`indexService.ts:361`) exits only the inner slice loop rather than the outer `for (let i = 0; ...)` loop; `save()` (`578-597`) re-serializes all vectors synchronously on the main thread.
- **Recommended Fix:** Replace `break` with `return` (or labeled outer break + final progress publish) once `MAX_TOTAL_BYTES` is reached, and move toward dirty-chunk/binary or worker-serialized persistence for large workspaces.

### 5.2 Context compaction uses a fixed 30s timeout and hardcodes sibling model IDs
- **Files:** `src/core/agent/compactor.ts:867-891, 975-983`
- **User Impact:** On local models or congested endpoints, model-assisted compaction regularly aborts at `30_000` ms (even when the user configured a 180s–300s inference timeout), silently falling back to lower-fidelity heuristic summaries. On cloud providers, `chooseSummarizerCandidates()` attempts fixed model IDs (`gemini:gemini-2.5-flash`, `claude:claude-haiku-4-5`, `openai:gpt-4o-mini`, `openrouter:google/gemini-2.5-flash`, `groq:llama-3.3-70b-versatile`) that may be unauthorized, unavailable on the user's tier, or deprecated before falling back to the active model—adding wasted latency on every compaction.
- **Root Cause:** `compactSessionMessages()` passes a literal `30_000` timeout (`compactor.ts:981`), and `chooseSummarizerCandidates()` (`867-891`) prepends hardcoded model strings without checking provider availability.
- **Recommended Fix:** Scale compaction timeout from the provider's configured request/idle timeout (with sensible bounds for local vs. cloud), and restrict candidate selection to user-configured or verified available models on that provider.
