import { posix } from "node:path";
import type { OutputFile } from "../types.ts";
import { literalKey, parseProgram, print, t } from "../unpack/ast.ts";

interface Route {
  name: string | null;
  own: string;
  path: string;
  target: string | null;
  meta: t.ObjectProperty[];
  children: Route[];
}

export interface NuxtPages {
  moves: Map<string, string>;
  meta: Map<string, string>;
}

const META_KEYS = /^(layout|middleware|pageTransition|layoutTransition|keepalive|alias|redirect|scrollToTop|colorMode|key)$/;

function stringValue(node: t.Node | null | undefined): string | null {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && !node.expressions.length) return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function property(object: t.ObjectExpression, key: string): t.ObjectProperty | undefined {
  return object.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === key);
}

function isRecord(node: t.Node | null | undefined): node is t.ObjectExpression {
  if (!t.isObjectExpression(node) || stringValue(property(node, "path")?.value) === null) return false;
  return !!property(node, "component") || !!property(node, "children");
}

function importTarget(node: t.Node | undefined, from: string): string | null {
  let found: string | null = null;
  if (!node) return null;
  t.traverseFast(node, (n) => {
    if (found || !t.isCallExpression(n) || !t.isImport(n.callee)) return;
    const value = stringValue(n.arguments[0]);
    if (value?.startsWith(".")) found = posix.normalize(posix.join(posix.dirname(from), value));
  });
  return found;
}

class Resolver {
  private readonly asts = new Map<string, t.File | null>();

  constructor(private readonly files: Map<string, OutputFile>) {}

  ast(path: string): t.File | null {
    if (this.asts.has(path)) return this.asts.get(path)!;
    const file = this.files.get(path) ?? this.files.get(`${path}.js`) ?? this.files.get(`${path}.ts`);
    let ast: t.File | null = null;
    if (file && /\.(m?[jt]sx?)$/.test(file.path)) {
      try {
        ast = parseProgram(file.content);
      } catch {
        ast = null;
      }
    }
    this.asts.set(path, ast);
    return ast;
  }

  file(path: string): string | null {
    for (const candidate of [path, `${path}.js`, `${path}.ts`]) if (this.files.has(candidate)) return candidate;
    return null;
  }

  object(name: string, from: string, depth = 0): t.ObjectExpression | null {
    if (depth > 4) return null;
    const ast = this.ast(from);
    if (!ast) return null;
    for (const stmt of ast.program.body) {
      const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
      if (t.isVariableDeclaration(decl)) {
        for (const d of decl.declarations) if (t.isIdentifier(d.id, { name }) && t.isObjectExpression(d.init)) return d.init;
      }
    }
    for (const stmt of ast.program.body) {
      if (!t.isImportDeclaration(stmt) || !stmt.source.value.startsWith(".")) continue;
      const spec = stmt.specifiers.find((s) => t.isImportSpecifier(s) && s.local.name === name) as t.ImportSpecifier | undefined;
      if (!spec) continue;
      const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
      const target = this.file(posix.normalize(posix.join(posix.dirname(from), stmt.source.value)));
      if (!target) return null;
      const local = this.exportedLocal(target, imported);
      return local ? this.object(local, target, depth + 1) : null;
    }
    return null;
  }

  private exportedLocal(path: string, exported: string): string | null {
    const ast = this.ast(path);
    if (!ast) return null;
    for (const stmt of ast.program.body) {
      if (!t.isExportNamedDeclaration(stmt)) continue;
      if (t.isVariableDeclaration(stmt.declaration) && stmt.declaration.declarations.some((d) => t.isIdentifier(d.id, { name: exported }))) return exported;
      for (const s of stmt.specifiers) if (t.isExportSpecifier(s) && (t.isIdentifier(s.exported) ? s.exported.name : s.exported.value) === exported) return s.local.name;
    }
    return null;
  }

  defaultSource(path: string, depth = 0): string {
    if (depth > 3 || path.endsWith(".vue")) return path;
    const ast = this.ast(path);
    if (!ast) return path;
    for (const stmt of ast.program.body) {
      if (!t.isExportNamedDeclaration(stmt) || !stmt.source) continue;
      if (!stmt.specifiers.some((s) => t.isExportSpecifier(s) && (t.isIdentifier(s.exported) ? s.exported.name : s.exported.value) === "default")) continue;
      return this.defaultSource(posix.normalize(posix.join(posix.dirname(path), stmt.source.value)), depth + 1);
    }
    return path;
  }

