import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpTool } from "./mcpClient";
import type { IMcpClient } from "./transport";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * MCP client over stdio: launches the server as a child process and exchanges
 * newline-delimited JSON-RPC. Careful with the process lifecycle — every pending
 * request is rejected if the child dies, timers are always cleared, and close()
 * kills the child and detaches listeners so nothing leaks.
 */
export class McpStdioClient implements IMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number | string, Pending>();
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env?: Record<string, string>,
    private readonly cwd?: string
  ) {}

  async connect(timeoutMs = 10_000): Promise<void> {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
      cwd: this.cwd,
      windowsHide: true,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.onData(d));
    child.on("error", (err) => this.failAll(new Error(`MCP process error: ${err.message}`)));
    child.on("exit", (code) => this.failAll(new Error(`MCP process exited (${code ?? "signal"}).`)));

    const result = (await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "photon", version: "0.1.0" },
      },
      timeoutMs
    )) as { protocolVersion?: string };
    if (!result?.protocolVersion) throw new Error("MCP server did not complete initialize.");
    this.notify("notifications/initialized");
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("MCP client closed."));
    const child = this.child;
    this.child = undefined;
    if (child) {
      child.stdout.removeAllListeners();
      child.removeAllListeners();
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private rpc(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed || !this.child) return Promise.reject(new Error("MCP client is not connected."));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private write(obj: unknown): void {
    if (!this.child) throw new Error("MCP client is not connected.");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // ignore non-JSON log noise on stdout
      }
      if (msg.id === undefined) continue; // a notification from the server
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`MCP error: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  /** Reject and clear every in-flight request (used on child death / close). */
  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}
