import { join, posix } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { genericAdapter, loadAdapters } from "./adapters/index.ts";
import { Browser } from "./browser/browser.ts";
import { htmlResources, importMap, inlineScripts, openPage, pageLinks, resolveHttpUrl, scriptResources, styleResources } from "./browser/discover.ts";
import { scanLoaders } from "./browser/coverage.ts";
import { toHar } from "./browser/har.ts";
import { loadExtractors, renderStandalone } from "./standalone/index.ts";
import { count, errorMessage, Report, type Logger } from "./log.ts";
import { commonDirectory, DIRS, hostDir, Layout, MANIFEST_FILE, normalizeSourcePath, OutputTree, relativeImport, repointImports, safeSegment, writeTree } from "./output.ts";
import { boilerplateCounts, isDataOnlyScript, isFrameworkScript, mangledRatio, StringCollector, suggestModuleNames, type StringsIndex } from "./refine/analyze.ts";
import { finalizeModule, normalizeExports, renameExports, trivialModule } from "./refine/cleanup.ts";
import { usageRenames } from "./refine/usage.ts";
import { nameCryptoCode, scanCrypto } from "./refine/crypto.ts";
import { scanServices } from "./refine/services.ts";
import { identifyAndRename } from "./refine/identify.ts";
import { analyzeIcons, detectFramework, replaceIcons } from "./refine/icons.ts";
import { buildFunctionIndex, stringPackages, entryExports, libraryStrings, packageVersions, loadFingerprints, matchLocals, printModule, vendorExportNames, type FingerprintDb, type LibraryComponent } from "./refine/fingerprint.ts";
import { moduleSpecifier } from "./unpack/ast.ts";
import { splitHoisted, type HoistedLabel } from "./unpack/hoisted.ts";
import { deminifyCode } from "./refine/deminify.ts";
import { formatContent, parserFor } from "./refine/format.ts";
import { mergeStyles } from "./refine/styles.ts";
import { organizeModules } from "./refine/organize.ts";
import { splitEntry } from "./refine/entry.ts";
import { astroProject, isImported, pruneOrphans } from "./refine/astro.ts";
import { movePages, nameRouteComponents } from "./refine/routes.ts";
import { adoptPackageAliases, adoptVendorAliases, collapseReexportShims, dedupeExports, forwardReexports, localizeUnknownPackageImports, nameSetupBindings, publishReadableExports, rebindImportedNames, tidyExports, unaliasExports } from "./refine/exports.ts";
import { tidyScript, tidySfc } from "./refine/sfc.ts";
import { aliasImports, detectTypeScript, projectLayout } from "./layout.ts";
import { writeProjectFiles } from "./project.ts";
import { apiGroups, functionGroups, mergeModules } from "./refine/merge.ts";
import { absorbLoneClient, absorbShared, nameStoreFiles } from "./refine/absorb.ts";
import { extractLocaleDictionaries } from "./refine/localize.ts";
import { readablePage } from "./refine/html.ts";
import { reconcileStreaming } from "./standalone/extractors/next-rsc.ts";
import { autoWorkers, refineAll } from "./refine/worker.ts";
import type { Asset, AssetRef, BundlerAdapter, ChunkEnv, Coverage, DiscoverContext, FileEntry, LoaderFinding, Manifest, ModuleRecord, Options, Page, Quality, SourceMapResult, StylesOutput } from "./types.ts";
import { decodeDataUrl, looksLikeSourceMap, sourceMapCandidates, unpackSourceMap } from "./unpack/sourcemap.ts";

const MIN_ADAPTER_SCORE = 0.3;
const MAX_ROUNDS = 12;
const NON_PAGE_EXT = /\.(js|mjs|css|map|json|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|pdf|zip|txt|xml)$/i;

export interface RunResult {
  outDir: string;
  manifest: Manifest;
}

interface Run {
  options: Options;
  log: Logger;
  report: Report;
  browser: Browser;
}

