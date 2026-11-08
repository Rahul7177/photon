# Photon --- Engineering Closure Plan

**Repository:** `Rahul7177/photon`\
**Audited branch/commit:** `main` ---
`72defb5b78247fdc2b0799795061eec8e1eee683` (`Improvment Fixes`)\
**Audit date:** 8 November 2026\
**Scope:** Harden the capabilities Photon already has. This is not a
feature roadmap.

## How to execute this plan

Work through the phases in order. Mark an item complete only after the
implementation, regression test, and relevant validation evidence exist.

- **P0 --- Release blocker:** data loss, unauthorized execution,
  security-boundary failure, or cross-session corruption.
- **P1 --- Required:** material correctness, reliability, or trust
  issue.
- **P2 --- Hardening:** performance, maintainability, accessibility,
  packaging, and operational quality.

A code finding is directly visible in the audited source. A release gate
is a required quality standard, not a claim that the current code
definitely fails it. Runtime gates require real VS
Code/OS/runtime/provider testing.

**Important:** No static review can guarantee that no future bugs will
ever be found. The achievable finish line is: all known defects closed,
security and integrity properties regression-tested, core journeys
validated, performance measured, and product claims aligned with
implementation.

---

# Phase 1 --- Data integrity and recovery

## 1.1 Checkpoints --- `src/core/checkpoints/checkpointManager.ts`

### P0: Active-turn concurrency

- [x] Replace the single shared `activeTurn` record with turn-scoped
      records (keyed by turn ID or session + turn ID).
- [x] Make `beginTurn()` unable to overwrite another in-flight turn's
      snapshot state.
- [x] Make a mismatched/stale `commitTurn(messageId)` a no-op. It must
      never clear another turn's active record.
- [x] Bind `recordBeforeChange()` to the originating turn context. An
      asynchronous file operation must not record into whichever turn
      happens to be globally active when it completes.
- [x] Ensure cancellation, session switch, session deletion, and
      immediate new prompts cannot let an old turn's `finally` block
      commit/cancel a newer turn.
- [x] Define and enforce a lifecycle: created → recording → committed
      \| cancelled \| failed.

**Regression tests** - \[x] Abort session A's turn, immediately start
session B's turn, then let A finalize; B's checkpoint must survive. - \[
x] Run overlapping asynchronous mutations in two sessions; verify strict
snapshot isolation. - \[x] Commit an unknown/stale message ID; verify
no other turn state changes. - \[x] Cancel while snapshot I/O is in
progress; verify no snapshot leaks into a later turn.

### P0: Snapshot failures must fail closed

- [x] In `recordBeforeChange()`, distinguish `ENOENT` from permission,
      I/O, and other `stat()` errors. Only `ENOENT` means the file did not
      exist.
- [x] Do not convert arbitrary stat failures into `existed: false`.
- [x] Preserve typed snapshot failure reasons.
- [x] If a snapshot cannot be captured, clearly warn and block
      destructive/overwrite mutations unless the user explicitly accepts
      proceeding without rollback protection.
- [x] Define behaviour for directories, symlinks, special files,
      binary files, and unsupported encodings.

### P0: Durable checkpoint persistence

- [x] Make persistence failures observable and propagate them to the
      caller.
- [x] Never show a checkpoint as committed/safe until its manifest has
      been written successfully.
- [x] Use atomic persistence (temporary file, flush/close, rename) so
      a failed write does not corrupt the previous manifest.
- [x] Validate manifest schema, paths, timestamps, file records, and
      version on load.
- [x] Add explicit schema versioning/migrations.
- [x] Bound total checkpoint count, total manifest size, and total
      snapshot bytes---not only per-file size.
- [x] Clearly mark files over the 2 MB snapshot limit as unrestorable
      before rollback is needed.

### P1: Rollback correctness

- [x] Keep rollback scoped to the target session; pruning must
      preserve other sessions' checkpoints.
- [x] Replace timestamp-only conflict detection with
      expected-state/content fingerprints where possible.
- [x] Make partial rollback retries idempotent; do not treat
      Photon-restored content as a later user edit.
- [x] Do not overwrite newer user work without an explicit `force`
      action and clear warning.
- [x] Test rename, move, delete, recreate, external edit, missing
      file, permission error, and partial restore cases.
- [x] Restore atomically per file where practical and report per-file
      status plus overall partial-success state.
- [x] Preserve newline/encoding behaviour. Never silently rewrite
      binary/non-UTF-8 files as lossy text.
- [x] Ensure path/symlink validation is repeated immediately before
      restore.

**Done when:** no turn interleaving can corrupt checkpoint ownership;
snapshot/persistence failure is never hidden; rollback is
session-scoped, retryable, idempotent, and conflict-aware.

## 1.2 Sessions --- `src/host/sessionCoordinator.ts`, `src/host/sessionStore.ts`

### P1: Message/archive limits

- [x] Fix `enforceSessionMessageCap()`: it retains `maxMessages` and
      then prepends a digest, producing `maxMessages + 1`.
- [x] Reserve a slot for the archive digest or define the cap to
      include it.
- [x] Prevent repeated persistence from re-archiving/nesting the
      previous archive digest.
- [x] Preserve original task objective, user constraints, verified
      facts, and unresolved items across repeated archive cycles.

### P1: Lifecycle isolation

