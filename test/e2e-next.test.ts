import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("next (webpack, basePath /t/tttt)", () => {
  test(
    "pages router: routes reachable only from code are found, page modules are named",
    async () => {
      const { outDir, manifest } = await runSite("site-next", { mount: BASE, serveMaps: false });
      expect(await exists(outDir, ".chunks/html/greet/settings.html")).toBe(true);
      expect(manifest.files.some((f) => /_buildManifest\.js$/.test(f.url) && f.status === "ok")).toBe(true);
      expect(modulePath(manifest, "GreetSettingsPage")).toBe("src/pages/GreetSettingsPage.jsx");
      const settings = await read(outDir, modulePath(manifest, "GreetSettingsPage"));
      expect(settings).toContain("export default function GreetSettingsPage");
      expect(settings).toContain("PAGES_ROUTER_SETTINGS_MARKER");
      expect(settings).toMatch(/await import\("@\/utils\/buildReport\.js"\)/);
      expect(await read(outDir, modulePath(manifest, "GreetPage"))).toContain("PAGES_ROUTER_HELLO");
      expect(await read(outDir, modulePath(manifest, "buildReport"))).toContain("PAGES_ROUTER_LAZY_REPORT");
    },
    TIMEOUT,
  );

  test(
    "without maps, under a sub-path: modules unpacked, named, laid out by kind",
    async () => {
      const { outDir, manifest } = await runSite("site-next", { mount: BASE, serveMaps: false });
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.summary.sourceMaps.maps).toBe(0);
      expect(manifest.summary.degraded).toBe(0);
      expect(manifest.coverage).toMatchObject({ status: "complete", unresolvedLoaders: [], missingModules: [], unfetchedChunkIds: [], seenButNotLoaded: [], failedResources: [] });
      expect(manifest.files.filter((f) => f.via === "unpack").every((f) => f.parse === "full" && f.localPath?.startsWith(".chunks/_next/static/chunks/"))).toBe(true);
      expect(manifest.summary.quality.boilerplate.defineExports).toBe(0);
      for (const pkg of ["react", "react-dom", "scheduler", "next", "@tanstack/query-core", "@tanstack/react-query"]) expect(identified(manifest).has(pkg)).toBe(true);
      expect(manifest.summary.quality.identifiedPackages).toEqual(expect.arrayContaining(["zustand", "lucide-react", "@radix-ui/react-slot"]));

      const counter = await read(outDir, modulePath(manifest, "Counter"));
      expect(modulePath(manifest, "Counter")).toBe("src/pages/Counter.jsx");
      expect(counter).toContain("export default function Counter");
      expect(counter).toContain("<strong>UNBUNDLE_COUNTER_MAX_REACHED</strong>");
      expect(counter).toContain('import { clamp, formatValue } from "@/utils/clamp.js";');
      expect(counter).toContain("setState((prev) => clamp(prev - 1, 0, 10))");
      expect(counter).toMatch(/var Slot = createSlot\("Slot"\)/);
      expect(counter).toContain("useBaseQuery(");
      const math = await read(outDir, "src/utils/clamp.js");
      expect(math).toMatch(/^export function clamp\(/m);
      expect(math).toContain("UNBUNDLE_ONE_ITEM");

      const todo = await read(outDir, modulePath(manifest, "AboutPageClient"));
      expect(todo).toContain('import { useTotalStore } from "@/stores/useTotalStore.js";');
      expect(todo).toMatch(/await import\("@\/utils\/summarize\.js"\)/);
      expect(todo).toContain("setItems((prevItems) =>");
      expect(await read(outDir, "src/stores/useTotalStore.js")).toContain('import { create } from "zustand";');
      expect(await read(outDir, modulePath(manifest, "summarize"))).toContain("export function summarize(items)");

      expect(modulePath(manifest, "react")).toBe("vendor/react/index.js");
      expect(await read(outDir, "vendor/next/dist/client/normalize-trailing-slash.js")).toContain("export let normalizePathTrailingSlash");
      expect(manifest.modules.filter((m) => m.localPath && /^vendor\/[^/]+\.js$/.test(m.localPath)).length).toBeLessThanOrEqual(10);
      expect(manifest.modules.filter((m) => m.localPath?.startsWith("vendor/next/dist/client/")).length).toBeGreaterThan(50);

      const strings = JSON.parse(await read(outDir, ".unbundle/strings.json")) as { strings: Array<{ value: string; locations: string[] }> };
      expect(strings.strings.some((s) => s.value === "UNBUNDLE_TODO_OVERFLOW")).toBe(true);
      expect(await read(outDir, ".chunks/html/index.rsc.txt")).toContain("static/chunks/app/page-");
    },
    TIMEOUT,
  );
});
