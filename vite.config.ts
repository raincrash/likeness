import { defineConfig } from "vite";

// The demo app. Relative base so the build also works from a subpath.
// es2022: the demo uses top-level await. dist/app keeps it apart from the library builds.
export default defineConfig({ base: "./", build: { target: "es2022", outDir: "dist/app" } });