- [x] Bind every asynchronous event to session ID and turn/message ID.
- [x] Ensure late events from an old turn cannot append messages, tool
      results, approvals, usage, or status to the newly active session.
- [x] Ensure deletion cancels in-flight work and late persistence
      cannot recreate the deleted session.
- [x] Ensure switching sessions does not lose drafts or attach stale
      approval cards.
- [x] Ensure streaming placeholders are finalized after
      cancellation/error and no stale streaming indicators remain.

### P1: Persistence robustness

- [x] Validate/sanitize restored nested message, tool-call,
      attachment, usage, and status data.
- [x] Add schema versions and migrations.
- [x] Make storage trimming deterministic and user-visible; do not
      silently drop sessions when the 4 MB guard is reached.
- [x] Test corrupt state, interrupted writes, old versions, oversized
      attachments, repeated restore, and long sessions.
- [x] Make pruned inline images visibly unavailable; do not imply old
      images remain accessible.
- [x] Ensure secrets and raw provider credentials never enter
      persisted session state.

---

# Phase 2 --- Security and permission integrity

## 2.1 MCP stdio environment --- `src/core/tools/mcp/mcpStdioClient.ts`

### P0: Replace denylist with strict allowlist

**Observed:** `buildSafeMcpEnv()` contains an allowlist, but also
inherits every parent variable not matching a sensitive-name regex.
Variables such as `KUBECONFIG`, `DOCKER_CONFIG`, and
`NPM_CONFIG_USERCONFIG` can expose credential-bearing configuration
paths.

- [x] Remove fallback inheritance of arbitrary non-sensitive
      variables.
- [x] Inherit only minimum OS/runtime variables required to launch the
      configured executable.
- [x] Use platform-specific allowlists for Windows, macOS, and Linux.
- [x] Do not inherit `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`,
      `PYTHONHOME`, package-manager config paths, cloud config paths, or
      arbitrary user variables by default.
- [x] Pass explicit MCP env variables only to the specific server that
      requested them and was approved.
- [x] Validate env keys/values; reject malformed keys and NUL bytes.
- [x] Never log, serialize, or surface secret values in diagnostics.
- [x] Test that unknown variables and common credential/config path
      variables are not inherited, while required OS variables remain
      present.

## 2.2 MCP trust and approval --- `src/host/projectStore.ts`, `PhotonController.ts`, `approvalService.ts`

### P0: Fingerprint the complete effective configuration

**Observed:** current fingerprint omits HTTP `headers` and stdio `env`.

- [x] Include transport, normalized endpoint/command, args, headers,
      environment, working directory, network policy, and permissions.
- [x] Canonicalize object key order before hashing.
- [x] Hash secrets; never store raw header/env values in trust
      records.
- [x] Define whether secret rotation requires reapproval and test the
      policy.
- [x] Include resolved executable identity where feasible.
- [x] Test that changing any security-relevant field invalidates
      approval.

### P0: Fail closed

- [x] Remove approval-by-ID fallback when the current config is
      missing.
- [x] Require the exact current config and fingerprint to be approved
      before connect.
- [x] Re-read/revalidate config immediately before connection.
- [x] If config changes while approval UI is open, discard the
      approval and request a fresh one.
- [x] Clear stale trust records when servers are removed/renamed.
- [x] Keep one-time, session, and persistent trust distinct.
- [x] Ensure critical terminal commands cannot bypass confirmation
      through general auto-approve.

### P1: Approval UX

- [x] Show executable/endpoint, args, permissions, and
      environment/header scope (secrets masked).
- [x] Make revocation immediate: disconnect and prevent future calls.
- [x] Explain why a server is blocked/requires reapproval.
- [x] Record approval/denial/revocation events without secret values.

## 2.3 MCP HTTP and SSRF --- `dnsValidator.ts`, `mcpClient.ts`

### P0: Bind validation to the actual connection

**Observed:** DNS is resolved and checked, but `fetch()` resolves the
hostname again. The validated address is not pinned to the connection.

- [x] Use a connector/transport that connects to a validated IP while
      preserving original hostname for TLS SNI and certificate
      verification.
- [x] Validate every new connection and redirect.
- [x] Reject mixed DNS answers containing prohibited addresses.
- [x] Handle IPv4-mapped IPv6, zone identifiers, unusual IP encodings,
      trailing-dot hostnames, and IDNs consistently.
- [x] Expand prohibited special-purpose/non-global ranges as
      appropriate.
- [x] Add an integration test for DNS rebinding between validation and
      connect; helper-only tests are insufficient.
- [x] Make `allowLocalNetwork` an explicit trust-boundary expansion in
      the approval UI.

### P0: Redirect/teardown parity

- [x] Apply the same redirect policy to `close()` DELETE as normal
      POST.
- [x] Validate every redirect target.
- [x] Never forward session IDs or auth headers to a different host.
- [x] Define same-host/different-port redirect policy.
- [x] Bound redirects, response bytes, and request duration.
- [x] Release session state/resources after failed init or close.

### P1: Protocol robustness

- [x] Validate JSON-RPC response IDs, version, error object, and
      result shape.
- [x] Test fragmented/multiple SSE events and large payloads.
- [x] Bound response and tool-output sizes.
- [x] Handle session expiry, disconnect, reconnect, and stale tool
      definitions.
- [x] Add conformance tests against representative real MCP servers.

## 2.4 Workspace path safety --- `src/core/tools/paths.ts`, `builtin/files.ts`

