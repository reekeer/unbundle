import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("next (webpack, basePath /t/tttt)", () => {
  test(
    "source maps give back the original tree",
    async () => {
      const server = serve("site-next", { mount: BASE });
      const { outDir, manifest } = await runOn(server.url, { crawlDepth: 1 });
      expect(manifest.bundler.adapter).toBe("next");
      expect(manifest.summary.sourceMaps.maps).toBeGreaterThan(0);
      expect(await read(outDir, "src/components/Counter.jsx")).toContain("export default function Counter");
      expect(await read(outDir, "src/lib/heavy.js")).toContain("UNBUNDLE_LAZY_CHUNK");
      const page = manifest.files.find((f) => f.url.includes("/app/page-"))!;
      expect(page.via).toBe("sourcemap");
      expect(page.localPath!.startsWith(".chunks/_next/static/chunks/app/page-")).toBe(true);
      expect(await exists(outDir, `${page.localPath}.map`)).toBe(true);
      for (const file of [".unbundle/manifest.json", ".unbundle/strings.json", ".unbundle/network.har", ".chunks/html/index.html", ".chunks/html/about.html"]) expect(await exists(outDir, file)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "lucide icons, own SVG icons, next/link and next/image read like the source; pages are clean HTML",
    async () => {
      const server = serve("site-next", { mount: BASE, serveMaps: false });
      const { outDir, manifest } = await runOn(server.url, { crawlDepth: 1 });
      const toolbar = await read(outDir, modulePath(manifest, "HomePageClient2"));
      expect(toolbar).toContain('import { Search, Bell, Settings, ArrowRight } from "lucide-react";');
      expect(toolbar).toContain('import Link from "next/link";');
      expect(toolbar).toContain('<ArrowRight className="h-4 w-4" />');
      expect(toolbar).toContain("<Settings size={18} strokeWidth={1.5} />");
      expect(toolbar).toContain('<Link href="/about/"');
      expect(toolbar).not.toMatch(/node:\s*\[/);

      const brand = await read(outDir, modulePath(manifest, "AboutPageClient2"));
      expect(brand).toContain('import { Heart } from "lucide-react";');
      expect(brand).toContain('import Image from "next/image";');
      expect(brand).toContain('import { Logo } from "@/icons/Logo.jsx";');
      expect(brand).toContain('import { Sparkle } from "@/icons/Sparkle.jsx";');
      expect(await read(outDir, "src/icons/Logo.jsx")).toContain('<svg aria-label="Logo"');
      expect(await read(outDir, "src/icons/Sparkle.jsx")).toContain("<title>Sparkle</title>");
      expect(await read(outDir, modulePath(manifest, "SiteNav"))).toContain('import { House, Info } from "lucide-react";');
      expect(manifest.modules.some((m) => m.dropped?.startsWith("icons: imported from"))).toBe(true);
      expect(manifest.modules.map((m) => m.localPath)).toContain("vendor/lucide-react/dist/esm/createLucideIcon.js");

      expect(await exists(outDir, "src/assets/css/tailwind.css")).toBe(true);
      expect(await Array.fromAsync(new Bun.Glob("html/**").scan({ cwd: outDir }))).toEqual([]);
      expect(await read(outDir, ".chunks/html/index.html")).toContain("self.__next_f");
    },
    TIMEOUT,
  );
});
