import { afterAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { read, removeRuns, runOn } from "./support/run.ts";
import { startFixtureServer, type FixtureServer } from "./support/server.ts";

interface Threshold {
  coverage: "complete" | "possibly-incomplete";
  maxDegraded: number;
  minReadableModuleNames: number;
  maxMangledApp: number;
  packages: string[];
  markers: string[];
  minMarkerPrefixCount?: { prefix: string; count: number };
  minPages: number;
  files?: string[];
  contains?: Record<string, string[]>;
  maxLibraryRootFiles?: number;
}

const CORPUS = resolve(process.env.UNBUNDLE_SOURCE_ROOT ?? resolve(import.meta.dir, ".."), ".cache/corpus");
const enabled = process.env.UNBUNDLE_CORPUS === "1";
const thresholds = (await Bun.file(join(import.meta.dir, "corpus-thresholds.json")).json()) as Record<string, Threshold>;
const servers: FixtureServer[] = [];
afterAll(async () => {
  servers.forEach((s) => s.stop());
  await removeRuns();
});

describe.skipIf(!enabled)("corpus of realistic builds", () => {
  for (const [name, expected] of Object.entries(thresholds)) {
    test(
      name,
      async () => {
        const root = join(CORPUS, name, "site");
        if (!(await Bun.file(join(root, "index.html")).exists())) throw new Error(`missing ${root}: run \`bun run corpus\` first`);
        const server = startFixtureServer({ root, serveMaps: false });
        servers.push(server);
        const started = performance.now();
        const { outDir, manifest } = await runOn(server.url, { maxPages: 20, crawlDepth: 2 });
        const quality = manifest.summary.quality;
        const strings = JSON.parse(await read(outDir, ".unbundle/strings.json")) as { strings: Array<{ value: string }> };
        const values = new Set(strings.strings.map((s) => s.value));
        await Bun.write(
          join(CORPUS, name, "metrics.json"),
          JSON.stringify({ seconds: Math.round((performance.now() - started) / 1000), coverage: manifest.coverage.status, degraded: manifest.summary.degraded, modules: manifest.summary.modules, pages: manifest.summary.pages, quality }, null, 2),
        );

        expect(manifest.coverage.status).toBe(expected.coverage);
        expect(manifest.summary.pages).toBeGreaterThanOrEqual(expected.minPages);
        expect(manifest.summary.degraded).toBeLessThanOrEqual(expected.maxDegraded);
        expect(quality.readableModuleNames).toBeGreaterThanOrEqual(expected.minReadableModuleNames);
        expect(quality.mangledIdentifiers.app).toBeLessThanOrEqual(expected.maxMangledApp);
        expect(quality.identifiedPackages).toEqual(expect.arrayContaining(expected.packages));
        for (const marker of expected.markers) expect(values.has(marker)).toBe(true);
        for (const file of expected.files ?? []) expect(await Bun.file(join(outDir, file)).exists()).toBe(true);
        for (const [file, snippets] of Object.entries(expected.contains ?? {})) {
          const text = await read(outDir, file);
          for (const snippet of snippets) expect(text).toContain(snippet);
        }
        if (expected.maxLibraryRootFiles !== undefined) {
          expect(manifest.modules.filter((m) => m.localPath && /^js\/node_modules\/[^/]+\.js$/.test(m.localPath)).length).toBeLessThanOrEqual(expected.maxLibraryRootFiles);
        }
        if (expected.minMarkerPrefixCount) {
          const { prefix, count } = expected.minMarkerPrefixCount;
          expect([...values].filter((v) => v.startsWith(prefix)).length).toBeGreaterThanOrEqual(count);
        }
      },
      900_000,
    );
  }
});
