3. The important issues I found
   These are the findings I'd prioritize. Some are residual problems; others are edge cases introduced by the new implementations.
   P0 — Fix before wider external testing
1. MCP processes inherit the extension host's environment
   File: mcpStdioClient.ts

Your process launch currently uses:
env: { ...process.env, ...this.env }

That means the MCP process inherits the extension host's entire environment.

Depending on the user's setup, that environment could contain:

- Provider API keys.
- GitHub credentials.
- Cloud credentials.
- Other application secrets.
  An MCP server is external executable code. A malicious or compromised MCP package could inspect the environment it inherits.

What to change:

Launch MCP processes with a minimal environment instead of the complete process.env. Pass only necessary OS variables and explicitly approved MCP-specific variables.

This is one of the most important security changes I'd make. 2. MCP server approval is tied to its ID, not its actual identity
Files: projectStore.ts, PhotonController.ts

Currently, approval is stored using the MCP server ID.

On startup, Photon checks whether that ID was previously approved and reconnects it.

Consider this scenario:

1. A developer approves an MCP server named database.
2. Its configuration points to a trusted executable.
3. Someone changes the configuration under the same ID.
4. Photon sees the existing approval and reconnects it.
   The endpoint, executable, arguments or permissions may have changed, but the approval remains valid.

What to change:

Create a trust fingerprint from the server's identity:

- Transport.
- Endpoint or executable.
- Arguments.
- Relevant configuration.
- Permission policy.
  Require reapproval whenever the fingerprint changes.

Approval should mean approval of a specific server configuration, not permanent trust in a string ID. 3. DNS validation still has a race condition
Files: dnsValidator.ts, mcpClient.ts

The implementation resolves a hostname and checks its IP addresses. But the subsequent fetch() resolves the hostname independently.

This creates a time-of-check/time-of-use gap: DNS could change between validation and the actual connection.

There is another issue in McpClient.close(): the session DELETE request uses the default redirect behaviour, without the redirect restrictions implemented in post(). That request also carries the MCP session ID and configured headers.

What to change:

Pin the validated address to the actual connection, or use a transport that enforces the validated destination. Apply redirect restrictions and destination validation to session teardown as well.

The current DNS tests validate the helper function, not the full HTTP connection behaviour. 4. Checkpoint rollback has two important correctness bugs
File: checkpointManager.ts

You fixed the earlier issue where checkpoint history was deleted after partial restoration. That was necessary.

But I found two remaining problems.

Problem A: Rollback can cross session boundaries.

rollbackToCheckpoint() finds the target index in the workspace-wide checkpoint array and processes:
const affectedCheckpoints = this.checkpoints.slice(targetIdx);

The checkpoint manager is shared at workspace level, while checkpoints contain different sessionId values.

Suppose:

- Session A creates checkpoint 1.
- Session B modifies another file and creates checkpoint 2.
- You roll back checkpoint 1 from session A.
  The rollback can include session B's changes as well. Successful pruning can also remove checkpoints belonging to other sessions.

The rollback chain should be restricted to the target checkpoint's session, and pruning must preserve other sessions' histories.

Problem B: Retrying after partial rollback may fail incorrectly.

The manager uses file modification times to detect external edits.

Imagine:

1. Rollback restores file A successfully.
2. Restoring file B fails.
3. The checkpoint is preserved.
4. You fix the problem and retry several seconds later.
   File A now has a newer modification time because Photon itself restored it. The next rollback can interpret that timestamp as an external modification and report a conflict.

The current test retries immediately, so it can miss this condition.

What to change:

Track restoration progress per file, or detect that a file already matches the original snapshot before applying external-modification conflict checks. Use content hashes or equivalent file-state verification rather than treating every newer timestamp as a user edit.

Also, recordBeforeChange() silently ignores snapshot failures, and persist() swallows storage errors. For a feature advertised as safe rollback, inability to save the original state should be visible and should not silently allow an unprotected edit.

P1 — Core reliability and intelligence 5. Context compaction can incorrectly report unfinished commands as successful
File: compactor.ts

I found this status mapping in the structured compaction extraction:
status: call.status === "error" ? "error" : "success"

This treats every status except error as success.

That includes statuses such as:

- proposed
- pending
- running
  The generated summary can then say a command was verified when it wasn't completed.

What to change:

Use explicit status mapping:
Original status Compaction representation
done Completed
error Failed
proposed Not executed
pending Awaiting approval
running In progress
Unknown Outcome unknown

Never turn an unknown or unfinished operation into a verified success.

I also noticed that provider-assisted compaction truncates each message and condenses long transcripts to their head and tail. It appends missing modified-file paths, but this does not guarantee that every important decision, inspection result or unresolved issue is retained.

That deserves more evaluation with long, realistic coding sessions. 6. Persisted project indexes can become stale
Files: indexService.ts, vectorStore.ts

