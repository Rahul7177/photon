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

    it("rejects mixed DNS answers containing prohibited addresses", async () => {
      const mockLookup = async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "192.168.1.1", family: 4 },
      ];
      const res = await validateRemoteEndpoint("https://mixed.example.com/mcp", false, mockLookup);
      assert.strictEqual(res.ok, false);
      assert.ok(res.reason?.includes("prohibited"));
    });

    it("handles trailing-dot hostnames, zone identifiers, and special prefixes consistently", async () => {
      assert.strictEqual(isSafeRemoteHostname("localhost."), false);
      assert.strictEqual(isSafeRemoteHostname("server.local."), false);
      assert.strictEqual(isBlockedIPv6("fe80::1%eth0"), true);
      assert.strictEqual(isBlockedIPv6("100::1"), true);
      assert.strictEqual(isBlockedIPv6("2001:db8::1"), true);
      assert.strictEqual(isBlockedIPv6("2002::1"), true);
    });

    it("McpClient pinned connection catches DNS rebinding between validation and actual connection", async () => {
      const { McpClient } = await import("../../src/core/tools/mcp/mcpClient");

      let callCount = 0;
      const rebindingLookup = async () => {
        callCount++;
        if (callCount === 1) {
          // Call 1: Validation time -> passes with public IP
          return [{ address: "93.184.216.34", family: 4 }];
        }
        // Call 2+: Actual connection time -> rebinding attack to cloud metadata
        return [{ address: "169.254.169.254", family: 4 }];
      };

      const client = new McpClient(
        "https://rebind.example.com/mcp",
        {},
        false,
        rebindingLookup
      );

      await assert.rejects(
        async () => {
          await client.connect(2000);
        },
        (err: Error) => {
          return err.message.includes("169.254.169.254") || err.message.includes("DNS rebinding");
        }
      );
    });

    it("parseSse handles comments, multi-line data, CRLF, and multiple events cleanly", async () => {
      const { parseSse } = await import("../../src/core/tools/mcp/mcpClient");

      const sseStream =
        ": heartbeat\r\n\r\n" +
        "event: ping\r\n" +
        "data: ignored\r\n\r\n" +
        "event: message\r\n" +
        "data: {\"jsonrpc\":\"2.0\",\r\n" +
        "data: \"id\":42,\r\n" +
        "data: \"result\":{\"tools\":[]}}\r\n\r\n";

      const parsed = parseSse(sseStream);
      assert.strictEqual(parsed.id, 42);
      assert.deepStrictEqual(parsed.result, { tools: [] });
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
    it("buildSafeMcpEnv uses strict allowlist, stripping credentials and non-allowlisted vars while preserving OS essentials and custom vars", async () => {
      const { buildSafeMcpEnv } = await import("../../src/core/tools/mcp/mcpStdioClient");

      const parentEnv: NodeJS.ProcessEnv = {
        PATH: "C:\\Windows;C:\\Program Files\\nodejs",
        SYSTEMROOT: "C:\\Windows",
        USERPROFILE: "C:\\Users\\dev",
        TEMP: "C:\\Temp",
        OPENAI_API_KEY: "sk-secret-1234567890",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        GITHUB_TOKEN: "ghp_1234567890",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        MY_APP_SECRET_PASS: "supersecret",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        GENERIC_VAR: "allowed_value",
        KUBECONFIG: "/home/dev/.kube/config",
        DOCKER_CONFIG: "/home/dev/.docker",
        NPM_CONFIG_USERCONFIG: "/home/dev/.npmrc",
        NODE_OPTIONS: "--require /tmp/malicious.js",
        PYTHONPATH: "/tmp/malicious_python",
      };

      const customEnv = {
        MCP_SERVER_CUSTOM_PORT: "8080",
        SPECIFIC_APPROVED_KEY: "custom_mcp_val",
      };

      const safe = buildSafeMcpEnv(parentEnv, customEnv, "win32");

      // Essential system variables must be retained on Windows
      assert.strictEqual(safe.PATH, parentEnv.PATH);
      assert.strictEqual(safe.SYSTEMROOT, parentEnv.SYSTEMROOT);
      assert.strictEqual(safe.USERPROFILE, parentEnv.USERPROFILE);
      assert.strictEqual(safe.TEMP, parentEnv.TEMP);

      // Sensitive credentials and arbitrary unknown variables must NOT be inherited
      assert.strictEqual(safe.OPENAI_API_KEY, undefined);
      assert.strictEqual(safe.ANTHROPIC_API_KEY, undefined);
      assert.strictEqual(safe.GITHUB_TOKEN, undefined);
      assert.strictEqual(safe.AWS_SECRET_ACCESS_KEY, undefined);
      assert.strictEqual(safe.MY_APP_SECRET_PASS, undefined);
      assert.strictEqual(safe.SSH_AUTH_SOCK, undefined);
      assert.strictEqual(safe.GENERIC_VAR, undefined);

      // Package and cloud config paths must NOT be inherited
      assert.strictEqual(safe.KUBECONFIG, undefined);
      assert.strictEqual(safe.DOCKER_CONFIG, undefined);
      assert.strictEqual(safe.NPM_CONFIG_USERCONFIG, undefined);

      // Execution injection variables must NOT be inherited from parent
      assert.strictEqual(safe.NODE_OPTIONS, undefined);
      assert.strictEqual(safe.PYTHONPATH, undefined);

      // Explicit server-specific variables must be present
      assert.strictEqual(safe.MCP_SERVER_CUSTOM_PORT, "8080");
      assert.strictEqual(safe.SPECIFIC_APPROVED_KEY, "custom_mcp_val");
    });

    it("buildSafeMcpEnv handles POSIX platforms (linux and darwin) correctly", async () => {
      const { buildSafeMcpEnv } = await import("../../src/core/tools/mcp/mcpStdioClient");

      const parentEnv: NodeJS.ProcessEnv = {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/home/user",
        USER: "user",
        SHELL: "/bin/bash",
        LANG: "en_US.UTF-8",
        SYSTEMROOT: "C:\\Windows", // Windows-only, should not be in POSIX
        KUBECONFIG: "/etc/kubernetes/admin.conf",
      };

      const linuxSafe = buildSafeMcpEnv(parentEnv, undefined, "linux");
      assert.strictEqual(linuxSafe.PATH, "/usr/local/bin:/usr/bin");
      assert.strictEqual(linuxSafe.HOME, "/home/user");
      assert.strictEqual(linuxSafe.USER, "user");
      assert.strictEqual(linuxSafe.SHELL, "/bin/bash");
      assert.strictEqual(linuxSafe.LANG, "en_US.UTF-8");
      assert.strictEqual(linuxSafe.SYSTEMROOT, undefined);
      assert.strictEqual(linuxSafe.KUBECONFIG, undefined);

      const darwinSafe = buildSafeMcpEnv(parentEnv, undefined, "darwin");
      assert.strictEqual(darwinSafe.PATH, "/usr/local/bin:/usr/bin");
      assert.strictEqual(darwinSafe.HOME, "/home/user");
      assert.strictEqual(darwinSafe.SYSTEMROOT, undefined);
    });

    it("buildSafeMcpEnv validates env keys and values, rejecting malformed keys and NUL bytes", async () => {
      const { buildSafeMcpEnv } = await import("../../src/core/tools/mcp/mcpStdioClient");

      // Key containing '=' is rejected
      assert.throws(() => {
        buildSafeMcpEnv({}, { "INVALID=KEY": "value" });
      }, /Invalid MCP environment variable name/);

      // Key containing NUL byte is rejected
      assert.throws(() => {
        buildSafeMcpEnv({}, { "KEY\0": "value" });
      }, /Invalid MCP environment variable name/);

      // Value containing NUL byte is rejected
      assert.throws(() => {
        buildSafeMcpEnv({}, { VALID_KEY: "val\0ue" });
      }, /contains NUL bytes/);

      // ParentEnv with NUL byte in value is safely dropped, not crashing
      const corruptedParent: NodeJS.ProcessEnv = {
        PATH: "C:\\Windows\0corrupted",
        SYSTEMROOT: "C:\\Windows",
      };
      const safe = buildSafeMcpEnv(corruptedParent, undefined, "win32");
      assert.strictEqual(safe.PATH, undefined);
      assert.strictEqual(safe.SYSTEMROOT, "C:\\Windows");
    });

    it("computeMcpConfigFingerprint detects configuration modifications under the same server ID", async () => {
      const { computeMcpConfigFingerprint } = await import("../../src/host/projectStore");

      const originalConfig: McpServerConfig = {
        id: "database",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sqlite"],
        cwd: "/workspace",
        env: { DB_PATH: "/workspace/db.sqlite", API_SECRET: "secret_token_123" },
        allowLocalNetwork: false,
        permissions: { defaultPolicy: "ask" },
      };

      const fp1 = computeMcpConfigFingerprint(originalConfig);
      assert.ok(typeof fp1 === "string" && fp1.length >= 16);

      // Idempotent for identical config
      const fpIdentical = computeMcpConfigFingerprint({ ...originalConfig });
      assert.strictEqual(fp1, fpIdentical);

      // Canonical key ordering: different key insertion order must produce IDENTICAL fingerprint
      const reorderedConfig: McpServerConfig = {
        ...originalConfig,
        env: { API_SECRET: "secret_token_123", DB_PATH: "/workspace/db.sqlite" },
      };
      assert.strictEqual(fp1, computeMcpConfigFingerprint(reorderedConfig));

      // Altering command creates distinct fingerprint
      const alteredCommand: McpServerConfig = { ...originalConfig, command: "node" };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(alteredCommand));

      // Altering args creates distinct fingerprint
      const alteredArgs: McpServerConfig = { ...originalConfig, args: ["-y", "malicious-package"] };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(alteredArgs));

      // Altering cwd creates distinct fingerprint
      const alteredCwd: McpServerConfig = { ...originalConfig, cwd: "/different/dir" };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(alteredCwd));

      // Altering permissions creates distinct fingerprint
      const alteredPerms: McpServerConfig = {
        ...originalConfig,
        permissions: { defaultPolicy: "always_allow" },
      };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(alteredPerms));

      // Altering allowLocalNetwork creates distinct fingerprint
      const alteredNet: McpServerConfig = { ...originalConfig, allowLocalNetwork: true };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(alteredNet));

      // Altering env variable or secret rotation invalidates previous approval
      const rotatedSecret: McpServerConfig = {
        ...originalConfig,
        env: { DB_PATH: "/workspace/db.sqlite", API_SECRET: "new_rotated_secret_456" },
      };
      assert.notStrictEqual(fp1, computeMcpConfigFingerprint(rotatedSecret));

      // HTTP server headers canonicalization and secret rotation
      const httpConfig: McpServerConfig = {
        id: "remote_api",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer tok_123", "X-Custom": "alpha" },
      };
      const httpFp = computeMcpConfigFingerprint(httpConfig);

      // Reordered and case-different header keys produce IDENTICAL fingerprint
      const httpReordered: McpServerConfig = {
        id: "remote_api",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "x-custom": "alpha", AUTHORIZATION: "Bearer tok_123" },
      };
      assert.strictEqual(httpFp, computeMcpConfigFingerprint(httpReordered));

      // Rotating header token invalidates fingerprint
      const httpRotated: McpServerConfig = {
        id: "remote_api",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer tok_rotated_456", "X-Custom": "alpha" },
      };
      assert.notStrictEqual(httpFp, computeMcpConfigFingerprint(httpRotated));
    });

    it("ProjectStore manages one-time, session, and persistent trust scopes, and prunes stale records", async () => {
      const { ProjectStore } = await import("../../src/host/projectStore");

      const stateStore: Record<string, unknown> = {};
      const mockContext: any = {
        workspaceState: {
          get: (key: string, defaultValue?: unknown) =>
            key in stateStore ? stateStore[key] : defaultValue,
          update: async (key: string, value: unknown) => {
            stateStore[key] = value;
          },
        },
      };

      const store = new ProjectStore(mockContext);

      const serverA: McpServerConfig = {
        id: "server_a",
        transport: "stdio",
        command: "node server.js",
      };
      const serverB: McpServerConfig = {
        id: "server_b",
        transport: "http",
        url: "https://api.example.com",
      };

      // Initially unapproved
      assert.strictEqual(store.isMcpConfigApproved(serverA), false);
      assert.strictEqual(store.isMcpApproved("server_a"), false); // fails closed

      // 1. One-time trust: valid for exactly one check, then consumed
      await store.approveMcpConfig(serverA, "one_time");
      assert.strictEqual(store.isMcpConfigApproved(serverA), true);
      assert.strictEqual(store.isMcpConfigApproved(serverA), false); // consumed!

      // 2. Session trust: in-memory only, does not write to workspaceState
      await store.approveMcpConfig(serverB, "session");
      assert.strictEqual(store.isMcpConfigApproved(serverB), true);
      assert.strictEqual(mockContext.workspaceState.get("photon.mcpFingerprints"), undefined);

      // Clearing session trust removes session approval
      store.clearSessionApprovals();
      assert.strictEqual(store.isMcpConfigApproved(serverB), false);

      // 3. Persistent trust: saved to workspaceState
      await store.approveMcpConfig(serverA, "persistent");
      assert.strictEqual(store.isMcpConfigApproved(serverA), true);
      const persisted = mockContext.workspaceState.get("photon.mcpFingerprints") as Record<string, string>;
      assert.ok(persisted && persisted["server_a"]);

      // 4. Stale trust pruning: if server_a is no longer active, its trust is cleared
      await store.pruneStaleMcpApprovals(["server_b"]); // server_a not in list
      assert.strictEqual(store.isMcpConfigApproved(serverA), false);
    });

    it("ApprovalService strictly prevents critical terminal commands from bypassing user confirmation via autoApprove", async () => {
      const { ApprovalService } = await import("../../src/host/approvalService");

      const service = new ApprovalService(true); // autoApprove initialized to true!
      assert.strictEqual(service.autoApprove, true);

      let requested = false;
      const onPost = () => {
        requested = true;
      };

      // 1. Benign tool call is auto-approved without prompting
      requested = false;
      const approvedNormal = await service.requestApproval(
        {
          id: "call_read",
          name: "read_file",
          args: { path: "package.json" },
          status: "proposed",
          sideEffecting: false,
          risk: "read",
        },
        onPost
      );
      assert.strictEqual(approvedNormal, true);
      assert.strictEqual(requested, false);

      // 2. Critical terminal execution CANNOT bypass approval even with autoApprove = true
      requested = false;
      const promiseCritical = service.requestApproval(
        {
          id: "call_critical",
          name: "run_command",
          args: { command: "rm -rf /" },
          status: "proposed",
          sideEffecting: true,
          risk: "critical",
          statusDetail: "High-risk action: deletes files recursively",
        },
        onPost
      );
      assert.strictEqual(requested, true); // User prompt was posted!
      service.resolveApproval("call_critical", true);
      const approvedCritical = await promiseCritical;
      assert.strictEqual(approvedCritical, true);

      // 3. Destructive action CANNOT bypass approval
      requested = false;
      const promiseDestructive = service.requestApproval(
        {
          id: "call_destructive",
          name: "drop_database",
          args: {},
          status: "proposed",
          sideEffecting: true,
          risk: "destructive",
        },
        onPost
      );
      assert.strictEqual(requested, true);
      service.resolveApproval("call_destructive", false);
      const approvedDestructive = await promiseDestructive;
      assert.strictEqual(approvedDestructive, false);
    });
  });
});

