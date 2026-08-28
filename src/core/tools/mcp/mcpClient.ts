// Minimal MCP client over the Streamable HTTP transport (JSON-RPC 2.0).
// Supports servers that reply with either application/json or text/event-stream.
// Intentionally small and tolerant — it's a bridge, not a full SDK.

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpClient {
  private sessionId?: string;
  private nextId = 1;
  private initialized = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {}
  ) {}

  async connect(timeoutMs = 8000): Promise<void> {
    const result = (await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "photon", version: "0.1.0" },
      },
      timeoutMs
    )) as { protocolVersion?: string };
    if (!result?.protocolVersion) {
      throw new Error("MCP server did not complete initialize.");
    }
    // Fire-and-forget the initialized notification.
    await this.notify("notifications/initialized").catch(() => undefined);
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    const res = (await this.rpc("tools/list", {})) as { tools?: McpTool[] };
    return res?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res?.content ?? [])
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
      .join("\n")
      .trim();
    if (res?.isError) throw new Error(text || "MCP tool returned an error.");
    return text || "(no content)";
  }

  /** End the server session (HTTP DELETE per the spec). Best-effort. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, {
        method: "DELETE",
        signal: AbortSignal.timeout(3000),
        headers: { "Mcp-Session-Id": this.sessionId, ...this.headers },
      });
    } catch {
      /* server may not support session teardown — ignore */
    } finally {
      this.sessionId = undefined;
      this.initialized = false;
    }
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  private async rpc(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    if (res.error) throw new Error(`MCP ${method} failed: ${res.error.message}`);
    return res.result;
  }

  private async post(body: unknown, timeoutMs = 15000): Promise<JsonRpcResponse> {
    const res = await fetch(this.url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    const sid = res.headers.get("Mcp-Session-Id");
    if (sid) this.sessionId = sid;

    // Notifications get 202 with no body.
    if (res.status === 202) return { jsonrpc: "2.0", id: 0 };
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);

    const ct = res.headers.get("Content-Type") ?? "";
    const text = await res.text();
    if (ct.includes("text/event-stream")) {
      return parseSse(text);
    }
    return JSON.parse(text) as JsonRpcResponse;
  }
}

/** Extract the first JSON-RPC response from an SSE stream body. */
function parseSse(body: string): JsonRpcResponse {
  for (const block of body.split(/\n\n/)) {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as JsonRpcResponse;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error) {
        return parsed;
      }
    } catch {
      /* keep scanning */
    }
  }
  throw new Error("No JSON-RPC payload found in MCP SSE response.");
}
