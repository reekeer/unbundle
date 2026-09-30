import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("vite (React SPA)", () => {
  test(
    "the bundle splits into app components, a zustand store and a lazy route; React APIs are imported by name",
    async () => {
      const server = serve("site-vite", { serveMaps: false });
      const { outDir, manifest } = await runOn(server.url, { crawlDepth: 0 });
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.bundler.adapter).toBe("vite");
      expect(manifest.coverage.status).toBe("complete");
      const app = await read(outDir, "src/App.jsx");
      expect(app).toContain('import { House, Info } from "lucide-react";');
      expect(app).toContain('import { lazy, Suspense } from "react";');
      expect(app).toContain('const About = lazy(() => import("@/pages/About.jsx"));');
      expect(app).toContain("<Link to=\"/\">");
      expect(app).toContain('import { Link, Route, Routes } from "react-router";');
      const about = await read(outDir, "src/pages/About.jsx");
      expect(about).toContain('import { useState } from "react";');
      expect(about).toContain('import { useTotalStore } from "@/stores/useTotalStore.js";');
      expect(about).toContain('await import("@/utils/heavy.js")');
      expect(await read(outDir, "src/stores/useTotalStore.js")).toContain('import { create } from "zustand";');
      expect(await read(outDir, "src/components/Counter.jsx")).toContain("VITE_COUNTER_MAX");
      expect(await read(outDir, "src/utils/heavy.js")).toContain("VITE_LAZY_CHUNK");
    },
    TIMEOUT,
  );
});