  meta(node: t.Node | null | undefined, from: string): t.ObjectProperty[] {
    if (!node) return [];
    if (t.isParenthesizedExpression(node)) return this.meta(node.expression, from);
    if (t.isLogicalExpression(node)) return this.meta(node.left, from);
    if (t.isIdentifier(node)) {
      const object = this.object(node.name, from);
      return object ? this.meta(object, from) : [];
    }
    if (!t.isObjectExpression(node)) return [];
    const out: t.ObjectProperty[] = [];
    for (const prop of node.properties) {
      if (t.isSpreadElement(prop)) out.push(...this.meta(prop.argument, from));
      else if (t.isObjectProperty(prop) && META_KEYS.test(literalKey(prop.key) ?? "") && isStatic(prop.value)) out.push(t.cloneNode(prop, true));
    }
    const byKey = new Map<string, t.ObjectProperty>();
    for (const prop of out) byKey.set(literalKey(prop.key)!, prop);
    return [...byKey.values()];
  }
}

function isStatic(node: t.Node): boolean {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return true;
  if (t.isArrayExpression(node)) return node.elements.every((e) => e !== null && isStatic(e));
  if (t.isObjectExpression(node)) return node.properties.every((p) => t.isObjectProperty(p) && !p.computed && isStatic(p.value));
  return false;
}

function routesIn(file: OutputFile, resolver: Resolver): Route[] {
  const ast = resolver.ast(file.path);
  if (!ast) return [];
  const nested = new Set<t.Node>();
  const arrays: t.ArrayExpression[] = [];
  t.traverseFast(ast.program, (n) => {
    if (!t.isArrayExpression(n) || !n.elements.length || !n.elements.every((e) => isRecord(e))) return;
    arrays.push(n);
    for (const e of n.elements) {
      const children = property(e as t.ObjectExpression, "children")?.value;
      if (children) nested.add(children);
    }
  });
  const walk = (array: t.ArrayExpression, parent: string): Route[] =>
    array.elements.map((element) => {
      const record = element as t.ObjectExpression;
      const own = stringValue(property(record, "path")?.value) ?? "";
      const path = own.startsWith("/") ? own : `${parent.replace(/\/+$/, "")}/${own}`.replace(/\/+$/, "") || "/";
      const rawName = stringValue(property(record, "name")?.value);
      const target = importTarget(property(record, "component")?.value, file.path);
      const children = property(record, "children")?.value;
      return {
        name: rawName ? rawName.replace(/___[\w-]+$/, "") : null,
        own,
        path,
        target: target ? resolver.defaultSource(resolver.file(target) ?? target) : null,
        meta: resolver.meta(property(record, "meta")?.value, file.path),
        children: t.isArrayExpression(children) ? walk(children, path) : [],
      };
    });
  return arrays.filter((a) => !nested.has(a)).flatMap((a) => walk(a, ""));
}

function paramSegment(path: string, token: string): string | null {
  const match = new RegExp(`:${token.replace(/[$]/g, "\\$&")}(\\([^)]*\\))?([?*+])?(?=/|$)`).exec(path);
  if (!match) return null;
  if (match[2] === "*" || match[2] === "+") return `[...${token}]`;
  if (match[2] === "?") return `[[${token}]]`;
  return `[${token}]`;
}

function fileSegments(name: string, path: string): string[] {
  const tokens = name.split("-").filter(Boolean);
  const literal = new Set(path.split("/").filter((s) => s && !s.startsWith(":")));
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const param = paramSegment(path, tokens[i]!);
    if (param) {
      out.push(param);
      i++;
      continue;
    }
    let end = i;
    for (let j = tokens.length - 1; j > i; j--) {
      if (literal.has(tokens.slice(i, j + 1).join("-")) && !tokens.slice(i, j + 1).some((tok) => paramSegment(path, tok))) {
        end = j;
        break;
      }
    }
    out.push(tokens.slice(i, end + 1).join("-"));
    i = end + 1;
  }
  return out;
}

function derivedPath(segments: string[]): string {
  const parts = segments.filter((s) => s !== "index").map((s) => {
    const catchAll = /^\[\.\.\.(\w+)\]$/.exec(s);
    if (catchAll) return `:${catchAll[1]}(.*)*`;
    const optional = /^\[\[(\w+)\]\]$/.exec(s);
    if (optional) return `:${optional[1]}?`;
    const param = /^\[(\w+)\]$/.exec(s);
    return param ? `:${param[1]}` : s;
  });
  return `/${parts.join("/")}`;
}

function normalizePath(path: string): string {
  return path.replace(/\(\)/g, "").replace(/\/+$/, "") || "/";
}

function names(route: Route): string[] {
  return [...(route.name ? [route.name] : []), ...route.children.flatMap(names)];
}

