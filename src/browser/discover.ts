import { parse, type HTMLElement } from "node-html-parser";
import type { AssetRef, Page, ResourceType } from "../types.ts";
import type { Browser } from "./browser.ts";
import { runtimeDependencies } from "./runtime.ts";

const transpiler = new Bun.Transpiler({ loader: "js" });
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/g;
const CSS_URL = /\burl\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)"']+))\s*\)/g;
const MEDIA = /\.(?:avif|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf|eot|mp3|mp4|ogg|webm)$/i;
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
    else if (rel.includes("icon") || rel.includes("apple-touch-icon")) add(href, "other", "icon", true);
    else if (rel.includes("preload") || rel.includes("prefetch")) {
      if (as === "script") add(href, "script", rel.includes("preload") ? "preload" : "prefetch", rel.includes("prefetch"));
      else if (as === "style") add(href, "style", "preload");
      else if (as === "fetch" && /\.wasm(?:[?#]|$)/i.test(href ?? "")) add(href, "other", "preload", true);
      else if (as === "fetch" && /\.m?js(\?|$)/.test(href ?? "")) add(href, "fetch", "preload", true);
      else if (as === "font" || as === "image") add(href, "other", "preload", true);
    }
  }
  for (const node of root.querySelectorAll("img[src], video[poster], input[type=image][src]")) add(node.getAttribute("src") ?? node.getAttribute("poster"), "other", "media", true);
  for (const node of root.querySelectorAll("img[srcset], source[srcset]")) {
    const srcset = node.getAttribute("srcset") ?? "";
    if (/\bdata:/i.test(srcset)) continue;
    for (const part of srcset.split(",")) add(part.trim().split(/\s+/)[0], "other", "media", true);
  }
  for (const node of root.querySelectorAll("style")) refs.push(...styleResources(node.text, page.baseUrl.href));
  for (const inline of inlineScripts(page)) {
    refs.push(...scriptResources(inline.code, page.baseUrl.href, inline.module));
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

export function scriptResources(code: string, scriptUrl: string, module: boolean, pageBase = scriptUrl): AssetRef[] {
  const refs: AssetRef[] = scriptImports(code, scriptUrl, module).map((url) => ({
    url,
    type: guessType(url) === "style" ? "style" : "module",
    initiator: `import:${scriptUrl}`,
  }));
  for (const { href, base, kind, source } of runtimeDependencies(code, scriptUrl, pageBase)) {
    const url = resolveHttpUrl(href, base);
    if (url) refs.push({ url: url.href, type: kind, initiator: `${source}:${scriptUrl}`, optional: true });
  }
  return refs;
}

export function styleResources(css: string, styleUrl: string): AssetRef[] {
  const refs: AssetRef[] = [];
  for (const match of css.matchAll(CSS_IMPORT)) {
    const url = resolveHttpUrl(match[1]!, styleUrl);
    if (url) refs.push({ url: url.href, type: "style", initiator: `css-import:${styleUrl}` });
  }
  for (const match of css.matchAll(CSS_URL)) {
    const url = resolveHttpUrl((match[1] ?? match[2] ?? match[3])!, styleUrl);
    if (url && MEDIA.test(url.pathname)) refs.push({ url: url.href, type: "other", initiator: `css-url:${styleUrl}`, optional: true });
  }
  return refs;
}
