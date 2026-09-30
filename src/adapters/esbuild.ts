import type { Asset, Detection } from "../types.ts";
import { unpackEsmChunk, unpackWrappedBundle } from "../unpack/wrappers.ts";
import { defineAdapter } from "./index.ts";

const COMMONJS_HELPER = /([\w$]+)=\(([\w$]+),([\w$]+)\)=>\(\)=>\(\3\|\|\2\(\(\3=\{exports:\{\}\}\)\.exports,\3\),\3\.exports\)/;

function assetEvidence(assets: readonly Asset[]): Detection {
  const evidence = new Set<string>();
  for (const asset of assets) {
    if (COMMONJS_HELPER.test(asset.body) || /__commonJS\(/.test(asset.body)) evidence.add("esbuild __commonJS helper");
    if (/__toESM\(|__export\(/.test(asset.body)) evidence.add("esbuild interop helpers");
    if (/\/chunk-[A-Z0-9]{8}\.js/.test(asset.ref.url) || /from"\.\/chunk-[A-Z0-9]{8}\.js"/.test(asset.body)) evidence.add("esbuild chunk-<HASH>.js naming");
  }
  return { score: Math.min(1, evidence.size * 0.4), evidence: [...evidence] };
}

export default defineAdapter({
  name: "esbuild",
  detect: () => ({ score: 0, evidence: [] }),
  detectAssets: assetEvidence,
  collectAssets: () => [],
  parseChunk(asset) {
    return unpackWrappedBundle(asset.body, asset.ref.url, "esbuild") ?? unpackEsmChunk(asset.body, asset.ref.url, "esbuild");
  },
});
