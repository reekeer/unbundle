import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("webpack and rspack (CRA-style SPA)", () => {
  const spa = (fixture: string) => runOn(serve(fixture, { serveMaps: false }).url, { crawlDepth: 0 });

  test(
    "webpack 5: commonjs wrappers and a JSONP lazy chunk",
    async () => {
      const { outDir, manifest } = await spa("site-webpack");
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.bundler).toMatchObject({ adapter: "webpack" });
      expect(manifest.coverage.status).toBe("complete");
      for (const pkg of ["react", "react-dom", "scheduler"]) expect(identified(manifest).has(pkg)).toBe(true);
      const main = await read(outDir, "src/main.js");
      expect(main).toContain('import { createRoot } from "react-dom/client";');
      expect(main).toContain('import { App } from "@/App.js";');
      const app = await read(outDir, "src/App.js");
      expect(app).toContain("WEBPACK_FIXTURE_TITLE");
      expect(app).toContain('await import("@/utils/summarize.js")');
      expect(await read(outDir, "src/utils/summarize.js")).toContain("WEBPACK_LAZY_CHUNK");
    },
    TIMEOUT,
  );

  test(
    "rspack: its own runtime is recognized, the module map in the bootstrap bundle is unpacked",
    async () => {
      const { outDir, manifest } = await spa("site-rspack");
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.bundler.adapter).toBe("rspack");
      expect(manifest.bundler.evidence.join(" ")).toContain("bundler=rspack@");
      expect(manifest.coverage.status).toBe("complete");
      for (const pkg of ["react", "react-dom", "scheduler"]) expect(identified(manifest).has(pkg)).toBe(true);
      const app = await read(outDir, "src/App.js");
      expect(app).toContain("WEBPACK_FIXTURE_TITLE");
      expect(app).toContain('import { useTotalStore } from "@/stores/useTotalStore.js";');
      expect(await read(outDir, "src/stores/useTotalStore.js")).toContain('import { create } from "zustand";');
      expect(await read(outDir, "src/utils/summarize.js")).toContain("WEBPACK_LAZY_CHUNK");
    },
    TIMEOUT,
  );
});
