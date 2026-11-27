import { defineConfig } from "vite";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Library builds.
 *   vite build -c vite.lib.config.ts                     -> dist/lib: ES modules, three/MediaPipe/three-vrm external
 *   vite build -c vite.lib.config.ts --mode standalone   -> dist/standalone: everything bundled, for <script type="module">
 * Both copy the data files (face model, hand models) to <outDir>/assets.
 */
export default defineConfig(({ mode }) => {
  const standalone = mode === "standalone";
  const outDir = resolve(__dirname, standalone ? "dist/standalone" : "dist/lib");
  return {
    publicDir: false,
    // Relative URLs (the worker), so the build works from any folder.
    base: "./",
    // The MediaPipe worker: an ES module at a fixed name in assets/, found through the asset base like the data files.
    worker: { format: "es", rollupOptions: { output: { entryFileNames: "assets/detect-worker.js", chunkFileNames: "assets/detect-worker-[hash].js" } } },
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2020",
      // Maps for the module build (debugging in apps); the standalone build stays lean.
      sourcemap: !standalone,
      lib: {
        entry: {
          likeness: resolve(__dirname, "src/lib.ts"),
          tracking: resolve(__dirname, "src/lib-tracking.ts"),
          element: resolve(__dirname, "src/lib-element.ts"),
          vrm: resolve(__dirname, "src/lib-vrm.ts"),
        },
        formats: ["es"],
      },
      rollupOptions: {
        external: standalone ? [] : [/^three($|\/)/, /^@mediapipe\//, /^@pixiv\//],
        // Keep chunks next to the entries: lib-assets resolves "./assets/" from its own chunk URL.
        output: { chunkFileNames: "[name]-[hash].js" },
      },
    },
    plugins: [
      {
        name: "likeness-assets",
        closeBundle() {
          const assets = resolve(outDir, "assets");
          mkdirSync(assets, { recursive: true });
          for (const dir of ["ict", "hands"]) cpSync(resolve(__dirname, "public", dir), resolve(assets, dir), { recursive: true });
        },
      },
    ],
  };
});
