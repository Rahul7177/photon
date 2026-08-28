// The "photon-block" tool protocol.
//
// Design goals for weak local models:
//   * ASCII, bracket-tagged, flat key:value body — no nested JSON to malform.
//   * One obvious opening/closing marker the model can memorize.
//   * A parser that tolerates casing, quotes, `=` vs `:`, and missing close tags.
//
// A call looks like:
//
//   [TOOL read_file]
//   path: src/index.ts
//   [/TOOL]
//
// A multi-line argument (e.g. file content) uses a fenced block:
//
//   [TOOL write_file]
//   path: src/hello.ts
//   content:
//   ```
//   export const hi = () => "hi";
//   ```
//   [/TOOL]

export const OPEN_RE = /\[TOOL[:\s]+([a-z0-9_-]+)\s*\]/gi;
export const CLOSE_TAG = "[/TOOL]";

/** Matches a complete tool block; group 1 = name, group 2 = body. */
export const BLOCK_RE = /\[TOOL[:\s]+([a-z0-9_-]+)\s*\]([\s\S]*?)\[\/TOOL\]/gi;

/** A block opened but (due to truncation) never closed — captured to end. */
export const OPEN_UNCLOSED_RE = /\[TOOL[:\s]+([a-z0-9_-]+)\s*\]([\s\S]*)$/i;
