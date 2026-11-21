import type { Asset, Detection, ModuleHint } from "../types.ts";
import { chunkStem, isEsmChunk, unpackEsmChunk, unpackWrappedBundle } from "../unpack/wrappers.ts";
import { isWebpackChunk, isWebpackRuntime } from "../unpack/webpack.ts";
import { defineAdapter } from "./index.ts";
import webpack from "./webpack.ts";

const IVY = /(?:\bstatic\s+|\.)(?:\\u0275|ɵ)(?:cmp|fac|prov|pipe|dir|mod|inj)\s*=|\[['"](?:\\u0275|ɵ)(?:cmp|fac|prov|pipe|dir|mod|inj)['"]\]\s*=|(?:\\u0275|ɵ){2}(?:defineComponent|ngDeclareComponent)\b/;
const SELECTOR = /selectors\s*:\s*\[\s*\[\s*"([a-z][\w-]*)"/g;
const VERSION = "(\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?)";
const HTML_VERSION = new RegExp(`\\sng-version\\s*=\\s*["']?${VERSION}(?=["'\\s>])`, "gi");
const SCRIPT_VERSION = new RegExp(`\\[\\s*["']ng-version["']\\s*,\\s*["']${VERSION}["']`, "g");

export function componentName(selector: string): string {
  const words = selector.replace(/^(app|ng|[a-z]{1,3})-(?=[a-z])/, "").split("-").filter(Boolean);
  return `${words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")}Component`;
}

function assetEvidence(assets: readonly Asset[]): Detection {
  const evidence = new Set<string>();
  for (const asset of assets) {
    if (IVY.test(asset.body)) evidence.add("Ivy definitions (ɵcmp / ɵfac / ɵprov)");
    if (/["']ng-version["']/.test(asset.body)) evidence.add("ng-version attribute");
  }
  return { score: evidence.has("Ivy definitions (ɵcmp / ɵfac / ɵprov)") ? 0.95 : evidence.size * 0.4, evidence: [...evidence] };
}

export default defineAdapter({
  name: "angular",
  detect(page) {
    const evidence: string[] = [];
    let score = 0;
    if (/\sng-version\s*=\s*["']?\d/i.test(page.html)) {
      score += 0.85;
      evidence.push("ng-version attribute in server-rendered HTML");
    }
    if (/<script[^>]+src\s*=\s*["'][^"']*main-[A-Z0-9]{8}\.js["']/.test(page.html)) {
      score += 0.1;
      evidence.push("CLI-style entry main-<HASH>.js");
    }
    if (/<app-[\w-]+[\s>]/i.test(page.html)) {
      score += 0.1;
      evidence.push("<app-*> root element");
    }
    if (/\s_ng(?:host|content)-[\w-]+(?=[\s=>])/i.test(page.html)) {
      score += 0.6;
      evidence.push("Angular view encapsulation attributes");
    }
    return { score: Math.min(1, score), evidence };
  },
  detectAssets: assetEvidence,
  packageVersions(page, assets) {
    const versions = new Set([...page.html.matchAll(HTML_VERSION), ...assets.flatMap((asset) => [...asset.body.matchAll(SCRIPT_VERSION)])].map((match) => match[1]!));
    if (versions.size !== 1) return new Map();
    const version = [...versions][0]!;
    return new Map(["core", "common", "router", "forms", "platform-browser", "animations"].map((name) => [`@angular/${name}`, version]));
  },
  collectAssets: () => [],
  discover(ctx) {
    return [...ctx.all.values()].some((asset) => isWebpackRuntime(asset) || isWebpackChunk(asset.body)) ? webpack.discover(ctx) : [];
  },
  isRuntime: webpack.isRuntime,
  coverage(ctx) {
    return [...ctx.all.values()].some((asset) => isWebpackRuntime(asset) || isWebpackChunk(asset.body)) ? webpack.coverage(ctx) : { unfetchedChunkIds: [] };
  },
  parseChunk(asset) {
    if (isWebpackChunk(asset.body) || isWebpackRuntime(asset)) return webpack.parseChunk(asset);
    if (asset.ref.type !== "module" && !isEsmChunk(asset.body)) return null;
    const chunk = unpackWrappedBundle(asset.body, asset.ref.url, "angular") ?? unpackEsmChunk(asset.body, asset.ref.url, "angular");
    if (chunk) return chunk;
    return {
      format: "esm",
      chunkIds: [chunkStem(asset.ref.url)],
      modules: [{ id: chunkStem(asset.ref.url), namespace: "angular", origin: "bundle", chunkUrl: asset.ref.url, code: asset.body, deps: [] }],
      diagnostics: { level: "full", shape: "esm-entry", containers: 1, recognized: 1, skipped: [], notes: [] },
    };
  },
  moduleHints(ctx) {
    const hints: ModuleHint[] = [];
    for (const asset of ctx.all.values()) {
      if (!IVY.test(asset.body)) continue;
      const path = new URL(asset.ref.url).pathname;
      if (/\/main-[\w]+\.js$/.test(path)) {
        hints.push({ id: chunkStem(asset.ref.url), name: "main", weight: 8, reason: "angular entry" });
        continue;
      }
      const selectors = [...asset.body.matchAll(SELECTOR)].map((m) => m[1]!);
      if (selectors.length === 1) hints.push({ id: chunkStem(asset.ref.url), name: componentName(selectors[0]!), weight: 7, reason: `angular component <${selectors[0]}>` });
    }
    return hints;
  },
});