This is a subtle retrieval problem.

When Photon loads an existing index, it publishes the index as ready and does not automatically reindex the workspace.

That means files modified while Photon was closed can remain stale in the index.

There is a second problem: persisted vectors record their dimension, but not the embedding-model identity.

Two different embedding models can have the same vector dimension while producing vectors from different semantic spaces.

Photon could load old vectors and query them using a new embedding model, producing misleading similarity results.

What to change:

Store the embedding model name and version alongside the index. Invalidate or rebuild the index when that identity changes.

Also validate file freshness at startup using file metadata or hashes, and incrementally update files changed since the previous indexing session. 7. The current implementation is not yet seamless local-to-cloud overflow
Files: PhotonController.ts, autoMode.ts

Your model-scoring system has improved substantially. It considers:

- Task complexity.
- Context fit.
- Tool reliability.
- Coding and reasoning capabilities.
- Benchmark throughput.
- Hardware fit.
- Cost and local preference.
  However, the controller passes modelsForUi() into planRequest(). That method separates local and cloud models according to the currently selected interface mode.

As a result, the router normally evaluates the active stack, not a combined set of local and cloud candidates.

So the current behaviour is primarily:

User selects Local or Cloud → Photon selects an appropriate model within that mode.

It is not yet the same as:

Photon starts locally → detects insufficient capability → selects a cloud model → escalates transparently.

The README currently describes cloud models as seamless overflow, which is stronger than what this routing path implements.

This isn't necessarily a defect if separate modes are your intended current behaviour. But it is important not to confuse model selection inside a mode with genuine hybrid routing. 8. Hardware recommendations are still estimates
File: modelAdvisor.ts

The new hardware advisor is a good addition, but it has limitations:

- It captures free RAM but calculates available RAM primarily from total RAM minus a safety buffer.
- GPU and RAM bandwidth values are hard-coded assumptions.
- Estimated tokens/sec are calculated from those assumptions, not measured inference results for the actual machine and model.
  Therefore, recommendations may be directionally useful without being accurate performance predictions.

What to change:

Use current free RAM in fit calculations, incorporate actual Photon Bench measurements where available, and label unbenchmarked performance as an estimate. 9. Your coding benchmark is better, but not yet a complete coding evaluation
File: bench.ts

The additions for patch validation, tool selection, recovery, verification and context retention are useful.

However, several checks still rely on fixed prompts and output-pattern matching. The patch evaluator can accept text that resembles a valid edit without actually applying the edit and verifying the resulting repository.

The new tests also use mocked LLM providers.

What to change:

Progress towards actual repository-level tasks:

1. Give a model a small real repository and a defined coding task.
2. Let it inspect, modify and test the repository.
3. Apply its actual changes.
4. Run the relevant test suite.
5. Compare the resulting repository state against objective success conditions.
   Measure successful tasks, not only successful-looking tool calls.

6. Other improvements worth doing
   Area Finding Recommended action
   Session persistence Sessions are capped at 400 messages by removing the oldest entries. Compact or archive before truncating, so important task context isn't discarded.
   Image attachments Only the newest four inline images are retained in persisted sessions. Show a clear indication when older image data is no longer available after reload.
   Approval lifecycle Always allow in session sets autoApprove = true, allowing all side-effecting tools. clearSessionApprovals() has no controller call site. Ensure the permission actually expires at the intended session boundary.
   Project configuration A checked-in .photon/config can set autoApprove: true and enable it in the controller. Do not let repository configuration independently disable user approval protections.
   Controller PhotonController.ts is still over 2,300 lines. Continue incremental extraction of session, provider and workspace orchestration.
   Documentation README says compaction triggers at 85%, while the implementation uses 75%. Synchronize documentation with actual runtime behaviour.
   Repository metadata README badges and package.json repository metadata still reference other GitHub namespaces. Update before distributing the extension.

One additional detail about approvals: the project configuration currently describes autoApprove as a team-shareable default. I would make that a user-controlled security decision instead. Opening a repository should not silently allow all its agent tool operations. 5. Testing: a very important distinction
CI successful
The latest commit, 34e3987, has a successful GitHub Actions run.

However, I checked the actual job steps. They were:

1. npm ci
2. npm run typecheck
3. npm run build
   The CI workflow does not run npm test.

You've added useful test coverage in:

- checkpoints.test.ts
- mcpSecurity.test.ts
- runtimeAndRecovery.test.ts
- benchIndexAndRouting.test.ts
- controllerServices.test.ts
  That is good progress. But these tests currently aren't being executed by the CI workflow.

I would add npm test to CI immediately, ideally as a separate job so failures are easy to identify.

Also add tests for the specific edge cases above: cross-session rollback, delayed retry after partial rollback, MCP environment isolation, MCP configuration changes after approval, embedding model changes and startup index freshness.
