import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePhotonBlocks } from "./parse";
import type { ToolSpec } from "../../shared/types";

const appendSpec: ToolSpec = {
  name: "append_file",
  summary: "Append text",
  params: [
    { name: "path", type: "string", required: true, description: "" },
    { name: "content", type: "string", required: true, description: "" },
  ],
  sideEffecting: true,
  priority: 1,
};

const readSpec: ToolSpec = {
  name: "read_file",
  summary: "Read text",
  params: [{ name: "path", type: "string", required: true, description: "" }],
  sideEffecting: false,
  priority: 1,
};

const specs = [appendSpec, readSpec];

test("parses blank-line-heavy pipe append calls", () => {
  const text = `<|tool_call>call:append_file

BEGIN_ARG: path

temp.md

END_ARG

BEGIN_ARG: content

Why do programmers prefer dark mode? Because light attracts bugs.

END_ARG

END_ARG`;
  const result = parsePhotonBlocks(text, specs);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].args, {
    path: "temp.md",
    content: "Why do programmers prefer dark mode? Because light attracts bugs.",
  });
  assert.equal(result.calls[0].errors.length, 0);
  assert.equal(result.cleanedText, "");
});

test("parses the canonical fenced append call", () => {
  const text = "```tool\nTOOL_NAME: append_file\nBEGIN_ARG: path\ntemp.md\nEND_ARG\nBEGIN_ARG: content\nA joke.\nEND_ARG\n```";
  const result = parsePhotonBlocks(text, specs);
  assert.deepEqual(result.calls[0].args, { path: "temp.md", content: "A joke." });
  assert.equal(result.cleanedText, "");
});

test("does not reinterpret structured multiline content as arguments", () => {
  const text = "[TOOL:append_file]\nBEGIN_ARG: path\ntemp.md\nEND_ARG\nBEGIN_ARG: content\nhello: world\nEND_ARG\n[/TOOL]";
  const result = parsePhotonBlocks(text, specs);
  assert.deepEqual(result.calls[0].args, { path: "temp.md", content: "hello: world" });
});

test("rejects non-object JSON arguments without crashing", () => {
  const text = `<tool_call>{"tool":"read_file","args":["temp.md"]}</tool_call>`;
  const result = parsePhotonBlocks(text, specs);
  assert.deepEqual(result.calls[0].args, {});
  assert.match(result.calls[0].errors[0], /Missing required argument/);
});

test("accepts aliases and strips tool markup", () => {
  const text = "Before <tool_call>{\"tool\":\"read\",\"args\":{\"path\":\"temp.md\"}}</tool_call> After";
  const result = parsePhotonBlocks(text, specs);
  assert.equal(result.calls[0].name, "read_file");
  assert.deepEqual(result.calls[0].args, { path: "temp.md" });
  assert.equal(result.cleanedText, "Before  After");
});
