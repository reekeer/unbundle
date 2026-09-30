import { parse, type HTMLElement, type Node } from "node-html-parser";
import { posix } from "node:path";
import { relativeImport, type OutputTree } from "../output.ts";
import type { Page } from "../types.ts";
import { formatContent, MARKUP_WIDTH } from "./format.ts";
import { codePlaceholders, Dictionary, hintBefore, markupPlaceholders, placeholderUses, tokens, withPrefix, type Token } from "./localize.ts";
import { decodeCloudflareEmails } from "./html.ts";
import { removeScopedRules, scopedRules } from "./organize.ts";
import { nameModuleLocals } from "./identify.ts";
import { refineCode } from "./worker.ts";

export interface AstroSources {
  root: string;
  moduleFor: (url: string) => string | null;
  stylesheets: string[];
  publicFile: (url: string) => string | null;
}

interface Island {
  name: string;
  source: string | null;
  client: string;
  framework: string;
  props: Map<string, unknown>;
  children: string;
  directives: string[];
}

type HeadItem =
  | { kind: "markup"; key: string; html: string; template: string | null; uses: string[] }
  | { kind: "module"; key: string; path: string; component: string | null }
  | { kind: "inline"; key: string; code: string; module: boolean; type: string | null }
  | { kind: "jsonld"; key: string; value: unknown };

interface Built {
  file: string;
  lang: string | null;
  title: string | null;
  description: string | null;
  site: string | null;
  head: HeadItem[];
  items: string[];
  wrappers: string[];
  bodyAttrs: string;
  islands: Island[];
  scripts: HeadItem[];
  transitions: boolean;
  animations: Map<string, string>;
}

interface Group {
  pages: Built[];
  prefix: number;
  suffix: number;
  varying: Map<number, Map<string, unknown>>;
}

interface Emit {
  from: string;
  imports: Set<string>;
  used: Map<string, string>;
  data: Map<string, string>;
  constants: Map<string, string>;
  scripts: string[];
  override?: (island: Island, key: string) => string | null;
}

interface Output {
  emit: Emit;
  code: string[];
  markup: string;
}

interface Animation {
  name: string;
  duration?: string;
  easing?: string;
  delay?: string;
  fillMode?: string;
  direction?: string;
}

const PLACEHOLDER = "astro-island-slot";
const SCRIPT_SLOT = "astro-script-slot";
const ISLAND_RE = new RegExp(`<${PLACEHOLDER} data-index="(\\d+)"\\s*>\\s*</${PLACEHOLDER}>`, "g");
const SCRIPT_RE = new RegExp(`^([ \\t]*)<${SCRIPT_SLOT} data-index="(\\d+)"\\s*>\\s*</${SCRIPT_SLOT}>`, "gm");
const DIRECTIVE_RE = /\sdata-unbundle-directive="([^"]*)"/g;
const DROPPED_PROPS = /^data-astro-(transition|cid)/;
const COMPONENT_SCRIPT = /\/([\w-]+)\.astro_astro_type_script_index_(\d+)_lang\.[\w-]+\.m?js$/;
const I18N_PROP = /^(translations?|messages|dict(ionary)?|i18n|t|strings|locale(Data|Messages)?)$/i;
const LANG_PROP = /^(current)?(lang|locale|language)$/i;
const EASE_IN_OUT_QUART = "cubic-bezier(0.76, 0, 0.24, 1)";
const RESERVED = new Set(["do", "if", "in", "for", "let", "new", "try", "var", "case", "else", "enum", "this", "void", "with", "break", "catch", "class", "const", "super", "while", "yield", "delete", "export", "import", "public", "return", "static", "switch", "typeof", "default", "extends", "finally", "package", "private", "continue", "debugger", "function", "arguments", "interface", "protected", "implements", "instanceof"]);
const PARSE = { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true, textarea: true } };

function decodeProps(value: unknown, depth = 0): unknown {
  if (depth > 50) return value;
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number") {
    const [type, inner] = value as [number, unknown];
    if (type === 0) return decodeProps(inner, depth + 1);
    if (type === 1 && inner && typeof inner === "object") return Object.fromEntries(Object.entries(inner as Record<string, unknown>).map(([k, v]) => [k, decodeProps(v, depth + 1)]));
    if (type === 2 || type === 5 || type === 6) return Array.isArray(inner) ? inner.map((v) => decodeProps(v, depth + 1)) : inner;
    if (type === 3) return String(inner);
    return inner;
  }
  if (Array.isArray(value)) return value.map((v) => decodeProps(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, decodeProps(v, depth + 1)]));
  return value;
}

function camel(text: string): string {
  return text.replace(/[^A-Za-z0-9]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
}

function identifier(text: string, fallback: string): string {
  const name = camel(text).replace(/^[^A-Za-z_$]+/, "");
  return name && !RESERVED.has(name) ? name : fallback;
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function routeFile(root: string, url: URL): string {
  let path = decodeURIComponent(url.pathname).replace(/\.html?$/, "");
  if (path.endsWith("/")) path += "index";
  return posix.join(root, "pages", `${path.replace(/^\/+/, "") || "index"}.astro`);
}

function splitList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

function animationsOf(declarations: string): Animation[] {
  const props = new Map<string, string[]>();
  for (const part of declarations.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    props.set(part.slice(0, colon).trim(), splitList(part.slice(colon + 1)));
  }
  const names = props.get("animation-name") ?? [];
  return names.map((name, i) => {
    const anim: Animation = { name };
    const pick = (prop: string) => {
      const values = props.get(prop);
      return values && values.length === names.length ? values[i] : undefined;
    };
    const duration = pick("animation-duration");
    const easing = pick("animation-timing-function");
    const direction = pick("animation-direction");
    const delay = pick("animation-delay");
    const fillMode = pick("animation-fill-mode");
    if (duration) anim.duration = duration;
    if (easing) anim.easing = easing;
    if (direction) anim.direction = direction;
    if (delay) anim.delay = delay;
    if (fillMode) anim.fillMode = fillMode;
    return anim;
  });
}

function sameAnimations(a: Animation[] | undefined, b: Animation[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));
}

function fadePreset(duration: string): Record<string, Record<string, Animation[]>> {
  const one = (name: string): Animation[] => [{ name, duration, easing: EASE_IN_OUT_QUART, fillMode: "both" }];
  return { forwards: { old: one("astroFadeOut"), new: one("astroFadeIn") }, backwards: { old: one("astroFadeOut"), new: one("astroFadeIn") } };
}

function slidePreset(duration: string | null): Record<string, Record<string, Animation[]>> {
  const time = (value: string) => duration ?? value;
  return {
    forwards: {
      old: [{ name: "astroFadeOut", duration: time("90ms"), easing: EASE_IN_OUT_QUART, fillMode: "both" }, { name: "astroSlideToLeft", duration: time("220ms"), easing: EASE_IN_OUT_QUART, fillMode: "both" }],
      new: [{ name: "astroFadeIn", duration: time("210ms"), easing: EASE_IN_OUT_QUART, ...(duration ? {} : { delay: "30ms" }), fillMode: "both" }, { name: "astroSlideFromRight", duration: time("220ms"), easing: EASE_IN_OUT_QUART, fillMode: "both" }],
    },
    backwards: { old: [{ name: "astroFadeOut" }, { name: "astroSlideToRight" }], new: [{ name: "astroFadeIn" }, { name: "astroSlideFromLeft" }] },
  };
}

function matchesPreset(found: Record<string, Record<string, Animation[]>>, preset: Record<string, Record<string, Animation[]>>): boolean {
  const directions = new Set([...Object.keys(found), ...Object.keys(preset)]);
  for (const direction of directions) {
    const images = new Set([...Object.keys(found[direction] ?? {}), ...Object.keys(preset[direction] ?? {})]);
    for (const image of images) if (!sameAnimations(found[direction]?.[image], preset[direction]?.[image] ?? [])) return false;
  }
  return true;
}

function animationLiteral(found: Record<string, Record<string, Animation[]>>): string {
  const directions = Object.entries(found).map(([direction, images]) => {
    const inner = Object.entries(images).map(([image, anims]) => {
      const one = (a: Animation) => `{ ${Object.entries(a).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`;
      return `    ${image}: ${anims.length === 1 ? one(anims[0]!) : `[${anims.map(one).join(", ")}]`},`;
    });
    return `  ${direction}: {\n${inner.join("\n")}\n  },`;
  });
  return `{\n${directions.join("\n")}\n}`;
}

function transitionDirectives(css: string, animations: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const match of css.matchAll(/\[data-astro-transition-scope="([^"]+)"\]\s*\{\s*view-transition-name:\s*([^;}\s]+)\s*;?\s*\}/g)) {
    const scope = match[1]!;
    const name = match[2]!;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found: Record<string, Record<string, Animation[]>> = {};
    let none = false;
    for (const rule of css.matchAll(new RegExp(`(?:\\[data-astro-transition=(\\w+)\\])?::view-transition-(old|new|group)\\(${escaped}\\)\\s*\\{([^}]*)\\}`, "g"))) {
      const direction = rule[1] === "back" ? "backwards" : rule[1] ?? "forwards";
      const image = rule[2]!;
      if (/animation:\s*none/.test(rule[3]!)) {
        none = true;
        continue;
      }
      const anims = animationsOf(rule[3]!);
      if (anims.length) (found[direction] ??= {})[image] = anims;
    }
    const directives: string[] = [];
    const custom = name !== scope;
    if (custom) directives.push(`transition:name="${attr(name)}"`);
    if (none) directives.push('transition:animate="none"');
    else if (Object.keys(found).length) {
      const duration = found.forwards?.old?.[0]?.duration ?? null;
      if (duration && matchesPreset(found, fadePreset(duration))) {
        if (duration !== "180ms") directives.push(`transition:animate={fade({ duration: "${duration}" })}`);
        else if (!custom) directives.push('transition:animate="fade"');
      } else if (matchesPreset(found, slidePreset(null))) directives.push('transition:animate="slide"');
      else if (duration && matchesPreset(found, slidePreset(duration))) directives.push(`transition:animate={slide({ duration: "${duration}" })}`);
      else {
        const first = [found.forwards?.old?.[0]?.name, found.forwards?.new?.[0]?.name].filter((n): n is string => !!n).map((n) => n.replace(/(Out|In)(?=[A-Z]|$)/, ""));
        let constant = identifier(first.length === 2 && first[0] === first[1] ? first[0]! : "pageTransition", "pageTransition");
        const literal = animationLiteral(found);
        for (let n = 2; animations.has(constant) && animations.get(constant) !== literal; n++) constant = `${constant.replace(/\d+$/, "")}${n}`;
        animations.set(constant, literal);
        directives.push(`transition:animate={${constant}}`);
      }
    }
    out.set(scope, directives);
  }
  return out;
}

