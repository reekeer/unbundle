import { posix } from "node:path";
import { literalKey, parseForFile, t } from "../unpack/ast.ts";
import type { Issue, OutputFile } from "../types.ts";
import { stringArray } from "./angular.ts";
import { ivyInstruction } from "./ivy-instructions.ts";

interface ExportTarget {
  source?: string;
  name: string;
}

interface Module {
  imports: Map<string, ExportTarget>;
  exports: Map<string, ExportTarget>;
  stars: string[];
  arrays: Map<string, string[]>;
  functions: Map<string, t.FunctionDeclaration>;
  ast: t.File | null;
}

const CODE = /\.[cm]?[jt]sx?$/;
const SUFFIXES = ["", ".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json", "/index.ts", "/index.js", "/index.tsx", "/index.jsx"];

export class ModuleGraph {
  private readonly files: Map<string, OutputFile>;
  private readonly modules = new Map<string, Module>();
  private readonly root: string;

  constructor(files: OutputFile[]) {
    this.files = new Map(files.map((file) => [file.path, file]));
    this.root = files.some((file) => file.path.startsWith("app/")) ? "app" : "src";
  }

  private base(from: string, source: string): string | null {
    const spec = source.replace(/[?#].*$/, "");
    if (spec.startsWith("@/") || spec.startsWith("~/")) return posix.join(this.root, spec.slice(2));
    if (spec.startsWith("~~/")) return posix.normalize(spec.slice(3));
    if (spec.startsWith("@vendor/")) return posix.join("vendor", spec.slice(8));
    return /^\.{1,2}\//.test(spec) ? posix.join(posix.dirname(from), spec) : null;
  }

  private resolve(base: string): string | null {
    for (const suffix of SUFFIXES) if (this.files.has(base + suffix)) return base + suffix;
    if (base.endsWith(".js")) {
      const stem = base.slice(0, -3);
      for (const suffix of [".ts", ".tsx", ".jsx"]) if (this.files.has(stem + suffix)) return stem + suffix;
    }
    return null;
  }

  private read(path: string): Module | null {
    const cached = this.modules.get(path);
    if (cached) return cached;
    const file = this.files.get(path);
    if (!file) return null;
    const vue = path.endsWith(".vue");
    if (!vue && !CODE.test(path)) return null;
    const mod: Module = { imports: new Map(), exports: new Map(), stars: [], arrays: new Map(), functions: new Map(), ast: null };
    this.modules.set(path, mod);
    if (vue) mod.exports.set("default", { name: "default" });
    const script = vue ? /<script\b[^>]*>([\s\S]*?)<\/script\s*>/i.exec(file.content)?.[1] ?? "" : file.content;
    mod.ast = parseForFile(vue ? "component.tsx" : path, script);
    for (const stmt of mod.ast.program.body) {
      const declaration = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
      if (t.isFunctionDeclaration(declaration) && declaration.id && /^vendor\/@angular\/core\//.test(path)) mod.functions.set(declaration.id.name, declaration);
      if (t.isVariableDeclaration(declaration)) for (const d of declaration.declarations) {
        const values = stringArray(d.init);
        if (t.isIdentifier(d.id) && values) mod.arrays.set(d.id.name, values);
      }
      if (t.isImportDeclaration(stmt)) {
        for (const spec of stmt.specifiers) {
          const name = t.isImportSpecifier(spec) ? literalKey(spec.imported)! : t.isImportDefaultSpecifier(spec) ? "default" : "*";
          mod.imports.set(spec.local.name, { source: stmt.source.value, name });
        }
      } else if (t.isExportAllDeclaration(stmt)) mod.stars.push(stmt.source.value);
      else if (t.isExportDefaultDeclaration(stmt)) mod.exports.set("default", { name: t.isIdentifier(stmt.declaration) ? stmt.declaration.name : "default" });
      else if (t.isExportNamedDeclaration(stmt)) {
        for (const spec of stmt.specifiers) {
          const name = literalKey(spec.exported)!;
          const local = t.isExportSpecifier(spec) ? literalKey(spec.local)! : t.isExportNamespaceSpecifier(spec) ? "*" : "default";
          mod.exports.set(name, { source: stmt.source?.value, name: local });
        }
        if (stmt.declaration) for (const name of Object.keys(t.getOuterBindingIdentifiers(stmt.declaration))) mod.exports.set(name, { name });
      }
    }
    return mod;
  }

  private resolveExport<T>(from: string, source: string, name: string, seen: Set<string>, binding: (path: string, name: string, mod: Module | null) => T | undefined): T | undefined {
    if (source === "@angular/core") return binding(source, name, null);
    const base = this.base(from, source);
    const target = base ? this.resolve(base) : null;
    if (!target) return;
    const key = `${target}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const mod = this.read(target);
    const ref = mod?.exports.get(name);
    const imported = ref?.source ? ref : ref && mod?.imports.get(ref.name);
    if (imported?.source) return this.resolveExport(target, imported.source, imported.name, seen, binding);
    if (ref) return binding(target, ref.name, mod);
    if (name === "default") return;
    const matches = new Set(mod?.stars.map((star) => this.resolveExport(target, star, name, new Set(seen), binding)).filter((match) => match !== undefined));
    return matches.size === 1 ? [...matches][0] : undefined;
  }

  angularImports(path: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const [local, ref] of this.read(path)?.imports ?? []) {
      const resolved = this.resolveExport(path, ref.source!, ref.name, new Set(), (target, name, mod) => {
        if (target !== "@angular/core" && !/^vendor\/@angular\/core\//.test(target)) return;
        if (/^ɵɵ/.test(name)) return name;
        if (mod) return ivyInstruction(name, mod.functions);
      });
      if (resolved) result.set(local, resolved);
    }
    return result;
  }

  projectionSelectors(path: string, name: string): readonly string[] | undefined {
    const ref = this.read(path)?.imports.get(name);
    if (ref?.source) return this.resolveExport(path, ref.source, ref.name, new Set(), (_target, local, mod) => mod?.arrays.get(local));
  }

  issues(): Issue[] {
    const result: Issue[] = [];
    for (const file of this.files.values()) {
      if (file.kind !== "module" && file.kind !== "script") continue;
      const report = (message: string) => result.push({ stage: "output", path: file.path, message });
      let mod: Module | null;
      try {
        mod = this.read(file.path);
      } catch (err) {
        report(err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!mod?.ast) continue;
      for (const err of (mod.ast as t.File & { errors?: Error[] }).errors ?? []) report(err.message);
      const check = (source: string, names: string[]) => {
        const base = this.base(file.path, source);
        if (!base) return;
        const target = this.resolve(base);
        if (!target) {
          report(`unresolved local import ${source}`);
          return;
        }
        let imported: Module | null;
        try {
          imported = this.read(target);
        } catch {
          return;
        }
        if (!imported?.ast || imported.stars.length || /\b(?:module\.exports|exports\.[\w$]+)\s*=/.test(this.files.get(target)!.content)) return;
        for (const name of names) if (name !== "*" && !imported.exports.has(name)) report(`${source} has no export ${name}`);
      };
      const sources = new Map<string, Set<string>>();
      for (const { source, name } of [...mod.imports.values(), ...mod.exports.values()]) {
        if (!source) continue;
        const names = sources.get(source) ?? new Set<string>();
        names.add(name);
        sources.set(source, names);
      }
      for (const stmt of mod.ast.program.body) {
        if ((t.isImportDeclaration(stmt) || t.isExportAllDeclaration(stmt)) && !sources.has(stmt.source.value)) sources.set(stmt.source.value, new Set());
      }
      t.traverseFast(mod.ast.program, (node) => {
        const source = t.isImportExpression(node) ? node.source : t.isCallExpression(node) && t.isImport(node.callee) ? node.arguments[0] : null;
        if (t.isStringLiteral(source) && !sources.has(source.value)) sources.set(source.value, new Set());
      });
      for (const [source, names] of sources) check(source, [...names]);
    }
    return result;
  }
}