export async function run(options: Options, log: Logger, adapters?: BundlerAdapter[]): Promise<RunResult> {
  const started = performance.now();
  const ctx: Run = { options, log, report: new Report(), browser: new Browser(options, log.withTag("net")) };

  log.start("1/9 open page");
  const start = await openPage(ctx.browser, options.url);
  if (start.url.href !== options.url.href) log.info(`redirected to ${start.url.href}`);

  log.start("2/9 detect bundler");
  const available = adapters ?? (await loadAdapters());
  let { adapter, detection } = detect(ctx, start, available);

  log.start("3/9 crawl pages");
  const scope = crawlScope(start, adapter);
  const pages = await crawl(ctx, start, scope);

  log.start("4/9 load resources");
  let { assets, entries } = await loadResources(ctx, adapter, pages);
  const routed = await crawlRoutesFromCode(ctx, start, scope, pages, assets);
  if (routed.length) {
    pages.push(...routed);
    ({ assets, entries } = await loadResources(ctx, adapter, pages));
  }
  if (!detection.adapter && !ctx.options.adapter) {
    const byAssets = detectFromAssets(ctx, [...assets.values()], available);
    if (byAssets) {
      ({ adapter, detection } = byAssets);
      ({ assets, entries } = await loadResources(ctx, adapter, pages));
    }
  }

  log.start("5/9 source maps");
  const maps = await findSourceMaps(ctx, adapter, assets);

  log.start("6/9 unpack");
  const layout = new Layout(start.url, scope, staticPrefix(start.url, assets));
  const tree = new OutputTree();
  const unpacked = unpack(ctx, adapter, pages, assets, maps, layout, tree, await loadFingerprints());

  log.start("7/9 refine");
  const renamed = await refine(ctx, unpacked.modules, tree);
  for (const file of tree.all()) {
    if (file.kind !== "script" || !file.renamable || file.library) continue;
    try {
      file.content = nameCryptoCode(file.content);
    } catch (err) {
      ctx.report.warn({ stage: "crypto", path: file.path, message: errorMessage(err) });
    }
  }
  const { modules, missing, libraryFunctions, libraryPackages, libraryNamespaces, pageFiles, routeFiles } = placeModules(ctx, adapter, pages, assets, unpacked, layout, tree, await loadFingerprints());
  const styles = writeStyles(ctx, unpacked, layout, tree);
  const fingerprints = await loadFingerprints();
  confirmReadableFunctions(tree, modules, libraryFunctions, fingerprints);
  const present = new Set([...libraryPackages, ...modules.flatMap((m) => (m.identifiedAs ? [m.identifiedAs.package] : []))]);
  const bareFunctions = new Map([...libraryFunctions].filter(([name, pkg]) => pkg && name.length > 2 && (present.has(pkg) || pkg.startsWith("@vue/")) && entryExports(fingerprints, pkg).has(name)).map(([name, pkg]) => [name, pkg.startsWith("@vue/") ? "vue" : pkg] as const));
  const routePages = new Set<string>();
  for (const file of tree.all()) {
    if (file.kind !== "module" || file.library || file.path.startsWith(`${DIRS.libraries}/`) || !/\.m?jsx?$/.test(file.path)) continue;
    file.content = safe(ctx, "routes", () => nameRouteComponents(file.content, routePages), file.content);
  }
  const packageRoles = organize(ctx, tree, modules, pageFiles, libraryFunctions, missing, new Map([...(fingerprints.components ?? [])].filter(([, component]) => present.has(component.package) || (adapter.name === "nuxt" && component.package === "nuxt"))), routeFiles, adapter.name === "nuxt", bareFunctions, libraryNamespaces, (value) => stringPackages(fingerprints).get(value) ?? null);
  relocateManifest(safe(ctx, "pages", () => movePages(tree, routePages), new Map<string, string>()), modules, missing, [...entries, ...unpacked.entries], unpacked.sources);
  relocateManifest(safe(ctx, "entry", () => splitEntry(tree), new Map<string, string>()), modules, missing, [...entries, ...unpacked.entries], unpacked.sources);
  cleanPages(ctx, adapter, pages, layout, tree, styles);
  pruneShells(ctx, tree, modules);
  linkInlineScripts(pages, layout, tree, modules);
  if (detection.adapter === null) relocateManifest(safe(ctx, "scripts", () => flattenScripts(tree), new Map<string, string>()), modules, missing, [...entries, ...unpacked.entries], unpacked.sources);

  const packageExport = (pkg: string, name: string) => {
    for (const candidate of pkg.startsWith("@vue/") ? ["vue", pkg] : [pkg]) if (entryExports(fingerprints, candidate).has(name)) return candidate;
    return null;
  };
  safe(ctx, "exports", () => dedupeExports(tree), 0);
  safe(ctx, "exports", () => collapseReexportShims(tree), 0);
  safe(ctx, "exports", () => forwardReexports(tree), 0);
  const functionIndex = buildFunctionIndex(fingerprints);
  const hints = new Map<string, Map<string, string>>();
  for (const file of tree.all()) {
    if (file.kind !== "module" || !file.path.startsWith(`${DIRS.libraries}/`) || !/\.m?js$/.test(file.path) || !/export\s*\{[^}]*\b[A-Za-z_$][\w$]?\b/.test(file.content)) continue;
    const names = safe(ctx, "vendor names", () => vendorExportNames(file.content, functionIndex, present, (pkg, name) => packageExport(pkg, name) !== null), new Map<string, string>());
    if (names.size) hints.set(file.path, names);
  }
  const published = safe(ctx, "exports", () => publishReadableExports(tree, packageExport, hints, (name) => {
    const component = fingerprints.components?.get(name);
    return component && component.export === name && present.has(component.package) ? packageExport(component.package, name) : null;
  }), 0) + safe(ctx, "exports", () => adoptPackageAliases(tree, packageRoles, (specifier) => [`${DIRS.libraries}/${specifier}/index.js`, `${DIRS.libraries}/${specifier}.js`].find((path) => tree.all().some((f) => f.path === path)) ?? null, packageExport), 0);
  if (published) log.debug(`${count(published, "import")} switched to readable export names`);
  safe(ctx, "exports", () => collapseReexportShims(tree), 0);
  safe(ctx, "exports", () => forwardReexports(tree), 0);
  safe(ctx, "exports", () => rebindImportedNames(tree), 0);
  safe(ctx, "exports", () => dedupeExports(tree), 0);
  safe(ctx, "exports", () => localizeUnknownPackageImports(tree, (specifier) => [`${DIRS.libraries}/${specifier}/index.js`, `${DIRS.libraries}/${specifier}.js`].find((path) => tree.all().some((f) => f.path === path)) ?? null, packageExport), 0);
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || file.library || file.path.startsWith(`${DIRS.libraries}/`)) continue;
    try {
      if (file.path.endsWith(".vue")) file.content = tidySfc(file.content);
      else if (/\.m?jsx?$/.test(file.path)) file.content = tidyScript(file.content);
    } catch (err) {
      ctx.report.warn({ stage: "sfc", path: file.path, message: errorMessage(err) });
    }
  }

  if (options.standalone) {
    log.start("standalone");
    const results = renderStandalone({ pages, bundler: detection.adapter, modules, styles, layout, tree, extractors: await loadExtractors() });
    for (const entry of unpacked.entries) if (entry.type === "document" && results.has(entry.url)) entry.standalone = results.get(entry.url)!;
    const annotated = [...results.values()].filter((r) => r.status === "annotated");
    const skipped = [...results.values()].filter((r) => r.status !== "annotated");
    log.success(`standalone: marked ${count(annotated.reduce((n, r) => n + (r.annotations?.length ?? 0), 0), "component boundary", "component boundaries")} on ${count(annotated.length, "page")}`);
    for (const result of skipped) log.warn(`standalone ${result.status}: ${result.reason}`);
  }

  relocateManifest(safe(ctx, "merge", () => mergeModules(tree, apiGroups(tree, `${DIRS.js}/api`)), new Map<string, string>()), modules, missing, [...entries, ...unpacked.entries], unpacked.sources);
  relocateManifest(safe(ctx, "merge", () => mergeModules(tree, functionGroups(tree, `${DIRS.js}/functions`)), new Map<string, string>()), modules, missing, [...entries, ...unpacked.entries], unpacked.sources);
  const typescript = detectTypeScript(tree.all(), unpacked.sources.map((s) => s.source), detection.adapter);
  if (typescript) log.info("the project was written in TypeScript: sources get .ts/.tsx (types themselves are not recoverable)");
  const moved = safe(ctx, "layout", () => projectLayout(tree, detection.adapter, typescript), new Map<string, string>());
  relocateManifest(moved, modules, missing, [...entries, ...unpacked.entries], unpacked.sources);
  safe(ctx, "layout", () => dropReexportLeftovers(tree), 0);
  if (adapter.name === "astro") await rebuildAstro(ctx, tree, pages, layout, modules, moved);
  relocateManifest(stashPages(tree, !!options.standalone), modules, missing, [...entries, ...unpacked.entries], unpacked.sources);
  safe(ctx, "project files", () => writeProjectFiles(tree, { host: start.url.hostname, adapter: detection.adapter, typescript, versions: new Map([...packageVersions(fingerprints), ...unpacked.modules.flatMap((m) => (m.package?.version ? [[m.package.name, m.package.version] as const] : []))]), html: start.html, base: scope === "/" ? "/" : `${scope.replace(/\/+$/, "")}/` }), []);
  if (detection.adapter === "vite" && tree.all().some((f) => f.path === "index.html")) for (const file of tree.all()) if (/^src\/_chunks\/scripts\/inline\//.test(file.path)) tree.remove(file.path);

  safe(ctx, "exports", () => dedupeExports(tree), 0);
  for (const root of ["src", "app"]) safe(ctx, "absorb", () => absorbShared(tree, root) + nameStoreFiles(tree, root) + absorbLoneClient(tree, root), 0);
  safe(ctx, "exports", () => unaliasExports(tree), 0);
  safe(ctx, "exports", () => nameSetupBindings(tree), 0);
  safe(ctx, "exports", () => tidyExports(tree), 0);
  safe(ctx, "exports", () => adoptVendorAliases(tree, packageExport), 0);
  safe(ctx, "exports", () => tidyExports(tree), 0);
  for (const root of ["src", "app"]) safe(ctx, "i18n", () => extractLocaleDictionaries(tree, root), 0);
  safe(ctx, "layout", () => aliasImports(tree, detection.adapter), 0);
  log.start("8/9 format");
  await formatAll(ctx, tree);

  log.start("9/9 write");
  const strings = collectStrings(tree);
  const scanned = tree.all().filter((f) => (f.kind === "module" || f.kind === "script") && /\.(m?js|jsx)$/.test(f.path));
  const own = tree.all().filter((f) => (f.kind === "module" || f.kind === "script" || f.kind === "page") && /\.(m?[jt]sx?|vue|svelte|astro|html)$/.test(f.path) && !/(^|\/)(vendor|node_modules)\//.test(f.path));
  const findings = [...scanned.flatMap((f) => scanCrypto(f.path, f.content)), ...own.flatMap((f) => scanServices(f.path, f.content))];
  for (const finding of findings.filter((f) => f.kind === "proof-of-work")) log.warn(`proof-of-work: ${finding.file}:${finding.line} (${finding.name})`);
  const coverage = coverageReport(ctx, adapter, { pages, all: assets, fresh: [] }, tree, entries, missing, scope, libraryStrings(await loadFingerprints()), libraryFunctions);
  if (coverage.status === "possibly-incomplete") log.warn("some code may be missing, see .unbundle/manifest.json#coverage");
  const outDir = join(options.outDir, hostDir(start.url));
  const files = [...entries, ...unpacked.entries].sort((a, b) => a.url.localeCompare(b.url));
  const quality = measureQuality(tree, modules, files, libraryPackages);
  if (quality.mangledIdentifiers.app >= 0.35) log.warn(`${Math.round(quality.mangledIdentifiers.app * 100)}% of the site's identifiers are still 1-2 letters, see .unbundle/manifest.json#summary.quality`);
  for (const finding of findings.filter((f) => f.kind === "auth" || f.kind === "captcha" || f.kind === "mini-app")) log.info(`${finding.name}: ${finding.file}:${finding.line}`);
  const manifest: Manifest = {
    tool: { name: "unbundle", version: pkg.version },
    createdAt: new Date().toISOString(),
    input: options.url.href,
    finalUrl: start.url.href,
    bundler: detection,
    summary: {
      pages: pages.length,
      requests: ctx.browser.network.length,
      scripts: files.filter((f) => (f.type === "script" || f.type === "module") && f.status === "ok").length,
      styles: files.filter((f) => f.type === "style" && f.status === "ok").length,
      chunks: unpacked.chunks,
      modules: modules.length,
      sourceMaps: {
        maps: maps.size,
        sources: unpacked.sources.length,
        missingContent: [...maps.values()].reduce((n, m) => n + m.missingContent.length, 0),
      },
      renamedIdentifiers: renamed,
      degraded: files.filter((f) => f.parse === "partial" || f.parse === "raw").length,
      quality,
      strings: strings.total,
      endpoints: strings.endpoints.length,
      errors: ctx.report.errors.length,
      warnings: ctx.report.warnings.length,
      durationMs: Math.round(performance.now() - started),
    },
    files,
    sources: unpacked.sources,
    modules,
    coverage,
    findings,
    errors: ctx.report.errors,
    warnings: ctx.report.warnings,
  };
  const har = toHar(ctx.browser.network, pages, { name: "unbundle", version: pkg.version });
  await writeTree(outDir, [
    ...tree.all(),
    { path: ".unbundle/strings.json", content: `${JSON.stringify(strings, null, 2)}\n` },
    { path: ".unbundle/network.har", content: `${JSON.stringify(har, null, 2)}\n` },
    { path: MANIFEST_FILE, content: `${JSON.stringify(manifest, null, 2)}\n` },
  ]);
  log.debug(`${count(tree.all().length + 3, "file")} written`);
  return { outDir, manifest };
}

function detect(ctx: Run, page: Page, adapters: BundlerAdapter[]) {
  const forced = ctx.options.adapter;
  if (forced) {
    const adapter = forced === genericAdapter.name ? genericAdapter : adapters.find((a) => a.name === forced);
    if (!adapter) throw new Error(`unknown adapter "${forced}" (available: ${[genericAdapter, ...adapters].map((a) => a.name).join(", ")})`);
    const { score, evidence } = adapter.detect(page);
    ctx.log.info(`adapter forced: ${adapter.name}`);
    return { adapter, detection: { adapter: adapter.name, score, evidence, forced: true } };
  }
  const ranked = adapters.map((adapter) => ({ adapter, result: adapter.detect(page) })).sort((a, b) => b.result.score - a.result.score);
  const best = ranked[0];
  if (!best || best.result.score < MIN_ADAPTER_SCORE) {
    ctx.log.warn("no known bundler recognized, using generic adapter");
    return { adapter: genericAdapter, detection: { adapter: null, score: best?.result.score ?? 0, evidence: best?.result.evidence ?? [], forced: false } };
  }
  ctx.log.success(`detected bundler: ${best.adapter.name}`);
  ctx.log.debug(`score ${best.result.score.toFixed(2)}: ${best.result.evidence.join("; ")}`);
  return { adapter: best.adapter, detection: { adapter: best.adapter.name, score: best.result.score, evidence: best.result.evidence, forced: false } };
}

function detectFromAssets(ctx: Run, assets: Asset[], adapters: BundlerAdapter[]) {
  const scripts = assets.filter((a) => isScript(a));
  const ranked = adapters
    .filter((a) => a.detectAssets)
    .map((adapter) => ({ adapter, result: safe(ctx, `${adapter.name}.detectAssets`, () => adapter.detectAssets!(scripts), { score: 0, evidence: [] }) }))
    .sort((a, b) => b.result.score - a.result.score);
  const best = ranked[0];
  if (!best || best.result.score < MIN_ADAPTER_SCORE) return null;
  ctx.log.success(`detected bundler: ${best.adapter.name} (from the loaded scripts)`);
  ctx.log.debug(`score ${best.result.score.toFixed(2)}: ${best.result.evidence.join("; ")}`);
  return { adapter: best.adapter, detection: { adapter: best.adapter.name, score: best.result.score, evidence: best.result.evidence, forced: false } };
}

export function crawlScope(start: Page, adapter: BundlerAdapter): string {
  const fromAdapter = adapter.scopePath?.(start);
  if (fromAdapter) return fromAdapter;
  const path = start.url.pathname;
  return (path.endsWith("/") ? path.replace(/\/+$/, "") : path.slice(0, path.lastIndexOf("/"))) || "/";
}

export function inScope(url: URL, origin: URL, scope: string): boolean {
  if (url.origin !== origin.origin) return false;
  return scope === "/" || url.pathname === scope || url.pathname.startsWith(`${scope}/`);
}

const SITEMAP_PAGES = 200;

async function sitemapPages(ctx: Run, start: Page, scope: string): Promise<URL[]> {
  const origin = start.url.origin;
  const base = `${origin}${scope.replace(/\/?$/, "/")}`;
  const read = async (url: string) => {
    try {
      const response = await ctx.browser.get(url, "fetch", { initiator: "sitemap" });
      return response.status === 200 ? response.body : "";
    } catch {
      return "";
    }
  };
  const queue = [`${base}sitemap.xml`, `${base}sitemap-index.xml`];
  for (const line of (await read(`${origin}/robots.txt`)).split("\n")) {
    const match = /^\s*sitemap:\s*(\S+)/i.exec(line);
    if (match) queue.unshift(match[1]!);
  }
  const done = new Set<string>();
  const out = new Map<string, URL>();
  while (queue.length && done.size < 8) {
    const next = queue.shift()!;
    if (done.has(next)) continue;
    done.add(next);
    const body = await read(next);
    if (!/<(urlset|sitemapindex)\b/.test(body)) continue;
    for (const match of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const url = resolveHttpUrl(match[1]!.replace(/&amp;/g, "&"), next);
      if (!url || url.origin !== origin) continue;
      if (/\.xml$/i.test(url.pathname)) queue.push(url.href);
      else out.set(url.href, url);
    }
  }
  if (out.size) ctx.log.debug(`sitemap lists ${out.size} pages`);
  return [...out.values()];
}

async function crawl(ctx: Run, start: Page, scope: string): Promise<Page[]> {
  const key = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
  const pages = [start];
  const seen = new Set([key(start.url), key(start.requestedUrl)]);
  let frontier = [start];
  ctx.log.debug(`scope ${start.url.origin}${scope}, up to ${ctx.options.maxPages} pages, depth ${ctx.options.crawlDepth}`);

  const listed = ctx.options.crawlDepth > 0 ? await sitemapPages(ctx, start, scope) : [];
  const limit = ctx.options.maxPages + Math.min(listed.length, SITEMAP_PAGES);
  for (let depth = 1; depth <= ctx.options.crawlDepth && frontier.length; depth++) {
    const targets: Array<{ url: URL; from: Page }> = [];
    if (depth === 1) {
      for (const link of listed) {
        if (NON_PAGE_EXT.test(link.pathname) || seen.has(key(link)) || !inScope(link, start.url, scope) || pages.length + targets.length >= limit) continue;
        seen.add(key(link));
        targets.push({ url: link, from: start });
      }
    }
    for (const page of frontier) {
      for (const link of pageLinks(page)) {
        link.search = "";
        if (NON_PAGE_EXT.test(link.pathname) || link.pathname.startsWith("/cdn-cgi/") || seen.has(key(link)) || !inScope(link, start.url, scope)) continue;
        if (pages.length + targets.length >= limit) break;
        seen.add(key(link));
        targets.push({ url: link, from: page });
      }
    }
    const results = await Promise.allSettled(targets.map((t) => openPage(ctx.browser, t.url, t.from.url)));
    frontier = [];
    results.forEach((result, i) => {
      const url = targets[i]!.url.href;
      if (result.status === "rejected") {
        ctx.report.error({ stage: "crawl", url, message: errorMessage(result.reason) });
        ctx.log.warn(`${url}: ${errorMessage(result.reason)}`);
      } else if (/html/i.test(result.value.headers.get("content-type") ?? "") || /<html/i.test(result.value.html.slice(0, 1024))) {
        seen.add(key(result.value.url));
        pages.push(result.value);
        frontier.push(result.value);
        ctx.log.debug(result.value.url.pathname);
      }
    });
  }
  ctx.log.success(`found ${count(pages.length, "page")}`);
  return pages;
}

const ROUTE_STRING = /["'`](\/[A-Za-z0-9\-_~.%/]*)["'`]/g;
const UNSAFE_ROUTE = /(^|\/)(api|graphql|trpc|logout|log-out|signout|sign-out|delete|remove|destroy|unsubscribe|oauth|callback|webhooks?)(\/|$)/i;

export function routeCandidates(code: string, origin: URL, scope: string): URL[] {
  const found = new Map<string, URL>();
  for (const match of code.matchAll(ROUTE_STRING)) {
    const path = match[1]!;
    if (path.startsWith("//") || path.length > 120 || UNSAFE_ROUTE.test(path)) continue;
    const segments = path.split("/").filter(Boolean);
    if (segments.some((seg) => /^[_[:(]/.test(seg) || seg.includes("..")) || NON_PAGE_EXT.test(path) || /\.\w{1,5}$/.test(path.replace(/\.html?$/, ""))) continue;
    if (segments.length && segments.every((seg) => seg.length < 2)) continue;
    if (/^\/?index(\.html?)?$/i.test(segments.at(-1) ?? "")) continue;
    const full = scope !== "/" && !(path === scope || path.startsWith(`${scope}/`)) ? `${scope}${path === "/" ? "" : path}` : path;
    const url = new URL(full, origin);
    if (inScope(url, origin, scope)) found.set(url.href.replace(/\/+$/, ""), url);
  }
  return [...found.values()];
}

async function crawlRoutesFromCode(ctx: Run, start: Page, scope: string, pages: Page[], assets: Map<string, Asset>): Promise<Page[]> {
  if (ctx.options.crawlDepth === 0 || pages.length >= ctx.options.maxPages) return [];
  const key = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
  const known = new Set(pages.flatMap((p) => [key(p.url), key(p.requestedUrl)]));
  const candidates = new Map<string, URL>();
  for (const asset of assets.values()) {
    if (!isScript(asset)) continue;
    for (const url of routeCandidates(asset.body, start.url, scope)) if (!known.has(key(url))) candidates.set(key(url), url);
  }
  const targets = [...candidates.values()].slice(0, ctx.options.maxPages - pages.length);
  if (!targets.length) return [];
  ctx.log.debug(`routes from code: ${targets.map((u) => u.pathname).join(", ")}`);
  const results = await Promise.allSettled(targets.map((url) => openPage(ctx.browser, url, start.url)));
  const found: Page[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      ctx.report.warn({ stage: "crawl", url: targets[i]!.href, message: `route from code: ${errorMessage(result.reason)}` });
      return;
    }
    const page = result.value;
    if (!/html/i.test(page.headers.get("content-type") ?? "") || known.has(key(page.url))) return;
    known.add(key(page.url));
    found.push(page);
    ctx.log.debug(`${page.url.pathname} (route from code)`);
  });
  return found;
}

async function loadResources(ctx: Run, adapter: BundlerAdapter, pages: Page[]): Promise<{ assets: Map<string, Asset>; entries: FileEntry[] }> {
  const start = pages[0]!;
  const assets = new Map<string, Asset>();
  const entries = new Map<string, FileEntry>();
  const queued = new Set<string>();
  const referrerOf = new Map<string, URL>();
  let pending: AssetRef[] = [];

  const enqueue = (refs: AssetRef[], referrer: URL) => {
    for (const ref of refs) {
      if (queued.has(ref.url) || ref.type === "document" || ref.type === "sourcemap") continue;
      queued.add(ref.url);
      const url = new URL(ref.url);
      const owned = (url.origin === start.url.origin && !url.pathname.startsWith("/cdn-cgi/")) || adapter.ownsUrl?.(url, start) || ctx.options.includeExternal;
      if (!owned) {
        entries.set(ref.url, { url: ref.url, localPath: null, type: ref.type, status: "skipped", initiator: ref.initiator, error: "third-party (use --include-external)" });
        continue;
      }
      referrerOf.set(ref.url, referrer);
      pending.push(ref);
    }
  };

  for (const page of pages) {
    enqueue(htmlResources(page), page.url);
    enqueue(safe(ctx, "collectAssets", () => adapter.collectAssets(page), []), page.url);
  }

  for (let round = 1; pending.length && round <= MAX_ROUNDS; round++) {
    const batch = pending;
    pending = [];
    const results = await Promise.allSettled(
      batch.map((ref) => ctx.browser.get(ref.url, ref.type, { initiator: ref.initiator, referrer: referrerOf.get(ref.url) ?? start.url })),
    );
    const fresh: Asset[] = [];
    results.forEach((result, i) => {
      const ref = batch[i]!;
      if (result.status === "fulfilled") {
        const asset = { ref, finalUrl: result.value.finalUrl, contentType: result.value.contentType, headers: result.value.headers, body: result.value.body };
        assets.set(ref.url, asset);
        fresh.push(asset);
        return;
      }
      const message = errorMessage(result.reason);
      entries.set(ref.url, { url: ref.url, localPath: null, type: ref.type, status: "failed", initiator: ref.initiator, error: message });
      if (ref.optional) ctx.report.warn({ stage: "load", url: ref.url, message });
      else {
        ctx.report.error({ stage: "load", url: ref.url, message });
        ctx.log.warn(`${ref.url}: ${message}`);
      }
    });
    ctx.log.debug(`round ${round}: ${fresh.length} loaded, ${batch.length - fresh.length} failed`);

    for (const asset of fresh) {
      const from = new URL(asset.finalUrl);
      if (asset.ref.type === "style") enqueue(styleResources(asset.body, asset.finalUrl), from);
      else if (isScript(asset)) enqueue(scriptResources(asset.body, asset.finalUrl, asset.ref.type === "module"), from);
    }
    if (adapter.discover) enqueue(safe(ctx, "discover", () => adapter.discover!({ pages, all: assets, fresh }), []), start.url);
  }
  if (pending.length) ctx.report.warn({ stage: "load", message: `stopped after ${MAX_ROUNDS} rounds, ${pending.length} left` });
  ctx.log.success(`loaded ${count(assets.size, "file")} in ${count(ctx.browser.network.length, "request")}`);
  return { assets, entries: [...entries.values()] };
}

function isScript(asset: Asset): boolean {
  return asset.ref.type === "script" || asset.ref.type === "module" || asset.ref.type === "worker" || /javascript/.test(asset.contentType);
}

function safe<T>(ctx: Run, what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    ctx.report.warn({ stage: "adapter", message: `${what} failed: ${errorMessage(err)}` });
    return fallback;
  }
}

async function safeAsync<T>(ctx: Run, what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    ctx.report.warn({ stage: "adapter", message: `${what} failed: ${errorMessage(err)}` });
    return fallback;
  }
}

