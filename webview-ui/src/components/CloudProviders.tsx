import { useState } from "react";
import type { AppState, Actions } from "../state/store";
import type { ModelInfo } from "../../../src/shared/types";
import { Toggle } from "./Toggle";
import { CapabilityBadges } from "./CapabilityBadges";

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
    hint: "Google Gemini via the Generative Language API. Saving a key validates it and lists every model your account can use.",
    live: true,
  },
  claude: {
    id: "claude",
    letter: "A",
    color: "#D4623A",
    docsUrl: "https://console.anthropic.com/settings/keys",
    hint: "Anthropic Claude via /v1/messages. Saving a key validates it and lists the models enabled for your account.",
    live: true,
  },
  openai: {
    id: "openai",
    letter: "O",
    color: "#10A37F",
    docsUrl: "https://platform.openai.com/api-keys",
    hint: "OpenAI chat-completions API. Saving a key validates it and lists the models your organization can access.",
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
    hint: "OpenRouter — one key, hundreds of models. The list reflects what your key can route to.",
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
    hint: "Blackbox AI — OpenAI-compatible API. Live model listing is not supported; add model ids manually below.",
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

  const fetching = state.providerModelsFetching.includes(provider.id);
  const fetchError = state.providerModelsError[provider.id];
  /** Only models validated against the user's own key — no static catalogs. */
  const liveModels = state.providerModels[provider.id] ?? [];
  const hasFetched = provider.id in state.providerModels || !!fetchError;

  const dispatchFetch = () => {
    // Optimistic spinner; cleared when the host posts `providerModels`.
    actions.fetchProviderModels(provider.id);
  };

  const handleSave = () => {
    if (!key.trim()) return;
    // The host stores the key, then validates the connection by listing the
    // models available to this account.
    actions.setProviderApiKey(provider.id, key.trim());
    dispatchFetch();
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
    // Enabling is "connecting": validate + refresh the account's model list.
    if (val && provider.configured && meta.live) dispatchFetch();
  };

  const handleManualAdd = () => {
    const id = manualId.trim();
    if (!id) return;
    actions.addAvailableModel(provider.id, { name: id });
    setManualId("");
  };

  /** Prefixed name used as the picker identity, e.g. "gemini:gemini-2.5-pro". */
  const prefixedName = (m: ModelInfo) =>
    m.name.startsWith(`${provider.id}:`) ? m.name : `${provider.id}:${m.name}`;

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
              <span className="provider-badge badge-ok">✓ Connected</span>
            ) : (
              <span className="provider-badge badge-warn">No key</span>
            )}
            {provider.enabled && provider.modelCount > 0 && (
              <span className="provider-badge badge-count">
                {provider.modelCount} added
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
              ✕
            </button>
          )}
          <button
            className="provider-expand-btn"
            title={expanded ? "Collapse" : "Configure"}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <span className={`expand-chevron ${expanded ? "open" : ""}`}>›</span>
          </button>
          <Toggle checked={provider.enabled} onChange={handleToggle} />
        </div>
      </div>

      {/* ── Expandable body ── */}
      {expanded && (
        <div className="provider-expand">
          <p className="provider-hint">{meta.hint}</p>

          {/* API key input */}
          <div className="key-input-section">
            <label className="key-label">API Key</label>
            <div className="key-input-wrap">
              <input
                className="key-input"
                type={showKey ? "text" : "password"}
                placeholder={
                  provider.configured
                    ? "••••••••••••  (key stored — enter new to replace)"
                    : "Paste your API key…"
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
                {showKey ? "🙈" : "👁"}
              </button>
            </div>
            <div className="key-actions">
              <button
                className="btn btn-sm btn-accent"
                onClick={handleSave}
                disabled={!key.trim()}
              >
                {saved ? "Saved ✓" : "Connect"}
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

          {/* Models available to THIS account (validated against its key) */}
          {(provider.configured || hasFetched) && (
            <div className="provider-models-section">
              <div className="provider-models-header">
                <span className="provider-models-label">
                  Models available to your key
                </span>
                {meta.live && provider.configured && (
                  <button
                    className="btn btn-sm ghost refresh-models-btn"
                    onClick={dispatchFetch}
                    disabled={fetching}
                  >
                    {fetching ? "Fetching…" : "↻ Refresh"}
                  </button>
                )}
              </div>

              {fetchError && (
                <div className="provider-fetch-error">
                  Connection failed: {fetchError}
                </div>
              )}

              {!meta.live && (
                <div className="manual-add-row">
                  <input
                    className="manual-add-input"
                    placeholder="model-id (e.g. blackboxai-pro)"
                    value={manualId}
                    onChange={(e) => setManualId(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleManualAdd()}
                    spellCheck={false}
                  />
                  <button
                    className="btn btn-sm ghost"
                    onClick={handleManualAdd}
                    disabled={!manualId.trim()}
                  >
                    ＋ Add
                  </button>
                </div>
              )}

              {liveModels.length > 0 ? (
                <div className="provider-model-list">
                  {liveModels.map((mInfo) => {
                    const mName = mInfo.name.replace(`${provider.id}:`, "");
                    const testKey = prefixedName(mInfo);
                    const testRes = state.modelTestResults[testKey];
                    const testing = state.modelTestRunning.includes(testKey);
                    const isInPicker = state.models.some((m) => m.name === testKey);
                    return (
                      <div key={mName} className="provider-model-chip-row">
                        <span className="provider-model-chip">{mName}</span>
                        <CapabilityBadges model={mInfo} compact />
                        {provider.configured && (
                          <button
                            className="model-test-btn"
                            onClick={() => actions.testModel(provider.id, mInfo)}
                            disabled={testing || !provider.enabled}
                            title={
                              !provider.enabled
                                ? "Provider is disabled"
                                : "Send a tiny completion to verify this model works"
                            }
                          >
                            Test ›
                          </button>
                        )}
                        {testing && <span className="model-test-spinner">⧗</span>}
                        {testRes && !testing && (
                          <span
                            className={`model-test-result ${
                              testRes.ok ? "model-test-ok" : "model-test-err"
                            }`}
                            title={testRes.error || `Latency: ${testRes.latencyMs}ms`}
                          >
                            {testRes.ok
                              ? `✓ ${testRes.latencyMs}ms`
                              : `✗ ${testRes.error || "Test failed"}`}
                          </span>
                        )}
                        {testRes?.ok &&
                          (isInPicker ? (
                            <span className="model-added-tag" title="In the header model picker">
                              ✓ Added
                              <button
                                className="model-added-remove"
                                title="Remove from the picker"
                                onClick={() => actions.removeAvailableModel(testKey)}
                              >
                                ✕
                              </button>
                            </span>
                          ) : (
                            <button
                              className="model-add-btn"
                              title="Add this model to the header model picker"
                              onClick={() => actions.addAvailableModel(provider.id, mInfo)}
                            >
                              ＋ Add to picker
                            </button>
                          ))}
                      </div>
                    );
                  })}
                </div>
              ) : (
                meta.live &&
                provider.configured &&
                !fetching && (
                  <div className="provider-empty-note">
                    {hasFetched
                      ? "No models returned for this key."
                      : "Press ↻ Refresh to load the models your key can use."}
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

/** Inline form to register a custom OpenAI-compatible endpoint. */
export function AddCustomEndpoint({ actions }: { actions: Actions }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const valid = label.trim() !== "" && /^https?:\/\//.test(baseUrl.trim());

  const submit = () => {
    if (!valid) return;
    actions.addCustomProvider(label.trim(), baseUrl.trim(), apiKey.trim() || undefined);
    setLabel("");
    setBaseUrl("");
    setApiKey("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button className="add-endpoint-btn" onClick={() => setOpen(true)}>
        ＋ Add custom endpoint
      </button>
    );
  }

  return (
    <div className="custom-endpoint-form">
      <div className="custom-endpoint-title">Custom OpenAI-compatible endpoint</div>
      <label className="custom-endpoint-field">
        <span>Name</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Groq, Together, LM Studio"
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
        <span>API key (optional)</span>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Stored securely in VS Code secrets"
          type="password"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="custom-endpoint-actions">
        <button className="btn btn-sm btn-accent" onClick={submit} disabled={!valid}>
          Add endpoint
        </button>
        <button className="btn btn-sm ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
