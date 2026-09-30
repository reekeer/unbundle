import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import type { OutputFile } from "./types.ts";

export const MANIFEST_FILE = ".unbundle/manifest.json";

export const DIRS = {
  html: "html",
  css: "css",
  js: "js",
  libraries: "js/node_modules",
  scripts: "js/scripts",
  raw: ".chunks",
} as const;

const UNSAFE_CHARS = /[<>:"|?*\\/\u0000-\u001f]/g;
const MAX_SEGMENT = 120;

export function safeSegment(segment: string): string {
  let clean = segment.replace(UNSAFE_CHARS, "_").replace(/[. ]+$/, "_");
  if (clean === "" || clean === "." || clean === "..") clean = "_";
  if (clean.length > MAX_SEGMENT) clean = `${clean.slice(0, MAX_SEGMENT - 9)}~${Bun.hash(clean).toString(36).slice(0, 8)}`;
  return clean;
}

export function safeRelativePath(input: string): string {
  const segments: string[] = [];
  for (const raw of input.replace(/\\/g, "/").split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      segments.pop();
      continue;
    }
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    segments.push(safeSegment(decoded));
  }
  return segments.join("/") || "_";
}

export function hostDir(url: URL): string {
  return safeSegment(url.port ? `${url.hostname}_${url.port}` : url.hostname);
}

const SOURCE_PREFIXES: RegExp[] = [
  /^webpack:\/\/[^/]*\//,
  /^turbopack:\/\/\/?/,
  /^rollup:\/\/\/?/,
  /^vite:\/\/\/?/,
  /^file:\/\/\/?/,
  /^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i,
];

