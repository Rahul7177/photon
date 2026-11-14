import { useState, useMemo } from "react";
import type { AppState, Actions } from "../state/store";
import type { ModelInfo } from "../../../src/shared/types";
import { Toggle } from "./Toggle";
import { CapabilityBadges } from "./CapabilityBadges";
import {
  CheckIcon,
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  ChevronRightIcon,
  RefreshIcon,
  BoltIcon,
} from "./Icons";
import { ProviderLogo } from "./ProviderLogos";

interface ProviderStatus {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  modelCount: number;
  isCustom?: boolean;
  isLocal?: boolean;
  baseUrl?: string;
  requireApiKey?: boolean;
  supportsLiveModels?: boolean;
}

interface ProviderMeta {
  id: string;
  docsUrl: string;
  hint: string;
  /** Whether the provider's API can list the models available to this account. */
  live: boolean;
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  gemini: {
    id: "gemini",
    docsUrl: "https://aistudio.google.com/app/apikey",
    hint: "Google Gemini via the Generative Language API. Connecting validates your key, auto-adds top models, and lists every model your account can use.",
    live: true,
  },
  claude: {
    id: "claude",
    docsUrl: "https://console.anthropic.com/settings/keys",
    hint: "Anthropic Claude via /v1/messages with automatic ephemeral prompt caching (up to 90% input token discount on multi-step tasks).",
    live: true,
  },
  openai: {
    id: "openai",
    docsUrl: "https://platform.openai.com/api-keys",
    hint: "OpenAI chat-completions API. Connecting validates your key and lists the models your organization can access.",
    live: true,
  },
  nvidia: {
    id: "nvidia",
    docsUrl: "https://build.nvidia.com",
    hint: "NVIDIA NIM — hosted Meta Llama, DeepSeek, Qwen, Nemotron and more via an OpenAI-compatible API.",
    live: true,
  },
  openrouter: {
    id: "openrouter",
    docsUrl: "https://openrouter.ai/keys",
    hint: "OpenRouter — one key, hundreds of models. Filter by category, ping latency, and add models in 1 click.",
    live: true,
  },
  opencode: {
    id: "opencode",
    docsUrl: "https://opencode.ai/auth",
    hint: "OpenCode Zen — curated, benchmarked coding models behind an OpenAI-compatible gateway.",
    live: true,
  },
  blackbox: {
    id: "blackbox",
    docsUrl: "https://www.blackbox.ai",
    hint: "Blackbox AI — OpenAI-compatible API. Add model IDs manually below.",
    live: false,
  },
  llamacpp: {
    id: "llamacpp",
    docsUrl: "https://github.com/ggerganov/llama.cpp",
    hint: "llama.cpp — local OpenAI-compatible server at photon.llamacpp.baseUrl/v1. Run with: llama-server -m model.gguf --port 8080. No API key needed.",
    live: true,
  },
};

export interface EndpointPreset {
  label: string;
  id: string;
  baseUrl: string;
  docsUrl: string;
  requireApiKey?: boolean;
  hint?: string;
}

