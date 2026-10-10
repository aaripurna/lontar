import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Set by `tauri android dev` / `tauri ios dev` so a physical device can reach the dev server.
const host = process.env.TAURI_DEV_HOST;

// pdf.js loads fonts, character maps, image decoders and colour profiles at runtime by URL.
// Serve them from /pdfjs/<dir>/ in dev and copy them into the build (see src/lib/foliate-pdf.js).
const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];
const PDFJS_SKIP = /^quickjs-/; // the scripting engine; Lontar doesn't run PDF JavaScript

function pdfjsAssets() {
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const files = PDFJS_DIRS.flatMap((dir) =>
    fs
      .readdirSync(path.join(root, dir))
      .filter((name) => !PDFJS_SKIP.test(name))
      .map((name) => `${dir}/${name}`),
  );
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const file = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "");
        if (!files.includes(file)) return next();
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        fs.createReadStream(path.join(root, file)).pipe(res);
      });
    },
    generateBundle() {
      for (const file of files) {
        this.emitFile({
          type: "asset",
          fileName: `pdfjs/${file}`,
          source: fs.readFileSync(path.join(root, file)),
        });
      }
    },
  };
}

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [svelte(), pdfjsAssets()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Android System WebView is Chromium; Tauri's minSdk 24 devices update it via Play / F-Droid.
    target: "chrome105",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // pdf.js is ~700 KB, but it's a separate chunk only loaded when a PDF is opened.
    chunkSizeWarningLimit: 800,
  },
});
