import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CustomAgentInfo,
  CustomizationScope,
  CustomizationsSnapshot,
  InstructionInfo,
  Mode,
  SkillInfo,
} from "../shared/types";

export interface CustomizationsStoreDeps {
  getWorkspaceRoot: () => string | undefined;
  getUserRoot?: () => string;
  getDisabledIds: () => string[];
  setDisabledIds: (ids: string[]) => Promise<void>;
  getActiveAgentId: () => string | null;
  setActiveAgentId: (id: string | null) => Promise<void>;
}

export interface SaveSkillInput {
  scope: CustomizationScope;
  slug?: string;
  name: string;
  description: string;
  content: string;
}

export interface SaveInstructionInput {
  scope: CustomizationScope;
  slug?: string;
  name: string;
  applyTo?: string;
  description?: string;
  content: string;
}

export interface SaveCustomAgentInput {
  scope: CustomizationScope;
  slug?: string;
  name: string;
  description: string;
  instructions: string;
  preferredMode?: Mode;
}

export function slugifyCustomizationName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "custom-item";
}

export interface ParsedFrontmatter {
  meta: Record<string, string>;
  body: string;
}

export function parseMarkdownFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { meta: {}, body: normalized.trim() };
  }
  const endIdx = normalized.indexOf("\n---", 4);
  if (endIdx === -1) {
    return { meta: {}, body: normalized.trim() };
  }
  const headerBlock = normalized.slice(4, endIdx);
  let afterFence = normalized.slice(endIdx + 4);
  if (afterFence.startsWith("\n")) afterFence = afterFence.slice(1);

  const meta: Record<string, string> = {};
  for (const line of headerBlock.split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body: afterFence.trim() };
}