function directiveAttr(directives: string[]): string {
  return Buffer.from(directives.join(" ")).toString("base64");
}

function readIsland(el: HTMLElement, index: number, sources: AstroSources, base: URL, directives: string[]): Island {
  let opts: { name?: string; value?: string } = {};
  try {
    opts = JSON.parse(el.getAttribute("opts") ?? "{}") as { name?: string; value?: string };
  } catch {
    opts = {};
  }
  let raw: Record<string, unknown> = {};
  try {
    raw = decodeProps(JSON.parse(el.getAttribute("props") ?? "{}")) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const href = el.getAttribute("component-url");
  const url = href ? (URL.parse(href, base)?.href ?? null) : null;
  const name = (opts.name ?? "").replace(/[^A-Za-z0-9_$]/g, "") || `Island${index + 1}`;
  const renderer = el.getAttribute("renderer-url") ?? "";
  const framework = /svelte/i.test(renderer) ? "svelte" : /solid/i.test(renderer) ? "solid-js" : /preact/i.test(renderer) ? "preact" : /react/i.test(renderer) ? "react" : "vue";
  const mode = el.getAttribute("client") ?? "load";
  const client = mode === "only" ? `client:only="${framework}"` : mode === "media" && opts.value ? `client:media="${opts.value}"` : `client:${mode}`;
  const props = new Map(Object.entries(raw).filter(([key]) => !DROPPED_PROPS.test(key)));
  const template = el.querySelector("template[data-astro-template]");
  return { name, source: url ? sources.moduleFor(url) : null, client, framework, props, children: template ? template.innerHTML.trim() : "", directives };
}

function isAstroRuntime(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  const text = el.textContent;
  if (tag === "style" && /astro-island|astro-slot/.test(text)) return true;
  if (tag === "script" && !el.getAttribute("src") && /customElements|self\.Astro|window\.Astro/.test(text) && /astro/i.test(text)) return true;
  if (tag === "script" && /\/cdn-cgi\//.test(el.getAttribute("src") ?? "")) return true;
  return false;
}

function schemaName(value: unknown): string {
  const type = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)["@type"] : null;
  return typeof type === "string" ? identifier(`${type} schema`, "jsonLd") : "jsonLd";
}

function elementMarkup(el: HTMLElement, substitute: (value: string) => string | null): { html: string; template: string | null; uses: string[] } {
  const tag = el.tagName.toLowerCase();
  const literal: string[] = [];
  const templated: string[] = [];
  const uses: string[] = [];
  for (const [key, value] of Object.entries(el.attributes)) {
    const plain = value === "" && !/^(content|href|src|alt|title|value)$/.test(key) ? key : `${key}="${attr(value)}"`;
    literal.push(plain);
    const expression = value ? substitute(value) : null;
    if (expression) {
      templated.push(`${key}={${expression}}`);
      uses.push(expression);
    } else templated.push(plain);
  }
  const close = /^(meta|link|base)$/.test(tag) ? " />" : `>${el.innerHTML}</${tag}>`;
  const html = `<${tag}${literal.length ? ` ${literal.join(" ")}` : ""}${close}`;
  const template = uses.length ? `<${tag} ${templated.join(" ")}${close}` : null;
  return { html, template, uses };
}

function scriptItem(el: HTMLElement, page: Page, sources: AstroSources, state: { transitions: boolean }): HeadItem | null {
  const src = el.getAttribute("src");
  const url = src ? (URL.parse(src, page.baseUrl)?.href ?? null) : null;
  const type = el.getAttribute("type");
  if (type === "application/ld+json") {
    try {
      const value = JSON.parse(el.textContent);
      return { kind: "jsonld", key: `jsonld:${JSON.stringify(value)}`, value };
    } catch {
      return { kind: "markup", key: el.outerHTML, html: el.outerHTML, template: null, uses: [] };
    }
  }
  if (url && /\/ClientRouter\.astro_astro_type_script/.test(url)) {
    state.transitions = true;
    return null;
  }
  const module = url ? sources.moduleFor(url) : null;
  if (module) return { kind: "module", key: `module:${module}`, path: module, component: url ? (COMPONENT_SCRIPT.exec(url)?.[1] ?? null) : null };
  if (url) {
    const html = `<script is:inline src="${attr(sources.publicFile(url) ?? src!)}"></script>`;
    return { kind: "markup", key: html, html, template: null, uses: [] };
  }
  const code = el.textContent;
  if (!code.trim()) return null;
  if (type && type !== "module" && !/javascript/i.test(type)) {
    const html = `<script type="${attr(type)}" is:inline>${code}</script>`;
    return { kind: "markup", key: html, html, template: null, uses: [] };
  }
  return { kind: "inline", key: `inline:${type === "module"}:${code}`, code, module: type === "module", type: type ?? null };
}

function build(page: Page, sources: AstroSources, animations: Map<string, string>): Built {
  const root = parse(decodeCloudflareEmails(page.html), PARSE);
  const html = root.querySelector("html");
  const head = root.querySelector("head");
  const body = root.querySelector("body") ?? root;
  const state = { transitions: false };
  const styles = [...root.querySelectorAll("style")].filter((el) => el.textContent.includes("data-astro-transition-scope"));
  const directives = transitionDirectives(styles.map((el) => el.textContent).join("\n"), animations);
  for (const el of styles) el.remove();
  const directivesOf = (el: HTMLElement) => {
    const found = [...(directives.get(el.getAttribute("data-astro-transition-scope") ?? "") ?? [])];
    const persist = el.getAttribute("data-astro-transition-persist");
    if (persist !== undefined) found.push(!persist || /^astro-[\w-]+-\d+$/.test(persist) ? "transition:persist" : `transition:persist="${attr(persist)}"`);
    if (el.hasAttribute("data-astro-transition-persist-props")) found.push(`transition:persist-props="${attr(el.getAttribute("data-astro-transition-persist-props") ?? "")}"`);
    return found;
  };
  const islands: Island[] = [];
  for (const el of body.querySelectorAll("astro-island")) {
    if ((el.parentNode as HTMLElement | null)?.closest?.("astro-island")) continue;
    islands.push(readIsland(el, islands.length, sources, page.baseUrl, directivesOf(el)));
    el.replaceWith(parse(`<${PLACEHOLDER} data-index="${islands.length - 1}"></${PLACEHOLDER}>`));
  }
  for (const el of body.querySelectorAll("[data-astro-transition-scope], [data-astro-transition-persist]")) {
    const found = directivesOf(el);
    for (const name of ["data-astro-transition-scope", "data-astro-transition-persist", "data-astro-transition-persist-props"]) el.removeAttribute(name);
    if (found.length) el.setAttribute("data-unbundle-directive", directiveAttr(found));
  }
  const canonicalHref = head?.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
  const canonical = canonicalHref ? URL.parse(canonicalHref, page.baseUrl) : null;
  const samePath = (a: string, b: string) => decodeURIComponent(a).replace(/\/+$/, "") === decodeURIComponent(b).replace(/\/+$/, "");
  const site = canonical && samePath(canonical.pathname, page.url.pathname) ? canonical.origin : null;
  let title: string | null = null;
  let description: string | null = null;
  for (const el of head?.querySelectorAll("title") ?? []) title = el.textContent;
  for (const el of head?.querySelectorAll('meta[name="description"]') ?? []) description = el.getAttribute("content") || null;
  const substitute = (value: string) => {
    if (title && value === title) return "title";
    if (description && value === description) return "description";
    if (site && canonical && value === canonical.href) return "canonical";
    return null;
  };
  const scripts: HeadItem[] = [];
  const extraHead: HeadItem[] = [];
  for (const el of body.querySelectorAll("script")) {
    if (isAstroRuntime(el)) {
      el.remove();
      continue;
    }
    const item = scriptItem(el, page, sources, state);
    if (!item) el.remove();
    else if (item.kind === "jsonld") {
      extraHead.push(item);
      el.remove();
    } else {
      scripts.push(item);
      el.replaceWith(parse(`<${SCRIPT_SLOT} data-index="${scripts.length - 1}"></${SCRIPT_SLOT}>`));
    }
  }
  for (const el of body.querySelectorAll("style")) if (isAstroRuntime(el)) el.remove();
  for (const el of body.querySelectorAll("[data-astro-cid]")) el.removeAttribute("data-astro-cid");
  for (const el of body.querySelectorAll("link[rel=stylesheet]")) if (/\/_astro\//.test(el.getAttribute("href") ?? "")) el.remove();
  const items: HeadItem[] = [];
  for (const child of head?.childNodes ?? []) {
    if (child.nodeType !== 1) continue;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const rel = el.getAttribute("rel") ?? "";
    const name = el.getAttribute("name") ?? "";
    if (/^astro-view-transitions/.test(name)) {
      state.transitions = true;
      continue;
    }
    if (tag === "link" && /^(modulepreload|preload|prefetch)$/.test(rel)) continue;
    if (tag === "link" && rel === "stylesheet" && /\/_astro\//.test(el.getAttribute("href") ?? "")) continue;
    if (tag === "meta" && el.getAttribute("charset")) continue;
    if (tag === "title" || (tag === "meta" && name === "description")) continue;
    if (tag === "meta" && name === "generator" && /^Astro\b/.test(el.getAttribute("content") ?? "")) {
      const html = '<meta name="generator" content={Astro.generator} />';
      items.push({ kind: "markup", key: html, html, template: null, uses: [] });
      continue;
    }
    if (isAstroRuntime(el)) continue;
    if (tag === "script") {
      const item = scriptItem(el, page, sources, state);
      if (item) items.push(item);
      continue;
    }
    if (tag === "meta" || tag === "link" || tag === "base") {
      const markup = elementMarkup(el, substitute);
      items.push({ kind: "markup", key: markup.template ?? markup.html, ...markup });
      continue;
    }
    items.push({ kind: "markup", key: el.outerHTML, html: el.outerHTML, template: null, uses: [] });
  }
  let container = body as HTMLElement;
  const wrappers: string[] = [];
  for (;;) {
    const kids = significant(container.childNodes);
    if (kids.length !== 1 || kids[0]!.nodeType !== 1 || [PLACEHOLDER, SCRIPT_SLOT].includes((kids[0] as HTMLElement).tagName.toLowerCase())) break;
    const el = kids[0] as HTMLElement;
    wrappers.push(`<${el.rawTagName}${el.rawAttrs ? ` ${el.rawAttrs}` : ""}>`);
    container = el;
  }
  return {
    file: routeFile(sources.root, page.url),
    lang: html?.getAttribute("lang") ?? null,
    title,
    description,
    site,
    head: [...items, ...extraHead],
    items: significant(container.childNodes).map(outer).map(escapeBraces),
    wrappers,
    bodyAttrs: body === root ? "" : (body as HTMLElement).rawAttrs,
    islands,
    scripts,
    transitions: state.transitions,
    animations,
  };
}

function significant(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.text.trim()));
}

function escapeBraces(html: string): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("<", i);
    const text = html.slice(i, open < 0 ? html.length : open);
    out += text.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
    if (open < 0) break;
    const raw = /^<(script|style|textarea|pre)\b/i.exec(html.slice(open, open + 12))?.[1];
    let close = open;
    for (let quote = ""; close < html.length; close++) {
      const char = html[close]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    out += html.slice(open, close + 1);
    i = close + 1;
    if (raw && raw.toLowerCase() !== "pre") {
      const end = html.toLowerCase().indexOf(`</${raw.toLowerCase()}`, i);
      const stop = end < 0 ? html.length : end;
      out += html.slice(i, stop);
      i = stop;
    }
  }
  return out;
}

