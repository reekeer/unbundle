import { posix } from "node:path";
import { parse, type HTMLElement, type Node } from "node-html-parser";
import type { StylesOutput } from "../types.ts";

const FRAMEWORK_INLINE = /self\.__next_[fs]|__next_f|\$R[CSTX]\s*[(=]|__NEXT_DATA__|__NEXT_P|__nuxt|window\.__NUXT__|__remixContext|__sveltekit|requestAnimationFrame\(function\(\)\{\$RT/;
const DROPPED_LINKS = /\b(preload|modulepreload|prefetch|preconnect|dns-prefetch)\b/i;
const REACT_MARKER = /^\s*(\/?\$[?!~]?|\/?&|)\s*$/;

export interface ReadablePageOptions {
  pageUrl: URL;
  filePath: string;
  owned: (url: URL) => boolean;
  styles: StylesOutput;
  prepare?: (html: string) => string;
}

export interface ReadablePage {
  html: string;
  removedScripts: number;
  thirdParty: string[];
}

function isComment(node: Node): boolean {
  return node.nodeType === 8;
}

function removeMarkers(node: HTMLElement): void {
  for (const child of [...node.childNodes]) {
    if (isComment(child) && REACT_MARKER.test(child.rawText)) child.remove();
    else if (child.nodeType === 1) removeMarkers(child as HTMLElement);
  }
}

function isEmptyHidden(element: HTMLElement): boolean {
  return element.hasAttribute("hidden") && !element.childNodes.some((c) => c.nodeType === 1 || (c.nodeType === 3 && c.rawText.trim()));
}

function cloudflareEmail(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex)) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let bytes = "";
  for (let i = 2; i < hex.length; i += 2) bytes += `%${(parseInt(hex.slice(i, i + 2), 16) ^ key).toString(16).padStart(2, "0")}`;
  try {
    const email = decodeURIComponent(bytes);
    return /^[^\s<>"]+@[^\s<>"]+$/.test(email) ? email : null;
  } catch {
    return null;
  }
}

export function decodeCloudflareEmails(html: string): string {
  if (!html.includes("__cf_email__") && !html.includes("/cdn-cgi/l/email-protection")) return html;
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return html
    .replace(/<a\b([^>]*?)\bhref="\/cdn-cgi\/l\/email-protection"([^>]*?)\bdata-cfemail="([0-9a-f]+)"([^>]*)>[\s\S]*?<\/a>/gi, (match, a: string, b: string, hex: string, c: string) => {
      const email = cloudflareEmail(hex);
      return email ? `<a${`${a}${b}${c}`.replace(/\s*class="__cf_email__"/, "")} href="mailto:${escape(email)}">${escape(email)}</a>` : match;
    })
    .replace(/<(span|template)\b[^>]*\bdata-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/\1>/gi, (match, tag: string, hex: string) => {
      const email = cloudflareEmail(hex);
      return email ? escape(email) : match;
    })
    .replace(/(["'])\/cdn-cgi\/l\/email-protection#([0-9a-f]+)\1/gi, (match, quote: string, hex: string) => {
      const email = cloudflareEmail(hex);
      return email ? `${quote}mailto:${escape(email)}${quote}` : match;
    });
}

const SERVICES: Array<[RegExp, string]> = [
  [/^telegram\.org\/js\/telegram-widget\.js/, "Telegram Login Widget"],
  [/^telegram\.org\/js\/telegram-web-app\.js/, "Telegram Mini App SDK"],
  [/^accounts\.google\.com\/gsi\//, "Google Sign-In"],
  [/^apis\.google\.com\/js\/platform\.js/, "Google Sign-In (legacy)"],
  [/^challenges\.cloudflare\.com\/turnstile\//, "Cloudflare Turnstile"],
  [/^(www\.)?(google\.com|recaptcha\.net|gstatic\.com)\/recaptcha\//, "reCAPTCHA"],
  [/^(js\.)?hcaptcha\.com\//, "hCaptcha"],
  [/^(unpkg\.com\/@vkid|vk\.com\/js\/api\/openapi\.js)/, "VK ID"],
  [/^yastatic\.net\/s3\/passport-sdk\//, "Yandex ID"],
  [/^appleid\.cdn-apple\.com\/appleauth\//, "Sign in with Apple"],
  [/^connect\.facebook\.net\//, "Facebook SDK"],
  [/^js\.stripe\.com\//, "Stripe.js"],
  [/^mc\.yandex\.ru\//, "Yandex Metrika"],
  [/^www\.googletagmanager\.com\//, "Google Tag Manager"],
];

function serviceLabel(url: URL): string {
  const host = url.host.replace(/--/g, "-");
  const found = SERVICES.find(([pattern]) => pattern.test(`${url.host}${url.pathname}`))?.[1];
  return found ? `${host} (${found})` : host;
}

export function readablePage(html: string, options: ReadablePageOptions): ReadablePage {
  const decoded = decodeCloudflareEmails(html);
  const source = options.prepare && /\$R[CS]\(/.test(decoded) ? options.prepare(decoded) : decoded;
  const root = parse(source, { comment: true, blockTextElements: { script: true, style: true, noscript: true, pre: true, textarea: true } });
  const relative = (target: string) => posix.relative(posix.dirname(options.filePath), target);
  let removedScripts = 0;
  let firstRemoved: { parent: HTMLElement; index: number } | null = null;
  const thirdParty: string[] = [];

  for (const script of root.querySelectorAll("script")) {
    const deferred = /self\.__next_s/.test(script.rawText) ? [...script.rawText.matchAll(/\[\s*"((?:https?:)?\/\/[^"]+|\/[^"]*)"/g)].map((m) => m[1]!) : [];
    for (const raw of deferred) {
      const url = URL.parse(raw, options.pageUrl);
      if (!url || options.owned(url)) continue;
      thirdParty.push(url.href);
      script.insertAdjacentHTML("beforebegin", `<!-- third-party script (next/script): ${serviceLabel(url)} --><script src="${url.href.replace(/"/g, "&quot;")}"></script>`);
    }
    const src = script.getAttribute("src");
    const type = (script.getAttribute("type") ?? "").toLowerCase();
    if (src) {
      const url = URL.parse(src, options.pageUrl);
      if (url && !options.owned(url)) {
        thirdParty.push(url.href);
        script.insertAdjacentHTML("beforebegin", `<!-- third-party script: ${serviceLabel(url)} -->`);
        continue;
      }
    } else if (type === "application/ld+json" || !(FRAMEWORK_INLINE.test(script.rawText) || /json/.test(type))) continue;
    if (!firstRemoved && script.parentNode) firstRemoved = { parent: script.parentNode, index: script.parentNode.childNodes.indexOf(script) };
    script.remove();
    removedScripts++;
  }

  for (const link of root.querySelectorAll("link")) {
    const rel = link.getAttribute("rel") ?? "";
    const href = URL.parse(link.getAttribute("href") ?? "", options.pageUrl);
    if (DROPPED_LINKS.test(rel)) link.remove();
    else if (/\bstylesheet\b/i.test(rel) && href && options.styles.sources.has(href.href)) link.remove();
  }
  for (const template of root.querySelectorAll("template")) if (/^[BPS]:/.test(template.getAttribute("id") ?? "")) template.remove();

  removeMarkers(root);
  for (const element of root.querySelectorAll("div")) if (isEmptyHidden(element)) element.remove();

  const head = root.querySelector("head");
  const local = [options.styles.tailwind?.path, options.styles.app].filter((p): p is string => !!p);
  if (head && local.length) head.insertAdjacentHTML("beforeend", local.map((p) => `<link rel="stylesheet" href="${relative(p)}">`).join(""));
  if (removedScripts) {
    const note = `<!-- unbundle: ${removedScripts} framework/app script(s) removed; recovered code is in ${relative("js")}/, the exact original page is in ${relative(posix.join(".chunks", options.filePath))} -->`;
    const body = root.querySelector("body");
    if (body) body.insertAdjacentHTML("beforeend", note);
    else if (firstRemoved) firstRemoved.parent.insertAdjacentHTML("beforeend", note);
  }
  return { html: root.toString(), removedScripts, thirdParty };
}
