import type { Page } from "../types.ts";
import type { NetworkEntry } from "./browser.ts";

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
