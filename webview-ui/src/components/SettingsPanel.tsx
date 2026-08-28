import { useState } from "react";
import type { ReactNode } from "react";
import type { IndexStatus, IntelligenceSetting } from "../../../src/shared/types";
import type { AppState, Actions } from "../state/store";
import { BackIcon } from "./Icons";
import { Toggle } from "./Toggle";
import { AddCustomEndpoint, CloudProviderCard } from "./CloudProviders";
import { CapabilityBadges } from "./CapabilityBadges";
import { ModelConfigs } from "./ModelConfigs";

function indexSummary(s: IndexStatus): string {
  switch (s.phase) {
    case "idle":
      return "Indexing is off.";
    case "indexing":
      return `Indexing… ${s.filesIndexed} files, ${s.chunks} chunks (${s.pending} pending).`;
    case "ready":
      return `Ready — ${s.filesIndexed} files, ${s.chunks} chunks${s.pending ? `, ${s.pending} pending` : ""}.`;
    case "unavailable":
      return s.message ?? "Embedding model unavailable.";
    case "error":
      return `Index error: ${s.message ?? "unknown"}.`;
  }
}

const INTELLIGENCE_OPTIONS: { value: IntelligenceSetting; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Photon picks the level from the model + machine." },
  { value: "max", label: "Maximum", hint: "Fully refined prompts, all tools, longest output. For capable models." },
  { value: "high", label: "High", hint: "Elaborated prompts and multi-file workflow guidance." },
  { value: "medium", label: "Medium", hint: "Standard prompts and instructions." },
  { value: "low", label: "Low", hint: "Compact prompts and few tools for weak models / tight context." },
];

