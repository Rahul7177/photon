# Photon --- Engineering Improvement Checklist

**Scope:** Consolidated from the repository review and the UI
walkthrough.\
**Current stage:** Personal/local testing.\
**Direction:** Local-first, with cloud support.\
**Purpose:** Improve reliability, safety, predictability and developer
experience before wider testing.

> This is an action list, not a monetization roadmap. The repository
> review was static inspection; tests and builds were not executed.
> Re-check each finding against the current branch before changing code.

## Priority levels

-   **P0 --- Critical:** privacy exposure, unsafe execution or risk of
    losing user work.
-   **P1 --- Core reliability:** long sessions, agent execution,
    context, recovery and evaluation.
-   **P2 --- Product polish:** maintainability, UI clarity and
    accessibility.

------------------------------------------------------------------------

# P0 --- Safety, privacy and workspace integrity

## 1. Keep generated Photon workspace state out of Git and VSIX

**What to do** - Add `.photon/` to `.gitignore`. - Add `.photon/**` to
`.vscodeignore`. - Remove already tracked workspace-generated context,
index, checkpoint, handoff and other local state from the repository. -
Inspect Git history for previously committed workspace paths, file
inventories, summaries or other private project metadata. Decide whether
history rewriting is required. - If documentation needs sample data, use
synthetic examples or schemas.

**End goal:** Source control and packaged extensions contain intentional
source/assets, not the developer's local workspace state.

**Done when** - `git ls-files` contains no generated `.photon` files. -
A fresh workspace's `.photon/` data is ignored. - The packaged VSIX
contains no `.photon/**` data. - Historical exposure has been reviewed
and addressed where necessary.

## 2. Make checkpoint rollback safe under partial failure

**What to do** - Review `checkpointManager.ts`, especially
`rollbackToCheckpoint()`. - Do not prune checkpoint records if any file
restoration fails. - Return per-file results: restored, skipped,
conflict or failed, with a reason. - Preserve failed checkpoint data so
the user can retry. - Detect files changed externally after checkpoint
creation; do not silently overwrite newer user work. - Revisit files
larger than 2 MB. Do not represent a checkpoint as restorable if
original content was not retained. - Consider Git-backed snapshots or
content-addressed storage for large files if needed. - Add tests for
partial restore, deleted files, external modifications, permission
errors, large files and multi-file rollback.

**End goal:** Rollback either restores the requested state or clearly
reports partial failure while preserving recovery information.

**Done when** - A failure restoring one file does not delete the
checkpoint. - A retry can complete restoration. - External modifications
are detected and handled explicitly. - Large-file limitations are
explicit in behaviour and UI. - Multi-file rollback has success and
failure tests.

## 3. Harden MCP trust boundaries and tool permissions

**What to do** - Review remote MCP URL validation. Hostname checks alone
may not prevent DNS rebinding or routing to private/local networks. -
Validate resolved destinations at connection time; block loopback,
private, link-local and prohibited ranges unless a local endpoint is
explicitly trusted. - Treat `npx` as a package runner, not proof that a
package is trusted. Show the exact command/package and require an
explicit trust decision. - Add per-server and per-tool permissions
rather than relying only on broad read-only/write distinctions. -
Approval prompts should identify the server, tool, arguments and
expected side effect. - Add an audit trail for MCP calls and approval
decisions. - Test malformed responses, redirects, DNS changes, timeouts,
crashes and cleanup.

**End goal:** MCP integrations are explicit, permission-scoped and
auditable; servers cannot quietly gain more access than intended.

**Done when** - Untrusted write/execute tools require approval. -
Prohibited network destinations are blocked, including after DNS
changes. - Users can see exactly what they are approving. -
Processes/connections are cleaned up after errors and cancellation. -
Security tests cover hostile inputs and network edge cases.

------------------------------------------------------------------------

# P1 --- Agent and session reliability

## 4. Stabilize context compaction

**What to do** - Verify the 75% auto-compaction trigger uses the active
model's actual context limit. - Preserve the original task, constraints,
decisions, important paths, changes made, unresolved questions and
relevant tool results. - Preserve tool-call/tool-result pairing and
valid message ordering. - Avoid losing user instructions or important
repository facts when compressing the middle of a conversation. -
Distinguish repository facts from model assumptions in summaries. - Add
fallback handling when provider summarization fails, times out or
returns unusable output. - Show a concise compaction event: why it
happened and what was retained. - Add long-session tests that trigger
compaction during multi-step work.

