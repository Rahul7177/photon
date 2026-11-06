import { useState } from "react";
import type { AppState, Actions } from "../state/store";
import type { ModelInfo } from "../../../src/shared/types";
import { Toggle } from "./Toggle";
import { CapabilityBadges } from "./CapabilityBadges";
import { CheckIcon, CloseIcon, EyeIcon, EyeOffIcon, ChevronRightIcon, RefreshIcon } from "./Icons";

interface ProviderStatus {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  modelCount: number;
}

interface ProviderMeta {
  id: string;
  letter: string;
  color: string;
  docsUrl: string;
  hint: string;
  /** Whether the provider's API can list the models available to this account. */
  live: boolean;
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  gemini: {
    id: "gemini",
    letter: "G",
    color: "#4285F4",
    docsUrl: "https://aistudio.google.com/app/apikey",
    hint: "Google Gemini via the Generative Language API. Connecting validates your key, auto-adds top models, and lists every model your account can use.",
    live: true,
  },
  claude: {
    id: "claude",
    letter: "A",
    color: "#D4623A",
    docsUrl: "https://console.anthropic.com/settings/keys",
    hint: "Anthropic Claude via /v1/messages with automatic ephemeral prompt caching (up to 90% input token discount on multi-step tasks).",
    live: true,
  },
  openai: {
    id: "openai",
    letter: "O",
    color: "#10A37F",
    docsUrl: "https://platform.openai.com/api-keys",
    hint: "OpenAI chat-completions API. Connecting validates your key and lists the models your organization can access.",
    live: true,
  },
  nvidia: {
    id: "nvidia",
    letter: "N",
    color: "#76B900",
    docsUrl: "https://build.nvidia.com",
    hint: "NVIDIA NIM — hosted Meta Llama, DeepSeek, Qwen, Nemotron and more via an OpenAI-compatible API.",
    live: true,
  },
  openrouter: {
    id: "openrouter",
    letter: "R",
    color: "#6B7280",
    docsUrl: "https://openrouter.ai/keys",
    hint: "OpenRouter — one key, hundreds of models. Use the search box below to filter and add any model in 1 click.",
    live: true,
  },
  opencode: {
    id: "opencode",
    letter: "Z",
    color: "#8B5CF6",
    docsUrl: "https://opencode.ai/auth",
    hint: "OpenCode Zen — curated, benchmarked coding models behind an OpenAI-compatible gateway.",
    live: true,
  },
  blackbox: {
    id: "blackbox",
    letter: "B",
    color: "#EAB308",
    docsUrl: "https://www.blackbox.ai",
    hint: "Blackbox AI — OpenAI-compatible API. Add model IDs manually below.",
    live: false,
  },
  llamacpp: {
    id: "llamacpp",
    letter: "L",
    color: "#6B7280",
    docsUrl: "https://github.com/ggerganov/llama.cpp",
    hint: "llama.cpp — local OpenAI-compatible server at photon.llamacpp.baseUrl/v1. Run with: llama-server -m model.gguf --port 8080. No API key needed.",
    live: true,
  },
};