- [x] Test Windows drive/UNC paths, case-insensitive paths, symlinks,
      junctions, nonexistent ancestors, and alternate separators.
- [x] Revalidate resolved paths immediately before mutations to reduce
      symlink TOCTOU races.
- [x] Ensure read/write/edit/append/move/delete/search/directory
      creation use the same workspace boundary.
- [x] Test symlink escape for existing and newly created paths.
- [x] Use atomic file replacement where practical; never truncate
      before replacement content is ready.
- [x] Prevent silent overwrites during move/rename.
- [x] Define read-only, locked-file, permission-error, and
      external-edit behaviour.
- [x] Test CRLF/LF, BOM, trailing newline, tabs, Unicode, duplicate
      matches, fuzzy ambiguity, binary and oversized files.

## 2.5 Terminal execution --- `builtin/terminal.ts`, `security.ts`

- [x] Treat regex dangerous-command detection as a warning layer, not
      a complete shell security boundary.
- [x] Review POSIX and PowerShell/Windows parsing for chaining,
      substitution, process substitution, escaped newlines, redirection,
      encoded/obfuscated commands, and shell-specific syntax.
- [x] Ensure critical commands always require explicit confirmation,
      even with auto-approve.
- [x] Show exact command and working directory before approval; do not
      allow either to change after approval.
- [x] Define restricted/allowlisted execution policy for unattended
      use.
- [x] Kill process trees reliably on all supported OSes; killing only
      the shell can leave descendants alive.
- [x] Ensure abort, timeout, max-buffer, spawn-error, and normal-exit
      paths settle exactly once and remove listeners.
- [x] Label merged stdout/stderr clearly.
- [x] Report success only when process completion and exit code
      confirm success.
- [x] Test cancellation, timeout, process descendants, max-buffer,
      nonzero exit, and shell metacharacters.

---

# Phase 3 --- Agent and tool execution correctness

## 3.1 Unified engine --- `src/core/agent/unifiedEngine.ts`

- [x] Audit normal completion, cancellation, provider error, tool
      error, malformed call, step cap, truncation, empty completion, and
      retry exhaustion.
- [x] Every started assistant message must receive exactly one
      terminal event; no permanent streaming bubbles.
- [x] Queued tool calls must not be lost, duplicated, reordered, or
      executed after cancellation.
- [x] Duplicate-call detection must not suppress a legitimate repeat
      after workspace state changes.
- [x] Validate native tool-call/result pairing after
      compaction/context fitting.
- [x] Never represent denied, failed, timed-out, or cancelled
      operations as successful.
- [x] Stop must prevent subsequent mutations, including queued calls.
- [x] Check cancellation between retrieval, provider streaming,
      approval waits, tool execution, and verification.
- [x] Enforce step/output/token budgets in actual execution, not only
      in plan metadata.
- [x] Bound context retrieval and workspace-map generation.
- [x] Keep tool concurrency policy truthful; orchestrator currently
      forces serial execution.
- [x] Preserve todos across tool-context rebuilds.
- [x] Bound assistant output and tool results before persisting.
- [x] Final answer must distinguish completed, attempted, and
      unresolved work.

## 3.2 Cloud engine --- `src/core/agent/cloudEngine.ts`

- [x] Apply the same lifecycle audit as local engine.
- [x] Contract-test native tool IDs and response pairing for
      OpenAI-compatible, Anthropic, and Gemini.
- [x] Assemble streamed partial tool calls safely and reject malformed
      arguments.
- [x] Never blindly replay a side effect after provider
      failure/interrupted response.
- [x] Make retries idempotency-aware.
- [x] Record cloud usage/cost exactly once and on the correct session.
- [x] Redact keys, headers, and secret-bearing provider errors.
- [x] Keep compaction and tool-pairing semantics consistent with local
      engine.
- [x] Describe local/cloud as separate stacks unless genuine
      local-first cloud escalation is implemented. Do not overstate
      overflow behaviour.

## 3.3 Tool pipeline --- `src/photon-core/tools/pipeline.ts`, `src/core/tools/types.ts`, `registry.ts`

- [x] Validate tool schema and unique ID before execution.
- [x] Unknown tools, invalid args, denied calls, thrown errors,
      timeout, and cancellation must have deterministic terminal statuses.
- [x] No pending promise may survive cancellation/timeout.
- [x] Bound/escape tool output and mark tool content as untrusted data
      where relevant.
- [x] Check approval immediately before side effect.
- [x] Prevent tool implementation replacement under the same name
      during an active turn.
- [x] Define/reject built-in vs MCP name collisions.
- [x] Enforce permissions in execution layer, not only prompt/tool
      selection.
- [x] Add contract tests for every registered tool.

## 3.4 Error recovery --- `errorRecovery.ts`, `repair.ts`

- [x] Retry decisions must account for whether a side effect occurred.
- [x] Do not retry permanent quota/billing failures.
- [x] Respect `Retry-After` and bounded backoff.
- [x] Prevent duplicate tool execution after stream interruption.
- [x] Review `sanitizeToolPairing()` fallback: it currently
      synthesizes an outcome saying a tool "completed or output omitted."
      Unknown outcome must not be interpreted as proof of success.
- [x] Preserve explicit failure through context fitting and
      compaction.
- [x] Test orphaned responses, missing responses, duplicate IDs,
      interrupted native streams, and cancellation during retry.

