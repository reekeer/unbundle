import { guessType, resolveHttpUrl } from "../browser/discover.ts";
import type { Asset, AssetRef, Detection } from "../types.ts";
import { isWebpackChunk, isWebpackRuntime, unpackBootstrapBundle, unpackWebpackChunk, webpackLazyState } from "../unpack/webpack.ts";
import { unpackWrappedBundle } from "../unpack/wrappers.ts";
import { defineAdapter } from "./index.ts";

const SOURCE = "adapter:webpack";

function jsonpGlobal(code: string): string {
  return /webpack(?:Chunk|Jsonp)[\w$]*/.exec(code)?.[0] ?? "webpack";
}

function assetEvidence(assets: readonly Asset[]): Detection {
  const evidence = new Set<string>();
  for (const asset of assets) {
    const body = asset.body;
    if (/webpack(Chunk|Jsonp)[\w$]*\s*=\s*[\w$.]+\s*\|\|\s*\[\]\)\.push\(\[\[/.test(body)) evidence.add("webpack JSONP chunk");
    if (/__webpack_require__|\b[\w$]\.m\s*=\s*[\w$]+,\s*[\w$]\.(cw|c|d|o)\s*=/.test(body)) evidence.add("webpack runtime");
    if (/\.cw\s*=\s*[\w$]+\s*=>/.test(body)) evidence.add("webpack commonjs wrappers");
  }
  return { score: Math.min(1, evidence.size * 0.45), evidence: [...evidence] };
}

export default defineAdapter({
  name: "webpack",
  detect(page) {
    const evidence: string[] = [];
    if (/\/static\/js\/(main|runtime|vendors?|bundle)[.~-][\w.]*\.js/.test(page.html)) evidence.push("CRA-style /static/js/ bundle names");
    if (/webpackChunk|webpackJsonp/.test(page.html)) evidence.push("webpack global in HTML");
    return { score: evidence.length * 0.2, evidence };
  },
  detectAssets: assetEvidence,
  collectAssets: () => [],
  discover(ctx) {
    const page = ctx.pages[0]!;
    const lazy = webpackLazyState(ctx.all);
    const base = lazy.runtime ? new URL(lazy.runtime.finalUrl) : page.url;
    const resolve = (path: string) => (lazy.publicPath !== null ? resolveHttpUrl(`${lazy.publicPath}${path}`, page.url) : resolveHttpUrl(path, base));
    const refs: AssetRef[] = [];
    for (const id of lazy.ids) {
      for (const path of [lazy.templates?.script?.(id), lazy.templates?.style?.(id)]) {
        const url = path ? resolve(path) : null;
        if (url && !ctx.all.has(url.href)) refs.push({ url: url.href, type: guessType(url.href), initiator: `${SOURCE}:runtime`, optional: true });
      }
    }
    return refs;
  },
  parseChunk(asset) {
    if (isWebpackChunk(asset.body)) {
      const chunk = unpackWebpackChunk(asset.body, asset.ref.url);
      if (chunk) return chunk;
    }
    return unpackWrappedBundle(asset.body, asset.ref.url, jsonpGlobal(asset.body)) ?? unpackBootstrapBundle(asset.body, asset.ref.url, jsonpGlobal(asset.body));
  },
  isRuntime: (asset) => isWebpackRuntime(asset) && !/\.cw\s*=/.test(asset.body),
  coverage: (ctx) => ({ unfetchedChunkIds: webpackLazyState(ctx.all).unresolved }),
});