export const CUSTOM_ENDPOINT_PRESETS: EndpointPreset[] = [
  { label: "Groq", id: "groq", baseUrl: "https://api.groq.com/openai/v1", docsUrl: "https://console.groq.com/keys" },
  { label: "DeepSeek", id: "deepseek", baseUrl: "https://api.deepseek.com/v1", docsUrl: "https://platform.deepseek.com/api_keys" },
  { label: "Mistral", id: "mistral", baseUrl: "https://api.mistral.ai/v1", docsUrl: "https://console.mistral.ai/api-keys" },
  { label: "Together AI", id: "together", baseUrl: "https://api.together.xyz/v1", docsUrl: "https://api.together.ai/settings/api-keys" },
  { label: "Fireworks AI", id: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", docsUrl: "https://fireworks.ai/account/api-keys" },
  { label: "xAI Grok", id: "xai", baseUrl: "https://api.x.ai/v1", docsUrl: "https://console.x.ai" },
  { label: "Cerebras", id: "cerebras", baseUrl: "https://api.cerebras.ai/v1", docsUrl: "https://cloud.cerebras.ai" },
  { label: "Perplexity", id: "perplexity", baseUrl: "https://api.perplexity.ai", docsUrl: "https://www.perplexity.ai/settings/api" },
  { label: "Moonshot / Kimi", id: "moonshot", baseUrl: "https://api.moonshot.ai/v1", docsUrl: "https://platform.moonshot.ai/console/api-keys" },
  { label: "SiliconFlow", id: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1", docsUrl: "https://cloud.siliconflow.cn/account/ak" },
  { label: "DeepInfra", id: "deepinfra", baseUrl: "https://api.deepinfra.com/v1/openai", docsUrl: "https://deepinfra.com/dash/api_keys" },
  { label: "SambaNova", id: "sambanova", baseUrl: "https://api.sambanova.ai/apis", docsUrl: "https://cloud.sambanova.ai/apis" },
  { label: "Hugging Face", id: "huggingface", baseUrl: "https://router.huggingface.co/v1", docsUrl: "https://huggingface.co/settings/tokens" },
  { label: "LM Studio (Local)", id: "lmstudio", baseUrl: "http://localhost:1234/v1", docsUrl: "https://lmstudio.ai", requireApiKey: false, hint: "Local LM Studio OpenAI server" },
  { label: "vLLM (Local)", id: "vllm", baseUrl: "http://localhost:8000/v1", docsUrl: "https://docs.vllm.ai", requireApiKey: false, hint: "Local vLLM OpenAI-compatible server" },
];

export function looksLikeLocalUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return (
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/.test(lower) ||
    /^https?:\/\/192\.168\./.test(lower) ||
    /^https?:\/\/10\./.test(lower)
  );
}

const RECOMMENDED_PATTERNS = [
  "gemini-2.5",
  "gemini-2.0-flash",
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-3-7-sonnet",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "gpt-5",
  "gpt-4.1",
  "gpt-4o",
  "o4-mini",
  "o3",
  "grok-4",
  "grok-3",
  "deepseek-r1",
  "deepseek-v3",
  "deepseek-chat",
  "deepseek-reasoner",
  "qwen3",
  "qwen2.5-coder",
  "llama-4",
  "llama-3.3-70b",
  "nemotron",
  "kimi",
  "blackboxai-pro",
];

function isRecommended(name: string): boolean {
  const n = name.toLowerCase();
  return RECOMMENDED_PATTERNS.some((p) => n.includes(p));
}

function hasReasoning(m: ModelInfo): boolean {
  const n = m.name.toLowerCase();
  return (
    m.thinking === true ||
    /r1|o1|o3|o4|gpt-5|claude-.*(4|3-7)|gemini-2\.5|reason|thinking|qwq|grok-3-mini|grok-4/.test(n)
  );
}

function hasVision(m: ModelInfo): boolean {
  const n = m.name.toLowerCase();
  return (
    m.vision === true ||
    /vision|\bvl\b|multimodal|gpt-4o|gpt-4\.1|gpt-5|claude-|gemini|pixtral|llama-4|grok-2-vision|grok-4/.test(n)
  );
}

function isFast(m: ModelInfo): boolean {
  const n = m.name.toLowerCase();
  return /flash|mini|nano|haiku|lite|8b|7b|small|instant|turbo|fast/.test(n);
}

function formatContext(ctx?: number): string | null {
  if (!ctx || ctx <= 0) return null;
  if (ctx >= 1_000_000) return `${Math.round(ctx / 1_000_000)}M ctx`;
  if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}k ctx`;
  return `${ctx} ctx`;
}

type FilterCategory = "all" | "recommended" | "picker" | "reasoning" | "vision" | "fast";

export function CloudProviderCard({
  provider,
  actions,
  state,
}: {
  provider: ProviderStatus;
  actions: Actions;
  state: AppState;
}) {
  const isCustom = provider.isCustom ?? !(provider.id in PROVIDER_META);
  const requiresKey = provider.requireApiKey !== false;
  const meta = PROVIDER_META[provider.id] ?? {
    id: provider.id,
    docsUrl: "",
    hint: provider.baseUrl
      ? `OpenAI-compatible endpoint (${provider.baseUrl})`
      : "Custom OpenAI-compatible endpoint.",
    live: provider.supportsLiveModels ?? true,
  };

  const [expanded, setExpanded] = useState(false);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [manualId, setManualId] = useState("");
  const [filterText, setFilterText] = useState("");
  const [category, setCategory] = useState<FilterCategory>("all");
  const [pingingAll, setPingingAll] = useState(false);
  const [pingProgress, setPingProgress] = useState<{ current: number; total: number } | null>(null);
  const [editingEndpoint, setEditingEndpoint] = useState(false);
  const [editLabel, setEditLabel] = useState(provider.label);
  const [editUrl, setEditUrl] = useState(provider.baseUrl ?? "");
  const [editRequireKey, setEditRequireKey] = useState(requiresKey);
  const [clearStoredKey, setClearStoredKey] = useState(false);

  const fetching = state.providerModelsFetching.includes(provider.id);
  const fetchError = state.providerModelsError[provider.id];
  const liveModels = state.providerModels[provider.id] ?? [];
  const hasFetched = provider.id in state.providerModels || !!fetchError;

  const dispatchFetch = () => {
    actions.fetchProviderModels(provider.id);
  };

  const handleSave = () => {
    if (!key.trim()) return;
    actions.setProviderApiKey(provider.id, key.trim());
    setKey("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  };

  const handleSaveEndpointEdit = () => {
    const cleanLabel = editLabel.trim();
    const cleanUrl = editUrl.trim();
    if (!cleanLabel || !/^https?:\/\//i.test(cleanUrl)) return;
    actions.updateCustomProvider(
      provider.id,
      cleanLabel,
      cleanUrl,
      key.trim() || undefined,
      editRequireKey,
      clearStoredKey || undefined
    );
    setKey("");
    setClearStoredKey(false);
    setEditingEndpoint(false);
  };

  const handleClear = () => {
    setClearing(true);
    actions.setProviderApiKey(provider.id, "");
    setTimeout(() => setClearing(false), 1200);
  };

  const handleToggle = (val: boolean) => {
    actions.setProviderEnabled(provider.id, val);
    if (val && !provider.configured) setExpanded(true);
  };

  const handleManualAdd = () => {
    const id = manualId.trim();
    if (!id) return;
    actions.addAvailableModel(provider.id, { name: id });
    setManualId("");
  };

  const prefixedName = (m: ModelInfo) =>
    m.name.startsWith(`${provider.id}:`) ? m.name : `${provider.id}:${m.name}`;

  const cleanName = (name: string) =>
    name.startsWith(`${provider.id}:`) ? name.slice(provider.id.length + 1) : name;

  // Filtered model collection based on search text and active category tab
  const filteredModels = useMemo(() => {
    let result = liveModels;

    // 1. Search text filter
    if (filterText.trim()) {
      const q = filterText.trim().toLowerCase();
      result = result.filter((m) => m.name.toLowerCase().includes(q));
    }

    // 2. Category pill filter
    if (category === "recommended") {
      result = result.filter((m) => isRecommended(m.name));
    } else if (category === "picker") {
      result = result.filter((m) => state.models.some((sm) => sm.name === prefixedName(m)));
    } else if (category === "reasoning") {
      result = result.filter(hasReasoning);
    } else if (category === "vision") {
      result = result.filter(hasVision);
    } else if (category === "fast") {
      result = result.filter(isFast);
    }

    return result;
  }, [liveModels, filterText, category, state.models, provider.id]);

  // Counts for filter pills
  const counts = useMemo(() => {
    return {
      all: liveModels.length,
      recommended: liveModels.filter((m) => isRecommended(m.name)).length,
      picker: liveModels.filter((m) => state.models.some((sm) => sm.name === prefixedName(m))).length,
      reasoning: liveModels.filter(hasReasoning).length,
      vision: liveModels.filter(hasVision).length,
      fast: liveModels.filter(isFast).length,
    };
  }, [liveModels, state.models, provider.id]);

  // Auto-ping all visible models in controlled batches of 3
  const handleAutoPing = async () => {
    if (pingingAll || filteredModels.length === 0) return;
    setPingingAll(true);
    const targets = filteredModels.slice(0, 15);
    setPingProgress({ current: 0, total: targets.length });

    const batchSize = 3;
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map((m) => actions.testModel(provider.id, m))
      );
      setPingProgress({ current: Math.min(i + batchSize, targets.length), total: targets.length });
    }

    setPingingAll(false);
    setPingProgress(null);
  };

  return (
    <div
      className={`provider-card ${provider.enabled ? "enabled" : ""} ${
        provider.configured ? "configured" : ""
      }`}
    >
      {/* ── Header row with Official Logo ── */}
      <div className="provider-header" onClick={() => setExpanded((v) => !v)}>
        <div className="provider-logo-wrap" title={provider.label}>
          <ProviderLogo providerId={provider.id} label={provider.label} baseUrl={provider.baseUrl} size={22} />
        </div>

        <div className="provider-info">
          <div className="provider-title-row">
            <span className="provider-name">{provider.label}</span>
            {provider.configured && (
              <span className="provider-status-dot connected" title="Configured & Ready">
                ●
              </span>
            )}
          </div>
          <div className="provider-badges">
            {!requiresKey ? (
              <span className="provider-badge badge-ok" title="API key optional for this endpoint">
                <CheckIcon size={10} />
                <span>{provider.configured ? "Key Stored" : "No Key Needed"}</span>
              </span>
            ) : provider.configured ? (
              <span className="provider-badge badge-ok">
                <CheckIcon size={10} />
                <span>Key Stored</span>
              </span>
            ) : (
              <span className="provider-badge badge-warn">No Key</span>
            )}
            {provider.enabled && provider.modelCount > 0 && (
              <span className="provider-badge badge-count">
                {provider.modelCount} in picker
              </span>
            )}
            {liveModels.length > 0 && (
              <span className="provider-badge badge-available">
                {liveModels.length} models available
              </span>
            )}
          </div>
        </div>

        <div className="provider-controls" onClick={(e) => e.stopPropagation()}>
          {isCustom && (
            <button
              type="button"
              className="provider-remove-btn"
              title="Remove this endpoint"
              onClick={() => actions.removeCustomProvider(provider.id)}
            >
              <CloseIcon />
            </button>
          )}
          <button
            type="button"
            className="provider-expand-btn"
            title={expanded ? "Collapse" : "Configure"}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <span className={`expand-chevron ${expanded ? "open" : ""}`}>
              <ChevronRightIcon />
            </span>
          </button>
          <Toggle checked={provider.enabled} onChange={handleToggle} />
        </div>
      </div>

      {/* ── Expandable Configuration & Models View ── */}
      {expanded && (
        <div className="provider-expand">
          <div className="provider-hint-bar">
            <span className="provider-hint-text">{meta.hint}</span>
            {isCustom && (
              <button
                type="button"
                className="btn btn-sm ghost provider-edit-endpoint-btn"
                onClick={() => {
                  setEditLabel(provider.label);
                  setEditUrl(provider.baseUrl ?? "");
                  setEditRequireKey(requiresKey);
                  setClearStoredKey(false);
                  setEditingEndpoint((v) => !v);
                }}
              >
                {editingEndpoint ? "Cancel Edit" : "Edit Endpoint"}
              </button>
            )}
          </div>

          {isCustom && editingEndpoint && (
            <div className="provider-edit-endpoint-form">
              <label className="custom-endpoint-field">
                <span>Name</span>
                <input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="custom-endpoint-field">
                <span>Base URL</span>
                <input
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                />
              </label>
              <label className="custom-endpoint-checkbox">
                <input
                  type="checkbox"
                  checked={editRequireKey}
                  onChange={(e) => setEditRequireKey(e.target.checked)}
                />
                <span>Requires API key</span>
              </label>
              {provider.configured && (
                <label className="custom-endpoint-checkbox">
                  <input
                    type="checkbox"
                    checked={clearStoredKey}
                    onChange={(e) => setClearStoredKey(e.target.checked)}
                  />
                  <span>Clear stored API key</span>
                </label>
              )}
              <div className="custom-endpoint-actions">
                <button
                  type="button"
                  className="btn btn-sm primary"
                  disabled={!editLabel.trim() || !/^https?:\/\//i.test(editUrl.trim())}
                  onClick={handleSaveEndpointEdit}
                >
                  Save Endpoint
                </button>
              </div>
            </div>
          )}

          {/* API Key Input Section */}
          <div className="key-input-section">
            <div className="key-header-row">
              <label className="key-label">
                {requiresKey ? "API Key" : "API Key (Optional)"}
              </label>
              {meta.docsUrl && (
                <a
                  className="key-docs-link"
                  href={meta.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open official API key portal"
                >
                  Get key ↗
                </a>
              )}
            </div>
            <div className="key-input-wrap">
              <input
                className="key-input"
                type={showKey ? "text" : "password"}
                placeholder={
                  provider.configured
                    ? "••••••••••••••••••••••••  (securely stored in keychain)"
                    : requiresKey
                    ? "Paste API key…"
                    : "Optional bearer token for local/custom server…"
                }
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="key-reveal-btn"
                title={showKey ? "Hide key" : "Show key"}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
              </button>
            </div>
            <div className="key-actions">
              <button
                type="button"
                className="btn btn-sm primary btn-save-key"
                onClick={handleSave}
                disabled={!key.trim()}
              >
                {saved ? (
                  <>
                    <CheckIcon size={11} />
                    <span>Saved &amp; Connected</span>
                  </>
                ) : (
                  "Save & Connect"
                )}
              </button>
              {provider.configured && (
                <button
                  type="button"
                  className="btn btn-sm ghost"
                  onClick={handleClear}
                >
                  {clearing ? "Cleared" : "Clear Key"}
                </button>
              )}
              {meta.live && (!requiresKey || provider.configured) && !hasFetched && (
                <button
                  type="button"
                  className="btn btn-sm ghost"
                  onClick={dispatchFetch}
                  disabled={fetching}
                >
                  <RefreshIcon />
                  <span>{fetching ? "Fetching…" : "Fetch Models"}</span>
                </button>
              )}
            </div>
          </div>

          {/* Models Browser & Selector Section */}
          {(provider.configured || !requiresKey || hasFetched || !meta.live) && (
            <div className="provider-models-section">
              <div className="provider-models-header">
                <div className="provider-models-title-wrap">
                  <span className="provider-models-label">
                    Models ({liveModels.length})
                  </span>
                  {counts.picker > 0 && (
                    <span className="models-in-picker-chip">
                      {counts.picker} in picker
                    </span>
                  )}
                </div>

                <div className="provider-models-actions">
                  {liveModels.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm ghost autoping-btn"
                      onClick={handleAutoPing}
                      disabled={pingingAll || !provider.enabled}
                      title="Automatically ping latency for models"
                    >
                      <BoltIcon />
                      <span>
                        {pingingAll && pingProgress
                          ? `Testing (${pingProgress.current}/${pingProgress.total})…`
                          : "Auto Ping"}
                      </span>
                    </button>
                  )}
                  {meta.live && provider.configured && (
                    <button
                      type="button"
                      className="btn btn-sm ghost refresh-models-btn"
                      onClick={dispatchFetch}
                      disabled={fetching}
                      title="Fetch latest models from provider API"
                    >
                      <RefreshIcon />
                      <span>{fetching ? "Refreshing…" : "Refresh"}</span>
                    </button>
                  )}
                </div>
              </div>

              {fetchError && (
                <div className="provider-fetch-error">
                  Connection error: {fetchError}
                </div>
              )}

              {/* Category Filter Tabs */}
              {liveModels.length > 0 && (
                <div className="model-category-pills">
                  <button
                    type="button"
                    className={`category-pill ${category === "all" ? "active" : ""}`}
                    onClick={() => setCategory("all")}
                  >
                    All ({counts.all})
                  </button>
                  {counts.recommended > 0 && (
                    <button
                      type="button"
                      className={`category-pill ${category === "recommended" ? "active" : ""}`}
                      onClick={() => setCategory("recommended")}
                    >
                      Recommended ({counts.recommended})
                    </button>
                  )}
                  {counts.picker > 0 && (
                    <button
                      type="button"
                      className={`category-pill ${category === "picker" ? "active" : ""}`}
                      onClick={() => setCategory("picker")}
                    >
                      In Picker ({counts.picker})
                    </button>
                  )}
                  {counts.reasoning > 0 && (
                    <button
                      type="button"
                      className={`category-pill ${category === "reasoning" ? "active" : ""}`}
                      onClick={() => setCategory("reasoning")}
                    >
                      Reasoning ({counts.reasoning})
                    </button>
                  )}
                  {counts.vision > 0 && (
                    <button
                      type="button"
                      className={`category-pill ${category === "vision" ? "active" : ""}`}
                      onClick={() => setCategory("vision")}
                    >
                      Vision ({counts.vision})
                    </button>
                  )}
                  {counts.fast > 0 && (
                    <button
                      type="button"
                      className={`category-pill ${category === "fast" ? "active" : ""}`}
                      onClick={() => setCategory("fast")}
                    >
                      Fast ({counts.fast})
                    </button>
                  )}
                </div>
              )}

              {/* Search filter input */}
              {liveModels.length > 4 && (
                <div className="model-search-wrap">
                  <input
                    className="model-search-input"
                    placeholder={`Search ${liveModels.length} models (e.g. flash, sonnet, gpt-4o, deepseek)…`}
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    spellCheck={false}
                  />
                  {filterText && (
                    <button
                      type="button"
                      className="search-clear-btn"
                      onClick={() => setFilterText("")}
                      title="Clear search"
                    >
                      ×
                    </button>
                  )}
                </div>
              )}

              {/* Manual Add Input */}
              <div className="manual-add-row">
                <input
                  className="manual-add-input"
                  placeholder="Or enter any model ID directly (e.g. gpt-4o-mini)"
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleManualAdd()}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleManualAdd}
                  disabled={!manualId.trim()}
                >
                  + Add Model
                </button>
              </div>

              {/* Structured Model Cards List */}
              {filteredModels.length > 0 ? (
                <div className="provider-model-list-cards">
                  {filteredModels.slice(0, 100).map((mInfo) => {
                    const cName = cleanName(mInfo.name);
                    const testKey = prefixedName(mInfo);
                    const testRes = state.modelTestResults[testKey];
                    const testing = state.modelTestRunning.includes(testKey);
                    const isInPicker = state.models.some((m) => m.name === testKey);
                    const ctxLabel = formatContext(mInfo.contextLength);
                    const isRec = isRecommended(mInfo.name);

                    return (
                      <div
                        key={cName}
                        className={`provider-model-card-item ${isInPicker ? "in-picker" : ""} ${
                          isRec ? "recommended" : ""
                        }`}
                      >
                        <div className="model-card-left">
                          <div className="model-card-title-row">
                            <span className="model-card-name" title={mInfo.name}>
                              {cName}
                            </span>
                            {isRec && (
                              <span className="model-card-rec-badge" title="Recommended Flagship Model">
                                Recommended
                              </span>
                            )}
                            {ctxLabel && (
                              <span className="model-card-ctx-badge" title={`Context window: ${ctxLabel}`}>
                                {ctxLabel}
                              </span>
                            )}
                          </div>
                          <CapabilityBadges model={mInfo} compact />
                        </div>

                        <div className="model-card-right">
                          {/* Latency ping indicator */}
                          {testRes && !testing && (
                            <span
                              className={`model-latency-tag ${
                                testRes.ok ? "latency-ok" : "latency-err"
                              }`}
                              title={testRes.error || `Round-trip latency: ${testRes.latencyMs}ms`}
                            >
                              {testRes.ok ? (
                                <>
                                  <span className="latency-dot">●</span>
                                  <span>{testRes.latencyMs}ms</span>
                                </>
                              ) : (
                                "Failed"
                              )}
                            </span>
                          )}

                          {/* Ping single button */}
                          {provider.configured && (
                            <button
                              type="button"
                              className="model-card-ping-btn"
                              onClick={() => actions.testModel(provider.id, mInfo)}
                              disabled={testing || !provider.enabled}
                              title="Test response and measure latency"
                            >
                              {testing ? "…" : "Ping"}
                            </button>
                          )}

                          {/* Picker Toggle Action */}
                          {isInPicker ? (
                            <button
                              type="button"
                              className="model-in-picker-btn"
                              title="Currently in model picker — click to remove"
                              onClick={() => actions.removeAvailableModel(testKey)}
                            >
                              <CheckIcon size={11} />
                              <span className="in-picker-text">In Picker</span>
                              <span className="in-picker-remove-text">Remove</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="model-add-to-picker-btn"
                              title="Add to the header model picker"
                              onClick={() => actions.addAvailableModel(provider.id, mInfo)}
                            >
                              + Add
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {filteredModels.length > 100 && (
                    <div className="provider-empty-note">
                      Showing top 100 of {filteredModels.length} models. Use the search box above to narrow down.
                    </div>
                  )}
                </div>
              ) : (
                <div className="provider-empty-note">
                  {hasFetched
                    ? filterText || category !== "all"
                      ? "No models match your current filter."
                      : "No models returned by this API key."
                    : "Press ↻ Refresh to fetch the models available to your API key."}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Form to register a custom OpenAI-compatible endpoint with 1-click presets. */
export function AddCustomEndpoint({ actions }: { actions: Actions }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [docsUrl, setDocsUrl] = useState("");
  const [requireApiKey, setRequireApiKey] = useState(true);
  const [presetFilter, setPresetFilter] = useState("");

  const trimmedUrl = baseUrl.trim();
  const urlValid = /^https?:\/\/[^/\s]+/i.test(trimmedUrl);
  const keyValid = !requireApiKey || apiKey.trim().length > 0;
  const valid = label.trim() !== "" && urlValid;

  const filteredPresets = useMemo(() => {
    const q = presetFilter.trim().toLowerCase();
    if (!q) return CUSTOM_ENDPOINT_PRESETS;
    return CUSTOM_ENDPOINT_PRESETS.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.baseUrl.toLowerCase().includes(q)
    );
  }, [presetFilter]);

  const submit = () => {
    if (!valid) return;
    actions.addCustomProvider(
      label.trim(),
      trimmedUrl,
      apiKey.trim() || undefined,
      requireApiKey
    );
    setLabel("");
    setBaseUrl("");
    setApiKey("");
    setDocsUrl("");
    setRequireApiKey(true);
    setPresetFilter("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="add-endpoint-btn" onClick={() => setOpen(true)}>
        + Add Custom / Preset Endpoint
      </button>
    );
  }

  return (
    <div className="custom-endpoint-form">
      <div className="custom-endpoint-header-row">
        <div className="custom-endpoint-title">1-Click Provider Presets</div>
        <input
          className="preset-filter-input"
          value={presetFilter}
          onChange={(e) => setPresetFilter(e.target.value)}
          placeholder="Filter presets…"
          spellCheck={false}
        />
      </div>
      <div className="preset-chip-row">
        {filteredPresets.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`preset-chip ${label === p.label ? "active" : ""}`}
            onClick={() => {
              setLabel(p.label);
              setBaseUrl(p.baseUrl);
              setDocsUrl(p.docsUrl);
              setRequireApiKey(p.requireApiKey !== false);
            }}
          >
            <ProviderLogo providerId={p.id} label={p.label} baseUrl={p.baseUrl} size={14} />
            <span>{p.label}</span>
          </button>
        ))}
      </div>
      <label className="custom-endpoint-field">
        <span>Name</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Groq, DeepSeek, LM Studio"
          autoFocus
          spellCheck={false}
        />
      </label>
      <label className="custom-endpoint-field">
        <span>Base URL</span>
        <input
          value={baseUrl}
          onChange={(e) => {
            const next = e.target.value;
            setBaseUrl(next);
            if (looksLikeLocalUrl(next)) {
              setRequireApiKey(false);
            }
          }}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
        />
        {trimmedUrl && !urlValid && (
          <span className="custom-endpoint-validation">
            Enter a valid http:// or https:// base URL
          </span>
        )}
      </label>
      <label className="custom-endpoint-checkbox">
        <input
          type="checkbox"
          checked={requireApiKey}
          onChange={(e) => setRequireApiKey(e.target.checked)}
        />
        <span>Requires API key (uncheck for local LM Studio / vLLM servers)</span>
      </label>
      <label className="custom-endpoint-field">
        <span>{requireApiKey ? "API Key" : "API Key (Optional)"}</span>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={requireApiKey ? "Paste API key (can also be added later)…" : "Optional bearer token…"}
          type="password"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="custom-endpoint-actions">
        <button
          type="button"
          className="btn btn-sm primary"
          onClick={submit}
          disabled={!valid}
          title={!keyValid ? "Saves endpoint; add API key afterwards to fetch models" : undefined}
        >
          {apiKey.trim() || !requireApiKey ? "Save & Connect" : "Add Endpoint"}
        </button>
        <button
          type="button"
          className="btn btn-sm ghost"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        {docsUrl && (
          <a
            className="key-docs-link"
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
          >
            Get {label} key ↗
          </a>
        )}
      </div>
    </div>
  );
}
