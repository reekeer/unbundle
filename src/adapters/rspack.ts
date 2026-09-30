import type { Asset, Detection } from "../types.ts";
import { defineAdapter } from "./index.ts";
import webpack from "./webpack.ts";

const BUNDLER_ID = /\.ruid\s*=\s*["'`]bundler=rspack@([\w.-]+)["'`]/;
const VERSION = /\.rv\s*=\s*\(\)\s*=>\s*["'`]([\d.]+[\w.-]*)["'`]/;

function assetEvidence(assets: readonly Asset[]): Detection {
  const evidence = new Set<string>();
  for (const asset of assets) {
    const id = BUNDLER_ID.exec(asset.body);
    if (id) evidence.add(`rspack runtime (bundler=rspack@${id[1]})`);
    else if (VERSION.test(asset.body) && /webpackChunk|__webpack_require__|\.m\s*=/.test(asset.body)) evidence.add("rspack version runtime module");
  }
  return { score: evidence.size ? 1 : 0, evidence: [...evidence] };
}

export default defineAdapter({
  ...webpack,
  name: "rspack",
  detect(page) {
    const evidence: string[] = [];
    if (/\/static\/js\/lib-(react|router|polyfill|lodash|axios)\.[\w]{8}\.js/.test(page.html)) evidence.push("Rsbuild lib-* split chunks");
    if (/\/static\/js\/(index|main)\.[\w]{8}\.js/.test(page.html) && /\/static\/css\/(index|main)\.[\w]{8}\.css/.test(page.html)) evidence.push("Rsbuild static/js + static/css layout");
    return { score: evidence.length * 0.2, evidence };
  },
  detectAssets: assetEvidence,
});
