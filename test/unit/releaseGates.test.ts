import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "../../src/host/sessionStore";
import { builtinTools } from "../../src/core/tools/builtin/index";
import { resolveInWorkspace } from "../../src/core/tools/paths";
import { buildSafeMcpEnv } from "../../src/core/tools/mcp/mcpStdioClient";

describe("Phase 11 & 12: Packaging, Documentation Truth & Final Release Gates", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  describe("Gate A & B: Security, Privacy & Secret Redaction", () => {
    it("redacts credentials across all provider formats", () => {
      const sensitiveSample = [
        "Authorization: Bearer my-secret-jwt-token-value-1234567890",
        "OpenAI: sk-proj-1234567890abcdef1234567890",
        "Claude: sk-ant-api03-abcdef12345678901234567890",
        "Gemini: AIzaSyD-1234567890abcdef1234567890123456",
        "GitHub: ghp_1234567890abcdef1234567890abcdef12",
        "AWS: AKIAIOSFODNN7EXAMPLE",
        "api_key: secret-password-key-value-9999",
      ].join("\n");

      const redacted = redactSecrets(sensitiveSample);

      assert.ok(!redacted.includes("my-secret-jwt-token-value-1234567890"));
      assert.ok(!redacted.includes("sk-proj-1234567890abcdef1234567890"));
      assert.ok(!redacted.includes("sk-ant-api03-abcdef12345678901234567890"));
      assert.ok(!redacted.includes("AIzaSyD-1234567890abcdef1234567890123456"));
      assert.ok(!redacted.includes("ghp_1234567890abcdef1234567890abcdef12"));
      assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"));
      assert.ok(!redacted.includes("secret-password-key-value-9999"));
      assert.ok(redacted.includes("Bearer [REDACTED]"));
      assert.ok(redacted.includes("[REDACTED_SECRET]"));
    });

    it("verifies strict MCP process environment isolation", () => {
      const dirtyHostEnv: Record<string, string> = {
        PATH: "C:\\Windows;C:\\Program Files",
        SYSTEMROOT: "C:\\Windows",
        OPENAI_API_KEY: "sk-secret-leak-test",
        ANTHROPIC_API_KEY: "sk-ant-secret-leak-test",
        AWS_SECRET_ACCESS_KEY: "supersecretaws",
        GITHUB_TOKEN: "ghp_secrettoken",
        MY_CUSTOM_VAR: "custom_value",
      };

      const safeEnv = buildSafeMcpEnv(dirtyHostEnv, { APPROVED_MCP_KEY: "permitted" });

      // Permitted standard system variables
      assert.equal(safeEnv.PATH, "C:\\Windows;C:\\Program Files");
      assert.equal(safeEnv.SYSTEMROOT, "C:\\Windows");
      assert.equal(safeEnv.APPROVED_MCP_KEY, "permitted");

      // Host secrets MUST NOT leak
      assert.equal(safeEnv.OPENAI_API_KEY, undefined);
      assert.equal(safeEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(safeEnv.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(safeEnv.GITHUB_TOKEN, undefined);
      assert.equal(safeEnv.MY_CUSTOM_VAR, undefined);
    });

    it("verifies workspace filesystem containment enforcement", () => {
      const workspaceRoot = path.join(repoRoot, "test-fixtures-jail");
      if (!fs.existsSync(workspaceRoot)) fs.mkdirSync(workspaceRoot, { recursive: true });

      try {
        // Legitimate workspace path
        const validRes = resolveInWorkspace(workspaceRoot, "src/index.ts");
        assert.ok("abs" in validRes, "Valid relative path should resolve to abs path");
        assert.ok(validRes.abs.startsWith(workspaceRoot));

        // Lexical path traversal attempt
        const escapeRes = resolveInWorkspace(workspaceRoot, "../../windows/system32/cmd.exe");
        assert.ok("error" in escapeRes, "Escaping path must return an error object");
        assert.ok(escapeRes.error.includes("outside the workspace"));
      } finally {
        if (fs.existsSync(workspaceRoot)) fs.rmdirSync(workspaceRoot);
      }
    });
  });

  describe("Gate C & D: Product Truth & Configuration Invariants", () => {
    it("ensures package.json configuration matches actual tools and defaults", () => {
      const pkgPath = path.join(repoRoot, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

      assert.equal(pkg.name, "photon");
      assert.equal(pkg.engines.vscode, "^1.90.0");
      assert.equal(pkg.main, "./dist/extension.js");

      const props = pkg.contributes.configuration.properties;
      assert.ok(props["photon.ollama.baseUrl"]);
      assert.equal(props["photon.ollama.baseUrl"].default, "http://localhost:11434");
      assert.equal(props["photon.ollama.keepAlive"].default, "-1");
      assert.equal(props["photon.adaptive.enabled"].default, true);
      assert.equal(props["photon.tools.autoApprove"].default, false);
      assert.equal(props["photon.index.enabled"].default, false);
    });

    it("ensures all documented built-in tools exist in the tool registry", () => {
      const documentedTools = [
        "read_file",
        "edit_file",
        "write_file",
        "append_file",
        "move_path",
        "list_dir",
        "find_files",
        "search_code",
        "code_outline",
        "run_command",
        "get_diagnostics",
        "web_search",
        "web_fetch",
        "todo_write",
        "think",
      ];

      const registeredTools = builtinTools().map((t) => t.spec.name);

      for (const tool of documentedTools) {
        assert.ok(
          registeredTools.includes(tool),
          `Expected documented tool '${tool}' to be registered in builtinTools()`
        );
      }
    });
  });

  describe("Gate E & F: Packaging, .vscodeignore & .gitignore Hygiene", () => {
    it("verifies .vscodeignore excludes tests, docs, build scripts and maps", () => {
      const vscodeIgnorePath = path.join(repoRoot, ".vscodeignore");
      assert.ok(fs.existsSync(vscodeIgnorePath), ".vscodeignore must exist");

      const content = fs.readFileSync(vscodeIgnorePath, "utf-8");

      assert.ok(content.includes("src/**"), "Must ignore src/**");
      assert.ok(content.includes("test/**"), "Must ignore test/**");
      assert.ok(content.includes("esbuild.mjs"), "Must ignore esbuild.mjs");
      assert.ok(content.includes("vite.config.ts"), "Must ignore vite.config.ts");
      assert.ok(content.includes(".github/**"), "Must ignore .github/**");
      assert.ok(content.includes("PHOTON_ENGINEERING_CLOSURE_PLAN.md"), "Must ignore internal plans");
    });

    it("verifies .gitignore preserves shareable configs while ignoring runtime caches", () => {
      const gitignorePath = path.join(repoRoot, ".gitignore");
      assert.ok(fs.existsSync(gitignorePath), ".gitignore must exist");

      const content = fs.readFileSync(gitignorePath, "utf-8");

      assert.ok(content.includes(".photon/*"), "Must ignore .photon/* generated runtime state");
      assert.ok(content.includes("!.photon/config.json"), "Must allow .photon/config.json");
      assert.ok(content.includes("!.photon/config.yaml"), "Must allow .photon/config.yaml");
      assert.ok(content.includes("!.photon/mcp.json"), "Must allow .photon/mcp.json");
      assert.ok(content.includes("*.vsix"), "Must ignore packaged *.vsix files");
    });

    it("verifies CI workflow defines multi-OS matrix and security audit", () => {
      const ciPath = path.join(repoRoot, ".github/workflows/ci.yml");
      assert.ok(fs.existsSync(ciPath), "ci.yml must exist");

      const content = fs.readFileSync(ciPath, "utf-8");

      assert.ok(content.includes("ubuntu-latest"));
      assert.ok(content.includes("windows-latest"));
      assert.ok(content.includes("macos-latest"));
      assert.ok(content.includes("npm run package"));
      assert.ok(content.includes("npm run typecheck"));
      assert.ok(content.includes("npm test"));
    });
  });
});