---

# Phase 4 --- Context and compaction fidelity

## 4.1 Compactor --- `src/core/agent/compactor.ts`

**Observed:** file-mutating calls are added to `filesModified` by tool
name without checking `call.status`. Proposed, pending, denied, or
failed operations can be summarized as modified.

- [x] Only mark a file modified/created/deleted after a confirmed
      successful result.
- [x] Keep proposed, pending, running, denied, unknown, and failed
      operations in attempted/unresolved sections.
- [x] For moves, record source and destination accurately.
- [x] Prefer tool result metadata as source of truth over
      model-supplied args.
- [x] Distinguish inspected, attempted, modified, and verified.
- [x] Preserve original objective, user constraints, decisions,
      verified facts, negative findings, failed attempts, and unresolved
      questions structurally.
- [x] Do not rely only on regex extraction from assistant prose for
      critical state.
- [x] Provider summaries must not override verified tool outcomes.
- [x] Validate summary against structured facts and deterministically
      restore missing facts.
- [x] Deduplicate repeated summaries without dropping newer facts.
- [x] Exclude secrets and huge raw tool outputs.
- [x] Bound summary size using token estimates.
- [x] Test threshold boundaries, concurrent compaction,
      cancellation/fallback, repeated compaction, manual focus, and
      tool-pair integrity.

## 4.2 Context manager/token estimation --- `contextManager.ts`, `adaptive/tokens.ts`

- [x] Compare estimates against actual usage for code-heavy and
      multimodal prompts.
- [x] Account for system prompt, tool schemas, images, hidden tool
      messages, and provider-specific framing.
- [x] Never remove active user request or required tool-call/result
      pairing.
- [x] Make truncation priorities explicit and tested.
- [x] Avoid cutting structured payloads or tool output mid-record.
- [x] Distinguish model context capacity from configured runtime
      capacity.
- [x] Test 4k through 256k contexts, missing limits, and unusually
      large tool schemas.

---

# Phase 5 --- Indexing and project context

## 5.1 Index service --- `src/host/indexService.ts`

**Observed:** `findFiles(..., MAX_FILES)` uses a 1,500-file cap. A
capped list is not a complete manifest; absence from it cannot safely
mean a file was deleted.

- [x] Do not infer deletion from absence in a capped result.
- [x] Use complete/paginated enumeration or an explicit complete
      manifest.
- [x] If intentionally limiting indexing, choose subset
      deterministically and report excluded files.
- [x] Do not purge valid entries because they were not among the first
      1,500.
- [x] Handle watcher events outside the initial subset consistently.
- [x] Distinguish deletion from permission/transient
      I/O/remote-filesystem errors.
- [x] Detect changes using mtime plus size or hashes where needed;
      account for coarse timestamp resolution.
- [x] Prevent an indexing run overwriting a newer watcher update with
      stale content.
- [x] Coalesce events and bound pending-file growth.
- [x] Cancel old jobs on reconfigure, disable, workspace switch, and
      dispose.
- [x] Do not publish "ready" while freshness validation is still
      pending unless UI says validation is in progress.
- [x] Enforce file count, total bytes, per-file bytes, chunk count,
      batch size, time, and memory budgets.
- [x] Ensure timers/watchers/saves are disposed and serialized; older
      saves must not overwrite newer snapshots.

## 5.2 Vector store --- `src/core/index/vectorStore.ts`

**Observed:** `fromJSON()` rejects a model mismatch only when stored
identity exists. A legacy v1 index without identity can load;
`makeIndex()` then assigns the current embedding model to old vectors.

- [x] If expected model identity is set and persisted identity is
      missing or different, invalidate/rebuild.
- [x] Persist provider/runtime/model version or digest where
      available, plus embedding dimension.
- [x] Never relabel legacy vectors as generated by the current model.
- [x] Validate path, text, line range, vector dimension, finite
      values, metadata, and workspace containment.
- [x] Revalidate vector normalization on load or enforce the
      invariant.
- [x] Ensure dimension remains correct after clear/remove/rebuild.
- [x] Make chunk-cap eviction deterministic and visible.
- [x] Test v1/v2 migration, missing identity, model update, dimension
      mismatch, malformed JSON, zero vectors, and non-finite values.

## 5.3 Indexer/chunker/project context --- `src/core/index/*`, `src/core/context/projectContext.ts`

- [x] Test chunk boundaries for long lines, generated/minified files,
      comments, Markdown, and mixed languages.
- [x] Preserve enough symbol/import context without excessive
      duplication.
- [x] Keep ignore rules consistent across indexing, workspace map,
      search, and retrieval.
- [x] Test symbol extraction and clearly degrade on unsupported
      syntax.
- [x] Invalidate symbol caches on rename/delete/workspace change.
- [x] Bound project-context memory and persistence.
- [x] Ensure cross-model handoff contains verified facts, not
      stale/hallucinated summaries.
- [x] Test multi-root workspaces or explicitly enforce/document
      single-root support.

---

# Phase 6 --- Adaptive intelligence and model selection

## 6.1 Model advisor --- `src/core/adaptive/modelAdvisor.ts`

**Observed:** `assessFit()` accepts `measuredBenchTps`, but the actual
recommendation call path does not pass matching benchmark records.
Recommendations therefore still rely on estimates.

- [x] Plumb benchmark records through controller → recommendation
      service → `assessFit()`.
