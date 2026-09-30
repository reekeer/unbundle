import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("determinism", () => {
  test(
    "single-threaded and pooled refinement produce identical code",
    async () => {
      const server = serve("site-rspack", { serveMaps: false });
      const one = await runOn(server.url, { crawlDepth: 0, workers: 1 });
      const four = await runOn(server.url, { crawlDepth: 0, workers: 4 });
      const list = async (dir: string) => (await Array.fromAsync(new Bun.Glob("src/**/*").scan({ cwd: dir, dot: true }))).sort();
      const files = await list(one.outDir);
      expect(files.length).toBeGreaterThan(3);
      expect(await list(four.outDir)).toEqual(files);
      for (const file of files) expect(await read(four.outDir, file)).toBe(await read(one.outDir, file));
    },
    TIMEOUT,
  );
});

describe("crypto and proof-of-work", () => {
  test(
    "an inlined SHA-256 proof-of-work solver is named and reported",
    async () => {
      const server = serve("site-webpack");
      const { outDir, manifest } = await runOn(`${server.url}/challenge.html`, { crawlDepth: 0 });
      const script = await read(outDir, "src/pow.js");
      expect(script).toContain("let SHA256_K = new Uint32Array([");
      expect(script).toContain("function rotr(");
      expect(script).toContain("function sha256(");
      expect(script).toContain("async function solveChallenge(");
      expect(script).toMatch(/sha256\(`\$\{\w+\}:\$\{\w+\}`\)\.startsWith\("0"\.repeat\(\w+\)\)/);
      expect(manifest.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "crypto", name: "SHA-256", file: "src/pow.js" }),
          expect.objectContaining({ kind: "proof-of-work", name: "solveChallenge", file: "src/pow.js" }),
          expect.objectContaining({ kind: "webcrypto", name: "crypto.subtle.digest", detail: "algorithm SHA-256" }),
        ]),
      );
      expect(manifest.findings.every((f) => f.line > 0)).toBe(true);
    },
    TIMEOUT,
  );
});
