import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("next (turbopack)", () => {
  test(
    "without maps, turbopack modules, pages router and lazy loaders are recovered",
    async () => {
      const server = serve("site-next-turbopack", { mount: BASE, serveMaps: false });
      const { outDir, manifest } = await runOn(server.url, { webcrack: false });
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.bundler.adapter).toBe("next");
      expect(manifest.coverage.status).toBe("complete");
      expect(manifest.summary.degraded).toBe(0);
      expect(await read(outDir, modulePath(manifest, "summarize"))).toContain("UNBUNDLE_LAZY_CHUNK");
      expect(await read(outDir, "src/utils/clamp.js")).toContain("UNBUNDLE_ONE_ITEM");
      expect(modulePath(manifest, "GreetPage")).toMatch(/^src\/pages\/GreetPage\.jsx?$/);
      expect(manifest.modules.find((m) => /^(SiteNav|RootLayoutClient)$/.test(m.name))?.localPath).toMatch(/^src\/pages\/\w+\.jsx?$/);
      expect(await read(outDir, "src/stores/useTotalStore.js")).toContain("create(");
      const pages = await Array.fromAsync(new Bun.Glob("src/pages/*").scan({ cwd: outDir }));
      const contents = await Promise.all(pages.map((p) => read(outDir, p)));
      expect(contents.some((c) => c.includes("UNBUNDLE_COUNTER_MAX_REACHED"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "with maps, turbopack project paths are normalized",
    async () => {
      const server = serve("site-next-turbopack", { mount: BASE });
      const { outDir } = await runOn(server.url, { webcrack: false, rename: false, format: false, crawlDepth: 0 });
      expect(await read(outDir, "src/lib/math.js")).toContain("export function clamp");
    },
    TIMEOUT,
  );
});
