import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { Asset, SourceMapResult } from "../types.ts";
import { normalizeExports } from "./cleanup.ts";
import { buildFunctionIndex, exportNames, identifyModule, inlinedVariants, matchLocals, packageVersions, printModule, stringPackages, withFingerprints, type FingerprintDb, type LibraryFile, type ModulePrint } from "./fingerprint.ts";

const REGISTRY = "https://registry.npmjs.org";
const CACHE_SCHEMA = 1;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const JS = /\.[cm]?js$/;
const MIB = 1024 * 1024;
const MAX_SOURCE = 2 * MIB;
const transpiler = new Bun.Transpiler({ loader: "jsx" });

interface Candidate {
  name: string;
  version?: string;
  score: number;
}

interface Metadata {
  name: string;
  version: string;
  dist: { tarball: string; integrity: string };
}

function packageName(spec: string): string {
  return spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
}

function imports(code: string): string[] {
  try {
    return transpiler.scanImports(code).map((entry) => entry.path);
  } catch {
    return [];
  }
}

function candidates(db: FingerprintDb, scripts: readonly Asset[], maps: Iterable<SourceMapResult>, hints: ReadonlyMap<string, string>): Candidate[] {
  const found = new Map<string, Candidate>();
  const known = packageVersions(db);
  const suggest = (name: string, score: number, version?: string) => {
    if (!PACKAGE.test(name) || name.length > 214 || isBuiltin(name)) return;
    if (version && !VERSION.test(version)) return;
    if (version && known.get(name) === version) return;
    const previous = found.get(name);
    if (!previous || score > previous.score) found.set(name, { name, version, score });
  };
  for (const [name, version] of hints) suggest(name, 10, version);
  for (const map of maps) for (const source of map.sources) {
    const after = source.originalPath.split(/(?:^|\/)node_modules\//).at(-1)!;
    if (after === source.originalPath) continue;
    const name = packageName(after);
    const version = /\/\.pnpm\/[^/]+@(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?=[_/])/.exec(source.originalPath)?.[1];
    if (version || !known.has(name)) suggest(name, 8, version);
  }
  const owners = stringPackages(db);
  for (const asset of scripts) {
    const { body } = asset;
    for (const banner of body.matchAll(/\/\*[!*]?[\s\S]{0,500}?(?:@license|@preserve|\bnpm:)\s+((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:\s*@\s*|\s+)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/gi)) suggest(banner[1]!, 8, banner[2]!);
    for (const spec of imports(body)) {
      const name = packageName(spec);
      if (!known.has(name)) suggest(name, 5);
    }
    const matches = new Map<string, number>();
    for (const text of new Set(Array.from(body.matchAll(/["']([^"'\\\n]{12,120})["']/g), (match) => match[1]!))) {
      const name = owners.get(text);
      if (name) matches.set(name, (matches.get(name) ?? 0) + 1);
    }
    for (const [name, count] of matches) if (count >= 4) suggest(name, 3 + Math.min(1, count / 30));
  }
  return [...found.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 6);
}

async function limited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) throw new Error("empty npm response");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw new Error("npm response exceeded the size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function request(url: URL): Promise<Response> {
  if (url.origin !== REGISTRY || url.username || url.password) throw new Error("invalid npm registry URL");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`npm returned HTTP ${response.status}`);
  }
  return response;
}

function exportPath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(exportPath).find(Boolean);
  if (!value || typeof value !== "object") return;
  const conditions = value as Record<string, unknown>;
  for (const key of ["browser", "import", "module", "default", "require"]) {
    const target = exportPath(conditions[key]);
    if (target) return target;
  }
}