export function normalizeSourcePath(source: string): string {
  let path = source;
  for (const prefix of SOURCE_PREFIXES) {
    if (prefix.test(path)) {
      path = path.replace(prefix, "");
      break;
    }
  }
  return safeRelativePath(path.replace(/[?#].*$/, "").replace(/^(\.\.?\/)+/, ""));
}

function withQuery(path: string, search: string): string {
  if (!search) return path;
  const ext = posix.extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  return `${stem}.q${Bun.hash(search).toString(36).slice(0, 8)}${ext}`;
}

export function commonDirectory(pathnames: string[]): string {
  if (!pathnames.length) return "/";
  const split = pathnames.map((p) => p.split("/").slice(0, -1));
  const first = split[0]!;
  let length = first.length;
  for (const parts of split) {
    let i = 0;
    while (i < length && parts[i] === first[i]) i++;
    length = i;
  }
  return `${first.slice(0, length).join("/")}/`;
}

export class Layout {
  constructor(
    private readonly origin: URL,
    private readonly scope: string,
    private readonly staticPrefix: string,
  ) {}

  private withinScope(url: URL): string {
    const path = url.pathname;
    if (this.scope !== "/" && (path === this.scope || path.startsWith(`${this.scope}/`))) return path.slice(this.scope.length) || "/";
    return path;
  }

  private external(url: URL): string {
    return url.origin !== this.origin.origin ? `_external/${hostDir(url)}/` : "";
  }

  page(url: URL): string {
    const path = this.withinScope(url).replace(/\/+$/, "").replace(/\.html?$/i, "").replace(/\/index$/, "");
    return posix.join(DIRS.html, safeRelativePath(`${this.external(url)}${withQuery(path || "index", url.search)}.html`));
  }

  pageData(page: URL, suffix: string): string {
    return this.page(page).replace(/\.html$/, `.${safeSegment(suffix)}`);
  }

  private short(url: URL): string {
    const path = url.pathname.startsWith(this.staticPrefix) ? url.pathname.slice(this.staticPrefix.length) : this.withinScope(url);
    return `${this.external(url)}${withQuery(path.replace(/^\/?(chunks|css|js|assets|static)\//, ""), url.search)}`;
  }

  style(href: string): string {
    return posix.join(DIRS.css, safeRelativePath(this.short(new URL(href))));
  }

  stylesheet(name: string): string {
    return posix.join(DIRS.css, safeSegment(name));
  }

  script(href: string): string {
    return posix.join(DIRS.scripts, safeRelativePath(this.short(new URL(href))));
  }

  inlineScript(page: URL, index: number): string {
    const base = this.page(page).slice(DIRS.html.length + 1).replace(/\.html$/, "");
    return posix.join(DIRS.scripts, "inline", `${safeRelativePath(base)}-${index}.js`);
  }

  rawPage(url: URL): string {
    return posix.join(DIRS.raw, this.page(url));
  }

  raw(href: string): string {
    const url = new URL(href);
    return posix.join(DIRS.raw, safeRelativePath(`${this.external(url)}${withQuery(this.withinScope(url), url.search)}`));
  }

  source(normalized: string): string {
    return posix.join(DIRS.js, normalized);
  }

  module(group: "app" | "library", name: string): string {
    return posix.join(group === "app" ? DIRS.js : DIRS.libraries, `${safeSegment(name)}.js`);
  }

  missingModule(id: string): string {
    return id.endsWith(".md") ? posix.join(DIRS.js, "_missing", id) : posix.join(DIRS.js, "_missing", `module-${safeSegment(id)}.js`);
  }

  packageFile(file: string): string {
    return posix.join(DIRS.libraries, safeRelativePath(file));
  }
}

export function relativeImport(fromFile: string, toFile: string): string {
  const rel = posix.relative(posix.dirname(fromFile), toFile);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export function repointImports(tree: OutputTree, from: string, to: string, skip: ReadonlySet<string> = new Set()): void {
  const bare = from.replace(/\.[^./]+$/, "");
  for (const file of tree.all()) {
    if (skip.has(file.path) || !/\.(m?[jt]sx?|vue)$/.test(file.path)) continue;
    const next = file.content.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g, (whole, lead: string, quote: string, spec: string) => {
      const target = posix.normalize(posix.join(posix.dirname(file.path), spec));
      if (target !== from && target !== bare) return whole;
      return `${lead}${quote}${relativeImport(file.path, to)}${quote}`;
    });
    if (next !== file.content) file.content = next;
  }
}

export class OutputTree {
  private readonly files = new Map<string, OutputFile>();
  private readonly dirs = new Set<string>();

  add(file: OutputFile): OutputFile {
    let path = safeRelativePath(file.path);
    const existing = this.files.get(path);
    if (existing && existing.content === file.content) return existing;
    if (existing || this.dirs.has(path) || this.hasFileAncestor(path)) path = this.freePath(path);
    const stored = { ...file, path };
    this.files.set(path, stored);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
    return stored;
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  all(): OutputFile[] {
    return [...this.files.values()];
  }

  private hasFileAncestor(path: string): boolean {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (this.files.has(parts.slice(0, i).join("/"))) return true;
    return false;
  }

  private freePath(path: string): string {
    const original = path.split("/");
    const parts = [...original];
    for (let i = 0; i < parts.length - 1; i++) {
      for (let n = 1; this.files.has(parts.slice(0, i + 1).join("/")); n++) parts[i] = `${original[i]}~dir${n > 1 ? n : ""}`;
    }
    const dir = parts.slice(0, -1).join("/");
    const name = parts.at(-1)!;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const join = (file: string) => (dir ? `${dir}/${file}` : file);
    let candidate = join(name);
    for (let n = 2; this.files.has(candidate) || this.dirs.has(candidate); n++) candidate = join(`${stem}~${n}${ext}`);
    return candidate;
  }
}

export function resolveInside(root: string, relative: string): string {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`refusing to write outside output dir: ${relative}`);
  return target;
}

async function isOurManifest(path: string): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  try {
    const manifest = (await file.json()) as { tool?: { name?: unknown } };
    return manifest.tool?.name === "unbundle";
  } catch {
    return false;
  }
}

export async function writeTree(root: string, files: Array<{ path: string; content: string }>): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const ours = (await isOurManifest(join(root, MANIFEST_FILE))) || (await isOurManifest(join(root, "manifest.json")));
  if (entries.length && !ours) {
    throw new Error(`${root} is not empty and has no ${MANIFEST_FILE}; refusing to overwrite it`);
  }
  await rm(root, { recursive: true, force: true });
  const targets = files.map((file) => ({ target: resolveInside(root, file.path), content: file.content }));
  for (const dir of new Set(targets.map((t) => dirname(t.target)))) await mkdir(dir, { recursive: true });
  for (let i = 0; i < targets.length; i += 64) await Promise.all(targets.slice(i, i + 64).map((t) => Bun.write(t.target, t.content)));
}
