import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalToolName,
  parsePhotonBlocks,
  stripToolMarkup,
} from "../../src/core/protocol/parse";
import {
  renderToolInstructions,
  renderToolResult,
  toNativeTools,
} from "../../src/core/protocol/serialize";
import type { AdaptivePlan, ToolSpec } from "../../src/shared/types";

describe("Protocol Parsing & Tool Serialization", () => {
  const specs: ToolSpec[] = [
    {
      name: "read_file",
      summary: "Read a file from disk with optional line ranges.",
      params: [
        { name: "path", type: "string", required: true, description: "Relative file path" },
        { name: "start_line", type: "number", required: false, description: "1-based start line" },
        { name: "end_line", type: "number", required: false, description: "1-based end line" },
      ],
      sideEffecting: false,
      priority: 1,
    },
    {
      name: "edit_file",
      summary: "Edit an existing file by replacing old_str with new_str.",
      params: [
        { name: "path", type: "string", required: true, description: "Relative file path" },
        { name: "old_str", type: "string", required: true, description: "Target string" },
        { name: "new_str", type: "string", required: true, description: "Replacement string" },
      ],
      sideEffecting: true,
      priority: 2,
    },
    {
      name: "write_file",
      summary: "Write content to a new file.",
      params: [
        { name: "path", type: "string", required: true, description: "Relative file path" },
        { name: "content", type: "string", required: true, description: "Content to write" },
      ],
      sideEffecting: true,
      priority: 3,
    },
    {
      name: "list_dir",
      summary: "List directory contents.",
      params: [{ name: "path", type: "string", required: false, description: "Directory path" }],
      sideEffecting: false,
      priority: 4,
    },
  ];

  describe("canonicalToolName & Aliases", () => {
    it("resolves exact tool names case-insensitively", () => {
      assert.equal(canonicalToolName("read_file", specs), "read_file");
      assert.equal(canonicalToolName("READ_FILE", specs), "read_file");
      assert.equal(canonicalToolName("edit_file", specs), "edit_file");
    });

    it("maps common model aliases to canonical tool names", () => {
      assert.equal(canonicalToolName("list_files", specs), "list_dir");
      assert.equal(canonicalToolName("replace_in_file", specs), "edit_file");
      assert.equal(canonicalToolName("create_file", specs), "write_file");
      assert.equal(canonicalToolName("view", specs), "read_file");
    });

    it("returns undefined for unknown tools", () => {
      assert.equal(canonicalToolName("unknown_tool_xyz", specs), undefined);
    });
  });

  describe("parsePhotonBlocks", () => {
    it("parses primary fenced format with BEGIN_ARG / END_ARG", () => {
      const text = `
I will now read the configuration file.
\`\`\`tool
TOOL_NAME: read_file
BEGIN_ARG: path
src/config.ts
END_ARG
BEGIN_ARG: start_line
10
END_ARG
\`\`\`
Let me know if you need more details.
      `.trim();

      const result = parsePhotonBlocks(text, specs);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].name, "read_file");
      assert.equal(result.calls[0].args.path, "src/config.ts");
      assert.equal(result.calls[0].args.start_line, 10);
      assert.ok(result.cleanedText.includes("I will now read the configuration file."));
      assert.ok(!result.cleanedText.includes("TOOL_NAME"));
    });

    it("parses JSON tool_call envelopes", () => {
      const text = `
<tool_call>
{"tool": "read_file", "args": {"path": "package.json", "start_line": 1, "end_line": 20}}
</tool_call>
      `.trim();

      const result = parsePhotonBlocks(text, specs);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].name, "read_file");
      assert.equal(result.calls[0].args.path, "package.json");
      assert.equal(result.calls[0].args.start_line, 1);
      assert.equal(result.calls[0].args.end_line, 20);
    });

    it("parses hybrid Gemma tool_call format with inline JSON", () => {
      const text = `<|tool_call>call:read_file{"path": "README.md"}<|tool_response>`;
      const result = parsePhotonBlocks(text, specs);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].name, "read_file");
      assert.equal(result.calls[0].args.path, "README.md");
    });

    it("parses bracket notation [TOOL:...] ... [/TOOL]", () => {
      const text = `
[TOOL:write_file]
path: docs/guide.md
content: # Getting Started
Welcome to the guide.
[/TOOL]
      `.trim();

      const result = parsePhotonBlocks(text, specs);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].name, "write_file");
      assert.equal(result.calls[0].args.path, "docs/guide.md");
      assert.ok(String(result.calls[0].args.content).includes("# Getting Started"));
    });

    it("strips read_file line gutter artifacts if copied by small models", () => {
      const text = `
\`\`\`tool
TOOL_NAME: edit_file
BEGIN_ARG: path
src/test.ts
END_ARG
BEGIN_ARG: old_str
 1 | const x = 1;
 2 | const y = 2;
END_ARG
BEGIN_ARG: new_str
const x = 10;
const y = 20;
END_ARG
\`\`\`
      `.trim();

      const result = parsePhotonBlocks(text, specs);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].args.old_str, "const x = 1;\nconst y = 2;");
      assert.equal(result.calls[0].args.new_str, "const x = 10;\nconst y = 20;");
    });

    it("recovers from malformed JSON in tool_call envelopes", () => {
      // Unquoted keys and trailing commas
      const text = `<tool_call>\n{tool: "read_file", args: {path: "src/main.ts",}}\n</tool_call>`;
      const result = parsePhotonBlocks(text, specs);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].name, "read_file");
      assert.equal(result.calls[0].args.path, "src/main.ts");
    });
  });

  describe("stripToolMarkup", () => {
    it("removes all Gemma, Claude, and Photon control tokens cleanly", () => {
      const dirty = `
Here is your answer.
<|tool_call>
call:read_file{"path": "test.txt"}
END_ARG
<|tool_response>
[RESULT read_file]
File content
[/RESULT]
<tool_call>some tool</tool_call>
Have a great day!
      `.trim();

      const clean = stripToolMarkup(dirty);
      assert.ok(clean.includes("Here is your answer."));
      assert.ok(clean.includes("Have a great day!"));
      assert.ok(!clean.includes("tool_call"));
      assert.ok(!clean.includes("END_ARG"));
      assert.ok(!clean.includes("[RESULT"));
      assert.ok(!clean.includes("[/RESULT]"));
    });
  });

  describe("Tool Instructions & Result Serialization", () => {
    it("renders tool instructions with clear formatting and rules", () => {
      const plan: AdaptivePlan = {
        model: "test:model",
        mode: "agent",
        intelligence: "medium",
        contextWindow: 16384,
        numCtx: 16384,
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 2048,
        toolProtocol: "photon-block",
        maxTools: 5,
      };

      const instructions = renderToolInstructions(specs, plan);
      assert.ok(instructions.includes("PRIMARY FORMAT — use this"));
      assert.ok(instructions.includes("TOOL_NAME: read_file"));
      assert.ok(instructions.includes("TOOL_NAME: edit_file"));
      assert.ok(instructions.includes("RULES FOR TOOL USE:"));
      assert.ok(instructions.includes("CRITICAL — Web & current info:"));
    });

    it("serializes successful tool results into tool_result envelopes", () => {
      const result = renderToolResult("read_file", "File lines 1-10", true);
      assert.equal(result, '<tool_result tool="read_file" status="ok">\nFile lines 1-10\n</tool_result>');
    });

    it("serializes error tool results into tool_result envelopes with status=error", () => {
      const result = renderToolResult("read_file", "ENOENT: file not found", false);
      assert.equal(result, '<tool_result tool="read_file" status="error">\nENOENT: file not found\n</tool_result>');
    });

    it("converts ToolSpec array into native function calling definitions", () => {
      const nativeTools = toNativeTools(specs) as any[];
      assert.equal(nativeTools.length, 4);
      assert.equal(nativeTools[0].type, "function");
      assert.equal(nativeTools[0].function.name, "read_file");
      assert.ok(nativeTools[0].function.parameters.properties.path);
      assert.deepEqual(nativeTools[0].function.parameters.required, ["path"]);
    });
  });

  describe("P1 Item 11: Cross-Model & Adversarial Protocol Evaluation", () => {
    it("resolves ambiguous parameter aliases across model families", () => {
      const text = `
\`\`\`tool
TOOL_NAME: replace_in_file
BEGIN_ARG: filepath
src/app.ts
END_ARG
BEGIN_ARG: old_text
const a = 1;
END_ARG
BEGIN_ARG: new_text
const a = 2;
END_ARG
\`\`\`
      `.trim();

      const result = parsePhotonBlocks(text, specs);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].name, "edit_file");
      assert.equal(result.calls[0].args.path, "src/app.ts");
      assert.equal(result.calls[0].args.old_str, "const a = 1;");
      assert.equal(result.calls[0].args.new_str, "const a = 2;");
    });

    it("parses repeated tool calls in a single response in exact order", () => {
      const text = `
Let me inspect both files first.
\`\`\`tool
TOOL_NAME: read_file
BEGIN_ARG: path
src/first.ts
END_ARG
\`\`\`
And now the second file:
\`\`\`tool
TOOL_NAME: read_file
BEGIN_ARG: path
src/second.ts
END_ARG
\`\`\`
      `.trim();

      const result = parsePhotonBlocks(text, specs);
      assert.equal(result.calls.length, 2);
      assert.equal(result.calls[0].args.path, "src/first.ts");
      assert.equal(result.calls[1].args.path, "src/second.ts");
    });

    it("handles escaped \\END_ARG and \\BEGIN_ARG inside file content without premature termination", () => {
      const text = `
\`\`\`tool
TOOL_NAME: write_file
BEGIN_ARG: path
src/parser-doc.md
END_ARG
BEGIN_ARG: content
Here is how delimiters work:
\\BEGIN_ARG: example
Inside content
\\END_ARG
Final line of file.
END_ARG
\`\`\`
      `.trim();

      const result = parsePhotonBlocks(text, specs);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].name, "write_file");
      assert.equal(result.calls[0].args.path, "src/parser-doc.md");
      const content = String(result.calls[0].args.content);
      assert.ok(content.includes("BEGIN_ARG: example"));
      assert.ok(content.includes("END_ARG"));
      assert.ok(content.includes("Final line of file."));
    });

    it("does not prematurely trigger a truncated tool call on partial streaming output with unclosed BEGIN_ARG", () => {
      const partialStream = `
I will update the file now:
\`\`\`tool
TOOL_NAME: write_file
BEGIN_ARG: path
src/index.ts
END_ARG
BEGIN_ARG: content
export function hello() {
  return "still streaming...
      `.trim();

      const result = parsePhotonBlocks(partialStream, specs);
      assert.equal(result.calls.length, 0, "Should wait until BEGIN_ARG is closed by END_ARG");
    });

    it("never triggers tool calls from arbitrary JSON, package.json snippets, or code fences in prose", () => {
      const proseWithCodeAndJson = `
Here is an example \`package.json\` file:

\`\`\`json
{
  "name": "view",
  "version": "1.0.0",
  "path": "dist/index.js"
}
\`\`\`

And here is a TypeScript example showing how Photon parses blocks:

\`\`\`ts
const example = \`
TOOL_NAME: read_file
BEGIN_ARG: path
src/secret.ts
END_ARG
\`;
\`\`\`

Also in plain JSON prose: {"name": "read", "description": "just a normal object"}
      `.trim();

      const result = parsePhotonBlocks(proseWithCodeAndJson, specs);
      assert.equal(result.calls.length, 0, "Arbitrary code fences and JSON objects must not trigger tools");
    });
  });
});