**End goal:** Long coding sessions continue correctly after compaction
without losing the task, decisions or tool state.

**Done when** - The original task remains understood after compaction. -
Tool-call/result sequences remain valid. - Summarization failure does
not corrupt the conversation. - Continuation tests pass after one or
more compactions. - The user can tell when compaction occurred.

## 5. Consolidate the agent execution path

**What to do** - Map the active path through `PhotonController`,
`AgentEngine`, `runUnifiedTurn` and `photon-core`. - Identify the
canonical runtime and which paths are legacy or experimental. - Compare
legacy and harness behaviour on representative tasks. - Move required
behaviour into the chosen runtime before removing the old path. - Keep
parity tests for tools, approvals, cancellation, streaming, recovery,
compaction and persistence. - Avoid maintaining two independent
implementations of the same agent lifecycle.

**End goal:** One understandable, testable source of truth for agent
execution.

**Done when** - The normal extension path uses a clearly documented
canonical runtime. - Required behaviour has parity tests. - No required
behaviour is lost during migration. - Experimental flags and duplicate
paths are removed or clearly isolated.

## 6. Improve failure recovery and cancellation

**What to do** - Define consistent handling for provider timeouts, rate
limits, network failures, malformed model output, local model crashes,
tool failures and interrupted streams. - Use bounded retries/backoff
only when retrying is safe. - Distinguish retryable from permanent
failures. - Preserve conversation and tool state when a request fails. -
Propagate cancellation through model requests, tools and child
processes. - Ensure failed tool calls cannot be mistaken for successful
actions. - Provide safe retry/resume actions where possible.

**End goal:** Temporary failures do not force users to restart sessions,
lose context or mistake failed operations for successful ones.

**Done when** - Timeout and local-runtime-crash tests recover or fail
with actionable messages. - Cancellation stops work and cleans up
resources. - Failed actions are visibly distinct from successful
actions. - Retrying cannot duplicate destructive operations.

## 7. Validate long-running sessions

**What to do** - Test 30--60 minute sessions with repeated tool use,
large outputs, model switching and compaction. - Check memory growth,
event/listener cleanup, stale session state and UI responsiveness. -
Verify session restoration after supported extension-host or provider
restarts. - Ensure progress and cancellation state remain accurate. -
Add repeated-session regression tests, not only single-turn tests.

**End goal:** Photon remains responsive and state-consistent during
realistic developer sessions.

**Done when** - No unbounded memory/listener growth appears in
repeated-session tests. - Session state is recoverable after supported
restarts. - The UI never remains stuck in a running state after
failure/cancellation. - Long-session scenarios are repeatable.

## 8. Make benchmarks measure actual coding success

**What to do** - Keep throughput and latency measurements, but do not
treat them as coding-quality evidence. - Add real repository tasks
requiring code reading, editing and verification. - Measure task
completion, correct file selection, patch correctness, test success,
recovery and context retention. - Replace simplistic text-match checks
that can pass without completing the task. - Run multiple trials for
nondeterministic tasks and record model, prompt, settings, hardware and
repository state. - Compare adaptive routing against a fixed-model
baseline.

**End goal:** Improvements are measured by successful coding outcomes,
not just tokens/sec or plausible responses.

**Done when** - Each benchmark task has an objective success
condition. - Results are reproducible and include configuration
details. - Regressions in task success are visible even if speed
improves. - Routing claims are supported by measured outcomes.

------------------------------------------------------------------------

# P1 --- Context, indexing and model selection

## 9. Measure and improve project indexing/retrieval

**What to do** - Benchmark indexing time, incremental update time, query
latency, memory use and relevance on small, medium and large
repositories. - Review the vector store's linear similarity scan and
approximate 8,000-chunk cap; establish whether either is a practical
bottleneck. - Exclude or filter generated, ignored, binary, oversized
and irrelevant files. - Ensure file changes, renames and deletions
invalidate stale chunks. - Build retrieval evaluations using questions
with known answers in the repository.

**End goal:** Context retrieval is fast, relevant and current without
excessive memory use or stale results.

**Done when** - Benchmarks exist for representative repositories. -
Modified/deleted files do not return stale chunks. - Retrieval relevance
is measured against known-answer cases. - Chunk limits and exclusions
are explicit.

