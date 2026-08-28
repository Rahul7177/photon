# Photon — To Be Done
### What to build next to make Photon better, stable, and truly scalable

> Audit date: Aug 29 2026 — Current state: Phase 0-1 done (local extension with adaptive engine, bench, auto-mode, indexing, MCP, BYOK in-extension). `dist/extension.js 167.2kb`, `vsix ~270KB`, `tsc` clean. This doc closes the gap to the `photon-blueprint.md` + `photon-build-modules.md` production vision.

---

## How to use this doc

Work is ordered **0 → 4** — fix stability before chasing growth. Each item has **Why**, **What**, **How**, **Done when**, **Effort/Owner**. Ship a phase, tag it, then move.

---

## 0) Stabilize — Weeks 1-2 (No new features)

These remove the last "my chat stopped" support tickets.

### 0.1 Finish harness migration (from reference → runtime)
- **Why:** `src/photon-core/` is scaffolded but live turns still use `AgentEngine`. Two loops = two bugs.
- **What:** Promote `AgentLoop` + `SessionRegistry` to the active turn path; keep `AgentEngine` as fallback behind a feature flag (`photon.experimental.harness`). Port `replication: emptyStreak, cutOff, duplicate` guards parity.
- **How:** `boot/index.ts` owns construction; `PhotonController.runPrompt` switches on flag; add 10 harness-level integration tests with fake `LLMProvider`.
- **Done when:** One `chatStream` → `AgentLoop` end-to-end (ollama + llamacpp + one cloud) with existing tool suite; harness logs appear in Output Channel.
- **Effort:** M / Engine owner

### 0.2 Chat Participant + LM API surface
- **Why:** `Module 3` promised `@photon` in native Copilot Chat + `vscode.lm` provider. Without it you are an island.
- **What:** Register `ChatParticipant` + `LanguageModelChatProvider` + `LanguageModelTool<T>` wrappers so Photon models appear in VS Code's native picker and native tools flow both ways.
- **Done when:** `/@photon` works in Copilot Chat panel; `Gemini` image attached in native chat reaches Photon via `SecretStorage`.
- **Effort:** S / Extension owner

### 0.3 Tool-call robustness for Gemma-class models
- **Why:** Last screenshot ` <|tool_call>call:list_dir` leak shows Gemma still invents its own tag shape.
- **What:** Extend `parse.ts:collectXmlTags` regression tests for ` <|tool_call>` pipe + unclosed tail (done) + add 20 real Gemma/Qwen captured traces as golden parser tests.
- **Done when:** `npm test` includes `parse-golden.test.ts` 100% green; no raw tag leak in 50-turn stress run.
- **Effort:** S

---

## 1) UX & Reliability — Weeks 3-5

### 1.1 Monorepo boundaries (Module 1 debt)
- **Why:** Blueprint says `@photon/engine` must be importable by a CLI/JetBrains port. Today `src/core` ↔ `src/host` is only an `esbuild.mjs` lint, not a package boundary.
- **What:** `pnpm` workspace `packages/engine` (pure TS, no `vscode`), `packages/protocol` (Host↔Webview types), `apps/extension`, `apps/webview-ui`. `engine` publishes to local `file:` until public npm.
- **Done when:** `import { buildPlan } from "@photon/engine"` compiles with zero `vscode` in `packages/engine`; CI fails on boundary violation.
- **Effort:** M

### 1.2 Context / token honesty
- **Why:** Users on 8k models see silent trimming; `ContextMeter` recently fixed `window=budgetTokens` but still approximate.
- **What:** Swap `estimateTokens` for per-model tokenizer when available (fallback keeps heuristic). Surface `TokenUsage.breakdown` in a tooltip: `System 1.2k + History 2.8k / Budget 7k (window 8k)`.
- **Done when:** Meter matches bench `eval_count` within 10% on Ollama runs.
- **Effort:** S

### 1.3 Image path end-to-end
- **Why:** Paste/drop added, but `Anthropic`/`Gemini` still need image routing verification + `llamacpp` vision `base64` size guard.
- **What:** Add integration test: 2MB PNG → `openaiCompatProvider` `image_url` + `Gemini inlineData` + `Ollama images[]`; assert provider receives it. Add clipboard `image/png` → `File` conversion for Firefox case.
- **Done when:** `Gemma` sees pasted chart, `Claude` sees screenshot, Ollama Qwen-VL answers correctly.
- **Effort:** S

### 1.4 Per-model config v2
- **Why:** `-c / -ngl / -fa` per-model works, but no `temperature` / `top_p` / `seed` per model, no `.photon/config.yaml` team-share.
- **What:** Extend `PerModelConfig` with `sampling?: { temp, topP, seed }`; sync `.photon/config.yaml` → `ModelConfigStore` (file wins over `globalState`).
- **Done when:** Team can `git commit .photon/config.yaml` with `llamacpp:gemma: {ctx:32768, ngl:all}` and new clone sees it.
- **Effort:** S

---

## 2) Platform — Weeks 6-10