function yamlScalar(value: string): string {
  const singleLine = value.replace(/\r?\n/g, " ").trim();
  if (/[:#"'{}[\],&*?|<>!%@`\\]/.test(singleLine) || singleLine === "") {
    return JSON.stringify(singleLine);
  }
  return singleLine;
}

export function serializeMarkdownFrontmatter(
  meta: Record<string, string | undefined>,
  body: string
): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined && v.trim() !== "") {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function listDirSafe(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isInsideDir(targetPath: string, parentDir: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedParent = path.resolve(parentDir);
  const rel = path.relative(resolvedParent, resolvedTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Discovers, persists, toggles, and renders User & Workspace Skills (`SKILL.md`),
 * Instructions (`*.instructions.md` / `AGENTS.md`), and Custom Agents (`*.agent.md`).
 */
export class CustomizationsStore {
  constructor(private readonly deps: CustomizationsStoreDeps) {}

  userRoot(): string {
    return this.deps.getUserRoot?.() ?? path.join(os.homedir(), ".photon");
  }

  workspaceRoot(): string | undefined {
    return this.deps.getWorkspaceRoot();
  }

  private writableRoot(scope: CustomizationScope): string {
    if (scope === "user") return this.userRoot();
    const ws = this.workspaceRoot();
    if (!ws) {
      throw new Error("Open a workspace folder first to save workspace customizations.");
    }
    return path.join(ws, ".photon");
  }

  isAllowedPath(filePath: string): boolean {
    if (!filePath) return false;
    const resolved = path.resolve(filePath);
    const uRoot = this.userRoot();
    if (isInsideDir(resolved, uRoot)) return true;

    const ws = this.workspaceRoot();
    if (ws) {
      for (const rel of [".photon", ".github", ".vscode"]) {
        if (isInsideDir(resolved, path.join(ws, rel))) return true;
      }
      if (resolved === path.resolve(ws, "AGENTS.md")) return true;
    }
    return false;
  }

  private formatRelPath(filePath: string, scope: CustomizationScope): string {
    if (scope === "workspace") {
      const ws = this.workspaceRoot();
      if (ws) {
        return path.relative(ws, filePath).replace(/\\/g, "/");
      }
    } else {
      const uRoot = this.userRoot();
      if (isInsideDir(filePath, uRoot)) {
        return `~/.photon/${path.relative(uRoot, filePath).replace(/\\/g, "/")}`;
      }
    }
    return filePath.replace(/\\/g, "/");
  }

  private scanSkillsInDir(
    skillsDir: string,
    scope: CustomizationScope,
    sourceTag: string,
    disabled: Set<string>,
    out: SkillInfo[]
  ): void {
    for (const entry of listDirSafe(skillsDir)) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
      const raw = readTextSafe(skillFile);
      if (raw === null) continue;
      const { meta, body } = parseMarkdownFrontmatter(raw);
      const slug = slugifyCustomizationName(entry.name);
      const id = `${scope}:skill:${sourceTag}:${slug}`;
      out.push({
        id,
        slug,
        name: meta.name || entry.name,
        description: meta.description || body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 140) || "",
        content: body,
        scope,
        filePath: skillFile,
        relPath: this.formatRelPath(skillFile, scope),
        enabled: !disabled.has(id),
      });
    }
  }

  private scanInstructionsInDir(
    dirPath: string,
    scope: CustomizationScope,
    sourceTag: string,
    disabled: Set<string>,
    out: InstructionInfo[]
  ): void {
    for (const entry of listDirSafe(dirPath)) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = path.join(dirPath, entry.name);
      const raw = readTextSafe(filePath);
      if (raw === null) continue;
      const { meta, body } = parseMarkdownFrontmatter(raw);
      const baseSlug = entry.name.replace(/\.instructions\.md$/i, "").replace(/\.md$/i, "");
      const slug = slugifyCustomizationName(baseSlug);
      const id = `${scope}:instruction:${sourceTag}:${slug}`;
      out.push({
        id,
        slug,
        name: meta.name || baseSlug,
        description: meta.description,
        applyTo: meta.applyTo,
        content: body,
        scope,
        filePath,
        relPath: this.formatRelPath(filePath, scope),
        enabled: !disabled.has(id),
      });
    }
  }

  private scanAgentsInDir(
    dirPath: string,
    scope: CustomizationScope,
    sourceTag: string,
    disabled: Set<string>,
    out: CustomAgentInfo[]
  ): void {
    for (const entry of listDirSafe(dirPath)) {
      if (!entry.isFile() || (!entry.name.endsWith(".agent.md") && !entry.name.endsWith(".md"))) continue;
      const filePath = path.join(dirPath, entry.name);
      const raw = readTextSafe(filePath);
      if (raw === null) continue;
      const { meta, body } = parseMarkdownFrontmatter(raw);
      const baseSlug = entry.name.replace(/\.agent\.md$/i, "").replace(/\.md$/i, "");
      const slug = slugifyCustomizationName(baseSlug);
      const modeRaw = meta.mode?.toLowerCase();
      const preferredMode: Mode | undefined =
        modeRaw === "chat" || modeRaw === "plan" || modeRaw === "agent" ? modeRaw : undefined;
      const id = `${scope}:agent:${sourceTag}:${slug}`;
      out.push({
        id,
        slug,
        name: meta.name || baseSlug,
        description: meta.description || body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 140) || "",
        instructions: body,
        preferredMode,
        scope,
        filePath,
        relPath: this.formatRelPath(filePath, scope),
        enabled: !disabled.has(id),
      });
    }
  }

  getSnapshot(): CustomizationsSnapshot {
    const disabled = new Set(this.deps.getDisabledIds());
    const skills: SkillInfo[] = [];
    const instructions: InstructionInfo[] = [];
    const agents: CustomAgentInfo[] = [];

    // User root (~/.photon)
    const uRoot = this.userRoot();
    this.scanSkillsInDir(path.join(uRoot, "skills"), "user", "photon", disabled, skills);
    this.scanInstructionsInDir(path.join(uRoot, "instructions"), "user", "photon", disabled, instructions);
    this.scanInstructionsInDir(path.join(uRoot, "rules"), "user", "photon-rules", disabled, instructions);
    this.scanAgentsInDir(path.join(uRoot, "agents"), "user", "photon", disabled, agents);

    // Workspace root (.photon + .github conventions + root AGENTS.md)
    const ws = this.workspaceRoot();
    if (ws) {
      this.scanSkillsInDir(path.join(ws, ".photon", "skills"), "workspace", "photon", disabled, skills);
      this.scanSkillsInDir(path.join(ws, ".github", "skills"), "workspace", "github", disabled, skills);

      this.scanInstructionsInDir(path.join(ws, ".photon", "instructions"), "workspace", "photon", disabled, instructions);
      this.scanInstructionsInDir(path.join(ws, ".github", "instructions"), "workspace", "github", disabled, instructions);

      const copilotInst = path.join(ws, ".github", "copilot-instructions.md");
      const copilotRaw = readTextSafe(copilotInst);
      if (copilotRaw !== null) {
        const { meta, body } = parseMarkdownFrontmatter(copilotRaw);
        const id = "workspace:instruction:github:copilot-instructions";
        instructions.push({
          id,
          slug: "copilot-instructions",
          name: meta.name || "copilot-instructions",
          description: meta.description || "Repository-wide instructions (.github/copilot-instructions.md)",
          applyTo: meta.applyTo,
          content: body,
          scope: "workspace",
          filePath: copilotInst,
          relPath: ".github/copilot-instructions.md",
          enabled: !disabled.has(id),
        });
      }

      const agentsMd = path.join(ws, "AGENTS.md");
      const agentsMdRaw = readTextSafe(agentsMd);
      if (agentsMdRaw !== null) {
        const { meta, body } = parseMarkdownFrontmatter(agentsMdRaw);
        const id = "workspace:instruction:root:agents-md";
        instructions.push({
          id,
          slug: "agents-md",
          name: meta.name || "AGENTS.md",
          description: meta.description || "Repository agent guidelines (AGENTS.md)",
          applyTo: meta.applyTo,
          content: body,
          scope: "workspace",
          filePath: agentsMd,
          relPath: "AGENTS.md",
          enabled: !disabled.has(id),
        });
      }

      this.scanAgentsInDir(path.join(ws, ".photon", "agents"), "workspace", "photon", disabled, agents);
      this.scanAgentsInDir(path.join(ws, ".github", "agents"), "workspace", "github", disabled, agents);
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    instructions.sort((a, b) => a.name.localeCompare(b.name));
    agents.sort((a, b) => a.name.localeCompare(b.name));

    const currentActiveId = this.deps.getActiveAgentId();
    const activeValid =
      currentActiveId && agents.some((a) => a.id === currentActiveId && a.enabled)
        ? currentActiveId
        : null;

    return {
      skills,
      instructions,
      agents,
      activeAgentId: activeValid,
    };
  }

  saveSkill(input: SaveSkillInput): SkillInfo {
    const root = this.writableRoot(input.scope);
    const slug = slugifyCustomizationName(input.slug || input.name);
    const dirPath = path.join(root, "skills", slug);
    const filePath = path.join(dirPath, "SKILL.md");
    fs.mkdirSync(dirPath, { recursive: true });
    const md = serializeMarkdownFrontmatter(
      {
        name: input.name.trim() || slug,
        description: input.description.trim() || undefined,
      },
      input.content
    );
    fs.writeFileSync(filePath, md, "utf8");
    const snap = this.getSnapshot();
    return (
      snap.skills.find((s) => path.resolve(s.filePath) === path.resolve(filePath)) ?? {
        id: `${input.scope}:skill:photon:${slug}`,
        slug,
        name: input.name.trim() || slug,
        description: input.description.trim(),
        content: input.content.trim(),
        scope: input.scope,
        filePath,
        relPath: this.formatRelPath(filePath, input.scope),
        enabled: true,
      }
    );
  }

  saveInstruction(input: SaveInstructionInput): InstructionInfo {
    const root = this.writableRoot(input.scope);
    const slug = slugifyCustomizationName(input.slug || input.name);
    const dirPath = path.join(root, "instructions");
    const filePath = path.join(dirPath, `${slug}.instructions.md`);
    fs.mkdirSync(dirPath, { recursive: true });
    const md = serializeMarkdownFrontmatter(
      {
        name: input.name.trim() || slug,
        description: input.description?.trim() || undefined,
        applyTo: input.applyTo?.trim() || undefined,
      },
      input.content
    );
    fs.writeFileSync(filePath, md, "utf8");
    const snap = this.getSnapshot();
    return (
      snap.instructions.find((i) => path.resolve(i.filePath) === path.resolve(filePath)) ?? {
        id: `${input.scope}:instruction:photon:${slug}`,
        slug,
        name: input.name.trim() || slug,
        description: input.description?.trim(),
        applyTo: input.applyTo?.trim(),
        content: input.content.trim(),
        scope: input.scope,
        filePath,
        relPath: this.formatRelPath(filePath, input.scope),
        enabled: true,
      }
    );
  }

  saveCustomAgent(input: SaveCustomAgentInput): CustomAgentInfo {
    const root = this.writableRoot(input.scope);
    const slug = slugifyCustomizationName(input.slug || input.name);
    const dirPath = path.join(root, "agents");
    const filePath = path.join(dirPath, `${slug}.agent.md`);
    fs.mkdirSync(dirPath, { recursive: true });
    const md = serializeMarkdownFrontmatter(
      {
        name: input.name.trim() || slug,
        description: input.description.trim() || undefined,
        mode: input.preferredMode,
      },
      input.instructions
    );
    fs.writeFileSync(filePath, md, "utf8");
    const snap = this.getSnapshot();
    return (
      snap.agents.find((a) => path.resolve(a.filePath) === path.resolve(filePath)) ?? {
        id: `${input.scope}:agent:photon:${slug}`,
        slug,
        name: input.name.trim() || slug,
        description: input.description.trim(),
        instructions: input.instructions.trim(),
        preferredMode: input.preferredMode,
        scope: input.scope,
        filePath,
        relPath: this.formatRelPath(filePath, input.scope),
        enabled: true,
      }
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<CustomizationsSnapshot> {
    const disabled = new Set(this.deps.getDisabledIds());
    if (enabled) {
      disabled.delete(id);
    } else {
      disabled.add(id);
      if (this.deps.getActiveAgentId() === id) {
        await this.deps.setActiveAgentId(null);
      }
    }
    await this.deps.setDisabledIds([...disabled]);
    return this.getSnapshot();
  }

  async deleteById(id: string): Promise<CustomizationsSnapshot> {
    const snap = this.getSnapshot();
    const skill = snap.skills.find((s) => s.id === id);
    if (skill && this.isAllowedPath(skill.filePath)) {
      fs.rmSync(skill.filePath, { force: true });
      const parent = path.dirname(skill.filePath);
      if (listDirSafe(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    }
    const inst = snap.instructions.find((i) => i.id === id);
    if (inst && this.isAllowedPath(inst.filePath)) {
      fs.rmSync(inst.filePath, { force: true });
    }
    const agent = snap.agents.find((a) => a.id === id);
    if (agent && this.isAllowedPath(agent.filePath)) {
      fs.rmSync(agent.filePath, { force: true });
      if (this.deps.getActiveAgentId() === id) {
        await this.deps.setActiveAgentId(null);
      }
    }
    const disabled = new Set(this.deps.getDisabledIds());
    if (disabled.delete(id)) {
      await this.deps.setDisabledIds([...disabled]);
    }
    return this.getSnapshot();
  }

  async setActiveAgent(id: string | null): Promise<CustomizationsSnapshot> {
    await this.deps.setActiveAgentId(id);
    return this.getSnapshot();
  }
}

export type SlashCustomizationResolution =
  | { kind: "none" }
  | { kind: "agent_activate"; agent: CustomAgentInfo; remainingPrompt: string }
  | { kind: "agent_clear"; remainingPrompt: string }
  | { kind: "skill_invoke"; skill: SkillInfo; remainingPrompt: string };

/**
 * Resolve custom `/agent:<slug>`, `/agent:off`, `/skill:<slug>`, or `/<skill-slug>`
 * invocations typed into the prompt composer.
 */
export function resolveCustomSlashCommand(
  rawPrompt: string,
  snapshot: CustomizationsSnapshot
): SlashCustomizationResolution {
  const trimmed = rawPrompt.trim();
  if (!trimmed.startsWith("/")) return { kind: "none" };

  const spaceIdx = trimmed.search(/\s/);
  const token = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (token === "/agent:off" || token === "/clear-agent") {
    return { kind: "agent_clear", remainingPrompt: rest };
  }

  if (token.startsWith("/agent:")) {
    const slug = token.slice("/agent:".length);
    const agent = snapshot.agents.find(
      (a) => a.enabled && (a.slug.toLowerCase() === slug || a.name.toLowerCase() === slug)
    );
    if (agent) {
      return { kind: "agent_activate", agent, remainingPrompt: rest };
    }
  }

  if (token.startsWith("/skill:")) {
    const slug = token.slice("/skill:".length);
    const skill = snapshot.skills.find(
      (s) => s.enabled && (s.slug.toLowerCase() === slug || s.name.toLowerCase() === slug)
    );
    if (skill) {
      return { kind: "skill_invoke", skill, remainingPrompt: rest };
    }
  }

  // Shorthand `/<skill-slug>` (skip built-in UI/host commands)
  const bare = token.slice(1);
  if (
    bare &&
    !["compact", "rewind", "revert", "mcp", "skills", "agents", "instructions", "customizations"].includes(bare)
  ) {
    const skill = snapshot.skills.find((s) => s.enabled && s.slug.toLowerCase() === bare);
    if (skill) {
      return { kind: "skill_invoke", skill, remainingPrompt: rest };
    }
  }

  return { kind: "none" };
}

/**
 * Build the prompt block injected into Local & Cloud system prompts containing:
 *  - Active Custom Agent persona (if selected)
 *  - Enabled Custom Instructions
 *  - Explicitly invoked Skill body + concise catalog of enabled Skills
 */
export function buildCustomizationsPromptBlock(
  snapshot: CustomizationsSnapshot,
  opts?: { invokedSkillIds?: string[]; maxChars?: number }
): string | undefined {
  const sections: string[] = [];
  const invokedIds = new Set(opts?.invokedSkillIds ?? []);

  if (snapshot.activeAgentId) {
    const agent = snapshot.agents.find((a) => a.id === snapshot.activeAgentId && a.enabled);
    if (agent && agent.instructions.trim()) {
      sections.push(
        `# Active Custom Agent: ${agent.name}\nAdopt this persona and follow its instructions carefully:\n\n${agent.instructions.trim()}`
      );
    }
  }

  const enabledInstructions = snapshot.instructions.filter((i) => i.enabled && i.content.trim());
  if (enabledInstructions.length > 0) {
    const blocks = enabledInstructions.map((i) => {
      const scopeHint = i.applyTo ? ` (applies to: ${i.applyTo})` : "";
      return `## ${i.name}${scopeHint}\n${i.content.trim()}`;
    });
    sections.push(`# Custom Instructions\n${blocks.join("\n\n")}`);
  }

  const enabledSkills = snapshot.skills.filter((s) => s.enabled);
  const invokedSkills = enabledSkills.filter((s) => invokedIds.has(s.id));
  if (invokedSkills.length > 0) {
    for (const sk of invokedSkills) {
      sections.push(`# Invoked Skill: ${sk.name}\nFollow this skill workflow for the current request:\n\n${sk.content.trim()}`);
    }
  }

  const remainingSkills = enabledSkills.filter((s) => !invokedIds.has(s.id));
  if (remainingSkills.length > 0) {
    const summaryLines = remainingSkills.slice(0, 20).map((s) => {
      const desc = s.description ? `: ${s.description}` : "";
      return `- \`/${s.slug}\` (${s.name})${desc} [${s.relPath}]`;
    });
    sections.push(
      `# Available Skills\nWhen a user's task matches one of these skills, follow its workflow (you may read its SKILL.md if you need full details):\n${summaryLines.join("\n")}`
    );
  }

  if (sections.length === 0) return undefined;
  const joined = sections.join("\n\n");
  const maxChars = opts?.maxChars ?? 14_000;
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars) + "\n\n[... Customizations truncated to fit context budget ...]";
}
