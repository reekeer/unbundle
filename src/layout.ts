import { posix } from "node:path";
import { DIRS, type OutputTree } from "./output.ts";
import { parseProgram, t } from "./unpack/ast.ts";
import type { OutputFile } from "./types.ts";
import { insertPageMeta, nuxtPages } from "./refine/pages.ts";
import { decompileMessages, defaultExportJson, inlineLocaleModules, nuxtLocales } from "./refine/i18n.ts";
import { adoptLibraryModules, libraryDataModules } from "./refine/datafiles.ts";

const CODE = /\.(m?jsx?|cjs|tsx?|vue|svelte)$/;
const SUFFIXES = ["", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".vue", "/index.js", "/index.jsx", "/index.ts", "/index.tsx"];
const SOURCE_DIRS: Record<string, string> = { functions: "utils" };
const ENTRY = /^(main|index|app|App|root|entry|entry\.client|start)\.(m?jsx?|tsx?|vue)$/;

function relative(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(from), to);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function appRoot(files: OutputFile[], nuxt: boolean, root: string): Map<string, string> {
  const out = new Map<string, string>();
  const candidates = files.filter((f) => /^js\/components\/App\.(vue|jsx|tsx|js)$/.test(f.path));
  const app = nuxt ? candidates.find((f) => f.path.endsWith(".vue") && /<NuxtPage\b/.test(f.content)) : candidates[0];
  if (app) out.set(app.path, posix.join(root, nuxt ? "app.vue" : posix.basename(app.path)));
  return out;
}

function nuxtLayouts(files: OutputFile[], root: string): Map<string, string> {
  const out = new Map<string, string>();
  const pair = /(?:"([a-z][a-z0-9-]*)"|\b([a-z][a-z0-9]*))\s*:\s*defineAsyncComponent\(\s*\(\)\s*=>\s*import\(\s*"(\.[^"]+\.(?:vue|js))"/g;
  for (const file of files) {
    if (!/\.m?js$/.test(file.path) || !file.content.includes("defineAsyncComponent")) continue;
    const clusters: Array<Array<{ key: string; specifier: string; start: number; end: number }>> = [];
    for (const match of file.content.matchAll(pair)) {
      const item = { key: match[1] ?? match[2]!, specifier: match[3]!, start: match.index!, end: match.index! + match[0].length };
      const last = clusters.at(-1)?.at(-1);
      if (last && item.start - last.end < 160) clusters.at(-1)!.push(item);
      else clusters.push([item]);
    }
    for (const cluster of clusters) {
      if (!cluster.some((item) => item.key === "default")) continue;
      for (const item of cluster) out.set(posix.normalize(posix.join(posix.dirname(file.path), item.specifier)), posix.join(root, "layouts", `${item.key}${posix.extname(item.specifier)}`));
    }
  }
  return out;
}

