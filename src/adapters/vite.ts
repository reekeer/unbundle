import type { Asset, AssetRef, Detection, ModuleHint } from "../types.ts";
import { chunkStem, isEsmChunk, normalizeChunkSpecifiers, unpackEsmChunk, unpackWrappedBundle } from "../unpack/wrappers.ts";
import { deminifyCode } from "../refine/deminify.ts";

function deminifyEntry(code: string): string {
  try {
    return deminifyCode(code);
  } catch {
    return code;
  }
}
import { defineAdapter } from "./index.ts";

const HASHED = /^(.+?)-[\w-]{8}$/;

export function preloadDeps(asset: Asset): AssetRef[] {
  if (!asset.body.includes("__vite__mapDeps")) return [];
  const list = /__vite__mapDeps\s*=\s*\([^)]*\)\s*=>[^[]*?\.f\s*=\s*(\[[^\]]*\])/.exec(asset.body)?.[1] ?? /\bm\.f\s*\|\|\s*\(\s*m\.f\s*=\s*(\[[^\]]*\])/.exec(asset.body)?.[1];
  if (!list) return [];
  let files: unknown;
  try {
    files = JSON.parse(list);
  } catch {
    return [];
  }
  if (!Array.isArray(files)) return [];
  const own = new URL(asset.finalUrl);
  const at = own.pathname.lastIndexOf("/assets/");
  const base = new URL(at >= 0 ? own.pathname.slice(0, at + 1) : "/", own);
  return files
    .filter((f): f is string => typeof f === "string")
    .map((file) => ({ url: new URL(file, /^\.\.?\//.test(file) ? own : base).href, type: file.endsWith(".css") ? ("style" as const) : ("module" as const), initiator: `vite preload deps in ${asset.ref.url}` }));
}

function assetEvidence(assets: readonly Asset[]): Detection {
  const evidence = new Set<string>();
  for (const asset of assets) {
    if (/__vite__mapDeps|__vitePreload/.test(asset.body)) evidence.add("vite preload helpers");
    if (/relList\.supports\("modulepreload"\)|rel="modulepreload"/.test(asset.body)) evidence.add("vite modulepreload polyfill");
  }
  const esm = assets.some((a) => a.ref.type === "module" && /\/assets\/[\w-]+-[\w-]{8}\.js$/.test(new URL(a.ref.url).pathname));
  if (esm) evidence.add("hashed ES module chunks in /assets/");
  return { score: Math.min(1, evidence.size * 0.35), evidence: [...evidence] };
}

export default defineAdapter({
  name: "vite",
  detect(page) {
    const evidence: string[] = [];
    if (/<script[^>]+type="module"[^>]+crossorigin[^>]+src="[^"]*\/assets\/[\w-]+-[\w-]{8}\.js"/.test(page.html)) evidence.push("module script /assets/<name>-<hash>.js with crossorigin");
    if (/rel="modulepreload"[^>]+\/assets\//.test(page.html)) evidence.push("modulepreload of /assets/");
    return { score: Math.min(1, evidence.length * 0.35), evidence };
  },
  detectAssets: assetEvidence,
  collectAssets: () => [],
  discover(ctx) {
    return ctx.fresh.flatMap((asset) => preloadDeps(asset));
  },
  parseChunk(asset) {
    if (asset.ref.type !== "module" && !isEsmChunk(asset.body)) return null;
    const chunk = unpackWrappedBundle(normalizeChunkSpecifiers(asset.body), asset.ref.url, "vite") ?? unpackEsmChunk(asset.body, asset.ref.url, "vite");
    if (chunk) return chunk;
    return {
      format: "esm",
      chunkIds: [chunkStem(asset.ref.url)],
      modules: [{ id: chunkStem(asset.ref.url), namespace: "vite", origin: "bundle", chunkUrl: asset.ref.url, code: deminifyEntry(asset.body), deps: [] }],
      diagnostics: { level: "full", shape: "esm-entry", containers: 1, recognized: 1, skipped: [], notes: [] },
    };
  },
  moduleHints(ctx) {
    const hints: ModuleHint[] = [];
    for (const asset of ctx.all.values()) {
      const stem = chunkStem(asset.ref.url);
      const base = HASHED.exec(stem)?.[1];
      if (base && base !== "index" && base !== "chunk") hints.push({ id: stem, name: base, weight: 4, reason: "chunk file name" });
    }
    return hints;
  },
});