function commonPrefix(list: string[][]): string[] {
  if (!list.length) return [];
  const out: string[] = [];
  for (let i = 0; list.every((l) => l[i] !== undefined && l[i] === list[0]![i]); i++) out.push(list[0]![i]!);
  return out;
}

export function nuxtPages(all: OutputFile[], root: string, destination: (path: string) => string): NuxtPages {
  const files = all.filter((f) => f.kind === "module" || f.kind === "script");
  const byPath = new Map(files.map((f) => [f.path, f]));
  const resolver = new Resolver(byPath);
  const routes = files.filter((f) => /\.m?js$/.test(f.path) && f.content.includes("component:") && /\bimport\(/.test(f.content)).flatMap((f) => routesIn(f, resolver));
  const moves = new Map<string, string>();
  const meta = new Map<string, string>();
  const seen = new Set<string>();
  const place = (route: Route) => {
    route.children.forEach(place);
    if (!route.target || seen.has(route.target) || !byPath.has(route.target) || !route.target.endsWith(".vue")) return;
    seen.add(route.target);
    let segments: string[];
    if (route.name) segments = fileSegments(route.name, route.path);
    else {
      const childNames = route.children.flatMap(names).map((n) => n.split("-"));
      const prefix = childNames.length > 1 ? commonPrefix(childNames) : (childNames[0]?.slice(0, -1) ?? []);
      if (!prefix.length) return;
      segments = fileSegments(prefix.join("-"), route.path);
    }
    const hasIndexName = !!route.name && route.own === "" && !!route.path;
    const base = `${root}/pages/${segments.join("/")}`;
    const current = destination(route.target);
    const options = hasIndexName ? [`${base}/index.vue`] : [`${base}.vue`, `${base}/index.vue`];
    const desired = options.includes(current) ? current : options[0]!;
    if (desired !== current) moves.set(route.target, desired);
    const props = [...route.meta];
    const fileSegs = desired.slice(`${root}/pages/`.length).replace(/\.vue$/, "").split("/");
    if (normalizePath(derivedPath(fileSegs)) !== normalizePath(route.path)) {
      props.push(t.objectProperty(t.identifier("path"), t.stringLiteral(normalizePath(route.path))));
    }
    if (props.length) meta.set(route.target, print(t.file(t.program([t.expressionStatement(t.callExpression(t.identifier("definePageMeta"), [t.objectExpression(props)]))]))).trim());
  };
  routes.forEach(place);
  const middleware = new Set<string>();
  const collect = (route: Route) => {
    for (const prop of route.meta) {
      if (literalKey(prop.key) !== "middleware") continue;
      for (const value of t.isArrayExpression(prop.value) ? prop.value.elements : [prop.value]) if (t.isStringLiteral(value)) middleware.add(value.value);
    }
    route.children.forEach(collect);
  };
  routes.forEach(collect);
  if (middleware.size) {
    for (const file of files) {
      const ast = /\.m?js$/.test(file.path) && file.content.includes("import(") ? resolver.ast(file.path) : null;
      if (!ast) continue;
      t.traverseFast(ast.program, (n) => {
        if (!t.isObjectExpression(n)) return;
        const lazy = n.properties.filter((p): p is t.ObjectProperty => t.isObjectProperty(p) && !!importTarget(p.value, file.path) && (t.isArrowFunctionExpression(p.value) || t.isFunctionExpression(p.value)));
        if (!lazy.length || lazy.length !== n.properties.length || !lazy.some((p) => middleware.has(literalKey(p.key) ?? ""))) return;
        for (const prop of lazy) {
          const key = literalKey(prop.key);
          const target = resolver.file(importTarget(prop.value, file.path)!);
          if (key && target && !moves.has(target)) moves.set(target, `${root}/middleware/${key}${posix.extname(target)}`);
        }
      });
    }
  }
  return { moves, meta };
}

export function insertPageMeta(content: string, call: string): string {
  if (content.includes("definePageMeta(")) return content;
  const script = /<script\b([^>]*)\bsetup\b([^>]*)>([\s\S]*?)<\/script>/.exec(content);
  if (!script) return `<script setup>\n${call}\n</script>\n\n${content}`;
  const body = script[3]!;
  const lines = body.split("\n");
  let last = -1;
  let open = false;
  lines.forEach((line, i) => {
    if (/^\s*import\b/.test(line) || open) {
      last = i;
      open = !/from\s*["'][^"']+["'];?\s*$|^\s*import\s*["'][^"']+["'];?\s*$/.test(line) && !/;\s*$/.test(line);
    }
  });
  lines.splice(last === -1 && lines[0] === "" ? 1 : last + 1, 0, call);
  const start = script.index + script[0].indexOf(body);
  return content.slice(0, start) + lines.join("\n") + content.slice(start + body.length);
}
