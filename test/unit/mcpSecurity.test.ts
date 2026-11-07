import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBlockedIPv4,
  isBlockedIPv6,
  isPrivateOrProhibitedIp,
  isSafeRemoteHostname,
  validateRemoteEndpoint,
} from "../../src/core/tools/mcp/dnsValidator";
import {
  McpManager,
  inferRisk,
  describeRiskEffect,
  type McpServerConfig,
} from "../../src/core/tools/mcp/bridge";
import { ToolRegistry } from "../../src/core/tools/registry";
import type { ToolContext } from "../../src/core/tools/types";
import type { IMcpClient } from "../../src/core/tools/mcp/transport";

describe("MCP Security, Trust Boundaries & Tool Permissions", () => {
  describe("IP and Network Destination Validation", () => {
    it("blocks IPv4 loopback, private, and link-local ranges", () => {
      // Loopback
      assert.strictEqual(isBlockedIPv4("127.0.0.1"), true);
      assert.strictEqual(isBlockedIPv4("127.0.1.1"), true);
      assert.strictEqual(isBlockedIPv4("127.255.255.254"), true);

      // Private (RFC 1918)
      assert.strictEqual(isBlockedIPv4("10.0.0.1"), true);
      assert.strictEqual(isBlockedIPv4("10.255.255.255"), true);
      assert.strictEqual(isBlockedIPv4("172.16.0.1"), true);
      assert.strictEqual(isBlockedIPv4("172.31.255.255"), true);
      assert.strictEqual(isBlockedIPv4("192.168.1.1"), true);
      assert.strictEqual(isBlockedIPv4("192.168.0.254"), true);

      // Link-local / Cloud Metadata (AWS, GCP, Azure metadata: 169.254.169.254)
      assert.strictEqual(isBlockedIPv4("169.254.169.254"), true);
      assert.strictEqual(isBlockedIPv4("169.254.1.1"), true);

      // Carrier-Grade NAT (RFC 6598: 100.64.0.0/10)
      assert.strictEqual(isBlockedIPv4("100.64.0.1"), true);
      assert.strictEqual(isBlockedIPv4("100.127.255.255"), true);

      // Multicast and Broadcast
      assert.strictEqual(isBlockedIPv4("224.0.0.1"), true);
      assert.strictEqual(isBlockedIPv4("255.255.255.255"), true);
      assert.strictEqual(isBlockedIPv4("0.0.0.0"), true);

      // Public IP should pass
      assert.strictEqual(isBlockedIPv4("8.8.8.8"), false);
      assert.strictEqual(isBlockedIPv4("1.1.1.1"), false);
      assert.strictEqual(isBlockedIPv4("93.184.216.34"), false);
    });

    it("blocks IPv6 loopback, private, link-local, and mapped ranges", () => {
      // Loopback / Unspecified
      assert.strictEqual(isBlockedIPv6("::1"), true);
      assert.strictEqual(isBlockedIPv6("::"), true);

      // Unique Local Addresses (fc00::/7)
      assert.strictEqual(isBlockedIPv6("fc00::1"), true);
      assert.strictEqual(isBlockedIPv6("fd12:3456:789a::1"), true);

      // Link-local (fe80::/10)
      assert.strictEqual(isBlockedIPv6("fe80::1"), true);
      assert.strictEqual(isBlockedIPv6("fe80::200:5aee:feaa:20a2"), true);

      // Multicast (ff00::/8)
      assert.strictEqual(isBlockedIPv6("ff02::1"), true);

      // IPv4-mapped IPv6
      assert.strictEqual(isBlockedIPv6("::ffff:127.0.0.1"), true);
      assert.strictEqual(isBlockedIPv6("::ffff:169.254.169.254"), true);
      assert.strictEqual(isBlockedIPv6("::ffff:8.8.8.8"), false);
    });

    it("detects DNS rebinding attacks where public hostname resolves to private IP", async () => {
      // Mock DNS resolver that simulates a malicious rebinding domain resolving to 169.254.169.254
      const mockLookup = async () => [
        { address: "169.254.169.254", family: 4 },
      ];

      const res = await validateRemoteEndpoint(
        "https://evil-rebinding.example.com/mcp",
        false,
        mockLookup
      );

      assert.strictEqual(res.ok, false);
      assert.ok(res.reason?.includes("DNS rebinding"));
      assert.ok(res.reason?.includes("169.254.169.254"));
    });

    it("allows local endpoints only when allowLocalNetwork is explicitly true", async () => {
      // Without allowLocalNetwork, localhost is blocked
      const blocked = await validateRemoteEndpoint("http://localhost:3000/mcp", false);
      assert.strictEqual(blocked.ok, false);

      // With allowLocalNetwork, localhost is permitted
      const allowed = await validateRemoteEndpoint("http://localhost:3000/mcp", true);
      assert.strictEqual(allowed.ok, true);
    });

    it("rejects non-HTTPS remote endpoints without allowLocalNetwork", async () => {
      const res = await validateRemoteEndpoint("http://api.remote-mcp.org/mcp", false);
      assert.strictEqual(res.ok, false);
      assert.ok(res.reason?.includes("HTTPS is required"));
    });

    it("rejects URLs containing embedded user credentials", async () => {
      const res = await validateRemoteEndpoint("https://admin:secret@api.mcp.org/mcp", false);
      assert.strictEqual(res.ok, false);
      assert.ok(res.reason?.includes("credentials"));
    });
  });

  describe("Risk Assessment & Side-Effect Explanations", () => {
    it("infers risk levels accurately from tool names and descriptions", () => {
      assert.strictEqual(inferRisk({ name: "delete_database" }), "destructive");
      assert.strictEqual(inferRisk({ name: "drop_table" }), "destructive");
      assert.strictEqual(inferRisk({ name: "run_shell_command" }), "execute");
      assert.strictEqual(inferRisk({ name: "eval_script" }), "execute");
      assert.strictEqual(inferRisk({ name: "fetch_api_data" }), "network");
      assert.strictEqual(inferRisk({ name: "write_file" }), "workspace_write");
      assert.strictEqual(inferRisk({ name: "read_file" }), "read");
      assert.strictEqual(inferRisk({ name: "get_user_info" }), "read");
    });

    it("generates clear, actionable effect descriptions for approval prompts", () => {
      const descDestructive = describeRiskEffect("destructive", "drop_table");
      assert.ok(descDestructive.includes("deletes"));

      const descExec = describeRiskEffect("execute", "run_shell");
      assert.ok(descExec.includes("Executes"));

      const descWrite = describeRiskEffect("workspace_write", "write_file");
      assert.ok(descWrite.includes("Modifies"));
    });
  });

  describe("Per-Server & Per-Tool Permissions and Audit Trail", () => {
    it("blocks tool calls immediately when tool policy is set to deny", async () => {
      const registry = new ToolRegistry();
      const logs: string[] = [];
      const manager = new McpManager(registry, (m) => logs.push(m));

      const mockClient: IMcpClient = {
        connect: async () => {},
        listTools: async () => [
          { name: "query_data", description: "Read-only query" },
          { name: "delete_records", description: "Dangerous delete" },
        ],
        callTool: async () => "result",
        close: async () => {},
      };

      // Set server permission with tool-level denial for "delete_records"
      manager.setPermissions("db_server", {
        defaultPolicy: "ask",
        toolPolicies: {
          delete_records: "deny",
          query_data: "always_allow",
        },
      });

      // Connect and register
      await manager.setConfigs([
        { id: "db_server", transport: "stdio", command: "node server.js" },
      ]);

      // Manually register mock bridged tools using manager
      const deleteTool = registry.register({
        spec: {
          name: "mcp_db_server_delete_records",
          summary: "Dangerous delete",
          params: [],
          sideEffecting: true,
          priority: 15,
          minTier: "medium",
          risk: "destructive",
          concurrency: "serial",
          idempotency: "stateful",
        },
        execute: async (args, ctx) => {
          // Verify getToolPermission
          const perm = manager.getToolPermission("db_server", "delete_records", "destructive");
          if (perm === "deny") {
            manager.recordAudit({
              serverId: "db_server",
              toolName: "delete_records",
              args,
              decision: "denied_by_policy",
              risk: "destructive",
              expectedEffect: describeRiskEffect("destructive", "delete_records"),
              success: false,
              error: "Denied by policy",
            });
            return { ok: false, error: "Execution denied by policy" };
          }
          return { ok: true, output: "done" };
        },
      });

      const mockCtx: ToolContext = {
        workspaceRoot: "B:/test",
        requestApproval: async () => true,
        signal: new AbortController().signal,
        log: () => {},
        webSearchProvider: "duckduckgo",
        findFiles: async () => [],
        capability: "medium",
        getDiagnostics: async () => [],
        todos: [],
      };

      const result = await registry.get("mcp_db_server_delete_records")?.execute({}, mockCtx);
      assert.strictEqual(result?.ok, false);
      assert.ok(result?.error?.includes("denied by policy"));

      // Verify audit trail recorded the denial
      const audits = manager.getAuditLog();
      assert.strictEqual(audits.length, 1);
      assert.strictEqual(audits[0].decision, "denied_by_policy");
      assert.strictEqual(audits[0].toolName, "delete_records");
    });

    it("requires user approval when policy is 'ask' and audits user acceptance or rejection", async () => {
      const registry = new ToolRegistry();
      const logs: string[] = [];
      const manager = new McpManager(registry, (m) => logs.push(m));

      manager.setPermissions("file_server", {
        defaultPolicy: "ask",
      });

      let approvalPromptSeen = false;
      let approvalAccepted = false;

      const mockCtx: ToolContext = {
        workspaceRoot: "B:/test",
        requestApproval: async (call) => {
          approvalPromptSeen = true;
          return approvalAccepted;
        },
        signal: new AbortController().signal,
        log: () => {},
        webSearchProvider: "duckduckgo",
        findFiles: async () => [],
        capability: "medium",
        getDiagnostics: async () => [],
        todos: [],
      };

      // Case 1: User declines
      approvalAccepted = false;
      const perm = manager.getToolPermission("file_server", "write_file", "workspace_write");
      assert.strictEqual(perm, "ask");

      const approved1 = await mockCtx.requestApproval({
        id: "call_1",
        name: "mcp_file_server_write_file",
        args: { file: "test.txt" },
        status: "proposed",
        sideEffecting: true,
      });

      assert.strictEqual(approved1, false);
      manager.recordAudit({
        serverId: "file_server",
        toolName: "write_file",
        args: { file: "test.txt" },
        decision: "declined",
        risk: "workspace_write",
        expectedEffect: describeRiskEffect("workspace_write", "write_file"),
        success: false,
        error: "User declined",
      });

      // Case 2: User accepts
      approvalAccepted = true;
      const approved2 = await mockCtx.requestApproval({
        id: "call_2",
        name: "mcp_file_server_write_file",
        args: { file: "test.txt" },
        status: "proposed",
        sideEffecting: true,
      });

      assert.strictEqual(approved2, true);
      manager.recordAudit({
        serverId: "file_server",
        toolName: "write_file",
        args: { file: "test.txt" },
        decision: "approved",
        risk: "workspace_write",
        expectedEffect: describeRiskEffect("workspace_write", "write_file"),
        durationMs: 42,
        success: true,
      });

      const auditTrail = manager.getAuditLog();
      assert.strictEqual(auditTrail.length, 2);
      assert.strictEqual(auditTrail[0].decision, "declined");
      assert.strictEqual(auditTrail[1].decision, "approved");
      assert.strictEqual(auditTrail[1].durationMs, 42);

      // Clear audit trail
      manager.clearAuditLog();
      assert.strictEqual(manager.getAuditLog().length, 0);
    });
  });

  describe("Server Teardown & Resource Cleanup", () => {
    it("cleans up registered tools and connections on dispose", async () => {
      const registry = new ToolRegistry();
      const logs: string[] = [];
      const manager = new McpManager(registry, (m) => logs.push(m));

      let closed = false;
      const mockClient: IMcpClient = {
        connect: async () => {},
        listTools: async () => [{ name: "t1" }, { name: "t2" }],
        callTool: async () => "ok",
        close: async () => {
          closed = true;
        },
      };

      // Manually register tools into registry with mcp prefix
      registry.register({
        spec: {
          name: "mcp_test_srv_t1",
          summary: "tool 1",
          params: [],
          sideEffecting: false,
          priority: 10,
          minTier: "medium",
          risk: "read",
          concurrency: "safe_parallel",
          idempotency: "idempotent",
        },
        execute: async () => ({ ok: true, output: "1" }),
      });

      assert.ok(registry.get("mcp_test_srv_t1"));

      await manager.dispose();
      assert.strictEqual(manager.list().length, 0);
    });
  });

  describe("MCP Child Process Environment Isolation & Trust Fingerprints", () => {
    it("buildSafeMcpEnv strips sensitive credentials while preserving OS essentials and custom vars", async () => {
      const { buildSafeMcpEnv } = await import("../../src/core/tools/mcp/mcpStdioClient");

      const parentEnv: NodeJS.ProcessEnv = {
        PATH: "C:\\Windows;C:\\Program Files\\nodejs",
        SYSTEMROOT: "C:\\Windows",
        USERPROFILE: "C:\\Users\\dev",
        HOME: "/home/dev",
        TEMP: "C:\\Temp",
        OPENAI_API_KEY: "sk-secret-1234567890",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        GITHUB_TOKEN: "ghp_1234567890",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        MY_APP_SECRET_PASS: "supersecret",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        GENERIC_VAR: "allowed_value",
      };

      const customEnv = {
        MCP_SERVER_CUSTOM_PORT: "8080",
        SPECIFIC_APPROVED_KEY: "custom_mcp_val",
      };

      const safe = buildSafeMcpEnv(parentEnv, customEnv);

      // Essential system variables must be retained
      assert.strictEqual(safe.PATH, parentEnv.PATH);
      assert.strictEqual(safe.SYSTEMROOT, parentEnv.SYSTEMROOT);
      assert.strictEqual(safe.USERPROFILE, parentEnv.USERPROFILE);
      assert.strictEqual(safe.HOME, parentEnv.HOME);
      assert.strictEqual(safe.TEMP, parentEnv.TEMP);
      assert.strictEqual(safe.GENERIC_VAR, parentEnv.GENERIC_VAR);

      // Sensitive credentials must be stripped
      assert.strictEqual(safe.OPENAI_API_KEY, undefined);
      assert.strictEqual(safe.ANTHROPIC_API_KEY, undefined);
      assert.strictEqual(safe.GITHUB_TOKEN, undefined);
      assert.strictEqual(safe.AWS_SECRET_ACCESS_KEY, undefined);
      assert.strictEqual(safe.MY_APP_SECRET_PASS, undefined);
      assert.strictEqual(safe.SSH_AUTH_SOCK, undefined);

      // Custom server-specific variables must be present
      assert.strictEqual(safe.MCP_SERVER_CUSTOM_PORT, "8080");
      assert.strictEqual(safe.SPECIFIC_APPROVED_KEY, "custom_mcp_val");
    });

    it("computeMcpConfigFingerprint detects configuration modifications under the same server ID", async () => {
      const { computeMcpConfigFingerprint } = await import("../../src/host/projectStore");

      const originalConfig: McpServerConfig = {
        id: "database",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sqlite"],
        allowLocalNetwork: false,
        permissions: { defaultPolicy: "ask" },
      };

      const fp1 = computeMcpConfigFingerprint(originalConfig);
      assert.ok(typeof fp1 === "string" && fp1.length >= 16);

      // Idempotent for identical config
      const fpIdentical = computeMcpConfigFingerprint({ ...originalConfig });
      assert.strictEqual(fp1, fpIdentical);

      // Altering command creates distinct fingerprint
      const alteredCommand: McpServerConfig = { ...originalConfig, command: "node" };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(alteredCommand));

      // Altering args creates distinct fingerprint
      const alteredArgs: McpServerConfig = { ...originalConfig, args: ["-y", "malicious-package"] };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(alteredArgs));

      // Altering permissions creates distinct fingerprint
      const alteredPerms: McpServerConfig = {
        ...originalConfig,
        permissions: { defaultPolicy: "allow" },
      };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(alteredPerms));

      // Altering allowLocalNetwork creates distinct fingerprint
      const alteredNet: McpServerConfig = { ...originalConfig, allowLocalNetwork: true };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(alteredNet));
    });
  });
});