const CUSTOM_ENDPOINT_PRESETS: { label: string; baseUrl: string; docsUrl: string }[] = [
  { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", docsUrl: "https://console.groq.com/keys" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", docsUrl: "https://platform.deepseek.com/api_keys" },
  { label: "Together AI", baseUrl: "https://api.together.xyz/v1", docsUrl: "https://api.together.ai/settings/api-keys" },
  { label: "Mistral", baseUrl: "https://api.mistral.ai/v1", docsUrl: "https://console.mistral.ai/api-keys" },
  { label: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", docsUrl: "https://fireworks.ai/account/api-keys" },
  { label: "xAI Grok", baseUrl: "https://api.x.ai/v1", docsUrl: "https://console.x.ai" },
  { label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", docsUrl: "https://cloud.cerebras.ai" },
];

/** Default meta for unknown / custom providers. */
function customMeta(id: string): ProviderMeta {
  return {
    id,
    letter: id[0]?.toUpperCase() ?? "?",
    color: "#9796a5",
    docsUrl: "",
    hint: "Custom OpenAI-compatible endpoint.",
    live: true,
  };
}

export function CloudProviderCard({
  provider,
  actions,
  state,
}: {
  provider: ProviderStatus;
  actions: Actions;
  state: AppState;
}) {
  const isCustom = !(provider.id in PROVIDER_META);
  const meta = PROVIDER_META[provider.id] ?? customMeta(provider.id);
  const [expanded, setExpanded] = useState(false);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [manualId, setManualId] = useState("");
  const [filterText, setFilterText] = useState("");

  const fetching = state.providerModelsFetching.includes(provider.id);
  const fetchError = state.providerModelsError[provider.id];
  const liveModels = state.providerModels[provider.id] ?? [];
  const hasFetched = provider.id in state.providerModels || !!fetchError;

  const dispatchFetch = () => {
    actions.fetchProviderModels(provider.id);
  };

  const handleSave = () => {
    if (!key.trim()) return;
    // Saving a key stores it in VS Code SecretStorage, auto-enables the provider,
    // fetches its live model list once, and auto-adds top models to the picker.
    actions.setProviderApiKey(provider.id, key.trim());
    setKey("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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

  const filteredModels = filterText.trim()
    ? liveModels.filter((m) =>
        m.name.toLowerCase().includes(filterText.trim().toLowerCase())
      )
    : liveModels;

  return (
    <div
      className={`provider-card ${provider.enabled ? "enabled" : ""} ${
        provider.configured ? "configured" : ""
      }`}
    >
      {/* ── Header row ── */}
      <div className="provider-header">
        <div
          className="provider-logo"
          style={{ background: meta.color }}
          title={provider.label}
        >
          {meta.letter}
        </div>

        <div className="provider-info">
          <span className="provider-name">{provider.label}</span>
          <div className="provider-badges">
            {provider.configured ? (
              <span className="provider-badge badge-ok">
                <CheckIcon size={11} />
                <span>Key stored</span>
              </span>
            ) : (
              <span className="provider-badge badge-warn">No key</span>
            )}
            {provider.enabled && provider.modelCount > 0 && (
              <span className="provider-badge badge-count">
                {provider.modelCount} in picker
              </span>
            )}
          </div>
        </div>

        <div className="provider-controls">
          {isCustom && (
            <button
              className="provider-remove-btn"
              title="Remove this endpoint"
              onClick={() => actions.removeCustomProvider(provider.id)}
            >
              <CloseIcon />
            </button>
          )}
          <button
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

      {/* ── Expandable body ── */}
      {expanded && (
        <div className="provider-expand">
          {/* API key input */}
          <div className="key-input-section">
            <label className="key-label">API Key</label>
            <div className="key-input-wrap">
              <input
                className="key-input"
                type={showKey ? "text" : "password"}
                placeholder={
                  provider.configured
                    ? "••••••••••••  (stored in keychain)"
                    : "Paste API key…"
                }
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="key-reveal-btn"
                title={showKey ? "Hide" : "Show"}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
              </button>
            </div>
            <div className="key-actions">
              <button
                className="btn btn-sm primary"
                onClick={handleSave}
                disabled={!key.trim()}
              >
                {saved ? (
                  <>
                    <CheckIcon size={11} />
                    <span>Connected</span>
                  </>
                ) : (
                  "Save & Connect"
                )}
              </button>
              {provider.configured && (
                <button className="btn btn-sm ghost" onClick={handleClear}>
                  {clearing ? "Cleared" : "Clear key"}
                </button>
              )}
              {meta.docsUrl && (
                <a
                  className="key-docs-link"
                  href={meta.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open API key page"
                >
                  Get key ↗
                </a>
              )}
            </div>
          </div>

          {/* Models available to THIS account */}
          {(provider.configured || hasFetched) && (
            <div className="provider-models-section">
              <div className="provider-models-header">
                <span className="provider-models-label">
                  Models ({liveModels.length})
                </span>
                {meta.live && provider.configured && (
                  <button
                    className="btn btn-sm ghost refresh-models-btn"
                    onClick={dispatchFetch}
                    disabled={fetching}
                  >
                    <RefreshIcon />
                    <span>{fetching ? "Fetching…" : "Refresh"}</span>
                  </button>
                )}
              </div>

              {fetchError && (
                <div className="provider-fetch-error">
                  Connection failed: {fetchError}
                </div>
              )}

              {liveModels.length > 5 && (
                <input
                  className="manual-add-input"
                  placeholder={`Filter ${liveModels.length} models (e.g. sonnet, flash, gpt-4o, deepseek)…`}
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  spellCheck={false}
                />
              )}

              <div className="manual-add-row">
                <input
                  className="manual-add-input"
                  placeholder="Or add any model ID directly (e.g. gpt-4o-mini)"
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleManualAdd()}
                  spellCheck={false}
                />
                <button
                  className="btn btn-sm"
                  onClick={handleManualAdd}
                  disabled={!manualId.trim()}
                >
                  + Add
                </button>
              </div>

              {filteredModels.length > 0 ? (
                <div className="provider-model-list">
                  {filteredModels.slice(0, 80).map((mInfo) => {
                    const mName = mInfo.name.replace(`${provider.id}:`, "");
                    const testKey = prefixedName(mInfo);
                    const testRes = state.modelTestResults[testKey];
                    const testing = state.modelTestRunning.includes(testKey);
                    const isInPicker = state.models.some((m) => m.name === testKey);
                    return (
                      <div key={mName} className="provider-model-chip-row">
                        <span className="provider-model-chip" title={mName}>{mName}</span>
                        <CapabilityBadges model={mInfo} compact />
                        {isInPicker ? (
                          <span className="model-added-tag" title="Available in the header model picker">
                            <CheckIcon size={11} />
                            <span>In picker</span>
                            <button
                              className="model-added-remove"
                              title="Remove from the picker"
                              onClick={() => actions.removeAvailableModel(testKey)}
                            >
                              <CloseIcon />
                            </button>
                          </span>
                        ) : (
                          <button
                            className="model-add-btn"
                            title="Add this model to the header model picker (no paid test required)"
                            onClick={() => actions.addAvailableModel(provider.id, mInfo)}
                          >
                            + Add
                          </button>
                        )}
                        {provider.configured && (
                          <button
                            className="model-test-btn"
                            onClick={() => actions.testModel(provider.id, mInfo)}
                            disabled={testing || !provider.enabled}
                            title="Optional: send a 1-token ping to test latency"
                          >
                            {testing ? "…" : "Ping"}
                          </button>
                        )}
                        {testRes && !testing && (
                          <span
                            className={`model-test-result ${
                              testRes.ok ? "model-test-ok" : "model-test-err"
                            }`}
                            title={testRes.error || `Latency: ${testRes.latencyMs}ms`}
                          >
                            {testRes.ok ? `${testRes.latencyMs}ms` : <CloseIcon />}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {filteredModels.length > 80 && (
                    <div className="provider-empty-note">
                      Showing first 80 of {filteredModels.length} matches — use the filter box above to narrow down.
                    </div>
                  )}
                </div>
              ) : (
                meta.live &&
                provider.configured &&
                !fetching && (
                  <div className="provider-empty-note">
                    {hasFetched
                      ? filterText
                        ? "No models matched your filter."
                        : "No models returned for this key."
                      : "Press ↻ Refresh list to load the models your key can use."}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline form to register a custom OpenAI-compatible endpoint with 1-click presets. */
export function AddCustomEndpoint({ actions }: { actions: Actions }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [docsUrl, setDocsUrl] = useState("");
  const valid = label.trim() !== "" && /^https?:\/\//.test(baseUrl.trim());

  const submit = () => {
    if (!valid) return;
    actions.addCustomProvider(label.trim(), baseUrl.trim(), apiKey.trim() || undefined);
    setLabel("");
    setBaseUrl("");
    setApiKey("");
    setDocsUrl("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button className="add-endpoint-btn" onClick={() => setOpen(true)}>
        + Add Custom / Preset Endpoint
      </button>
    );
  }

  return (
    <div className="custom-endpoint-form">
      <div className="custom-endpoint-title">Endpoint Presets</div>
      <div className="preset-chip-row">
        {CUSTOM_ENDPOINT_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`preset-chip ${label === p.label ? "active" : ""}`}
            onClick={() => {
              setLabel(p.label);
              setBaseUrl(p.baseUrl);
              setDocsUrl(p.docsUrl);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="custom-endpoint-field">
        <span>Name</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Groq, DeepSeek"
          autoFocus
          spellCheck={false}
        />
      </label>
      <label className="custom-endpoint-field">
        <span>Base URL</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
        />
      </label>
      <label className="custom-endpoint-field">
        <span>API Key</span>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste API key…"
          type="password"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="custom-endpoint-actions">
        <button className="btn btn-sm primary" onClick={submit} disabled={!valid}>
          Save &amp; Connect
        </button>
        <button className="btn btn-sm ghost" onClick={() => setOpen(false)}>
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
