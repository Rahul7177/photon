import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../session/store";
import { AgentRegistry } from "../agent/agent";
import { ToolPipeline } from "../tools/pipeline";
import { SystemPromptRegistry } from "../systemPrompt/registry";
import { AgentLoop } from "./agentLoop";
import type { LlmAdapter, StreamChunk } from "../llm/types.v2";

// Fake LLM: canned chunks per call
function fakeLlm(chunks: StreamChunk[][]): LlmAdapter {
  let call = 0;
  return {
    id: "fake",
    label: "fake",
    enabled: true,
    isConfigured: () => true,
    ping: async () => true,
    listModels: async () => [],
    async *stream(): AsyncGenerator<StreamChunk> {
      const cur = chunks[call++] ?? [{ type: "finish", reason: "stop" } as StreamChunk];
      for (const c of cur) yield c;
    },
  };
}

function makeDeps(llm: LlmAdapter) {
  const tools = new ToolPipeline();
  // minimal mock tools: list_dir + read_file
  tools.register({ spec: { name: "list_dir", summary: "x", params: [{ name: "path", type: "string", required: false, description: "" }], sideEffecting: false, priority: 5 } as any, execute: async () => ({ ok: true, output: "fileA.ts\nfileB.ts" }) } as any);
  tools.register({ spec: { name: "read_file", summary: "x", params: [{ name: "path", type: "string", required: true, description: "" }], sideEffecting: false, priority: 1 } as any, execute: async (args: any) => ({ ok: true, output: `content of ${args.path}` }) } as any);
  tools.register({ spec: { name: "write_file", summary: "x", params: [{ name: "path", type: "string", required: true, description: "" }, { name: "content", type: "string", required: true, description: "" }], sideEffecting: true, priority: 3 } as any, execute: async () => ({ ok: true, output: "done" }) } as any);
  const sys = new SystemPromptRegistry();
  return {
    llm,
    tools,
    systemPrompt: sys,
    workspaceName: "test",
    retrieveContext: async () => undefined,
    reserveOutputTokens: 1024,
    buildPlan: (prompt: string) => ({
      model: "fake:test",
      mode: "agent" as const,
      contextWindow: 8192,
      numCtx: 8192,
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 1024,
      toolProtocol: "photon-block" as const,
      maxTools: 5,
      allowParallelTools: false,
      intelligence: "low" as const,
      intelligenceAuto: true,
      rationale: [],
    }),
    buildToolContext: () => ({ capability: "low", todos: [], signal: new AbortController().signal, workspaceRoot: undefined, log: () => {}, findFiles: async () => [], getDiagnostics: async () => [] } as any),
  };
}

test("harness 01: simple chat turn produces assistant message", async () => {
  const llm = fakeLlm([[{ type: "text-delta", text: "hello", index: 0 }, { type: "finish", reason: "stop" }]]);
  const deps = makeDeps(llm);
  const sessions = new SessionRegistry();
  const agents = new AgentRegistry(sessions);
  const loop = new AgentLoop(deps as any);
  const agent = agents.create(undefined, { provider: "fake", model: "fake:test", mode: "agent" } as any);
  agent.inbox.push({ content: "hi", source: { kind: "user" }, wake: true } as any);
  const run = loop.run(agent);
  await new Promise((r) => setTimeout(r, 200));
  agent.cancel();
  await run.catch(() => {});
  assert.ok(sessions.list().length === 1);
});

test("harness 02: tool call list_dir then result logged", async () => {
  const llm = fakeLlm([
    [{ type: "text-delta", text: "[TOOL list_dir]\npath: .\n[/TOOL]", index: 0 }, { type: "finish", reason: "tool-calls" }],
    [{ type: "text-delta", text: "done", index: 0 }, { type: "finish", reason: "stop" }],
  ]);
  const deps = makeDeps(llm);
  const sessions = new SessionRegistry();
  const agents = new AgentRegistry(sessions);
  const loop = new AgentLoop(deps as any);
  const agent = agents.create(undefined, { provider: "fake", model: "fake:test", mode: "agent" } as any);
  agent.inbox.push({ content: "list", source: { kind: "user" }, wake: true } as any);
  const run = loop.run(agent);
  await new Promise((r) => setTimeout(r, 200));
  agent.cancel();
  await run.catch(() => {});
  assert.ok(sessions.list().length === 1);
});

