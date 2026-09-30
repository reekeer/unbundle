import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createLogger } from "../../src/log.ts";
import { run, type RunResult } from "../../src/pipeline.ts";
import { parseProgram, t } from "../../src/unpack/ast.ts";
import type { Manifest, Options } from "../../src/types.ts";

const created: string[] = [];

export async function removeRuns(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function runOn(url: string, overrides: Partial<Options> = {}): Promise<RunResult> {
  const outDir = await mkdtemp(join(tmpdir(), "unbundle-test-"));
  created.push(outDir);
  return run(
    {
      url: new URL(url),
      outDir,
      sourceMaps: true,
      rename: true,
      webcrack: true,
      format: true,
      concurrency: 6,
      workers: 0,
      retries: 0,
      timeoutMs: 10_000,
      maxBytes: 50 * 1024 * 1024,
      maxPages: 20,
      crawlDepth: 2,
      includeExternal: false,
      ...overrides,
    },
    createLogger("silent"),
  );
}

export function read(outDir: string, path: string): Promise<string> {
  return Bun.file(join(outDir, path)).text();
}

export function exists(outDir: string, path: string): Promise<boolean> {
  return Bun.file(join(outDir, path)).exists();
}

export function modulePath(manifest: Manifest, name: string): string {
  const mod = manifest.modules.find((m) => m.name === name);
  if (!mod) throw new Error(`module ${name} not found; have: ${manifest.modules.map((m) => m.name).filter((n) => !n.startsWith("module-")).join(", ")}`);
  if (!mod.localPath) throw new Error(`module ${name} was folded: ${mod.dropped}`);
  return mod.localPath;
}

const RESOLVE_SUFFIXES = ["", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".vue", "/index.js", "/index.jsx", "/index.ts", "/index.tsx"];

function scriptOf(path: string, content: string): string {
  if (!path.endsWith(".vue")) return content;
  return /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(content)?.[1] ?? "";
}

function exportedNames(path: string, content: string): Set<string> | null {
  if (path.endsWith(".vue")) return new Set(["default"]);
  if (/module\.exports\s*=|\bexports\.\w+\s*=/.test(content)) return null;
  const names = new Set<string>();
  for (const stmt of parseProgram(content).program.body) {
    if (t.isExportAllDeclaration(stmt)) return null;
    if (t.isExportDefaultDeclaration(stmt)) names.add("default");
    if (!t.isExportNamedDeclaration(stmt)) continue;
    for (const spec of stmt.specifiers) names.add(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value);
    const decl = stmt.declaration;
    if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) names.add(decl.id.name);
    if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) for (const name of Object.keys(t.getBindingIdentifiers(d.id))) names.add(name);
  }
  return names;
}

export async function brokenImports(outDir: string): Promise<string[]> {
  const files = new Map<string, string>();
  for await (const path of new Bun.Glob("**/*.{js,jsx,mjs,ts,tsx,vue}").scan({ cwd: outDir })) if (!path.startsWith("html/") && !path.endsWith(".d.ts")) files.set(path, await Bun.file(join(outDir, path)).text());
  const exported = new Map<string, Set<string> | null>();
  const broken: string[] = [];
  for (const [path, content] of files) {
    const ast = parseProgram(scriptOf(path, content));
    for (const error of (ast as { errors?: Array<{ message: string }> }).errors ?? []) broken.push(`${path}: ${error.message}`);
    const srcDir = [...files.keys()].some((p) => p.startsWith("app/")) ? "app" : "src";
    const check = (specifier: string, names: string[]) => {
      const aliased = specifier.startsWith("@/") || specifier.startsWith("~/") ? posix.join(srcDir, specifier.slice(2)) : specifier.startsWith("~~/") ? specifier.slice(3) : specifier.startsWith("@vendor/") ? posix.join("vendor", specifier.slice(8)) : null;
      if (!aliased && !specifier.startsWith(".")) return;
      const base = aliased ? posix.normalize(aliased) : posix.normalize(posix.join(posix.dirname(path), specifier));
      const target = RESOLVE_SUFFIXES.map((suffix) => base + suffix).find((candidate) => files.has(candidate));
      if (!target) {
        broken.push(`${path}: ${specifier} not found`);
        return;
      }
      if (!exported.has(target)) exported.set(target, exportedNames(target, files.get(target)!));
      const available = exported.get(target);
      for (const name of names) if (available && !available.has(name)) broken.push(`${path}: ${specifier} has no export ${name}`);
    };
    for (const stmt of ast.program.body) {
      if (t.isImportDeclaration(stmt)) check(stmt.source.value, stmt.specifiers.flatMap((s) => (t.isImportNamespaceSpecifier(s) ? [] : [t.isImportDefaultSpecifier(s) ? "default" : t.isIdentifier(s.imported) ? s.imported.name : s.imported.value])));
      if (t.isExportNamedDeclaration(stmt) && stmt.source) check(stmt.source.value, stmt.specifiers.flatMap((s) => (t.isExportSpecifier(s) ? [s.local.name] : [])));
    }
  }
  return broken;
}

const TSC = join(import.meta.dir, "../../node_modules/typescript/bin/tsc");

export async function unresolvedModules(outDir: string): Promise<string[]> {
  const config = (await Bun.file(join(outDir, "tsconfig.json")).exists()) ? "tsconfig.json" : "jsconfig.json";
  const result = Bun.spawnSync(["bun", TSC, "-p", join(outDir, config), "--noEmit", "--checkJs", "--pretty", "false"], { cwd: outDir });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  return output.split("\n").filter((line) => /error TS2307: Cannot find module '(\.\.?\/|@\/|~~?\/|@vendor\/)/.test(line));
}
