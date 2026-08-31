# Photon — Build Modules
### Step-by-Step Production Roadmap (SaaS-Ready)

*Derived from the Photon Strategic + Technical Blueprint, July 2026*

---

## How to use this document

Each module below is a self-contained unit of work with four sections:

- **What to build** — the concrete deliverable(s)
- **Why we're building it** — the strategic/technical reason it exists
- **How to build it effectively** — the implementation plan, in order
- **Production-readiness checklist** — what separates "it works on my machine" from "it's a SaaS product"

Modules are grouped into 5 phases that mirror the blueprint's roadmap (0 → 4). **Build in order within a phase; phases can overlap slightly at the edges, but don't start Phase 2 monetization work before Phase 1's orchestration engine is stable — the engine is the actual product.**

---

## PHASE 0 — MVP (Prove the core loop works)

Goal of this phase: a working VS Code extension that talks to a local model and feels better than raw Ollama + Copilot Chat for small models. No cloud, no billing, no auto mode yet.

### Module 1 — Extension Scaffolding & Dev Infrastructure

**What to build**
- VS Code extension skeleton (TypeScript, esbuild bundler, `package.json` contribution points)
- Monorepo structure from day one: `apps/extension`, `packages/engine`, `apps/webview-ui`, `apps/cloud` (empty until Phase 2) — use pnpm/Turborepo or Nx
- Linting/formatting (ESLint + Prettier), strict TypeScript config, pre-commit hooks (Husky + lint-staged)
- Basic CI (GitHub Actions): typecheck, lint, unit test on every PR

**Why we're building it**
The blueprint is explicit that the orchestration engine must be a *separate package* from day one (`@photon/engine`) so it can later power a CLI or JetBrains port without a rewrite. Retrofitting a monorepo after the fact is expensive — get the boundaries right before you write feature code.

**How to build it effectively**
1. Set up the monorepo with workspace boundaries enforced by package.json `exports` — the extension should only ever import `@photon/engine` through its public API, never reach into internals.
2. Scaffold the extension with `yo code` or the official `vscode-extension-samples` generator, strip it to the minimum `activate()`.
3. Wire CI before writing any feature — every subsequent module should land with green checks, not "we'll add tests later."
4. Set semantic-release or changesets up now for versioning; you'll thank yourself in Phase 4 when you're publishing `@photon/engine` to npm separately from the extension.

**Production-readiness checklist**
- [ ] Monorepo builds and typechecks clean with zero `any` in shared interfaces
- [ ] CI runs on every PR, blocks merge on failure
- [ ] Package boundaries enforced (engine has zero `vscode` imports — verify with a lint rule, not just discipline)
- [ ] README with local dev setup that a new contributor can follow in under 10 minutes

---

### Module 2 — Model Provider Abstraction (Local-first)

**What to build**
- `ModelProvider` interface: `listModels()`, `getCapabilities(modelId)`, `chat(messages, tools, opts)`, `embedding(text)`
- Concrete implementations: Ollama REST client, OpenAI-compatible client (covers llama.cpp `server` and LM Studio without custom bindings)
- Capability metadata extraction: parameter count (from Ollama `/api/show`, else parsed from model name), context window, quantization

**Why we're building it**
This is the seam that makes everything downstream — auto mode, capability profiling, cloud routing later — possible. Get the interface right now, because every other module talks *through* it, never directly to Ollama or llama.cpp.

**How to build it effectively**
1. Design the interface against Ollama first (largest install base for your target user), then validate it against an OpenAI-compatible endpoint to make sure it isn't Ollama-shaped by accident.
2. Handle streaming responses as a first-class case, not an afterthought — chat UX depends on it.
3. Write a fake/mock provider for tests so the rest of the codebase never needs a real model running to be tested.
4. Fail loudly and specifically when a provider is unreachable (model not pulled, server not running, wrong port) — this is the #1 support-ticket category for any local-model tool.

**Production-readiness checklist**
- [ ] Timeout and retry handling on every network call, with user-visible, actionable error messages
- [ ] Mock provider exists and is used in >80% of tests that touch this layer
- [ ] Graceful degradation when Ollama/llama.cpp isn't running (clear "start Ollama" prompt, not a stack trace)
- [ ] Provider abstraction has zero leakage of Ollama-specific concepts into the rest of the codebase

---

### Module 3 — Chat Participant & Sidebar UI

**What to build**
- `@photon` Chat Participant registered via VS Code's Chat Participant API
- Sidebar webview (React + Vite, VS Code Webview UI Toolkit) for model config, connection status
- Status bar item showing active model with quick-switch

**Why we're building it**
This is the surface users judge you on in the first 60 seconds. It also plugs you into VS Code's native chat UI, which the blueprint flags as free distribution — using the platform's own chat surface means Photon shows up somewhere users already trust, instead of asking them to learn a new UI cold.

