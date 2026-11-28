import * as fs from "node:fs";
import * as path from "node:path";
import type { LLMChatChunk } from "../../src/core/llm/types";
import type { DiagnosticInfo } from "../../src/core/tools/types";
import type { Mode, TurnReliabilitySummary } from "../../src/shared/types";

export interface EvalExecutedTool {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface EvalVerifyContext {
  repoDir: string;
  assistantText: string;
  executedTools: EvalExecutedTool[];
  telemetry?: TurnReliabilitySummary;
}

export interface EvalTask {
  id: string;
  title: string;
  mode: Mode;
  prompt: string;
  files: Record<string, string>;
  /** Optional custom diagnostics evaluator inspecting sandbox disk state. */
  diagnosticsFn?: (repoDir: string) => DiagnosticInfo[];
  /** Deterministic offline stub output when `web_search` is called. */
  webSearchStubOutput?: string;
  /** Compliant mock response sequence used by automated unit/baseline verification. */
  compliantResponses: LLMChatChunk[][];
  verify: (ctx: EvalVerifyContext) => { passed: boolean; detail: string };
}

function readRel(repoDir: string, rel: string): string {
  const full = path.join(repoDir, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}

function blockChunk(toolName: string, args: Record<string, string>): LLMChatChunk[] {
  const argLines = Object.entries(args)
    .map(([k, v]) => `BEGIN_ARG: ${k}\n${v}\nEND_ARG`)
    .join("\n");
  return [
    { message: { content: `\`\`\`tool\nTOOL_NAME: ${toolName}\n${argLines}\n\`\`\`` } },
    { done: true },
  ];
}

function textChunk(content: string): LLMChatChunk[] {
  return [{ message: { content } }, { done: true }];
}

export const EVAL_TASKS: EvalTask[] = [
  {
    id: "fix-discount-sign",
    title: "Fix sign error in applyDiscount",
    mode: "agent",
    prompt: "Fix the bug in `src/pricing.ts` where `applyDiscount` adds the discount instead of subtracting it.",
    files: {
      "src/pricing.ts": [
        "export function applyDiscount(price: number, discountRate: number): number {",
        "  return price + price * discountRate;",
        "}",
        "",
        "export function applyTax(price: number, taxRate: number): number {",
        "  return price + price * taxRate;",
        "}",
        "",
      ].join("\n"),
    },
    compliantResponses: [
      blockChunk("read_file", { path: "src/pricing.ts" }),
      blockChunk("edit_file", {
        path: "src/pricing.ts",
        old_str: "  return price + price * discountRate;",
        new_str: "  return price - price * discountRate;",
      }),
      textChunk("Fixed `applyDiscount` in `src/pricing.ts` to subtract the discount (`price - price * discountRate`) while leaving `applyTax` unchanged."),
    ],
    verify: ({ repoDir }) => {
      const content = readRel(repoDir, "src/pricing.ts");
      const discountFixed = /return\s+price\s*-\s*price\s*\*\s*discountRate|price\s*\*\s*\(\s*1\s*-\s*discountRate\s*\)/.test(content);
      const taxPreserved = /return\s+price\s*\+\s*price\s*\*\s*taxRate/.test(content);
      return {
        passed: discountFixed && taxPreserved,
        detail: discountFixed && taxPreserved ? "discount subtracted, tax preserved" : "pricing.ts invariant failed",
      };
    },
  },
  {
    id: "fix-off-by-one-pagination",
    title: "Fix 1-based pagination offset",
    mode: "agent",
    prompt: "Fix the 1-based page off-by-one bug in `src/paginate.ts` so `page = 1` starts at index `0`.",
    files: {
      "src/paginate.ts": [
        "export function pageSlice<T>(items: T[], page: number, pageSize: number): T[] {",
        "  const start = page * pageSize;",
        "  return items.slice(start, start + pageSize);",
        "}",
        "",
      ].join("\n"),
    },
    compliantResponses: [
      blockChunk("read_file", { path: "src/paginate.ts" }),
      blockChunk("edit_file", {
        path: "src/paginate.ts",
        old_str: "  const start = page * pageSize;",
        new_str: "  const start = Math.max(0, page - 1) * pageSize;",
      }),
      textChunk("Updated `pageSlice` in `src/paginate.ts` so `page = 1` computes offset `0` via `Math.max(0, page - 1) * pageSize`."),
    ],
    verify: ({ repoDir }) => {
      const content = readRel(repoDir, "src/paginate.ts");
      const fixed = /page\s*-\s*1/.test(content) && /items\.slice\(\s*start\s*,\s*start\s*\+\s*pageSize\s*\)/.test(content);
      return {
        passed: fixed,
        detail: fixed ? "1-based page offset fixed" : "paginate.ts missing (page - 1) * pageSize fix",
      };
    },
  },
  {
    id: "add-timeout-param",
    title: "Add optional timeoutMs parameter",
    mode: "agent",
    prompt: "Add an optional `timeoutMs = 5000` parameter to `getJson` in `src/http.ts` and pass `AbortSignal.timeout(timeoutMs)` to `fetch`.",
    files: {
      "src/http.ts": [
        "export async function getJson(url: string): Promise<unknown> {",
        "  const res = await fetch(url);",
        "  return res.json();",
        "}",
        "",
      ].join("\n"),
    },
    compliantResponses: [
      blockChunk("read_file", { path: "src/http.ts" }),
      blockChunk("edit_file", {
        path: "src/http.ts",
        old_str: "export async function getJson(url: string): Promise<unknown> {\n  const res = await fetch(url);",
        new_str: "export async function getJson(url: string, timeoutMs = 5000): Promise<unknown> {\n  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });",
      }),
      textChunk("Added `timeoutMs = 5000` to `getJson` and passed `{ signal: AbortSignal.timeout(timeoutMs) }` to `fetch` in `src/http.ts`."),
    ],
    verify: ({ repoDir }) => {
      const content = readRel(repoDir, "src/http.ts");
      const hasParam = /timeoutMs\s*(?::\s*number)?\s*=\s*5000/.test(content);
      const hasSignal = /AbortSignal\.timeout\(\s*timeoutMs\s*\)/.test(content);
      return {
        passed: hasParam && hasSignal,
        detail: hasParam && hasSignal ? "timeoutMs param + AbortSignal.timeout present" : "http.ts missing timeoutMs or AbortSignal.timeout",
      };
    },
  },
  {
    id: "rename-symbol-multi-file",
    title: "Rename symbol across two files",
    mode: "agent",
    prompt: "Rename `fetchAccount` to `getAccount` across `src/user.ts` and `src/routes.ts`.",
    files: {
      "src/user.ts": [
        "export function fetchAccount(id: string) {",
        "  return { id, active: true };",
        "}",
        "",
      ].join("\n"),
      "src/routes.ts": [
        'import { fetchAccount } from "./user";',
        "",
        "export function userHandler(id: string) {",
        "  return fetchAccount(id);",
        "}",
        "",
      ].join("\n"),
    },
    compliantResponses: [
      blockChunk("read_file", { path: "src/user.ts" }),
      blockChunk("edit_file", {
        path: "src/user.ts",
        old_str: "export function fetchAccount(id: string) {",
        new_str: "export function getAccount(id: string) {",
      }),
      blockChunk("read_file", { path: "src/routes.ts" }),
      blockChunk("edit_file", {
        path: "src/routes.ts",
        old_str: 'import { fetchAccount } from "./user";\n\nexport function userHandler(id: string) {\n  return fetchAccount(id);',
        new_str: 'import { getAccount } from "./user";\n\nexport function userHandler(id: string) {\n  return getAccount(id);',
      }),
      textChunk("Renamed `fetchAccount` to `getAccount` in both `src/user.ts` and `src/routes.ts`."),
    ],
    verify: ({ repoDir }) => {
      const user = readRel(repoDir, "src/user.ts");
      const routes = readRel(repoDir, "src/routes.ts");
      const ok = !user.includes("fetchAccount") && !routes.includes("fetchAccount") && user.includes("getAccount") && routes.includes("getAccount");
      return {
        passed: ok,
        detail: ok ? "symbol renamed cleanly across both files" : "stale fetchAccount or missing getAccount",
      };
    },
  },
  {
    id: "append-changelog-entry",
    title: "Append entry with append_file",
    mode: "agent",
    prompt: "Append a `## 0.2.0` section with `- Added baseline eval harness.` to `CHANGELOG.md` without removing earlier entries.",
    files: {
      "CHANGELOG.md": "# Changelog\n\n## 0.1.0\n- Initial release.\n",
    },
    compliantResponses: [
      blockChunk("read_file", { path: "CHANGELOG.md" }),
      blockChunk("append_file", {
        path: "CHANGELOG.md",
        content: "\n## 0.2.0\n- Added baseline eval harness.\n",
      }),
      textChunk("Appended the `## 0.2.0` release note to `CHANGELOG.md` while keeping `## 0.1.0` intact."),
    ],
    verify: ({ repoDir }) => {
      const content = readRel(repoDir, "CHANGELOG.md");
      const ok =
        content.includes("## 0.1.0") &&
        content.includes("Initial release.") &&
        content.includes("## 0.2.0") &&
        content.includes("- Added baseline eval harness.");
      return {
        passed: ok,
        detail: ok ? "changelog appended cleanly" : "CHANGELOG.md missing prior or appended content",
      };
    },
  },
  {
    id: "create-healthcheck-module",
    title: "Create new healthcheck file",
    mode: "agent",
    prompt: 'Create `src/health.ts` exporting `checkHealth(): { ok: boolean; status: string }` returning `{ ok: true, status: "healthy" }`.',
    files: {
      "src/index.ts": 'export const VERSION = "1.0.0";\n',
    },
    compliantResponses: [
      blockChunk("write_file", {
        path: "src/health.ts",
        content: [
          "export function checkHealth(): { ok: boolean; status: string } {",
          '  return { ok: true, status: "healthy" };',
          "}",
          "",
        ].join("\n"),
      }),
      textChunk("Created `src/health.ts` exporting `checkHealth()`."),
    ],
    verify: ({ repoDir }) => {
      const health = readRel(repoDir, "src/health.ts");
      const idx = readRel(repoDir, "src/index.ts");
      const ok =
        health.includes("export function checkHealth") &&
        health.includes("healthy") &&
        idx === 'export const VERSION = "1.0.0";\n';
      return {
        passed: ok,
        detail: ok ? "src/health.ts created, src/index.ts untouched" : "health.ts missing or index.ts modified",
      };
    },
  },
  {
    id: "recover-wrong-path",
    title: "Locate moved file via search and fix bug",
    mode: "agent",
    prompt: "Inspect `src/utils/math.ts` (if moved inside `src/`, locate it first) and fix the `clamp` upper-bound bug.",
    files: {
      "src/lib/math.ts": [
        "export function clamp(n: number, min: number, max: number): number {",
        "  if (n < min) return min;",
        "  if (n > max) return min;",
        "  return n;",
        "}",
        "",
      ].join("\n"),
    },
    compliantResponses: [
      blockChunk("find_files", { pattern: "*math*" }),
      blockChunk("read_file", { path: "src/lib/math.ts" }),
      blockChunk("edit_file", {
        path: "src/lib/math.ts",
        old_str: "  if (n > max) return min;",
        new_str: "  if (n > max) return max;",
      }),
      textChunk("Located `src/lib/math.ts` and fixed the upper-bound branch to return `max` instead of `min`."),
    ],
    verify: ({ repoDir }) => {
      const moved = readRel(repoDir, "src/lib/math.ts");
      const wrongExists = fs.existsSync(path.join(repoDir, "src/utils/math.ts"));
      const ok = !wrongExists && /if\s*\(\s*n\s*>\s*max\s*\)\s*return\s+max/.test(moved);
      return {
        passed: ok,
        detail: ok ? "found src/lib/math.ts and fixed clamp" : "clamp unfixed or wrong path created",
      };
    },
  },
  {
    id: "explain-auth-flow",
    title: "Read-only explanation in Chat mode",
    mode: "chat",
    prompt: "Explain how `verifyToken` in `src/auth.ts` validates tokens.",
    files: {
      "src/auth.ts": [
        "export function verifyToken(token: string): boolean {",
        '  return token.startsWith("ph_") && token.length > 10;',
        "}",
        "",
      ].join("\n"),
    },
    compliantResponses: [
      blockChunk("read_file", { path: "src/auth.ts" }),
      textChunk('`verifyToken` in `src/auth.ts` returns `true` only when `token` starts with `"ph_"` and has length strictly greater than `10`.'),
    ],
    verify: ({ repoDir, assistantText, executedTools }) => {
      const diskOk = readRel(repoDir, "src/auth.ts").includes('token.startsWith("ph_")');
      const readRan = executedTools.some((t) => t.name === "read_file" && t.ok);
      const answered = assistantText.includes("ph_") && assistantText.includes("10");
      return {
        passed: diskOk && readRan && answered,
        detail: diskOk && readRan && answered ? "read and explained verifyToken" : "missing read or grounded explanation",
      };
    },
  },
  {
    id: "chat-readonly-guard",
    title: "Chat mode must not write files on edit request",
    mode: "chat",
    prompt: "Please update `RETRIES` to `5` in `src/config.ts`.",
    files: {
      "src/config.ts": "export const RETRIES = 2;\n",
    },
    compliantResponses: [
      blockChunk("read_file", { path: "src/config.ts" }),
      textChunk(
        "Chat mode is read-only, so I cannot modify `src/config.ts` directly. Update it manually:\n\n```ts\nexport const RETRIES = 5;\n```\n\nSwitch to **Agent** mode if you want me to apply this edit directly."
      ),
    ],
    verify: ({ repoDir, assistantText }) => {
      const untouched = readRel(repoDir, "src/config.ts") === "export const RETRIES = 2;\n";
      const guided = assistantText.includes("RETRIES = 5") && /\bagent\b/i.test(assistantText);
      return {
        passed: untouched && guided,
        detail: untouched && guided ? "read-only preserved with manual steps + Agent suggestion" : "file altered or guidance missing",
      };
    },
  },
  {
    id: "plan-multi-file-feature",
    title: "Read-only Plan across two files",
    mode: "plan",
    prompt: "Create a step-by-step plan to add caching for `fetchUser` across `src/api.ts` and `src/store.ts`.",
    files: {
      "src/api.ts": "export async function fetchUser(id: string) {\n  return { id };\n}\n",
      "src/store.ts": "export const userCache = new Map<string, unknown>();\n",
    },
    compliantResponses: [
      blockChunk("read_file", { path: "src/api.ts" }),
      blockChunk("read_file", { path: "src/store.ts" }),
      textChunk(
        [
          "1. Inspect `userCache` in `src/store.ts` and define typed helpers `getCachedUser`/`setCachedUser`.",
          "2. Update `fetchUser` in `src/api.ts` to check `userCache` before fetching and populate it on miss.",
          "3. Verify with `get_diagnostics` and unit tests before concluding, then switch to Agent mode to apply.",
        ].join("\n")
      ),
    ],
    verify: ({ repoDir, assistantText }) => {
      const apiUntouched = readRel(repoDir, "src/api.ts").includes("return { id };");
      const storeUntouched = readRel(repoDir, "src/store.ts").includes("userCache");
      const structured =
        /1\./.test(assistantText) &&
        assistantText.includes("src/api.ts") &&
        assistantText.includes("src/store.ts");
      return {
        passed: apiUntouched && storeUntouched && structured,
        detail: apiUntouched && storeUntouched && structured ? "read-only plan references both files" : "plan missing file refs or files altered",
      };
    },
  },
  {
    id: "fresh-info-web-search",
    title: "Live/external info request routes through web_search",
    mode: "chat",
    prompt: "What is the current weather in Tokyo today?",
    files: {
      "README.md": "# Sample Project\n",
    },
    webSearchStubOutput: "Tokyo, Japan current weather: 18°C, Clear sky, Humidity 48% (observed 2026-11-25).",
    compliantResponses: [
      blockChunk("web_search", { query: "current weather in Tokyo today" }),
      textChunk("According to `web_search`, the current weather in Tokyo is **18°C** with a **Clear** sky (48% humidity)."),
    ],
    verify: ({ assistantText, executedTools }) => {
      const searched = executedTools.some((t) => t.name === "web_search" && t.ok);
      const grounded = assistantText.includes("18") && /tokyo/i.test(assistantText) && /clear/i.test(assistantText);
      return {
        passed: searched && grounded,
        detail: searched && grounded ? "web_search used and answer grounded" : "missing web_search call or grounded facts",
      };
    },
  },
  {
    id: "diagnose-and-verify-bug",
    title: "Fix type bug and verify with get_diagnostics",
    mode: "agent",
    prompt: "Fix the type error in `src/validator.ts` and run `get_diagnostics` to verify zero errors remain.",
    files: {
      "src/validator.ts": [
        "export function isPortValid(port: number): boolean {",
        "  const ok: string = port >= 1 && port <= 65535;",
        "  return Boolean(ok);",
        "}",
        "",
      ].join("\n"),
    },
    diagnosticsFn: (repoDir) => {
      const content = readRel(repoDir, "src/validator.ts");
      if (content.includes("const ok: string")) {
        return [
          {
            file: "src/validator.ts",
            line: 2,
            col: 9,
            severity: "error",
            message: "Type 'boolean' is not assignable to type 'string'.",
            source: "ts",
          },
        ];
      }
      return [];
    },
    compliantResponses: [
      blockChunk("read_file", { path: "src/validator.ts" }),
      blockChunk("edit_file", {
        path: "src/validator.ts",
        old_str: "  const ok: string = port >= 1 && port <= 65535;",
        new_str: "  const ok: boolean = port >= 1 && port <= 65535;",
      }),
      blockChunk("get_diagnostics", { path: "src/validator.ts" }),
      textChunk("Fixed the type annotation in `src/validator.ts` (`const ok: boolean`) and verified via `get_diagnostics` that 0 errors remain."),
    ],
    verify: ({ repoDir, executedTools }) => {
      const content = readRel(repoDir, "src/validator.ts");
      const fixed = content.includes("const ok: boolean");
      const verified = executedTools.some((t) => t.name === "get_diagnostics" && t.ok);
      return {
        passed: fixed && verified,
        detail: fixed && verified ? "validator.ts fixed and diagnostics verified" : "validator.ts unfixed or diagnostics not verified",
      };
    },
  },
];
