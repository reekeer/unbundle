import { importMap, parseHtml, resolveHttpUrl } from "../browser/discover.ts";
import { camel, capitalize } from "../refine/rename.ts";
import type { Asset, AssetRef, DiscoverContext, ModuleHint, Page } from "../types.ts";
import { literalKey, parseProgram, t } from "../unpack/ast.ts";
import { applyImportMap, chunkStem, isEsmChunk, unpackEsmChunk } from "../unpack/wrappers.ts";
import { defineAdapter } from "./index.ts";
import { preloadDeps } from "./vite.ts";

const SIGNALS: Array<[RegExp, number, string]> = [
  [/\/_nuxt\/[\w.-]+\.m?js/, 0.5, "/_nuxt/ module chunks"],
  [/<div id=["']__nuxt["']/, 0.3, "#__nuxt root"],
  [/id=["']__NUXT_DATA__["']|window\.__NUXT__\s*=/, 0.4, "Nuxt payload (__NUXT_DATA__ / window.__NUXT__)"],
  [/"#entry"\s*:/, 0.2, "import map #entry"],
];

const BUILD_ASSETS = /buildAssetsDir\s*:\s*"([^"]+)"/;
const BASE_URL = /\bbaseURL\s*:\s*"([^"]+)"/;
const CDN_URL = /\bcdnURL\s*:\s*"([^"]*)"/;

function nuxtConfig(page: Page): { base: string; assets: string; cdn: string } {
  return {
    base: BASE_URL.exec(page.html)?.[1] ?? "/",
    assets: BUILD_ASSETS.exec(page.html)?.[1] ?? "/_nuxt/",
    cdn: CDN_URL.exec(page.html)?.[1] ?? "",
  };
}

export function nuxtAssetsBase(page: Page): URL {
  const { base, assets, cdn } = nuxtConfig(page);
  const root = cdn ? resolveHttpUrl(cdn.endsWith("/") ? cdn : `${cdn}/`, page.url) : null;
  const joined = `${base.replace(/\/+$/, "")}/${assets.replace(/^\/+/, "")}`;
  return new URL(joined.replace(/^\/+/, ""), root ?? new URL("/", page.url));
}

function scopeOf(page: Page): string | null {
  const base = nuxtConfig(page).base.replace(/\/+$/, "");
  if (base) return base;
  const script = /<script[^>]+src=["']([^"']*\/_nuxt\/[^"']+)["']/.exec(page.html)?.[1];
  const url = script ? resolveHttpUrl(script, page.baseUrl) : null;
  if (!url || url.origin !== page.url.origin) return null;
  return url.pathname.slice(0, url.pathname.indexOf("/_nuxt/")) || "/";
}

export function decodeDevalue(values: unknown): unknown {
  if (!Array.isArray(values)) return values;
  const cache = new Map<number, unknown>();
  const special: Record<number, unknown> = { [-1]: undefined, [-2]: null, [-3]: Number.NaN, [-4]: Number.POSITIVE_INFINITY, [-5]: Number.NEGATIVE_INFINITY, [-6]: -0 };
  const hydrate = (index: unknown, depth = 0): unknown => {
    if (typeof index !== "number" || depth > 200) return index;
    if (index < 0) return special[index];
    if (cache.has(index)) return cache.get(index);
    const value = values[index];
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      if (typeof value[0] === "string") {
        const [tag, ...rest] = value as [string, ...unknown[]];
        if (tag === "Date" || tag === "BigInt" || tag === "URL") return rest[0];
        if (tag === "RegExp") return `/${String(rest[0])}/${String(rest[1] ?? "")}`;
        if (tag === "Set") return rest.map((r) => hydrate(r, depth + 1));
        if (tag === "Map") {
          const out: Record<string, unknown> = {};
          for (let i = 0; i + 1 < rest.length; i += 2) out[String(hydrate(rest[i], depth + 1))] = hydrate(rest[i + 1], depth + 1);
          return out;
        }
        if (tag === "null") {
          const out: Record<string, unknown> = {};
          for (let i = 0; i + 1 < rest.length; i += 2) out[String(rest[i])] = hydrate(rest[i + 1], depth + 1);
          return out;
        }
        return rest.length ? hydrate(rest[0], depth + 1) : null;
      }
      const out: unknown[] = [];
      cache.set(index, out);
      for (const item of value) out.push(hydrate(item, depth + 1));
      return out;
    }
    const out: Record<string, unknown> = {};
    cache.set(index, out);
    for (const [key, item] of Object.entries(value)) out[key] = hydrate(item, depth + 1);
    return out;
  };
  return hydrate(0);
}

