import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("coverage", () => {
  test(
    "a lazy chunk that cannot be loaded makes the result visibly incomplete",
    async () => {
      const probe = await runOn(serve("site-next", { mount: BASE, serveMaps: false }).url, { webcrack: false, rename: false, format: false });
      const lazy = probe.manifest.modules.find((m) => m.name === "summarize")!;
      const chunk = new URL(lazy.chunkUrl).pathname.split("/").pop()!;
      const server = serve("site-next", { mount: BASE, serveMaps: false, fail: (p) => (p.endsWith(`/${chunk}`) ? 404 : null) });
      const { outDir, manifest } = await runOn(server.url, { webcrack: false, format: false });
      expect(manifest.coverage.status).toBe("possibly-incomplete");
      expect(manifest.coverage.failedResources.some((u) => u.endsWith(`/${chunk}`))).toBe(true);
      const missing = manifest.coverage.missingModules.find((m) => m.missingId === lazy.id);
      expect(missing).toBeDefined();
      expect(await read(outDir, missing!.module)).toContain(`_missing/module-${lazy.id}.js`);
      expect(await read(outDir, `src/_chunks/_missing/module-${lazy.id}.js`)).toContain("was not loaded");
      expect(await read(outDir, "src/_chunks/_missing/README.md")).toContain(`module ${lazy.id}`);
    },
    TIMEOUT,
  );

  test(
    "unknown runtime loaders on a plain site are reported with file and line",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "unbundle-loader-site-"));
      await Bun.write(
        join(root, "index.html"),
        `<!doctype html><html><head><script src="/app.js"></script></head><body><script>
var flag = location.hash; var s = document.createElement("script"); s.src = "/feature-" + flag + ".js"; document.head.appendChild(s);
</script></body></html>`,
      );
      await Bun.write(join(root, "app.js"), `window.boot = function (name) { return import("/pages/" + name + ".js"); };\nwindow.hint = "/static/extra.js";\n`);
      const server = serveDirectory(root);
      const { manifest } = await runOn(server.url, { webcrack: false, rename: false, format: false, crawlDepth: 0 });
      expect(manifest.bundler.adapter).toBeNull();
      expect(manifest.coverage.status).toBe("possibly-incomplete");
      const kinds = manifest.coverage.unresolvedLoaders.map((l) => `${l.kind} ${l.file}`);
      expect(kinds).toContain("script-element src/_chunks/scripts/inline/index-1.js");
      expect(kinds).toContain("dynamic-import src/app.js");
      expect(manifest.coverage.unresolvedLoaders.every((l) => l.line > 0 && l.snippet.length > 0)).toBe(true);
      expect(manifest.coverage.seenButNotLoaded.map((u) => new URL(u.url).pathname)).toEqual(["/static/extra.js"]);
      await rm(root, { recursive: true, force: true });
    },
    TIMEOUT,
  );
});