async function findSourceMaps(ctx: Run, adapter: BundlerAdapter, assets: Map<string, Asset>): Promise<Map<string, SourceMapResult>> {
  const results = new Map<string, SourceMapResult>();
  if (!ctx.options.sourceMaps) {
    ctx.log.debug("source maps skipped (--no-sourcemaps)");
    return results;
  }
  const normalize = adapter.normalizeSourcePath ?? normalizeSourcePath;
  await Promise.all(
    [...assets.values()]
      .filter((a) => isScript(a) || a.ref.type === "style")
      .map(async (asset) => {
        for (const candidate of sourceMapCandidates(asset)) {
          let text: string | null;
          try {
            text = candidate.url.startsWith("data:")
              ? decodeDataUrl(candidate.url)
              : (await ctx.browser.get(candidate.url, "sourcemap", { initiator: `sourcemap:${asset.finalUrl}`, referrer: new URL(asset.finalUrl) })).body;
          } catch (err) {
            if (candidate.explicit) ctx.log.debug(`source map not published: ${candidate.url} (${errorMessage(err)})`);
            continue;
          }
          if (!text || !looksLikeSourceMap(text)) continue;
          try {
            const result = unpackSourceMap(text, candidate.url, asset.ref.url, normalize);
            if (!result.sources.length) {
              ctx.report.warn({ stage: "sourcemap", url: candidate.url, message: "no sourcesContent, unpacking instead" });
              continue;
            }
            results.set(asset.ref.url, result);
            return;
          } catch (err) {
            ctx.report.warn({ stage: "sourcemap", url: candidate.url, message: `invalid map: ${errorMessage(err)}` });
          }
        }
      }),
  );
  if (results.size) ctx.log.success(`found ${count(results.size, "source map")} with ${count([...results.values()].reduce((n, r) => n + r.sources.length, 0), "original file")}`);
  else ctx.log.info("no source maps published, recovering code from the bundles");
  return results;
}