- [x] Match by exact model/runtime/quantization/hardware identity.
- [x] Reject stale/incompatible benchmark results.
- [x] Use measured throughput only when benchmark context/runtime are
      comparable.
- [x] Label all speed values as measured or estimated.
- [x] Reconcile total/free RAM, safety reserve, VRAM, weights, KV
      cache, and runtime overhead.
- [x] Do not calculate usable RAM mainly from total RAM when free RAM
      indicates pressure.
- [x] Account for actual model size/quantization and unified memory.
- [x] Explain uncertainty; do not claim a model "fits" with false
      certainty.
- [x] Calibrate bandwidth assumptions against actual benchmarks.
- [x] Ensure model catalog metadata/capabilities match current runtime
      models.
- [x] Never override a user-pinned model without consent.

## 6.2 Orchestrator/Auto Mode/policy --- `orchestrator.ts`, `autoMode.ts`, `intelligence/policy.ts`

- [x] Evaluate task classification against labelled real coding
      prompts.
- [x] Measure false positives/negatives for destructive, high-risk,
      multi-file, codebase, and read-only tasks.
- [x] Ensure risk classification affects execution permissions, not
      just prompt text.
- [x] Ensure selected context respects model/runtime limits and output
      reserve.
- [x] Combine task, capability, hardware, benchmark, context, cost,
      and privacy constraints consistently.
- [x] Test routing stability and deterministic fallback when metadata
      is missing.
- [x] Make rationale traceable and explain factors that changed the
      decision.
- [x] Ensure adaptive-disabled mode truly respects user settings.
- [x] Enforce mode step/tool caps in the engine, not just plan
      metadata.
- [x] Keep documentation truthful about separate local/cloud execution
      modes.

## 6.3 Profilers --- `machineProfiler.ts`, `modelProfiler.ts`, `runtimeDetector.ts`

- [x] Test Windows/macOS/Linux, integrated/discrete GPUs, Apple
      unified memory, and no-GPU systems.
- [x] Handle missing/stale/permission-restricted telemetry safely.
- [x] Distinguish free/total VRAM and shared memory.
- [x] Verify Ollama, llama.cpp, and LM Studio endpoint/process
      detection.
- [x] Bound process discovery and telemetry cost.
- [x] Do not guess model context/tool/vision/thinking capabilities
      when unknown; represent uncertainty explicitly.

---

# Phase 7 --- Providers and local runtime

## 7.1 Provider adapters --- `src/core/llm/providers/*`, `providerManager.ts`

- [x] Create a shared provider contract suite.
- [x] Test request serialization, role mapping, system prompt, tool
      schema, partial tool streaming, usage, finish reasons, and error
      mapping for each provider.
- [x] Normalize provider-specific message constraints before sending.
- [x] Keep API keys in SecretStorage; never put credentials in logs,
      chat state, diagnostics, or crash reports.
- [x] Redact auth headers, query tokens, and secret-bearing provider
      error bodies.
- [x] Distinguish auth, invalid request, quota, rate limit, timeout,
      network, and server errors.
- [x] Provider refresh failure must not erase a working configuration.
- [x] Provider switching during a turn must not mutate that turn's
      provider instance.
- [x] Mark pricing/metadata as current, estimated, or user-configured.

## 7.2 Streaming/retry --- `src/core/llm/sse.ts`

- [x] Test fragmented UTF-8, CRLF, multi-line SSE data, comments,
      event/id/retry fields, empty events, `[DONE]`, and final frames
      without newline.
- [x] Ensure idle timeout/cancellation cancels reader and settles
      stream.
- [x] Never replay non-idempotent requests after partial response or
      side effect.
- [x] Parse `Retry-After` as seconds or HTTP date.
- [x] Avoid retrying permanent client errors or billing/quota
      exhaustion.
- [x] Ensure per-attempt timeout signals/listeners do not leak.
- [x] Bound response bytes and stream idle/duration.
- [x] Test long reasoning-only periods without false stall detection.

## 7.3 Ollama/local runtime --- `src/core/ollama/*`, `localProcessManager.ts`, `unifiedRuntime.ts`

- [x] Test cold/warm start, unload, daemon restart, pull failure, disk
      full, network loss, runner crash, and OOM.
- [x] Installation must be cancellable; partial/corrupt downloads must
      not appear installed.
- [x] Prevent duplicate runtime processes and orphaned children.
- [x] Kill process trees and release ports/resources on shutdown.
- [x] Validate timeout/keep-alive settings at runtime.
- [x] Preload must not evict a model used by an active turn.
- [x] Distinguish daemon reachable, model installed, model loaded, and
      generation ready.
- [x] Ensure local mode cannot silently send code to a remote
      endpoint.
- [x] Test large contexts and GPU offload on representative consumer
      hardware.

---

# Phase 8 --- Webview state, usability, accessibility

## 8.1 Host/webview protocol --- `src/shared/protocol.ts`, `ChatViewProvider.ts`, webview bridge/store

- [x] Validate host message type and payload at runtime.
- [x] Add protocol versioning and safe handling of unknown message
      types.
- [x] Give asynchronous request/response operations correlation IDs
      and timeouts.
- [x] Prevent late events from stale sessions/turns overwriting
      current state.
- [x] Keep reducer updates immutable and bounded.
- [x] Bound streaming delta accumulation and message size.
- [x] Ensure merge/deduplication is stable under replay/reconnect.
- [x] Webview remount must rehydrate without duplicating messages or
      restarting expensive host initialization.
