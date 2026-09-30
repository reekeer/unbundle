import { guessType, resolveHttpUrl } from "../browser/discover.ts";
import { normalizeSourcePath } from "../output.ts";
import { camel, capitalize } from "../refine/rename.ts";
import type { AssetRef, Asset, Detection, DiscoverContext, ModuleHint, Page } from "../types.ts";
import { isTurbopackChunk, unpackTurbopackChunk } from "../unpack/turbopack.ts";
import { isWebpackChunk, isWebpackRuntime, unpackWebpackChunk, webpackLazyState } from "../unpack/webpack.ts";
import { defineAdapter } from "./index.ts";

function hasHeaderPrefix(headers: Headers, prefix: string): boolean {
  let found = false;
  headers.forEach((_, key) => {
    if (key.startsWith(prefix)) found = true;
  });
  return found;
}

const SIGNALS: Array<[RegExp | ((page: Page) => boolean), number, string]> = [
  [/\/_next\/static\//, 0.6, "/_next/static/ assets"],
  [/self\.__next_f/, 0.3, "App Router RSC payload (self.__next_f)"],
  [/id=["']__NEXT_DATA__["']/, 0.3, "Pages Router __NEXT_DATA__"],
  [/webpackChunk_N_E|_N_E=/, 0.2, "webpack chunk global _N_E"],
  [/<div id=["']__next["']/, 0.1, "#__next root"],
  [/name=["']next-head-count["']/, 0.1, "next-head-count meta"],
  [(page) => /next\.js/i.test(page.headers.get("x-powered-by") ?? ""), 0.3, "x-powered-by: Next.js"],
  [(page) => hasHeaderPrefix(page.headers, "x-nextjs-"), 0.3, "x-nextjs-* headers"],
];

export function detectNext(page: Page): Detection {
  let score = 0;
  const evidence: string[] = [];
  for (const [test, weight, label] of SIGNALS) {
    const hit = typeof test === "function" ? test(page) : test.test(page.html);
    if (hit) {
      score += weight;
      evidence.push(label);
    }
  }
  return { score: Math.min(1, score), evidence };
}

const NEXT_SEGMENT = "/_next/";
const ATTR_URL = /(?:src|href)\s*=\s*["']([^"']*\/_next\/[^"']*)["']/gi;

export function nextBase(page: Page): URL {
  const counts = new Map<string, number>();
  for (const match of page.html.matchAll(ATTR_URL)) {
    const url = resolveHttpUrl(match[1]!, page.baseUrl);
    if (!url) continue;
    const index = url.href.indexOf(NEXT_SEGMENT);
    if (index < 0) continue;
    const base = url.href.slice(0, index + NEXT_SEGMENT.length);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  let best: string | null = null;
  let max = 0;
  for (const [base, count] of counts) if (count > max) [best, max] = [base, count];
  return new URL(best ?? new URL("/_next/", page.url).href);
}

export function basePathOf(page: Page): string | null {
  const base = nextBase(page);
  if (base.origin !== page.url.origin) return null;
  return base.pathname.slice(0, -NEXT_SEGMENT.length + 1).replace(/\/$/, "") || "/";
}

export function resolveNextPath(path: string, page: Page): URL | null {
  if (/^https?:\/\//i.test(path)) return resolveHttpUrl(path, page.url);
  if (path.startsWith("/")) return resolveHttpUrl(path, page.url);
  return resolveHttpUrl(path.replace(/^\.?\//, ""), nextBase(page));
}

export interface ClientReference {
  moduleId: string;
  exportName: string;
  chunkPaths: string[];
  chunkIds: string[];
}

export interface FlightData {
  text: string;
  buildId: string | null;
  references: ClientReference[];
  styles: string[];
}

const PUSH = /self\.__next_f\.push\(\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
const NEXT_DATA = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

export function decodeFlight(html: string): string {
  let text = "";
  for (const match of html.matchAll(PUSH)) {
    try {
      text += JSON.parse(match[1]!) as string;
    } catch {
      continue;
    }
  }
  return text;
}

export function parseFlight(text: string): FlightData {
  const references: ClientReference[] = [];
  const styles: string[] = [];
  for (const line of text.split("\n")) {
    const row = /^[0-9a-f]*:(I|HL)(\[.*)$/.exec(line);
    if (!row) continue;
    let value: unknown;
    try {
      value = JSON.parse(row[2]!);
    } catch {
      continue;
    }
    if (!Array.isArray(value)) continue;
    if (row[1] === "HL") {
      if (typeof value[0] === "string" && value[1] === "style") styles.push(value[0]);
      continue;
    }
    const [moduleId, chunks, exportName] = value as [unknown, unknown, unknown];
    if ((typeof moduleId !== "string" && typeof moduleId !== "number") || !Array.isArray(chunks)) continue;
    const chunkPaths: string[] = [];
    const chunkIds: string[] = [];
    for (const entry of chunks) {
      if (typeof entry !== "string" && typeof entry !== "number") continue;
      const value = String(entry);
      if (value.includes("/") || /\.(m?js|css)$/.test(value)) chunkPaths.push(value);
      else chunkIds.push(value);
    }
    references.push({ moduleId: String(moduleId), exportName: typeof exportName === "string" ? exportName : "", chunkPaths, chunkIds });
  }
  const buildId = /"b":"([^"]+)"/.exec(text)?.[1] ?? null;
  return { text, buildId, references, styles };
}

export function readNextData(html: string): { buildId?: string; page?: string; assetPrefix?: string } | null {
  const match = NEXT_DATA.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as { buildId?: string; page?: string; assetPrefix?: string };
  } catch {
    return null;
  }
}

export function flightOf(html: string): FlightData {
  return parseFlight(decodeFlight(html));
}

const SOURCE = "adapter:next";
const CHUNK_PATH = /(?:\/[\w\-.~%@]+)*\/_next\/static\/[\w\-./~%@[\]()]+?\.(?:m?js|css)|(?<![\w/])static\/(?:chunks|css|[\w-]{8,})\/[\w\-./~%@[\]()]+?\.(?:m?js|css)/g;

function ref(url: URL | null, initiator: string, optional = false): AssetRef | null {
  if (!url) return null;
  return { url: url.href, type: guessType(url.href), initiator, ...(optional ? { optional } : {}) };
}

function compact(refs: Array<AssetRef | null>): AssetRef[] {
  const seen = new Set<string>();
  return refs.filter((r): r is AssetRef => {
    if (!r || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

export function chunkPathsIn(text: string): string[] {
  return [...new Set(text.match(CHUNK_PATH) ?? [])];
}

export function collectNextAssets(page: Page): AssetRef[] {
  const flight = flightOf(page.html);
  const refs: Array<AssetRef | null> = [];

  for (const reference of flight.references) {
    for (const path of reference.chunkPaths) refs.push(ref(resolveNextPath(path, page), `${SOURCE}:rsc`));
  }
  for (const style of flight.styles) refs.push(ref(resolveNextPath(style, page), `${SOURCE}:rsc`));
  for (const path of chunkPathsIn(page.html)) refs.push(ref(resolveNextPath(path, page), `${SOURCE}:html-text`));

  const buildId = flight.buildId ?? readNextData(page.html)?.buildId ?? null;
  if (buildId && /^[\w-]+$/.test(buildId)) {
    const base = nextBase(page);
    for (const file of ["_buildManifest.js", "_ssgManifest.js"]) {
      refs.push(ref(new URL(`static/${buildId}/${file}`, base), `${SOURCE}:build-manifest`, true));
    }
  }
  return compact(refs);
}

function isScript(asset: Asset): boolean {
  return (asset.ref.type === "script" || asset.ref.type === "module") || /javascript/.test(asset.contentType);
}

function isTurbopackRuntime(asset: Asset): boolean {
  return /runtimeModuleIds|TURBOPACK_CHUNK_BASE_PATH/.test(asset.body) && /TURBOPACK/.test(asset.body);
}

export function expandNextAssets(ctx: DiscoverContext): AssetRef[] {
  const page = ctx.pages[0]!;
  const refs: Array<AssetRef | null> = [];

  for (const asset of ctx.fresh) {
    if (!isScript(asset) && asset.ref.type !== "style") continue;
    for (const path of chunkPathsIn(asset.body)) refs.push(ref(resolveNextPath(path, page), `${SOURCE}:chunk-ref`));
  }

  const lazy = webpackLazyState(ctx.all);
  for (const id of lazy.ids) {
    const script = lazy.templates?.script?.(id);
    const style = lazy.templates?.style?.(id);
    if (script) refs.push(ref(resolveNextPath(script, page), `${SOURCE}:webpack-runtime`, true));
    if (style) refs.push(ref(resolveNextPath(style, page), `${SOURCE}:webpack-runtime`, true));
  }
  return compact(refs).filter((r) => !ctx.all.has(r.url));
}

const GENERIC_EXPORTS = new Set(["", "default", "*"]);

function routeName(pathname: string, basePath: string): string {
  let route = pathname;
  if (basePath !== "/" && route.startsWith(basePath)) route = route.slice(basePath.length);
  route = route.replace(/\/index(\.html?)?$/, "/").replace(/\.html?$/, "");
  const words = camel(route.replace(/\//g, " "));
  return words ? capitalize(words) : "Home";
}

const PAGES_ROUTER_PAGE = /__NEXT_P\s*=[^;]*?\.push\(\[\s*"([^"]+)"\s*,\s*(?:function\s*\(\)\s*\{\s*return\s+\w+\((\d+)\)|\(\)\s*=>\s*\w+\((\d+)\))/g;
const TURBOPACK_PAGE = /(?:let|var|const)\s+([\w$]+)\s*=\s*"([^"]+)"\s*;?\s*\(window\.__NEXT_P\s*=[^;]*?\.push\(\[\s*\1\s*,\s*(?:function\s*\(\)\s*\{\s*return\s+[\w$]+\.r\((\d+)\)|\(\)\s*=>\s*[\w$]+\.r\((\d+)\))/g;

export function nextModuleHints(ctx: DiscoverContext): ModuleHint[] {
  const hints: ModuleHint[] = [];
  const first = ctx.pages[0];
  if (!first) return hints;
  const basePath = basePathOf(first) ?? "/";

  const pageName = (route: string) => (route === "/_app" ? "App" : route === "/_error" ? "ErrorPage" : `${routeName(route, "/")}Page`);
  for (const asset of ctx.all.values()) {
    for (const match of asset.body.matchAll(PAGES_ROUTER_PAGE)) {
      hints.push({ id: match[2] ?? match[3]!, name: pageName(match[1]!), weight: 6, reason: `pages router ${match[1]}` });
    }
    for (const match of asset.body.matchAll(TURBOPACK_PAGE)) {
      hints.push({ id: match[3] ?? match[4]!, name: pageName(match[2]!), weight: 6, reason: `pages router ${match[2]}` });
    }
  }

  const onPages = new Map<string, number>();
  const flights = ctx.pages.map((page) => ({ page, references: flightOf(page.html).references }));
  for (const { references } of flights) for (const id of new Set(references.map((r) => r.moduleId))) onPages.set(id, (onPages.get(id) ?? 0) + 1);

  for (const { page, references } of flights) {
    const chunkUse = new Map<string, number>();
    for (const r of references) for (const c of new Set([...r.chunkPaths, ...r.chunkIds])) chunkUse.set(c, (chunkUse.get(c) ?? 0) + 1);
    const baseline = new Set([...chunkUse].filter(([, n]) => n * 2 >= references.length).map(([c]) => c));
    const route = routeName(page.url.pathname, basePath);
    const seen = new Map<string, number>();
    for (const r of references) {
      if (!GENERIC_EXPORTS.has(r.exportName) && /^[A-Za-z_$][\w$]*$/.test(r.exportName)) {
        hints.push({ id: r.moduleId, name: r.exportName, weight: 3, reason: `rsc export ${r.exportName}` });
      }
      const specific = [...r.chunkPaths, ...r.chunkIds].some((c) => !baseline.has(c));
      if (!specific) {
        if (r.exportName === "default") hints.push({ id: r.moduleId, name: "RootLayoutClient", weight: 6, reason: `client reference on ${page.url.pathname}` });
        continue;
      }
      const layoutChunk = r.chunkPaths.find((c) => /\/app\/(.+\/)?layout-[\w-]+\.js$/.test(c));
      const pageChunk = r.chunkPaths.some((c) => /\/app\/(.+\/)?page-[\w-]+\.js$/.test(c));
      const everywhere = ctx.pages.length > 1 && onPages.get(r.moduleId) === ctx.pages.length;
      let base: string;
      if (layoutChunk || (!pageChunk && everywhere)) {
        const segment = layoutChunk ? /\/app\/(.+)\/layout-/.exec(layoutChunk)?.[1] : undefined;
        base = segment ? `${capitalize(camel(segment.replace(/\//g, " ")))}LayoutClient` : "RootLayoutClient";
      } else {
        base = r.exportName === "default" ? `${route}PageClient` : `${route}PageDependency`;
      }
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      hints.push({
        id: r.moduleId,
        name: count > 1 ? `${base}${count}` : base,
        weight: r.exportName === "default" ? 6 : 2,
        reason: `client reference on ${page.url.pathname}`,
      });
    }
  }
  return hints;
}

export function normalizeNextSource(source: string): string {
  const cleaned = source
    .replace(/^webpack:\/\/_N_E\//, "")
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/^turbopack:\/\/\/\[project\]\//, "")
    .replace(/^turbopack:\/\/\/\[turbopack\]\//, "_turbopack/")
    .replace(/^turbopack:\/\/\/\[([^\]]+)\]\//, "_$1/");
  return normalizeSourcePath(cleaned);
}

export default defineAdapter({
  name: "next",
  detect: detectNext,
  collectAssets: collectNextAssets,
  discover: expandNextAssets,
  scopePath: basePathOf,
  ownsUrl: (url, page) => url.href.startsWith(nextBase(page).href),
  parseChunk(asset) {
    if (isWebpackChunk(asset.body)) return unpackWebpackChunk(asset.body, asset.ref.url);
    if (isTurbopackChunk(asset.body)) return unpackTurbopackChunk(asset.body, asset.ref.url);
    return null;
  },
  normalizeSourcePath: normalizeNextSource,
  moduleHints: nextModuleHints,
  isRuntime: (asset) => isWebpackRuntime(asset) || isTurbopackRuntime(asset),
  coverage: (ctx) => ({ unfetchedChunkIds: webpackLazyState(ctx.all).unresolved }),
  pageData(page) {
    const text = decodeFlight(page.html);
    return text ? [{ suffix: "rsc.txt", content: text }] : [];
  },
});