**How to build it effectively**
1. Start with the Chat Participant API (`@photon` in the existing Copilot Chat panel) before building a fully custom sidebar — it's less UI work and validates the core interaction loop faster.
2. Build the sidebar webview second, scoped to config/status only for the MVP (model picker, connection health, context window indicator) — not a competing chat surface yet.
3. Use `vscode.LanguageModelChatProvider` registration so Photon-configured local models also appear in VS Code's native model picker.
4. Keep all webview↔extension messaging typed (a shared message-schema file in `packages/engine` or a dedicated `packages/protocol`) — untyped postMessage traffic is a recurring source of silent bugs in VS Code extensions.

**Production-readiness checklist**
- [ ] Webview has a loading state, an empty state, and an error state — not just the happy path
- [ ] Chat participant handles cancellation (user stops generation mid-stream) cleanly
- [ ] UI matches VS Code theming (light/dark/high-contrast) automatically via CSS variables
- [ ] No blocking UI calls on the extension host's main thread

---

### Module 4 — Core Native Tools (Minimal Set)

**What to build**
- 4–5 tools only: `read_file`, `write_file`, `list_dir`, `run_terminal`, `search_workspace`
- Confirmation UI for any write/execute tool before it runs
- Unified tool schema matching `vscode.LanguageModelTool<T>` shape

**Why we're building it**
The blueprint is emphatic: small models degrade fast as tool count and description verbosity grow. Shipping 15 tools because it's easy is actively counterproductive for your target model class — resist scope creep here even though it's tempting.

**How to build it effectively**
1. Write each tool description as **one sentence**, and put every edge case in code, never in the prompt text the model sees.
2. Make every write/execute tool require explicit user confirmation by default — this is a trust feature Cline users consistently cite, not a nice-to-have.
3. Log every tool invocation (input, output, success/failure) locally, even in the MVP — you'll need this data structure ready for the "why did this happen" transparency panel in Phase 1.
4. Design the tool interface (`PhotonTool`) now with `minCapabilityTier` and `tags` fields even though auto mode doesn't exist yet — retrofitting this later means re-touching every tool.

**Production-readiness checklist**
- [ ] Every write/execute path requires confirmation and cannot be silently auto-approved by a bug
- [ ] `run_terminal` sandboxes or clearly scopes what it can execute — this is your highest-risk tool, treat it accordingly
- [ ] Tool call inputs are validated against JSON schema before execution, not just trusted from the model output
- [ ] All tool calls are logged locally with enough detail to reconstruct "what happened and why"

---

### Module 5 — Manual Prompt Tiers & Basic Config

**What to build**
- Three static system-prompt tiers: MINIMAL, STANDARD, DETAILED — manually selectable in MVP (auto-selection comes in Phase 1)
- Basic `.photon/config.yaml` file support (model choice, active tier, context window override)

**Why we're building it**
This proves the core hypothesis of the whole product — that tuning prompt verbosity and structure to model size measurably improves small-model reliability — before you invest in the harder work of auto-selecting it. It also seeds the config-file pattern you'll build the team tier on top of in Phase 3.

**How to build it effectively**
1. Write the three tiers by hand against your target models (Qwen2.5-Coder 7B, DeepSeek-Coder-V2-Lite, a 14B+ model) and eyeball tool-call success rate differences — this is your first real validation signal.
2. Keep the config file schema versioned (`version: 1` field) from the start so you can evolve it without breaking early adopters' checked-in files.
3. Make tier selection visible in the UI at all times — users should never wonder which prompt is currently active.

**Production-readiness checklist**
- [ ] Config file is documented (a real README section, not just inline comments) and validated on load with clear error messages for malformed YAML
- [ ] Switching tiers takes effect immediately, no reload required
- [ ] Config schema is versioned so future changes don't silently break existing users' files

---

## PHASE 1 — Core Differentiator (The part nobody else has)

Goal of this phase: the orchestration engine — auto mode, capability profiling, tool-call repair, indexing, MCP — becomes real. This is the version worth publicizing.

### Module 6 — Orchestration Engine Package (`@photon/engine`)

**What to build**
- Standalone, VS Code-agnostic npm package that takes `(prompt, workspaceContext, availableModels, toolRegistry)` and returns an `ExecutionPlan` (model, prompt tier, tool set, context budget)
- Zero dependency on the `vscode` module anywhere in this package

**Why we're building it**
This is explicitly called out as your actual IP and long-term moat, separate from the extension UI. It's also what lets you port to JetBrains, Neovim, or a CLI in Phase 4 without a rewrite. If this package ever imports `vscode`, the moat leaks back into the extension and you've lost the point of separating it.

**How to build it effectively**
1. Define the `ExecutionPlan` type first, as the contract between engine and extension — build both sides against this type before wiring them together.
2. Enforce the "no vscode import" rule with an ESLint restricted-import rule in CI, not a code-review habit that erodes over time.
3. Write the engine's public API as if a stranger (future-you doing the JetBrains port) will consume it with zero VS Code knowledge.

**Production-readiness checklist**
- [ ] Package builds and is independently unit-testable with no VS Code runtime present
- [ ] Public API is documented (TSDoc minimum) as if it will be published to npm, because eventually it will be
- [ ] CI enforces the zero-`vscode`-import boundary automatically

---