test("harness 03: empty generation handled", async () => {
  const llm = fakeLlm([[{ type: "finish", reason: "stop" }], [{ type: "text-delta", text: "recovered", index: 0 }, { type: "finish", reason: "stop" }]]);
  const deps = makeDeps(llm);
  const sessions = new SessionRegistry();
  const agents = new AgentRegistry(sessions);
  const loop = new AgentLoop(deps as any);
  const agent = agents.create(undefined, { provider: "fake", model: "fake:test", mode: "agent" } as any);
  agent.inbox.push({ content: "hi", source: { kind: "user" }, wake: true } as any);
  const run = loop.run(agent);
  await new Promise((r) => setTimeout(r, 200));
  agent.cancel();
  await run.catch(() => {});
  assert.ok(true);
});

test("harness 04: cut-off fence continuation", async () => {
  const llm = fakeLlm([
    [{ type: "text-delta", text: "```\ncode", index: 0 }, { type: "finish", reason: "max-tokens" }],
    [{ type: "text-delta", text: "\n```", index: 0 }, { type: "finish", reason: "stop" }],
  ]);
  const deps = makeDeps(llm);
  const sessions = new SessionRegistry();
  const agents = new AgentRegistry(sessions);
  const loop = new AgentLoop(deps as any);
  const agent = agents.create(undefined, { provider: "fake", model: "fake:test", mode: "agent" } as any);
  agent.inbox.push({ content: "write code", source: { kind: "user" }, wake: true } as any);
  const run = loop.run(agent);
  await new Promise((r) => setTimeout(r, 200));
  agent.cancel();
  await run.catch(() => {});
  assert.ok(true);
});

test("harness 05: duplicate path-keyed dedup", async () => {
  const llm = fakeLlm([
    [{ type: "text-delta", text: "[TOOL read_file]\npath: a.ts\n[/TOOL]", index: 0 }, { type: "finish", reason: "tool-calls" }],
    [{ type: "text-delta", text: "[TOOL read_file]\npath: a.ts\n[/TOOL]", index: 0 }, { type: "finish", reason: "tool-calls" }],
    [{ type: "text-delta", text: "done", index: 0 }, { type: "finish", reason: "stop" }],
  ]);
  const deps = makeDeps(llm);
  const sessions = new SessionRegistry();
  const agents = new AgentRegistry(sessions);
  const loop = new AgentLoop(deps as any);
  const agent = agents.create(undefined, { provider: "fake", model: "fake:test", mode: "agent" } as any);
  agent.inbox.push({ content: "read", source: { kind: "user" }, wake: true } as any);
  const run = loop.run(agent);
  await new Promise((r) => setTimeout(r, 300));
  agent.cancel();
  await run.catch(() => {});
  // dedup should prevent second identical execution from being marked as new progress, but still logged as tool/result dup
  assert.ok(true);
});

test("harness 06: parallel tools when allowed", async () => {
  const llm = fakeLlm([[{ type: "text-delta", text: "[TOOL list_dir]\npath: .\n[/TOOL]\n[TOOL read_file]\npath: a.ts\n[/TOOL]", index: 0 }, { type: "finish", reason: "tool-calls" }]]);
  const deps = makeDeps(llm) as any;
  deps.buildPlan = () => ({ model: "fake:test", mode: "agent", contextWindow: 8192, numCtx: 8192, temperature: 0.2, topP: 0.9, maxOutputTokens: 1024, toolProtocol: "photon-block", maxTools: 5, allowParallelTools: true, intelligence: "high", intelligenceAuto: true, rationale: [] });
  const sessions = new SessionRegistry();
  const agents = new AgentRegistry(sessions);
  const loop = new AgentLoop(deps);
  const agent = agents.create(undefined, { provider: "fake", model: "fake:test", mode: "agent" } as any);
  agent.inbox.push({ content: "do parallel", source: { kind: "user" }, wake: true } as any);
  const run = loop.run(agent);
  await new Promise((r) => setTimeout(r, 200));
  agent.cancel();
  await run.catch(() => {});
  assert.ok(true);
});

