import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";
import type { OutputTree } from "../output.ts";
import type { Asset, FileEntry, Page, Preview } from "../types.ts";

const TEXT_RESOURCE = /^(?:application\/(?:javascript|json|manifest\+json)|text\/(?:javascript|css|plain)|image\/svg\+xml)(?:\s*;|$)/i;
const MEDIA_RESOURCE = /^(?:(?:image|font|audio|video)\/|application\/(?:octet-stream|font-|vnd\.ms-fontobject))/i;
const SCRIPT = /\.[cm]?js$/i;

function previewHtml(page: Page, origin: string): string {
  const root = parse(page.html, { comment: true, blockTextElements: { script: true, style: true, noscript: true, pre: true, textarea: true } });
  for (const el of root.querySelectorAll("[src], [href]")) {
    for (const attr of ["src", "href"]) {
      const value = el.getAttribute(attr);
      if (!value || !/^(?:https?:)?\/\//i.test(value)) continue;
      const url = URL.parse(value, page.url);
      if (url?.origin === origin) el.setAttribute(attr, `${url.pathname}${url.search}${url.hash}`);
    }
    if (el.hasAttribute("integrity")) {
      const url = URL.parse(el.getAttribute("src") ?? el.getAttribute("href") ?? "", page.baseUrl);
      if (url?.origin === origin) el.removeAttribute("integrity");
    }
  }
  // A downloaded CSP may contain hashes for the old source or a production origin.
  for (const meta of root.querySelectorAll("meta[http-equiv]")) if (meta.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy") meta.remove();
  return root.toString();
}

export async function writePreview(tree: OutputTree, pages: Page[], assets: Map<string, Asset>, files: FileEntry[], adapter: string | null): Promise<Preview> {
  const start = pages[0]!;
  const origin = start.url.origin;
  const routes: Preview["routes"] = [];
  const replay: string[] = [];
  const output = new Map(tree.all().map((file) => [file.path, file]));
  const add = (path: string, content: string) => tree.add({ path, content, kind: "data", renamable: false }).path;
  const entryHtml = output.get("index.html");
  const vite = !!(adapter === "vite" && entryHtml && /<script\s+type="module"\s+src="\/src\//.test(entryHtml.content));
  const originalScripts = [...assets.values()].filter((asset) => asset.ref.type === "script" || asset.ref.type === "module");
  const entries = new Map(files.filter((file) => file.status === "ok").map((file) => [file.url, file.localPath]));
  const sourceEntry = !adapter && originalScripts.length === 1 ? files.find((entry) => entry.url === originalScripts[0]!.ref.url && entry.via === "deminify" && entry.localPath && SCRIPT.test(entry.localPath))?.localPath : null;
  const known = new Set<string>();
  const route = (url: URL, path: string, contentType: string) => {
    const key = url.pathname + url.search;
    if (url.origin !== origin || known.has(key)) return;
    known.add(key);
    routes.push([key, path, contentType]);
  };
  const pagePath = (page: Page, index: number) => index === 0 ? "preview/index.html" : posix.join("preview/pages", page.url.pathname.replace(/^\/|\/$/g, ""), "index.html");
  for (const [index, page] of pages.entries()) {
    const path = add(pagePath(page, index), previewHtml(page, origin));
    route(page.url, path, "text/html; charset=utf-8");
    route(page.requestedUrl, path, "text/html; charset=utf-8");
  }
  for (const asset of assets.values()) {
    const url = new URL(asset.ref.url);
    if (url.origin !== origin || known.has(url.pathname + url.search)) continue;
    const isScript = asset.ref.type === "script" || asset.ref.type === "module" || asset.ref.type === "worker" || /javascript/i.test(asset.contentType);
    const css = asset.ref.type === "style";
    const wasm = /\.wasm$/i.test(url.pathname) || /^application\/wasm\b/i.test(asset.contentType);
    const recorded = asset.ref.initiator === "har";
    const media = !!asset.bytes || asset.ref.type === "other" && MEDIA_RESOURCE.test(asset.contentType);
    if (!isScript && !css && !media && !recorded && !TEXT_RESOURCE.test(asset.contentType)) continue;
    const name = url.pathname.replace(/^\/+/, "") || "asset";
    const path = media ? entries.get(asset.ref.url) : sourceEntry && asset === originalScripts[0] && output.has(sourceEntry) ? sourceEntry : add(posix.join("preview/assets", name), asset.body);
    if (!path) continue;
    const type = wasm ? "application/wasm" : isScript ? "application/javascript; charset=utf-8" : css ? "text/css; charset=utf-8" : asset.contentType;
    route(url, path, type);
    if (recorded && asset.ref.type === "fetch") replay.push(url.pathname + url.search);
    if (asset.finalUrl !== asset.ref.url) route(new URL(asset.finalUrl), path, type);
  }
  const preview: Preview = {
    mode: vite ? "vite" : "static",
    entry: start.url.pathname + start.url.search,
    editable: vite ? "src/" : sourceEntry && output.has(sourceEntry) ? sourceEntry : "preview/",
    spa: adapter === "angular" || adapter === "vite" || adapter === "react-router",
    routes,
    ...(replay.length ? { replay } : {}),
  };
  add(".unbundle/preview.json", `${JSON.stringify(preview, null, 2)}\n`);
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./server.ts", import.meta.url))],
    target: "node",
    format: "esm",
    external: ["vite"],
  });
  tree.add({ path: ".unbundle/start.mjs", content: await build.outputs[0]!.text(), kind: "data", renamable: false, noFormat: true });
  return preview;
}