const ROUTE = /\{\s*name\s*:\s*["'`]([^"'`]+)["'`]\s*,\s*path\s*:\s*["'`]([^"'`]*)["'`][^{}]*?component\s*:\s*\(\)\s*=>[^{}]*?import\(\s*["'`]\.\/([^"'`]+)\.js["'`]\s*\)/g;
const LAZY_WITH_CSS = /import\(\s*["'`]\.\/([^"'`]+)\.js["'`]\s*\)\s*,\s*__vite__mapDeps\(\[([\d,\s]+)\]\)/g;
const MAP_DEPS = /__vite__mapDeps\s*=[^[]*?\.f\s*=\s*(\[[^\]]*\])|\bm\.f\s*\|\|\s*\(\s*m\.f\s*=\s*(\[[^\]]*\])/;

function routeComponentName(name: string, path: string): string {
  const source = name && name !== "index" ? name : path.replace(/[:[\]()*?]/g, "") || "index";
  const words = camel(source.replace(/[/\-_.]+/g, " ").trim());
  return `${words ? capitalize(words) : "Index"}Page`;
}

interface RouteEntry {
  name: string;
  path: string;
  id: string;
}

function stringProp(object: t.ObjectExpression, key: string): string | null {
  const prop = object.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === key);
  if (t.isStringLiteral(prop?.value)) return prop.value.value;
  if (t.isTemplateLiteral(prop?.value) && !prop.value.expressions.length) return prop.value.quasis[0]?.value.cooked ?? null;
  return null;
}

function chunkOf(object: t.ObjectExpression): string | null {
  const component = object.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "component");
  let id: string | null = null;
  if (component) {
    t.traverseFast(component.value, (n) => {
      if (id || !t.isCallExpression(n) || !t.isImport(n.callee)) return;
      const arg = n.arguments[0];
      const value = t.isStringLiteral(arg) ? arg.value : t.isTemplateLiteral(arg) && !arg.expressions.length ? arg.quasis[0]?.value.cooked : null;
      const match = value ? /^\.\/(.+)\.js$/.exec(value) : null;
      if (match) id = match[1]!;
    });
  }
  return id;
}

function isRouteArray(node: t.Node | null | undefined): node is t.ArrayExpression {
  return t.isArrayExpression(node) && node.elements.length > 0 && node.elements.every((e) => t.isObjectExpression(e) && stringProp(e, "path") !== null);
}

export function routeTable(code: string): RouteEntry[] {
  let ast: t.File;
  try {
    ast = parseProgram(code);
  } catch {
    return [];
  }
  const out: RouteEntry[] = [];
  const nested = new Set<t.Node>();
  const walk = (array: t.ArrayExpression, parent: string) => {
    for (const element of array.elements) {
      const route = element as t.ObjectExpression;
      const own = stringProp(route, "path") ?? "";
      const full = own.startsWith("/") ? own : `${parent.replace(/\/+$/, "")}/${own}`.replace(/\/+$/, "") || "/";
      const name = stringProp(route, "name");
      const id = chunkOf(route);
      if (name && id) out.push({ name, path: full, id });
      const children = route.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "children")?.value;
      if (isRouteArray(children)) {
        nested.add(children);
        walk(children, full);
      }
    }
  };
  const arrays: t.ArrayExpression[] = [];
  t.traverseFast(ast.program, (node) => {
    if (isRouteArray(node)) arrays.push(node);
  });
  for (const array of arrays) {
    for (const element of array.elements) {
      const children = (element as t.ObjectExpression).properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "children")?.value;
      if (children) nested.add(children);
    }
  }
  for (const array of arrays) if (!nested.has(array)) walk(array, "");
  return out;
}

export function routeFile(name: string, params: Map<string, string>): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((token) => params.get(token) ?? token)
    .join("/");
}

function pathParams(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of path.matchAll(/:(\w+)(\([^)]*\))?([?*+])?/g)) {
    const name = match[1]!;
    out.set(name, match[3] === "*" || match[3] === "+" ? `[...${name}]` : match[3] === "?" ? `[[${name}]]` : `[${name}]`);
  }
  return out;
}

export function nuxtModuleHints(ctx: DiscoverContext): ModuleHint[] {
  const hints: ModuleHint[] = [];
  const page = ctx.pages[0];
  const script = page ? /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']*\/_nuxt\/[^"']+\.m?js)["']/.exec(page.html)?.[1] : undefined;
  const entry = page ? (importMap(page).get("#entry") ?? (script ? resolveHttpUrl(script, page.baseUrl)?.href : undefined)) : undefined;
  if (entry) hints.push({ id: chunkStem(entry), name: "entry", weight: 8, reason: "nuxt import map #entry" });
  const seen = new Set<string>();
  for (const asset of ctx.all.values()) {
    if (!ROUTE.test(asset.body)) continue;
    ROUTE.lastIndex = 0;
    for (const route of routeTable(asset.body)) {
      if (seen.has(route.id)) continue;
      seen.add(route.id);
      const name = route.name.replace(/___[\w-]+$/, "");
      hints.push({ id: route.id, name: routeComponentName(name, route.path), weight: 7, reason: `nuxt route ${route.path || "/"}`, file: `pages/${routeFile(name === "index" ? "" : name, pathParams(route.path))}` });
    }
  }
  for (const asset of ctx.all.values()) {
    const deps = MAP_DEPS.exec(asset.body);
    let files: unknown[] = [];
    try {
      files = deps ? (JSON.parse(deps[1] ?? deps[2]!) as unknown[]) : [];
    } catch {
      files = [];
    }
    for (const match of asset.body.matchAll(LAZY_WITH_CSS)) {
      const css = match[2]!.split(",").map((i) => files[Number(i.trim())]).find((f): f is string => typeof f === "string" && f.endsWith(".css"));
      const stem = css ? /([^/]+?)\.[\w-]+\.css$/.exec(css)?.[1] : undefined;
      if (!stem || /^(entry|index|pages|default)$/.test(stem)) continue;
      const words = camel(stem.replace(/[-_.]+/g, " "));
      if (words) hints.push({ id: match[1]!, name: capitalize(words), weight: 4, reason: `nuxt lazy chunk css ${stem}` });
    }
  }
  return hints;
}

function nuxtData(page: Page): string | null {
  const script = parseHtml(page.html).querySelector("script#__NUXT_DATA__");
  if (!script) return null;
  try {
    return `${JSON.stringify(decodeDevalue(JSON.parse(script.text)), null, 2)}\n`;
  } catch {
    return null;
  }
}

function isScript(asset: Asset): boolean {
  return asset.ref.type === "script" || asset.ref.type === "module" || /javascript/.test(asset.contentType);
}

export default defineAdapter({
  name: "nuxt",
  detect(page) {
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
    const evidence = new Set<string>();
    for (const asset of assets) {
      if (/\/_nuxt\//.test(asset.ref.url) && /__vite__mapDeps/.test(asset.body)) evidence.add("vite chunks under /_nuxt/");
      if (/useNuxtApp|nuxt-root|__NUXT__/.test(asset.body)) evidence.add("Nuxt runtime");
    }
    return { score: Math.min(1, evidence.size * 0.45), evidence: [...evidence] };
  },
  collectAssets: () => [],
  discover(ctx) {
    const refs: AssetRef[] = [];
    for (const asset of ctx.fresh) if (isScript(asset)) refs.push(...preloadDeps(asset));
    return refs.filter((r) => !ctx.all.has(r.url));
  },
  scopePath: scopeOf,
  ownsUrl: (url, page) => url.href.startsWith(nuxtAssetsBase(page).href),
  parseChunk(asset, env) {
    if (asset.ref.type !== "module" && !isEsmChunk(asset.body)) return null;
    const code = applyImportMap(asset.body, asset.ref.url, env.importMap);
    const chunk = unpackEsmChunk(code, asset.ref.url, "nuxt");
    if (chunk) return chunk;
    const stem = chunkStem(asset.ref.url);
    return {
      format: "esm",
      chunkIds: [stem],
      modules: [{ id: stem, namespace: "nuxt", origin: "bundle", chunkUrl: asset.ref.url, code, deps: [] }],
      diagnostics: { level: "full", shape: "esm-entry", containers: 1, recognized: 1, skipped: [], notes: [] },
    };
  },
  moduleHints: nuxtModuleHints,
  pageData(page) {
    const data = nuxtData(page);
    return data ? [{ suffix: "nuxt.json", content: data }] : [];
  },
});
