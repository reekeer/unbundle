import { parse, type HTMLElement } from "node-html-parser";
import type { AssetRef, Page, ResourceType } from "../types.ts";
import type { Browser } from "./browser.ts";

const transpiler = new Bun.Transpiler({ loader: "js" });
const WORKER = /new\s+(?:Shared)?Worker\(\s*(?:new\s+URL\(\s*)?["'`]([^"'`$]+)["'`]/g;
const SERVICE_WORKER = /serviceWorker\.register\(\s*["'`]([^"'`$]+)["'`]/g;
const IMPORT_SCRIPTS = /importScripts\(\s*["'`]([^"'`$]+)["'`]/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/g;
const META_REFRESH = /^\s*\d+\s*;\s*url\s*=\s*['"]?([^'"]+)/i;

export function resolveHttpUrl(href: string, base: URL | string): URL | null {
  const url = URL.parse(href.trim(), base);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  url.hash = "";
  return url;
}

export function guessType(url: string): ResourceType {
  const path = URL.parse(url)?.pathname ?? url;
  if (/\.m?js$/i.test(path)) return "script";
  if (/\.css$/i.test(path)) return "style";
  if (/\.map$/i.test(path)) return "sourcemap";
  if (/\.(webmanifest|json)$/i.test(path)) return "manifest";
  return "other";
}

export function parseHtml(html: string): HTMLElement {
  return parse(html, { comment: false, blockTextElements: { script: true, style: true } });
}

export async function openPage(browser: Browser, url: URL, referrer?: URL): Promise<Page> {
  let target = url;
  for (let refresh = 0; ; refresh++) {
    const response = await browser.get(target.href, "document", { initiator: referrer ? `link:${referrer.href}` : "navigation", ...(referrer ? { referrer } : {}) });
    const finalUrl = new URL(response.finalUrl);
    const root = parseHtml(response.body);
    const content = root.querySelector('meta[http-equiv="refresh" i]')?.getAttribute("content") ?? "";
    const next = META_REFRESH.exec(content)?.[1];
    const nextUrl = next ? resolveHttpUrl(next, finalUrl) : null;
    if (nextUrl && refresh < 2 && nextUrl.href !== finalUrl.href) {
      target = nextUrl;
      continue;
    }
    const baseHref = root.querySelector("base[href]")?.getAttribute("href");
    return {
      requestedUrl: url,
      url: finalUrl,
      baseUrl: (baseHref && resolveHttpUrl(baseHref, finalUrl)) || finalUrl,
      status: response.status,
      headers: response.headers,
      html: response.body,
    };
  }
}

export function importMap(page: Page): Map<string, string> {
  const map = new Map<string, string>();
  for (const script of parseHtml(page.html).querySelectorAll("script[type]")) {
    if ((script.getAttribute("type") ?? "").trim().toLowerCase() !== "importmap") continue;
    let json: { imports?: Record<string, unknown> };
    try {
      json = JSON.parse(script.text) as { imports?: Record<string, unknown> };
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(json.imports ?? {})) {
      const url = typeof value === "string" ? resolveHttpUrl(value, page.baseUrl) : null;
      if (url) map.set(key, url.href);
    }
  }
  return map;
}

export function pageLinks(page: Page): URL[] {
  const links: URL[] = [];
  const root = parseHtml(page.html);
  for (const a of root.querySelectorAll("a[href]")) {
    const url = resolveHttpUrl(a.getAttribute("href") ?? "", page.baseUrl);
    if (url) links.push(url);
  }
  for (const link of root.querySelectorAll("link[rel=alternate][hreflang][href]")) {
    const url = resolveHttpUrl(link.getAttribute("href") ?? "", page.baseUrl);
    if (url) links.push(url);
  }
  return links;
}

export interface InlineScript {
  code: string;
  module: boolean;
}

export function inlineScripts(page: Page): InlineScript[] {
  return parseHtml(page.html)
    .querySelectorAll("script:not([src])")
    .filter((s) => isJavaScript(s.getAttribute("type")))
    .map((s) => ({ code: s.text, module: (s.getAttribute("type") ?? "").trim() === "module" }))
    .filter((s) => s.code.trim());
}

function isJavaScript(type: string | undefined): boolean {
  return !type || /^(module|text\/javascript|application\/javascript)$/i.test(type.trim());
}

export function htmlResources(page: Page): AssetRef[] {
  const root = parseHtml(page.html);
  const refs: AssetRef[] = [];
  const add = (href: string | undefined, type: ResourceType, initiator: string, optional = false) => {
    const url = href ? resolveHttpUrl(href, page.baseUrl) : null;
    if (url) refs.push({ url: url.href, type, initiator, ...(optional ? { optional } : {}) });
  };

  for (const script of root.querySelectorAll("script[src]")) {
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    if (type && !isJavaScript(type)) continue;
    add(script.getAttribute("src"), type === "module" ? "module" : "script", "parser");
  }
  for (const link of root.querySelectorAll("link[href]")) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    const as = (link.getAttribute("as") ?? "").toLowerCase();
    const href = link.getAttribute("href");
    if (rel.includes("stylesheet")) add(href, "style", "parser");
    else if (rel.includes("modulepreload")) add(href, "module", "preload");
    else if (rel.includes("manifest")) add(href, "manifest", "parser", true);
    else if (rel.includes("preload") || rel.includes("prefetch")) {
      if (as === "script") add(href, "script", rel.includes("preload") ? "preload" : "prefetch", rel.includes("prefetch"));
      else if (as === "style") add(href, "style", "preload");
      else if (as === "fetch" && /\.m?js(\?|$)/.test(href ?? "")) add(href, "fetch", "preload", true);
    }
  }
  for (const inline of inlineScripts(page)) {
    for (const url of scriptImports(inline.code, page.baseUrl, inline.module)) refs.push({ url, type: "module", initiator: "inline-script" });
  }
  refs.push(...linkHeaderResources(page.headers, page.url));
  return refs;
}

export function linkHeaderResources(headers: Headers, base: URL): AssetRef[] {
  const header = headers.get("link");
  if (!header) return [];
  const refs: AssetRef[] = [];
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = /<([^>]+)>(.*)/.exec(part.trim());
    if (!match) continue;
    const params = match[2]!.toLowerCase();
    const rel = /rel="?([^";]+)"?/.exec(params)?.[1] ?? "";
    const as = /as="?([^";]+)"?/.exec(params)?.[1] ?? "";
    const url = resolveHttpUrl(match[1]!, base);
    if (!url) continue;
    if (rel.includes("modulepreload")) refs.push({ url: url.href, type: "module", initiator: "link-header" });
    else if (rel.includes("preload") && as === "script") refs.push({ url: url.href, type: "script", initiator: "link-header" });
    else if (rel.includes("preload") && as === "style") refs.push({ url: url.href, type: "style", initiator: "link-header" });
    else if (rel.includes("stylesheet")) refs.push({ url: url.href, type: "style", initiator: "link-header" });
  }
  return refs;
}

function isRelativeSpecifier(spec: string): boolean {
  return /^(\.{1,2}\/|\/|https?:\/\/)/i.test(spec);
}

export function scriptImports(code: string, base: URL | string, module: boolean): string[] {
  const urls = new Set<string>();
  if (module || /\bimport\s*\(|\bimport\s*[\w{*"']|\bexport\s*[{*]/.test(code)) {
    try {
      for (const entry of transpiler.scanImports(code)) {
        if (!isRelativeSpecifier(entry.path)) continue;
        const url = resolveHttpUrl(entry.path, base);
        if (url && /\.(m?js|jsx?|css)$|^[^.]*$/i.test(url.pathname)) urls.add(url.href);
      }
    } catch {
      return [...urls];
    }
  }
  return [...urls];
}

export function scriptResources(code: string, scriptUrl: string, module: boolean): AssetRef[] {
  const refs: AssetRef[] = scriptImports(code, scriptUrl, module).map((url) => ({
    url,
    type: guessType(url) === "style" ? "style" : "module",
    initiator: `import:${scriptUrl}`,
  }));
  for (const [pattern, type] of [
    [WORKER, "worker"],
    [SERVICE_WORKER, "worker"],
    [IMPORT_SCRIPTS, "script"],
  ] as const) {
    for (const match of code.matchAll(pattern)) {
      const url = resolveHttpUrl(match[1]!, scriptUrl);
      if (url) refs.push({ url: url.href, type, initiator: `${type}:${scriptUrl}`, optional: true });
    }
  }
  return refs;
}

export function styleResources(css: string, styleUrl: string): AssetRef[] {
  const refs: AssetRef[] = [];
  for (const match of css.matchAll(CSS_IMPORT)) {
    const url = resolveHttpUrl(match[1]!, styleUrl);
    if (url) refs.push({ url: url.href, type: "style", initiator: `css-import:${styleUrl}` });
  }
  return refs;
}
