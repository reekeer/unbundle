import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("meta-frameworks", () => {
  test(
    "react router 7 (framework mode): route modules land under routes/ with their route exports",
    async () => {
      const { outDir, manifest } = await runOn(serve("site-rr7", { serveMaps: false }).url, { crawlDepth: 1 });
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.bundler.adapter).toBe("react-router");
      expect(manifest.coverage.status).toBe("complete");
      const home = await read(outDir, "src/routes/home.jsx");
      expect(home).toContain("RR7_HOME_TITLE");
      expect(home).toMatch(/function meta\(\)/);
      expect(home).toContain('import { useState } from "react";');
      const about = await read(outDir, "src/routes/about.jsx");
      expect(about).toContain("async function clientLoader()");
      expect(about).toContain("RR7_LOADER_MESSAGE");
      const root = await read(outDir, "src/root.jsx");
      expect(root).toContain("function Layout({ children })");
      expect(root).toContain("<NavLink to=\"/about\">About</NavLink>");
    },
    TIMEOUT,
  );

  test(
    "sveltekit: nodes follow the route dictionary (routes/+page, +layout, +error)",
    async () => {
      const { outDir, manifest } = await runOn(serve("site-sveltekit", { serveMaps: false }).url, { crawlDepth: 1 });
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.bundler.adapter).toBe("sveltekit");
      expect(manifest.coverage.status).toBe("complete");
      for (const file of ["src/routes/+page.js", "src/routes/about/+page.js", "src/routes/+layout.js", "src/routes/+error.js"]) expect(await exists(outDir, file)).toBe(true);
      const page = await read(outDir, "src/routes/+page.js");
      expect(page).toContain("KIT_HOME_TITLE");
      expect(page).toContain("export { IndexPage as component };");
      expect(page).toMatch(/set_text\(\w+, `KIT_COUNT/);
      expect(await read(outDir, "src/routes/about/+page.js")).toContain("KIT_ABOUT_TITLE");
    },
    TIMEOUT,
  );
});