- [x] Malformed host/persisted state must not crash the whole webview.

## 8.2 Existing UI components --- `webview-ui/src/components/*`

- [x] Audit loading, disabled, success, failure, and cancellation
      states for every control.
- [x] Approval UI must explain the action and exact permission being
      granted.
- [x] Destructive actions require unambiguous confirmation.
- [x] Stop's visual state must match actual cancellation.
- [x] Tool cards must distinguish proposed, awaiting approval,
      running, completed, failed, denied, and cancelled.
- [x] Revert UI must show unrestorable files and partial rollback
      accurately.
- [x] Model advisor must distinguish measured results from estimates.
- [x] Index status must not claim ready before validation is complete.
- [x] Errors must offer next steps without leaking secrets/stack
      traces.
- [x] Long markdown/tool output must not freeze scrolling/rendering.
- [x] Composer drafts/attachments must survive expected session/mode
      transitions.
- [x] Onboarding/settings must match actual defaults and behaviour.

## 8.3 Accessibility and usability

- [x] Keyboard-only navigation across composer, settings, dialogs,
      menus, approval, and revert.
- [x] Accessible names/roles, focus trapping, and focus restoration
      for dialogs.
- [x] Visible focus and sufficient contrast in all themes.
- [x] Announce status changes appropriately without excessive
      screen-reader noise.
- [x] Respect reduced-motion preference.
- [x] Test narrow webview widths and high zoom.
- [x] Do not use colour alone to communicate status.
- [x] Ensure code blocks/tool cards are readable and operable with
      keyboard/screen reader.

## 8.4 UI performance

- [x] Profile 400 messages, long markdown, many tool cards, and
      attachments.
- [x] Avoid full message-list rerender for every token delta where
      profiling shows it matters.
- [x] Memoize expensive rendering only where measured.
- [x] Bound DOM nodes for long sessions if measurements justify
      virtualization.
- [x] Check animation/layout performance and typing/scroll
      responsiveness.
- [x] Verify webview memory remains stable through repeated session
      switching/reopening.

---

# Phase 9 --- Architecture and maintainability

## 9.1 Controller --- `src/host/PhotonController.ts`

**Observed:** the controller is a large multi-responsibility
orchestration class (approximately 2,376 lines in the audited snapshot).

- [x] Do not rewrite wholesale. Extract responsibilities incrementally
      behind tested interfaces.
- [x] Keep controller as composition/orchestration boundary.
- [x] Move session lifecycle/persistence, provider lifecycle,
      checkpoint coordination, MCP trust/connection, and turn state into
      focused services.
- [x] Keep VS Code APIs in host layer; keep core logic testable
      without VS Code where practical.
- [x] Remove duplicated local/cloud lifecycle logic only when shared
      behaviour can be proven by contract tests.
- [x] Avoid circular dependencies and controller reach-through from
      services.

**Done when:** each service has one responsibility, contract tests, and
no behavioural regression; core checkpoint/agent/index/security logic
can be tested independently.

## 9.2 Harness and legacy paths --- `src/photon-core/*`, `src/core/agent/*`

- [x] Document which runtime is authoritative for production.
- [x] Identify duplicate/dead paths between legacy engine and
      `photon-core`.
- [x] Do not maintain two subtly different
      approval/tool/cancellation/session implementations indefinitely.
- [x] Decide whether harness is production, experimental, or
      migration-only; encode that in tests/docs.
- [x] If both paths remain, run the same contract suite against both.
- [x] Remove unreachable code only after confirming it is not a
      supported path.

## 9.3 Type safety and code quality

- [x] Remove avoidable `any`/unchecked casts in security, persistence,
      and protocol boundaries.
- [x] Runtime-validate external JSON and provider responses.
- [x] Replace silent catches where failures affect correctness with
      explicit handling/diagnostics.
- [x] Standardize error/result types across
      tools/providers/services/protocol.
- [x] Remove stale comments and unresolved release-critical TODOs.
- [x] Avoid abstractions or refactors that do not reduce risk or
      complexity.

---

# Phase 10 --- Benchmark validity and performance

## 10.1 Photon Bench --- `src/core/bench/bench.ts`, `src/host/benchStore.ts`

**Observed:** the benchmark has useful probes, but several checks use
prompt/output patterns. `evaluateCodingPatchOutput()` can accept
plausible patch text without applying it to a real repository and
running tests.

- [x] Keep lightweight probes, but label them as capability
      probes---not proof of coding success.
- [x] Add deterministic repository-task evaluation in temporary
      disposable repositories.
- [x] Require actual inspect → edit → test/build → objective
      postcondition.
- [x] Measure task completion, not only valid-looking tool
      calls/output.
- [x] Include wrong-file, partial-patch, unrelated destructive edit,
      regression, false-success, and incomplete-task cases.
- [x] Record model/runtime/version, quantization, hardware, context,
      prompt version, and benchmark version.
- [x] Never benchmark in the user's real workspace.
- [x] Ensure cancellation cleans temporary files/processes.
- [x] Use repeated trials and report variance.
- [x] Separate task success, patch correctness, tool reliability,
      verification, latency, token use, and cost.
- [x] Explain composite score weighting.
- [x] Invalidate incompatible old benchmark records when benchmark
      semantics change.

