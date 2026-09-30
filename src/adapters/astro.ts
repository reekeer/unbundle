import { parseHtml, resolveHttpUrl } from "../browser/discover.ts";
import type { AssetRef, ModuleHint, Page } from "../types.ts";
import { chunkStem, isEsmChunk, unpackEsmChunk } from "../unpack/wrappers.ts";
import { defineAdapter } from "./index.ts";

export interface AstroIsland {
  component: string | null;
  componentUrl: string | null;
  rendererUrl: string | null;
  framework: string | null;
  client: string | null;
  props: unknown;
}

const RENDERERS: Array<[RegExp, string]> = [
  [/client\.svelte|svelte/i, "svelte"],
  [/client\.solid|solid/i, "solid"],
  [/client\.preact|preact/i, "preact"],
];

function decodeProps(value: unknown, depth = 0): unknown {
  if (depth > 50) return value;
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number") {
    const [type, inner] = value as [number, unknown];
    if (type === 0) return decodeProps(inner, depth + 1);
    if (type === 1 && inner && typeof inner === "object") return Object.fromEntries(Object.entries(inner as Record<string, unknown>).map(([k, v]) => [k, decodeProps(v, depth + 1)]));
    if (type === 2 || type === 5 || type === 6) return Array.isArray(inner) ? inner.map((v) => decodeProps(v, depth + 1)) : inner;
    if (type === 3) return String(inner);
    return inner;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, decodeProps(v, depth + 1)]));
  return value;
}

export function astroRuntime(url: string, code: string): { name: string; specifier: string } | null {
  if (/\/ClientRouter\.astro_astro_type_script_index_\d+_lang\.[\w-]+\.m?js$/.test(url)) return { name: "astro", specifier: "astro/components/ClientRouter.astro" };
  if (/astro-static-slot/.test(code) && /astro-slot/.test(code)) {
    const framework = /\$forceUpdate|config\.idPrefix|createSSRApp/.test(code) ? "vue" : /identifierPrefix|hydrateRoot/.test(code) ? "react" : /\$\$slots|svelte/i.test(code) ? "svelte" : /solid-js|createComponent/.test(code) ? "solid-js" : /preact/.test(code) ? "preact" : null;
    if (framework) return { name: `@astrojs/${framework}`, specifier: `@astrojs/${framework}/client` };
  }
  if (/data-astro-transition-persist/.test(code) && /astro:(before-preparation|after-swap|page-load)/.test(code)) return { name: "astro", specifier: "astro/transitions/router" };
  return null;
}

export function astroIslands(page: Page): AstroIsland[] {
  if (!page.html.includes("<astro-island")) return [];
  return parseHtml(page.html)
    .querySelectorAll("astro-island")
    .map((island) => {
      let opts: { name?: string } = {};
      let props: unknown = null;
      try {
        opts = JSON.parse(island.getAttribute("opts") ?? "{}") as { name?: string };
      } catch {
        opts = {};
      }
      try {
        props = decodeProps(JSON.parse(island.getAttribute("props") ?? "{}"));
      } catch {
        props = null;
      }
      const componentUrl = island.getAttribute("component-url") ?? null;
      const rendererUrl = island.getAttribute("renderer-url") ?? null;
      const framework = rendererUrl ? (RENDERERS.find(([pattern]) => pattern.test(rendererUrl))?.[1] ?? null) : null;
      return {
        component: opts.name ?? null,
        componentUrl: componentUrl ? (resolveHttpUrl(componentUrl, page.baseUrl)?.href ?? null) : null,
        rendererUrl: rendererUrl ? (resolveHttpUrl(rendererUrl, page.baseUrl)?.href ?? null) : null,
        framework,
        client: island.getAttribute("client") ?? null,
        props,
      };
    });
}

export default defineAdapter({
  name: "astro",
  detect(page) {
    let score = 0;
    const evidence: string[] = [];
    if (page.html.includes("<astro-island")) {
      score += 0.7;
      evidence.push("<astro-island> components");
    }
    if (/["']\/_astro\/[\w.-]+\.(js|css)["']/.test(page.html)) {
      score += 0.3;
      evidence.push("/_astro/ assets");
    }
    if (/<meta name="generator" content="Astro/.test(page.html)) {
      score += 0.4;
      evidence.push("generator meta");
    }
    return { score: Math.min(1, score), evidence };
  },
  collectAssets(page) {
    const refs: AssetRef[] = [];
    for (const island of astroIslands(page)) {
      for (const url of [island.componentUrl, island.rendererUrl]) if (url) refs.push({ url, type: "module", initiator: "adapter:astro:island" });
    }
    for (const el of parseHtml(page.html).querySelectorAll("astro-island[before-hydration-url]")) {
      const url = resolveHttpUrl(el.getAttribute("before-hydration-url") ?? "", page.baseUrl);
      if (url) refs.push({ url: url.href, type: "module", initiator: "adapter:astro:island" });
    }
    return refs;
  },
  parseChunk(asset) {
    if (asset.ref.type !== "module" && !isEsmChunk(asset.body)) return null;
    const result = unpackEsmChunk(asset.body, asset.ref.url, "astro");
    const runtime = astroRuntime(asset.ref.url, asset.body);
    if (result && runtime) for (const mod of result.modules) mod.package = runtime;
    return result;
  },
  moduleHints(ctx) {
    const hints: ModuleHint[] = [];
    const seen = new Set<string>();
    for (const page of ctx.pages) {
      for (const island of astroIslands(page)) {
        if (island.componentUrl && island.component && !seen.has(island.componentUrl)) {
          seen.add(island.componentUrl);
          hints.push({ id: chunkStem(island.componentUrl), name: island.component, weight: 9, reason: `astro island ${island.component}`, file: `components/${island.component}` });
        }
        if (island.rendererUrl && island.framework) hints.push({ id: chunkStem(island.rendererUrl), name: `${island.framework}-renderer`, weight: 6, reason: "astro island renderer" });
      }
    }
    return hints;
  },
  pageData(page) {
    const islands = astroIslands(page);
    return islands.length ? [{ suffix: "astro.json", content: `${JSON.stringify({ islands }, null, 2)}\n` }] : [];
  },
});
