import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { looksLikeNarration } from "../../src/core/intelligence/policy";
import { toNativeTools } from "../../src/core/protocol/serialize";
import { builtinTools } from "../../src/core/tools/builtin";

describe("Launch Readiness Regression Guards", () => {
  it("looksLikeNarration catches gerund tool narration while ignoring code blocks, lists, and questions", () => {
    assert.equal(looksLikeNarration("Calling edit_file with the extracted old_str and new_str."), true);
    assert.equal(looksLikeNarration("Using write_file to create hello.txt."), true);
    assert.equal(looksLikeNarration("Running run_command to verify the build."), true);

    // Must remain false for legitimate deliverables and questions
    assert.equal(looksLikeNarration("```ts\nCalling edit_file();\n```"), false);
    assert.equal(
      looksLikeNarration("Steps completed:\n1. Calling edit_file updated math.ts\n2. Verified tests"),
      false
    );
    assert.equal(
      looksLikeNarration("Calling edit_file on src/math.ts failed — would you like me to overwrite it?"),
      false
    );
  });

  it("toNativeTools compact mode preserves all tool names & required params while shrinking schema payload >= 40%", () => {
    const specs = builtinTools().map((t) => t.spec);
    const full = toNativeTools(specs) as Array<{
      type: string;
      function: { name: string; description: string; parameters: { required: string[] } };
    }>;
    const compact = toNativeTools(specs, { compact: true, shortlistSize: 5 }) as Array<{
      type: string;
      function: { name: string; description: string; parameters: { required: string[] } };
    }>;

    assert.equal(compact.length, specs.length);
    assert.deepEqual(
      compact.map((t) => t.function.name),
      full.map((t) => t.function.name)
    );
    for (let i = 0; i < full.length; i++) {
      assert.deepEqual(
        compact[i].function.parameters.required,
        full[i].function.parameters.required
      );
    }

    const fullLen = JSON.stringify(full).length;
    const compactLen = JSON.stringify(compact).length;
    const reductionPct = ((fullLen - compactLen) / fullLen) * 100;
    assert.ok(
      reductionPct >= 40,
      `Expected >= 40% compact schema reduction, got ${reductionPct.toFixed(1)}% (${fullLen} -> ${compactLen})`
    );
  });

  it("package.json declares Marketplace icon (>= 128x128 PNG), chatParticipants, and removes dead harness setting", () => {
    const root = path.resolve(__dirname, "../..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

    assert.equal(pkg.icon, "media/icon.png");
    const iconBuf = fs.readFileSync(path.join(root, pkg.icon));
    assert.ok(
      iconBuf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      "media/icon.png must be a valid PNG"
    );
    const width = iconBuf.readUInt32BE(16);
    const height = iconBuf.readUInt32BE(20);
    assert.ok(width >= 128 && height >= 128, `Expected icon >= 128x128, got ${width}x${height}`);

    const participants = pkg.contributes?.chatParticipants as Array<{ id: string }> | undefined;
    assert.ok(Array.isArray(participants), "contributes.chatParticipants must be declared");
    assert.ok(
      participants.some((p) => p.id === "photon"),
      "contributes.chatParticipants must include id 'photon'"
    );

    const props = pkg.contributes?.configuration?.properties ?? {};
    assert.equal("photon.experimental.harness" in props, false);
  });
});
