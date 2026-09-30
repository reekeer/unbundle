import type { Logger } from "../log.ts";
import type { ResourceType } from "../types.ts";

const CHROME_MAJOR = "140";

export const CHROME = {
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  secChUa: `"Chromium";v="${CHROME_MAJOR}", "Not=A?Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`,
  platform: '"Windows"',
  acceptLanguage: "en-US,en;q=0.9",
  acceptEncoding: "gzip, deflate, br",
};

const ACCEPT: Record<ResourceType, string> = {
  document: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  script: "*/*",
  module: "*/*",
  style: "text/css,*/*;q=0.1",
  manifest: "*/*",
  worker: "*/*",
  sourcemap: "*/*",
  fetch: "*/*",
  other: "*/*",
};

const FETCH_META: Record<ResourceType, { mode: string; dest: string; priority: string }> = {
  document: { mode: "navigate", dest: "document", priority: "u=0, i" },
  script: { mode: "no-cors", dest: "script", priority: "u=1" },
  module: { mode: "cors", dest: "script", priority: "u=1" },
  style: { mode: "no-cors", dest: "style", priority: "u=0" },
  manifest: { mode: "cors", dest: "manifest", priority: "u=4" },
  worker: { mode: "same-origin", dest: "worker", priority: "u=1" },
  sourcemap: { mode: "cors", dest: "empty", priority: "u=4" },
  fetch: { mode: "cors", dest: "empty", priority: "u=1, i" },
  other: { mode: "no-cors", dest: "empty", priority: "u=4" },
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_REDIRECTS = 10;

export interface BrowserOptions {
  concurrency: number;
  retries: number;
  timeoutMs: number;
  maxBytes: number;
}

export interface RequestContext {
  initiator: string;
  referrer?: URL;
  userInitiated?: boolean;
}

export interface BrowserResponse {
  url: string;
  finalUrl: string;
  status: number;
  headers: Headers;
  contentType: string;
  body: string;
}

export interface NetworkEntry {
  startedAt: string;
  url: string;
  type: ResourceType;
  initiator: string;
  requestHeaders: Array<[string, string]>;
  status: number;
  statusText: string;
  responseHeaders: Array<[string, string]>;
  mimeType: string;
  size: number;
  timeMs: number;
  redirectTo?: string;
  error?: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  sameSite: "strict" | "lax" | "none";
  expires: number | null;
}

export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  store(url: URL, setCookie: string[]): void {
    for (const line of setCookie) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const cookie: Cookie = {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: url.hostname,
        hostOnly: true,
        path: url.pathname.lastIndexOf("/") > 0 ? url.pathname.slice(0, url.pathname.lastIndexOf("/")) : "/",
        secure: false,
        sameSite: "lax",
        expires: null,
      };
      let rejected = false;
      for (const attr of attrs) {
        const [rawKey = "", ...rest] = attr.split("=");
        const key = rawKey.trim().toLowerCase();
        const value = rest.join("=").trim();
        if (key === "domain" && value) {
          const domain = value.replace(/^\./, "").toLowerCase();
          if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) rejected = true;
          cookie.domain = domain;
          cookie.hostOnly = false;
        } else if (key === "path" && value.startsWith("/")) cookie.path = value;
        else if (key === "secure") cookie.secure = true;
        else if (key === "samesite") cookie.sameSite = value.toLowerCase() === "none" ? "none" : value.toLowerCase() === "strict" ? "strict" : "lax";
        else if (key === "max-age" && /^-?\d+$/.test(value)) cookie.expires = Date.now() + Number(value) * 1000;
        else if (key === "expires" && cookie.expires === null) {
          const time = Date.parse(value);
          if (!Number.isNaN(time)) cookie.expires = time;
        }
      }
      if (rejected) continue;
      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      if (cookie.expires !== null && cookie.expires <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, cookie);
    }
  }

  header(url: URL, crossSite: boolean): string | null {
    const now = Date.now();
    const matches = [...this.cookies.values()].filter((c) => {
      if (c.expires !== null && c.expires <= now) return false;
      if (c.secure && url.protocol !== "https:") return false;
      if (crossSite && c.sameSite !== "none") return false;
      const domainOk = c.hostOnly ? url.hostname === c.domain : url.hostname === c.domain || url.hostname.endsWith(`.${c.domain}`);
      return domainOk && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`));
    });
    if (!matches.length) return null;
    return matches
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
}

function site(url: URL): string {
  const labels = url.hostname.split(".");
  if (/^[\d.]+$/.test(url.hostname) || labels.length <= 2) return `${url.protocol}//${url.hostname}`;
  return `${url.protocol}//${labels.slice(-2).join(".")}`;
}

function fetchSite(target: URL, referrer: URL | undefined): "none" | "same-origin" | "same-site" | "cross-site" {
  if (!referrer) return "none";
  if (referrer.origin === target.origin) return "same-origin";
  return site(referrer) === site(target) ? "same-site" : "cross-site";
}

function referrerHeader(target: URL, referrer: URL | undefined): string | null {
  if (!referrer) return null;
  if (referrer.protocol === "https:" && target.protocol === "http:") return null;
  if (referrer.origin === target.origin) {
    const clean = new URL(referrer.href);
    clean.hash = "";
    return clean.href;
  }
  return `${referrer.origin}/`;
}

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active < concurrency) queue.shift()?.();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

export class Browser {
  readonly cookies = new CookieJar();
  readonly network: NetworkEntry[] = [];
  private readonly inflight = new Map<string, Promise<BrowserResponse>>();
  private readonly limit: ReturnType<typeof createLimiter>;

  constructor(
    private readonly options: BrowserOptions,
    private readonly log: Logger,
  ) {
    this.limit = createLimiter(Math.max(1, options.concurrency));
  }

  get(url: string, type: ResourceType, ctx: RequestContext): Promise<BrowserResponse> {
    const key = `${type}|${url}`;
    const cached = this.inflight.get(key);
    if (cached) return cached;
    const promise = this.limit(() => this.withRetries(url, type, ctx));
    this.inflight.set(key, promise);
    return promise;
  }

  buildHeaders(target: URL, type: ResourceType, ctx: RequestContext): Array<[string, string]> {
    const meta = FETCH_META[type];
    const siteRel = fetchSite(target, ctx.referrer);
    const headers: Array<[string, string]> = [];
    const push = (name: string, value: string | null | undefined) => {
      if (value) headers.push([name, value]);
    };
    if (type === "document") {
      push("sec-ch-ua", CHROME.secChUa);
      push("sec-ch-ua-mobile", "?0");
      push("sec-ch-ua-platform", CHROME.platform);
      push("upgrade-insecure-requests", "1");
      push("user-agent", CHROME.userAgent);
      push("accept", ACCEPT.document);
      push("sec-fetch-site", siteRel);
      push("sec-fetch-mode", meta.mode);
      if (ctx.userInitiated !== false) push("sec-fetch-user", "?1");
      push("sec-fetch-dest", meta.dest);
    } else {
      push("sec-ch-ua-platform", CHROME.platform);
      push("user-agent", CHROME.userAgent);
      push("sec-ch-ua", CHROME.secChUa);
      push("sec-ch-ua-mobile", "?0");
      push("accept", ACCEPT[type]);
      if (meta.mode === "cors" && ctx.referrer && ctx.referrer.origin !== target.origin) push("origin", ctx.referrer.origin);
      push("sec-fetch-site", siteRel);
      push("sec-fetch-mode", meta.mode);
      push("sec-fetch-dest", meta.dest);
    }
    push("referer", referrerHeader(target, ctx.referrer));
    push("accept-encoding", CHROME.acceptEncoding);
    push("accept-language", CHROME.acceptLanguage);
    push("cookie", this.cookies.header(target, siteRel === "cross-site"));
    push("priority", meta.priority);
    return headers;
  }

  private async withRetries(url: string, type: ResourceType, ctx: RequestContext): Promise<BrowserResponse> {
    const parsed = URL.parse(url);
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) throw new HttpError(`unsupported URL ${url}`);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.follow(parsed, type, ctx);
      } catch (err) {
        const retryable = err instanceof HttpError ? err.retryable : err instanceof TypeError;
        if (!retryable || attempt >= this.options.retries) throw err;
        await Bun.sleep(Math.min(250 * 2 ** attempt, 4000));
      }
    }
  }

  private async follow(start: URL, type: ResourceType, ctx: RequestContext): Promise<BrowserResponse> {
    let url = start;
    const referrer = ctx.referrer;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await this.once(url, type, { ...ctx, referrer });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        const next = URL.parse(response.headers.get("location")!, url);
        if (!next) throw new HttpError(`bad redirect from ${url.href}`);
        this.network.at(-1)!.redirectTo = next.href;
        url = next;
        continue;
      }
      if (response.status >= 400) {
        throw new HttpError(`HTTP ${response.status}`, response.status, RETRYABLE_STATUS.has(response.status));
      }
      return { url: start.href, finalUrl: url.href, status: response.status, headers: response.headers, contentType: response.headers.get("content-type") ?? "", body: response.body };
    }
    throw new HttpError(`too many redirects from ${start.href}`);
  }

  private async once(url: URL, type: ResourceType, ctx: RequestContext): Promise<{ status: number; headers: Headers; body: string }> {
    const requestHeaders = this.buildHeaders(url, type, ctx);
    const startedAt = new Date();
    const began = performance.now();
    const entry: NetworkEntry = {
      startedAt: startedAt.toISOString(),
      url: url.href,
      type,
      initiator: ctx.initiator,
      requestHeaders,
      status: 0,
      statusText: "",
      responseHeaders: [],
      mimeType: "",
      size: 0,
      timeMs: 0,
    };
    this.network.push(entry);
    try {
      const response = await fetch(url.href, {
        method: "GET",
        redirect: "manual",
        headers: requestHeaders,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      entry.status = response.status;
      entry.statusText = response.statusText;
      response.headers.forEach((value, name) => entry.responseHeaders.push([name, value]));
      entry.mimeType = response.headers.get("content-type") ?? "";
      this.cookies.store(url, response.headers.getSetCookie());
      const body = response.status >= 300 && response.status < 400 ? (await response.body?.cancel(), "") : await readCapped(response, this.options.maxBytes);
      entry.size = Buffer.byteLength(body);
      entry.timeMs = Math.round(performance.now() - began);
      this.log.debug(`GET ${response.status} ${type} ${formatSize(entry.size)} ${entry.timeMs}ms ${url.href}`);
      return { status: response.status, headers: response.headers, body };
    } catch (err) {
      entry.timeMs = Math.round(performance.now() - began);
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        entry.error = `timeout after ${this.options.timeoutMs}ms`;
        throw new HttpError(entry.error, undefined, true);
      }
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new HttpError(`response too large (${declared} bytes > ${maxBytes})`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(`response too large (> ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}kB`;
}