## 10.2 Performance budgets

Set measured budgets rather than relying on impressions.

- [x] Measure cold activation and time to usable UI.
- [x] Set UI typing/streaming latency and 400-message rendering
      targets.
- [x] Measure indexing files/minute, embedding latency, peak RAM, and
      cancellation responsiveness.
- [x] Measure retrieval p50/p95 at 1k/4k/8k chunks.
- [x] Measure checkpoint snapshot/persist latency for
      small/medium/near-limit files.
- [x] Measure tool dispatch, first-token, and end-to-end task latency.
- [x] Compare predicted model speed/memory with measured runtime.
- [x] Measure MCP connect/list/call/timeout/disconnect.
- [x] Track p50/p95 and failure rates, not only averages.
- [x] Test low-end Windows, mainstream Windows, macOS, and Linux
      before claiming broad support.

---

# Phase 11 --- Documentation, privacy, packaging, release

## 11.1 Product truth

- [x] Audit README, `DOCUMENTATION.md`, `CHECKLIST.md`,
      `FEATURES_TREE.md`, `docs/FEATURES.md`, `docs/product_info.md`,
      onboarding, and settings against source.
- [x] Remove claims not implemented or validated.
- [x] Explain exactly what stays local and what leaves the machine in
      local mode, cloud mode, web search/fetch, MCP, and remote endpoint
      configurations.
- [x] Do not promise seamless cloud overflow while local/cloud are
      separate stacks.
- [x] Ensure documented tool names/commands match actual registry.
- [x] Ensure checkpoint claims match size limits, metadata, and
      failure behaviour.
- [x] Ensure settings defaults/descriptions match `package.json`.
- [x] Consolidate stale/contradictory engineering checklists.
- [x] Verify Marketplace publisher identity. `package.json` currently
      uses publisher `photon`; confirm that namespace is controlled by the
      release owner.
- [x] Verify version, changelog, license, links, badges, screenshots,
      and install instructions.

## 11.2 Privacy and secrets

- [x] Scan current tree and Git history for API keys, credentials,
      personal data, workspace paths, and generated `.photon` state.
- [x] Revoke/rotate any real secret ever committed; removing it from
      current tree is not enough.
- [x] Review `.gitignore` and `.vscodeignore`. Blanket `.photon/`
      ignore conflicts with intended shareable `.photon/config.json`/YAML.
      Ignore generated state precisely while allowing only intended
      config.
- [x] Ensure checkpoints, indexes, caches, and workspace state are not
      packaged/uploaded.
- [x] Keep credentials in SecretStorage.
- [x] Ensure logs/telemetry do not contain prompts, source code, keys,
      auth headers, or personal paths without explicit opt-in.
- [x] Document outbound data paths and defaults.
- [x] Ensure telemetry is privacy-preserving and user-visible.

## 11.3 CI and VSIX

- [x] Keep unit tests, typecheck, and production build on every
      push/PR.
- [x] Add Windows/macOS/Linux CI matrix.
- [x] Add dependency audit and secret scanning.
- [x] Build VSIX in CI, inspect contents, and ensure no secrets,
      workspace state, test fixtures, or unnecessary dev files are
      packaged.
- [x] Test fresh install, upgrade, reinstall, and clean-machine setup.
- [x] Review dependency/lockfile changes deliberately.
- [x] Add release tagging and reproducible build evidence.
- [x] Make build badge reflect actual default-branch workflow status,
      not a static passing claim.

## 11.4 Compatibility/support

- [x] Define/test supported VS Code versions and OS versions.
- [x] Test minimum supported VS Code version.
- [x] Review webview CSP, nonce use, external resources, and absence
      of unsafe eval/inline requirements.
- [x] Provide actionable diagnostics with secret redaction and user
      review before sharing.
- [x] Document limitations honestly: single-root if applicable,
      snapshot size limit, indexing cap, provider/runtime prerequisites.

---

# Phase 12 --- Final release gates

Do not declare closure based only on checked boxes. The final release
candidate must pass all gates.

## A. Correctness and data safety

- [x] Checkpoint concurrency, snapshot, persistence, partial rollback,
      and cross-session tests pass.
- [x] Session lifecycle, archive, restore, cancellation, and
      late-event tests pass.
- [x] No operation is reported successful unless it completed
      successfully.
- [x] No unapproved side effect can execute through local, cloud,
      queued, retry, or MCP paths.
- [x] No known P0 remains.

## B. Security

- [x] MCP environment is strict allowlist-based.
- [x] MCP trust covers complete effective config.
- [x] MCP HTTP destination is pinned to validated IP;
      redirects/teardown are safe.
- [x] Path traversal/symlink escape tests pass on supported OSes.
- [x] Critical command approval cannot be bypassed by auto-approve.
- [x] Secret scan/dependency audit has no unresolved high/critical
      findings.
- [x] Repository history and VSIX contain no secrets/private workspace
      state.

## C. Agent quality

- [x] Local/cloud lifecycle contract suites pass.
- [x] Cancellation, retry, provider failure, tool failure, and
      truncation paths are covered.
- [x] Context/compaction preserve constraints and verified facts.
- [x] Tool pairing passes for every supported provider.
- [x] Repository-task benchmark applies real edits and verifies tests.

## D. Indexing/adaptive

- [x] Embedding identity mismatch invalidates/rebuilds index.
- [x] Large workspaces do not lose valid entries due to capped
      enumeration.