function outer(node: Node): string {
  return node.nodeType === 1 ? (node as HTMLElement).outerHTML : node.text.trim();
}

function singularParam(name: string): string {
  const base = name.replace(/ies$/, "y").replace(/(?<=.)s$/, "");
  const word = /^[A-Za-z_$][\w$]*$/.test(base) && base !== name ? base : "item";
  return word;
}

const REPEAT_SKIP = /^(script|style|pre|textarea|svg|path|head|html|body|title|meta|link|option|br|hr|img|input)$/i;
const LEAF_ELEMENT = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>{}"'])*)>([^<>{}]*)<\/\1\s*>/g;

function repeatName(before: string, taken: Set<string>): string {
  const key = [...before.matchAll(/\{t\.([A-Za-z_$][\w$]*)\}/g)].pop();
  const heading = [...before.matchAll(/<h[1-6][^>]*>([^<>{}]+)<\/h[1-6]>/g)].pop();
  const keyAt = key ? key.index! : -1;
  const headingAt = heading ? heading.index! : -1;
  const hint = keyAt >= headingAt ? (key?.[1] ?? null) : camel(heading![1]!.trim());
  const seed = hint && /^[A-Za-z_$][\w$]*$/.test(hint) ? hint : "items";
  let base = seed;
  for (let i = 2; taken.has(base); i++) base = `${seed}${i}`;
  taken.add(base);
  return base;
}

function collapseRepeats(output: Output, taken: Set<string>): void {
  const markup = output.markup;
  const leaves: { start: number; end: number; open: string; tag: string; text: string }[] = [];
  for (const match of markup.matchAll(LEAF_ELEMENT)) {
    const tag = match[1]!;
    if (REPEAT_SKIP.test(tag)) continue;
    leaves.push({ start: match.index!, end: match.index! + match[0].length, open: `<${tag}${match[2]}>`, tag, text: match[3]! });
  }
  const runs: { start: number; end: number; open: string; tag: string; name: string; param: string; values: string[] }[] = [];
  for (let i = 0; i < leaves.length; ) {
    let j = i + 1;
    while (j < leaves.length && leaves[j]!.open === leaves[i]!.open && !markup.slice(leaves[j - 1]!.end, leaves[j]!.start).trim()) j++;
    const group = leaves.slice(i, j);
    const values = group.map((leaf) => leaf.text.trim());
    if (group.length >= 3 && new Set(values).size >= 2) {
      const name = repeatName(markup.slice(0, group[0]!.start), taken);
      runs.push({ start: group[0]!.start, end: group[group.length - 1]!.end, open: leaves[i]!.open, tag: leaves[i]!.tag, name, param: singularParam(name), values });
    }
    i = j;
  }
  if (!runs.length) return;
  let result = markup;
  for (const run of [...runs].reverse()) {
    const expression = `{${run.name}.map((${run.param}) => (\n${run.open}{${run.param}}</${run.tag}>\n))}`;
    result = result.slice(0, run.start) + expression + result.slice(run.end);
  }
  output.markup = result;
  const spread = (code: string) => spreadArrays(code, runs);
  for (const [name, value] of output.emit.constants) output.emit.constants.set(name, spread(value));
  output.code = output.code.map(spread);
  for (const run of runs) output.code.push(`const ${run.name} = ${JSON.stringify(run.values)};`);
}

function spreadArrays(code: string, runs: { name: string; values: string[] }[]): string {
  const STRING_ARRAY = /\[\s*"(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*\s*,?\s*\]/g;
  return code.replace(STRING_ARRAY, (literal) => {
    const elements = [...literal.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => m[0]!);
    let values: string[];
    try {
      values = elements.map((raw) => JSON.parse(raw) as string);
    } catch {
      return literal;
    }
    const tokens: string[] = [...elements];
    let changed = false;
    for (const run of runs) {
      if (run.values.length < 3) continue;
      for (let i = 0; i + run.values.length <= values.length; i++) {
        if (tokens[i]?.startsWith("...")) continue;
        if (run.values.every((value, k) => values[i + k] === value && !tokens[i + k]!.startsWith("..."))) {
          tokens.splice(i, run.values.length, `...${run.name}`);
          values.splice(i, run.values.length, `\u0000${run.name}`);
          changed = true;
          break;
        }
      }
    }
    return changed ? `[${tokens.join(", ")}]` : literal;
  });
}

function islandIndex(item: string): number | null {
  const match = new RegExp(`^<${PLACEHOLDER} data-index="(\\d+)"\\s*>\\s*</${PLACEHOLDER}>$`).exec(item.trim());
  return match ? Number(match[1]) : null;
}

function keyOf(page: Built, item: string): string {
  const index = islandIndex(item);
  if (index !== null) return `island:${page.islands[index]!.name}`;
  return item.replace(new RegExp(`<${SCRIPT_SLOT} data-index="(\\d+)"\\s*>\\s*</${SCRIPT_SLOT}>`, "g"), (_, i: string) => `<script:${page.scripts[Number(i)]!.key}>`);
}

function shellOf(pages: Built[]): { prefix: number; suffix: number } {
  const lists = pages.map((p) => p.items.map((item) => keyOf(p, item)));
  const wrappers = pages.map((p) => p.wrappers.join(""));
  if (pages.length < 2 || new Set(wrappers).size > 1) return { prefix: 0, suffix: 0 };
  const shortest = Math.min(...lists.map((l) => l.length));
  let prefix = 0;
  while (prefix < shortest && lists.every((l) => l[prefix] === lists[0]![prefix])) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && lists.every((l) => l[l.length - 1 - suffix] === lists[0]![lists[0]!.length - 1 - suffix])) suffix++;
  return { prefix, suffix };
}