function staticPrefix(origin: URL, assets: Map<string, Asset>): string {
  const paths = [...assets.values()].map((a) => new URL(a.ref.url)).filter((u) => u.origin === origin.origin).map((u) => u.pathname);
  return commonDirectory(paths);
}

interface Unpacked {
  entries: FileEntry[];
  sources: Manifest["sources"];
  modules: ModuleRecord[];
  chunks: number;
  styles: Array<{ url: string; finalUrl: string; css: string }>;
}

function unpack(ctx: Run, adapter: BundlerAdapter, pages: Page[], assets: Map<string, Asset>, maps: Map<string, SourceMapResult>, layout: Layout, tree: OutputTree, fingerprints: FingerprintDb): Unpacked {
  const out: Unpacked = { entries: [], sources: [], modules: [], chunks: 0, styles: [] };
  const seenBodies = new Map<string, string>();
  const env: ChunkEnv = { importMap: new Map(pages.flatMap((page) => [...importMap(page)])) };

  for (const page of pages) {
    const file = tree.add({ path: layout.page(page.url), content: page.html, kind: "page", renamable: false });
    out.entries.push({ url: page.url.href, localPath: file.path, type: "document", status: "ok", via: "copy" });
    for (const data of safe(ctx, "pageData", () => adapter.pageData?.(page) ?? [], [])) {
      tree.add({ path: layout.pageData(page.url, data.suffix), content: data.content, kind: "data", renamable: false });
    }
    inlineScripts(page)
      .filter((script) => !isDataOnlyScript(script.code) && !isFrameworkScript(script.code))
      .forEach((script, i) => {
        tree.add({ path: layout.inlineScript(page.url, i + 1), content: deminifySafe(ctx, script.code, page.url.href), kind: "script", renamable: true });
      });
  }

  for (const asset of assets.values()) {
    const url = asset.ref.url;
    const base = { url, type: asset.ref.type, initiator: asset.ref.initiator };
    try {
      const raw = tree.add({ path: layout.raw(url), content: asset.body, kind: "raw", renamable: false });
      const map = maps.get(url);
      if (map) {
        if (!map.mapUrl.startsWith("data:")) tree.add({ path: layout.raw(map.mapUrl), content: map.raw, kind: "raw", renamable: false });
        for (const source of map.sources) {
          const file = tree.add({ path: layout.source(source.path), content: source.content, kind: "source", renamable: false });
          out.sources.push({ source: source.originalPath, localPath: file.path, mapUrl: map.mapUrl });
        }
      }
      const withMap = map ? { via: "sourcemap" as const, sourceMap: map.mapUrl } : null;

      if (asset.ref.type === "style") {
        out.styles.push({ url, finalUrl: asset.finalUrl, css: asset.body });
        out.entries.push({ ...base, localPath: raw.path, status: "ok", ...(withMap ?? { via: "copy" as const }) });
        continue;
      }
      if (!isScript(asset) || withMap) {
        out.entries.push({ ...base, localPath: raw.path, status: "ok", ...(withMap ?? { via: "copy" as const }) });
        continue;
      }

      const hash = Bun.hash(asset.body).toString(36);
      const original = seenBodies.get(hash);
      if (original) {
        out.entries.push({ ...base, localPath: raw.path, status: "duplicate", duplicateOf: original });
        continue;
      }
      seenBodies.set(hash, url);

      const chunk = safe(ctx, `parseChunk ${url}`, () => adapter.parseChunk(asset, env), null);
      const diagnostics = chunk?.diagnostics;
      const parse = diagnostics ? { parse: diagnostics.level, ...(diagnostics.level === "full" ? {} : { parseNotes: describeDiagnostics(diagnostics) }) } : {};
      if (diagnostics && diagnostics.level !== "full") {
        ctx.report.warn({ stage: "unpack", url, message: `${diagnostics.level} parse (${diagnostics.shape}): ${describeDiagnostics(diagnostics).join("; ")}` });
        ctx.log.warn(`${diagnostics.level} parse of ${url}: ${diagnostics.recognized} recognized, ${diagnostics.skipped.length} skipped`);
      }
      if (chunk?.modules.length) {
        out.chunks++;
        const modules = chunk.modules.flatMap((mod) => splitBundle(ctx, mod, fingerprints));
        out.modules.push(...modules);
        out.entries.push({ ...base, localPath: raw.path, status: "ok", via: "unpack", modules: modules.map((m) => m.id), ...parse });
        continue;
      }
      const runtime = safe(ctx, "isRuntime", () => adapter.isRuntime?.(asset) ?? false, false);
      const file = tree.add({ path: layout.script(url), content: deminifySafe(ctx, asset.body, url), kind: "script", renamable: true, library: runtime });
      out.entries.push({ ...base, localPath: file.path, status: "ok", via: "deminify", ...parse });
    } catch (err) {
      ctx.report.error({ stage: "unpack", url, message: errorMessage(err) });
      out.entries.push({ ...base, localPath: null, status: "failed", error: errorMessage(err) });
    }
  }
  ctx.log.success(`unpacked ${count(out.chunks, "chunk")} into ${count(out.modules.length, "module")}${out.sources.length ? ` and ${count(out.sources.length, "original file")}` : ""}`);
  return out;
}

function describeDiagnostics(d: NonNullable<ReturnType<BundlerAdapter["parseChunk"]>>["diagnostics"]): string[] {
  const skipped = d.skipped.slice(0, 10).map((x) => `module ${x.id}: ${x.reason}`);
  const more = d.skipped.length > 10 ? [`...and ${d.skipped.length - 10} more skipped`] : [];
  return [...d.notes, ...skipped, ...more];
}

function writeStyles(ctx: Run, unpacked: Unpacked, layout: Layout, tree: OutputTree): StylesOutput {
  const sources = new Set(unpacked.styles.flatMap((s) => [s.url, s.finalUrl]));
  if (!unpacked.styles.length) return { app: null, tailwind: null, sources };
  const merged = mergeStyles(unpacked.styles.map((s) => ({ url: s.url, css: s.css })));
  let tailwind: StylesOutput["tailwind"] = null;
  if (merged.tailwind) {
    const file = tree.add({ path: layout.stylesheet("tailwind.css"), content: merged.tailwind.css + "\n", kind: "style", renamable: false, noFormat: true });
    tailwind = { path: file.path, version: merged.tailwind.version, rules: merged.tailwind.rules, bytes: merged.tailwind.css.length };
  }
  let app: string | null = null;
  if (merged.app.rules || !merged.tailwind) {
    app = tree.add({ path: layout.stylesheet("app.css"), content: merged.app.css + "\n", kind: "style", renamable: false }).path;
  }
  for (const entry of unpacked.entries) if (entry.type === "style" && entry.status === "ok") entry.localPath = app ?? tailwind?.path ?? entry.localPath;
  ctx.log.debug(`${count(merged.sources.length, "stylesheet")} merged into ${[app, tailwind?.path].filter(Boolean).join(" and ")}`);
  return { app, tailwind, sources };
}

function cleanPages(ctx: Run, adapter: BundlerAdapter, pages: Page[], layout: Layout, tree: OutputTree, styles: StylesOutput): void {
  const start = pages[0]!;
  const owned = (url: URL) => url.origin === start.url.origin || !!adapter.ownsUrl?.(url, start);
  const files = new Map(tree.all().map((f) => [f.path, f]));
  let removed = 0;
  for (const page of pages) {
    const path = layout.page(page.url);
    const file = files.get(path);
    if (!file || file.kind !== "page") continue;
    try {
      const clean = readablePage(page.html, { pageUrl: page.url, filePath: path, owned, styles, prepare: reconcileStreaming });
      tree.add({ path: layout.rawPage(page.url), content: page.html, kind: "raw", renamable: false });
      file.content = clean.html;
      removed += clean.removedScripts;
    } catch (err) {
      ctx.report.warn({ stage: "html", url: page.url.href, message: `kept original markup: ${errorMessage(err)}` });
    }
  }
  if (removed) ctx.log.debug(`${count(pages.length, "page")} cleaned, originals kept in ${DIRS.raw}/${DIRS.html}/`);
}

function confirmReadableFunctions(tree: OutputTree, modules: Manifest["modules"], libraryFunctions: Map<string, string>, db: FingerprintDb): void {
  const app = new Set(modules.filter((m) => m.group === "app" && m.localPath).map((m) => m.localPath!));
  const index = buildFunctionIndex(db);
  for (const file of tree.all()) {
    if (!app.has(file.path) || !/\.m?jsx?$/.test(file.path)) continue;
    try {
      const print = printModule(file.content);
      const known = new Set([...print.known, ...[...print.locals, ...print.exports].map((f) => f.name).filter((n) => n.length > 2)]);
      const readable = [...print.locals, ...print.exports].filter((f) => f.name.length > 2 && !libraryFunctions.has(f.name) && /^[A-Za-z]/.test(f.name));
      for (const [name, match] of matchLocals(readable, index, known)) if (match.name === name) libraryFunctions.set(name, match.package);
    } catch {
      continue;
    }
  }
}

function stashPages(tree: OutputTree, standalone: boolean): Map<string, string> {
  const moved = new Map<string, string>();
  for (const file of tree.all()) {
    if (!file.path.startsWith(`${DIRS.html}/`) || /\.standalone\.html$/.test(file.path)) continue;
    const raw = posix.join(DIRS.raw, file.path);
    if (file.kind === "page") {
      if (standalone) continue;
      tree.remove(file.path);
      moved.set(file.path, raw);
    } else {
      tree.remove(file.path);
      moved.set(file.path, tree.add({ ...file, path: raw }).path);
    }
  }
  return moved;
}