function vueRouterLayout(files: OutputFile[], root: string): Map<string, string> {
  const out = new Map<string, string>();
  const paths = new Set(files.map((f) => f.path));
  const resolveFile = (from: string, specifier: string) => {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier.replace(/[?#].*$/, "")));
    return SUFFIXES.map((suffix) => base + suffix).find((candidate) => paths.has(candidate)) ?? null;
  };
  for (const file of files) {
    if (file.library || !/\.m?[jt]sx?$/.test(file.path) || !file.path.startsWith(`${DIRS.js}/`) || file.path.startsWith(`${DIRS.libraries}/`)) continue;
    if (!/\bcreateRouter\s*\(/.test(file.content) || !/\broutes\s*:/.test(file.content) || !/["']vue-router["']/.test(file.content)) continue;
    out.set(file.path, posix.join(root, "router", `index${posix.extname(file.path)}`));
    const imports = new Map<string, string>();
    for (const match of file.content.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](\.[^"']+)["']/g)) imports.set(match[1]!, match[2]!);
    for (const match of file.content.matchAll(/component\s*:\s*(?:\(\)\s*=>\s*import\(\s*["'](\.[^"']+)["']\s*\)|([A-Za-z_$][\w$]*))(?=[\s,}])/g)) {
      const specifier = match[1] ?? imports.get(match[2] ?? "");
      const target = specifier ? resolveFile(file.path, specifier) : null;
      if (!target || !target.startsWith(`${DIRS.js}/components/`)) continue;
      const after = file.content.slice(match.index! + match[0].length, match.index! + match[0].length + 40);
      const layout = !match[1] && (/^\s*,\s*children\s*:/.test(after) || /Layout$/.test(posix.basename(target).replace(/\.[^.]+$/, "")));
      out.set(target, posix.join(root, layout ? "layouts" : "views", posix.basename(target)));
    }
  }
  return out;
}

function importGraph(files: OutputFile[]): Map<string, Set<string>> {
  const paths = new Set(files.map((f) => f.path));
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    if (!CODE.test(file.path)) continue;
    const targets = new Set<string>();
    for (const match of file.content.matchAll(/\bfrom\s*["'](\.[^"']+)["']|\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const base = posix.normalize(posix.join(posix.dirname(file.path), (match[1] ?? match[2]!).replace(/[?#].*$/, "")));
      const target = SUFFIXES.map((suffix) => base + suffix).find((candidate) => paths.has(candidate));
      if (target && target !== file.path) targets.add(target);
    }
    graph.set(file.path, targets);
  }
  return graph;
}

function viewSwitches(files: OutputFile[], root: string, views: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const byPath = new Map(files.map((f) => [f.path, f]));
  const graph = importGraph(files);
  for (const [path, next] of views) {
    if (!next.startsWith(`${root}/views/`) || !path.endsWith(".vue")) continue;
    const template = /<template>([\s\S]*)<\/template>/.exec(byPath.get(path)?.content ?? "")?.[1]?.trim();
    if (!template) continue;
    const tags = [...template.matchAll(/<([A-Z][A-Za-z0-9]*)\b([^>]*?)\/>/g)];
    if (tags.length < 2 || template.replace(/<([A-Z][A-Za-z0-9]*)\b[^>]*?\/>/g, "").trim() || !tags.every((tag, i) => (i === 0 ? /\sv-if=/ : i === tags.length - 1 ? /\sv-else(-if=|\s|$)/ : /\sv-else-if=/).test(tag[2]!))) continue;
    for (const target of graph.get(path) ?? []) {
      const name = posix.basename(target).replace(/\.vue$/, "");
      if (!target.startsWith(`${DIRS.js}/components/`) || !tags.some((tag) => tag[1] === name)) continue;
      if ([...graph].some(([from, targets]) => from !== path && targets.has(target))) continue;
      out.set(target, posix.join(root, "views", posix.basename(target)));
    }
  }
  return out;
}

function featureFolders(files: OutputFile[], root: string, taken: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const graph = importGraph(files);
  const importers = new Map<string, Set<string>>();
  for (const [from, targets] of graph) for (const target of targets) importers.set(target, (importers.get(target) ?? new Set()).add(from));
  const component = (path: string) => path.startsWith(`${DIRS.js}/components/`) && /\.(vue|[jt]sx)$/.test(path) && !taken.has(path) && posix.dirname(path) === `${DIRS.js}/components`;
  for (const [path, targets] of graph) {
    if (!component(path)) continue;
    const own = [...targets].filter((target) => component(target) && [...(importers.get(target) ?? [])].every((from) => from === path));
    if (own.length < 3) continue;
    const word = /^([A-Z][a-z]+)[A-Z]/.exec(posix.basename(path))?.[1]?.toLowerCase();
    if (!word || /^(app|base|the|ui|main|page|item|card|list|modal|form)$/.test(word)) continue;
    for (const file of [path, ...own]) out.set(file, posix.join(root, "components", word, posix.basename(file)));
  }
  return out;
}

const TS_EMIT = [/\b__decorate\(\s*\[/, /\b__metadata\(\s*["']design:/, /\b__awaiter\(\s*this\b/, /\b([A-Za-z_$][\w$]*)\[\(?\1(?:\["[A-Za-z_$][\w$]*"\]|\.[A-Za-z_$][\w$]*) = -?\d+\)?\] = "/];

const TS_FIELDS = [/\b([A-Za-z_$][\w$]*)\(\s*this,\s*"([\w$]+)"\s*\);[\s\S]{0,800}?\bthis\.\2\s*=[^=]/, /\bclass\b[^{;]*\{\s*(?:(?:static\s+)?[\w$]+;\s*)+constructor\s*\(/];

function ownSource(path: string): boolean {
  if (!path.startsWith(`${DIRS.js}/`) || path.startsWith(`${DIRS.libraries}/`)) return false;
  return !/^(scripts|_missing|vendor)\//.test(path.slice(DIRS.js.length + 1));
}

function appSource(path: string): boolean {
  return ownSource(path) && path.slice(DIRS.js.length + 1).includes("/");
}

function typedProps(code: string): boolean {
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(code)?.[1];
  if (!script || !script.includes("defineProps")) return false;
  let found = false;
  try {
    t.traverseFast(parseProgram(script).program, (node) => {
      if (found || !t.isCallExpression(node) || !t.isIdentifier(node.callee, { name: "defineProps" }) || !t.isObjectExpression(node.arguments[0])) return;
      for (const prop of node.arguments[0].properties) {
        if (!t.isObjectProperty(prop) || !t.isObjectExpression(prop.value)) continue;
        const keys = prop.value.properties.flatMap((p) => (t.isObjectProperty(p) && t.isIdentifier(p.key) ? [p.key.name] : []));
        const typeNull = prop.value.properties.some((p) => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "type" }) && t.isNullLiteral(p.value));
        if (typeNull || !keys.includes("type")) found = true;
      }
    });
  } catch {
    return false;
  }
  return found;
}

export function detectTypeScript(files: OutputFile[], sources: string[], adapter: string | null): boolean {
  if (adapter === "angular") return true;
  if (sources.some((source) => /\.(m?ts|tsx)$/.test(source) && !/(^|\/)node_modules\//.test(source))) return true;
  let vue = 0;
  for (const file of files) {
    if (file.library || !ownSource(file.path)) continue;
    if (/\.m?jsx?$/.test(file.path) && TS_FIELDS.some((pattern) => pattern.test(file.content))) return true;
    if (!appSource(file.path)) continue;
    if (file.path.endsWith(".vue")) {
      if (typedProps(file.content) && ++vue >= 2) return true;
    } else if (/\.m?jsx?$/.test(file.path) && TS_EMIT.some((pattern) => pattern.test(file.content))) return true;
  }
  return false;
}

function typed(path: string, next: string, root: string, content: string): string {
  if (!path.startsWith(`${DIRS.js}/`) || next.startsWith(`${root}/_chunks/`) || next.startsWith("vendor/")) return next;
  const code = content.replace(/`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  return next.replace(/\.jsx$/, ".tsx").replace(/\.js$/, /<\/[\w.]*>|\/>/.test(code) ? ".tsx" : ".ts");
}

function destination(path: string, root: string, flat = false): string {
  if (path.startsWith(`${DIRS.libraries}/`)) return posix.join("vendor", path.slice(DIRS.libraries.length + 1));
  if (path.startsWith(`${DIRS.css}/`)) return posix.join(root, "assets", path);
  if (!path.startsWith(`${DIRS.js}/`)) return path;
  const rest = path.slice(DIRS.js.length + 1);
  const [head, ...tail] = rest.split("/");
  const plainTop = flat && /^[A-Za-z][\w.-]*\.m?[jt]sx?$/.test(rest) && !/^(chunk|module|runtime|webpack|polyfill|vendor|framework|commonjsHelpers)/i.test(rest);
  if (!tail.length) return ENTRY.test(rest) || plainTop || /^(store|shared)\d*\.m?jsx?$/.test(rest) || /^(sw|service-worker|serviceworker|registerSW|worker)\.m?js$/i.test(rest) || rest === "app.config.js" ? posix.join(root, rest) : posix.join(root, "_chunks", rest);
  if (head === "scripts" || head === "_missing" || head === "vendor") return posix.join(root, "_chunks", rest);
  return posix.join(root, SOURCE_DIRS[head!] ?? head!, ...tail);
}

function resolveOld(from: string, specifier: string, known: Map<string, string>): { target: string; suffix: string } | null {
  const clean = specifier.replace(/[?#].*$/, "");
  const base = posix.normalize(posix.join(posix.dirname(from), clean));
  for (const suffix of SUFFIXES) if (known.has(base + suffix)) return { target: base + suffix, suffix };
  return null;
}

function rewrite(path: string, next: string, specifier: string, moves: Map<string, string>): string {
  const found = resolveOld(path, specifier, moves);
  if (!found) return specifier;
  const tail = specifier.match(/[?#].*$/)?.[0] ?? "";
  let target = moves.get(found.target)!;
  if (found.suffix && target.endsWith(found.suffix)) target = target.slice(0, -found.suffix.length);
  else if (!found.suffix && /\.tsx?$/.test(target) && !/\.tsx?$/.test(found.target)) target = target.replace(/\.tsx?$/, "");
  if (/\/index$/.test(target) && !/\.[a-z]+$/.test(target)) target = target.slice(0, -"/index".length);
  return relative(next, target) + tail;
}

export function projectLayout(tree: OutputTree, adapter: string | null, typescript = false): Map<string, string> {
  if (adapter === "nuxt") for (const file of inlineLocaleModules(tree.all())) tree.add(file);
  const files = tree.all();
  const nuxt = adapter === "nuxt";
  const root = nuxt ? "app" : "src";
  const pages = nuxt ? nuxtPages(files, root, (path) => destination(path, root)) : { moves: new Map<string, string>(), meta: new Map<string, string>() };
  for (const file of files) {
    const call = pages.meta.get(file.path);
    if (call) file.content = insertPageMeta(file.content, call);
  }
  const locales = nuxt ? nuxtLocales(files) : new Map<string, string>();
  for (const file of files) {
    if (!locales.has(file.path)) continue;
    file.content = decompileMessages(file.content).code;
    if (locales.get(file.path)!.endsWith(".json")) file.content = defaultExportJson(file.content) ?? file.content;
  }
  const data = libraryDataModules(files);
  const routed = nuxt ? nuxtLayouts(files, root) : vueRouterLayout(files, root);
  const special = new Map([...data, ...adoptLibraryModules(files, data), ...pages.moves, ...locales, ...appRoot(files, nuxt, root), ...routed, ...(nuxt ? [] : viewSwitches(files, root, routed))]);
  if (!nuxt) for (const [from, to] of featureFolders(files, root, special)) special.set(from, to);
  const moves = new Map<string, string>();
  const taken = new Set<string>();
  for (const file of files) {
    let next = special.get(file.path) ?? destination(file.path, root, adapter === null);
    if (typescript && (file.kind === "module" || file.kind === "script")) next = typed(file.path, next, root, file.content);
    const ext = posix.extname(next);
    for (let n = 2; taken.has(next.toLowerCase()); n++) next = `${next.slice(0, next.length - ext.length).replace(/-\d+$/, "")}-${n}${ext}`;
    taken.add(next.toLowerCase());
    moves.set(file.path, next);
  }
  for (const file of files) {
    const path = file.path;
    const next = moves.get(path)!;
    if (typescript && path.endsWith(".vue") && !next.startsWith("vendor/")) file.content = file.content.replace(/<script(\s+setup)?>/, '<script$1 lang="ts">');
    if (CODE.test(path)) {
      if (!next.startsWith("vendor/")) file.content = file.content.replace(/^[ \t]*import\s*(["'])(\.\.?\/[^"'\n]+)\1;?[ \t]*\n/gm, (line, quote: string, specifier: string) => (/\.(css|scss|sass|less)(\?.*)?$/.test(specifier) || !resolveOld(path, specifier, moves) ? line : ""));
      file.content = file.content.replace(/(["'`])(\.\.?\/[^"'`\n]*?)\1/g, (match, quote: string, specifier: string) => `${quote}${rewrite(path, next, specifier, moves)}${quote}`);
    } else if (path.endsWith(".css")) {
      file.content = file.content
        .replace(/url\(\s*(["']?)(\.\.?\/[^"')]+)\1\s*\)/g, (match, quote: string, specifier: string) => `url(${quote}${rewrite(path, next, specifier, moves)}${quote})`)
        .replace(/@import\s+(["'])(\.\.?\/[^"']+)\1/g, (match, quote: string, specifier: string) => `@import ${quote}${rewrite(path, next, specifier, moves)}${quote}`);
    } else if (file.kind === "page" || path.endsWith(".html")) {
      file.content = file.content
        .replace(/\s(href|src)="(\.\.?\/[^"]+)"/g, (match, attr: string, specifier: string) => ` ${attr}="${rewrite(path, next, specifier, moves)}"`)
        .replace(/\sdata-component-src="([^"]+)"/g, (match, list: string) => ` data-component-src="${list.split(" ").map((p) => moves.get(p) ?? p).join(" ")}"`);
    }
  }
  const changed = [...moves].filter(([from, to]) => from !== to);
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const [from] of changed) tree.remove(from);
  const result = new Map<string, string>();
  for (const [from, to] of changed) {
    const stored = tree.add({ ...byPath.get(from)!, path: to });
    result.set(from, stored.path);
  }
  return result;
}

export function aliasImports(tree: OutputTree, adapter: string | null): number {
  const nuxt = adapter === "nuxt";
  const root = nuxt ? "app" : "src";
  const paths = new Set(tree.all().map((f) => f.path));
  let count = 0;
  for (const file of tree.all()) {
    if (!file.path.startsWith(`${root}/`) || !/\.(m?[jt]sx?|vue|astro|svelte)$/.test(file.path) || /\.d\.ts$/.test(file.path)) continue;
    const next = file.content.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"'\n]+)\2/g, (whole, lead: string, quote: string, specifier: string) => {
      const target = posix.normalize(posix.join(posix.dirname(file.path), specifier));
      const clean = target.replace(/[?#].*$/, "");
      const exists = SUFFIXES.some((suffix) => paths.has(clean + suffix)) || paths.has(clean);
      if (!exists) return whole;
      if (target.startsWith(`${root}/`)) {
        count++;
        return `${lead}${quote}@/${target.slice(root.length + 1)}${quote}`;
      }
      if (target.startsWith("vendor/")) {
        count++;
        return `${lead}${quote}${nuxt ? "~~/" : "@vendor/"}${target.slice(nuxt ? 0 : "vendor/".length)}${quote}`;
      }
      return whole;
    });
    if (next !== file.content) file.content = next;
  }
  return count;
}
