import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("--standalone (Next.js App Router)", () => {
  const annotated = async (outDir: string, page: string) => {
    const { parse } = await import("node-html-parser");
    const root = parse(await read(outDir, `html/${page}.standalone.html`));
    return {
      root,
      marks: root.querySelectorAll("main [data-component], main[data-component]").map((e) => ({
        node: `${e.rawTagName.toLowerCase()}.${e.getAttribute("class")}`,
        component: e.getAttribute("data-component")!,
        src: e.getAttribute("data-component-src") ?? null,
      })),
    };
  };

  test(
    "client component boundaries are annotated exactly, server markup stays untouched",
    async () => {
      const server = serve("site-next", { mount: BASE, serveMaps: false });
      const { outDir, manifest } = await runOn(server.url, { standalone: true, webcrack: false, crawlDepth: 1 });
      const page = (path: string) => manifest.files.find((f) => f.type === "document" && new URL(f.url).pathname.replace(/\/$/, "") === `${BASE}${path}`)!.standalone!;

      const single = await annotated(outDir, "single");
      expect(single.marks.map((m) => m.node)).toEqual(["span.badge"]);
      expect(await exists(outDir, single.marks[0]!.src!)).toBe(true);

      const siblings = await annotated(outDir, "siblings");
      expect(siblings.marks.map((m) => m.node)).toEqual(["dt.pair-term", "dd.pair-detail"]);
      expect(new Set(siblings.marks.map((m) => m.component)).size).toBe(1);

      expect(page("/server")).toMatchObject({ status: "annotated" });
      expect((await annotated(outDir, "server")).marks.every((m) => !m.node.includes("server-card"))).toBe(true);

      const nested = await annotated(outDir, "nested");
      expect(nested.marks.map((m) => m.node)).toEqual(expect.arrayContaining(["section.outer", "em.inner"]));
      expect(nested.root.querySelector("p.server-inside")!.getAttribute("data-component")).toBeUndefined();

      expect(page("/empty").unaligned?.some((u) => u.reason.includes("renders no host element"))).toBe(true);
      expect(page("/single").unaligned?.some((u) => u.reason.includes("a provider"))).toBe(true);
      expect((await read(outDir, "html/single.standalone.html"))).toMatch(/<nav[^>]*data-component=/);

      const deferred = await annotated(outDir, "deferred");
      expect(deferred.marks.map((m) => m.node)).toContain("b.late");
      const html = await read(outDir, "html/deferred.standalone.html");
      expect(html).toContain('<div class="slow">');
      expect(html).not.toContain("RSC_LOADING");
      expect(html).not.toContain('id="S:0"');
      expect(await read(outDir, ".chunks/html/deferred.html")).toContain("RSC_LOADING");
      const readable = await read(outDir, "html/deferred.html");
      expect(readable).toContain('<div class="slow">');
      expect(readable).not.toContain("RSC_LOADING");
      expect(readable).not.toContain("self.__next_f");
      expect(readable).not.toMatch(/rel="preload"/);

      const index = await read(outDir, "html/index.standalone.html");
      expect(index).toMatch(/^<!doctype html>\s*<!--\s*unbundle --standalone/i);
      expect(index).toMatch(/Styling: Tailwind CSS v4\.\d+\.\d+/);
      expect(index).toContain('href="../src/assets/css/tailwind.css"');
      expect(index).toContain('class="bg-white text-slate-900 antialiased"');
      const tailwind = await read(outDir, "src/assets/css/tailwind.css");
      expect(tailwind.split("\n").length).toBeLessThan(5);
      const css = await read(outDir, "src/assets/css/app.css");
      expect(css).toContain(".badge");
      expect(css).toContain(".site-header");
      expect(css).not.toContain("--tw-");
    },
    TIMEOUT,
  );

  test(
    "pages without a Flight payload are reported, never emitted as a plain copy",
    async () => {
      const cases: Array<[string, string, string]> = [
        ["site-next", `${BASE}/greet`, "Pages Router"],
        ["site-vite", "", "vite"],
      ];
      for (const [fixture, path, reason] of cases) {
        const server = serve(fixture, { serveMaps: false, ...(fixture === "site-next" ? { mount: BASE } : {}) });
        const url = fixture === "site-next" ? `${server.url.replace(BASE, "")}${path}` : server.url;
        const { outDir, manifest } = await runOn(url, { standalone: true, webcrack: false, rename: false, format: false, crawlDepth: 0 });
        const home = manifest.files.find((f) => f.type === "document")!;
        expect(home.standalone?.status).toBe("not-applicable");
        expect(home.standalone?.reason).toContain(reason);
        expect((await Array.fromAsync(new Bun.Glob("html/**/*.standalone.html").scan({ cwd: outDir }))).length).toBe(0);
      }
    },
    TIMEOUT,
  );
});