### 2.1 Publish `@photon/engine` (Module 6)
- **Why:** The moat is portable. Without a real package, JetBrains port `Module 23` is a rewrite.
- **What:** `npm publish --access public` with `CHANGELOG`, `TSDoc`, semantic versioning via `changesets`. Export `buildPlan`, `planRequest`, `ToolRegistry`, `fitToWindow`.
- **Done when:** `npx @photon/engine --help` works outside VS Code; extension imports only public API.
- **Effort:** M

### 2.2 CLI thin wrapper
- **Why:** Fastest validation that the engine boundary is real; gives terminal users and CI a way to run `photon agent "migrate X"` headless.
- **What:** `apps/cli` `photon --model qwen2.5 --prompt "fix tests"` reusing `ProviderManager` + `AgentLoop`. No UI.
- **Done when:** CLI runs the same 3 demo prompts as the extension with identical `ExecutionPlan` JSON output.
- **Effort:** M

### 2.3 CI/CD + observability (Modules 26,28)
- **Why:** Extension updates are hard to roll back; you need staged rollout.
- **What:** GitHub Actions: `typecheck + test + vsce package` on PR; `beta` channel via `vsce publish --pre-release` on `main`, `stable` on git tag. Add opt-in `Sentry` (extension) + `OTel` (engine) with PII scrub.
- **Done when:** PR cannot merge red; `beta` users get build within 10m of merge; error shows in Sentry with washed file paths.
- **Effort:** S/M

### 2.4 Security pass (Module 27)
- **Why:** MCP is your riskiest surface.
- **What:** CI `npm audit`, `trufflehog` secrets scan, `eslint-plugin-security`, MCP `path traversal` + `tool-poisoning` integration tests, provider ToS file per `providers/*.md` with review date.
- **Done when:** Checklist `Module 27` items ticketed and closed with evidence.
- **Effort:** S

---

## 3) Scale (optional SaaS track) — Only if you want revenue now

> Skip entirely if you stay extension-only. If you do it, do the legitimate BYOK route the blueprint prescribes — never pool free tiers.

### 3.1 Local BYOK is sufficient for 90%
Keep in-extension vault `SecretStorage` (today) for `Gemini/Claude/NVIDIA/OpenRouter`. Document it as the default. Do not build a proxy unless you have paying demand.

### 3.2 If demand appears: `Photon Cloud` (Modules 13-18)
- **Stack:** `apps/cloud` `Fastify`, `Postgres` (`teams` schema day 1), `Redis`, `Terraform`, `staging` mirror.
- **Vault:** `KMS`-encrypted keys, never plaintext, audit log `who routed where`.
- **Portal:** Next.js key connect → live `fetchLiveModels` (already done in extension) → Stripe `Pro/Team` subscriptions → cost dashboard (reuse `BenchStore` + router logs, disclose methodology).
- **Auth:** OAuth device-code `vscode.SecretStorage` refresh (Module 16).
- **Gate:** Every `Module 13-18` checklist green before charging a dollar; legal ToS review per provider.

---

## 4) Growth moat — After product is boringly reliable

### 4.1 Curated Skills Registry (Module 20) → Marketplace (Module 25)
- **What:** Hand-curated `skills/` repo with review checklist (network destinations, permission scope, provenance). Versioned, revocable. Only then open submissions + public review queue.
- **Done when:** 10 reviewed skills, revocation propagates to teams with notice.

### 4.2 Telemetry opt-in (Module 21) → Auto-mode tuning
- **Why:** Dataset `hardware × model × quantization × task × tok/s × tool-reliability` is the only defensible moat `photon-blueprint.md:1.4`.
- **What:** Off-by-default, plain-language privacy policy, anonymized at edge (no code, no paths), versioned heuristics update feeding `autoMode.ts:WEIGHTS` + `Bench` refresh cadence published.
- **Done when:** 500 opt-in nodes produce first `hardware-class` filtered leaderboard `Module 24`.

### 4.3 Public leaderboard (Module 24) + JetBrains port (Module 23)
- **Leaderboard:** Filter by `low/mid/high` hardware class, show `tok/s`, `tool-reliability`, `N` samples, methodology.
- **JetBrains:** Thin plugin consuming `@photon/engine` — zero duplication validates `Module 6` boundary.

---

## Execution order (Gantt-ish)

```
0 Stabilize (2w)  ─┬─ 1 UX (2w) ─┬─ 2 Platform (4w) ── optional 3 SaaS ── 4 Growth
                   │             │    (engine publish)
                   └─ 0.1 harness ── 1.1 monorepo ── 2.1 → 2.2/2.3
```

**One rule from the blueprints, non-negotiable:** never ship `14`/`25` as "rotate keys to beat rate limits." BYOK only over the user's own keys.

---

## Definition of Done for "Scalable"

- `pnpm -r build` + `npm test` green, `packages/engine` has zero `vscode` imports (CI enforced)
- Extension `beta` channel auto-publishes; rollback <10m
- Any model in `llamacpp:`/`ollama:` runs through the same `AgentLoop` with `tool repair` <2 retries, `ContextMeter` honest, paste/drop + vision E2E green
- `.photon/config.yaml` checked in → new clone gets same `AdaptivePlan`
- Telemetry off by default, policy published, audit log exists if cloud track chosen

Ship 0+1 first — that alone makes Photon feel like a product, not a demo.