function relocateManifest(moved: Map<string, string>, modules: Manifest["modules"], missing: Coverage["missingModules"], files: FileEntry[], sources: Manifest["sources"]): void {
  if (!moved.size) return;
  const to = (path: string) => moved.get(path) ?? path;
  for (const mod of modules) {
    if (mod.localPath) mod.localPath = to(mod.localPath);
    if (mod.parts) mod.parts = mod.parts.map(to);
    if (mod.exports) mod.exports = Object.fromEntries(Object.entries(mod.exports).map(([name, path]) => [name, to(path)]));
  }
  for (const entry of missing) entry.module = to(entry.module);
  for (const file of files) {
    if (file.localPath) file.localPath = to(file.localPath);
    for (const annotation of file.standalone?.annotations ?? []) if (annotation.src) annotation.src = annotation.src.split(" ").map(to).join(" ");
    if (file.standalone?.localPath) file.standalone.localPath = to(file.standalone.localPath);
  }
  for (const source of sources) source.localPath = to(source.localPath);
}

function flattenScripts(tree: OutputTree): Map<string, string> {
  const prefix = `${DIRS.scripts}/`;
  const inline = `${DIRS.scripts}/inline/`;
  const taken = new Set(tree.all().map((f) => f.path));
  const moves = new Map<string, string>();
  for (const file of tree.all()) {
    if (file.kind !== "script" || !file.path.startsWith(prefix) || file.path.startsWith(inline)) continue;
    const rest = file.path.slice(prefix.length).replace(/\.q[0-9a-z]{8}(?=\.[^./]+$)/i, "");
    let target = posix.join(DIRS.js, rest);
    if (target === file.path) continue;
    for (let n = 2; taken.has(target) && target !== file.path; n++) target = posix.join(DIRS.js, rest.replace(/(\.[^./]+)$/, `-${n}$1`));
    taken.delete(file.path);
    taken.add(target);
    moves.set(file.path, target);
  }
  if (!moves.size) return moves;
  const byPath = new Map(tree.all().map((f) => [f.path, f]));
  for (const [from, to] of moves) {
    const file = byPath.get(from)!;
    tree.remove(from);
    tree.add({ ...file, path: to });
  }
  for (const [from, to] of moves) repointImports(tree, from, to);
  return moves;
}

function linkInlineScripts(pages: Page[], layout: Layout, tree: OutputTree, modules: Manifest["modules"]): void {
  const perChunk = new Map<string, string[]>();
  for (const mod of modules) if (mod.chunkUrl && mod.localPath) perChunk.set(mod.chunkUrl, [...(perChunk.get(mod.chunkUrl) ?? []), mod.localPath]);
  const files = new Map(tree.all().map((f) => [f.path, f]));
  for (const page of pages) {
    inlineScripts(page)
      .filter((script) => !isDataOnlyScript(script.code) && !isFrameworkScript(script.code))
      .forEach((_, i) => {
        const file = files.get(layout.inlineScript(page.url, i + 1));
        if (!file) return;
        file.content = file.content.replace(/(\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)(["'])([^"']+)\2/g, (match, lead: string, quote: string, spec: string) => {
          if (!/^(\.{1,2}\/|\/|https?:)/.test(spec)) return match;
          const url = resolveHttpUrl(spec, page.baseUrl);
          const local = url ? perChunk.get(url.href) : undefined;
          return local?.length === 1 ? `${lead}${quote}${relativeImport(file.path, local[0]!)}${quote}` : match;
        });
      });
  }
}

const BARE_IMPORT = /^[ \t]*import\s*["']([^"']+)["'];?[ \t]*$/gm;

function isShell(code: string): boolean {
  return (
    code
      .replace(BARE_IMPORT, "")
      .replace(/^[ \t]*export\s*\{\s*\};?[ \t]*$/gm, "")
      .trim() === ""
  );
}

function dropReexportLeftovers(tree: OutputTree): number {
  const code = (path: string) => /\.(m?[jt]sx?|vue|astro)$/.test(path);
  for (const file of tree.all()) {
    if (!file.path.startsWith("vendor/") || !code(file.path)) continue;
    const next = file.content.replace(/^[ \t]*import\s*["'](\.{1,2}\/[^"']+)["'];?[ \t]*\n?/gm, (line, specifier: string) => (posix.normalize(posix.join(posix.dirname(file.path), specifier)).startsWith("vendor/") ? line : ""));
    if (next !== file.content) file.content = next;
  }
  const leftovers = tree.all().filter((f) => /^(src|app)\/_chunks\/[^/]+\.m?[jt]s$/.test(f.path) && /^(\s*(import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?|import\s*["'][^"']+["'];?|export\s*\{[^}]*\}(\s*from\s*["'][^"']+["'])?;?)\s*)*$/.test(f.content) && !isImported(tree, f.path));
  pruneOrphans(tree, leftovers.map((f) => f.path), () => false);
  return leftovers.length;
}

