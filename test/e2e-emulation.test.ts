import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("browser emulation", () => {
  test(
    "requests look like Chrome and are logged to network.har",
    async () => {
      const { outDir, manifest, url } = await runSite("site-next", { mount: BASE, serveMaps: false }, { webcrack: false, rename: false, format: false, crawlDepth: 0 });
      const har = JSON.parse(await read(outDir, ".unbundle/network.har")) as {
        log: { entries: Array<{ request: { url: string; headers: Array<{ name: string; value: string }> }; response: { status: number }; _resourceType: string }> };
      };
      expect(har.log.entries.length).toBe(manifest.summary.requests);
      const doc = har.log.entries.find((e) => e._resourceType === "document")!;
      expect(doc.request.headers.map((h) => h.name).slice(0, 4)).toEqual(["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests"]);
      expect(doc.request.headers.find((h) => h.name === "sec-fetch-mode")?.value).toBe("navigate");
      const script = har.log.entries.find((e) => e._resourceType === "script")!;
      expect(script.request.headers.find((h) => h.name === "sec-fetch-dest")?.value).toBe("script");
      expect(script.request.headers.find((h) => h.name === "referer")?.value).toBe(`${url}`);
    },
    TIMEOUT,
  );
});

describe("resilience", () => {
  test(
    "a failing chunk is reported, the run still completes",
    async () => {
      const probe = await runSite("site-next", { mount: BASE, serveMaps: false }, { webcrack: false, rename: false, format: false, crawlDepth: 0 });
      const shared = probe.manifest.files.find((f) => /\/chunks\/\d+-[\w]+\.js$/.test(f.url) && f.status === "ok")!;
      const name = new URL(shared.url).pathname.split("/").pop()!;
      const server = serve("site-next", { mount: BASE, serveMaps: false, fail: (p) => (p.endsWith(`/${name}`) ? 500 : null) });
      const { manifest } = await runOn(server.url, { webcrack: false, rename: false, format: false, crawlDepth: 0 });
      const failed = manifest.files.find((f) => f.url.endsWith(`/${name}`));
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toContain("500");
      expect(manifest.errors.some((e) => e.url?.endsWith(`/${name}`))).toBe(true);
      expect(manifest.files.some((f) => f.url.includes("/app/page-") && f.status === "ok")).toBe(true);
    },
    TIMEOUT,
  );
});
