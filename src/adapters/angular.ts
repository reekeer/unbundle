import type { Asset, Detection, ModuleHint } from "../types.ts";
import { chunkStem, isEsmChunk, unpackEsmChunk } from "../unpack/wrappers.ts";
import { defineAdapter } from "./index.ts";

const IVY = /\bstatic\s*(?:\\u0275|ɵ)(?:cmp|fac|prov|pipe|dir|mod|inj)\s*=|\\u0275\\u0275defineComponent|ɵɵdefineComponent/;
const SELECTOR = /selectors\s*:\s*\[\s*\[\s*"([a-z][\w-]*)"/g;

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
    if (/\sng-version="\d/.test(page.html)) evidence.push("ng-version attribute in server-rendered HTML");
    if (/<script[^>]+src="[^"]*main-[A-Z0-9]{8}\.js"/.test(page.html)) evidence.push("Angular CLI entry main-<HASH>.js");
    if (/<(app-root|app-[a-z-]+)[\s>]/.test(page.html)) evidence.push("<app-*> root element");
    if (/_nghost-|_ngcontent-/.test(page.html)) evidence.push("emulated view encapsulation attributes");
    return { score: Math.min(1, evidence.length * 0.35), evidence };
  },
  detectAssets: assetEvidence,
  collectAssets: () => [],
  parseChunk(asset) {
    if (asset.ref.type !== "module" && !isEsmChunk(asset.body)) return null;
    const chunk = unpackEsmChunk(asset.body, asset.ref.url, "angular");
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