async function rebuildAstro(ctx: Run, tree: OutputTree, pages: Page[], layout: Layout, modules: Manifest["modules"], moved: Map<string, string>): Promise<void> {
  const at = (path: string) => moved.get(path) ?? path;
  const byChunk = new Map(modules.filter((m) => m.localPath && m.group === "app").map((m) => [m.chunkUrl, m.localPath!] as const));
  const present = new Set(tree.all().map((f) => f.path));
  const built = await safeAsync(ctx, "astro", () =>
    astroProject(tree, pages, {
      root: "src",
      moduleFor: (url) => byChunk.get(url) ?? null,
      stylesheets: ["app.css", "tailwind.css"].map((name) => at(layout.stylesheet(name))).filter((path) => present.has(path)),
      publicFile: (url) => {
        const from = at(layout.script(url));
        const file = tree.all().find((f) => f.path === from);
        if (!file) return null;
        const pathname = new URL(url).pathname;
        tree.remove(from);
        tree.add({ ...file, path: posix.join("public", pathname), library: true });
        return pathname;
      },
    }),
  0);
  if (!built) return;
  for (const [from, to] of moved) if (from.startsWith(`${DIRS.scripts}/inline/`)) tree.remove(to);
  for (const file of tree.all()) {
    if (!/\.(m?[jt]sx?|vue|astro)$/.test(file.path) || file.path.startsWith("vendor/")) continue;
    file.content = file.content
      .replace(/import\(\s*["']astro\/transitions\/router["']\s*\)\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.\w+\s*\)/g, 'import("astro:transitions/client")')
      .replace(/(from\s*|import\s*\(\s*)["']astro\/transitions\/router["']/g, '$1"astro:transitions/client"');
  }
  pruneOrphans(tree, modules.filter((m) => m.localPath && /\/ClientRouter\.astro_astro_type_script/.test(m.chunkUrl ?? "")).map((m) => m.localPath!), () => false);
  pruneOrphans(tree, modules.filter((m) => /^vendor\/(astro\/transitions|@astrojs)\//.test(m.localPath ?? "") && !isImported(tree, m.localPath!)).map((m) => m.localPath!), () => false);
  ctx.log.success(`rebuilt ${count(built, "Astro page")} with a shared layout`);
}

function pruneShells(ctx: Run, tree: OutputTree, modules: Manifest["modules"]): void {
  const pages = tree.all().filter((f) => f.kind !== "module" && f.kind !== "script" && f.kind !== "raw");
  const code = () => tree.all().filter((f) => (f.kind === "module" || f.kind === "script") && /\.m?jsx?$|\.vue$/.test(f.path));
  const resolve = (from: string, spec: string) => (spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(from), spec)) : null);
  const removed = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    const files = code();
    const held = new Set<string>();
    for (const file of files) {
      for (const match of file.content.replace(BARE_IMPORT, "").matchAll(/["'`](\.{1,2}\/[^"'`]+)["'`]/g)) {
        const target = resolve(file.path, match[1]!);
        if (target) held.add(target);
      }
    }
    for (const file of files) {
      if ((file.library && !file.path.includes("/vendor/")) || held.has(file.path) || !/\.m?js$/.test(file.path) || !isShell(file.content)) continue;
      const name = posix.basename(file.path);
      if (pages.some((p) => p.content.includes(name))) continue;
      tree.remove(file.path);
      removed.add(file.path);
      changed = true;
    }
    if (!changed) break;
    for (const file of code()) {
      const next = file.content.replace(BARE_IMPORT, (line, spec: string) => (removed.has(resolve(file.path, spec) ?? "") ? "" : line));
      if (next !== file.content) file.content = next.replace(/\n{3,}/g, "\n\n");
    }
  }
  if (!removed.size) return;
  for (const mod of modules) {
    if (mod.parts) mod.parts = mod.parts.filter((p) => !removed.has(p));
    if (mod.localPath && removed.has(mod.localPath)) mod.localPath = mod.parts?.[0] ?? null;
  }
  ctx.log.debug(`${count(removed.size, "import-only module")} dropped`);
}

function deminifySafe(ctx: Run, code: string, where: string): string {
  try {
    return deminifyCode(code);
  } catch (err) {
    ctx.report.warn({ stage: "deminify", url: where, message: `kept original: ${errorMessage(err)}` });
    return code;
  }
}

async function refine(ctx: Run, modules: ModuleRecord[], tree: OutputTree): Promise<number> {
  const { webcrack, rename } = ctx.options;
  if (!webcrack && !rename) return 0;
  const files = tree.all().filter((f) => f.renamable);
  const targets = [...modules.map((m) => ({ where: `module ${m.id}`, get: () => m.code, set: (c: string) => (m.code = c) })), ...files.map((f) => ({ where: f.path, get: () => f.content, set: (c: string) => (f.content = c) }))];
  const jobs = targets.map((target, id) => ({ id, code: target.get(), webcrack, rename }));
  const workers = ctx.options.workers || autoWorkers(jobs);
  ctx.log.debug(`${count(targets.length, "file")} on ${workers > 1 ? count(Math.min(workers, targets.length), "worker") : "the main thread"}`);
  const results = await refineAll(
    jobs,
    workers,
    (done) => done % 100 === 0 && ctx.log.debug(`${done}/${targets.length} files`),
  );
  let renamed = 0;
  results.forEach((result, i) => {
    const target = targets[i]!;
    target.set(result.code);
    renamed += result.renamed;
    for (const warning of result.warnings) ctx.report.warn({ stage: warning.stage, path: target.where, message: warning.message });
  });
  ctx.log.success(rename ? `restored ${count(renamed, "name")} in ${count(targets.length, "file")}` : `deminified ${count(targets.length, "file")}`);
  return renamed;
}

const PACKAGES: Record<string, { specifier: string; file: string; defaultName: string }> = {
  react: { specifier: "react", file: "react/index.js", defaultName: "React" },
  "jsx-runtime": { specifier: "react/jsx-runtime", file: "react/jsx-runtime.js", defaultName: "jsxRuntime" },
  "react-dom": { specifier: "react-dom", file: "react-dom/index.js", defaultName: "ReactDOM" },
};

const DEFAULT_IMPORTS: Record<string, string> = {
  "next/link": "Link",
  "next/image": "Image",
  "next/script": "Script",
  "next/head": "Head",
  "next/form": "Form",
  "next/dynamic": "dynamic",
};

interface Placed {
  modules: Manifest["modules"];
  missing: Coverage["missingModules"];
  libraryFunctions: Map<string, string>;
  libraryPackages: string[];
  libraryNamespaces: Map<string, string>;
  pageFiles: Set<string>;
  routeFiles: Map<string, string>;
}

function siteWords(url: URL): string[] {
  const parts = url.hostname.toLowerCase().split(".").slice(0, -1);
  return parts.filter((part) => part.length >= 4 && !/^(www|app|admin|api|static|cdn|assets|web|site|home|dev|test|stage|staging|beta|demo|xn--[a-z0-9-]+)$/.test(part));
}

const MONACO_WORKERS: Record<string, string> = { editor: "monaco-editor/esm/vs/editor/editor.worker", json: "monaco-editor/esm/vs/language/json/json.worker", css: "monaco-editor/esm/vs/language/css/css.worker", html: "monaco-editor/esm/vs/language/html/html.worker", ts: "monaco-editor/esm/vs/language/typescript/ts.worker" };

function monacoWorker(mod: ModuleRecord): ModuleRecord | null {
  const kind = /\/(editor|json|css|html|ts)\.worker[.-][\w-]+\.m?js$/.exec(mod.chunkUrl ?? "")?.[1];
  if (!kind || !/onUnexpectedError|microsoft\/monaco-editor/.test(mod.code)) return null;
  return { ...mod, origin: "library", package: { name: "monaco-editor", specifier: MONACO_WORKERS[kind]! } };
}

function splitBundle(ctx: Run, mod: ModuleRecord, fingerprints: FingerprintDb): ModuleRecord[] {
  const hoistedLabels = new Map<string, ReadonlyMap<string, HoistedLabel>>();
  const worker = monacoWorker(mod);
  if (worker) return [worker];
  if (mod.origin !== "bundle") return [mod];
  try {
    const parts = splitHoisted(
      mod,
      (code) => {
        const cached = hoistedLabels.get(code);
        if (cached) return cached;
        const print = printModule(code);
        const found = matchLocals([...print.locals, ...(print.shortLocals ?? [])], buildFunctionIndex(fingerprints));
        const labels = new Map([...found].map(([name, match]) => [name, { package: match.package, name: match.confidence >= 0.9 ? match.name : null }]));
        hoistedLabels.set(code, labels);
        return labels;
      },
      (name) => fingerprints.components?.get(name)?.package ?? null,
      siteWords(ctx.options.url),
    );
    if (!parts) return [mod];
    const packages = parts.flatMap((p) => (p.package ? [p.package.specifier] : []));
    ctx.log.success(`split ${mod.id} into ${count(parts.length, "module")}: ${packages.join(", ")}`);
    return parts;
  } catch (err) {
    ctx.report.warn({ stage: "modules", message: `module ${mod.id}: hoisted split failed: ${errorMessage(err)}` });
    return [mod];
  }
}

function placeModules(
  ctx: Run,
  adapter: BundlerAdapter,
  pages: Page[],
  assets: Map<string, Asset>,
  unpacked: Unpacked,
  layout: Layout,
  tree: OutputTree,
  fingerprints: FingerprintDb,
): Placed {
  const keyOf = (namespace: string, id: string) => `${namespace}\u0000${id}`;
  const unique = new Map<string, ModuleRecord>();
  const shape = (code: string) => code.replace(/\b[A-Za-z_$][\w$]?\b/g, "_");
  for (const mod of unpacked.modules) {
    const key = keyOf(mod.namespace, mod.id);
    const existing = unique.get(key);
    if (!existing) unique.set(key, mod);
    else if (shape(existing.code) !== shape(mod.code)) ctx.report.warn({ stage: "modules", message: `module ${mod.id} differs between ${existing.chunkUrl} and ${mod.chunkUrl}` });
  }
  const all = [...unique.values()];
  if (!all.length) return { modules: [], missing: [], libraryFunctions: new Map(), libraryPackages: [], libraryNamespaces: new Map(), pageFiles: new Set(), routeFiles: new Map() };

  for (const mod of all) {
    try {
      mod.code = normalizeExports(mod.code);
    } catch (err) {
      ctx.report.warn({ stage: "modules", message: `module ${mod.id}: ${errorMessage(err)}` });
    }
  }

  const framework = detectFramework(all.map((m) => m.code));
  const iconModules = new Map<string, { exported: Map<string, string>; source: string }>();
  const iconFactories = new Map<string, { package: string; file: string }>();
  for (const mod of all) {
    try {
      const icons = analyzeIcons(mod.code, framework);
      if (!icons) continue;
      for (const factory of icons.factories) iconFactories.set(keyOf(mod.namespace, factory.id), { package: factory.package, file: factory.file });
      if (icons.onlyIcons && icons.sources.size === 1) iconModules.set(keyOf(mod.namespace, mod.id), { exported: icons.exported, source: [...icons.sources][0]! });
      else mod.code = replaceIcons(mod.code, framework);
    } catch (err) {
      ctx.report.warn({ stage: "icons", message: `module ${mod.id}: ${errorMessage(err)}` });
    }
  }
  if (iconModules.size) {
    const sources = [...new Set([...iconModules.values()].map((m) => m.source))];
    ctx.log.success(`recognized ${count([...iconModules.values()].reduce((n, m) => n + m.exported.size, 0), "icon")} from ${sources.join(", ")}`);
  }

  const trivial = new Map(all.map((m) => [keyOf(m.namespace, m.id), trivialModule(m.code)]));
  const resolveAlias = (namespace: string, id: string): string => {
    let current = id;
    for (let hop = 0; hop < 10; hop++) {
      const kind = trivial.get(keyOf(namespace, current));
      if (kind?.kind !== "alias") break;
      current = kind.target;
    }
    return current;
  };
  const referenced = new Set<string>();
  const usedAsValue = new Set<string>();
  for (const mod of all) {
    if (trivial.get(keyOf(mod.namespace, mod.id))) continue;
    for (const dep of mod.deps) referenced.add(keyOf(mod.namespace, resolveAlias(mod.namespace, dep)));
    for (const id of valueReferences(mod.code)) usedAsValue.add(keyOf(mod.namespace, resolveAlias(mod.namespace, id)));
  }
  const dropped = (mod: ModuleRecord): string | null => {
    const icons = iconModules.get(keyOf(mod.namespace, mod.id));
    if (icons) return `icons: imported from "${icons.source}" where used`;
    const kind = trivial.get(keyOf(mod.namespace, mod.id));
    if (kind?.kind === "alias") return `alias of ${kind.target}`;
    if (kind?.kind === "stub") {
      const key = keyOf(mod.namespace, mod.id);
      if (!referenced.has(key)) return "entry stub";
      if (kind.targets.length === 0) return "empty module: inlined as {} where it was required";
      return usedAsValue.has(key) ? null : "only loads other modules: folded into its importers";
    }
    return null;
  };
  const stubTargets = (namespace: string, id: string, seen = new Set<string>()): string[] => {
    const resolved = resolveAlias(namespace, id);
    const key = keyOf(namespace, resolved);
    const kind = trivial.get(key);
    if (kind?.kind !== "stub" || usedAsValue.has(key)) return [resolved];
    if (seen.has(key)) return [];
    seen.add(key);
    return [...new Set(kind.targets.flatMap((target) => stubTargets(namespace, target, seen)))];
  };
  const modules = all.filter((m) => !dropped(m));

  const naming = identifyAndRename(modules, (m) => keyOf(m.namespace, m.id), fingerprints);
  const { identified, exportRenames, localRenames, libraryFunctions } = naming;
  for (const mod of modules) {
    if (!mod.package) continue;
    const key = keyOf(mod.namespace, mod.id);
    const { name, specifier } = mod.package;
    identified.set(key, { package: name, file: specifier === name ? "index.js" : `${specifier.slice(name.length + 1)}.js`, entry: true, specifier, confidence: 1 });
  }
  const usageNamed = new Set<string>();
  const usageTargets = new Map([...identified].map(([key, lib]) => [key, { id: key, package: lib.package }]));
  const byKeyForUsage = new Map(modules.map((m) => [keyOf(m.namespace, m.id), m]));
  for (const namespace of new Set(modules.map((m) => m.namespace))) {
    const targets = new Map([...usageTargets].filter(([key]) => byKeyForUsage.get(key)?.namespace === namespace).map(([key, v]) => [byKeyForUsage.get(key)!.id, v]));
    if (!targets.size) continue;
    const found = usageRenames(modules.filter((m) => m.namespace === namespace && !identified.has(keyOf(m.namespace, m.id))), targets, (id) => resolveAlias(namespace, id));
    for (const [id, renames] of found) {
      const key = keyOf(namespace, id);
      const target = byKeyForUsage.get(key)!;
      const existing = exportRenames.get(key) ?? new Map<string, string>();
      const fresh = new Map([...renames].filter(([from, to]) => !existing.has(from) && ![...existing.values()].includes(to)));
      if (!fresh.size) continue;
      try {
        target.code = renameExports(target.code, fresh);
        exportRenames.set(key, new Map([...existing, ...fresh]));
        for (const name of fresh.values()) usageNamed.add(`${key}\u0000${name}`);
      } catch (err) {
        ctx.report.warn({ stage: "fingerprint", message: `module ${id}: ${errorMessage(err)}` });
      }
    }
  }
  const byKey = new Map(modules.map((m) => [keyOf(m.namespace, m.id), m]));
  for (const [key, factory] of iconFactories) {
    const mod = byKey.get(key);
    const known = identified.get(key);
    if (!mod || (known && known.package !== factory.package) || (!known && (mod.origin === "app" || mod.origin === "bundle"))) continue;
    identified.set(key, { package: factory.package, file: factory.file, entry: false, confidence: known?.confidence ?? 0.9 });
  }
  for (const warning of naming.warnings) ctx.report.warn({ stage: "fingerprint", message: `module ${warning.module}: ${warning.message}` });
  if (identified.size || exportRenames.size || localRenames.size) {
    const packages = new Set([...identified.values()].map((i) => i.package));
    const total = (map: Map<string, Map<string, string>>) => [...map.values()].reduce((n, m) => n + m.size, 0);
    if (packages.size) ctx.log.success(`recognized libraries: ${[...packages].join(", ")}`);
    ctx.log.debug(`${identified.size} library modules, ${total(exportRenames)} exports and ${total(localRenames)} inlined functions renamed`);
  }

  for (const mod of modules) {
    if (identified.has(keyOf(mod.namespace, mod.id))) continue;
    try {
      mod.code = nameCryptoCode(mod.code);
    } catch (err) {
      ctx.report.warn({ stage: "crypto", message: `module ${mod.id}: ${errorMessage(err)}` });
    }
  }
  const hints = safe(ctx, "moduleHints", () => adapter.moduleHints?.({ pages, all: assets, fresh: [] }) ?? [], []);
  const routeModules = new Set(hints.filter((h) => h.weight >= 6).map((h) => h.id));
  const importers = new Map<string, Set<string>>();
  for (const mod of modules) {
    for (const dep of mod.deps) {
      const target = keyOf(mod.namespace, resolveAlias(mod.namespace, dep));
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target)!.add(keyOf(mod.namespace, mod.id));
    }
  }
  const appKeys = new Set(modules.filter((m) => routeModules.has(m.id) || m.origin === "app" || m.origin === "bundle").map((m) => keyOf(m.namespace, m.id)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const mod of modules) {
      const key = keyOf(mod.namespace, mod.id);
      const from = importers.get(key);
      if (identified.has(key) || mod.origin === "library" || appKeys.has(key) || !from?.size || ![...from].every((k) => appKeys.has(k))) continue;
      appKeys.add(key);
      grew = true;
    }
  }
  const looksLikeApp = (mod: ModuleRecord): boolean => appKeys.has(keyOf(mod.namespace, mod.id));

  const names = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const namespace of new Set(modules.map((m) => m.namespace))) {
    const own = modules
      .filter((m) => m.namespace === namespace && !identified.has(keyOf(m.namespace, m.id)))
      .sort((a, b) => Number(looksLikeApp(b)) - Number(looksLikeApp(a)));
    const ids = new Set(own.map((m) => m.id));
    const nsHints = hints.map((h) => ({ ...h, id: resolveAlias(namespace, h.id) })).filter((h) => ids.has(h.id));
    const nameHints = own.flatMap((m) => (m.nameHint ? [{ id: m.id, name: m.nameHint, weight: 9, reason: "unpacker" }] : []));
    const suggested = suggestModuleNames(own, [...nsHints, ...nameHints], usedNames, (id) => resolveAlias(namespace, id));
    for (const [id, name] of suggested) names.set(keyOf(namespace, id), name);
  }
  for (const mod of modules) {
    const key = keyOf(mod.namespace, mod.id);
    if (mod.origin !== "bundle") continue;
    const previous = names.get(key) ?? "module-";
    const base = mod.id.replace(/~.*$/, "").replace(/[.-][\w-]{8,}$/, "") || mod.id;
    if (/^chunk$/i.test(base) && !/^(module-|utils|constants|Component)/.test(previous)) continue;
    if (base === mod.id && isHashName(base)) continue;
    if (hints.some((h) => h.id === mod.id && h.weight >= 7)) continue;
    usedNames.delete(previous.toLowerCase());
    let name = base;
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    usedNames.add(name.toLowerCase());
    names.set(key, name);
  }
  for (const [key, library] of identified) {
    if (PACKAGES[names.get(key) ?? ""]) continue;
    names.set(key, library.specifier ?? `${library.package}/${library.file.replace(/\.[cm]?js$/, "")}`);
  }
  const ownerPackage = new Map<string, string>();
  for (const [key, library] of identified) ownerPackage.set(key, library.package);
  for (const [key, name] of names) {
    const pkg = PACKAGES[name];
    if (pkg) ownerPackage.set(key, pkg.specifier.replace(/\/.*$/, ""));
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const mod of modules) {
      const key = keyOf(mod.namespace, mod.id);
      if (ownerPackage.has(key) || looksLikeApp(mod)) continue;
      const owners = new Set([...(importers.get(key) ?? [])].map((k) => ownerPackage.get(k) ?? null));
      if (owners.size !== 1 || owners.has(null)) continue;
      ownerPackage.set(key, [...owners][0]!);
      grew = true;
    }
  }
  const groupOf = (mod: ModuleRecord): "app" | "library" => {
    if (identified.has(keyOf(mod.namespace, mod.id)) || PACKAGES[names.get(keyOf(mod.namespace, mod.id))!]) return "library";
    return looksLikeApp(mod) ? "app" : "library";
  };
  const pathOf = new Map<string, string>();
  const specifierOf = new Map<string, string>();
  const specifierCount = new Map<string, number>();
  for (const [key, library] of identified) if (library.specifier && byKey.get(key)?.package) specifierCount.set(library.specifier, (specifierCount.get(library.specifier) ?? 0) + 1);
  for (const mod of modules) {
    const key = keyOf(mod.namespace, mod.id);
    const pkg = PACKAGES[names.get(key)!];
    const library = identified.get(key);
    if (pkg) {
      pathOf.set(key, layout.packageFile(pkg.file));
      specifierOf.set(key, pkg.specifier);
    } else if (library?.specifier) {
      pathOf.set(key, layout.packageFile(library.specifier === library.package ? `${library.package}/index.js` : `${library.specifier}.js`));
      if (!byKey.get(key)?.package || (specifierCount.get(library.specifier) ?? 0) < 2) specifierOf.set(key, library.specifier);
    } else if (library) {
      pathOf.set(key, layout.packageFile(`${library.package}/${library.file.replace(/\.[cm]?js$/, "")}.js`));
    } else if (groupOf(mod) === "library" && ownerPackage.has(key)) {
      pathOf.set(key, layout.packageFile(`${ownerPackage.get(key)}/${safeSegment(names.get(key)!)}.js`));
    } else {
      pathOf.set(key, layout.module(groupOf(mod), names.get(key)!));
    }
  }
  const usedPaths = new Set<string>();
  for (const mod of modules) {
    const key = keyOf(mod.namespace, mod.id);
    const path = pathOf.get(key);
    if (!path || !path.startsWith(`${DIRS.libraries}/`)) continue;
    let next = path;
    for (let n = 2; usedPaths.has(next); n++) next = path.replace(/(\.[^./]+)$/, `~${n}$1`);
    usedPaths.add(next);
    pathOf.set(key, next);
  }
  for (const [key, icons] of iconModules) specifierOf.set(key, icons.source);
  const bareCandidates = new Map<string, string[]>();
  for (const pkg of new Set([...identified.values()].map((l) => l.package))) {
    for (const name of entryExports(fingerprints, pkg)) bareCandidates.set(name, [...(bareCandidates.get(name) ?? []), pkg]);
  }
  const defaultNames = new Map([...Object.values(PACKAGES).map((p) => [p.specifier, p.defaultName] as const), ...Object.entries(DEFAULT_IMPORTS)]);

  const out: Manifest["modules"] = [];
  const missing: Coverage["missingModules"] = [];
  for (const mod of all) {
    const key = keyOf(mod.namespace, mod.id);
    const reason = dropped(mod);
    if (reason) {
      out.push({ id: mod.id, namespace: mod.namespace, name: reason, group: "app", localPath: null, dropped: reason, chunkUrl: mod.chunkUrl, deps: mod.deps });
      continue;
    }
    const path = pathOf.get(key)!;
    const sideEffectsFor = (id: string): string[] | null => {
      const key = keyOf(mod.namespace, resolveAlias(mod.namespace, id));
      if (trivial.get(key)?.kind !== "stub" || usedAsValue.has(key)) return null;
      return stubTargets(mod.namespace, id).map((target) => moduleSpecifier(target));
    };
    const specifierFor = (id: string) => {
      const target = keyOf(mod.namespace, resolveAlias(mod.namespace, id));
      const found = specifierOf.get(target) ?? (pathOf.has(target) ? relativeImport(path, pathOf.get(target)!) : null);
      if (found) return found;
      const resolved = resolveAlias(mod.namespace, id);
      if (!missing.some((m) => m.module === path && m.missingId === resolved)) missing.push({ module: path, missingId: resolved, chunkUrl: mod.chunkUrl });
      return relativeImport(path, layout.missingModule(resolved));
    };
    const defaultNameFor = (specifier: string) => {
      if (defaultNames.has(specifier)) return defaultNames.get(specifier)!;
      const stem = specifier.replace(/^.*\//, "").replace(/\.js$/, "");
      return /^[A-Z]/.test(stem) ? stem : null;
    };
    let code = mod.code;
    try {
      code = finalizeModule(code, {
        specifierFor,
        moduleName: names.get(key),
        defaultNameFor,
        exportRenamesFor: (id) => {
          const target = keyOf(mod.namespace, resolveAlias(mod.namespace, id));
          return iconModules.get(target)?.exported ?? exportRenames.get(target);
        },
        sideEffectsFor,
        bareImport: (id, name) => {
          const target = keyOf(mod.namespace, resolveAlias(mod.namespace, id));
          if (!identified.has(target)) {
            const pkg = name !== "default" && name.length > 2 ? libraryFunctions.get(name) : undefined;
            if (!pkg || !entryExports(fingerprints, pkg).has(name)) return null;
            if (!pkg.startsWith("@vue/") && (naming.libraryPackages.get(pkg) ?? 0) < 3 && ![...identified.values()].some((l) => l.package === pkg)) return null;
            return pkg.startsWith("@vue/") ? "vue" : pkg;
          }
          if (name === "default") {
            const pkg = identified.get(target)!.package;
            return entryExports(fingerprints, pkg, true).has("default") && specifierOf.get(target) !== pkg ? pkg : null;
          }
          const forced = byKey.get(target)?.package;
          if (forced) {
            const pkg = forced.name.startsWith("@vue/") ? "vue" : forced.name;
            return specifierOf.get(target) !== pkg && entryExports(fingerprints, pkg).has(name) ? pkg : null;
          }
          const owners = bareCandidates.get(name);
          const own = identified.get(target)!.package;
          if ((owners?.includes(own) || (!owners && usageNamed.has(`${target}\u0000${name}`))) && own !== specifierOf.get(target)) return own;
          return owners && owners.length === 1 && owners[0] !== specifierOf.get(target) ? owners[0]! : null;
        },
        isEmptyModule: (id) => {
          const kind = trivial.get(keyOf(mod.namespace, resolveAlias(mod.namespace, id)));
          return kind?.kind === "stub" && kind.targets.length === 0;
        },
      });
    } catch (err) {
      ctx.report.warn({ stage: "modules", message: `module ${mod.id}: ${errorMessage(err)}` });
    }
    const file = tree.add({ path, content: code, kind: "module", renamable: false, library: groupOf(mod) === "library" });
    const library = identified.get(key);
    const renamed = exportRenames.get(key) || localRenames.get(key) ? { ...Object.fromEntries(exportRenames.get(key) ?? []), ...Object.fromEntries(localRenames.get(key) ?? []) } : undefined;
    out.push({
      id: mod.id,
      namespace: mod.namespace,
      name: names.get(key)!,
      group: groupOf(mod),
      localPath: file.path,
      ...(library ? { identifiedAs: { package: library.package, file: library.file, confidence: library.confidence } } : {}),
      ...(renamed ? { renamedExports: renamed } : {}),
      chunkUrl: mod.chunkUrl,
      deps: mod.deps,
    });
  }
  writeMissingStubs(missing, layout, tree);
  if (missing.length) ctx.log.warn(`${count(new Set(missing.map((m) => m.missingId)).size, "module")} imported but not loaded (stubs in _chunks/_missing/)`);
  const written = out.filter((m) => m.localPath);
  const app = written.filter((m) => m.group === "app").length;
  ctx.log.debug(`${count(written.length, "module")}: ${app} app, ${written.length - app} library`);
  const pageFiles = new Set(out.filter((m) => m.localPath && m.group === "app" && routeModules.has(m.id)).map((m) => m.localPath!));
  const routeFiles = new Map<string, string>();
  for (const hint of hints) {
    if (hint.file === undefined) continue;
    const mod = out.find((m) => m.id === hint.id && m.localPath && pageFiles.has(m.localPath));
    if (mod && !routeFiles.has(mod.localPath!)) routeFiles.set(mod.localPath!, hint.file);
  }
  const foreign = framework === "vue" ? /(^|\/)(react|react-dom|preact|solid-js|svelte|@angular|alpinejs|framer-motion|@iconify\/react|lucide-react|@tabler\/icons-react|@radix-ui\/react)|react$/ : framework === "react" ? /^(vue|@vue\/|pinia|vue-router|alpinejs|@iconify\/vue|lucide-vue-next|svelte)/ : null;
  const libraryPackages = [...naming.libraryPackages].filter(([pkg, n]) => n >= 3 && !(foreign?.test(pkg) && ![...identified.values()].some((l) => l.package === pkg))).map(([pkg]) => pkg);
  return { modules: out, missing, libraryFunctions, libraryPackages, libraryNamespaces: naming.namespaces, pageFiles, routeFiles };
}

function organize(ctx: Run, tree: OutputTree, modules: Manifest["modules"], pageFiles: Set<string>, libraryFunctions: Map<string, string>, missing: Coverage["missingModules"], components?: ReadonlyMap<string, LibraryComponent>, routeFiles?: ReadonlyMap<string, string>, autoImports = false, bareFunctions?: ReadonlyMap<string, string>, namespaces?: ReadonlyMap<string, string>, stringOwner?: (value: string) => string | null): Map<string, Map<string, Set<string>>> {
  const result = safe(ctx, "organize", () => organizeModules(tree, modules, pageFiles, libraryFunctions, components, routeFiles, autoImports, bareFunctions, namespaces, stringOwner), null);
  if (!result?.split) return result?.packageRoles ?? new Map();
  const contents = new Map(tree.all().map((f) => [f.path, f.content]));
  for (const entry of missing) {
    const moved = result.moved.get(entry.module);
    const holder = moved?.parts.find((part) => contents.get(part)?.includes(`_missing/module-${safeSegment(entry.missingId)}.js`));
    if (holder) entry.module = holder;
  }
  for (const mod of modules) {
    const moved = mod.localPath ? result.moved.get(mod.localPath) : undefined;
    if (!moved) continue;
    mod.localPath = moved.primary;
    mod.parts = moved.parts;
    if (Object.keys(moved.exports).length) mod.exports = moved.exports;
  }
  ctx.log.debug(`${count(result.split, "app module")} split into ${count(result.files, "file")}`);
  return result.packageRoles;
}

function isHashName(name: string): boolean {
  if (!/^[A-Za-z0-9_-]{8,12}$/.test(name)) return false;
  if (name.length === 8) return /[\d_-]/.test(name) || (/[A-Z]/.test(name) && /[a-z]/.test(name));
  return !/^[A-Z]?[a-z]+(?:[A-Z][a-z]+)*$/.test(name) && (/\d/.test(name) || (/[A-Z]/.test(name) && /[a-z]/.test(name)));
}

function valueReferences(code: string): string[] {
  const ids: string[] = [];
  const idOf = (spec: string) => /^\.\/(.+)\.js$/.exec(spec)?.[1];
  for (const match of code.matchAll(/import\s+[^"';]+?\s+from\s*["']([^"']+)["']/g)) {
    const id = idOf(match[1]!);
    if (id) ids.push(id);
  }
  for (const match of code.matchAll(/(?<![;{}\n]\s*)(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) {
    const id = idOf(match[1]!);
    if (id) ids.push(id);
  }
  for (const match of code.matchAll(/export\s+(?:\*|\{[^}]*\})\s+from\s*["']([^"']+)["']/g)) {
    const id = idOf(match[1]!);
    if (id) ids.push(id);
  }
  return ids;
}

function writeMissingStubs(missing: Coverage["missingModules"], layout: Layout, tree: OutputTree): void {
  if (!missing.length) return;
  const byId = new Map<string, string[]>();
  for (const m of missing) byId.set(m.missingId, [...(byId.get(m.missingId) ?? []), m.module]);
  for (const [id, users] of byId) {
    const message = `unbundle: module ${id} was imported by ${users.join(", ")} but its chunk was not loaded; see .unbundle/manifest.json#coverage`;
    tree.add({ path: layout.missingModule(id), content: `throw new Error(${JSON.stringify(message)});\n`, kind: "module", renamable: false });
  }
  const lines = [...byId].map(([id, users]) => `- module ${id}: imported by ${users.map((u) => `\`${u}\``).join(", ")}`);
  tree.add({
    path: layout.missingModule("README.md"),
    content: `# Modules that were referenced but not recovered\n\nTheir chunks were never loaded, so the code is incomplete here. Details: \`.unbundle/manifest.json\` -> \`coverage.missingModules\`.\n\n${lines.join("\n")}\n`,
    kind: "data",
    renamable: false,
  });
}

async function formatAll(ctx: Run, tree: OutputTree): Promise<void> {
  if (!ctx.options.format) return;
  const files = tree.all().filter((f) => f.kind !== "raw" && !f.noFormat && parserFor(f.path) && !(f.kind === "source" && /(^|\/)(node_modules|vendor)\//.test(f.path)));
  let failed = 0;
  for (const file of files) {
    try {
      file.content = await formatContent(file.path, file.content);
    } catch (err) {
      failed++;
      ctx.report.warn({ stage: "format", path: file.path, message: errorMessage(err).split("\n")[0]! });
    }
  }
  ctx.log.debug(`${count(files.length - failed, "file")} formatted${failed ? `, ${failed} left as-is` : ""}`);
}

function coverageReport(
  ctx: Run,
  adapter: BundlerAdapter,
  discover: DiscoverContext,
  tree: OutputTree,
  entries: FileEntry[],
  missingModules: Coverage["missingModules"],
  scope: string,
  knownStrings: Set<string>,
  libraryFunctions: Map<string, string>,
): Coverage {
  const origin = discover.pages[0]!.url;
  const known = new Set<string>();
  for (const asset of discover.all.values()) {
    known.add(asset.ref.url);
    known.add(asset.finalUrl);
  }
  for (const entry of entries) known.add(entry.url);

  const unresolvedLoaders: LoaderFinding[] = [];
  const libraryLoaders: LoaderFinding[] = [];
  const seenButNotLoaded: Coverage["seenButNotLoaded"] = [];
  const seenUrls = new Set<string>();
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || file.path.includes("/_missing/")) continue;
    const scan = scanLoaders(file.path, file.content);
    for (const finding of scan.loaders) {
      const known = (finding.regionStrings ?? []).filter((s) => knownStrings.has(s)).length;
      const { regionStrings: _, regionName, ...clean } = finding;
      const inLibrary = file.library || known >= 2 || (regionName !== undefined && libraryFunctions.has(regionName));
      (inLibrary ? libraryLoaders : unresolvedLoaders).push(clean);
    }
    if (file.library) continue;
    for (const seen of scan.urls) {
      const url = resolveHttpUrl(seen.value, origin);
      if (!url || known.has(url.href) || seenUrls.has(url.href)) continue;
      if (!inScope(url, origin, scope) && !adapter.ownsUrl?.(url, discover.pages[0]!)) continue;
      seenUrls.add(url.href);
      seenButNotLoaded.push({ url: url.href, file: seen.file, line: seen.line });
    }
  }
  const unfetchedChunkIds = safe(ctx, "coverage", () => adapter.coverage?.(discover).unfetchedChunkIds ?? [], []);
  const failedResources = entries.filter((e) => e.status === "failed" && e.type !== "document").map((e) => e.url);
  const incomplete = unresolvedLoaders.length + missingModules.length + unfetchedChunkIds.length + seenButNotLoaded.length + failedResources.length > 0;
  return {
    status: incomplete ? "possibly-incomplete" : "complete",
    unresolvedLoaders,
    libraryLoaders: libraryLoaders.slice(0, 50),
    missingModules,
    unfetchedChunkIds,
    seenButNotLoaded,
    failedResources,
  };
}

function measureQuality(tree: OutputTree, modules: Manifest["modules"], files: FileEntry[], inlinedPackages: string[]): Quality {
  const written = modules.filter((m) => m.localPath);
  const ratio = (a: number, b: number) => (b ? Number((a / b).toFixed(3)) : 0);
  const mangled = { app: { total: 0, mangled: 0 }, library: { total: 0, mangled: 0 } };
  const boilerplate = { defineExports: 0, exportsAssignments: 0, requireCalls: 0, indirectCalls: 0 };
  const hasModules = tree.all().some((f) => f.kind === "module");
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || file.path.includes("/_missing/")) continue;
    const counts = mangledRatio(file.content, file.path);
    const library = file.library || /(^|\/)(node_modules|vendor)\//.test(file.path) || (file.kind === "script" && hasModules);
    const bucket = library ? mangled.library : mangled.app;
    bucket.total += counts.total;
    bucket.mangled += counts.mangled;
    const found = boilerplateCounts(file.content);
    for (const key of Object.keys(boilerplate) as Array<keyof typeof boilerplate>) boilerplate[key] += found[key];
  }
  return {
    readableModuleNames: ratio(written.filter((m) => !m.name.startsWith("module-")).length, written.length),
    mangledIdentifiers: { app: ratio(mangled.app.mangled, mangled.app.total), library: ratio(mangled.library.mangled, mangled.library.total) },
    boilerplate,
    identifiedPackages: [...new Set([...modules.flatMap((m) => (m.identifiedAs ? [m.identifiedAs.package] : [])), ...inlinedPackages])].sort(),
    degradedChunks: files.filter((f) => f.parse === "partial" || f.parse === "raw").length,
  };
}

function collectStrings(tree: OutputTree): StringsIndex {
  const collector = new StringCollector();
  for (const file of tree.all()) {
    if (file.kind === "raw" || file.kind === "page" || file.kind === "style" || file.kind === "data") continue;
    if (file.kind === "source" && /(^|\/)(node_modules|vendor)\//.test(file.path)) continue;
    if (/\.(m?js|cjs|jsx|tsx?)$/i.test(file.path)) collector.addCode(file.path, file.content);
    else if (file.path.endsWith(".vue")) {
      const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(file.content)?.[1];
      if (script) collector.addCode(file.path, script);
    }
  }
  return collector.build();
}
