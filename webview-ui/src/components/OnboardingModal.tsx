import { useState, useEffect, useRef, useMemo } from "react";
import {
  isLocalModel,
  matchInstalledModelName,
  type ModelCapability,
  type ModelInfo,
} from "../../../src/shared/types";
import type { AppState, Actions } from "../state/store";
import { ProviderLogo } from "./ProviderLogos";
import { PullProgressBar } from "./PullProgressBar";
import {
  PhotonLogoIcon,
  CpuIcon,
  CloudIcon,
  RefreshIcon,
  SparkleIcon,
  StarIcon,
  CheckIcon,
  CloseIcon,
  BoltIcon,
  CodeIcon,
  BrainIcon,
  EyeIcon,
  ShieldIcon,
  SearchIcon,
  AlertTriangleIcon,
  ChevronRightIcon,
  BackIcon,
} from "./Icons";

type OnboardingStep = "choose" | "local" | "cloud";

const AUTO_PING_BATCH_SIZE = 5;
const AUTO_PING_MAX_MODELS = 15;

export function OnboardingModal({
  state,
  actions,
}: {
  state: AppState;
  actions: Actions;
}) {
  const [step, setStep] = useState<OnboardingStep>("choose");
  const [isScanning, setIsScanning] = useState(false);
  const [showCatalogWhenInstalled, setShowCatalogWhenInstalled] = useState(false);

  // Cloud setup state
  const providers = state.config.providers ?? [];
  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    () => providers.find((p) => p.configured)?.id ?? providers[0]?.id ?? "gemini"
  );
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [cloudSearch, setCloudSearch] = useState("");
  const [autoPinging, setAutoPinging] = useState(false);
  const autoPingCancelRef = useRef(false);

  // Trigger an initial scan when modal mounts
  useEffect(() => {
    actions.detectProviders();
    actions.requestRecommendations();
  }, [actions]);

  useEffect(() => {
    return () => {
      autoPingCancelRef.current = true;
    };
  }, []);

  const triggerLocalScan = () => {
    setIsScanning(true);
    actions.detectProviders();
    actions.refreshModels();
    actions.requestRecommendations(state.recommendations?.goal ?? "coding");
    setTimeout(() => setIsScanning(false), 900);
  };

  const localInstalled = useMemo(
    () => state.models.filter((m) => isLocalModel(m)),
    [state.models]
  );

  const evalMap = useMemo(
    () => new Map((state.recommendations?.evaluatedInstalled ?? []).map((e) => [e.name, e])),
    [state.recommendations]
  );

  const sortedLocalInstalled = useMemo(() => {
    return [...localInstalled].sort((a, b) => {
      const ea = evalMap.get(a.name);
      const eb = evalMap.get(b.name);
      return Number(Boolean(eb?.recommended)) - Number(Boolean(ea?.recommended));
    });
  }, [localInstalled, evalMap]);

  const bestInstalledEval = useMemo(
    () => (state.recommendations?.evaluatedInstalled ?? []).find((e) => e.recommended),
    [state.recommendations]
  );

  const anyLocalRuntimePresent = useMemo(
    () =>
      state.ollamaReachable ||
      state.localRuntimes.some((r) => r.state === "running" || r.state === "installed_stopped"),
    [state.ollamaReachable, state.localRuntimes]
  );

  const ollamaRuntime = useMemo(
    () => state.localRuntimes.find((r) => r.id === "ollama"),
    [state.localRuntimes]
  );

  const isPulling = Boolean(
    state.pullProgress && state.pullProgress.phase === "pulling" && !state.pullProgress.error
  );

  // Cloud helpers
  const activeProvider = providers.find((p) => p.id === selectedProviderId);
  const liveCloudModels = state.providerModels[selectedProviderId] ?? [];
  const isFetchingCloud = state.providerModelsFetching.includes(selectedProviderId);
  const cloudFetchError = state.providerModelsError[selectedProviderId];

  const addedForSelectedProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of state.models) {
      if (m.provider === selectedProviderId || m.name.startsWith(`${selectedProviderId}:`)) {
        const bare = m.name.startsWith(`${selectedProviderId}:`)
          ? m.name.slice(selectedProviderId.length + 1)
          : m.name;
        map.set(bare, m.name);
      }
    }
    return map;
  }, [state.models, selectedProviderId]);

  const testForCloudModel = (m: ModelInfo) => {
    const key = m.name.startsWith(`${selectedProviderId}:`)
      ? m.name
      : `${selectedProviderId}:${m.name}`;
    return state.modelTestResults[key];
  };

  const isTestingCloudModel = (m: ModelInfo) => {
    const key = m.name.startsWith(`${selectedProviderId}:`)
      ? m.name
      : `${selectedProviderId}:${m.name}`;
    return state.modelTestRunning.includes(key);
  };

  const filteredCloudModels = useMemo(() => {
    const q = cloudSearch.trim().toLowerCase();
    const list = q
      ? liveCloudModels.filter((m) => m.name.toLowerCase().includes(q))
      : liveCloudModels;
    return [...list].sort((a, b) => {
      const aAdded = addedForSelectedProvider.has(a.name) ? 1 : 0;
      const bAdded = addedForSelectedProvider.has(b.name) ? 1 : 0;
      if (aAdded !== bAdded) return bAdded - aAdded;
      const aOk = testForCloudModel(a)?.ok ? 1 : 0;
      const bOk = testForCloudModel(b)?.ok ? 1 : 0;
      if (aOk !== bOk) return bOk - aOk;
      return (testForCloudModel(a)?.latencyMs ?? 99999) - (testForCloudModel(b)?.latencyMs ?? 99999);
    });
  }, [liveCloudModels, cloudSearch, addedForSelectedProvider, state.modelTestResults, selectedProviderId]);

  const runCloudAutoPing = async () => {
    if (autoPinging) {
      autoPingCancelRef.current = true;
      setAutoPinging(false);
      return;
    }
    const candidates = filteredCloudModels.slice(0, AUTO_PING_MAX_MODELS);
    if (candidates.length === 0) return;

    autoPingCancelRef.current = false;
    setAutoPinging(true);
    for (let i = 0; i < candidates.length; i += AUTO_PING_BATCH_SIZE) {
      if (autoPingCancelRef.current) break;
      const batch = candidates.slice(i, i + AUTO_PING_BATCH_SIZE);
      for (const m of batch) {
        if (!isTestingCloudModel(m)) {
          actions.testModel(selectedProviderId, m);
        }
      }
      if (i + AUTO_PING_BATCH_SIZE < candidates.length) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    setAutoPinging(false);
  };

  const handleSaveCloudKey = () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    actions.setProviderApiKey(selectedProviderId, trimmed);
    setApiKeyInput("");
  };

  const handleAddCustomProvider = () => {
    if (!customLabel.trim() || !customUrl.trim()) return;
    actions.addCustomProvider(
      customLabel.trim(),
      customUrl.trim(),
      customKey.trim() || undefined
    );
    setCustomLabel("");
    setCustomUrl("");
    setCustomKey("");
    setIsCustomMode(false);
  };

  const handleSelectCloudModel = (m: ModelInfo) => {
    const bare = m.name.startsWith(`${selectedProviderId}:`)
      ? m.name.slice(selectedProviderId.length + 1)
      : m.name;
    const fullName = `${selectedProviderId}:${bare}`;
    if (!addedForSelectedProvider.has(bare)) {
      actions.addAvailableModel(selectedProviderId, m);
    }
    if (state.config.interfaceMode !== "cloud") {
      actions.setInterfaceMode("cloud");
    }
    actions.setModel(fullName);
  };

  const handleSelectLocalModel = (modelName: string) => {
    if (state.config.interfaceMode !== "local") {
      actions.setInterfaceMode("local");
    }
    actions.setModel(modelName);
  };

  const hwLabel = state.machine
    ? `${
        state.machine.gpu
          ? `${state.machine.gpu.name}${
              state.machine.gpu.vramBytes
                ? ` (${(state.machine.gpu.vramBytes / 1024 ** 3).toFixed(1)} GB VRAM)`
                : ""
            }`
          : "CPU Mode"
      } · ${(state.machine.totalRamBytes / 1024 ** 3).toFixed(0)} GB RAM · ${state.machine.cpuCores} Cores`
    : "Detecting hardware profile…";

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label="Photon First-Time Setup">
      <div className="onboarding-modal">
        {/* ───── Header ───── */}
        <div className="onboarding-header">
          <div className="onboarding-header-top">
            <div className="onboarding-brand">
              <PhotonLogoIcon size={24} />
              <div className="onboarding-brand-text">
                <div className="onboarding-title">Welcome to Photon</div>
                <div className="onboarding-subtitle">
                  Streamlined Local &amp; Cloud AI Coding Setup
                </div>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-sm ghost onboarding-skip-top"
              onClick={() => actions.completeOnboarding()}
              title="Skip setup and go straight to the workspace"
            >
              <span>Skip</span>
              <CloseIcon />
            </button>
          </div>

          <div className="onboarding-steps-pill">
            <span className={`onboarding-step-dot ${step === "choose" ? "active" : "done"}`}>
              1. Choose Mode
            </span>
            <ChevronRightIcon />
            <span className={`onboarding-step-dot ${step !== "choose" ? "active" : ""}`}>
              2. {step === "cloud" ? "Cloud Setup" : step === "local" ? "Local Setup" : "Configure"}
            </span>
          </div>
        </div>

        {/* ───── Hardware Bar ───── */}
        <div className="onboarding-hw-bar" title={hwLabel}>
          <div className="onboarding-hw-left">
            <CpuIcon />
            <span className="onboarding-hw-label">Hardware:</span>
            <span className="onboarding-hw-value">{hwLabel}</span>
          </div>
          {state.selectedModel && (
            <span className="onboarding-active-pill" title={`Active: ${state.selectedModel}`}>
              <CheckIcon size={11} />
              <span>Active: {state.selectedModel}</span>
            </span>
          )}
        </div>

        {/* ───── Body ───── */}
        <div className="onboarding-body">
          {step === "choose" && (
            <div className="onboarding-choose-view">
              <p className="onboarding-lead">
                How would you like to power Photon? You can switch between Local and Cloud engines anytime from the header.
              </p>

              <div className="onboarding-mode-cards">
                {/* Local Card */}
                <button
                  type="button"
                  className="onboarding-mode-card"
                  onClick={() => {
                    actions.setInterfaceMode("local");
                    setStep("local");
                    triggerLocalScan();
                  }}
                >
                  <div className="onboarding-mode-card-top">
                    <span className="onboarding-mode-icon local">
                      <CpuIcon />
                    </span>
                    <span className="onboarding-mode-status">
                      {anyLocalRuntimePresent ? (
                        <span className="onboarding-tag ok">
                          {localInstalled.length > 0
                            ? `${localInstalled.length} local model${localInstalled.length === 1 ? "" : "s"} sensed`
                            : "Provider detected"}
                        </span>
                      ) : (
                        <span className="onboarding-tag faint">Scan available</span>
                      )}
                    </span>
                  </div>
                  <div className="onboarding-mode-title">Local Model Provider</div>
                  <div className="onboarding-mode-desc">
                    100% private, offline execution on your own GPU/CPU. Scan for Ollama, llama.cpp, LM Studio, or vLLM, sense installed models, and get hardware-tailored recommendations.
                  </div>
                  <div className="onboarding-mode-cta">
                    <span>Set Up Local Models</span>
                    <ChevronRightIcon />
                  </div>
                </button>

                {/* Cloud Card */}
                <button
                  type="button"
                  className="onboarding-mode-card"
                  onClick={() => {
                    actions.setInterfaceMode("cloud");
                    setStep("cloud");
                  }}
                >
                  <div className="onboarding-mode-card-top">
                    <span className="onboarding-mode-icon cloud">
                      <CloudIcon />
                    </span>
                    <span className="onboarding-mode-status">
                      {providers.some((p) => p.configured) ? (
                        <span className="onboarding-tag ok">
                          {providers.filter((p) => p.configured).length} provider(s) connected
                        </span>
                      ) : (
                        <span className="onboarding-tag faint">API Key Setup</span>
                      )}
                    </span>
                  </div>
                  <div className="onboarding-mode-title">Cloud Model Providers</div>
                  <div className="onboarding-mode-desc">
                    Connect Gemini, Claude, OpenAI, NVIDIA NIM, OpenRouter, OpenCode Zen, Blackbox, or any custom endpoint. Fetch live models, auto-ping latency, and select your model.
                  </div>
                  <div className="onboarding-mode-cta">
                    <span>Set Up Cloud Providers</span>
                    <ChevronRightIcon />
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* ───── STEP 2A: LOCAL SETUP ───── */}
          {step === "local" && (
            <div className="onboarding-step-content">
              {/* 1. Scan Local Providers */}
              <div className="onboarding-section">
                <div className="onboarding-section-head">
                  <div className="onboarding-head-titles">
                    <div className="onboarding-section-title">
                      1. Local Runtime Providers
                    </div>
                    <div className="onboarding-section-hint">
                      Scan your system for installed local LLM servers (Ollama, llama.cpp, LM Studio, vLLM).
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm primary onboarding-scan-btn"
                    onClick={triggerLocalScan}
                    disabled={isScanning}
                  >
                    <RefreshIcon />
                    <span>{isScanning ? "Scanning…" : "Scan Providers"}</span>
                  </button>
                </div>

                {/* Runtime Grid */}
                <div className="onboarding-runtime-grid">
                  {state.localRuntimes.map((r) => {
                    const isRunning = r.state === "running" || (r.id === "ollama" && state.ollamaReachable);
                    const isStopped = !isRunning && r.state === "installed_stopped";
                    const isConflict = r.state === "port_conflict";
                    const lifecycle = state.providerLifecycle[r.id];
                    const isStarting = lifecycle?.phase === "starting";

                    return (
                      <div
                        key={r.id}
                        className={`onboarding-runtime-card ${
                          isRunning ? "running" : isStopped ? "stopped" : "missing"
                        }`}
                      >
                        <div className="onboarding-runtime-top">
                          <span className="onboarding-runtime-name">{r.label}</span>
                          <span
                            className={`hub-badge ${
                              isRunning ? "ok" : isStopped || isStarting ? "warn" : isConflict ? "error" : "faint"
                            }`}
                          >
                            {isRunning
                              ? `Running${r.version ? ` v${r.version}` : ""}`
                              : isStarting
                                ? "Starting…"
                                : isStopped
                                  ? "Stopped"
                                  : isConflict
                                    ? "Conflict"
                                    : "Missing"}
                          </span>
                        </div>
                        <div className="onboarding-runtime-actions">
                          <span className="onboarding-runtime-port">:{r.port}</span>
                          {isStopped && !isStarting && (r.id === "ollama" || r.id === "llamacpp") && (
                            <button
                              type="button"
                              className="btn btn-sm primary"
                              onClick={() => actions.startProvider(r.id as "ollama" | "llamacpp")}
                            >
                              <BoltIcon />
                              <span>Start</span>
                            </button>
                          )}
                          {!isRunning && !isStopped && r.installOptions && r.installOptions.length > 0 && (
                            <button
                              type="button"
                              className="btn btn-sm ghost onboarding-runtime-install-btn"
                              onClick={() => actions.installProvider(r.id, 0)}
                              title={r.installOptions[0].value}
                            >
                              <span>{r.installOptions[0].label}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* No provider installed callout */}
                {!anyLocalRuntimePresent && state.localRuntimes.length > 0 && (
                  <div className="onboarding-callout warn">
                    <AlertTriangleIcon />
                    <div className="onboarding-callout-body">
                      <strong>No active local provider detected on your machine.</strong>
                      <span>
                        We recommend installing <strong>Ollama</strong> for 1-click model downloads and automatic GPU management. Once installed, click <strong>Scan Local Providers</strong> above.
                      </span>
                      {ollamaRuntime?.installOptions && ollamaRuntime.installOptions.length > 0 && (
                        <div className="onboarding-install-row">
                          {ollamaRuntime.installOptions.map((opt, idx) => (
                            <button
                              key={opt.label}
                              type="button"
                              className={`btn btn-sm ${idx === 0 ? "primary" : ""}`}
                              onClick={() => actions.installProvider("ollama", idx)}
                            >
                              <span>{opt.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 2. Sense Present Models & Hardware Recommendation */}
              <div className="onboarding-section">
                <div className="onboarding-section-head">
                  <div className="onboarding-head-titles">
                    <div className="onboarding-section-title">
                      2. Sensed Models &amp; Hardware Recommendation
                    </div>
                    <div className="onboarding-section-hint">
                      Select a model below. Photon ranks models based on your GPU VRAM, system RAM, and target capability.
                    </div>
                  </div>

                  {/* Capability filter chips */}
                  <div className="advisor-goal-chips onboarding-goal-chips">
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
                            {goal === "coding" && "Coding"}
                            {goal === "reasoning" && "Reasoning"}
                            {goal === "multimodal" && "Vision"}
                            {goal === "autocomplete" && "Fast"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Present / Installed Local Models */}
                {sortedLocalInstalled.length > 0 ? (
                  <div className="onboarding-models-block">
                    {bestInstalledEval && (
                      <div className="onboarding-best-banner">
                        <div className="onboarding-best-banner-left">
                          <span className="rec-star-badge">
                            <StarIcon size={11} />
                            <span>Recommended for Your Hardware</span>
                          </span>
                          <span className="onboarding-best-name">{bestInstalledEval.name}</span>
                          <span className="onboarding-best-reason">{bestInstalledEval.reason}</span>
                        </div>
                        {state.selectedModel === bestInstalledEval.name ? (
                          <span className="model-added-tag">
                            <CheckIcon size={11} />
                            <span>Selected</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm primary"
                            onClick={() => handleSelectLocalModel(bestInstalledEval.name)}
                          >
                            Use Recommended
                          </button>
                        )}
                      </div>
                    )}

                    <div className="onboarding-sublabel">
                      Present Models on Your Machine ({sortedLocalInstalled.length})
                    </div>
                    <div className="rec-model-list">
                      {sortedLocalInstalled.map((m) => {
                        const ev = evalMap.get(m.name);
                        const isSelected =
                          state.config.interfaceMode === "local" && state.selectedModel === m.name;
                        const sizeGb =
                          ev?.sizeGb ??
                          (m.sizeBytes ? Math.round((m.sizeBytes / 1024 ** 3) * 10) / 10 : undefined);

                        return (
                          <div
                            key={m.name}
                            className={`rec-model-card ${
                              isSelected || ev?.recommended ? "rec-highlight" : ""
                            }`}
                          >
                            <div className="rec-model-head">
                              <span className="rec-model-title">{ev?.label || m.name}</span>
                              {ev?.recommended && (
                                <span className="rec-star-badge">
                                  <StarIcon size={10} />
                                  <span>Best Fit</span>
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
                                  <span>Selected</span>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-sm primary"
                                  onClick={() => handleSelectLocalModel(m.name)}
                                >
                                  Select Model
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="onboarding-catalog-toggle-row">
                      <button
                        type="button"
                        className="btn btn-sm ghost"
                        onClick={() => setShowCatalogWhenInstalled((v) => !v)}
                      >
                        <SparkleIcon />
                        <span>
                          {showCatalogWhenInstalled
                            ? "Hide Downloadable Catalog Models"
                            : "Browse More Hardware-Recommended Models to Download"}
                        </span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="onboarding-empty-models">
                    <span>
                      No local models sensed yet. Choose a hardware-recommended model below to download &amp; activate automatically, or click <strong>Scan Local Providers</strong> if you just installed one.
                    </span>
                  </div>
                )}

                {/* Downloadable Recommended Catalog (shown when 0 installed OR toggled open) */}
                {(sortedLocalInstalled.length === 0 || showCatalogWhenInstalled) &&
                  state.recommendations &&
                  state.recommendations.models.length > 0 && (
                    <div className="onboarding-models-block">
                      <div className="onboarding-sublabel">
                        Hardware-Matched Catalog Models
                      </div>
                      <div className="rec-model-list">
                        {state.recommendations.models.map((rec) => {
                          const matchedName =
                            rec.installedName ??
                            matchInstalledModelName(
                              rec.name,
                              state.models.map((m) => m.name)
                            );
                          const installed = rec.installed || Boolean(matchedName);
                          const targetName = matchedName ?? rec.name;
                          const isSelected = installed && state.selectedModel === targetName;
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
                                    <span>Recommended for Hardware</span>
                                  </span>
                                )}
                                <span className={`rec-fit-badge ${rec.fit.badge}`}>
                                  {rec.fit.label}
                                </span>
                                <span className="rec-model-size">{rec.sizeGb.toFixed(1)} GB</span>
                              </div>
                              <div className="rec-model-foot">
                                <span className="settings-hint">{rec.blurb}</span>
                                {installed ? (
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <span className="model-added-tag">
                                      <CheckIcon size={11} />
                                      <span>Installed</span>
                                    </span>
                                    {!isSelected && (
                                      <button
                                        type="button"
                                        className="btn btn-sm primary"
                                        onClick={() => handleSelectLocalModel(targetName)}
                                      >
                                        Select
                                      </button>
                                    )}
                                  </div>
                                ) : pullingThis ? (
                                  <span className="btn btn-sm" style={{ opacity: 0.7 }}>
                                    Downloading…
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className="btn btn-sm primary"
                                    disabled={isPulling}
                                    onClick={() => actions.pullModel(rec.name)}
                                  >
                                    Download &amp; Use
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                <PullProgressBar state={state} actions={actions} />
              </div>
            </div>
          )}

          {/* ───── STEP 2B: CLOUD SETUP ───── */}
          {step === "cloud" && (
            <div className="onboarding-step-content">
              {/* 1. Choose Cloud Provider */}
              <div className="onboarding-section">
                <div className="onboarding-section-head">
                  <div>
                    <div className="onboarding-section-title">1. Choose Cloud Provider</div>
                    <div className="onboarding-section-hint">
                      Select a provider to configure its API key, fetch live models, and test latency.
                    </div>
                  </div>
                </div>

                <div className="onboarding-provider-grid">
                  {providers.map((p) => {
                    const active = !isCustomMode && selectedProviderId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`onboarding-provider-chip ${active ? "active" : ""}`}
                        onClick={() => {
                          setIsCustomMode(false);
                          setSelectedProviderId(p.id);
                          setCloudSearch("");
                          if (p.configured && !state.providerModels[p.id]?.length) {
                            actions.fetchProviderModels(p.id);
                          }
                        }}
                      >
                        <ProviderLogo providerId={p.id} label={p.label} size={18} />
                        <span className="onboarding-provider-chip-name">{p.label}</span>
                        {p.configured && <span className="onboarding-provider-dot" title="API Key Configured" />}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={`onboarding-provider-chip ${isCustomMode ? "active" : ""}`}
                    onClick={() => setIsCustomMode(true)}
                  >
                    <ProviderLogo providerId="custom" label="Custom" size={18} />
                    <span className="onboarding-provider-chip-name">+ Custom Endpoint</span>
                  </button>
                </div>
              </div>

              {/* 2. API Key & Fetch Models */}
              {isCustomMode ? (
                <div className="onboarding-section">
                  <div className="onboarding-section-title">
                    2. Connect Custom OpenAI-Compatible Endpoint
                  </div>
                  <div className="onboarding-custom-form">
                    <input
                      className="settings-input"
                      type="text"
                      placeholder="Provider Name (e.g. Together, Groq, vLLM)"
                      value={customLabel}
                      onChange={(e) => setCustomLabel(e.target.value)}
                    />
                    <input
                      className="settings-input"
                      type="text"
                      placeholder="Base URL (e.g. https://api.groq.com/openai/v1)"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                    />
                    <input
                      className="settings-input"
                      type="password"
                      placeholder="API Key (optional for local servers)"
                      value={customKey}
                      onChange={(e) => setCustomKey(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-sm primary"
                      disabled={!customLabel.trim() || !customUrl.trim()}
                      onClick={handleAddCustomProvider}
                    >
                      Connect &amp; Fetch Models
                    </button>
                  </div>
                </div>
              ) : (
                activeProvider && (
                  <>
                    <div className="onboarding-section">
                      <div className="onboarding-section-head">
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <ProviderLogo
                            providerId={activeProvider.id}
                            label={activeProvider.label}
                            size={20}
                          />
                          <div>
                            <div className="onboarding-section-title">
                              2. {activeProvider.label} API Key
                            </div>
                            <div className="onboarding-section-hint">
                              {activeProvider.configured
                                ? "API key is saved in VS Code SecretStorage. Enter a new key to replace it or fetch models below."
                                : "Stored encrypted in VS Code SecretStorage."}
                            </div>
                          </div>
                        </div>

                        {activeProvider.configured && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={isFetchingCloud}
                            onClick={() => actions.fetchProviderModels(activeProvider.id)}
                          >
                            <RefreshIcon />
                            <span>{isFetchingCloud ? "Fetching…" : "Fetch Models"}</span>
                          </button>
                        )}
                      </div>

                      <div className="onboarding-key-row">
                        <div className="key-input-wrap" style={{ flex: 1 }}>
                          <span style={{ paddingLeft: 8, display: "inline-flex", color: "var(--text-faint)" }}>
                            <ShieldIcon />
                          </span>
                          <input
                            className="key-input"
                            type="password"
                            placeholder={
                              activeProvider.configured
                                ? `Update ${activeProvider.label} API key…`
                                : `Enter ${activeProvider.label} API key…`
                            }
                            value={apiKeyInput}
                            onChange={(e) => setApiKeyInput(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleSaveCloudKey()}
                          />
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm primary"
                          disabled={!apiKeyInput.trim() || isFetchingCloud}
                          onClick={handleSaveCloudKey}
                        >
                          {activeProvider.configured ? "Update & Fetch" : "Save Key & Fetch Models"}
                        </button>
                      </div>

                      {cloudFetchError && (
                        <div className="provider-error-banner" style={{ marginTop: 8 }}>
                          <span>{cloudFetchError}</span>
                        </div>
                      )}
                    </div>

                    {/* 3. Auto/Manual Ping & Select Available Model */}
                    <div className="onboarding-section">
                      <div className="onboarding-section-head">
                        <div>
                          <div className="onboarding-section-title">
                            3. Ping &amp; Select Available Model
                          </div>
                          <div className="onboarding-section-hint">
                            Auto-ping or manually ping models to verify access &amp; latency, then click <strong>Select &amp; Use</strong>.
                          </div>
                        </div>

                        {liveCloudModels.length > 0 && (
                          <button
                            type="button"
                            className={`btn btn-sm ${autoPinging ? "danger" : "primary"}`}
                            onClick={() => void runCloudAutoPing()}
                          >
                            <BoltIcon />
                            <span>
                              {autoPinging ? "Stop Auto-Ping" : "Auto-Ping Models"}
                            </span>
                          </button>
                        )}
                      </div>

                      {isFetchingCloud && liveCloudModels.length === 0 ? (
                        <div className="onboarding-empty-models">
                          Fetching available models from {activeProvider.label}…
                        </div>
                      ) : liveCloudModels.length > 0 ? (
                        <>
                          <div className="provider-models-toolbar" style={{ marginBottom: 8 }}>
                            <div className="provider-search-box" style={{ flex: 1 }}>
                              <SearchIcon />
                              <input
                                type="text"
                                className="provider-search-input"
                                placeholder={`Filter ${liveCloudModels.length} ${activeProvider.label} models…`}
                                value={cloudSearch}
                                onChange={(e) => setCloudSearch(e.target.value)}
                              />
                            </div>
                          </div>

                          <div className="onboarding-cloud-model-list">
                            {filteredCloudModels.slice(0, 60).map((m) => {
                              const bare = m.name.startsWith(`${selectedProviderId}:`)
                                ? m.name.slice(selectedProviderId.length + 1)
                                : m.name;
                              const fullName = `${selectedProviderId}:${bare}`;
                              const isSelected =
                                state.config.interfaceMode === "cloud" &&
                                state.selectedModel === fullName;
                              const isAdded = addedForSelectedProvider.has(bare);
                              const test = testForCloudModel(m);
                              const testing = isTestingCloudModel(m);

                              return (
                                <div
                                  key={m.name}
                                  className={`provider-model-item ${
                                    isSelected ? "added" : ""
                                  }`}
                                >
                                  <div className="provider-model-info">
                                    <span className="provider-model-id" title={m.name}>
                                      {bare}
                                    </span>
                                    <div className="provider-model-badges">
                                      {m.toolTrained && (
                                        <span className="pm-badge">Tools</span>
                                      )}
                                      {m.vision && (
                                        <span className="pm-badge">Vision</span>
                                      )}
                                      {test?.ok && (
                                        <span className="pm-badge ping-ok">
                                          {test.latencyMs}ms
                                        </span>
                                      )}
                                      {test && !test.ok && (
                                        <span
                                          className="pm-badge ping-fail"
                                          title={test.error}
                                        >
                                          Offline
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  <div className="provider-model-actions">
                                    <button
                                      type="button"
                                      className="btn btn-sm ghost"
                                      disabled={testing}
                                      onClick={() =>
                                        actions.testModel(selectedProviderId, m)
                                      }
                                      title="Manual ping this model"
                                    >
                                      {testing ? "Pinging…" : "Ping"}
                                    </button>

                                    {isSelected ? (
                                      <span className="model-added-tag">
                                        <CheckIcon size={11} />
                                        <span>Selected</span>
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        className="btn btn-sm primary"
                                        onClick={() => handleSelectCloudModel(m)}
                                      >
                                        {isAdded ? "Use Model" : "Select & Use"}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="onboarding-empty-models">
                          {activeProvider.configured
                            ? "Click Fetch Models above to load models for this provider."
                            : `Enter your ${activeProvider.label} API key above to fetch and ping available models.`}
                        </div>
                      )}
                    </div>
                  </>
                )
              )}
            </div>
          )}
        </div>

        {/* ───── Footer ───── */}
        <div className="onboarding-footer">
          <div className="onboarding-footer-left">
            {step !== "choose" && (
              <button
                type="button"
                className="btn btn-sm ghost"
                onClick={() => setStep("choose")}
              >
                <BackIcon />
                <span>Back</span>
              </button>
            )}
          </div>

          <div className="onboarding-footer-right">
            <button
              type="button"
              className="btn btn-sm ghost"
              onClick={() => actions.completeOnboarding()}
            >
              Skip
            </button>
            <button
              type="button"
              className="btn btn-sm primary onboarding-finish-btn"
              onClick={() => actions.completeOnboarding()}
            >
              <CheckIcon size={12} />
              <span>{state.selectedModel ? "Start Coding" : "Finish Setup"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