### Module 7 — Capability Profiler ("Photon Bench")

**What to build**
- One-time (re-runnable) local benchmark: FIM completion task, a short tool-call task, a multi-file reasoning task
- Records latency, tokens/sec, and structured-output pass/fail per installed model
- Static hardware detection (RAM, VRAM if available, CPU cores) to seed defaults before real usage data exists

**Why we're building it**
This is both a UX safety net and the seed of the long-term data moat described in the blueprint — the benchmark dataset ("which model, which quantization, which hardware handles which task") is genuinely hard to replicate and valuable independent of the extension. It's also the thing standing between you and a flood of "this is useless" reviews from users running a 14B model on hardware that can't handle it.

**How to build it effectively**
1. Build the three benchmark tasks first as fixed, versioned test prompts with a deterministic scoring rubric — don't let scoring drift between runs or the data becomes useless for comparison.
2. Run the benchmark automatically the first time a new model is detected, with a visible progress indicator (it can take a minute or two) — never block the chat UI on it.
3. Store results locally in a simple structured format (SQLite alongside the vector store) keyed by model+quantization+hardware-class, ready to be opt-in synced to cloud telemetry in Phase 3.
4. Make results human-readable in the UI ("this model: 42 tok/s, 91% tool-call success on this machine") — this transparency builds trust and gives users something to screenshot/share, which is free marketing.

**Production-readiness checklist**
- [ ] Benchmark never blocks or freezes the extension host
- [ ] Results are versioned so a benchmark-methodology change doesn't silently corrupt comparisons across versions
- [ ] Re-running the benchmark is a one-click action, not buried in settings
- [ ] Data schema is designed to be opt-in exportable to cloud telemetry later without a rewrite

---

### Module 8 — Auto Mode Controller

**What to build**
- `planRequest(prompt, workspace, availableModels, hardwareProfile)` implementing the blueprint's pseudocode: complexity classification → candidate filtering → ranking → prompt tier selection → tool set selection
- Pin/override mechanism so users can lock a model choice per-project

**Why we're building it**
This is the core differentiator. Everything else in the product exists to feed good inputs into this function or to act on its output well. It's also the single hardest thing for competitors to copy well, because Cline/Roo would need to specialize *downward* for weak models, which cuts against how they're currently designed.

**How to build it effectively**
1. Start with a purely heuristic classifier (keyword/pattern matching on task type, file-count, diff-size estimate) — the blueprint explicitly scopes this as "heuristic, not ML" for v1. Resist the urge to reach for an ML classifier before you have usage data to justify it.
2. Build ranking as a weighted scoring function (measured tok/s, measured tool-call reliability, context headroom) with weights as named constants you can tune, not magic numbers buried in logic.
3. Ship the pin/override mechanism in the same release as auto mode itself, not as a follow-up — power users will not trust a black box on day one, and the override is your pressure valve.
4. Log every decision (chosen model, complexity score, ranking inputs) in the same structure the transparency panel (Module 12) will read from — build these two together conceptually even if UI comes later.

**Production-readiness checklist**
- [ ] Every auto-mode decision is fully explainable from logged data — no "it just picked something" black-box moments
- [ ] Pin/override always wins over auto-selection, with zero exceptions or bugs where auto mode silently overrides a pin
- [ ] Classifier and ranking weights are configuration, not hardcoded, so they can be tuned without a code release
- [ ] Fallback behavior is defined for the "no candidate model fits" case (e.g., context window too small for the task) — never silently truncate context without telling the user

---

### Module 9 — Tool Router + Repair Loop

**What to build**
- Router that exposes only the tool subset appropriate to the chosen model's capability tier (never >5–7 tools to a `minimal`-tier model)
- Repair loop: on malformed JSON or hallucinated tool name, send one corrective micro-prompt with the exact schema and parse error, retry up to 2x, then gracefully degrade

**Why we're building it**
The blueprint calls this out as the single feature likely to do more for perceived reliability than almost anything else on the list — small models frequently emit malformed tool calls, and how you handle that failure mode is the actual product experience for a large share of interactions.

**How to build it effectively**
1. Build the validator first as a pure function (schema in, model output in, valid/invalid + specific error out) — fully unit-testable without a live model.
2. Write the corrective micro-prompt template once, test it against real malformed outputs from your target small models, and keep it terse — it's competing for the same limited context/attention that caused the failure in the first place.
3. Define the "graceful degrade" path explicitly: fall back to a smaller tool subset, or surface a clear "I couldn't complete this automatically, here's what I was trying to do" message with a manual-input option — never fail silently.
4. Track repair-loop trigger rate per model in the local benchmark data — this becomes a strong signal for auto mode's ranking function over time.

**Production-readiness checklist**
- [ ] Repair loop has a hard retry ceiling (2x) with no path to an infinite retry loop
- [ ] Every degrade path ends in a user-visible, actionable message — never a silent failure
- [ ] Tool exposure count is enforced per capability tier with a test that fails the build if a tier exceeds its limit
- [ ] Repair attempts are logged with enough detail to debug "why did this model keep failing this tool call"

---