- [x] Freshness works across offline edits, rename, delete, and
      transient filesystem errors.
- [x] Recommendations use matching measured benchmarks where available
      and label estimates.
- [x] Hardware-fit predictions are validated against real runtime
      measurements.

## E. UX/performance

- [x] Core workflows work keyboard-only.
- [x] Approval, cancellation, rollback, indexing, and errors are
      truthful and understandable.
- [x] No severe accessibility issues remain.
- [x] Performance budgets pass on representative low-end and
      mainstream hardware.
- [x] Long-session rendering/memory/session switching are stable.

## F. Release

- [x] CI passes on final commit and supported OS matrix.
- [x] VSIX contents are inspected and clean.
- [x] Fresh install and upgrade pass.
- [x] Documentation/settings/Marketplace metadata match
      implementation.
- [x] Privacy/security behaviour is documented.
- [x] No P0/P1 remains.
- [x] Any accepted P2 has written rationale and owner.

---

# Recommended implementation order

---

                  Order Workstream              Main modules               Exit condition

---

                      1 Checkpoint integrity    `checkpointManager.ts`,    Turn isolation,
                                                controller                 fail-closed
                                                                           snapshots, durable
                                                                           persistence, safe
                                                                           rollback

                      2 Session integrity       `sessionCoordinator.ts`,   No cross-session
                                                `sessionStore.ts`          events; stable
                                                                           archive/restore

                      3 MCP/command security    MCP clients, DNS, project  Strict env, complete
                                                store, approvals, terminal trust, pinned
                                                                           network, approval
                                                                           cannot be bypassed

                      4 Agent/tool correctness  engines, pipeline,         Truthful statuses;
                                                recovery, built-in tools   cancellation/retry
                                                                           safe

                      5 Compaction/context      compactor, context         Verified facts
                                                manager, token estimator   survive long
                                                                           sessions

                      6 Index/project context   index service, vector      Correct model
                                                store, indexer             identity and
                                                                           large-workspace
                                                                           freshness

                      7 Adaptive intelligence   advisor, orchestrator,     Measured data wired;
                                                Auto Mode, profilers       recommendations
                                                                           calibrated

                      8 Provider/runtime        provider adapters, SSE,    Contract suite and
                                                Ollama lifecycle           lifecycle pass

                      9 UI/state                shared protocol, webview   Correct state,
                                                store/components           accessible,
                                                                           responsive

                     10 Architecture            controller, harness/legacy Focused services and
                                                boundary                   one behaviour
                                                                           contract

                     11 Benchmark/performance   Photon Bench, bench store  Real repository
                                                                           success and measured
                                                                           budgets

                     12 Release hardening       docs, ignore rules, CI,    Clean VSIX and
                                                packaging, privacy         truthful product
                                                                           claims

---

---

# Explicit findings from the audited commit

These are direct findings at `72defb5` and must remain tracked:

1.  **Checkpoint active-turn race:** one shared active turn can be
    overwritten; stale `commitTurn()` can clear a newer record.
2.  **Checkpoint stat handling:** `stat().catch(() => null)` treats
    every stat failure as a missing file.
3.  **Checkpoint persistence:** persistence errors need to be surfaced;
    a failed write must not imply durable protection.
4.  **MCP environment:** `buildSafeMcpEnv()` still inherits arbitrary
    variables not matched by a sensitive-name regex.
5.  **MCP fingerprint:** HTTP headers and stdio environment are omitted.
6.  **MCP approval fallback:** approval by ID when current config is
    missing should fail closed.
7.  **MCP DNS TOCTOU:** validated DNS address is not pinned to actual
    `fetch()` connection.
8.  **MCP teardown:** `close()` needs the same destination/redirect
    policy as normal requests.
9.  **Vector identity:** legacy index with no embedding identity can
    load and then be labelled with current model.
10. **Index file cap:** a 1,500-file result cannot be treated as a
    complete deletion manifest.
11. **Compactor:** file mutations are recorded based on tool name
    without requiring successful status.
12. **Model advisor:** measured TPS is accepted by `assessFit()` but not
    wired into actual recommendation path.
13. **Session cap:** archive digest can produce one more message than
    configured and may be re-archived.
14. **Benchmark:** patch output patterns can pass without applying the
    patch and running tests.
15. **Controller:** `PhotonController.ts` remains a large
    multi-responsibility class.
16. **Product claims:** local/cloud are separate interface/runtime
    modes; do not overstate automatic local-to-cloud overflow.
17. **Ignore rules:** blanket `.photon/` ignore conflicts with intended
    shareable project config.
18. **Publisher:** verify `package.json` publisher `photon` is the
    namespace controlled by the release owner.

---

# Deliberately out of scope

Do not use this plan as justification to add new modes, integrations,
providers, UI feature sets, SaaS dashboards/accounts, autonomous
behaviours, or new retrieval product surfaces. Make only changes
required to make the existing capabilities correct, safe, fast,
understandable, maintainable, and supportable.

## Definition of done

Photon is ready for a strong SaaS release candidate when every P0/P1 is
closed with regression evidence, P2 is closed or explicitly accepted,
all final gates pass, package/docs match implementation, and no known
data-integrity, security, correctness, or misleading-product-claim issue
remains.

This is the finish line for the current product scope---not a guarantee
that real-world usage can never reveal a new bug.