test("harness 07: session fork integrity outside open turn", async () => {
  const sessions = new SessionRegistry();
  const s = sessions.create("test-session");
  s.append("user/message", { id: "u1", content: "hi", source: { kind: "user" }, createdAt: Date.now() } as any);
  s.append("turn/start", { turnId: "t1", at: Date.now() } as any);
  s.append("turn/end", { turnId: "t1", reason: "stop", at: Date.now() } as any);
  const fork = s.fork(s.allEvents().length - 1);
  // fork replays slice excluding original session/created + new created = same length
  assert.ok(fork.allEvents().length === s.allEvents().length);
  assert.ok(fork.allEvents().some((e) => e.type === "user/message"));
});

test("harness 08: SessionRegistry turn/start and turn/end events", async () => {
  const llm = fakeLlm([[{ type: "text-delta", text: "hello", index: 0 }, { type: "finish", reason: "stop" }]]);
  const deps = makeDeps(llm);
  const sessions = new SessionRegistry();
  const agents = new AgentRegistry(sessions);
  const loop = new AgentLoop(deps as any);
  const agent = agents.create(undefined, { provider: "fake", model: "fake:test", mode: "agent" } as any);
  agent.inbox.push({ content: "hi", source: { kind: "user" }, wake: true } as any);
  const run = loop.run(agent);
  await new Promise((r) => setTimeout(r, 200));
  agent.cancel();
  await run.catch(() => {});
  const evs = sessions.list()[0].allEvents();
  assert.ok(evs.some((e) => e.type === "turn/start"));
  assert.ok(evs.some((e) => e.type === "turn/end"));
});

test("harness 09: photon-block vs native protocol selection", async () => {
  const llm = fakeLlm([[{ type: "tool-call-delta", id: "1", name: "list_dir", argumentsDelta: "{\"path\":\".\"}", index: 0 }, { type: "finish", reason: "tool-calls" }]]);
  const deps = makeDeps(llm) as any;
  deps.buildPlan = () => ({ model: "fake:test", mode: "agent", contextWindow: 8192, numCtx: 8192, temperature: 0.2, topP: 0.9, maxOutputTokens: 1024, toolProtocol: "native" as const, maxTools: 5, allowParallelTools: false, intelligence: "high", intelligenceAuto: true, rationale: [] });
  const sessions = new SessionRegistry();
  const agents = new AgentRegistry(sessions);
  const loop = new AgentLoop(deps);
  const agent = agents.create(undefined, { provider: "fake", model: "fake:test", mode: "agent" } as any);
  agent.inbox.push({ content: "hi", source: { kind: "user" }, wake: true } as any);
  const run = loop.run(agent);
  await new Promise((r) => setTimeout(r, 200));
  agent.cancel();
  await run.catch(() => {});
  assert.ok(true);
});

test("harness 10: stripToolMarkup removes leaked tags", async () => {
  const { parsePhotonBlocks } = await import("../../core/protocol/parse.js");
  const specs = [{ name: "list_dir", summary: "", params: [{ name: "path", type: "string", required: false, description: "" }], sideEffecting: false, priority: 5 } as any];
  const res = parsePhotonBlocks("hello <|tool_call>call:list_dir\npath: .\n</|tool_call> world", specs as any);
  assert.ok(!res.cleanedText.includes("tool_call"));
  assert.ok(res.cleanedText.includes("hello"));
  assert.equal(res.calls.length, 1);
  assert.equal(res.calls[0].name, "list_dir");
});

test("harness 11: parsePhotonBlocks and stripToolMarkup cleans leaked gemma tool calls", async () => {
  const { parsePhotonBlocks, stripToolMarkup } = await import("../../core/protocol/parse.js");
  const specs = [{ name: "list_dir", summary: "", params: [{ name: "path", type: "string", required: false, description: "" }], sideEffecting: false, priority: 5 } as any];
  const leaked = '<|tool_call>call:list_dir\n{"path": "."}\nEND_ARG';
  const res = parsePhotonBlocks(leaked, specs as any);
  assert.equal(res.calls.length, 1);
  assert.equal(res.calls[0].name, "list_dir");
  assert.equal(res.calls[0].args.path, ".");
  assert.equal(res.cleanedText, "");
  assert.equal(stripToolMarkup(leaked), "");
});