function groups(pages: Built[], expand: (page: Built) => Built[] = (page) => [page]): Group[] {
  const signature = (p: Built) => {
    const keys = p.items.map((item) => keyOf(p, item));
    return [p.wrappers.join(""), keys[0], keys[keys.length - 1]].join("\u0000");
  };
  const buckets = new Map<string, Built[]>();
  for (const page of pages) buckets.set(signature(page), [...(buckets.get(signature(page)) ?? []), page]);
  const out: Group[] = [];
  for (const members of [...buckets.values()].sort((a, b) => b.length - a.length)) {
    const { prefix, suffix } = shellOf(members);
    if (members.length < 2 || prefix + suffix === 0) {
      for (const page of members) out.push({ pages: [page], prefix: 0, suffix: 0, varying: new Map() });
      continue;
    }
    const varying = new Map<number, Map<string, unknown>>();
    const positions = [...Array(prefix).keys(), ...[...Array(suffix).keys()].map((i) => -1 - i)];
    for (const position of positions) {
      const islandsAt = members.flatMap(expand).map((p) => {
        const index = islandIndex(p.items[position >= 0 ? position : p.items.length + position]!);
        return index === null ? null : p.islands[index]!;
      });
      if (islandsAt.some((i) => !i)) continue;
      const keys = new Set(islandsAt.flatMap((i) => [...i!.props.keys()]));
      const differing = new Map<string, unknown>();
      for (const key of keys) {
        const values = islandsAt.map((i) => JSON.stringify(i!.props.get(key)));
        if (new Set(values).size > 1) {
          const counts = new Map<string, number>();
          for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
          const common = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
          differing.set(key, common === undefined ? undefined : JSON.parse(common));
        }
      }
      if (differing.size) varying.set(position, differing);
    }
    out.push({ pages: members, prefix, suffix, varying });
  }
  return out;
}