### Module 10 — Context Budget Manager & Workspace Indexing

**What to build**
- File watcher → incremental chunker (by function/class where a language server is available, else line-window) → embeddings → local vector store (sqlite-vec or LanceDB)
- Context/token budget manager that feeds auto mode a hard token ceiling per model
- Optional, explicitly opt-in cloud embeddings upgrade path

**Why we're building it**
Offline-first indexing is a hard requirement for your target hardware tier — a tool that needs network access to index a workspace defeats the local-first pitch. The budget manager is what prevents silent context overflow, which is one of the most confusing failure modes for end users (the model "forgets" things with no explanation).

**How to build it effectively**
1. Ship the local, zero-dependency vector store first; treat cloud embeddings purely as an additive quality upgrade behind an explicit opt-in toggle, never a fallback that silently sends data off-machine.
2. Build incremental re-indexing on file save/change, not full re-index on every request — full re-index on a large workspace will be unusably slow on the hardware tier you're targeting.
3. Make the context budget manager the single source of truth for "how many tokens do we have left" — every other module (prompt builder, tool router) should ask it, not compute independently and risk drift.
4. Surface index status in the sidebar (indexing / up to date / N files pending) — silent background indexing that the user can't see creates confusion about why results are inconsistent.

**Production-readiness checklist**
- [ ] Indexing works with zero network calls in the default configuration
- [ ] Cloud embeddings require explicit, informed opt-in with plain-language explanation of what leaves the machine
- [ ] Context budget manager prevents any prompt assembly from silently exceeding a model's context window
- [ ] Large workspaces (10k+ files) don't freeze the extension during initial index — background/chunked indexing with progress UI

---

### Module 11 — MCP Client Integration

**What to build**
- Photon acting as an MCP host, connecting to user-imported MCP servers over stdio and Streamable HTTP via the official MCP TypeScript SDK
- Imported MCP tools surfaced through the same unified `PhotonTool` schema as native tools
- Explicit per-server approval flow before any imported server's tools become usable

**Why we're building it**
This is a legitimate, standards-compliant way to massively expand what Photon can do without maintaining every integration yourself. But the blueprint flags 2026 MCP ecosystem incidents (path traversal, tool poisoning) explicitly — this module has real security weight, not just feature weight.

**How to build it effectively**
1. Build the SDK integration against a couple of well-known, trustworthy MCP servers first to validate the transport/schema mapping before opening it up generally.
2. Treat every imported server as untrusted by default: require explicit per-server user approval, sandbox where technically possible, and never auto-execute a newly imported server's tools without confirmation the first time.
3. Map imported MCP tool schemas through the same capability-tier gating as native tools — an imported tool with a verbose 10-paragraph description should still be filtered out for `minimal`-tier models, not given a pass because it came from MCP.
4. Log all MCP server connections and their tool invocations with the same rigor as native tools — this is your audit trail if something goes wrong.

**Production-readiness checklist**
- [ ] Every new MCP server import requires explicit user approval before its tools are usable
- [ ] Imported tools go through the same schema validation and capability-tier filtering as native tools — no bypass path
- [ ] Server connections are logged and revocable from the UI in one click
- [ ] A security review of the import path (path traversal, malicious tool descriptions) is done before this ships, per the blueprint's pre-launch checklist

---

### Module 12 — "Why Did Auto Mode Choose This" Transparency Panel

**What to build**
- UI panel showing: model picked, why (complexity signals, context budget, hardware fit), and a one-click override that lets the user pin the choice per-project

**Why we're building it**
Power users — your early-adopter audience — will not trust a black-box router, full stop. This panel is explicitly called out in the blueprint as necessary to earn that trust, and it turns the logging work you already did in Modules 8–9 into a user-facing feature instead of dead debug data.

**How to build it effectively**
1. Build this directly off the decision log structure from Module 8 — if that log wasn't designed with a human-readable explanation in mind, revisit it here rather than building a second, parallel logging path.
2. Keep the panel one click away from the chat, not buried in settings — this is a trust feature, so it needs to be discoverable in the moment a user is skeptical of a choice.
3. Make "pin this choice" a single action from the same panel — the explanation and the override belong together.

**Production-readiness checklist**
- [ ] Explanation is always available for the most recent decision, never stale or missing
- [ ] Override action is one click and takes effect on the next request with no restart required
- [ ] Panel degrades gracefully (clear empty state) before any requests have been made yet

---

## PHASE 2 — Cloud + Monetization (First revenue)

Goal of this phase: legitimate BYOK multi-provider routing, a web portal, and a paid tier. **Do not build automated free-tier pooling across providers or accounts — this is a Marketplace-pull and ban risk, explicitly ruled out in the blueprint. Every module below routes only through providers/keys the user themselves legitimately owns.**

### Module 13 — Photon Cloud Backend Foundations

**What to build**
- Node/Fastify (or Go) backend, Postgres for persistent data, Redis for session/cache
- Base service structure: auth service, router service, sync service, billing service — separate deployable units even if they share a repo initially

