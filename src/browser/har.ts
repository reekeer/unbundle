import type { AssetRef, Page, ResourceType } from "../types.ts";
import type { BrowserResponse, NetworkEntry } from "./browser.ts";

export function toHar(entries: NetworkEntry[], pages: readonly Page[], creator: { name: string; version: string }): unknown {
  const pageRefs = pages.map((page, index) => ({ id: `page_${index + 1}`, url: page.url.href }));
  const pageFor = (entry: NetworkEntry) => {
    const initiatorUrl = entry.initiator.replace(/^[\w-]+:/, "");
    const match = pageRefs.find((p) => p.url === entry.url || p.url === initiatorUrl);
    return match?.id ?? pageRefs[0]?.id ?? "page_1";
  };
  return {
    log: {
      version: "1.2",
      creator,
      pages: pages.map((page, index) => ({
        startedDateTime: entries.find((e) => e.url === page.requestedUrl.href)?.startedAt ?? new Date().toISOString(),
        id: `page_${index + 1}`,
        title: page.url.href,
        pageTimings: {},
      })),
      entries: entries.map((entry) => ({
        pageref: pageFor(entry),
        startedDateTime: entry.startedAt,
        time: entry.timeMs,
        request: {
          method: "GET",
          url: entry.url,
          httpVersion: "HTTP/1.1",
          headers: entry.requestHeaders.map(([name, value]) => ({ name, value })),
          queryString: [...new URL(entry.url).searchParams].map(([name, value]) => ({ name, value })),
          cookies: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: entry.status,
          statusText: entry.error ?? entry.statusText,
          httpVersion: "HTTP/1.1",
          headers: entry.responseHeaders.map(([name, value]) => ({ name, value })),
          cookies: [],
          content: { size: entry.size, mimeType: entry.mimeType },
          redirectURL: entry.redirectTo ?? "",
          headersSize: -1,
          bodySize: entry.size,
        },
        cache: {},
        timings: { send: 0, wait: entry.timeMs, receive: 0 },
        _resourceType: entry.type,
        _initiator: entry.initiator,
      })),
    },
  };
}

interface HarEntry {
  _resourceType?: string;
  request?: { method?: string; url?: string; headers?: Array<{ name: string; value: string }> };
  response?: { status?: number; content?: { mimeType?: string; text?: string; encoding?: string } };
}

export interface RecordedResponse extends BrowserResponse {
  ref: AssetRef;
}

function resourceType(hint: string | undefined, mime: string, url: URL): ResourceType {
  if (hint === "document" || (!hint && /^text\/html\b/i.test(mime))) return "document";
  if (hint === "script" || /(?:java|ecma)script/i.test(mime)) return "script";
  if (hint === "stylesheet" || /^text\/css\b/i.test(mime)) return "style";
  if (hint === "xhr" || hint === "fetch") return "fetch";
  if (!hint && (url.search || /\.(?:php|aspx|cgi)$/i.test(url.pathname) || url.pathname.startsWith("/api/")) && /^(?:application\/(?:[^;]+\+)?json\b|text\/plain\b)/i.test(mime)) return "fetch";
  return "other";
}

export async function readHar(path: string, origin: string, maxBytes: number): Promise<Map<string, RecordedResponse>> {
  const file = Bun.file(path);
  if (file.size > 200 * 1024 * 1024) throw new Error("HAR exceeds 200 MiB");
  const data: { log?: { entries?: HarEntry[] } } = await file.json();
  if (!Array.isArray(data?.log?.entries)) throw new Error("Invalid HAR: expected log.entries");
  const responses = new Map<string, RecordedResponse>();
  const ambiguous = new Set<string>();
  for (const entry of data.log.entries) {
    if (!entry?.request || entry.request.method !== "GET" || typeof entry.request.url !== "string" || entry.response?.status !== 200) continue;
    if (Array.isArray(entry.request.headers) && entry.request.headers.some((header) => /^authorization$/i.test(header?.name))) continue;
    const url = URL.parse(entry.request.url);
    if (url?.origin !== origin || url.username || url.password) continue;
    url.hash = "";
    const content = entry.response.content;
    if (typeof content?.text !== "string" || (content.encoding && content.encoding !== "base64")) continue;
    const contentType = typeof content.mimeType === "string" && !/[\r\n]/.test(content.mimeType) ? content.mimeType : "application/octet-stream";
    const bytes = Buffer.from(content.text, content.encoding === "base64" ? "base64" : "utf8");
    if (bytes.byteLength > maxBytes || ambiguous.has(url.href)) continue;
    if (/^application\/wasm\b/i.test(contentType) && bytes.byteLength < 8) continue;
    const type = resourceType(entry._resourceType, contentType, url);
    const textual = type === "document" || type === "script" || type === "style" || /^(?:text\/|application\/(?:[^;]+\+)?(?:json|xml)\b|image\/svg\+xml)/i.test(contentType);
    const body = textual ? bytes.toString("utf8") : "";
    const previous = responses.get(url.href);
    if (previous && (previous.contentType !== contentType || !bytes.equals(previous.bytes ?? Buffer.from(previous.body)))) {
      responses.delete(url.href);
      ambiguous.add(url.href);
      continue;
    }
    responses.set(url.href, {
      ref: { url: url.href, type, initiator: "har" },
      url: url.href, finalUrl: url.href, status: 200, headers: new Headers({ "content-type": contentType }), contentType, body,
      ...(!textual ? { bytes } : {}),
    });
  }
  return responses;
}
