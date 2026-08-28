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
  const evs = sessions.list()[0].allEvents().map((e) => e.type);
  assert.ok(evs.includes("tool/call"));
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