## 10. Make adaptive model routing measurable and explainable

**What to do** - Evaluate complexity, capability, context and hardware
signals used by adaptive routing. - Build capability profiles from
repeatable task benchmarks, not only model names or advertised
capabilities. - Include context fit, tool reliability, latency, local
hardware constraints and estimated cloud cost. - Test whether current
per-level tool allowances improve completion. - Explain model selection
and routing reasons in the transparency panel. - Provide controlled
fallback when a model fails or cannot handle a task. - Make cloud
escalation visible and respect the configured local/cloud policy.

**End goal:** Photon chooses a suitable model for the task and
environment, and users can understand and control the decision.

**Done when** - Routing decisions record the signals that influenced
them. - Benchmarks compare adaptive routing with a fixed-model
baseline. - Model failure triggers controlled fallback or a clear
explanation. - Cloud use is never hidden.

## 11. Evaluate the Photon Block Protocol across models

**What to do** - Benchmark the custom `[TOOL ...]` protocol against
native function/tool calling. - Test models with different
instruction-following and tool-use capabilities. - Measure valid call
rate, malformed output, tool selection, argument accuracy and
recovery. - Test ambiguous arguments, repeated calls, escaped content,
partial streaming and malformed delimiters. - Use native tool calling
where it performs better and the custom protocol where it demonstrably
improves compatibility.

**End goal:** The protocol is a measured compatibility advantage, not an
unnecessary source of parsing failures.

**Done when** - A model-by-model evaluation exists. - Parser tests cover
malformed/adversarial outputs. - Arbitrary text or incomplete delimiters
cannot trigger unintended tools. - Protocol choice is based on measured
reliability.

------------------------------------------------------------------------

# P2 --- Maintainability and UI/UX refinement

## 12. Reduce `PhotonController.ts` responsibilities

**What to do** - Map responsibilities concentrated in the controller. -
Gradually extract session orchestration, provider configuration,
approval lifecycle, workspace lifecycle and UI message coordination into
focused services. - Keep the controller as a thin host-facing
coordinator. - Add interfaces and unit tests around extracted
services. - Extract one responsibility at a time; avoid a large rewrite.

**End goal:** Core behaviour can be tested and changed without
navigating or destabilizing one oversized controller.

**Done when** - Extracted services have clear responsibilities and
tests. - The controller delegates rather than owning all business
logic. - No unintended user-facing behaviour changes occur.

## 13. Make agent activity visible and understandable

**What to do** - Show meaningful stages from actual runtime events:
understanding request, retrieving context, selecting model, invoking
tools and verifying changes. - Distinguish thinking, tool execution,
approval waiting, success, failure and cancellation. - Keep tool details
expandable to avoid a wall of raw output. - Do not simulate progress or
show stages the runtime has not reached. - Make it clear when Photon is
waiting for approval or a provider.

**End goal:** Developers can understand what Photon is doing without
guessing whether it is stuck.

**Done when** - Every activity state maps to a real runtime event. -
Errors, approvals and cancellation are visually distinct. - The UI
returns to an accurate idle/finished state after every outcome.

## 14. Refine composer and control hierarchy

**What to do** - Keep Chat, Plan and Agent modes, but make their
behavioural differences easy to discover. - Group model, local/cloud,
thinking and attachment controls into a coherent composer hierarchy. -
Make the active inference mode obvious. - Explain whether a request may
send code/context to a cloud provider. - Keep advanced controls
accessible without giving every control equal prominence. - Test narrow
VS Code panel widths.

**End goal:** The composer is quick to use while important execution and
privacy choices remain understandable.

**Done when** - First-time users can distinguish Chat, Plan and Agent. -
Active model and inference mode are visible. - Cloud/context-sharing
implications are clear. - Controls remain usable in narrow panels.

## 15. Refine Project Context and hardware presentation

**What to do** - Separate summary metrics from detailed context/index
information. - Improve hierarchy between memory, indexed files, modules,
notes and handoff details. - Make file references actionable where
possible. - Explain hardware compatibility practically: fits in VRAM,
requires offloading, may run slowly or is not recommended. - Distinguish
measured values from estimates.

**End goal:** Users can understand what Photon knows about the project
and whether a local model is practical on their machine.