**Why we're building it**
This is where SaaS revenue lives, per the blueprint's three-layer model (IDE → engine → cloud). Structuring services separately now, even if co-deployed, avoids a painful split later when one service (e.g., the router) needs to scale independently of the portal.

**How to build it effectively**
1. Stand up infrastructure-as-code (Terraform or Pulumi) from the first deploy — manual cloud console changes become untraceable technical debt fast.
2. Design the Postgres schema with multi-tenancy in mind from day one (org/team boundaries), even though Phase 2 only needs individual accounts — retrofitting tenancy in Phase 3 is expensive.
3. Put a staging environment in place before production — you need somewhere to test billing and auth flows without touching real customer data.

**Production-readiness checklist**
- [ ] Infrastructure is defined as code and reproducible from scratch
- [ ] Staging environment exists and mirrors production configuration
- [ ] Database schema supports multi-tenancy (org boundary) even if unused until Phase 3
- [ ] Basic health-check/readiness endpoints exist for every service before anything depends on them

---

### Module 14 — Encrypted Key Vault & BYOK Router Service

**What to build**
- KMS-backed encrypted vault for user-provided provider API keys (never plaintext at rest)
- Stateless router service that, given a user's own configured providers, picks and proxies to the best fit — cost, latency, capability match, graceful fallback on rate-limit

**Why we're building it**
This is the legitimate version of the router idea from the original pitch: the user connects *their own* keys, and Photon helps them use their *own* existing allowances efficiently. This delivers most of the "one place to access many models" value with none of the ToS exposure of automated free-tier pooling across accounts.

**How to build it effectively**
1. Build the vault first, in isolation, with its own security review — this is your highest-liability data store (leaked API keys are a direct financial and trust incident for your users).
2. Router logic should reuse the same ranking concepts as the local auto-mode controller (capability fit, cost, latency) so the mental model is consistent for users moving between local and cloud routing.
3. Explicitly implement per-provider rate-limit detection and graceful fallback to the next configured provider — never retry-hammer a provider that just rate-limited the user, that's the exact pattern the blueprint warns against.
4. Add clear labeling everywhere a request is routed to a specific provider — users should always know which of their own accounts is being used and why.

**Production-readiness checklist**
- [ ] Keys are encrypted at rest via KMS, never logged, never returned in plaintext through any API response
- [ ] Router only ever uses providers/keys the requesting user has explicitly configured — no cross-user sharing of any kind
- [ ] Rate-limit responses from a provider trigger fallback, not retry-hammering
- [ ] Full audit log of which provider handled which request, retrievable by the user
- [ ] Legal review of each integrated provider's ToS completed before this ships (blueprint pre-launch checklist item)

---

### Module 15 — Web Portal (Next.js)

**What to build**
- Provider key connection UI, usage/cost analytics dashboard, team config profile management (stubbed until Phase 3), account/billing settings

**Why we're building it**
The portal is the customer-facing proof that Photon is a real SaaS product, not just an extension — it's also where the upgrade/upsell path to Pro lives.

**How to build it effectively**
1. Build the key-connection flow first — it's the prerequisite for the router service (Module 14) to have anything to work with, and it's the first "wow, this is a real product" moment for a paying user.
2. Build usage/cost analytics against real router-service data from day one rather than mocked data — the blueprint calls out "tokens processed, estimated cloud-equivalent cost saved" as a strong retention/upgrade mechanic even for local-only users, so wire this early.
3. Keep the portal visually and structurally simple for v1 — it doesn't need to be beautiful yet, it needs to correctly reflect account state.

**Production-readiness checklist**
- [ ] Every destructive action (revoke key, cancel subscription) has a confirmation step
- [ ] Usage/cost dashboard numbers are verifiably accurate against router-service logs, not estimated client-side
- [ ] Portal handles the zero-data states gracefully (new account, no keys connected yet)
- [ ] Basic accessibility pass (keyboard nav, contrast) before public launch

---

### Module 16 — Auth (OAuth Device-Code Flow)

**What to build**
- OAuth device-code flow that lets a user log into the Photon Cloud portal directly from inside the VS Code extension, matching the pattern established by GitHub/Copilot auth

**Why we're building it**
This is the pattern your target users already expect from VS Code — deviating from it (e.g., asking users to copy-paste an API key manually) adds friction at exactly the moment you're trying to convert a free user to Pro.

**How to build it effectively**
1. Implement against the standard OAuth 2.0 device authorization grant (RFC 8628) rather than inventing a custom flow — this is a well-trodden path with known libraries on both ends.
2. Store the resulting session/refresh token in `vscode.SecretStorage`, never settings.json.
3. Handle token expiry and refresh transparently — a user should never be surprised by a silent auth failure mid-task.

**Production-readiness checklist**
- [ ] Tokens are stored only in `SecretStorage`, never in plaintext config
- [ ] Token refresh is automatic and doesn't interrupt an in-progress chat/tool-call session
- [ ] Login flow works correctly across VS Code Desktop and remote/SSH/Codespaces contexts
- [ ] Logout fully revokes the session both locally and server-side

---

### Module 17 — Billing (Stripe)

