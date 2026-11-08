import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import {
  isLocalModel,
  matchInstalledModelName,
  type IndexStatus,
  type IntelligenceSetting,
  type ModelCapability,
} from "../../../src/shared/types";
import type { AppState, Actions } from "../state/store";
import {
  BackIcon,
  BoltIcon,
  SlidersIcon,
  RulerIcon,
  ShieldIcon,
  SearchIcon,
  ToolboxIcon,
  BotIcon,
  WrenchIcon,
  ChartIcon,
  HeartPulseIcon,
  PlugIcon,
  FolderIcon,
  LinkIcon,
  TabGeneralIcon,
  TabToolsIcon,
  TabModelsIcon,
  TabProvidersIcon,
  TabAdvancedIcon,
  CpuIcon,
  RefreshIcon,
  SparkleIcon,
  AlertTriangleIcon,
  BrainIcon,
  CodeIcon,
  EyeIcon,
  StarIcon,
  CheckIcon,
  CloseIcon,
  ChevronRightIcon,
} from "./Icons";
import { Toggle } from "./Toggle";
import { AddCustomEndpoint, CloudProviderCard } from "./CloudProviders";
import { CapabilityBadges } from "./CapabilityBadges";
import { ModelConfigs } from "./ModelConfigs";
import { LocalProviderHub } from "./LocalProviderHub";
import { PullProgressBar } from "./PullProgressBar";
import {
  CONTEXT_PRESETS,
  checkContextWindowOverflow,
  formatK,
  type ContextOverflowCheck,
} from "../contextPresets";
import { ContextWarningModal } from "./ContextWarningModal";

function indexSummary(s: IndexStatus): string {
  switch (s.phase) {
    case "idle":
      return "Indexing is off.";
    case "indexing":
      return `Indexing… ${s.filesIndexed} files (${s.pending} pending)`;
    case "validating":
      return s.message ?? `Validating freshness… ${s.filesIndexed} files`;
    case "ready":
      if (s.pending && s.pending > 0) {
        return `Updating index… ${s.filesIndexed} files (${s.pending} pending)`;
      }
      return `Ready · ${s.filesIndexed} files, ${s.chunks} chunks`;
    case "unavailable":
      return s.message ?? "Embedding model unavailable.";
    case "error":
      return `Error: ${s.message ?? "unknown"}`;
  }
}

const INTELLIGENCE_OPTIONS: { value: IntelligenceSetting; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Scales scaffolding automatically by model size." },
  { value: "max", label: "Max", hint: "Maximum guidance and worked examples for 2–8B models." },
  { value: "high", label: "High", hint: "Structured workflow and tool verification rules." },
  { value: "medium", label: "Balanced", hint: "Standard workflow and tool result synthesis." },
  { value: "low", label: "Minimal", hint: "Minimal prompt overhead for frontier models." },
];

type Tab = "general" | "tools" | "models" | "providers" | "advanced";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <TabGeneralIcon /> },
  { id: "models", label: "Models", icon: <TabModelsIcon /> },
  { id: "providers", label: "Providers", icon: <TabProvidersIcon /> },
  { id: "tools", label: "Tools", icon: <TabToolsIcon /> },
  { id: "advanced", label: "Advanced", icon: <TabAdvancedIcon /> },
];