**Done when** - Context sections have clear labels and hierarchy. - File
references open relevant workspace files where supported. - Hardware
guidance is grounded in measurements and labels estimates.

## 16. Accessibility and interaction polish

**What to do** - Check keyboard navigation, focus visibility, tooltips
and accessible labels for icon-only controls. - Ensure dropdowns and
modals support Escape and sensible focus behaviour. - Check contrast for
muted text, badges and status indicators. - Respect reduced-motion
preferences. - Test different panel widths and VS Code zoom levels.

**End goal:** Photon remains usable and consistent across developer
setups and interaction styles.

**Done when** - Core workflows work by keyboard. - Icon-only controls
have accessible names and useful tooltips. - Modal/dropdown focus
behaviour is predictable. - Important status is not communicated by
colour alone.

------------------------------------------------------------------------

# Recommended implementation order

Work in small, independently testable changes. Do not combine everything
into one refactor.

  ---------------------------------------------------------------------------------
                  Order Workstream              Priority         Exit condition
  --------------------- ----------------------- ---------------- ------------------
                      1 Workspace data hygiene  P0               No generated
                                                                 `.photon` state
                                                                 tracked or
                                                                 packaged

                      2 Checkpoint/rollback     P0               Partial failures
                        integrity                                preserve recovery
                                                                 data

                      3 MCP security and        P0               Trust boundaries
                        permissions                              and approvals are
                                                                 tested

                      4 Context compaction      P1               Long tasks survive
                                                                 compaction

                      5 Agent runtime           P1               One canonical
                        consolidation                            execution path

                      6 Failure                 P1               Failures leave
                        recovery/cancellation                    consistent session
                                                                 state

                      7 Long-session regression P1               30--60 minute
                        tests                                    scenarios remain
                                                                 stable

                      8 Real coding-task        P1               Quality measured
                        evaluation                               by actual task
                                                                 outcomes

                      9 Indexing/retrieval      P1               Context is
                        evaluation                               current, relevant
                                                                 and performant

                     10 Routing/protocol        P1               Decisions are
                        evaluation                               evidence-based

                     11 Controller              P2               Responsibilities
                        decomposition                            separated
                                                                 incrementally

                     12 Agent activity/composer P2               Runtime state and
                        UX                                       controls are clear

                     13 Context/hardware UI and P2               Information is
                        accessibility                            actionable and
                                                                 accessible
  ---------------------------------------------------------------------------------

------------------------------------------------------------------------

# Regression test checklist

Run these regularly, manually and/or automatically:

-   [ ] 30--60 minute coding session with repeated file reads, edits and
    terminal calls.
-   [ ] Context compaction during a multi-step task, followed by
    successful continuation.
-   [ ] Provider timeout during a task, followed by retry or controlled
    failure.
-   [ ] Local model crash/restart while a session is active.
-   [ ] Cancellation while a tool is running.
-   [ ] Multi-file edit followed by rollback to a checkpoint.
-   [ ] Partial rollback failure followed by a successful retry.
-   [ ] File modified externally after checkpoint creation.
-   [ ] Large file changed and then reverted.
-   [ ] MCP read-only call, write call requiring approval, and denied
    approval.
-   [ ] MCP server crash, malformed response and prohibited network
    destination.
-   [ ] Model switch during a session, including context handoff.
-   [ ] Index update after file modification, rename and deletion.
-   [ ] Narrow VS Code panel layout and keyboard-only core workflow.

# Definition of ready for a wider private beta

Do not consider Photon ready merely because the interface looks polished
or a short demo succeeds. Before inviting more developers, aim for:

-   No known rollback path silently discards the only recovery data.
-   No workspace-generated context/private project state is included in
    source control or VSIX packages.
-   MCP permissions, network restrictions and approvals have meaningful
    security tests.
-   Long sessions can compact and continue without losing the task or
    corrupting tool history.
-   Provider failures and cancellation leave the session consistent.
-   The normal user path uses one clearly defined agent execution
    architecture.
-   A repeatable coding-task suite measures actual completion and
    regressions.
-   Users can tell what the agent is doing, which model is active and
    whether inference is local or cloud-based.

**Guiding principle:** Prioritize correctness, recoverability and user
trust before adding more capabilities. A smaller set of dependable agent
workflows is more valuable than a larger set of features that are
difficult to predict.