export async function packagePrints(bytes: Uint8Array<ArrayBuffer>, name: string, version: string): Promise<LibraryFile[]> {
  const archive = await limited(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), 32 * MIB);
  const files = await new Bun.Archive(archive).files("package/**");
  const manifest = files.get("package/package.json");
  if (!manifest || manifest.size > MIB) return [];
  const pkg = JSON.parse(await manifest.text()) as Record<string, unknown>;
  if (pkg.name !== name || pkg.version !== version) return [];
  const exports = pkg.exports as Record<string, unknown> | string | undefined;
  const top = typeof exports === "object" && exports !== null ? exports["."] ?? exports : exports;
  const main = exportPath(top) ?? exportPath(pkg.browser) ?? exportPath(pkg.module) ?? exportPath(pkg.main) ?? "index.js";
  const resolve = (path: string) => {
    const base = posix.normalize(path).replace(/^\.\//, "");
    if (base === ".." || base.startsWith("../") || base.startsWith("/")) return;
    return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`, `${base}/index.mjs`].find((candidate) => JS.test(candidate) && files.has(`package/${candidate}`));
  };
  const roots = new Map<string, string>();
  const entry = resolve(main);
  if (entry) roots.set(entry, name);
  if (exports && typeof exports === "object") for (const [key, value] of Object.entries(exports)) {
    if (roots.size >= 20) break;
    if (!key.startsWith("./") || key.includes("*")) continue;
    const target = exportPath(value);
    const path = target ? resolve(target) : null;
    if (path && !roots.has(path)) roots.set(path, `${name}${key.slice(1)}`);
  }
  const visited = new Set(roots.keys());
  const queue = [...visited];
  const prints: LibraryFile[] = [];
  let total = 0;
  for (let i = 0; i < queue.length && i < 64; i++) {
    const path = queue[i]!;
    const file = files.get(`package/${path}`)!;
    if (file.size > MAX_SOURCE || total + file.size > 6 * MIB) continue;
    total += file.size;
    const source = await file.text();
    for (const spec of imports(source)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(posix.join(posix.dirname(path), spec));
      if (!target || visited.has(target)) continue;
      visited.add(target);
      queue.push(target);
    }
    try {
      const code = /\b(?:module\.exports|exports\.)/.test(source) && !/^\s*(?:export|import)\s/m.test(source) ? normalizeExports(source) : source;
      const print = printModule(code);
      const specifier = roots.get(path);
      prints.push({
        package: name, version, file: path, entry: !!specifier, ...(specifier ? { specifier } : {}),
        features: print.features, exports: print.exports, names: exportNames(code), locals: [...print.locals, ...inlinedVariants(print)].filter((fn) => fn.name.length > 2),
      });
    } catch {
      // A package can include files that the JavaScript parser does not support.
      continue;
    }
  }
  return prints;
}

function matches(prints: LibraryFile[], observed: ModulePrint[]): boolean {
  if (!prints.length) return false;
  const db = { version: CACHE_SCHEMA, files: prints };
  if (observed.some((print) => (identifyModule(print, db)?.confidence ?? 0) >= 0.85)) return true;
  const index = buildFunctionIndex(db);
  const matched = new Set<string>();
  for (const print of observed) {
    for (const hit of matchLocals([...print.exports, ...print.locals, ...(print.shortLocals ?? [])], index).values()) {
      if (hit.confidence >= 0.95) matched.add(hit.name);
    }
    if (matched.size >= 3) return true;
  }
  return false;
}

function cachePath(cache: string, name: string, version: string): string {
  return join(cache, `${encodeURIComponent(name)}@${version}.json`);
}

async function cachedPrints(path: string, name: string, version: string): Promise<LibraryFile[]> {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size > 16 * MIB) return [];
  try {
    const data = await file.json() as { schema: number; files: LibraryFile[] };
    return data.schema === CACHE_SCHEMA && Array.isArray(data.files) && data.files.every((item) => item.package === name && item.version === version && Array.isArray(item.features) && Array.isArray(item.exports)) ? data.files : [];
  } catch {
    return [];
  }
}

async function writeCache(path: string, prints: LibraryFile[]): Promise<void> {
  await mkdir(posix.dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await Bun.write(temp, JSON.stringify({ schema: CACHE_SCHEMA, files: prints }));
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function learnCandidate(candidate: Candidate, observed: ModulePrint[], cache: string, previousVersion: string | undefined, log: (message: string) => void): Promise<LibraryFile[]> {
  if (candidate.version) {
    const cached = await cachedPrints(cachePath(cache, candidate.name, candidate.version), candidate.name, candidate.version);
    if (matches(cached, observed)) return cached;
  }
  const url = new URL(`/${encodeURIComponent(candidate.name)}/${candidate.version ?? "latest"}`, REGISTRY);
  const metadata = JSON.parse(new TextDecoder().decode(await limited((await request(url)).body, MIB))) as Metadata;
  if (metadata.name !== candidate.name || !VERSION.test(metadata.version) || (candidate.version && metadata.version !== candidate.version) || metadata.version === previousVersion) return [];
  const integrity = /^sha512-([A-Za-z0-9+/=]+)$/.exec(metadata.dist?.integrity ?? "")?.[1];
  if (!integrity) return [];
  const path = cachePath(cache, metadata.name, metadata.version);
  const cached = await cachedPrints(path, metadata.name, metadata.version);
  if (cached.length) return matches(cached, observed) ? cached : [];
  const bytes = await limited((await request(new URL(metadata.dist.tarball))).body, 8 * MIB);
  if (createHash("sha512").update(bytes).digest("base64") !== integrity) throw new Error("npm archive integrity mismatch");
  const prints = await packagePrints(bytes, metadata.name, metadata.version);
  if (!matches(prints, observed)) return [];
  try {
    await writeCache(path, prints);
  } catch (err) {
    log(`could not cache ${metadata.name}@${metadata.version}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return prints;
}

export async function learnFingerprints(db: FingerprintDb, assets: Asset[], maps: Iterable<SourceMapResult>, hints: ReadonlyMap<string, string>, log: (message: string) => void): Promise<FingerprintDb> {
  const scripts = assets.filter((asset) => asset.body.length <= MAX_SOURCE).slice(0, 48);
  const sources = [...maps];
  const targets = candidates(db, scripts, sources, hints);
  if (!targets.length) return db;
  const observed: ModulePrint[] = [];
  for (const code of [...scripts.map((asset) => asset.body), ...sources.flatMap((map) => map.sources.filter((source) => JS.test(source.path)).map((source) => source.content)).slice(0, 48)]) {
    if (code.length > MAX_SOURCE) continue;
    try {
      observed.push(printModule(code));
    } catch {
      continue;
    }
  }
  if (!observed.length) return db;
  const cache = process.env.UNBUNDLE_LEARN_CACHE ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "unbundle", "fingerprints-v1");
  const previous = packageVersions(db);
  const files: LibraryFile[] = [];
  for (const candidate of targets) {
    try {
      files.push(...await learnCandidate(candidate, observed, cache, previous.get(candidate.name), log));
    } catch (err) {
      log(`could not learn ${candidate.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return withFingerprints(db, files);
}
