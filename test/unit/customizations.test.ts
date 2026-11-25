import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  CustomizationsStore,
  buildCustomizationsPromptBlock,
  parseMarkdownFrontmatter,
  resolveCustomSlashCommand,
  serializeMarkdownFrontmatter,
} from "../../src/host/customizationsStore";
import { McpCoordinator } from "../../src/host/mcpCoordinator";
import { McpManager } from "../../src/core/tools/mcp/bridge";
import { ToolRegistry } from "../../src/core/tools/registry";
import { filterSlashItems } from "../../webview-ui/src/slashCommands";
import { initial, reducer } from "../../webview-ui/src/state/store";

describe("Customizations: MCP, Skills, Instructions, Agents & Slash Triggers", () => {
  let tmpDir: string;
  let userRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-custom-test-"));
    userRoot = path.join(tmpDir, "user-photon");
    workspaceRoot = path.join(tmpDir, "workspace");
    fs.mkdirSync(userRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses and serializes YAML frontmatter cleanly", () => {
    const raw = serializeMarkdownFrontmatter(
      { name: "Security: Audit", description: "Check auth & secrets", mode: "plan" },
      "# Steps\n1. Inspect inputs."
    );
    const parsed = parseMarkdownFrontmatter(raw);
    assert.equal(parsed.meta.name, "Security: Audit");
    assert.equal(parsed.meta.description, "Check auth & secrets");
    assert.equal(parsed.meta.mode, "plan");
    assert.equal(parsed.body, "# Steps\n1. Inspect inputs.");
  });

  it("discovers, saves, toggles, and deletes Skills, Instructions, and Agents across User and Workspace scopes", async () => {
    let disabled: string[] = [];
    let activeAgentId: string | null = null;

    const store = new CustomizationsStore({
      getWorkspaceRoot: () => workspaceRoot,
      getUserRoot: () => userRoot,
      getDisabledIds: () => disabled,
      setDisabledIds: async (ids) => {
        disabled = ids;
      },
      getActiveAgentId: () => activeAgentId,
      setActiveAgentId: async (id) => {
        activeAgentId = id;
      },
    });

    // Save a User skill & Workspace instruction + agent
    const skill = store.saveSkill({
      scope: "user",
      name: "React Refactor",
      description: "Clean component hooks",
      content: "Extract reusable hooks and minimize re-renders.",
    });
    const inst = store.saveInstruction({
      scope: "workspace",
      name: "Strict TypeScript",
      applyTo: "**/*.ts",
      content: "Never use any; prefer explicit return types.",
    });
    const agent = store.saveCustomAgent({
      scope: "workspace",
      name: "Reviewer",
      description: "Critical code review persona",
      preferredMode: "chat",
      instructions: "Review diff carefully for security and edge cases.",
    });

    // Also verify AGENTS.md convention discovery in workspace root
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Repo Rules\nRun tests before commit.\n", "utf8");

    const snap1 = store.getSnapshot();
    assert.equal(snap1.skills.length, 1);
    assert.equal(snap1.skills[0].slug, "react-refactor");
    assert.equal(snap1.skills[0].scope, "user");
    assert.equal(snap1.instructions.length, 2);
    assert.ok(snap1.instructions.some((i) => i.slug === "agents-md"));
    assert.equal(snap1.agents.length, 1);
    assert.equal(snap1.agents[0].preferredMode, "chat");

    // Activate agent then disable it -> activeAgentId automatically clears
    await store.setActiveAgent(agent.id);
    assert.equal(store.getSnapshot().activeAgentId, agent.id);
    const snapAfterDisable = await store.setEnabled(agent.id, false);
    assert.equal(snapAfterDisable.agents[0].enabled, false);
    assert.equal(snapAfterDisable.activeAgentId, null);

    // Re-enable agent, toggle skill off, verify prompt builder excludes disabled items
    await store.setEnabled(agent.id, true);
    await store.setActiveAgent(agent.id);
    await store.setEnabled(skill.id, false);

    const promptBlock = buildCustomizationsPromptBlock(store.getSnapshot());
    assert.ok(promptBlock);
    assert.match(promptBlock, /# Active Custom Agent: Reviewer/);
    assert.match(promptBlock, /# Custom Instructions/);
    assert.match(promptBlock, /Never use any/);
    assert.doesNotMatch(promptBlock, /React Refactor/);

    // Allowed path checks
    assert.equal(store.isAllowedPath(skill.filePath), true);
    assert.equal(store.isAllowedPath(path.join(tmpDir, "outside.txt")), false);

    // Delete skill cleans up file
    const snapAfterDelete = await store.deleteById(skill.id);
    assert.equal(snapAfterDelete.skills.length, 0);
    assert.equal(fs.existsSync(skill.filePath), false);
    assert.ok(inst.filePath);
  });

  it("resolves /<skill>, /agent:<slug>, and /agent:off and builds full prompt when skill invoked", async () => {
    const store = new CustomizationsStore({
      getWorkspaceRoot: () => workspaceRoot,
      getUserRoot: () => userRoot,
      getDisabledIds: () => [],
      setDisabledIds: async () => {},
      getActiveAgentId: () => null,
      setActiveAgentId: async () => {},
    });

    const skill = store.saveSkill({
      scope: "workspace",
      name: "Security Audit",
      description: "Audit workspace for secrets and auth bugs",
      content: "1. Check auth checks.\n2. Scan hardcoded secrets.",
    });
    const agent = store.saveCustomAgent({
      scope: "user",
      name: "Architect",
      description: "Systems design persona",
      preferredMode: "plan",
      instructions: "Think in boundaries and contracts.",
    });

    const snap = store.getSnapshot();

    const rSkill = resolveCustomSlashCommand("/security-audit check src/host", snap);
    assert.equal(rSkill.kind, "skill_invoke");
    if (rSkill.kind === "skill_invoke") {
      assert.equal(rSkill.skill.id, skill.id);
      assert.equal(rSkill.remainingPrompt, "check src/host");
    }

    const rAgent = resolveCustomSlashCommand("/agent:architect design auth", snap);
    assert.equal(rAgent.kind, "agent_activate");
    if (rAgent.kind === "agent_activate") {
      assert.equal(rAgent.agent.id, agent.id);
      assert.equal(rAgent.remainingPrompt, "design auth");
    }

    const rOff = resolveCustomSlashCommand("/agent:off", snap);
    assert.equal(rOff.kind, "agent_clear");

    // Full skill workflow is injected when skill ID is marked invoked
    const prompt = buildCustomizationsPromptBlock(snap, { invokedSkillIds: [skill.id] });
    assert.ok(prompt);
    assert.match(prompt, /# Invoked Skill: Security Audit/);
    assert.match(prompt, /Scan hardcoded secrets/);

    // Default slash filtering follows CUSTOMIZATIONS_ENABLED (currently hidden)
    const defaultSlash = filterSlashItems("/", snap);
    assert.equal(defaultSlash.some((s) => s.cmd === "/mcp" || s.cmd === "/skills"), false);

    // Webview slash dropdown filtering when customizations are enabled includes setup commands + skills + agents
    const allSlash = filterSlashItems("/", snap, true);
    assert.ok(allSlash.some((s) => s.cmd === "/mcp" && s.openSection === "mcp"));
    assert.ok(allSlash.some((s) => s.cmd === "/skills" && s.openSection === "skills"));
    assert.ok(allSlash.some((s) => s.cmd === "/agents" && s.openSection === "agents"));
    assert.ok(allSlash.some((s) => s.cmd === "/instructions" && s.openSection === "instructions"));
    assert.ok(allSlash.some((s) => s.cmd === "/security-audit" && s.category === "skill"));
    assert.ok(allSlash.some((s) => s.cmd === "/agent:architect" && s.category === "agent"));

    const filteredMcp = filterSlashItems("/mc", snap, true);
    assert.equal(filteredMcp[0].cmd, "/mcp");
  });

  it("manages User and Workspace MCP servers in McpCoordinator and updates webview store", async () => {
    const registry = new ToolRegistry();
    const mcpManager = new McpManager(registry, () => {});
    const posted: unknown[] = [];

    const fakeProjectStore = {
      approvedMcpFingerprints: () => ({}),
      isMcpConfigApproved: () => false,
      pruneStaleMcpApprovals: async () => {},
      approveMcpConfig: async () => {},
      revokeMcpConfig: async () => {},
    } as any;

    const coord = new McpCoordinator({
      mcpManager,
      projectStore: fakeProjectStore,
      getWorkspaceRoot: () => workspaceRoot,
      getUserRoot: () => userRoot,
      post: (msg) => posted.push(msg),
      pushTools: () => {},
      output: { appendLine: () => {} },
    });

    await coord.addServer({
      scope: "user",
      id: "user-fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    });
    await coord.addServer({
      scope: "workspace",
      id: "ws-docs",
      transport: "http",
      url: "https://mcp.example.com/sse",
    });

    const listed = mcpManager.list();
    assert.equal(listed.length, 2);
    assert.equal(listed.find((s) => s.id === "user-fs")?.scope, "user");
    assert.equal(listed.find((s) => s.id === "ws-docs")?.scope, "workspace");

    assert.equal(fs.existsSync(path.join(userRoot, "mcp.json")), true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, ".vscode", "mcp.json")), true);

    await coord.removeServer("user-fs", "user");
    assert.equal(mcpManager.list().length, 1);
    assert.equal(mcpManager.list()[0].id, "ws-docs");

    // Webview store reducer handles customizations updates cleanly
    const updatedState = reducer(initial, {
      type: "customizations",
      payload: {
        skills: [],
        instructions: [],
        agents: [],
        activeAgentId: "workspace:agent:photon:reviewer",
      },
    });
    assert.equal(updatedState.customizations.activeAgentId, "workspace:agent:photon:reviewer");
  });
});
