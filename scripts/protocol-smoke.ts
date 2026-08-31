import assert from "node:assert/strict";
import { parsePhotonBlocks } from "../src/core/protocol/parse";
import { builtinTools } from "../src/core/tools/builtin";

const specs = builtinTools.map((t) => t.spec);

const python = `[TOOL write_file]\npath: factorial.py\ncontent: |\ndef factorial(n):\n    result = 1\n    for i in range(1, n + 1):\n        result *= i\n    return result\n[/TOOL]`;
const parsed = parsePhotonBlocks(python, specs);
assert.equal(parsed.calls.length, 1);
assert.equal(parsed.calls[0].name, "write_file");
assert.equal(parsed.calls[0].errors.length, 0);
assert.equal(parsed.calls[0].args.path, "factorial.py");
assert.equal(String(parsed.calls[0].args.content), "def factorial(n):\n    result = 1\n    for i in range(1, n + 1):\n        result *= i\n    return result");

const fenced = `[TOOL write_file]\npath: hello.py\ncontent:\n\`\`\`\ndef hello():\n    print(\"hello\")\n\`\`\`\n[/TOOL]`;
const fencedParsed = parsePhotonBlocks(fenced, specs);
assert.equal(fencedParsed.calls.length, 1);
assert.equal(fencedParsed.calls[0].errors.length, 0);
assert.equal(String(fencedParsed.calls[0].args.content), `def hello():\n    print(\"hello\")`);

const alias = `[TOOL write_to_file]\npath: alias.txt\ncontent: |\nhello = world\n[/TOOL]`;
const aliasParsed = parsePhotonBlocks(alias, specs);
assert.equal(aliasParsed.calls.length, 1);
assert.equal(aliasParsed.calls[0].name, "write_file");
assert.equal(String(aliasParsed.calls[0].args.content), "hello = world");

console.log("Photon protocol smoke tests passed.");
