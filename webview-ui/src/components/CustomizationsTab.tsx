import { useState, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import type {
  CustomAgentInfo,
  CustomizationScope,
  InstructionInfo,
  McpServerInfo,
  Mode,
  SkillInfo,
} from "../../../src/shared/types";
import type { Actions, AppState } from "../state/store";
import {
  BotIcon,
  ChevronRightIcon,
  CloseIcon,
  EditIcon,
  FileCodeIcon,
  LinkIcon,
  PlusIcon,
  RulerIcon,
  SearchIcon,
  SparkleIcon,
  TrashIcon,
} from "./Icons";
import { Toggle } from "./Toggle";
import { HelpTip } from "./HelpTip";

export type CustomizationSection = "mcp" | "skills" | "instructions" | "agents";

interface CustomizationsTabProps {
  state: AppState;
  actions: Actions;
  initialSection?: CustomizationSection;
  onCloseSettings?: () => void;
}

type DraftForm =
  | { kind: "mcp"; scope: CustomizationScope }
  | { kind: "skill"; scope: CustomizationScope; slug?: string; name: string; description: string; content: string }
  | { kind: "instructions"; scope: CustomizationScope; slug?: string; name: string; applyTo: string; content: string }
  | { kind: "agent"; scope: CustomizationScope; slug?: string; name: string; description: string; preferredMode: "" | Mode; instructions: string };

const SECTION_META: Record<
  CustomizationSection,
  { label: string; title: string; subtitle: string; searchPlaceholder: string; icon: ReactNode }
> = {
  mcp: {
    label: "MCP Servers",
    title: "MCP Servers",
    subtitle: "Connect external tools, databases, and services via the Model Context Protocol.",
    searchPlaceholder: "Search MCP servers...",
    icon: <LinkIcon />,
  },
  skills: {
    label: "Skills",
    title: "Skills",
    subtitle: "Reusable workflow folders (SKILL.md) invoked automatically or via /skill commands.",
    searchPlaceholder: "Search skills...",
    icon: <SparkleIcon />,
  },
  instructions: {
    label: "Instructions",
    title: "Instructions",
    subtitle: "Define coding guidelines and rules automatically injected into every chat and agent turn.",
    searchPlaceholder: "Search instructions...",
    icon: <RulerIcon />,
  },
  agents: {
    label: "Agents",
    title: "Agents",
    subtitle: "Configure custom personas (*.agent.md) with tailored instructions and preferred modes.",
    searchPlaceholder: "Search agents...",
    icon: <BotIcon />,
  },
};

export function CustomizationsTab({
  state,
  actions,
  initialSection = "mcp",
  onCloseSettings,
}: CustomizationsTabProps) {
  const [section, setSection] = useState<CustomizationSection>(initialSection);
  const [query, setQuery] = useState("");
  const [userOpen, setUserOpen] = useState(true);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [draft, setDraft] = useState<DraftForm | null>(null);

  // MCP Add Form local state
  const [mcpId, setMcpId] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpCommand, setMcpCommand] = useState("npx");
  const [mcpArgs, setMcpArgs] = useState("-y @modelcontextprotocol/server-filesystem .");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpHeadersRaw, setMcpHeadersRaw] = useState("");
  const [mcpEnvRaw, setMcpEnvRaw] = useState("");
  const [mcpConnectNow, setMcpConnectNow] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setSection(initialSection);
    setDraft(null);
    setFormError(null);
  }, [initialSection]);

  const switchSection = (next: CustomizationSection) => {
    setSection(next);
    setQuery("");
    setDraft(null);
    setFormError(null);
  };

  const q = query.trim().toLowerCase();

  const mcpByScope = useMemo(() => {
    const match = (s: McpServerInfo) =>
      !q || s.id.toLowerCase().includes(q) || s.target.toLowerCase().includes(q);
    return {
      user: state.mcpServers.filter((s) => s.scope === "user" && match(s)),
      workspace: state.mcpServers.filter((s) => s.scope !== "user" && match(s)),
    };
  }, [state.mcpServers, q]);

  const skillsByScope = useMemo(() => {
    const match = (s: SkillInfo) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.slug.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.relPath.toLowerCase().includes(q);
    return {
      user: state.customizations.skills.filter((s) => s.scope === "user" && match(s)),
      workspace: state.customizations.skills.filter((s) => s.scope === "workspace" && match(s)),
    };
  }, [state.customizations.skills, q]);

  const instructionsByScope = useMemo(() => {
    const match = (i: InstructionInfo) =>
      !q ||
      i.name.toLowerCase().includes(q) ||
      (i.description ?? "").toLowerCase().includes(q) ||
      (i.applyTo ?? "").toLowerCase().includes(q) ||
      i.relPath.toLowerCase().includes(q);
    return {
      user: state.customizations.instructions.filter((i) => i.scope === "user" && match(i)),
      workspace: state.customizations.instructions.filter((i) => i.scope === "workspace" && match(i)),
    };
  }, [state.customizations.instructions, q]);

  const agentsByScope = useMemo(() => {
    const match = (a: CustomAgentInfo) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      a.slug.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.relPath.toLowerCase().includes(q);
    return {
      user: state.customizations.agents.filter((a) => a.scope === "user" && match(a)),
      workspace: state.customizations.agents.filter((a) => a.scope === "workspace" && match(a)),
    };
  }, [state.customizations.agents, q]);

  const counts: Record<CustomizationSection, number> = {
    mcp: state.mcpServers.length,
    skills: state.customizations.skills.length,
    instructions: state.customizations.instructions.length,
    agents: state.customizations.agents.length,
  };

  const openCreateForm = (scope: CustomizationScope) => {
    setFormError(null);
    if (scope === "user") setUserOpen(true);
    else setWorkspaceOpen(true);

    if (section === "mcp") {
      setMcpId("");
      setMcpTransport("stdio");
      setMcpCommand("npx");
      setMcpArgs("");
      setMcpUrl("");
      setMcpHeadersRaw("");
      setMcpEnvRaw("");
      setMcpConnectNow(true);
      setDraft({ kind: "mcp", scope });
    } else if (section === "skills") {
      setDraft({ kind: "skill", scope, name: "", description: "", content: "" });
    } else if (section === "instructions") {
      setDraft({ kind: "instructions", scope, name: "", applyTo: "", content: "" });
    } else {
      setDraft({
        kind: "agent",
        scope,
        name: "",
        description: "",
        preferredMode: "",
        instructions: "",
      });
    }
  };

  const parseKeyValueLines = (raw: string): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.includes("=") ? trimmed.indexOf("=") : trimmed.indexOf(":");
      if (idx <= 0) continue;
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const submitDraft = () => {
    if (!draft) return;
    setFormError(null);
    if (draft.kind === "mcp") {
      const id = mcpId.trim();
      if (!id) {
        setFormError("Server ID is required (e.g. github, filesystem, postgres).");
        return;
      }
      if (mcpTransport === "stdio") {
        if (!mcpCommand.trim()) {
          setFormError("Command is required (e.g. npx, uvx, node, python).");
          return;
        }
        const args = mcpArgs
          .trim()
          .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
          ?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
        actions.addMcpServer({
          scope: draft.scope,
          id,
          transport: "stdio",
          command: mcpCommand.trim(),
          args,
          env: parseKeyValueLines(mcpEnvRaw),
          connectNow: mcpConnectNow,
        });
      } else {
        if (!mcpUrl.trim()) {
          setFormError("Server URL is required for HTTP transport.");
          return;
        }
        actions.addMcpServer({
          scope: draft.scope,
          id,
          transport: "http",
          url: mcpUrl.trim(),
          headers: parseKeyValueLines(mcpHeadersRaw),
          connectNow: mcpConnectNow,
        });
      }
      setDraft(null);
      return;
    }

    if (draft.kind === "skill") {
      if (!draft.name.trim() || !draft.content.trim()) {
        setFormError("Skill name and instructions are required.");
        return;
      }
      actions.saveSkill({
        scope: draft.scope,
        slug: draft.slug,
        name: draft.name.trim(),
        description: draft.description.trim(),
        content: draft.content,
      });
      setDraft(null);
      return;
    }

    if (draft.kind === "instructions") {
      if (!draft.name.trim() || !draft.content.trim()) {
        setFormError("Instruction name and content are required.");
        return;
      }
      actions.saveInstruction({
        scope: draft.scope,
        slug: draft.slug,
        name: draft.name.trim(),
        applyTo: draft.applyTo.trim() || undefined,
        content: draft.content,
      });
      setDraft(null);
      return;
    }

    if (draft.kind === "agent") {
      if (!draft.name.trim() || !draft.instructions.trim()) {
        setFormError("Agent name and system instructions are required.");
        return;
      }
      actions.saveCustomAgent({
        scope: draft.scope,
        slug: draft.slug,
        name: draft.name.trim(),
        description: draft.description.trim(),
        instructions: draft.instructions,
        preferredMode: draft.preferredMode || undefined,
      });
      setDraft(null);
    }
  };

  const meta = SECTION_META[section];

  const renderMcpRow = (s: McpServerInfo) => {
    const canApprove = s.status === "pending" || s.status === "revoked" || s.status === "error";
    const isConnected = s.status === "connected" || s.status === "approved";
    return (
      <div key={s.id} className="custom-row">
        <div className="custom-row-main">
          <div className="custom-row-title-line">
            <span className="custom-row-title">{s.id}</span>
            <span className={`mcp-status mcp-${s.status}`}>{s.status}</span>
            {s.toolCount > 0 && <span className="custom-badge">{s.toolCount} tools</span>}
          </div>
          <div className="custom-row-sub">
            <span className="custom-pill">{s.transport}</span>
            <span className="custom-path" title={s.target}>{s.target}</span>
          </div>
          {s.message && <div className="mcp-msg">{s.message}</div>}
        </div>
        <div className="custom-row-actions">
          {canApprove && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => actions.approveMcpServer(s.id, s.fingerprint, "persistent")}
              title="Connect MCP server"
            >
              {s.status === "error" ? "Retry" : "Start"}
            </button>
          )}
          <Toggle
            checked={isConnected}
            onChange={(next) => {
              if (next) actions.approveMcpServer(s.id, s.fingerprint, "persistent");
              else actions.revokeMcpServer(s.id);
            }}
            label={isConnected ? `Disconnect ${s.id}` : `Connect ${s.id}`}
          />
          {s.sourcePath && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => actions.openCustomizationFile(s.sourcePath!)}
              title="Open mcp.json"
              aria-label={`Open config for ${s.id}`}
            >
              <FileCodeIcon />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => actions.removeMcpServer(s.id, s.scope)}
            title="Remove MCP server"
            aria-label={`Remove ${s.id}`}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    );
  };

  const renderSkillRow = (s: SkillInfo) => (
    <div key={s.id} className={`custom-row${!s.enabled ? " muted" : ""}`}>
      <div className="custom-row-main">
        <div className="custom-row-title-line">
          <span className="custom-row-title">{s.name}</span>
          <code className="custom-slash-chip">/{s.slug}</code>
        </div>
        {s.description && <div className="custom-row-desc">{s.description}</div>}
        <div className="custom-row-sub">
          <span className="custom-path" title={s.filePath}>{s.relPath}</span>
        </div>
      </div>
      <div className="custom-row-actions">
        {s.enabled && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              actions.setDraftPrompt(`/${s.slug} `);
              onCloseSettings?.();
            }}
            title={`Run /${s.slug} in chat`}
          >
            Use
          </button>
        )}
        <Toggle
          checked={s.enabled}
          onChange={(next) => actions.toggleSkill(s.id, next)}
          label={s.enabled ? `Disable ${s.name}` : `Enable ${s.name}`}
        />
        <button
          type="button"
          className="icon-btn"
          onClick={() =>
            setDraft({
              kind: "skill",
              scope: s.scope,
              slug: s.slug,
              name: s.name,
              description: s.description,
              content: s.content,
            })
          }
          title="Edit skill"
          aria-label={`Edit ${s.name}`}
        >
          <EditIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => actions.openCustomizationFile(s.filePath)}
          title="Open SKILL.md in editor"
          aria-label={`Open file for ${s.name}`}
        >
          <FileCodeIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => actions.deleteSkill(s.id)}
          title="Delete skill"
          aria-label={`Delete ${s.name}`}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );

  const renderInstructionRow = (i: InstructionInfo) => (
    <div key={i.id} className={`custom-row${!i.enabled ? " muted" : ""}`}>
      <div className="custom-row-main">
        <div className="custom-row-title-line">
          <span className="custom-row-title">{i.name}</span>
          {i.applyTo && <span className="custom-badge">{i.applyTo}</span>}
        </div>
        {i.description && <div className="custom-row-desc">{i.description}</div>}
        <div className="custom-row-sub">
          <span className="custom-path" title={i.filePath}>{i.relPath}</span>
        </div>
      </div>
      <div className="custom-row-actions">
        <Toggle
          checked={i.enabled}
          onChange={(next) => actions.toggleInstruction(i.id, next)}
          label={i.enabled ? `Disable ${i.name}` : `Enable ${i.name}`}
        />
        <button
          type="button"
          className="icon-btn"
          onClick={() =>
            setDraft({
              kind: "instructions",
              scope: i.scope,
              slug: i.slug,
              name: i.name,
              applyTo: i.applyTo ?? "",
              content: i.content,
            })
          }
          title="Edit instruction"
          aria-label={`Edit ${i.name}`}
        >
          <EditIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => actions.openCustomizationFile(i.filePath)}
          title="Open file in editor"
          aria-label={`Open file for ${i.name}`}
        >
          <FileCodeIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => actions.deleteInstruction(i.id)}
          title="Delete instruction"
          aria-label={`Delete ${i.name}`}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );

  const renderAgentRow = (a: CustomAgentInfo) => {
    const isActive = state.customizations.activeAgentId === a.id;
    return (
      <div key={a.id} className={`custom-row${!a.enabled ? " muted" : ""}${isActive ? " is-active" : ""}`}>
        <div className="custom-row-main">
          <div className="custom-row-title-line">
            <span className="custom-row-title">{a.name}</span>
            {isActive && <span className="custom-active-pill">Active</span>}
            {a.preferredMode && <span className="custom-badge">{a.preferredMode}</span>}
          </div>
          {a.description && <div className="custom-row-desc">{a.description}</div>}
          <div className="custom-row-sub">
            <code className="custom-slash-chip">/agent:{a.slug}</code>
            <span className="custom-path" title={a.filePath}>{a.relPath}</span>
          </div>
        </div>
        <div className="custom-row-actions">
          {a.enabled && (
            <button
              type="button"
              className={`btn btn-sm${isActive ? " primary" : ""}`}
              onClick={() => actions.setActiveCustomAgent(isActive ? null : a.id)}
              title={isActive ? "Deactivate custom agent" : `Activate ${a.name}`}
            >
              {isActive ? "Active" : "Use"}
            </button>
          )}
          <Toggle
            checked={a.enabled}
            onChange={(next) => actions.toggleCustomAgent(a.id, next)}
            label={a.enabled ? `Disable ${a.name}` : `Enable ${a.name}`}
          />
          <button
            type="button"
            className="icon-btn"
            onClick={() =>
              setDraft({
                kind: "agent",
                scope: a.scope,
                slug: a.slug,
                name: a.name,
                description: a.description,
                preferredMode: a.preferredMode ?? "",
                instructions: a.instructions,
              })
            }
            title="Edit agent"
            aria-label={`Edit ${a.name}`}
          >
            <EditIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => actions.openCustomizationFile(a.filePath)}
            title="Open .agent.md in editor"
            aria-label={`Open file for ${a.name}`}
          >
            <FileCodeIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => actions.deleteCustomAgent(a.id)}
            title="Delete agent"
            aria-label={`Delete ${a.name}`}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    );
  };

  const renderScopeGroup = (
    scope: CustomizationScope,
    label: string,
    open: boolean,
    setOpen: (fn: (v: boolean) => boolean) => void,
    count: number,
    itemsNode: ReactNode
  ) => (
    <div className={`custom-group${open ? " open" : ""}`}>
      <div className="custom-group-head">
        <button
          type="button"
          className="custom-group-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="custom-group-chevron">
            <ChevronRightIcon />
          </span>
          <span className="custom-group-label">{label}</span>
          <HelpTip
            text={
              scope === "user"
                ? "Saved in your user profile (~/.photon) and shared across all your projects."
                : "Saved inside this project folder (.photon or .vscode) for this workspace."
            }
          />
          <span className="custom-count-pill">{count}</span>
        </button>
        <div className="custom-group-actions">
          {section === "mcp" && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => actions.openMcpConfig(scope)}
              title={`Open ${label} mcp.json`}
              aria-label={`Open ${label} mcp.json`}
            >
              <FileCodeIcon />
            </button>
          )}
          <button
            type="button"
            className="icon-btn custom-add-btn"
            onClick={() => openCreateForm(scope)}
            title={`Add ${label} ${section === "mcp" ? "MCP server" : section.slice(0, -1)}`}
            aria-label={`Add ${label} ${section}`}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      {open && (
        <div className="custom-group-body">
          {count === 0 ? (
            <div className="custom-empty-hint">
              No {label.toLowerCase()} {meta.label.toLowerCase()} yet. Click <strong>+</strong> to add one.
            </div>
          ) : (
            itemsNode
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="custom-shell">
      <nav className="custom-nav" aria-label="Customization categories">
        {(Object.keys(SECTION_META) as CustomizationSection[]).map((key) => {
          const item = SECTION_META[key];
          const active = section === key;
          return (
            <button
              key={key}
              type="button"
              className={`custom-nav-item${active ? " active" : ""}`}
              onClick={() => switchSection(key)}
            >
              <span className="custom-nav-left">
                <span className="custom-nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </span>
              {counts[key] > 0 && <span className="custom-nav-count">{counts[key]}</span>}
            </button>
          );
        })}
      </nav>

      <div className="custom-pane">
        <div className="custom-pane-head">
          <div className="settings-row-label">
            <h3 className="custom-pane-title">{meta.title}</h3>
            <HelpTip text={meta.subtitle} />
          </div>
          <button
            type="button"
            className="btn btn-sm primary"
            onClick={() => openCreateForm("workspace")}
          >
            + New
          </button>
        </div>

        <div className="custom-search-wrap">
          <span className="custom-search-icon" aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            type="search"
            className="custom-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={meta.searchPlaceholder}
            aria-label={meta.searchPlaceholder}
          />
          {query && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {draft && (
          <div className="custom-form" role="region" aria-label="Customization editor">
            <div className="custom-form-head">
              <span className="custom-form-title">
                {draft.kind === "mcp"
                  ? `Connect MCP Server (${draft.scope})`
                  : draft.kind === "skill"
                    ? `${draft.slug ? "Edit" : "Create"} Skill (${draft.scope})`
                    : draft.kind === "instructions"
                      ? `${draft.slug ? "Edit" : "Create"} Instruction (${draft.scope})`
                      : `${draft.slug ? "Edit" : "Create"} Custom Agent (${draft.scope})`}
              </span>
              <div className="custom-scope-switch" role="group" aria-label="Customization scope">
                {(["user", "workspace"] as CustomizationScope[]).map((sc) => (
                  <button
                    key={sc}
                    type="button"
                    aria-pressed={draft.scope === sc}
                    className={`custom-scope-btn${draft.scope === sc ? " active" : ""}`}
                    onClick={() => setDraft({ ...draft, scope: sc })}
                  >
                    {sc === "user" ? "User" : "Workspace"}
                  </button>
                ))}
              </div>
            </div>

            {draft.kind === "mcp" && (
              <>
                <div className="custom-form-grid">
                  <label className="custom-field">
                    <span>Server Name</span>
                    <input
                      type="text"
                      value={mcpId}
                      onChange={(e) => setMcpId(e.target.value)}
                      placeholder="e.g. filesystem, github, postgres"
                    />
                  </label>
                  <label className="custom-field">
                    <span>Transport</span>
                    <select
                      value={mcpTransport}
                      onChange={(e) => setMcpTransport(e.target.value as "stdio" | "http")}
                    >
                      <option value="stdio">stdio (local command)</option>
                      <option value="http">http / sse (remote URL)</option>
                    </select>
                  </label>
                </div>
                {mcpTransport === "stdio" ? (
                  <>
                    <div className="custom-form-grid">
                      <label className="custom-field">
                        <span>Command</span>
                        <input
                          type="text"
                          value={mcpCommand}
                          onChange={(e) => setMcpCommand(e.target.value)}
                          placeholder="npx, uvx, node, python"
                        />
                      </label>
                      <label className="custom-field">
                        <span>Arguments</span>
                        <input
                          type="text"
                          value={mcpArgs}
                          onChange={(e) => setMcpArgs(e.target.value)}
                          placeholder="-y @modelcontextprotocol/server-filesystem ."
                        />
                      </label>
                    </div>
                    <label className="custom-field">
                      <span>Environment Variables (optional, KEY=value per line)</span>
                      <textarea
                        rows={2}
                        value={mcpEnvRaw}
                        onChange={(e) => setMcpEnvRaw(e.target.value)}
                        placeholder="GITHUB_TOKEN=..."
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="custom-field">
                      <span>Endpoint URL</span>
                      <input
                        type="url"
                        value={mcpUrl}
                        onChange={(e) => setMcpUrl(e.target.value)}
                        placeholder="https://example.com/mcp"
                      />
                    </label>
                    <label className="custom-field">
                      <span>Headers (optional, Header: value per line)</span>
                      <textarea
                        rows={2}
                        value={mcpHeadersRaw}
                        onChange={(e) => setMcpHeadersRaw(e.target.value)}
                        placeholder="Authorization: Bearer ..."
                      />
                    </label>
                  </>
                )}
                <label className="custom-check-row">
                  <input
                    type="checkbox"
                    checked={mcpConnectNow}
                    onChange={(e) => setMcpConnectNow(e.target.checked)}
                  />
                  <span>Approve and connect immediately</span>
                </label>
              </>
            )}

            {draft.kind === "skill" && (
              <>
                <div className="custom-form-grid">
                  <label className="custom-field">
                    <span>Skill Name</span>
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="e.g. Security Audit, React Refactor"
                    />
                  </label>
                  <label className="custom-field">
                    <span>Short Description</span>
                    <input
                      type="text"
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      placeholder="When Photon should invoke this skill"
                    />
                  </label>
                </div>
                <label className="custom-field">
                  <span>Skill Instructions (SKILL.md body)</span>
                  <textarea
                    rows={5}
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                    placeholder="Step-by-step instructions, checks, and constraints for this skill..."
                  />
                </label>
              </>
            )}

            {draft.kind === "instructions" && (
              <>
                <div className="custom-form-grid">
                  <label className="custom-field">
                    <span>Instruction Name</span>
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="e.g. TypeScript Style, Testing Rules"
                    />
                  </label>
                  <label className="custom-field">
                    <span>Apply To (optional glob)</span>
                    <input
                      type="text"
                      value={draft.applyTo}
                      onChange={(e) => setDraft({ ...draft, applyTo: e.target.value })}
                      placeholder="e.g. **/*.ts, src/** (leave blank for all)"
                    />
                  </label>
                </div>
                <label className="custom-field">
                  <span>Rules &amp; Guidelines</span>
                  <textarea
                    rows={5}
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                    placeholder="- Prefer strict TypeScript types...\n- Always run unit tests after edits..."
                  />
                </label>
              </>
            )}

            {draft.kind === "agent" && (
              <>
                <div className="custom-form-grid">
                  <label className="custom-field">
                    <span>Agent Name</span>
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="e.g. Code Reviewer, Architect, Ask"
                    />
                  </label>
                  <label className="custom-field">
                    <span>Preferred Mode</span>
                    <select
                      value={draft.preferredMode}
                      onChange={(e) => setDraft({ ...draft, preferredMode: e.target.value as "" | Mode })}
                    >
                      <option value="">Keep current mode</option>
                      <option value="chat">Chat (Read-only)</option>
                      <option value="plan">Plan (Interactive planning)</option>
                      <option value="agent">Agent (Full autonomy)</option>
                    </select>
                  </label>
                </div>
                <label className="custom-field">
                  <span>Description</span>
                  <input
                    type="text"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="What this custom agent specializes in"
                  />
                </label>
                <label className="custom-field">
                  <span>Persona &amp; System Instructions</span>
                  <textarea
                    rows={5}
                    value={draft.instructions}
                    onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                    placeholder="Define the agent's persona, workflow, tone, and constraints..."
                  />
                </label>
              </>
            )}

            {formError && <div className="custom-form-error" role="alert">{formError}</div>}

            <div className="custom-form-foot">
              <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-sm primary" onClick={submitDraft}>
                {draft.kind === "mcp" ? "Save Server" : "Save"}
              </button>
            </div>
          </div>
        )}

        <div className="custom-groups">
          {section === "mcp" && (
            <>
              {renderScopeGroup(
                "user",
                "User",
                userOpen,
                setUserOpen,
                mcpByScope.user.length,
                <div className="custom-list">{mcpByScope.user.map(renderMcpRow)}</div>
              )}
              {renderScopeGroup(
                "workspace",
                "Workspace",
                workspaceOpen,
                setWorkspaceOpen,
                mcpByScope.workspace.length,
                <div className="custom-list">{mcpByScope.workspace.map(renderMcpRow)}</div>
              )}
            </>
          )}

          {section === "skills" && (
            <>
              {renderScopeGroup(
                "user",
                "User",
                userOpen,
                setUserOpen,
                skillsByScope.user.length,
                <div className="custom-list">{skillsByScope.user.map(renderSkillRow)}</div>
              )}
              {renderScopeGroup(
                "workspace",
                "Workspace",
                workspaceOpen,
                setWorkspaceOpen,
                skillsByScope.workspace.length,
                <div className="custom-list">{skillsByScope.workspace.map(renderSkillRow)}</div>
              )}
            </>
          )}

          {section === "instructions" && (
            <>
              {renderScopeGroup(
                "user",
                "User",
                userOpen,
                setUserOpen,
                instructionsByScope.user.length,
                <div className="custom-list">{instructionsByScope.user.map(renderInstructionRow)}</div>
              )}
              {renderScopeGroup(
                "workspace",
                "Workspace",
                workspaceOpen,
                setWorkspaceOpen,
                instructionsByScope.workspace.length,
                <div className="custom-list">{instructionsByScope.workspace.map(renderInstructionRow)}</div>
              )}
            </>
          )}

          {section === "agents" && (
            <>
              {renderScopeGroup(
                "user",
                "User",
                userOpen,
                setUserOpen,
                agentsByScope.user.length,
                <div className="custom-list">{agentsByScope.user.map(renderAgentRow)}</div>
              )}
              {renderScopeGroup(
                "workspace",
                "Workspace",
                workspaceOpen,
                setWorkspaceOpen,
                agentsByScope.workspace.length,
                <div className="custom-list">{agentsByScope.workspace.map(renderAgentRow)}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
