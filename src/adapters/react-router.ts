import { resolveHttpUrl } from "../browser/discover.ts";
import { camel, capitalize } from "../refine/rename.ts";
import type { Asset, AssetRef, DiscoverContext, ModuleHint, Page } from "../types.ts";
import { chunkStem, isEsmChunk, unpackEsmChunk } from "../unpack/wrappers.ts";
import { defineAdapter } from "./index.ts";

const SIGNALS: Array<[RegExp, number, string]> = [
  [/window\.__reactRouterContext\s*=/, 0.7, "React Router framework context (window.__reactRouterContext)"],
  [/window\.__remixContext\s*=/, 0.7, "Remix context (window.__remixContext)"],
  [/__reactRouterRouteModules|__remixRouteModules/, 0.3, "route modules registry"],
  [/__reactRouterManifest|__remixManifest/, 0.2, "route manifest"],
];

interface RouteEntry {
  id: string;
  module: string;
  imports?: string[];
  css?: string[];
  path?: string;
  index?: boolean;
}

interface RouteManifest {
  entry?: { module: string; imports?: string[] };
  routes?: Record<string, RouteEntry>;
}

const MANIFEST = /window\.__(?:reactRouter|remix)Manifest\s*=\s*(\{[\s\S]*\})\s*;?\s*$/;

export function routeManifest(code: string): RouteManifest | null {
  const match = MANIFEST.exec(code.trim());
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as RouteManifest;
  } catch {
    return null;
  }
}

function manifests(ctx: DiscoverContext): RouteManifest[] {
  const out: RouteManifest[] = [];
  for (const asset of ctx.all.values()) {
    if (!/__(reactRouter|remix)Manifest/.test(asset.body)) continue;
    const found = routeManifest(asset.body);
    if (found) out.push(found);
  }
  for (const page of ctx.pages) {
    const inline = /window\.__remixManifest\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(page.html)?.[1];
    if (!inline) continue;
    try {
      out.push(JSON.parse(inline) as RouteManifest);
    } catch {
      continue;
    }
  }
  return out;
}

function routeName(id: string): string {
  const words = camel(id.replace(/^routes[/.]/, "").replace(/[$]/g, " ").replace(/[/.\-_[\]()]+/g, " "));
  return id === "root" ? "Root" : `${words ? capitalize(words) : "Index"}Route`;
}

function routeFile(id: string): string {
  if (id === "root") return "root";
  return id
    .split("/")
    .map((part) => part.replace(/[^\w.$[\]()-]/g, "_"))
    .join("/");
}

function isScript(asset: Asset): boolean {
  return asset.ref.type === "script" || asset.ref.type === "module" || /javascript/.test(asset.contentType);
}

export default defineAdapter({
  name: "react-router",
  detect(page: Page) {
    let score = 0;
    const evidence: string[] = [];
    for (const [pattern, weight, label] of SIGNALS) {
      if (!pattern.test(page.html)) continue;
      score += weight;
      evidence.push(label);
    }
    return { score: Math.min(1, score), evidence };
  },
  detectAssets(assets) {
    const evidence = assets.some((a) => /window\.__(reactRouter|remix)Manifest\s*=/.test(a.body)) ? ["route manifest chunk"] : [];
    return { score: evidence.length ? 0.8 : 0, evidence };
  },
  collectAssets: () => [],
  discover(ctx) {
    const page = ctx.pages[0]!;
    const refs: AssetRef[] = [];
    for (const manifest of manifests(ctx)) {
      const files = [manifest.entry?.module, ...(manifest.entry?.imports ?? []), ...Object.values(manifest.routes ?? {}).flatMap((r) => [r.module, ...(r.imports ?? []), ...(r.css ?? [])])];
      for (const file of files) {
        const url = file ? resolveHttpUrl(file, page.url) : null;
        if (url && !ctx.all.has(url.href)) refs.push({ url: url.href, type: file!.endsWith(".css") ? "style" : "module", initiator: "adapter:react-router:manifest" });
      }
    }
    return refs;
  },
  parseChunk(asset) {
    if (!isScript(asset) || (asset.ref.type !== "module" && !isEsmChunk(asset.body))) return null;
    return unpackEsmChunk(asset.body, asset.ref.url, "react-router");
  },
  moduleHints(ctx) {
    const hints: ModuleHint[] = [];
    for (const manifest of manifests(ctx)) {
      for (const [id, route] of Object.entries(manifest.routes ?? {})) {
        const stem = chunkStem(new URL(route.module, "http://x/").href);
        hints.push({ id: stem, name: routeName(id), weight: 7, reason: `react-router route ${id}`, file: routeFile(id) });
      }
      if (manifest.entry?.module) hints.push({ id: chunkStem(new URL(manifest.entry.module, "http://x/").href), name: "entry.client", weight: 8, reason: "react-router client entry" });
    }
    return hints;
  },
});
