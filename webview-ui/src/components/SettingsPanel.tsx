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

type Tab = "general" | "tools" | "models" | "providers" | "advanced";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "⚙" },
  { id: "tools", label: "Tools", icon: "🔧" },
  { id: "models", label: "Models", icon: "🧠" },
  { id: "providers", label: "Providers", icon: "☁" },
  { id: "advanced", label: "Advanced", icon: "…" },
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
  const [tab, setTab] = useState<Tab>("general");
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

      {/* Tab bar — sticky */}
      <nav className="settings-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`settings-tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="settings-tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      {/* Scrollable body */}
      <div className="settings-scroll">
        <div className="settings-body">
          {/* ───── General ───── */}
          {tab === "general" && (
            <>
              <Category title="Intelligence level" icon="⚡">
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
              </Category>

              <Category title="Adaptive engine" icon="🎛">
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
              </Category>

              <Category title="Context window" icon="📐">
                <Row
                  label={`Global override (0 = auto${
                    state.plan ? `, now ${state.plan.numCtx.toLocaleString()}` : ""
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
                  <div className="settings-hint">Model max: {model.contextLength.toLocaleString()} tokens</div>
                )}
              </Category>
            </>
          )}

          {/* ───── Tools ───── */}
          {tab === "tools" && (
            <>
              <Category title="Safety" icon="🛡">
                <Row label="Auto-approve file edits & commands">
                  <Toggle checked={state.config.autoApprove} onChange={actions.setAutoApprove} />
                </Row>
                <div className="settings-hint">When on, Photon executes tools without asking.</div>
              </Category>

              <Category title="Web search" icon="🔍">
                <Row label="Search provider">
                  <select
                    className="settings-select"
                    value={state.config.webSearchProvider}
                    onChange={(e) => actions.setWebSearchProvider(e.target.value as "duckduckgo" | "none")}
                  >
                    <option value="duckduckgo">DuckDuckGo</option>
                    <option value="none">Disabled</option>
                  </select>
                </Row>
              </Category>

              {state.tools.length > 0 && (
                <Category title={`Available tools (${state.tools.length})`} icon="🧰" defaultOpen={false}>
                  <div className="tool-list">
                    {state.tools.map((t) => (
                      <div key={t.name} className="tool-list-row" title={t.summary}>
                        <span className="tool-list-name">{t.name}</span>
                        {t.sideEffecting && <span className="tool-list-badge">writes</span>}
                      </div>
                    ))}
                  </div>
                </Category>
              )}
            </>
          )}

          {/* ───── Models ───── */}
          {tab === "models" && (
            <>
              <Category title="Current model" icon="🤖">
                {model ? (
                  <>
                    <div className="settings-model-name">{model.name}</div>
                    <div className="settings-hint">
                      {model.tier ?? "?"} tier
                      {model.paramSize ? ` · ${model.paramSize}` : ""}
                      {model.quantization ? ` · ${model.quantization}` : ""}
                    </div>
                    <CapabilityBadges model={model} />
                  </>
                ) : (
                  <div className="settings-hint">No model selected.</div>
                )}
              </Category>

              <Category title="Per-model configuration" icon="🔧">
                <p className="provider-section-intro">
                  Tune context and llama.cpp flags. Per-model <code>ctx</code> overrides the global.
                </p>
                <ModelConfigs state={state} actions={actions} />
              </Category>

              {state.machine && (
                <Category title="Machine specs" icon="💻">
                  <div className="settings-hint">
                    {state.machine.tier} tier · {(state.machine.totalRamBytes / 1024 ** 3).toFixed(1)} GB RAM ·{" "}
                    {state.machine.cpuCores} cores
                    {state.machine.gpu ? ` · ${state.machine.gpu.name}` : ""}
                  </div>
                </Category>
              )}

              <Category title="Benchmarks" icon="📊">
                <Row label="Photon Bench — measured on this machine">
                  <button className="btn btn-sm" onClick={() => actions.runBench()}>
                    Benchmark all
                  </button>
                </Row>
                {state.benchResults.length === 0 ? (
                  <div className="settings-hint">No results yet. Benchmarks run in the background.</div>
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
              </Category>

              <Category title="Diagnostics" icon="🩺" defaultOpen={false}>
                <button className="btn" onClick={actions.diagnostics}>View full diagnostics</button>
              </Category>
            </>
          )}

          {/* ───── Providers ───── */}
          {tab === "providers" && (
            <>
              <Category title="Local connection" icon="🔌">
                <div className="settings-hint"><code>{state.config.ollamaBaseUrl}</code></div>
                <div className={`settings-status ${state.ollamaReachable ? "ok" : "err"}`}>
                  {state.ollamaReachable ? "Connected" : "Not reachable"}
                </div>
              </Category>

              <Category title="Cloud providers" icon="☁">
                <p className="provider-section-intro">
                  Connect high-end cloud models alongside local ones. Enable a provider,
                  paste its API key, test, then add to the picker.
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
                    No cloud providers yet — add a key or register a custom endpoint.
                  </div>
                )}
              </Category>
            </>
          )}

          {/* ───── Advanced ───── */}
          {tab === "advanced" && (
            <>
              <Category title="Workspace index" icon="📁">
                <Row label="Index workspace for code-aware retrieval (local, offline)">
                  <Toggle checked={state.config.indexingEnabled} onChange={actions.setIndexingEnabled} />
                </Row>
                <div className="settings-hint">{indexSummary(state.indexStatus)}</div>
                {state.config.indexingEnabled && state.indexStatus.phase !== "unavailable" && (
                  <button className="btn btn-sm" onClick={actions.reindex}>Re-index now</button>
                )}
                <div className="settings-hint">Embeds with: <code>{state.config.embeddingModel}</code></div>
              </Category>

              <Category title="MCP servers" icon="🔗">
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
                            <button className="btn btn-sm" onClick={() => actions.revokeMcpServer(s.id)}>Revoke</button>
                          ) : (
                            <button className="btn btn-sm" onClick={() => actions.approveMcpServer(s.id)}>Approve</button>
                          )}
                        </div>
                        {s.message && <div className="mcp-msg">{s.message}</div>}
                      </div>
                    ))}
                  </div>
                )}
                <div className="settings-hint">
                  Imported servers are untrusted until approved; tools require confirmation.
                </div>
              </Category>
            </>
          )}
        </div>
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

function Category({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`category${open ? " open" : ""}`}>
      <button className="category-header" onClick={() => setOpen((o) => !o)}>
        <span className="category-label">
          <span className="category-icon">{icon}</span>
          {title}
        </span>
        <span className="category-chevron">▶</span>
      </button>
      {open && <div className="category-body">{children}</div>}
    </div>
  );
}
