import { camel, capitalize } from "../refine/rename.ts";
import type { AssetRef, DiscoverContext, ModuleHint } from "../types.ts";
import { chunkStem, isEsmChunk, unpackEsmChunk } from "../unpack/wrappers.ts";
import { defineAdapter } from "./index.ts";
import { preloadDeps } from "./vite.ts";

const NODE = /\/nodes\/(\d+)\.[\w-]+\.js$/;
const DICTIONARY = /(?:^|[,;{\s])([\w$]+)\s*=\s*(\{(?:"[^"]*"\s*:\s*\[[^\]]*(?:\[[^\]]*\])?[^\]]*\]\s*,?\s*)+\})/g;

export function kitDictionary(code: string): Map<string, number> {
  const exported = /export\s*\{[^}]*\b([\w$]+)\s+as\s+dictionary\b/.exec(code)?.[1];
  const routes = new Map<string, number>();
  for (const match of code.matchAll(DICTIONARY)) {
    if (exported && match[1] !== exported) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[2]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const [route, value] of Object.entries(parsed)) {
      const leaf = Array.isArray(value) ? value[0] : null;
      if (typeof leaf === "number") routes.set(route, Math.abs(leaf));
    }
  }
  return routes;
}

function routeFile(route: string): string {
  const segments = route.split("/").filter(Boolean);
  return ["routes", ...segments, "+page"].join("/");
}

function routeName(route: string): string {
  const words = camel(route.replace(/[[\]()]/g, " ").replace(/\//g, " "));
  return `${words ? capitalize(words) : "Index"}Page`;
}

export default defineAdapter({
  name: "sveltekit",
  detect(page) {
    let score = 0;
    const evidence: string[] = [];
    if (/__sveltekit_\w+\s*=/.test(page.html)) {
      score += 0.8;
      evidence.push("__sveltekit_* bootstrap");
    }
    if (/\/_app\/immutable\//.test(page.html)) {
      score += 0.4;
      evidence.push("/_app/immutable/ chunks");
    }
    return { score: Math.min(1, score), evidence };
  },
  collectAssets: () => [],
  discover(ctx) {
    const refs: AssetRef[] = [];
    for (const asset of ctx.fresh) refs.push(...preloadDeps(asset));
    return refs.filter((r) => !ctx.all.has(r.url));
  },
  parseChunk(asset) {
    if (asset.ref.type !== "module" && !isEsmChunk(asset.body)) return null;
    return unpackEsmChunk(asset.body, asset.ref.url, "sveltekit");
  },
  moduleHints(ctx: DiscoverContext) {
    const hints: ModuleHint[] = [];
    const nodes = new Map<number, string>();
    for (const asset of ctx.all.values()) {
      const node = NODE.exec(new URL(asset.ref.url).pathname);
      if (node) nodes.set(Number(node[1]), chunkStem(asset.ref.url));
    }
    const add = (index: number, name: string, file: string, reason: string) => {
      const id = nodes.get(index);
      if (id) hints.push({ id, name, weight: 7, reason, file });
    };
    add(0, "Layout", "routes/+layout", "sveltekit root layout node");
    add(1, "Error", "routes/+error", "sveltekit root error node");
    for (const asset of ctx.all.values()) {
      if (!/\bdictionary\b/.test(asset.body)) continue;
      for (const [route, index] of kitDictionary(asset.body)) add(index, routeName(route), routeFile(route), `sveltekit route ${route}`);
    }
    for (const asset of ctx.all.values()) {
      const path = new URL(asset.ref.url).pathname;
      if (/\/entry\/(start|app)\.[\w-]+\.js$/.test(path)) hints.push({ id: chunkStem(asset.ref.url), name: /\/start\./.test(path) ? "start" : "app", weight: 8, reason: "sveltekit entry" });
    }
    return hints;
  },
});