**What to build**
- Stripe subscription integration for Photon Pro and Team tiers
- Usage-based metering scaffolding reserved for a future *disclosed, opt-in* hosted-proxy convenience tier (not built yet, but the metering plumbing should exist)

**Why we're building it**
This is literally where revenue happens. The blueprint is specific that anything usage-metered must be disclosed and opt-in, billed at cost + margin — never marketed as "free," which keeps you aligned with the same ToS-safety principle as Module 14.

**How to build it effectively**
1. Use Stripe Billing's subscription primitives directly rather than building custom invoicing logic — this is a solved problem, don't reinvent it.
2. Build webhook handling (payment succeeded/failed, subscription canceled) as the source of truth for entitlement state, not client-side assumptions after checkout.
3. Gate Pro/Team features server-side based on verified subscription status, never client-side only — a client-side-only gate is trivially bypassed and undermines the whole monetization model.

**Production-readiness checklist**
- [ ] All entitlement checks happen server-side against verified Stripe subscription state
- [ ] Webhook handling is idempotent and retried on failure (Stripe will redeliver)
- [ ] Failed payment / dunning flow is handled gracefully with clear user-facing messaging, not silent feature loss
- [ ] Test mode fully exercised (successful payment, failed card, cancellation, upgrade/downgrade) before going live

---

### Module 18 — Cost/Usage Dashboard (Local + Cloud)

**What to build**
- Dashboard showing tokens processed, estimated cloud-equivalent cost saved (even for local-only free users), and actual spend for BYOK cloud routing

**Why we're building it**
Called out explicitly in the blueprint as a strong retention and upgrade-prompt mechanic — showing a free, local-only user "you saved $47 this month vs. cloud" is a natural, honest upsell moment, not a dark pattern, since it's just surfacing real data.

**How to build it effectively**
1. Compute "cost saved" using transparent, documented cloud-equivalent pricing assumptions — publish the methodology so it doesn't read as a manufactured number.
2. Build this on the same telemetry/logging structures already created for the benchmark profiler (Module 7) and router audit log (Module 14) — don't create a third parallel data pipeline.
3. Surface this in both the extension sidebar (quick glance) and the web portal (full history/trends).

**Production-readiness checklist**
- [ ] Cost-saved methodology is documented and consistent, not silently changed over time in a way that confuses returning users
- [ ] Dashboard data matches underlying logs exactly (spot-checkable, auditable)
- [ ] Works correctly for local-only users with zero cloud spend (shows savings, not a broken/empty cloud-spend panel)

---

## PHASE 3 — Team & Scale (Land the team/enterprise tier)

### Module 19 — Config/Team Sync

**What to build**
- `.photon/config.yaml` versioned, syncable project config (model/tool/prompt profiles) that a team can check into source control and/or sync via Photon Cloud

**Why we're building it**
This is explicitly called out as the natural on-ramp from individual to team tier — teams already check in `.eslintrc`-style files, so this pattern requires no new mental model from the user.

**How to build it effectively**
1. Support git-checked-in config as the primary mechanism first (zero cloud dependency) — cloud sync is an added convenience on top, not a requirement.
2. Version the schema (already started in Module 5) and write a migration path for schema changes so a team's checked-in config from six months ago doesn't silently break.
3. Build clear conflict resolution UX for when local overrides and team config disagree — surface it, don't silently pick one.

**Production-readiness checklist**
- [ ] Config works fully via git alone, with cloud sync as pure convenience, not a hard dependency
- [ ] Schema migrations are tested against real old config files, not just synthetic ones
- [ ] Conflicts between personal and team config are surfaced to the user, never silently resolved

---

### Module 20 — Curated Tool/Skills Registry & Security Review

**What to build**
- Reviewed, curated registry of MCP servers/tools that teams can adopt with more confidence than an arbitrary import
- Security review process/checklist applied to anything entering the curated registry (path traversal, tool-poisoning patterns, excessive permission scope)

**Why we're building it**
The blueprint frames curation explicitly as a feature, not overhead, given real 2026 MCP ecosystem security incidents. For a team/enterprise buyer, "we reviewed this" is a genuine differentiator over an open, unmoderated import.

**How to build it effectively**
1. Write the review checklist first (permission scope requested, network destinations, code provenance) before accepting any submissions — you need a consistent bar, not ad hoc judgment calls.
2. Start the registry small and hand-curated rather than open-submission — quality and trust compound, and a bad early entry undermines the whole "curated" pitch.
3. Version registry entries and allow revocation — if a previously-approved server is later found to be problematic, teams need a fast path to see and remove it.

**Production-readiness checklist**
- [ ] Every registry entry has a documented review record (what was checked, by whom, when)
- [ ] Revocation of a previously-approved entry propagates to teams using it with a visible notice, not silent removal
- [ ] Registry entries declare their permission/network scope up front, visible before a team adopts them

---

### Module 21 — Telemetry Pipeline (Opt-in) & Auto-Mode Tuning

**What to build**
- Opt-in, anonymized telemetry pipeline aggregating benchmark and auto-mode-decision data across users
- Feedback loop that uses aggregated data to improve auto-mode ranking heuristics over time

