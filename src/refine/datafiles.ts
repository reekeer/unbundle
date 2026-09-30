import { posix } from "node:path";
import type { OutputFile } from "../types.ts";
import { literalKey, parseProgram, t } from "../unpack/ast.ts";

type Kind = "grammar" | "theme";

function keys(object: t.ObjectExpression): Map<string, t.Node> {
  return new Map(object.properties.flatMap((p) => (t.isObjectProperty(p) ? [[literalKey(p.key) ?? "", p.value] as const] : [])));
}

function frozenObject(node: t.Node | null | undefined): t.ObjectExpression | null {
  if (t.isObjectExpression(node)) return node;
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.object, { name: "Object" }) && literalKey(node.callee.property) === "freeze" && t.isObjectExpression(node.arguments[0])) return node.arguments[0];
  return null;
}

function classify(object: t.ObjectExpression): { kind: Kind; name: string } | null {
  const map = keys(object);
  const name = map.get("name");
  if (!t.isStringLiteral(name) || !/^[\w.-]+$/.test(name.value)) return null;
  if (t.isStringLiteral(map.get("scopeName")) && (t.isArrayExpression(map.get("patterns")) || t.isObjectExpression(map.get("repository")))) return { kind: "grammar", name: name.value };
  if (t.isArrayExpression(map.get("tokenColors")) && t.isObjectExpression(map.get("colors")) && t.isStringLiteral(map.get("type"))) return { kind: "theme", name: name.value };
  return null;
}

function dataModule(file: OutputFile): { kind: Kind; name: string } | null {
  if (!/\.m?js$/.test(file.path) || !file.content.includes("Object.freeze") && !file.content.includes("tokenColors")) return null;
  let ast: t.File;
  try {
    ast = parseProgram(file.content);
  } catch {
    return null;
  }
  const found: Array<{ kind: Kind; name: string }> = [];
  let other = false;
  for (const stmt of ast.program.body) {
    if (t.isImportDeclaration(stmt) || t.isExportDefaultDeclaration(stmt) || (t.isExportNamedDeclaration(stmt) && !stmt.declaration)) continue;
    const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
    if (!t.isVariableDeclaration(decl)) {
      other = true;
      continue;
    }
    for (const d of decl.declarations) {
      const object = frozenObject(d.init);
      const kind = object ? classify(object) : null;
      if (kind) found.push(kind);
      else if (!t.isArrayExpression(d.init)) other = true;
    }
  }
  return !other && found.length ? found.at(-1)! : null;
}

function inlineWasm(file: OutputFile): boolean {
  return /\.m?js$/.test(file.path) && /atob\(\s*["'`]AGFzbQ/.test(file.content) && /WebAssembly\.instantiate/.test(file.content);
}

export function libraryDataModules(files: OutputFile[]): Map<string, string> {
  const moves = new Map<string, string>();
  const taken = new Set<string>();
  const place = (path: string, target: string) => {
    let next = target;
    const ext = posix.extname(target);
    for (let n = 2; taken.has(next); n++) next = `${target.slice(0, -ext.length)}-${n}${ext}`;
    taken.add(next);
    moves.set(path, next);
  };
  for (const file of files) {
    if ((file.kind !== "module" && file.kind !== "script") || file.path.startsWith("vendor/") || /(^|\/)node_modules\//.test(file.path)) continue;
    const found = dataModule(file);
    if (found) place(file.path, `vendor/@shikijs/${found.kind === "grammar" ? "langs" : "themes"}/${found.name}.js`);
  }
  if (moves.size) for (const file of files) if ((file.kind === "module" || file.kind === "script") && inlineWasm(file) && !moves.has(file.path)) place(file.path, "vendor/@shikijs/engine-oniguruma/wasm-inlined.js");
  return moves;
}

const SUFFIXES = ["", ".js", ".mjs", ".ts", ".vue", "/index.js"];

function packageOf(path: string): string | null {
  const rest = path.startsWith("js/node_modules/") ? path.slice("js/node_modules/".length) : path.startsWith("vendor/") ? path.slice("vendor/".length) : null;
  if (!rest) return null;
  const parts = rest.split("/");
  return rest.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

export function adoptLibraryModules(files: OutputFile[], planned: ReadonlyMap<string, string>): Map<string, string> {
  const code = files.filter((f) => (f.kind === "module" || f.kind === "script") && /\.(m?jsx?|tsx?|vue)$/.test(f.path));
  const paths = new Set(code.map((f) => f.path));
  const resolve = (from: string, spec: string) => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec.replace(/[?#].*$/, "")));
    for (const suffix of SUFFIXES) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
  const importers = new Map<string, Set<string>>();
  for (const file of code) {
    for (const match of file.content.matchAll(/\bfrom\s*["'](\.[^"']+)["']|\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const target = resolve(file.path, match[1] ?? match[2]!);
      if (!target || target === file.path) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target)!.add(file.path);
    }
  }
  const owner = new Map<string, string>();
  for (const [from, to] of planned) {
    const pkg = packageOf(to);
    if (pkg) owner.set(from, pkg);
  }
  const moves = new Map<string, string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const file of code) {
      if (owner.has(file.path) || packageOf(file.path) || file.library || !/^js\/[^/]+\.m?js$/.test(file.path) || /^js\/app\.config\.m?js$/.test(file.path)) continue;
      const users = [...(importers.get(file.path) ?? [])];
      if (!users.length) continue;
      const packages = users.map((u) => owner.get(u) ?? packageOf(u));
      if (packages.some((p) => p === null)) continue;
      const votes = new Map<string, number>();
      for (const [i, p] of packages.entries()) votes.set(p!, (votes.get(p!) ?? 0) + (/\/chunk(-\d+)?\.js$/.test(users[i]!) ? 0.5 : 1));
      const pkg = [...votes].sort((a, b) => b[1] - a[1])[0]![0];
      owner.set(file.path, pkg);
      moves.set(file.path, `vendor/${pkg}/${posix.basename(file.path)}`);
      grew = true;
    }
  }
  return moves;
}
