import esbuild from "esbuild";
import { rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Engine-boundary guard (Module 6): the orchestration engine in src/core must
// never import `vscode`, so it stays portable to a CLI/JetBrains/Neovim front-end
// without a rewrite. Enforced here in the build — not left to code-review habit.
function assertEngineBoundary(dir = "src/core") {
  const offenders = [];
  const importRe = /\b(?:import|require)\b[^\n;]*['"]vscode['"]/;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && importRe.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk(dir);
  if (offenders.length) {
    console.error(`✘ [ERROR] Engine boundary violated — src/core must not import 'vscode':`);
    for (const f of offenders) console.error(`    ${f}`);
    process.exit(1);
  }
}

assertEngineBoundary();

// Prints markers the "photon: watch:esbuild" task's background problem
// matcher looks for, so VS Code can gate F5 on the *first* build instead of
// re-running a full build on every launch.
const watchLoggerPlugin = {
  name: "photon-watch-logger",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log("[watch] build finished");
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  plugins: watch ? [watchLoggerPlugin] : [],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[photon] esbuild watching…");
} else {
  // esbuild won't remove a stale sourcemap left by an earlier --watch run
  // when sourcemap:false is requested now — clean it up so it never ships.
  rmSync("dist/extension.js.map", { force: true });
  await esbuild.build(options);
  console.log("[photon] extension host bundled.");
}
