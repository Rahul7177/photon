import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The webview UI is a standalone React app bundled into dist/webview/,
// then loaded by the extension host inside a VS Code WebviewView.
export default defineConfig({
  root: resolve(__dirname, "webview-ui"),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/webview"),
    emptyOutDir: true,
    // Single deterministic filenames so the extension can reference them
    // without parsing a manifest.
    rollupOptions: {
      input: resolve(__dirname, "webview-ui/index.html"),
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
    target: "es2020",
    sourcemap: true,
  },
});