export function SettingsPanel({
  state,
  actions,
  onClose,
}: {
  state: AppState;
  actions: Actions;
  onClose: () => void;
}) {
  const model = state.models.find((m) => m.name === state.selectedModel);
  const [numCtxInput, setNumCtxInput] = useState(
    state.config.numCtxOverride ? String(state.config.numCtxOverride) : ""
  );

  const commitNumCtx = () => {
    const n = parseInt(numCtxInput, 10);
    const value = Number.isFinite(n) && n > 0 ? n : 0;
    actions.setContextWindow(value);
    setNumCtxInput(value ? String(value) : "");
  };

  return (
    <div className="settings">
      <div className="settings-head">
        <button className="icon-btn" onClick={onClose} title="Back">
          <BackIcon />
        </button>
        <span className="settings-title">Settings</span>
      </div>

      <div className="settings-body">
        <Section title="Intelligence level">
          <div className="intelligence-grid">
            {INTELLIGENCE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`intelligence-opt ${state.config.intelligence === opt.value ? "active" : ""}`}
                onClick={() => actions.setIntelligence(opt.value)}
                title={opt.hint}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="settings-hint">
            {INTELLIGENCE_OPTIONS.find((o) => o.value === state.config.intelligence)?.hint}
            {state.plan && ` Active: ${state.plan.intelligence}${state.plan.intelligenceAuto ? " (auto)" : ""}.`}
          </div>
        </Section>

        <Section title="Adaptive engine">
          <Row label="Auto-tune settings & tools per model">
            <Toggle checked={state.config.adaptiveEnabled} onChange={actions.setAdaptiveEnabled} />
          </Row>
          {state.plan && state.config.adaptiveEnabled && (
            <ul className="settings-rationale">
              {(state.plan.rationale ?? []).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Context window">
          <Row
            label={`Global override tokens (0 = auto${
              state.plan ? `, currently ${state.plan.numCtx.toLocaleString()}` : ""
            })`}
          >
            <input
              className="settings-input"
              type="number"
              min={0}
              value={numCtxInput}
              onChange={(e) => setNumCtxInput(e.target.value)}
              onBlur={commitNumCtx}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              placeholder="auto"
            />
          </Row>
          {model?.contextLength && (
            <div className="settings-hint">Model max: {model.contextLength.toLocaleString()} tokens — per-model overrides below win over this global.</div>
          )}
        </Section>

        <Section title="Per-model configuration">
          <p className="provider-section-intro">
            Tune context and llama.cpp flags per model. Per-model <code>ctx</code> overrides the global window; for <code>llamacpp</code> models the flags below generate a <code>llama-server</code> launch command — restart the server with it for changes to take effect.
            Examples: <code>-c 32768</code>, <code>-ngl all</code>, <code>--fit on</code>, <code>-np 1</code>, <code>-fa on</code>, <code>-ctk q8_0 -ctv q8_0</code>.
          </p>
          <ModelConfigs state={state} actions={actions} />
        </Section>

        <Section title="Tools">
          <Row label="Auto-approve file edits & commands">
            <Toggle checked={state.config.autoApprove} onChange={actions.setAutoApprove} />
          </Row>
          <Row label="Web search">
            <select
              className="settings-select"
              value={state.config.webSearchProvider}
              onChange={(e) => actions.setWebSearchProvider(e.target.value as "duckduckgo" | "none")}
            >
              <option value="duckduckgo">DuckDuckGo</option>
              <option value="none">Disabled</option>
            </select>
          </Row>
          {state.tools.length > 0 && (
            <div className="tool-list">
              {state.tools.map((t) => (
                <div key={t.name} className="tool-list-row" title={t.summary}>
                  <span className="tool-list-name">{t.name}</span>
                  {t.sideEffecting && <span className="tool-list-badge">writes</span>}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Workspace index">
          <Row label="Index workspace for code-aware retrieval (local, offline)">
            <Toggle checked={state.config.indexingEnabled} onChange={actions.setIndexingEnabled} />
          </Row>
          <div className="settings-hint">
            {indexSummary(state.indexStatus)}
          </div>
          {state.config.indexingEnabled && state.indexStatus.phase !== "unavailable" && (
            <button className="btn" onClick={actions.reindex}>
              Re-index now
            </button>
          )}
          <div className="settings-hint">Embeds with local model: <code>{state.config.embeddingModel}</code></div>
        </Section>

        <Section title="MCP servers">
          {state.mcpServers.length === 0 ? (
            <div className="settings-hint">
              No MCP servers configured. Add them to <code>.vscode/mcp.json</code>.
            </div>
          ) : (
            <div className="mcp-list">
              {state.mcpServers.map((s) => (
                <div key={s.id} className="mcp-row">
                  <div className="mcp-info">
                    <span className="mcp-name">{s.id}</span>
                    <span className={`mcp-status mcp-${s.status}`}>{s.status}</span>
                    {s.toolCount > 0 && <span className="mcp-tools">{s.toolCount} tools</span>}
                  </div>
                  <div className="mcp-actions">
                    {s.status === "connected" ? (
                      <button className="btn btn-sm" onClick={() => actions.revokeMcpServer(s.id)}>
                        Revoke
                      </button>
                    ) : (
                      <button className="btn btn-sm" onClick={() => actions.approveMcpServer(s.id)}>
                        Approve
                      </button>
                    )}
                  </div>
                  {s.message && <div className="mcp-msg">{s.message}</div>}
                </div>
              ))}
            </div>
          )}
          <div className="settings-hint">
            Imported servers are untrusted until you approve them; their tools require confirmation.
          </div>
        </Section>

        <Section title="Model benchmarks">
          <Row label="Photon Bench — measured on this machine">
            <button className="btn btn-sm" onClick={() => actions.runBench()}>
              Benchmark all
            </button>
          </Row>
          {state.benchResults.length === 0 ? (
            <div className="settings-hint">No results yet. Photon benchmarks each model in the background.</div>
          ) : (
            <div className="bench-table">
              <div className="bench-head">
                <span>Model</span>
                <span>tok/s</span>
                <span>tools</span>
                <span>reason</span>
                <span />
              </div>
              {state.benchResults.map((b) => (
                <div key={b.model} className="bench-row">
                  <span className="bench-model" title={b.model}>{b.model}</span>
                  <span>{Math.round(b.tokensPerSec)}</span>
                  <span>{Math.round(b.toolCallReliability * 100)}%</span>
                  <span>{b.reasoningPass ? "✓" : "✕"}</span>
                  <span>
                    {state.benchRunning.includes(b.model) ? (
                      <span className="bench-running">…</span>
                    ) : (
                      <button className="btn btn-sm" onClick={() => actions.runBench(b.model)}>
                        ↻
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          {state.benchRunning.length > 0 && (
            <div className="settings-hint">Benchmarking: {state.benchRunning.join(", ")}…</div>
          )}
        </Section>

        <Section title="Machine & model">
          {state.machine && (
            <div className="settings-hint">
              {state.machine.tier} tier · {(state.machine.totalRamBytes / 1024 ** 3).toFixed(1)} GB RAM ·{" "}
              {state.machine.cpuCores} cores
              {state.machine.gpu ? ` · ${state.machine.gpu.name}` : ""}
            </div>
          )}
          {model && (
            <>
              <div className="settings-hint">
                {model.name} · {model.tier ?? "?"} tier
                {model.paramSize ? ` · ${model.paramSize}` : ""}
                {model.quantization ? ` · ${model.quantization}` : ""}
              </div>
              <CapabilityBadges model={model} />
              {model.capabilities?.length ? (
                <div className="settings-hint">raw: {model.capabilities.join(", ")}</div>
              ) : null}
            </>
          )}
          <button className="btn" onClick={actions.diagnostics}>
            View full diagnostics
          </button>
        </Section>

        <Section title="Connection">
          <div className="settings-hint">
            <code>{state.config.ollamaBaseUrl}</code>
          </div>
          <div className={`settings-status ${state.ollamaReachable ? "ok" : "err"}`}>
            {state.ollamaReachable ? "Connected" : "Not reachable"}
          </div>
        </Section>

        <Section title="Cloud providers">
          <p className="provider-section-intro">
            Connect high-end cloud models alongside your local Ollama models. Enable a provider
            and paste its API key — Photon validates the connection and lists only the models
            your account can actually use. Test a model, then add it to the header picker.
            Keys are stored securely in VS Code Secrets, never in plain settings.
          </p>
          <div className="provider-list">
            {state.config.providers
              .filter((p) => p.id !== "ollama")
              .map((p) => (
                <CloudProviderCard key={p.id} provider={p} actions={actions} state={state} />
              ))}
          </div>
          <AddCustomEndpoint actions={actions} />
          {state.config.providers.filter((p) => p.id !== "ollama").length === 0 && (
            <div className="settings-hint">
              No cloud providers connected yet — add a key above or register a custom endpoint.
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="settings-section">
      <div className="settings-section-title">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <span>{label}</span>
      {children}
    </div>
  );
}