export function quoteAttributes(markup: string): string {
  let out = "";
  let i = 0;
  while (i < markup.length) {
    const open = markup.indexOf("<", i);
    if (open < 0) {
      out += markup.slice(i);
      break;
    }
    out += markup.slice(i, open);
    const name = /^<([A-Za-z][\w:-]*)/.exec(markup.slice(open, open + 64))?.[1];
    if (!name) {
      out += "<";
      i = open + 1;
      continue;
    }
    let j = open + 1 + name.length;
    let tag = `<${name}`;
    while (j < markup.length && markup[j] !== ">" && !(markup[j] === "/" && markup[j + 1] === ">")) {
      const ws = /^\s+/.exec(markup.slice(j))?.[0];
      if (ws) {
        tag += ws;
        j += ws.length;
        continue;
      }
      const attrName = /^[^\s=>/"']+/.exec(markup.slice(j))?.[0];
      if (!attrName) {
        tag += markup[j];
        j++;
        continue;
      }
      tag += attrName;
      j += attrName.length;
      const eq = /^\s*=\s*/.exec(markup.slice(j))?.[0];
      if (!eq) continue;
      j += eq.length;
      const quote = markup[j];
      if (quote === '"' || quote === "'") {
        const end = markup.indexOf(quote, j + 1);
        const value = markup.slice(j, end < 0 ? markup.length : end + 1);
        tag += `=${value}`;
        j += value.length;
      } else {
        const value = /^[^\s>]*/.exec(markup.slice(j))?.[0] ?? "";
        const clean = value.endsWith("/") && markup[j + value.length] === ">" && !/\/\/$/.test(value) && value.length > 1 && !value.startsWith("/") ? value.slice(0, -1) : value;
        tag += `="${clean.replace(/"/g, "&quot;")}"`;
        j += clean.length;
      }
    }
    out += tag;
    i = j;
    if (/^(script|style)$/i.test(name)) {
      const close = markup.toLowerCase().indexOf(`</${name.toLowerCase()}`, j);
      const end = close < 0 ? markup.length : close;
      out += markup.slice(j, end);
      i = end;
    }
  }
  return out;
}

async function formatMarkup(markup: string): Promise<string> {
  if (!markup.trim()) return "";
  try {
    return (await formatContent("fragment.html", quoteAttributes(markup))).trimEnd();
  } catch {
    return markup.trim();
  }
}

async function refineInline(code: string, module: boolean): Promise<string> {
  let out = (await refineCode({ id: 0, code, webcrack: true, rename: true })).code;
  if (!module) return out;
  try {
    out = nameModuleLocals(out);
  } catch {
    return out;
  }
  return out;
}

async function formatScript(code: string): Promise<string> {
  try {
    return (await formatContent("script.ts", code)).trimEnd();
  } catch {
    return code.trim();
  }
}

function newEmit(from: string): Emit {
  return { from, imports: new Set(), used: new Map(), data: new Map(), constants: new Map(), scripts: [] };
}

function literal(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

class DataFiles {
  private byJson = new Map<string, { path: string; name: string }>();
  private taken = new Set<string>();
  constructor(
    private tree: OutputTree,
    private root: string,
  ) {}

  place(value: unknown, key: string, island: Island, pageLang: string | null, uses: number): { path: string; name: string } | null {
    const json = JSON.stringify(value);
    const known = this.byJson.get(json);
    if (known) return known;
    const lang = [...island.props].find(([k, v]) => LANG_PROP.test(k) && typeof v === "string")?.[1] as string | undefined;
    let dir: string;
    let base: string;
    if (I18N_PROP.test(key) && (lang ?? pageLang)) {
      dir = "i18n";
      base = (lang ?? pageLang)!.toLowerCase();
    } else if (uses >= 2) {
      dir = "data";
      base = key.replace(/[^A-Za-z0-9_-]+/g, "-");
    } else return null;
    let path = posix.join(this.root, dir, `${base}.json`);
    for (let n = 2; this.taken.has(path); n++) path = posix.join(this.root, dir, `${base}-${n}.json`);
    this.taken.add(path);
    const name = identifier(posix.basename(path, ".json"), dir === "i18n" ? "messages" : camel(key) || "data");
    const placed = { path, name };
    this.byJson.set(json, placed);
    this.tree.add({ path, content: `${JSON.stringify(value, null, 2)}\n`, kind: "data", renamable: false });
    return placed;
  }
}

interface Context {
  tree: OutputTree;
  data: DataFiles;
  uses: Map<string, number>;
  inlinable: (path: string) => boolean;
  consumed: Set<string>;
}

function valueExpression(value: unknown, key: string, found: Island, lang: string | null, emit: Emit, ctx: Context): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "undefined";
  if (typeof value !== "object" || value === null || json.length <= 120) return json;
  const placed = ctx.data.place(value, key, found, lang, ctx.uses.get(json) ?? 0);
  if (placed) {
    emit.data.set(placed.name, placed.path);
    return placed.name;
  }
  const base = identifier(`${found.name} ${key}`, "props");
  let name = base;
  for (let n = 2; emit.constants.has(name) && emit.constants.get(name) !== literal(value); n++) name = `${base}${n}`;
  emit.constants.set(name, literal(value));
  return name;
}

function islandTag(found: Island, emit: Emit, ctx: Context, lang: string | null, indent: string): string {
  if (found.source) emit.used.set(found.name, found.source);
  const attrs = [found.client, ...found.directives];
  for (const [key, value] of found.props) {
    const override = emit.override?.(found, key);
    if (override) {
      attrs.push(`${key}={${override}}`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !/["{}]/.test(value)) attrs.push(`${key}="${value.replace(/&/g, "&amp;")}"`);
    else attrs.push(`${key}={${valueExpression(value, key, found, lang, emit, ctx)}}`);
  }
  const flat = `<${found.name} ${attrs.join(" ")}`;
  const long = flat.length + indent.length > MARKUP_WIDTH;
  const open = long ? `<${found.name}\n${attrs.map((a) => `${indent}  ${a}`).join("\n")}\n${indent}` : `${flat} `;
  return found.children ? `${open.trimEnd()}>${found.children}</${found.name}>` : `${open}/>`;
}

function fill(markup: string, page: Built, emit: Emit, ctx: Context, scripts: Map<number, string[]>): string {
  return markup
    .replace(new RegExp(`^([ \\t]*)<${PLACEHOLDER} data-index="(\\d+)"\\s*>\\s*</${PLACEHOLDER}>`, "gm"), (_, pad: string, i: string) => `${pad}${islandTag(page.islands[Number(i)]!, emit, ctx, page.lang, pad)}`)
    .replace(ISLAND_RE, (_, i: string) => islandTag(page.islands[Number(i)]!, emit, ctx, page.lang, ""))
    .replace(SCRIPT_RE, (_, pad: string, i: string) => (scripts.get(Number(i)) ?? []).map((line) => `${pad}${line}`).join("\n"))
    .replace(DIRECTIVE_RE, (_, encoded: string) => {
      const text = Buffer.from(encoded, "base64").toString();
      for (const match of text.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)) if (page.animations.has(match[1]!)) emit.constants.set(match[1]!, page.animations.get(match[1]!)!);
      if (/\{fade\(/.test(text)) emit.imports.add('import { fade } from "astro:transitions";');
      if (/\{slide\(/.test(text)) emit.imports.add('import { slide } from "astro:transitions";');
      return ` ${text}`;
    });
}

function relativeSpecifiers(code: string, from: string, to: string): string {
  return code.replace(/((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'])(\.\.?\/[^"']+)(["'])/g, (_, lead: string, spec: string, quote: string) => `${lead}${relativeImport(to, posix.normalize(posix.join(posix.dirname(from), spec)))}${quote}`);
}

async function renderItem(item: HeadItem, emit: Emit, ctx: Context, templated: boolean): Promise<string[]> {
  if (item.kind === "markup") {
    if (templated && item.template) {
      if (item.uses.includes("canonical")) emit.constants.set("canonical", "new URL(Astro.url.pathname, Astro.site)");
      return [item.template];
    }
    const style = /^<style([^>]*)>([\s\S]*)<\/style>$/i.exec(item.html.trim());
    if (style && style[2]!.trim()) {
      try {
        const css = (await formatContent("inline.css", style[2]!)).trimEnd();
        return [`<style${style[1]}>`, ...css.split("\n").map((line) => (line ? `  ${line}` : line)), "</style>"];
      } catch {
        return [item.html];
      }
    }
    return [item.html];
  }
  if (item.kind === "jsonld") {
    const base = schemaName(item.value);
    let name = base;
    for (let n = 2; emit.constants.has(name) && emit.constants.get(name) !== literal(item.value); n++) name = `${base}${n}`;
    emit.constants.set(name, literal(item.value));
    return [`<script type="application/ld+json" set:html={JSON.stringify(${name})} />`];
  }
  if (item.kind === "inline") {
    const code = await formatScript(await refineInline(item.code, item.module));
    return [item.module ? "<script>" : "<script is:inline>", ...code.split("\n").map((line) => (line ? `  ${line}` : line)), "</script>"];
  }
  const file = ctx.tree.all().find((f) => f.path === item.path);
  if (item.component && file && ctx.inlinable(item.path)) {
    if (!ctx.consumed.has(item.path)) {
      const code = relativeSpecifiers(file.content, item.path, emit.from)
        .replace(/^[ \t]*export\s*\{[^}]*\};?[ \t]*$/gm, "")
        .replace(/^export\s+(?=(const|let|var|function|async|class)\b)/gm, "");
      emit.scripts.push(await formatScript(await refineInline(code, true)));
      ctx.consumed.add(item.path);
    }
    return [];
  }
  return [`<script src="${relativeImport(emit.from, item.path)}"></script>`];
}

async function renderScripts(page: Built, emit: Emit, ctx: Context): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const [i, item] of page.scripts.entries()) out.set(i, await renderItem(item, emit, ctx, false));
  return out;
}

function frontmatter(output: Output): string {
  const { emit } = output;
  const lines = [
    ...emit.imports,
    ...[...emit.used].map(([name, source]) => `import ${name} from "${relativeImport(emit.from, source)}";`),
    ...[...emit.data].map(([name, source]) => `import ${name} from "${relativeImport(emit.from, source)}";`),
  ];
  const constants = [...emit.constants].map(([name, value]) => `const ${name} = ${value};`);
  const body = [...output.code, ...constants];
  if (!lines.length && !body.length) return "";
  return `---\n${[...lines, ...(lines.length && body.length ? [""] : []), ...body].join("\n")}\n---\n\n`;
}

function indent(text: string, pad: string): string[] {
  return text ? text.split("\n").map((line) => (line ? `${pad}${line}` : line)) : [];
}

function closing(wrapper: string): string {
  return `</${/^<([\w-]+)/.exec(wrapper)![1]}>`;
}

function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return i;
  }
  return css.length - 1;
}

function scopedStyles(outputs: Map<string, Output>, tree: OutputTree, stylesheets: string[]): void {
  const sheets = stylesheets.map((path) => tree.all().find((f) => f.path === path)).filter((f) => !!f);
  const css = sheets.map((f) => f.content).join("\n");
  const cids = new Set([...css.matchAll(/\[(data-astro-cid-[a-z0-9]+)\]/g)].map((m) => m[1]!));
  const moved = new Set<string>();
  const styles = new Map<string, string[]>();
  for (const cid of cids) {
    const users = [...outputs].filter(([, o]) => o.markup.includes(cid));
    const rules = users.length ? scopedRules(css, cid) : null;
    if (!rules) continue;
    moved.add(cid);
    for (const block of rules.split(/\n\n(?=\S)/)) {
      const selector = block.slice(0, block.indexOf("{"));
      const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!.replace(/\\/g, ""));
      const matching = users.filter(([, o]) => classes.every((c) => new RegExp(`class="[^"]*(?<![\\w-])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(o.markup)));
      for (const [path] of matching.length ? matching : users) styles.set(path, [...(styles.get(path) ?? []), block]);
    }
  }
  if (moved.size) {
    for (const sheet of sheets) sheet.content = removeScopedRules(sheet.content, moved);
    for (const [path, blocks] of styles) {
      const animated = new Set(blocks.flatMap((b) => [...b.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)].flatMap((m) => m[1]!.split(/[\s,]+/))));
      for (const name of animated) {
        if (!/^[A-Za-z_-][\w-]*$/.test(name)) continue;
        const owners = [...styles.values()].filter((b) => b.some((x) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(x))).length;
        if (owners > 1) continue;
        const sheet = sheets.find((f) => new RegExp(`@keyframes\\s+${name}\\s*\\{`).test(f.content));
        if (!sheet) continue;
        const rest = sheets.map((f) => f.content).join("\n");
        if (new RegExp(`animation(?:-name)?\\s*:[^;}]*(?<![\\w-])${name}(?![\\w-])`).test(rest)) continue;
        const start = sheet.content.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
        const end = blockEnd(sheet.content, sheet.content.indexOf("{", start));
        blocks.unshift(sheet.content.slice(start, end + 1).trim());
        sheet.content = sheet.content.slice(0, start) + sheet.content.slice(end + 1);
      }
      outputs.get(path)!.markup += `\n<style>\n${blocks.join("\n\n")}\n</style>\n`;
    }
  }
  for (const output of outputs.values()) output.markup = output.markup.replace(/\s+data-astro-cid-[a-z0-9]+(="")?(?=[\s>/])/g, "");
}

function importers(tree: OutputTree): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const paths = new Set(tree.all().map((f) => f.path));
  const resolve = (from: string, spec: string) => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec.replace(/[?#].*$/, "")));
    for (const suffix of ["", ".js", ".ts", ".mjs", ".jsx", ".tsx", ".vue", "/index.js", "/index.ts"]) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
  for (const file of tree.all()) {
    if (!/\.(m?[jt]sx?|vue|astro|svelte)$/.test(file.path)) continue;
    for (const match of file.content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bsrc=)["'](\.\.?\/[^"']+)["']/g)) {
      const target = resolve(file.path, match[1]!);
      if (target && target !== file.path) out.set(target, new Set([...(out.get(target) ?? []), file.path]));
    }
  }
  return out;
}

export function isImported(tree: OutputTree, path: string): boolean {
  return !!importers(tree).get(path)?.size;
}

export function pruneOrphans(tree: OutputTree, removed: Iterable<string>, keep: (path: string) => boolean): string[] {
  const dropped: string[] = [];
  let queue = [...removed];
  while (queue.length) {
    const before = importers(tree);
    const targets = new Set<string>();
    for (const path of queue) {
      if (!tree.all().some((f) => f.path === path)) continue;
      for (const [target, from] of before) if (from.has(path)) targets.add(target);
      tree.remove(path);
      dropped.push(path);
    }
    const after = importers(tree);
    queue = [...targets].filter((target) => !after.get(target)?.size && !keep(target));
  }
  return dropped;
}

function astroConfig(site: string | null, frameworks: Set<string>, tailwind: boolean): string {
  const integrations = [...frameworks].sort().map((framework) => (framework === "solid-js" ? ["solid", "@astrojs/solid-js"] : [framework, `@astrojs/${framework}`]) as [string, string]);
  const lines = ['import { defineConfig } from "astro/config";', ...integrations.map(([name, pkg]) => `import ${name} from "${pkg}";`), ...(tailwind ? ['import tailwindcss from "@tailwindcss/vite";'] : []), "", "export default defineConfig({"];
  if (site) lines.push(`  site: ${JSON.stringify(site)},`);
  if (integrations.length) lines.push(`  integrations: [${integrations.map(([name]) => `${name}()`).join(", ")}],`);
  if (tailwind) lines.push("  vite: {", "    plugins: [tailwindcss()],", "  },");
  lines.push("});", "");
  return lines.join("\n");
}

interface Localization {
  pages: Built[];
  variants: Map<Built, Map<string, Built>>;
  params: Map<Built, string[]>;
}

type Part = { mode: "markup" | "code" | "raw"; text: string };

function partsOf(page: Built): Part[] {
  const head = page.head.map((item): Part => (item.kind === "markup" ? { mode: "markup", text: quoteAttributes(item.html) } : item.kind === "jsonld" ? { mode: "code", text: JSON.stringify(item.value) } : { mode: "raw", text: `\u0001${item.key}` }));
  return [{ mode: "raw", text: page.title ?? "" }, { mode: "raw", text: page.description ?? "" }, ...page.wrappers.map((text): Part => ({ mode: "markup", text: quoteAttributes(text) })), ...page.items.map((text): Part => ({ mode: "markup", text: quoteAttributes(text) })), ...head];
}

function tokenize(part: Part): { skeleton: string; list: Token[] } {
  if (part.mode === "raw") return part.text.startsWith("\u0001") ? { skeleton: part.text, list: [] } : { skeleton: "\u0000", list: [{ kind: "text", start: 0, end: part.text.length, value: part.text }] };
  return tokens(part.text, part.mode === "code");
}

function localizeBuilt(built: Built[], root: string, defaultLang: string, dictionary: Dictionary): Localization {
  const langs = new Set(built.map((p) => p.lang).filter((l): l is string => !!l));
  const empty: Localization = { pages: built, variants: new Map(), params: new Map() };
  if (langs.size < 2) return empty;
  const pagesDir = posix.join(root, "pages");
  const routes = new Map<string, Map<string, Built>>();
  const duplicates = new Map<string, Built[]>();
  for (const page of built) {
    if (!page.lang || !page.file.startsWith(`${pagesDir}/`)) continue;
    const rest = page.file.slice(pagesDir.length + 1);
    const head = rest.split("/")[0]!;
    const prefixed = langs.has(head) && rest.includes("/") ? head : null;
    const route = prefixed ? rest.slice(head.length + 1) : rest;
    if (prefixed && prefixed !== page.lang) continue;
    if (!prefixed && page.lang !== defaultLang) continue;
    if (prefixed === defaultLang) {
      duplicates.set(route, [...(duplicates.get(route) ?? []), page]);
      continue;
    }
    const byLang = routes.get(route) ?? new Map<string, Built>();
    byLang.set(prefixed ?? "", page);
    routes.set(route, byLang);
  }
  const replaced = new Map<Built, Built>();
  const dropped = new Set<Built>();
  const variants = new Map<Built, Map<string, Built>>();
  const params = new Map<Built, string[]>();
  for (const [route, byLang] of routes) {
    const base = byLang.get("");
    if (!base || byLang.size < 2) continue;
    const baseParts = partsOf(base).map(tokenize);
    const baseScripts = base.scripts.map((item) => item.key).join("\u0000");
    const baseIslands = base.islands.map((island) => island.name).join("\u0000");
    const matching = new Map<string, Array<{ skeleton: string; list: Token[] }>>();
    const alternates = new Map<number, Map<string, string>>();
    const itemStart = 2 + base.wrappers.length;
    const itemEnd = itemStart + base.items.length;
    for (const [prefix, page] of byLang) {
      if (!prefix) continue;
      const parts = partsOf(page).map(tokenize);
      if (parts.length !== baseParts.length || page.scripts.map((item) => item.key).join("\u0000") !== baseScripts || page.islands.map((island) => island.name).join("\u0000") !== baseIslands) continue;
      const differing = parts.flatMap((part, i) => (part.skeleton !== baseParts[i]!.skeleton ? [i] : []));
      if (differing.some((i) => i < itemStart || i >= itemEnd) || differing.length * 2 > base.items.length + 1) continue;
      if (differing.some((i) => page.items[i - itemStart]!.includes(`<${PLACEHOLDER}`) || page.items[i - itemStart]!.includes(`<${SCRIPT_SLOT}`))) continue;
      for (const i of differing) {
        const table = alternates.get(i) ?? new Map<string, string>();
        table.set(prefix, quoteAttributes(page.items[i - itemStart]!));
        alternates.set(i, table);
      }
      matching.set(prefix, parts);
    }
    if (!matching.size) continue;
    const source = partsOf(base);
    const expression = (partIndex: number, tokenIndex: number): string | null => {
      const token = baseParts[partIndex]!.list[tokenIndex]!;
      const values = new Map<string, string>([[defaultLang, token.value]]);
      for (const [prefix, parts] of matching) if (!alternates.get(partIndex)?.has(prefix)) values.set(prefix, parts[partIndex]!.list[tokenIndex]!.value);
      if (new Set(values.values()).size === 1) return null;
      if ([...values].every(([lang, value]) => value === lang)) return "lang";
      const langPath = new RegExp(`^((?:https?://[^/]+)?/)${defaultLang}(?=/|$)`);
      if (langPath.test(token.value) && [...values].every(([lang, value]) => value === token.value.replace(langPath, `$1${lang}`))) return `\`${token.value.replace(langPath, "$1${lang}").replace(/`/g, "\\`")}\``;
      if ([...values].every(([lang, value]) => lang === defaultLang || value === withPrefix(token.value, lang) || value === withPrefix(token.value, lang)?.replace(/\/$/, ""))) {
        const url = /^(https?:\/\/[^/]+)?(\/.*)?$/.exec(token.value)!;
        const path = url[2] ?? "/";
        return `\`${url[1] ?? ""}\${prefix}${path.replace(/[`$\\]/g, "\\$&")}\``;
      }
      const part = source[partIndex]!;
      const hint = part.mode === "raw" ? (partIndex === 0 ? "title" : "description") : hintBefore(part.text, token.start, token.kind);
      return `t.${dictionary.key(values, hint, part.mode !== "code")}`;
    };
    const rewritten = source.map((part, partIndex) => {
      const list = baseParts[partIndex]!.list;
      let out = "";
      let last = 0;
      list.forEach((token, tokenIndex) => {
        const expr = expression(partIndex, tokenIndex);
        if (!expr) return;
        out += `${part.text.slice(last, token.start)}{${expr}}`;
        last = token.end;
      });
      const text = out + part.text.slice(last);
      const other = alternates.get(partIndex);
      if (!other) return text;
      const branches = [...other].map(([lang, html]) => `lang === ${JSON.stringify(lang)} ? (<Fragment>${html}</Fragment>) : `).join("");
      return `{${branches}(<Fragment>${text}</Fragment>)}`;
    });
    let cursor = 2;
    const wrappers = rewritten.slice(cursor, (cursor += base.wrappers.length));
    const items = rewritten.slice(cursor, (cursor += base.items.length));
    const cursorHead = cursor;
    const headTexts = rewritten.slice(cursor);
    const head = base.head.map((item, i): HeadItem => {
      if (item.kind === "markup") return headTexts[i] === partsOf(base)[cursorHead + i]!.text ? item : { ...item, html: headTexts[i]!, template: null, key: headTexts[i]! };
      if (item.kind === "jsonld") return { ...item, value: JSON.parse(headTexts[i]!) };
      return item;
    });
    const virtual: Built = { ...base, file: posix.join(pagesDir, "[...lang]", route), title: rewritten[0]! || null, description: rewritten[1]! || null, wrappers, items, head };
    replaced.set(base, virtual);
    const languages = new Map<string, Built>([[defaultLang, base]]);
    for (const prefix of matching.keys()) {
      languages.set(prefix, byLang.get(prefix)!);
      dropped.add(byLang.get(prefix)!);
    }
    variants.set(virtual, languages);
    params.set(virtual, [...matching.keys()]);
    for (const duplicate of duplicates.get(route) ?? []) dropped.add(duplicate);
  }
  if (!replaced.size) return empty;
  return { pages: built.filter((page) => !dropped.has(page)).map((page) => replaced.get(page) ?? page), variants, params };
}

function headFamilies(pages: Built[], headKey: (item: HeadItem) => string, root: string): Built[][] {
  const families: Array<{ keys: Set<string>; pages: Built[] }> = [];
  for (const page of pages) {
    const keys = new Set(page.head.map(headKey));
    const home = families.find((family) => {
      const shared = [...keys].filter((key) => family.keys.has(key)).length;
      return shared / Math.max(1, Math.min(keys.size, family.keys.size)) >= 0.5 || (!keys.size && !family.keys.size);
    });
    if (home) home.pages.push(page);
    else families.push({ keys, pages: [page] });
  }
  const sorted = families.map((family) => family.pages).sort((a, b) => b.length - a.length);
  return sorted.length ? sorted : [pages];
}

function familyName(pages: Built[], root: string, index: number): string {
  const dir = posix.join(root, "pages") + "/";
  const heads = new Set(pages.map((page) => page.file.startsWith(dir) ? page.file.slice(dir.length).split("/")[0]!.replace(/\.astro$/, "") : ""));
  const head = heads.size === 1 ? [...heads][0]! : "";
  return /^[a-z][a-z0-9-]*$/.test(head) && head !== "index" ? camel(head).replace(/^./, (c) => c.toUpperCase()) : `Section${index + 1}`;
}

export async function astroProject(tree: OutputTree, pages: Page[], sources: AstroSources): Promise<number> {
  const seen = new Set<string>();
  const collected: Built[] = [];
  const animations = new Map<string, string>();
  for (const page of pages) {
    if (page.status >= 400 || !/<html/i.test(page.html)) continue;
    const next = build(page, sources, animations);
    if (seen.has(next.file)) continue;
    seen.add(next.file);
    collected.push(next);
  }
  if (!collected.length) return 0;
  const rootLang = collected.find((page) => !/\/pages\/[a-z]{2}(-[A-Za-z]+)?\//.test(page.file) && page.lang)?.lang ?? null;
  const dictionary = new Dictionary(rootLang ?? "en");
  const localization = rootLang ? localizeBuilt(collected, sources.root, rootLang, dictionary) : { pages: collected, variants: new Map<Built, Map<string, Built>>(), params: new Map<Built, string[]>() };
  const built = localization.pages;
  const expand = (page: Built): Built[] => [...(localization.variants.get(page)?.values() ?? [page])];
  const before = importers(tree);
  const ctx: Context = { tree, data: new DataFiles(tree, sources.root), uses: new Map(), inlinable: (path) => !before.get(path)?.size, consumed: new Set() };
  for (const page of built) {
    for (const island of page.islands) {
      for (const value of island.props.values()) {
        const json = JSON.stringify(value);
        if (json && json.length > 120) ctx.uses.set(json, (ctx.uses.get(json) ?? 0) + 1);
      }
    }
  }
  const headKey = (item: HeadItem) => (item.kind === "markup" ? (item.template ?? item.html) : item.key);
  const families = headFamilies(built, headKey, sources.root);
  const outputs = new Map<string, Output>();
  let layoutCount = 0;
  for (const [familyIndex, family] of families.entries()) {
    const built = family;
    const familyPrefix = familyIndex === 0 ? "" : familyName(family, sources.root, familyIndex);
    const layouts = posix.join(sources.root, "layouts");
    const shells = groups(built, expand);
    const merged = shells.length === 1 && shells[0]!.pages.length === built.length && built.length > 1 && shells[0]!.prefix + shells[0]!.suffix > 0;
    const headCommon = new Set(built[0]!.head.map(headKey).filter((key) => built.every((p) => p.head.some((item) => headKey(item) === key))));
    const owner = built[0]!.head.find((item): item is Extract<HeadItem, { kind: "module" }> => item.kind === "module" && headCommon.has(item.key) && !!item.component && /Layout$/.test(item.component));
    const grouped = shells.some((group) => group.pages.length > 1 && group.prefix + group.suffix > 0);
    const shellName = `${familyPrefix}${merged ? (owner?.component ?? "Layout") : owner?.component && !(grouped && owner.component === "Layout") ? owner.component : "BaseLayout"}`;
    const basePath = posix.join(layouts, `${shellName}.astro`);
    const langs = new Set(collected.map((p) => p.lang));
    const transitions = built.some((p) => p.transitions);
    const described = built.some((p) => p.description);

    const baseEmit = newEmit(basePath);
    for (const sheet of sources.stylesheets) baseEmit.imports.add(`import "${relativeImport(basePath, sheet)}";`);
    if (transitions) baseEmit.imports.add('import { ClientRouter } from "astro:transitions";');
    const headLines: string[] = [];
    for (const item of built[0]!.head) if (headCommon.has(headKey(item))) headLines.push(...(await renderItem(item, baseEmit, ctx, true)));
    const shellHead = ['<meta charset="UTF-8" />', ...headLines, "<title>{title}</title>", ...(described ? ['{description && <meta name="description" content={description} />}'] : []), ...(transitions ? ["<ClientRouter />"] : []), '<slot name="head" />'];
    const htmlOpen = `<html${langs.size > 1 ? " lang={lang}" : [...langs][0] ? ` lang="${[...langs][0]}"` : ""}>`;
    const bodyOpen = `<body${built[0]!.bodyAttrs ? ` ${built[0]!.bodyAttrs}` : ""}>`;
    const shellProps = ["title", ...(described ? ["description"] : []), ...(langs.size > 1 ? [`lang = ${JSON.stringify(built[0]!.lang ?? "en")}`] : [])];
    const propNames = shellProps.map((p) => p.replace(/\s*=.*$/, ""));
    const passProps = (page: Built) => [`title=${JSON.stringify(page.title ?? "")}`, ...(page.description ? [`description=${JSON.stringify(page.description)}`] : []), ...(langs.size > 1 && page.lang ? [localization.variants.has(page) ? "lang={lang}" : `lang="${page.lang}"`] : [])];

    const layoutOf = new Map<Built, { path: string; name: string; props: Map<string, unknown>; keys: Map<string, string> }>();
    for (const group of shells) {
      if (group.pages.length < 2 || group.prefix + group.suffix === 0) continue;
      layoutCount++;
      const name = merged ? shellName : layoutCount === 1 ? "Layout" : `Layout${layoutCount}`;
      const path = merged ? basePath : posix.join(layouts, `${name}.astro`);
      const first = group.pages[0]!;
      const layoutProps = new Map<string, { key: string; fallback: unknown }>();
      const propName = new Map<string, string>();
      const valuesOf = new Map<string, string>();
      const derived = new Map<string, { key: string; position: number; byLang: Map<string, Built> }>();
      const islandAt = (page: Built, position: number) => page.islands[islandIndex(page.items[position >= 0 ? position : page.items.length + position]!)!]!;
      for (const [position, props] of group.varying) {
        for (const [key, fallback] of props) {
          const signature = JSON.stringify(group.pages.flatMap(expand).map((page) => islandAt(page, position).props.get(key)));
          if (langs.size > 1 && signature === JSON.stringify(group.pages.flatMap(expand).map((page) => page.lang ?? built[0]!.lang ?? "en"))) {
            propName.set(`${position}\u0000${key}`, "lang");
            continue;
          }
          const same = [...valuesOf].find(([, values]) => values === signature)?.[0];
          if (same) {
            propName.set(`${position}\u0000${key}`, same);
            continue;
          }
          let prop = key;
          for (let n = 2; layoutProps.has(prop) || propNames.includes(prop); n++) prop = camel(`${key} ${n}`);
          layoutProps.set(prop, { key, fallback });
          propName.set(`${position}\u0000${key}`, prop);
          valuesOf.set(prop, signature);
          const byLang = new Map<string, Built>();
          const perLang =
            langs.size > 1 &&
            I18N_PROP.test(key) &&
            group.pages.flatMap(expand).every((page) => {
              const value = islandAt(page, position).props.get(key);
              const lang = page.lang ?? built[0]!.lang ?? "en";
              const seen = byLang.get(lang);
              if (typeof value !== "object" || value === null || (seen && JSON.stringify(islandAt(seen, position).props.get(key)) !== JSON.stringify(value))) return false;
              byLang.set(lang, page);
              return true;
            });
          if (perLang && byLang.size > 1 && new Set([...byLang.values()].map((page) => JSON.stringify(islandAt(page, position).props.get(key)))).size === byLang.size) derived.set(prop, { key, position, byLang });
        }
      }
      const positionOf = (index: number) => {
        const at = first.items.findIndex((item) => islandIndex(item) === index);
        return at < group.prefix ? at : at - first.items.length;
      };
      const emit = merged ? baseEmit : newEmit(path);
      emit.override = (found, key) => {
        const index = first.islands.indexOf(found);
        const position = positionOf(index);
        return group.varying.get(position)?.has(key) ? (propName.get(`${position}\u0000${key}`) ?? null) : null;
      };
      const scripts = await renderScripts(first, emit, ctx);
      const depth = first.wrappers.length + (merged ? 2 : 1);
      const pad = "  ".repeat(depth);
      const beforeSlot = fill(await formatMarkup(first.items.slice(0, group.prefix).join("\n")), first, emit, ctx, scripts);
      const afterSlot = fill(await formatMarkup(first.items.slice(first.items.length - group.suffix).join("\n")), first, emit, ctx, scripts);
      const selections = [...derived].map(([prop, { key, position, byLang }]) => {
        const entries = [...byLang].map(([lang, page]) => {
          const holder = islandAt(page, position);
          const name = valueExpression(holder.props.get(key), key, holder, lang, emit, ctx);
          return name === lang ? name : `${/^[A-Za-z_$][\w$]*$/.test(lang) ? lang : JSON.stringify(lang)}: ${name}`;
        });
        return `const ${prop} = { ${entries.join(", ")} }[lang];`;
      });
      const defaults = [...layoutProps].filter(([prop]) => !derived.has(prop)).map(([prop, { key, fallback }]) => {
        const holder = first.islands.find((i) => i.props.has(key));
        return fallback === undefined ? prop : `${prop} = ${holder ? valueExpression(fallback, key, holder, first.lang, emit, ctx) : JSON.stringify(fallback)}`;
      });
      const content = [
        ...first.wrappers.map((w, i) => `${"  ".repeat(i + depth - first.wrappers.length)}${w}`),
        ...indent(beforeSlot, pad),
        `${pad}<slot />`,
        ...indent(afterSlot, pad),
        ...[...first.wrappers].reverse().map((w, i) => `${"  ".repeat(depth - 1 - i)}${closing(w)}`),
      ];
      emit.override = undefined;
      if (merged) {
        const code = [`const { ${[...shellProps, ...defaults].join(", ")} } = Astro.props;`, ...selections];
        const markup = ["<!doctype html>", htmlOpen, "  <head>", ...shellHead.map((l) => `    ${l}`), "  </head>", `  ${bodyOpen}`, ...content, "  </body>", "</html>", ""].join("\n");
        outputs.set(path, { emit, code, markup });
      } else {
        emit.imports.add(`import ${shellName} from "./${shellName}.astro";`);
        const code = [`const { ${[...shellProps, ...defaults].join(", ")} } = Astro.props;`, ...selections];
        const markup = [`<${shellName} ${propNames.map((p) => `${p}={${p}}`).join(" ")}>`, '  <slot name="head" slot="head" />', ...content, `</${shellName}>`, ""].join("\n");
        outputs.set(path, { emit, code, markup });
      }
      for (const page of group.pages) {
        const values = new Map<string, unknown>();
        for (const [position, props] of group.varying) {
          const found = islandAt(page, position);
          for (const [key] of props) {
            const prop = propName.get(`${position}\u0000${key}`)!;
            if (!layoutProps.has(prop) || derived.has(prop)) continue;
            if (JSON.stringify(found.props.get(key)) !== JSON.stringify(layoutProps.get(prop)?.fallback)) values.set(prop, found.props.get(key));
          }
        }
        layoutOf.set(page, { path, name, props: values, keys: new Map([...layoutProps].map(([prop, { key }]) => [prop, key])) });
      }
    }
    if (!merged) {
      const code = [`const { ${shellProps.join(", ")} } = Astro.props;`];
      const markup = ["<!doctype html>", htmlOpen, "  <head>", ...shellHead.map((l) => `    ${l}`), "  </head>", `  ${bodyOpen}`, "    <slot />", "  </body>", "</html>", ""].join("\n");
      outputs.set(basePath, { emit: baseEmit, code, markup });
    }

    for (const group of shells) {
      for (const page of group.pages) {
        const layout = layoutOf.get(page);
        const emit = newEmit(page.file);
        const languages = localization.variants.get(page);
        const selections: string[] = [];
        if (languages) {
          const chosen = new Map<string, string>();
          emit.override = (found, key) => {
            const index = page.islands.indexOf(found);
            const values = [...languages].map(([lang, variant]) => [lang, variant.islands[index]?.props.get(key)] as const);
            if (index < 0 || new Set(values.map(([, value]) => JSON.stringify(value))).size < 2) return null;
            if (values.every(([lang, value]) => value === lang)) return "lang";
            const id = `${index}\u0000${key}`;
            if (chosen.has(id)) return chosen.get(id)!;
            let name = identifier(key, "props");
            for (let n = 2; [...chosen.values()].includes(name); n++) name = `${identifier(key, "props")}${n}`;
            chosen.set(id, name);
            const entries = values.map(([lang, value]) => `${/^[A-Za-z_$][\w$]*$/.test(lang) ? lang : JSON.stringify(lang)}: ${valueExpression(value, key, languages.get(lang)!.islands[index]!, lang, emit, ctx)}`);
            selections.push(`const ${name} = { ${entries.join(", ")} }[lang];`);
            return name;
          };
        }
        const scripts = await renderScripts(page, emit, ctx);
        const items = layout ? page.items.slice(group.prefix, page.items.length - group.suffix) : page.items;
        const wrapped = layout ? items : [...page.wrappers, ...items, ...[...page.wrappers].reverse().map(closing)];
        const body = fill(await formatMarkup(wrapped.join("\n")), page, emit, ctx, scripts);
        const extraHead: string[] = [];
        for (const item of page.head) if (!headCommon.has(headKey(item))) extraHead.push(...(await renderItem(item, emit, ctx, false)));
        const target = layout?.path ?? basePath;
        const name = layout?.name ?? shellName;
        emit.imports.add(`import ${name} from "${relativeImport(page.file, target)}";`);
        const holder = (key: string) => page.islands.find((i) => i.props.has(key)) ?? null;
        const attrs = [
          ...passProps(page),
          ...[...(layout?.props ?? [])].map(([prop, value]) => {
            if (typeof value === "string" && !/["{}]/.test(value)) return `${prop}="${value}"`;
            const key = layout?.keys.get(prop) ?? prop;
            const found = holder(key);
            return `${prop}={${found ? valueExpression(value, key, found, page.lang, emit, ctx) : JSON.stringify(value)}}`;
          }),
        ];
        const markup = [`<${name} ${attrs.join(" ")}>`, ...(extraHead.length ? ['  <Fragment slot="head">', ...extraHead.map((line) => `    ${line}`), "  </Fragment>"] : []), ...indent(body, "  "), `</${name}>`, ""].join("\n");
        emit.override = undefined;
        const routeParams = localization.params.get(page);
        const prelude = routeParams ? ["export function getStaticPaths() {", `  return [${["undefined", ...routeParams.map((lang) => JSON.stringify(lang))].join(", ")}].map((lang) => ({ params: { lang } }));`, "}", "", `const lang = Astro.params.lang ?? ${JSON.stringify(rootLang)};`] : [];
        outputs.set(page.file, { emit, code: [...prelude, ...selections], markup });
      }
    }
  }

  scopedStyles(outputs, tree, sources.stylesheets);
  const namespaceOf = (path: string) => camel(path.replace(/\.astro$/, "").replace(/^.*?\/(pages|layouts)\//, (_, dir: string) => (dir === "layouts" ? "layout " : "")).replace(/\[\.\.\.lang\]\/?/, "").replace(/(^|\/)index$/, "$1home").replace(/[/[\].-]+/g, " ")) || "home";
  const usedKeys = new Map<string, Set<string>>();
  for (const [path, output] of outputs) {
    output.markup = markupPlaceholders(output.markup);
    for (const [name, value] of output.emit.constants) output.emit.constants.set(name, codePlaceholders(value));
    output.code = output.code.map(codePlaceholders);
    const text = `${output.markup}\n${output.code.join("\n")}\n${[...output.emit.constants.values()].join("\n")}`;
    const keys = new Set([...text.matchAll(/\bt\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!));
    if (keys.size) usedKeys.set(namespaceOf(path), new Set([...(usedKeys.get(namespaceOf(path)) ?? []), ...keys]));
  }
  const renames = dictionary.scope(usedKeys);
  const withUi = dictionary.write(tree, sources.root);
  const i18nIndex = posix.join(sources.root, "i18n", "index.ts");
  for (const [path, output] of outputs) {
    const langOf = new Map<string, string>();
    for (const [name, source] of output.emit.data) {
      const lang = new RegExp(`^${sources.root}/i18n/([a-z]{2}(?:-[A-Za-z]{2,4})?)\\.json$`).exec(source)?.[1];
      if (lang && withUi.has(lang)) langOf.set(name, lang);
    }
    if (!langOf.size) continue;
    const names = [...langOf.keys()].map((n) => n.replace(/\$/g, "\\$")).join("|");
    const selection = new RegExp(`\\{\\s*(?:(?:(?:[\\w$]+|"[^"]+")\\s*:\\s*)?(?:${names})\\s*,?\\s*)+\\}\\[lang\\]`, "g");
    const single = new RegExp(`(?<![\\w$."'])(${names})(?![\\w$"'])`, "g");
    const fix = (text: string) => text.replace(selection, "messages[lang].ui").replace(single, (_, name: string) => `messages.${langOf.get(name)}.ui`);
    output.code = output.code.map(fix);
    output.markup = output.markup.replace(/=\{([^{}]*)\}/g, (whole, expr: string) => `={${fix(expr)}}`);
    for (const [name, value] of output.emit.constants) output.emit.constants.set(name, fix(value));
    for (const name of langOf.keys()) output.emit.data.delete(name);
    output.emit.imports.add(`import { messages } from "${relativeImport(path, i18nIndex).replace(/\/index\.ts$/, "")}";`);
  }
  for (const [path, output] of outputs) {
    const local = renames.get(namespaceOf(path));
    if (local) {
      const rename = (text: string) => text.replace(/\bt\.([A-Za-z_$][\w$]*)/g, (whole, key: string) => (local.has(key) ? `t.${local.get(key)}` : whole));
      output.markup = rename(output.markup);
      output.code = output.code.map(rename);
      for (const [name, value] of output.emit.constants) output.emit.constants.set(name, rename(value));
    }
    const taken = new Set([...output.emit.constants.keys(), ...output.code.flatMap((line) => [...line.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!))]);
    collapseRepeats(output, taken);
    const uses = placeholderUses(`${output.markup}\n${output.code.join("\n")}\n${[...output.emit.constants.values()].join("\n")}`);
    if (uses.t) output.emit.imports.add(`import { messages } from "${relativeImport(path, i18nIndex).replace(/\/index\.ts$/, "")}";`);
    if (uses.prefix) output.code.push(`const prefix = lang === ${JSON.stringify(rootLang)} ? "" : \`/\${lang}\`;`);
    if (uses.t) output.code.push(`const t = messages[lang].${namespaceOf(path)};`);
    const scripts = output.emit.scripts.map((code) => `\n<script>\n${code}\n</script>\n`).join("");
    tree.add({ path, content: `${frontmatter(output)}${output.markup.trimEnd()}\n${scripts}`, kind: "source", renamable: false });
  }
  const frameworks = new Set(built.flatMap((p) => p.islands.map((i) => i.framework)));
  const site = built.find((p) => p.site)?.site ?? null;
  tree.add({ path: "astro.config.mjs", content: astroConfig(site, frameworks, sources.stylesheets.some((s) => s.endsWith("tailwind.css"))), kind: "data", renamable: false });
  pruneOrphans(tree, ctx.consumed, () => false);
  return built.length;
}