**Why we're building it**
This is the long-term data moat the blueprint identifies: "which local model, at which quantization, on which hardware class, handles which task well" is a dataset nobody else has a good public answer to, and it only exists if you build the opt-in pipeline properly and users trust it enough to opt in.

**How to build it effectively**
1. Write and publish a plain-language privacy policy for this specific data flow before collecting anything — this is a trust-critical surface for a developer tool audience that will read the policy.
2. Make opt-in genuinely opt-in — off by default, or at minimum a clear, unmissable first-run choice, never a buried settings toggle enabled by default.
3. Aggregate and anonymize at the edge (strip anything workspace/code-content-identifying) before it ever leaves the client — send benchmark scores and decision metadata, never code content.
4. Feed aggregated data back into auto-mode ranking as a periodic, versioned heuristic update, not a live/real-time black box — keep it explainable via the transparency panel from Module 12.

**Production-readiness checklist**
- [ ] Telemetry is off by default or requires clear affirmative opt-in — verify with an actual first-run test, not just the setting's default value
- [ ] No code content, file paths, or workspace-identifying data ever leaves the client, verified by a data-flow audit
- [ ] Privacy policy is published and accurate to what's actually collected, reviewed before this ships
- [ ] Users can view and delete their own contributed telemetry data on request

---

### Module 22 — Enterprise Self-Hosted Gateway, SSO, Audit Logs

