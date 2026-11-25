import type { CustomizationsSnapshot } from "../../src/shared/types";
import { CUSTOMIZATIONS_ENABLED } from "../../src/shared/features";
import type { CustomizationSection } from "./components/CustomizationsTab";

export type SlashCategory = "customization" | "skill" | "agent" | "session";

export interface SlashItem {
  id: string;
  cmd: string;
  desc: string;
  badge?: string;
  category: SlashCategory;
  openSection?: CustomizationSection;
  skillSlug?: string;
  agentId?: string;
  clearAgent?: boolean;
}

const STATIC_SLASH_ITEMS: SlashItem[] = [
  {
    id: "cmd:mcp",
    cmd: "/mcp",
    desc: "Connect and manage MCP servers (User & Workspace)",
    badge: "Setup",
    category: "customization",
    openSection: "mcp",
  },
  {
    id: "cmd:skills",
    cmd: "/skills",
    desc: "Save, edit, and enable reusable Skills (SKILL.md)",
    badge: "Setup",
    category: "customization",
    openSection: "skills",
  },
  {
    id: "cmd:agents",
    cmd: "/agents",
    desc: "Create and switch Custom Agent personas (*.agent.md)",
    badge: "Setup",
    category: "customization",
    openSection: "agents",
  },
  {
    id: "cmd:instructions",
    cmd: "/instructions",
    desc: "Manage coding rules and custom instructions",
    badge: "Setup",
    category: "customization",
    openSection: "instructions",
  },
  {
    id: "cmd:customizations",
    cmd: "/customizations",
    desc: "Open Customizations (MCP Servers, Skills, Instructions, Agents)",
    badge: "Setup",
    category: "customization",
    openSection: "mcp",
  },
  {
    id: "cmd:revert",
    cmd: "/revert",
    desc: "Select a checkpoint (#1, #2, …) to restore files and rewind chat",
    category: "session",
  },
  {
    id: "cmd:rewind",
    cmd: "/rewind",
    desc: "Instantly rollback the most recent file changes and rewind chat",
    category: "session",
  },
  {
    id: "cmd:compact",
    cmd: "/compact",
    desc: "Compact conversation history to optimize context window",
    category: "session",
  },
];

export function buildSlashItems(
  customizations: CustomizationsSnapshot,
  includeCustomizations = CUSTOMIZATIONS_ENABLED
): SlashItem[] {
  if (!includeCustomizations) {
    return STATIC_SLASH_ITEMS.filter((item) => item.category !== "customization");
  }

  const dynamicSkills: SlashItem[] = customizations.skills
    .filter((s) => s.enabled)
    .map((s) => ({
      id: `skill:${s.id}`,
      cmd: `/${s.slug}`,
      desc: s.description || `Run ${s.name} skill workflow`,
      badge: "Skill",
      category: "skill",
      skillSlug: s.slug,
    }));

  const dynamicAgents: SlashItem[] = customizations.agents
    .filter((a) => a.enabled)
    .map((a) => ({
      id: `agent:${a.id}`,
      cmd: `/agent:${a.slug}`,
      desc:
        customizations.activeAgentId === a.id
          ? `Active · ${a.description || a.name}`
          : a.description || `Switch to ${a.name} custom agent`,
      badge: customizations.activeAgentId === a.id ? "Active Agent" : "Agent",
      category: "agent",
      agentId: a.id,
    }));

  const clearAgentItem: SlashItem[] = customizations.activeAgentId
    ? [
        {
          id: "agent:off",
          cmd: "/agent:off",
          desc: "Clear the currently active custom agent persona",
          badge: "Agent",
          category: "agent",
          clearAgent: true,
        },
      ]
    : [];

  return [...dynamicSkills, ...dynamicAgents, ...clearAgentItem, ...STATIC_SLASH_ITEMS];
}

export function filterSlashItems(
  rawText: string,
  customizations: CustomizationsSnapshot,
  includeCustomizations = CUSTOMIZATIONS_ENABLED
): SlashItem[] {
  const trimmed = rawText.trimStart();
  if (!trimmed.startsWith("/")) return [];
  // Close dropdown once user already has arguments after a command space (e.g. "/skill-name fix bug")
  if (/\s/.test(trimmed)) return [];

  const q = trimmed.toLowerCase();
  const all = buildSlashItems(customizations, includeCustomizations);
  if (q === "/") return all;

  const bare = q.slice(1);
  const prefixMatches: SlashItem[] = [];
  const subMatches: SlashItem[] = [];
  for (const item of all) {
    const cmdLower = item.cmd.toLowerCase();
    if (cmdLower.startsWith(q)) {
      prefixMatches.push(item);
    } else if (cmdLower.includes(bare) || item.desc.toLowerCase().includes(bare)) {
      subMatches.push(item);
    }
  }
  return [...prefixMatches, ...subMatches];
}