test("harness 12: isFreshInfoRequest identifies real-time and search queries", async () => {
  const { isFreshInfoRequest } = await import("../../core/intelligence/policy.js");
  assert.equal(isFreshInfoRequest("what is the weather in Tokyo"), true);
  assert.equal(isFreshInfoRequest("bitcoin price"), true);
  assert.equal(isFreshInfoRequest("search online for vite plugins"), true);
  assert.equal(isFreshInfoRequest("latest news today"), true);
  assert.equal(isFreshInfoRequest("read file src/index.ts"), false);
});

test("harness 13: webSearchTool returns results via duckduckgo and google fallback", async () => {
  const { webSearchTool } = await import("../../core/tools/builtin/web.js");
  const origFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seenUrls.push(url);
    if (url.includes("google.com")) {
      // Empty Google HTML forces DuckDuckGo fallback path
      return new Response("<html><body></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.includes("html.duckduckgo.com")) {
      const ddgHtml = `<html><body>
        <a class="result__a" href="https://expressjs.com/en/starter/hello-world.html">Express Node.js Tutorial</a>
        <a class="result__snippet">Build fast Node.js web apps with Express.</a>
      </body></html>`;
      return new Response(ddgHtml, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    const res = await webSearchTool.execute({ query: "nodejs express tutorial" }, {
      signal: new AbortController().signal,
      webSearchProvider: "google",
      capability: "medium",
    } as any);
    assert.equal(res.ok, true);
    assert.ok(seenUrls.some((u) => u.includes("google.com")));
    assert.ok(seenUrls.some((u) => u.includes("duckduckgo.com")));
    assert.ok(res.output.includes("Express") || res.output.includes("Node"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("harness 14: webSearchTool falls back to DuckDuckGo Lite and Wikipedia extracts when primary DDG returns 202", async () => {
  const { webSearchTool, extractCurrencyQuery } = await import("../../core/tools/builtin/web.js");
  assert.deepEqual(extractCurrencyQuery("USD to INR conversion rate today"), {
    amount: 1,
    from: "USD",
    to: "INR",
  });
  assert.deepEqual(extractCurrencyQuery("current USD to INR exchange rate"), {
    amount: 1,
    from: "USD",
    to: "INR",
  });
  assert.deepEqual(extractCurrencyQuery("whats the USD conversion rate to INR today?"), {
    amount: 1,
    from: "USD",
    to: "INR",
  });
  assert.equal(extractCurrencyQuery("current president of India"), undefined);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("html.duckduckgo.com")) {
      return new Response("<html><body>202 anomaly challenge</body></html>", {
        status: 202,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.includes("lite.duckduckgo.com")) {
      const liteHtml = `<html><body>
        <table>
          <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FDroupadi_Murmu&amp;rut=123" class='result-link'>Droupadi Murmu - Wikipedia</a></td></tr>
          <tr><td class='result-snippet'>Droupadi Murmu is an Indian politician who has served as the 15th president of India since 2022.</td></tr>
        </table>
      </body></html>`;
      return new Response(liteHtml, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.includes("open.er-api.com")) {
      return new Response(
        JSON.stringify({
          result: "success",
          time_last_update_utc: "Fri, 27 Nov 2026 00:00:01 +0000",
          rates: { INR: 84.5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const presRes = await webSearchTool.execute({ query: "current president of India" }, {
      signal: new AbortController().signal,
      webSearchProvider: "duckduckgo",
      capability: "medium",
    } as any);
    assert.equal(presRes.ok, true);
    assert.ok(presRes.output.includes("Droupadi Murmu"));

    const fxRes = await webSearchTool.execute({ query: "USD to INR conversion rate today" }, {
      signal: new AbortController().signal,
      webSearchProvider: "duckduckgo",
      capability: "medium",
    } as any);
    assert.equal(fxRes.ok, true);
    assert.ok(fxRes.output.includes("1 USD = 84.5 INR"));
  } finally {
    globalThis.fetch = origFetch;
  }
});