export function SettingsPanel({
  state,
  actions,
  onClose,
  initialTab = "general",
}: {
  state: AppState;
  actions: Actions;
  onClose: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const model = state.models.find((m) => m.name === state.selectedModel);
  const [numCtxInput, setNumCtxInput] = useState(
    state.config.numCtxOverride ? String(state.config.numCtxOverride) : ""
  );
  const [ctxWarn, setCtxWarn] = useState<ContextOverflowCheck | null>(null);
  const [customPullName, setCustomPullName] = useState("");
  const [confirmUnload, setConfirmUnload] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "models" && !state.recommendations) {
      actions.requestRecommendations();
    }
    if (tab === "providers" && state.localRuntimes.length === 0) {
      actions.detectProviders();
    }
  }, [tab, state.recommendations, state.localRuntimes.length, actions]);

  const selectCtxPreset = (value: number) => {
    actions.setContextWindow(value);
    setNumCtxInput(value ? String(value) : "");
    if (value > 0) {
      const check = checkContextWindowOverflow(value, model, state.machine);
      if (check.overflows) setCtxWarn(check);
    }
  };

  const commitNumCtx = () => {
    const n = parseInt(numCtxInput, 10);
    const value = Number.isFinite(n) && n > 0 ? n : 0;
    selectCtxPreset(value);
  };

  const isPulling = Boolean(
    state.pullProgress && state.pullProgress.phase === "pulling" && !state.pullProgress.error
  );

  return (
    <div className="settings">
      <div className="settings-head">
        <button className="icon-btn" onClick={onClose} title="Back">
          <BackIcon />
        </button>
        <span className="settings-title">Settings</span>
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            onClose();
            actions.openOnboarding();
          }}
          title="Launch the guided Local & Cloud Provider Setup Wizard"
        >
          <SparkleIcon />
          <span>Setup Wizard</span>
        </button>
      </div>

      <nav className="settings-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`settings-tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="settings-tab-icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      <div className="settings-scroll">
        <div className="settings-body">
          {/* ───── General ───── */}
          {tab === "general" && (
            <>
              <Category title="Adaptive Scaffolding" iconNode={<BoltIcon />}>
                <div className="intelligence-grid">
                  {INTELLIGENCE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`intelligence-opt ${
                        state.config.intelligence === opt.value ? "active" : ""
                      }`}
                      onClick={() => actions.setIntelligence(opt.value)}
                      title={opt.hint}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="settings-hint">
                  {INTELLIGENCE_OPTIONS.find((o) => o.value === state.config.intelligence)?.hint}
                </div>
              </Category>

              <Category title="Adaptive Engine" iconNode={<SlidersIcon />}>
                <Row label="Hardware-aware context & model tuning">
                  <Toggle
                    checked={state.config.adaptiveEnabled}
                    onChange={actions.setAdaptiveEnabled}
                  />
                </Row>
              </Category>

              <Category title="Context Limit" iconNode={<RulerIcon />}>
                <div className="ctx-preset-grid">
                  {CONTEXT_PRESETS.map((p) => {
                    const isCloud = state.config.interfaceMode === "cloud";
                    const active = isCloud
                      ? p.value === 0
                      : (state.config.numCtxOverride || 0) === p.value;
                    const disabled = isCloud && p.value !== 0;
                    return (
                      <button
                        key={p.value}
                        className={`intelligence-opt ${active ? "active" : ""}`}
                        disabled={disabled}
                        onClick={() => !disabled && selectCtxPreset(p.value)}
                        title={
                          isCloud ? "Cloud models use their native context window" : p.label
                        }
                      >
                        {p.value === 0
                          ? isCloud
                            ? `Native (${formatK(
                                model?.contextLength ?? state.plan?.contextWindow ?? 128000
                              )})`
                            : "Auto"
                          : formatK(p.value)}
                      </button>
                    );
                  })}
                </div>
                <Row
                  label={`Custom tokens (${
                    state.plan ? `active: ${formatK(state.plan.numCtx)}` : "0 = Auto"
                  })`}
                >
                  <input
                    className="settings-input"
                    type="number"
                    min={0}
                    disabled={state.config.interfaceMode === "cloud"}
                    value={state.config.interfaceMode === "cloud" ? "" : numCtxInput}
                    onChange={(e) => setNumCtxInput(e.target.value)}
                    onBlur={commitNumCtx}
                    onKeyDown={(e) =>
                      e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()
                    }
                    placeholder={state.config.interfaceMode === "cloud" ? "native" : "auto"}
                  />
                </Row>
              </Category>
            </>
          )}

          {/* ───── Models ───── */}
          {tab === "models" && (
            <>
              <Category title="Active Model" iconNode={<BotIcon />}>
                {model ? (
                  <>
                    <div className="settings-row">
                      <span className="settings-model-name">{model.name}</span>
                      <span className="settings-hint">
                        {model.tier ?? "standard"}
                        {model.paramSize ? ` · ${model.paramSize}` : ""}
                        {model.quantization ? ` · ${model.quantization}` : ""}
                      </span>
                    </div>
                    <CapabilityBadges model={model} />
                  </>
                ) : (
                  <div className="settings-hint">No model selected.</div>
                )}

                {state.ollamaRuntime.length > 0 && (
                  <div className="runtime-loaded-list">
                    {state.ollamaRuntime.map((rt) => (
                      <div key={rt.name} className="runtime-loaded-row">
                        <span className="runtime-loaded-name">{rt.name}</span>
                        <span className="runtime-loaded-meta">
                          {rt.gpuPercent}% GPU · {(rt.sizeBytes / 1024 ** 3).toFixed(1)} GB
                        </span>
                        {confirmUnload === rt.name ? (
                          <span className="hw-confirm-inline">
                            <button
                              className="btn btn-sm ghost"
                              onClick={() => setConfirmUnload(null)}
                            >
                              Cancel
                            </button>
                            <button
                              className="btn btn-sm danger"
                              onClick={() => {
                                actions.unloadModel(rt.name);
                                setConfirmUnload(null);
                              }}
                            >
                              Unload
                            </button>
                          </span>
                        ) : (
                          <button
                            className="btn btn-sm"
                            onClick={() => setConfirmUnload(rt.name)}
                          >
                            Unload
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Category>

              <Category title="Installed Local Models" iconNode={<CpuIcon />}>
                <div className="sensed-runtimes-head">
                  <span className="settings-hint">
                    Models sensed on your machine ({state.models.filter((m) => isLocalModel(m)).length} found)
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      actions.detectProviders();
                      actions.refreshModels();
                      actions.requestRecommendations(state.recommendations?.goal);
                    }}
                  >
                    <RefreshIcon />
                    <span>Scan Models</span>
                  </button>
                </div>

                {(() => {
                  const localInstalled = state.models.filter((m) => isLocalModel(m));
                  const evalMap = new Map(
                    (state.recommendations?.evaluatedInstalled ?? []).map((e) => [e.name, e])
                  );
                  if (localInstalled.length === 0) {
                    return (
                      <div className="settings-hint" style={{ padding: "6px 0" }}>
                        No local models sensed yet. Click <strong>Scan Models</strong> or pull a recommended model below.
                      </div>
                    );
                  }
                  const sorted = [...localInstalled].sort((a, b) => {
                    const ea = evalMap.get(a.name);
                    const eb = evalMap.get(b.name);
                    return Number(Boolean(eb?.recommended)) - Number(Boolean(ea?.recommended));
                  });
                  return (
                    <div className="rec-model-list">
                      {sorted.map((m) => {
                        const ev = evalMap.get(m.name);
                        const isSelected = state.selectedModel === m.name;
                        const sizeGb =
                          ev?.sizeGb ??
                          (m.sizeBytes ? Math.round((m.sizeBytes / 1024 ** 3) * 10) / 10 : undefined);
                        return (
                          <div
                            key={m.name}
                            className={`rec-model-card ${ev?.recommended ? "rec-highlight" : ""}`}
                          >
                            <div className="rec-model-head">
                              <span className="rec-model-title">{ev?.label || m.name}</span>
                              {ev?.recommended && (
                                <span className="rec-star-badge" title={ev.reason}>
                                  <StarIcon size={10} />
                                  <span>Recommended for Hardware</span>
                                </span>
                              )}
                              {ev?.fit && (
                                <span className={`rec-fit-badge ${ev.fit.badge}`}>
                                  {ev.fit.label}
                                </span>
                              )}
                              {sizeGb !== undefined && (
                                <span className="rec-model-size">{sizeGb.toFixed(1)} GB</span>
                              )}
                            </div>
                            <div className="rec-model-foot">
                              <code className="rec-model-code">{m.name}</code>
                              {isSelected ? (
                                <span className="model-added-tag">
                                  <CheckIcon size={11} />
                                  <span>Active</span>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-sm primary"
                                  onClick={() => {
                                    if (state.config.interfaceMode !== "local") {
                                      actions.setInterfaceMode("local");
                                    }
                                    actions.setModel(m.name);
                                  }}
                                >
                                  Use Model
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </Category>

              <Category title="Recommended Local Models Catalog" iconNode={<SparkleIcon />}>
                <div className="sensed-runtimes-head">
                  <span className="settings-hint">
                    {state.machine?.gpu
                      ? `${state.machine.gpu.name}${
                          state.machine.gpu.vramBytes
                            ? ` · ${(state.machine.gpu.vramBytes / 1024 ** 3).toFixed(1)} GB VRAM`
                            : ""
                        } · ${(state.machine.totalRamBytes / 1024 ** 3).toFixed(0)} GB RAM`
                      : "Matched to your hardware"}
                  </span>
                  <div className="advisor-goal-chips">
                    {(
                      ["coding", "reasoning", "multimodal", "autocomplete"] as ModelCapability[]
                    ).map((goal) => {
                      const active = (state.recommendations?.goal ?? "coding") === goal;
                      return (
                        <button
                          key={goal}
                          type="button"
                          className={`advisor-goal-chip ${active ? "active" : ""}`}
                          onClick={() => actions.requestRecommendations(goal)}
                        >
                          {goal === "coding" && <CodeIcon size={11} />}
                          {goal === "reasoning" && <BrainIcon />}
                          {goal === "multimodal" && <EyeIcon size={11} />}
                          {goal === "autocomplete" && <BoltIcon />}
                          <span>
                            {goal === "coding" && "Code"}
                            {goal === "reasoning" && "Reason"}
                            {goal === "multimodal" && "Vision"}
                            {goal === "autocomplete" && "Fast"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {state.recommendations && state.recommendations.models.length > 0 ? (
                  <div className="rec-model-list">
                    {state.recommendations.models.map((rec) => {
                      const matchedName =
                        rec.installedName ??
                        matchInstalledModelName(
                          rec.name,
                          state.models.map((m) => m.name)
                        );
                      const installed = rec.installed || Boolean(matchedName);
                      const targetModelName = matchedName ?? rec.name;
                      const isSelected = installed && state.selectedModel === targetModelName;
                      const pullingThis =
                        isPulling &&
                        state.pullProgress?.model.toLowerCase() === rec.name.toLowerCase();

                      return (
                        <div
                          key={rec.name}
                          className={`rec-model-card ${rec.recommended ? "rec-highlight" : ""}`}
                        >
                          <div className="rec-model-head">
                            <span className="rec-model-title">{rec.label || rec.name}</span>
                            {rec.recommended && (
                              <span className="rec-star-badge">
                                <StarIcon size={10} />
                                <span>Best Fit</span>
                              </span>
                            )}
                            <span className={`rec-fit-badge ${rec.fit.badge}`}>
                              {rec.fit.label}
                            </span>
                            {rec.fit.tokPerSec && (
                              <span
                                className={`rec-speed-badge ${rec.fit.isEstimate ? "estimated" : "measured"}`}
                                title={rec.fit.isEstimate ? "Estimated bandwidth throughput" : "Measured via benchmark on this machine"}
                              >
                                {rec.fit.isEstimate ? `~${rec.fit.tokPerSec} tok/s (est.)` : `⚡ ${rec.fit.tokPerSec} tok/s (measured)`}
                              </span>
                            )}
                            <span className="rec-model-size">{rec.sizeGb.toFixed(1)} GB</span>
                          </div>
                          <div className="rec-model-foot">
                            <code className="rec-model-code">
                              {installed && matchedName && matchedName !== rec.name
                                ? `${rec.name} (${matchedName})`
                                : rec.name}
                            </code>
                            {installed ? (
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span className="model-added-tag">
                                  <CheckIcon size={11} />
                                  <span>Installed</span>
                                </span>
                                {!isSelected && (
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    onClick={() => {
                                      if (state.config.interfaceMode !== "local") {
                                        actions.setInterfaceMode("local");
                                      }
                                      actions.setModel(targetModelName);
                                    }}
                                  >
                                    Select
                                  </button>
                                )}
                              </div>
                            ) : pullingThis ? (
                              <span className="btn btn-sm" style={{ opacity: 0.6 }}>
                                Pulling…
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-sm primary"
                                disabled={isPulling}
                                onClick={() => actions.pullModel(rec.name)}
                              >
                                Pull
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="settings-row">
                    <span className="settings-hint">Scanning hardware…</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => actions.requestRecommendations()}
                    >
                      <RefreshIcon />
                      <span>Refresh</span>
                    </button>
                  </div>
                )}

                <PullProgressBar state={state} actions={actions} />

                <div className="pull-custom-row">
                  <input
                    className="manual-add-input"
                    type="text"
                    placeholder="Pull custom model (e.g. qwen2.5-coder:3b)"
                    value={customPullName}
                    onChange={(e) => setCustomPullName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && customPullName.trim() && !isPulling) {
                        actions.pullModel(customPullName.trim());
                        setCustomPullName("");
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm primary"
                    disabled={!customPullName.trim() || isPulling}
                    onClick={() => {
                      actions.pullModel(customPullName.trim());
                      setCustomPullName("");
                    }}
                  >
                    Pull
                  </button>
                </div>
              </Category>

              <Category title="Model Parameters" iconNode={<WrenchIcon />} defaultOpen={false}>
                <ModelConfigs state={state} actions={actions} />
              </Category>

              <Category title="Benchmarks" iconNode={<ChartIcon />} defaultOpen={false}>
                <Row label="Measure local tok/s & tool reliability">
                  <button className="btn btn-sm" onClick={() => actions.runBench()}>
                    Run Bench
                  </button>
                </Row>
                {state.benchResults.length > 0 && (
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
                        <span className="bench-model" title={b.model}>
                          {b.model}
                        </span>
                        <span>{Math.round(b.tokensPerSec)}</span>
                        <span>{Math.round(b.toolCallReliability * 100)}%</span>
                        <span>
                          {b.reasoningPass ? (
                            <span className="hw-tag-ok">
                              <CheckIcon size={12} />
                            </span>
                          ) : (
                            <span className="text-dim">
                              <CloseIcon />
                            </span>
                          )}
                        </span>
                        <span>
                          {state.benchRunning.includes(b.model) ? (
                            <span className="bench-running">…</span>
                          ) : (
                            <button
                              className="icon-btn"
                              onClick={() => actions.runBench(b.model)}
                              title="Re-run benchmark"
                            >
                              <RefreshIcon />
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Category>
            </>
          )}

          {/* ───── Providers ───── */}
          {tab === "providers" && (
            <>
              <Category title="Local Engine" iconNode={<CpuIcon />}>
                <LocalProviderHub state={state} actions={actions} />
              </Category>

              <Category title="Detected Local Runtimes" iconNode={<PlugIcon />}>
                <div className="sensed-runtimes-head">
                  <span className="settings-hint">Ollama, llama.cpp, LM Studio &amp; vLLM</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      actions.detectProviders();
                      actions.refreshModels();
                    }}
                  >
                    <RefreshIcon />
                    <span>Rescan</span>
                  </button>
                </div>

                <div className="sensed-runtimes-list">
                  {state.localRuntimes.map((r) => {
                    const isRunning = r.state === "running";
                    const isStopped = r.state === "installed_stopped";
                    const isConflict = r.state === "port_conflict";
                    const isNotInstalled = r.state === "not_installed";

                    return (
                      <div key={r.id} className={`sensed-runtime-card ${r.state}`}>
                        <div className="sensed-runtime-head">
                          <span className="sensed-runtime-name">{r.label}</span>
                          <span className={`sensed-runtime-badge ${r.state}`}>
                            {isRunning ? (
                              <>
                                <span className="dot-pulse green" />
                                <span>
                                  Port {r.port}
                                  {r.version ? ` · v${r.version}` : ""}
                                </span>
                              </>
                            ) : isStopped ? (
                              <>
                                <span className="dot-pulse amber" />
                                <span>Stopped</span>
                              </>
                            ) : isConflict ? (
                              <>
                                <AlertTriangleIcon />
                                <span>Port {r.port} busy</span>
                              </>
                            ) : (
                              <span>Not installed</span>
                            )}
                          </span>
                        </div>

                        {(isStopped || isConflict || (isNotInstalled && r.installOptions?.length)) ? (
                          <div className="sensed-runtime-actions">
                            {r.id === "ollama" && isStopped && (
                              <button
                                type="button"
                                className="btn btn-sm primary"
                                onClick={() => actions.startProvider("ollama")}
                              >
                                <BoltIcon />
                                <span>Start</span>
                              </button>
                            )}
                            {isConflict && (r.id === "ollama" || r.id === "llamacpp") && (
                              <button
                                type="button"
                                className="btn btn-sm danger"
                                onClick={() =>
                                  actions.restartProvider(r.id as "ollama" | "llamacpp")
                                }
                              >
                                <RefreshIcon />
                                <span>Free Port</span>
                              </button>
                            )}
                            {isNotInstalled &&
                              r.installOptions &&
                              r.installOptions.length > 0 && (
                                <div className="sensed-install-opts">
                                  {r.installOptions.slice(0, 2).map((opt, i) => (
                                    <button
                                      key={opt.label}
                                      type="button"
                                      className={`btn btn-sm ${i === 0 ? "primary" : ""}`}
                                      onClick={() => actions.installProvider(r.id, i)}
                                      title={opt.value}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </Category>

              <Category title="Cloud Providers" iconNode={<LinkIcon />}>
                <div className="provider-list">
                  {state.config.providers
                    .filter((p) => p.id !== "ollama")
                    .map((p) => (
                      <CloudProviderCard
                        key={p.id}
                        provider={p}
                        actions={actions}
                        state={state}
                      />
                    ))}
                </div>
                <AddCustomEndpoint actions={actions} />
              </Category>
            </>
          )}

          {/* ───── Tools ───── */}
          {tab === "tools" && (
            <>
              <Category title="Execution Safety" iconNode={<ShieldIcon />}>
                <Row label="Auto-approve file edits & terminal commands">
                  <Toggle checked={state.config.autoApprove} onChange={actions.setAutoApprove} />
                </Row>
              </Category>

              <Category title="Web Search" iconNode={<SearchIcon />}>
                <Row label="Search engine">
                  <select
                    className="settings-select"
                    value={state.config.webSearchProvider}
                    onChange={(e) =>
                      actions.setWebSearchProvider(
                        e.target.value as "google" | "duckduckgo" | "none"
                      )
                    }
                  >
                    <option value="google">Google</option>
                    <option value="duckduckgo">DuckDuckGo</option>
                    <option value="none">Disabled</option>
                  </select>
                </Row>
              </Category>

              {state.tools.length > 0 && (
                <Category
                  title={`Registered Tools (${state.tools.length})`}
                  iconNode={<ToolboxIcon />}
                  defaultOpen={false}
                >
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

          {/* ───── Advanced ───── */}
          {tab === "advanced" && (
            <>
              <Category title="Workspace Index" iconNode={<FolderIcon />}>
                <Row label="Local code & symbol indexing">
                  <Toggle
                    checked={state.config.indexingEnabled}
                    onChange={actions.setIndexingEnabled}
                  />
                </Row>
                <div className="settings-row">
                  <span className="settings-hint">{indexSummary(state.indexStatus)}</span>
                  {state.config.indexingEnabled && state.indexStatus.phase !== "unavailable" && (
                    <button className="btn btn-sm" onClick={actions.reindex}>
                      Re-index
                    </button>
                  )}
                </div>
              </Category>

              <Category title="MCP Servers" iconNode={<LinkIcon />}>
                {state.mcpServers.length === 0 ? (
                  <div className="settings-hint">
                    Configure MCP servers in <code>.vscode/mcp.json</code>.
                  </div>
                ) : (
                  <div className="mcp-list">
                    {state.mcpServers.map((s) => (
                      <div key={s.id} className="mcp-row">
                        <div className="mcp-info">
                          <span className="mcp-name">{s.id}</span>
                          <span className={`mcp-status mcp-${s.status}`}>{s.status}</span>
                          {s.toolCount > 0 && (
                            <span className="mcp-tools">{s.toolCount} tools</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Category>

              <Category title="Diagnostics" iconNode={<HeartPulseIcon />} defaultOpen={false}>
                <button className="btn btn-sm" onClick={actions.diagnostics}>
                  Open Output Diagnostics
                </button>
              </Category>
            </>
          )}
        </div>
      </div>

      {ctxWarn && (
        <ContextWarningModal
          title={ctxWarn.title}
          explanation={ctxWarn.explanation}
          recommendedTokens={ctxWarn.recommendedTokens}
          onUseRecommended={() => {
            selectCtxPreset(ctxWarn.recommendedTokens);
            setCtxWarn(null);
          }}
          onKeepSelected={() => setCtxWarn(null)}
        />
      )}
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
  iconNode,
  children,
  defaultOpen = true,
}: {
  title: string;
  iconNode: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`category${open ? " open" : ""}`}>
      <button className="category-header" onClick={() => setOpen((o) => !o)}>
        <span className="category-label">
          <span className="category-icon">{iconNode}</span>
          <span>{title}</span>
        </span>
        <span className="category-chevron">
          <ChevronRightIcon />
        </span>
      </button>
      {open && <div className="category-body">{children}</div>}
    </div>
  );
}