**What to build**
- Self-hostable Photon Cloud gateway (deployable inside a customer's own network, no data egress)
- SSO integration (SAML/OIDC)
- Audit logging sufficient for compliance review

**Why we're building it**
The blueprint notes this mirrors exactly how MCP enterprise adoption is already being sold in 2026 — compliance and control, not raw model access, is the value prop at this tier. This is also where meaningfully larger contract sizes come from.

**How to build it effectively**
1. Package the gateway as a container/Helm chart from the start — enterprise buyers expect standard deployment tooling, not bespoke install scripts.
2. Build SSO against standard SAML/OIDC providers using a mature library rather than a custom implementation — auth is not where you want to be clever.
3. Design audit logs against what a security/compliance reviewer will actually ask for (who did what, when, from where) — involve someone with enterprise-security familiarity in defining the schema if possible.

**Production-readiness checklist**
- [ ] Self-hosted deployment has zero required outbound calls to Photon's own servers (true no-data-egress claim, verifiable)
- [ ] SSO supports at least SAML and OIDC against mainstream identity providers
- [ ] Audit log covers auth events, key access, and admin actions at minimum, and is exportable
- [ ] Deployment is documented well enough for a customer's infra team to self-serve install

---

## PHASE 4 — Platform (Extension becomes a front-end to a broader platform)

### Module 23 — JetBrains / Neovim Port of the Orchestration Engine

**What to build**
- Thin JetBrains plugin and/or Neovim integration that consumes `@photon/engine` directly, reusing all orchestration logic built in Phase 1

**Why we're building it**
This is the payoff for having kept the engine VS-Code-agnostic since Module 6 — if that boundary was respected throughout, this becomes a UI-layer project, not a rewrite.

**How to build it effectively**
1. Audit `@photon/engine`'s public API against JetBrains/Neovim's actual extension capabilities before writing UI code — confirm the contract holds outside VS Code.
2. Build the thinnest possible UI layer first (chat + model picker), reusing tool/provider/auto-mode logic entirely from the engine — resist rebuilding orchestration logic per-platform.
3. Treat this as validation of the Module 6 architecture decision — any place the port requires touching engine internals is a signal the earlier boundary wasn't clean enough, worth fixing before scaling to more platforms.

**Production-readiness checklist**
- [ ] Zero orchestration logic duplicated between VS Code extension and the new port — both call the same engine package
- [ ] Feature parity tracked explicitly against the VS Code extension so the port doesn't silently lag
- [ ] Platform-specific UI still respects the same tool-confirmation and transparency-panel trust patterns from Phase 1

---

### Module 24 — Public Benchmark Leaderboard

**What to build**
- Public-facing site/page surfacing aggregated, anonymized benchmark data from Module 7/21 — "best local model for your hardware"

**Why we're building it**
This turns your internal data moat into an external marketing and distribution asset — it's genuinely useful content that draws in exactly your target audience (people choosing a local model for their hardware) organically.

**How to build it effectively**
1. Build this directly off the aggregated telemetry pipeline from Module 21 — don't create a separate data collection path.
2. Present data with clear methodology and confidence/sample-size indicators — this audience will scrutinize numbers, and a well-caveated leaderboard is more credible than an overconfident one.
3. Make it easy to filter by hardware class, since that's the actual question users have ("what should *I* run"), not just a flat model ranking.

**Production-readiness checklist**
- [ ] Methodology and sample sizes are published alongside every ranking, not just the headline numbers
- [ ] Data refreshes on a predictable, disclosed cadence
- [ ] No individually-identifying data is exposed, even indirectly, in the public dataset

---

### Module 25 — Skills/Tool Marketplace

**What to build**
- Public marketplace extending the curated registry from Module 20, with a formal submission and review pipeline, ratings, and versioning

**Why we're building it**
This is the natural evolution of curation (Module 20) into an ecosystem play — third-party developers building for Photon's tool interface extends the platform's capability without you building everything yourselves.

**How to build it effectively**
1. Reuse the Module 20 review checklist as the baseline submission bar, formalized into a documented, public submission process.
2. Version every marketplace entry and support pinning a specific version in project config — a silently auto-updating third-party tool is a supply-chain risk you control the exposure to by making versioning explicit.
3. Build revocation/delisting with the same urgency as Module 20 — a marketplace at scale will eventually have a bad actor or a compromised package, and your response speed matters.

**Production-readiness checklist**
- [ ] Formal, documented submission and review process, publicly visible
- [ ] Version pinning supported and encouraged in project config
- [ ] Fast, tested delisting/revocation path with user notification
- [ ] Basic reputation/rating system to help users assess unfamiliar entries

---

## Cross-Cutting Modules (Run in parallel throughout — not a separate phase)

These aren't sequential — they're ongoing disciplines that should start in Phase 0 and scale up through every subsequent phase.

### Module 26 — Observability & Error Tracking

**What to build**: Structured logging across extension, engine, and cloud services; error tracking (e.g., Sentry) with PII scrubbing; basic metrics/dashboards for cloud services (latency, error rate, router fallback rate).

**Why**: You cannot fix what you cannot see, and a cloud outage or a systematic tool-call failure pattern needs to be caught by you before it's caught by a wave of bad reviews.

**How**: Wire error tracking into the extension from Module 1 (with explicit opt-in and PII scrubbing, consistent with Module 21's privacy stance) and into every cloud service from Module 13 onward. Build dashboards for the router service and billing webhooks first — these are the two places silent failure costs you money or trust fastest.

**Production-readiness checklist**
- [ ] Error tracking is opt-in and scrubs code/PII before transmission
- [ ] Every cloud service has latency and error-rate dashboards with alerting thresholds
- [ ] On-call/alerting is in place before Phase 2 cloud services carry paying customers

---

### Module 27 — Security Hardening & Compliance

**What to build**: Regular dependency audits, secrets scanning in CI, the MCP import security review (Module 11), the pre-launch legal/ToS checklist from the blueprint (trademark check, provider ToS review, privacy policy, OSS license decision).

**Why**: The blueprint's explicit warning about the original router feature is really a specific instance of a general risk — anything touching third-party accounts, credentials, or imported code needs a security-first default, not a security-eventually one.

**How**: Run the blueprint's pre-launch checklist as literal, tracked tickets, not a mental note: trademark/namespace check, per-provider ToS legal review before any routing feature ships, published privacy policy before any telemetry collection, MCP import security review before that module ships, OSS license decision made explicitly and early.

**Production-readiness checklist**
- [ ] Dependency and secrets scanning run in CI on every PR
- [ ] Every blueprint pre-launch checklist item is closed, with evidence, before public launch
- [ ] Security review is a required gate for Modules 11, 14, and 20 specifically (import paths, key handling, third-party tools)

---

### Module 28 — CI/CD & Release Management

**What to build**: Automated build/test/release pipelines for the extension (VS Code Marketplace), `@photon/engine` (npm), and cloud services (containerized deploys); staged rollout capability for the extension (percentage rollout or beta channel).

**Why**: A SaaS product needs to ship safely and often. A bad extension release is worse than a bad web release — it's harder to instantly roll back for every user, since VS Code Marketplace updates propagate on the client's schedule.

**How**: Set up automated Marketplace publishing gated on CI passing, with a beta/pre-release channel for early adopters to catch regressions before general rollout. Cloud services get standard blue-green or canary deploys. Treat `@photon/engine` as a real published package with semantic versioning from Module 6 onward, since the JetBrains/Neovim port in Phase 4 will depend on version stability.

**Production-readiness checklist**
- [ ] Extension has a beta/pre-release channel used before every general release
- [ ] Cloud deploys are automated and support fast rollback
- [ ] `@photon/engine` follows semantic versioning with a changelog, published consistently

---

## Suggested Execution Order (Summary)

| Phase | Modules | Milestone |
|---|---|---|
| 0 | 1–5 | Working local extension, proves the core UX loop |
| 1 | 6–12 | Orchestration engine live — this is the version worth publicizing |
| 2 | 13–18 | First paying customers, legitimate BYOK cloud routing |
| 3 | 19–22 | Team and enterprise tier, data moat starts compounding |
| 4 | 23–25 | Platform play — engine powers more than one IDE |
| Ongoing | 26–28 | Observability, security, and release discipline throughout |

**One more time, because it matters:** never build automated aggregation of multiple providers' or accounts' free-tier allowances to exceed a single account's entitlement. Every cloud/router module above (13, 14) is scoped specifically to route through a user's *own* legitimately-owned keys — that boundary is what keeps Photon out of ToS-violation and Marketplace-removal territory while still delivering the "one place to access many models" value the original idea was reaching for.
