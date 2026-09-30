import { posix } from "node:path";
import type { NodePath } from "@babel/traverse";
import { relativeImport, repointImports, type OutputTree } from "../output.ts";
import { print, t } from "../unpack/ast.ts";
import { load, programPath, save } from "./exports.ts";
import { keySubject } from "./semantic.ts";

const SUFFIXES = ["", ".ts", ".js", ".tsx", ".jsx", ".vue", "/index.ts", "/index.js"];

interface Imported {
  source: string;
  path: string | null;
  name: string;
}

interface Move {
  statements: t.Statement[];
  target: string;
  create: boolean;
  locals: Set<string>;
  names: Map<string, string>;
}

export function absorbShared(tree: OutputTree, root: string): number {
  let count = 0;
  const pattern = new RegExp(`^${root}/((shared|store)|router/index)\\.[jt]sx?$`);
  for (const file of tree.all()) {
    if (!pattern.test(file.path)) continue;
    count += absorb(tree, file.path, root);
    count += splitClusters(tree, file.path, root);
    const left = tree.all().find((f) => f.path === file.path);
    if (left && !left.content.trim()) tree.remove(file.path);
  }
  return count;
}

function specifierFor(from: string, target: string): string {
  const vendor = /(^|\/)(vendor|node_modules)\//.test(target);
  const bare = vendor || target.endsWith(".vue") ? target : target.replace(/\.[jt]sx?$/, "").replace(/\/index$/, "");
  return relativeImport(from, bare);
}

function absorb(tree: OutputTree, path: string, root: string): number {
  const find = (p: string) => tree.all().find((f) => f.path === p);
  const paths = new Set(tree.all().map((f) => f.path));
  const resolve = (from: string, specifier: string) => {
    if (!specifier.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    for (const suffix of SUFFIXES) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
  const isApp = (p: string | null): p is string => !!p && !/(^|\/)(vendor|node_modules)\//.test(p) && !p.endsWith(".vue");
  const file = find(path);
  const source = file ? load(file) : null;
  if (!source) return 0;
  const program = programPath(source.ast);
  const body = source.ast.program.body;
  const imported = new Map<string, Imported>();
  for (const st of body) {
    if (!t.isImportDeclaration(st) || st.importKind === "type") continue;
    for (const spec of st.specifiers) {
      const name = t.isImportSpecifier(spec) ? (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) : t.isImportDefaultSpecifier(spec) ? "default" : "*";
      imported.set(spec.local.name, { source: st.source.value, path: resolve(path, st.source.value), name });
    }
  }
  const exportList = (st: t.Statement): boolean => t.isExportNamedDeclaration(st) && !st.declaration && !st.source;
  const exportedAs = new Map<string, string[]>();
  const declaredIn = new Map<string, t.Statement>();
  for (const st of body) {
    if (t.isExportNamedDeclaration(st) && exportList(st)) {
      for (const spec of st.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported)) exportedAs.set(spec.local.name, [...(exportedAs.get(spec.local.name) ?? []), spec.exported.name]);
      continue;
    }
    const decl = t.isExportNamedDeclaration(st) ? st.declaration : st;
    if (!t.isFunctionDeclaration(decl) && !t.isClassDeclaration(decl) && !t.isVariableDeclaration(decl)) continue;
    for (const name of Object.keys(t.getOuterBindingIdentifiers(decl))) {
      declaredIn.set(name, st);
      if (t.isExportNamedDeclaration(st)) exportedAs.set(name, [...(exportedAs.get(name) ?? []), name]);
    }
  }
  const uses = new Map<t.Statement, Set<string>>();
  const users = new Map<string, Set<t.Statement>>();
  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    for (const ref of [...binding.referencePaths, ...binding.constantViolations] as NodePath[]) {
      const top = ref.find((p) => p.parentPath?.isProgram() === true)?.node as t.Statement | undefined;
      if (!top || exportList(top)) continue;
      if (!uses.has(top)) uses.set(top, new Set());
      uses.get(top)!.add(name);
      if (!users.has(name)) users.set(name, new Set());
      users.get(name)!.add(top);
    }
  }
  const helpersOf = (statement: t.Statement): t.Statement[] | null => {
    const group = new Set<t.Statement>([statement]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const st of [...group]) {
        for (const name of uses.get(st) ?? []) {
          const at = declaredIn.get(name);
          if (!at || group.has(at)) continue;
          if (exportedAs.has(name)) return null;
          if ([...(users.get(name) ?? [])].some((user) => user !== at && !group.has(user))) return null;
          group.add(at);
          grew = true;
        }
      }
    }
    group.delete(statement);
    return body.filter((st) => group.has(st));
  };
  const bindingsOf = (target: string) => {
    const other = find(target);
    const parsed = other ? load(other) : null;
    if (!parsed) return null;
    const scope = programPath(parsed.ast).scope;
    const exported = new Map<string, string>();
    for (const st of parsed.ast.program.body) {
      if (!t.isExportNamedDeclaration(st) || st.source) continue;
      if (st.declaration) for (const name of Object.keys(t.getOuterBindingIdentifiers(st.declaration))) exported.set(name, name);
      for (const spec of st.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported)) exported.set(spec.exported.name, spec.local.name);
    }
    return { scope, exported };
  };
  const moves: Move[] = [];
  const claimed = new Map<string, Set<string>>();
  const plan = (statement: t.Statement, target: string, create: boolean, names: Map<string, string>): boolean => {
    const helpers = helpersOf(statement);
    if (!helpers) return false;
    const statements = body.filter((st) => st === statement || helpers.includes(st));
    const needed = new Set(statements.flatMap((st) => [...(uses.get(st) ?? [])]).filter((name) => imported.has(name)));
    const declared = new Set(statements.flatMap((st) => Object.keys(t.getOuterBindingIdentifiers(t.isExportNamedDeclaration(st) ? (st.declaration ?? st) : st))));
    const taken = claimed.get(target) ?? new Set<string>();
    if (!create) {
      const bindings = bindingsOf(target);
      if (!bindings) return false;
      for (const name of needed) {
        const origin = imported.get(name)!;
        if (origin.path === target) {
          if (bindings.exported.get(origin.name) !== name) return false;
          continue;
        }
        if (bindings.scope.hasBinding(name) && !bindings.scope.getBinding(name)?.path.isImportSpecifier()) return false;
      }
      for (const name of [...declared, ...names.values()]) if (bindings.scope.hasBinding(name) || taken.has(name)) return false;
    }
    for (const name of [...declared, ...names.values()]) taken.add(name);
    claimed.set(target, taken);
    moves.push({ statements, target, create, locals: needed, names });
    return true;
  };
  const ext = posix.extname(path);
  for (const st of body) {
    const decl = t.isExportNamedDeclaration(st) ? st.declaration : st;
    if (t.isVariableDeclaration(decl) && decl.declarations.length === 1 && t.isIdentifier(decl.declarations[0]!.id)) {
      const local = decl.declarations[0]!.id.name;
      const init = decl.declarations[0]!.init;
      const exported = exportedAs.get(local) ?? [];
      const hook = exported.find((name) => /^use[A-Z]\w*Store$/.test(name));
      if (hook && t.isCallExpression(init) && t.isIdentifier(init.callee) && imported.get(init.callee.name)?.source === "pinia" && imported.get(init.callee.name)?.name === "defineStore") {
        const target = posix.join(root, "stores", `${hook}${ext}`);
        if (!paths.has(target) && plan(st, target, true, new Map([[local, hook]]))) continue;
      }
    }
    if ((t.isFunctionDeclaration(decl) && decl.id) || (t.isVariableDeclaration(decl) && decl.declarations.length === 1 && t.isIdentifier(decl.declarations[0]!.id))) {
      const local = t.isFunctionDeclaration(decl) ? decl.id!.name : (decl.declarations[0]!.id as t.Identifier).name;
      const exported = exportedAs.get(local);
      if (!exported?.length || exported.length > 1) continue;
      const fromApp = [...(uses.get(st) ?? [])].filter((name) => isApp(imported.get(name)?.path ?? null));
      const modules = new Set(fromApp.map((name) => imported.get(name)!.path!));
      const [target] = modules;
      if (modules.size !== 1 || target === path || !target || fromApp.every((name) => /^[A-Z]/.test(name))) continue;
      plan(st, target, false, new Map([[local, exported[0]!]]));
      continue;
    }
    if (t.isExpressionStatement(st) && t.isCallExpression(st.expression) && t.isMemberExpression(st.expression.callee)) {
      let object: t.Node = st.expression.callee.object;
      while (t.isMemberExpression(object)) object = object.object;
      const origin = t.isIdentifier(object) ? imported.get(object.name) : undefined;
      if (!origin || !isApp(origin.path) || origin.path === path) continue;
      plan(st, origin.path, false, new Map());
    }
  }
  if (!moves.length) return 0;
  const sharedImport = new RegExp(`from\\s*["'][^"']*${posix.basename(path).replace(/\.[jt]sx?$/, "")}(\\.[jt]sx?)?["']`);
  for (const other of tree.all()) {
    if (other.path === path || !/\.(m?[jt]sx?|vue)$/.test(other.path) || !sharedImport.test(other.content)) continue;
    let parsed;
    try {
      parsed = load(other);
    } catch {
      parsed = null;
    }
    if (!parsed && !(other.path.endsWith(".vue") && !/<script\b/.test(other.content))) return 0;
  }

  for (const move of moves) {
    for (const [local, name] of move.names) if (local !== name && !program.scope.hasBinding(name)) program.scope.rename(local, name);
  }
  const movedStatements = new Set(moves.flatMap((m) => m.statements));
  const relocated = new Map<string, string>();
  for (const move of moves) for (const [, name] of move.names) relocated.set(name, move.target);
  source.ast.program.body = body.filter((st) => !movedStatements.has(st));
  for (const st of source.ast.program.body) if (t.isExportNamedDeclaration(st) && exportList(st)) st.specifiers = st.specifiers.filter((spec) => !(t.isExportSpecifier(spec) && t.isIdentifier(spec.exported) && relocated.has(spec.exported.name)));
  source.ast.program.body = source.ast.program.body.filter((st) => !(t.isExportNamedDeclaration(st) && exportList(st) && !st.specifiers.length));

  const byTarget = new Map<string, Move[]>();
  for (const move of moves) byTarget.set(move.target, [...(byTarget.get(move.target) ?? []), move]);
  for (const [target, group] of byTarget) {
    const importsFor = (from: string) => {
      const bySource = new Map<string, t.ImportDeclaration>();
      for (const move of group) {
        for (const local of move.locals) {
          const origin = imported.get(local)!;
          if (origin.path === target) continue;
          const specifier = origin.path ? specifierFor(from, origin.path) : origin.source;
          const decl = bySource.get(specifier) ?? t.importDeclaration([], t.stringLiteral(specifier));
          bySource.set(specifier, decl);
          if (decl.specifiers.some((spec) => spec.local.name === local)) continue;
          decl.specifiers.push(origin.name === "default" ? t.importDefaultSpecifier(t.identifier(local)) : origin.name === "*" ? t.importNamespaceSpecifier(t.identifier(local)) : t.importSpecifier(t.identifier(local), t.identifier(origin.name)));
        }
      }
      return [...bySource.values()];
    };
    const exportedStatements = group.flatMap((move) =>
      move.statements.map((st) => {
        const named = t.isExportNamedDeclaration(st) ? st.declaration : st;
        const names = Object.keys(t.getOuterBindingIdentifiers(named ?? st));
        const exported = names.some((name) => [...move.names.values()].includes(name));
        return exported && !t.isExportNamedDeclaration(st) && (t.isFunctionDeclaration(st) || t.isVariableDeclaration(st) || t.isClassDeclaration(st)) ? t.exportNamedDeclaration(st, []) : !exported && t.isExportNamedDeclaration(st) && st.declaration ? st.declaration : st;
      }),
    );
    if (group[0]!.create) {
      tree.add({ ...file!, path: target, content: print(t.file(t.program([...importsFor(target), ...exportedStatements]))), kind: "module" });
      continue;
    }
    const other = find(target)!;
    const parsed = load(other)!;
    const existing = parsed.ast.program.body;
    const additions = importsFor(target).map((decl) => {
      const same = existing.find((st): st is t.ImportDeclaration => t.isImportDeclaration(st) && st.source.value === decl.source.value && st.importKind !== "type" && !st.specifiers.some((spec) => t.isImportNamespaceSpecifier(spec)));
      const fresh = decl.specifiers.filter((spec) => !existing.some((st) => t.isImportDeclaration(st) && st.specifiers.some((known) => known.local.name === spec.local.name)));
      if (same) {
        same.specifiers.push(...fresh);
        return null;
      }
      decl.specifiers = fresh;
      return fresh.length ? decl : null;
    });
    const lastImport = existing.reduce((at, st, i) => (t.isImportDeclaration(st) ? i : at), -1);
    existing.splice(lastImport + 1, 0, ...additions.filter((decl): decl is t.ImportDeclaration => !!decl));
    existing.push(...exportedStatements);
    save(parsed);
  }

  const after = programPath(source.ast);
  after.scope.crawl();
  const exportedLocals = new Set(source.ast.program.body.flatMap((st) => (t.isExportNamedDeclaration(st) && exportList(st) ? st.specifiers.flatMap((spec) => (t.isExportSpecifier(spec) ? [spec.local.name] : [])) : [])));
  const emptied = new Set<t.Statement>();
  for (const st of source.ast.program.body) {
    if (!t.isImportDeclaration(st) || !st.specifiers.length) continue;
    st.specifiers = st.specifiers.filter((spec) => exportedLocals.has(spec.local.name) || (after.scope.getBinding(spec.local.name)?.referencePaths.length ?? 0) > 0);
    if (!st.specifiers.length) emptied.add(st);
  }
  source.ast.program.body = source.ast.program.body.filter((st) => !emptied.has(st));
  save(source);
  rewriteImporters(tree, path, relocated, resolve);
  return moves.length;
}

function topicOf(statements: t.Statement[]): string | null {
  const strings = new Map<string, string>();
  for (const st of statements) {
    const decl = t.isExportNamedDeclaration(st) ? st.declaration : st;
    if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) if (t.isIdentifier(d.id) && t.isStringLiteral(d.init)) strings.set(d.id.name, d.init.value);
  }
  let api = false;
  const keys: string[] = [];
  for (const st of statements) {
    t.traverseFast(st, (node) => {
      if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: "fetch" })) api = true;
      else if (t.isStringLiteral(node) && /^\/api\//.test(node.value)) api = true;
      else if (t.isTemplateElement(node) && /(^|\/)api\/v?\d*/.test(node.value.cooked ?? "")) api = true;
      else if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property) && /^(getItem|setItem|removeItem)$/.test(node.callee.property.name)) {
        const arg = node.arguments[0];
        const key = t.isStringLiteral(arg) ? arg.value : t.isIdentifier(arg) ? strings.get(arg.name) : undefined;
        if (key) keys.push(key);
      }
    });
  }
  if (api) return "api";
  const subject = keys.length ? keySubject(keys[0]!) : null;
  return subject && /^[a-z][a-z0-9]{2,}$/i.test(subject) ? subject : null;
}

function splitClusters(tree: OutputTree, path: string, root: string): number {
  const find = (p: string) => tree.all().find((f) => f.path === p);
  const paths = new Set(tree.all().map((f) => f.path));
  const resolve = (from: string, specifier: string) => {
    if (!specifier.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    for (const suffix of SUFFIXES) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
  const file = find(path);
  const source = file ? load(file) : null;
  if (!source) return 0;
  const program = programPath(source.ast);
  const body = source.ast.program.body;
  const renamedExports = new Map<string, string>();
  const readableName = (st: t.Statement): [string, string] | null => {
    const decl = t.isExportNamedDeclaration(st) ? st.declaration : st;
    if (t.isFunctionDeclaration(decl) && decl.id && decl.id.name.length <= 3 && !decl.params.length && decl.body.body.length === 1) {
      const only = decl.body.body[0];
      const call = t.isExpressionStatement(only) && t.isCallExpression(only.expression) && t.isIdentifier(only.expression.callee) ? only.expression.callee.name : null;
      const subject = call ? /^apply([A-Z]\w*)$/.exec(call)?.[1] : undefined;
      return subject ? [decl.id.name, `init${subject}`] : null;
    }
    if (t.isVariableDeclaration(decl) && decl.declarations.length === 1 && t.isIdentifier(decl.declarations[0]!.id) && decl.declarations[0]!.id.name.length <= 3 && t.isObjectExpression(decl.declarations[0]!.init)) {
      const keys = decl.declarations[0]!.init.properties.map((p) => (t.isObjectProperty(p) || t.isObjectMethod(p)) && t.isIdentifier(p.key) ? p.key.name : null);
      if (keys.includes("get") && keys.includes("post") && keys.every((k) => k && /^(get|post|put|patch|del|delete|head|options|upload)$/.test(k))) return [decl.declarations[0]!.id.name, "api"];
    }
    return null;
  };
  for (const st of body) {
    const found = readableName(st);
    if (!found || program.scope.hasBinding(found[1])) continue;
    const [old, next] = found;
    program.scope.rename(old, next);
    for (const other of body) {
      if (!t.isExportNamedDeclaration(other) || other.declaration || other.source) continue;
      for (const spec of other.specifiers) {
        if (t.isExportSpecifier(spec) && spec.local.name === next && t.isIdentifier(spec.exported) && spec.exported.name === old) {
          spec.exported = t.identifier(next);
          renamedExports.set(old, next);
        }
      }
    }
  }
  const imported = new Map<string, Imported>();
  for (const st of body) {
    if (!t.isImportDeclaration(st) || st.importKind === "type") continue;
    for (const spec of st.specifiers) {
      const name = t.isImportSpecifier(spec) ? (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) : t.isImportDefaultSpecifier(spec) ? "default" : "*";
      imported.set(spec.local.name, { source: st.source.value, path: resolve(path, st.source.value), name });
    }
  }
  const isList = (st: t.Statement) => t.isExportNamedDeclaration(st) && !st.declaration && !st.source;
  const declOf = (st: t.Statement) => (t.isExportNamedDeclaration(st) ? st.declaration : st);
  const declaredIn = new Map<string, t.Statement>();
  const exportedAs = new Map<string, string[]>();
  for (const st of body) {
    if (t.isExportNamedDeclaration(st) && isList(st)) {
      for (const spec of st.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported)) exportedAs.set(spec.local.name, [...(exportedAs.get(spec.local.name) ?? []), spec.exported.name]);
      continue;
    }
    const decl = declOf(st);
    if (!t.isFunctionDeclaration(decl) && !t.isClassDeclaration(decl) && !t.isVariableDeclaration(decl)) continue;
    for (const name of Object.keys(t.getOuterBindingIdentifiers(decl))) {
      declaredIn.set(name, st);
      if (t.isExportNamedDeclaration(st)) exportedAs.set(name, [...(exportedAs.get(name) ?? []), name]);
    }
  }
  const uses = new Map<t.Statement, Set<string>>();
  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    for (const ref of [...binding.referencePaths, ...binding.constantViolations] as NodePath[]) {
      const top = ref.find((p) => p.parentPath?.isProgram() === true)?.node as t.Statement | undefined;
      if (!top || isList(top)) continue;
      if (!uses.has(top)) uses.set(top, new Set());
      uses.get(top)!.add(name);
    }
  }
  const routers = new Set<string>();
  for (const [name, st] of declaredIn) {
    const decl = declOf(st);
    const init = t.isVariableDeclaration(decl) ? decl.declarations.find((d) => t.isIdentifier(d.id, { name }))?.init : null;
    if (t.isCallExpression(init) && t.isIdentifier(init.callee) && imported.get(init.callee.name)?.name === "createRouter") routers.add(name);
  }
  const anchors = new Set(body.filter((st) => t.isImportDeclaration(st) || isList(st) || !declaredIn.size || ![...declaredIn.values()].includes(st) || [...Object.keys(t.getOuterBindingIdentifiers(declOf(st) ?? st))].some((name) => routers.has(name)) || [...(uses.get(st) ?? [])].some((name) => routers.has(name))));
  const candidates = body.filter((st) => !anchors.has(st));
  const parent = new Map<t.Statement, t.Statement>(candidates.map((st) => [st, st]));
  const findRoot = (st: t.Statement): t.Statement => (parent.get(st) === st ? st : findRoot(parent.get(st)!));
  for (const st of candidates) {
    for (const name of uses.get(st) ?? []) {
      const at = declaredIn.get(name);
      if (at && parent.has(at)) parent.set(findRoot(at), findRoot(st));
    }
  }
  const components = new Map<t.Statement, t.Statement[]>();
  for (const st of candidates) components.set(findRoot(st), [...(components.get(findRoot(st)) ?? []), st]);
  const anchorNames = new Set([...declaredIn].filter(([, st]) => anchors.has(st)).map(([name]) => name));
  const ext = posix.extname(path);
  const relocated = new Map<string, string>();
  const created: { target: string; statements: t.Statement[]; exports: Set<string>; locals: Set<string>; aliases: (readonly [string, string])[] }[] = [];
  const localImports = new Map<string, Set<string>>();
  for (const group of components.values()) {
    const members = new Set(group);
    if ([...members].some((st) => [...(uses.get(st) ?? [])].some((name) => anchorNames.has(name)))) continue;
    const topic = topicOf(group);
    if (!topic) continue;
    let jsx = false;
    for (const st of group)
      t.traverseFast(st, (node) => {
        if (t.isJSXElement(node) || t.isJSXFragment(node)) jsx = true;
      });
    const target = posix.join(root, "utils", `${topic}${jsx ? ext : ext.replace(/x$/, "")}`);
    if ([".ts", ".tsx", ".js", ".jsx"].some((suffix) => paths.has(posix.join(root, "utils", `${topic}${suffix}`))) || created.some((c) => c.target === target)) continue;
    const names = new Set(group.flatMap((st) => Object.keys(t.getOuterBindingIdentifiers(declOf(st) ?? st))));
    const outside = new Set(body.filter((st) => !members.has(st)).flatMap((st) => [...(uses.get(st) ?? [])]));
    const exports = new Set([...names].filter((name) => outside.has(name) || exportedAs.has(name)));
    const aliases = [...names].flatMap((name) => (exportedAs.get(name) ?? []).filter((alias) => alias !== name).map((alias) => [name, alias] as const));
    for (const name of names) for (const alias of exportedAs.get(name) ?? []) relocated.set(alias, target);
    const locals = new Set(group.flatMap((st) => [...(uses.get(st) ?? [])]).filter((name) => imported.has(name)));
    created.push({ target, statements: group, exports, locals, aliases });
    const needed = [...names].filter((name) => outside.has(name));
    if (needed.length) localImports.set(target, new Set(needed));
  }
  for (const [old, next] of renamedExports) if (!relocated.has(next)) relocated.set(next, path);
  if (!created.length) {
    if (!renamedExports.size) return 0;
    save(source);
    rewriteImporters(tree, path, relocated, resolve, renamedExports);
    return renamedExports.size;
  }
  const moved = new Set(created.flatMap((c) => c.statements));
  for (const { target, statements, exports, locals, aliases } of created) {
    const bySource = new Map<string, t.ImportDeclaration>();
    for (const local of locals) {
      const origin = imported.get(local)!;
      const specifier = origin.path ? specifierFor(target, origin.path) : origin.source;
      const decl = bySource.get(specifier) ?? t.importDeclaration([], t.stringLiteral(specifier));
      bySource.set(specifier, decl);
      decl.specifiers.push(origin.name === "default" ? t.importDefaultSpecifier(t.identifier(local)) : origin.name === "*" ? t.importNamespaceSpecifier(t.identifier(local)) : t.importSpecifier(t.identifier(local), t.identifier(origin.name)));
    }
    const out = statements.map((st) => {
      const decl = declOf(st) ?? st;
      const exported = Object.keys(t.getOuterBindingIdentifiers(decl)).some((name) => exports.has(name));
      if (exported) return t.isExportNamedDeclaration(st) ? st : t.exportNamedDeclaration(decl as t.Declaration, []);
      return t.isExportNamedDeclaration(st) && st.declaration ? st.declaration : st;
    });
    const aliasList = aliases.length ? [t.exportNamedDeclaration(null, aliases.map(([name, alias]) => t.exportSpecifier(t.identifier(name), t.identifier(alias))))] : [];
    tree.add({ ...file!, path: target, content: print(t.file(t.program([...bySource.values(), ...out, ...aliasList]))), kind: "module" });
  }
  source.ast.program.body = body.filter((st) => !moved.has(st));
  for (const st of source.ast.program.body) if (t.isExportNamedDeclaration(st) && isList(st)) st.specifiers = st.specifiers.filter((spec) => !(t.isExportSpecifier(spec) && t.isIdentifier(spec.exported) && relocated.has(spec.exported.name)));
  source.ast.program.body = source.ast.program.body.filter((st) => !(t.isExportNamedDeclaration(st) && isList(st) && !st.specifiers.length));
  const lastImport = source.ast.program.body.reduce((at, st, i) => (t.isImportDeclaration(st) ? i : at), -1);
  source.ast.program.body.splice(lastImport + 1, 0, ...[...localImports].map(([target, names]) => t.importDeclaration([...names].map((name) => t.importSpecifier(t.identifier(name), t.identifier(name))), t.stringLiteral(specifierFor(path, target)))));
  const after = programPath(source.ast);
  after.scope.crawl();
  const exportedLocals = new Set(source.ast.program.body.flatMap((st) => (t.isExportNamedDeclaration(st) && isList(st) ? st.specifiers.flatMap((spec) => (t.isExportSpecifier(spec) ? [spec.local.name] : [])) : [])));
  const emptied = new Set<t.Statement>();
  for (const st of source.ast.program.body) {
    if (!t.isImportDeclaration(st) || !st.specifiers.length) continue;
    st.specifiers = st.specifiers.filter((spec) => exportedLocals.has(spec.local.name) || (after.scope.getBinding(spec.local.name)?.referencePaths.length ?? 0) > 0);
    if (!st.specifiers.length) emptied.add(st);
  }
  source.ast.program.body = source.ast.program.body.filter((st) => !emptied.has(st));
  save(source);
  rewriteImporters(tree, path, relocated, resolve, renamedExports);
  return created.length;
}

function rewriteImporters(tree: OutputTree, path: string, relocated: Map<string, string>, resolve: (from: string, specifier: string) => string | null, renamed: Map<string, string> = new Map()): void {
  if (!relocated.size) return;
  for (const other of tree.all()) {
    if (other.path === path || !/\.(m?[jt]sx?|vue)$/.test(other.path) || !other.content.includes("import")) continue;
    let parsed;
    try {
      parsed = load(other);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    let changed = false;
    const list = parsed.ast.program.body;
    for (let i = 0; i < list.length; i++) {
      const st = list[i]!;
      if (!t.isImportDeclaration(st) || resolve(other.path, st.source.value) !== path) continue;
      for (const spec of st.specifiers) {
        if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported) || !renamed.has(spec.imported.name)) continue;
        const next = renamed.get(spec.imported.name)!;
        const scope = programPath(parsed.ast).scope;
        if (spec.local.name === spec.imported.name && !scope.hasBinding(next)) scope.rename(spec.local.name, next);
        spec.imported = t.identifier(next);
        changed = true;
      }
      const shifted = st.specifiers.filter((spec): spec is t.ImportSpecifier => t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && relocated.has(spec.imported.name) && relocated.get(spec.imported.name) !== path);
      if (!shifted.length) continue;
      st.specifiers = st.specifiers.filter((spec) => !shifted.includes(spec as t.ImportSpecifier));
      const bySource = new Map<string, t.ImportSpecifier[]>();
      for (const spec of shifted) {
        const target = relocated.get((spec.imported as t.Identifier).name)!;
        if (target === other.path) continue;
        const specifier = specifierFor(other.path, target);
        bySource.set(specifier, [...(bySource.get(specifier) ?? []), spec]);
      }
      const added = [...bySource].map(([specifier, specs]) => t.importDeclaration(specs, t.stringLiteral(specifier)));
      list.splice(i, st.specifiers.length ? 0 : 1, ...added);
      i += added.length - (st.specifiers.length ? 0 : 1);
      changed = true;
    }
    if (changed) save(parsed);
  }
}

export function nameStoreFiles(tree: OutputTree, root: string): number {
  let count = 0;
  const pattern = new RegExp(`^${root}/stores/use[A-Z]\\w*Store\\.[jt]sx?$`);
  for (const file of tree.all()) {
    if (!pattern.test(file.path)) continue;
    const ids = [...file.content.matchAll(/\bdefineStore\(\s*["']([A-Za-z][\w-]*)["']/g)].map((m) => m[1]!);
    if (ids.length !== 1) continue;
    const id = ids[0]!.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    const target = posix.join(posix.dirname(file.path), `${id}${posix.extname(file.path)}`);
    if (tree.all().some((f) => f.path === target || f.path.replace(/\.[^./]+$/, "") === target.replace(/\.[^./]+$/, ""))) continue;
    tree.remove(file.path);
    tree.add({ ...file, path: target });
    repointImports(tree, file.path, target.replace(/\.[jt]sx?$/, ""), new Set([target]));
    count++;
  }
  return count;
}

export function absorbLoneClient(tree: OutputTree, root: string): number {
  const dir = `${root}/api/`;
  const inside = tree.all().filter((f) => f.path.startsWith(dir) && /\.[jt]sx?$/.test(f.path));
  const client = tree.all().find((f) => new RegExp(`^${root}/utils/api\\.[jt]sx?$`).test(f.path));
  if (inside.length !== 1 || !client || tree.all().some((f) => f.path.startsWith(dir) && f !== inside[0])) return 0;
  const lone = inside[0]!;
  const source = load(lone);
  const target = load(client);
  if (!source || !target) return 0;
  const body = source.ast.program.body;
  if (body.some((st) => t.isImportDeclaration(st) || t.isExportDefaultDeclaration(st) || t.isExportAllDeclaration(st))) return 0;
  const classes = body.filter((st) => t.isExportNamedDeclaration(st) && t.isClassDeclaration(st.declaration));
  if (!classes.length || classes.length !== body.length) return 0;
  const names = classes.map((st) => ((st as t.ExportNamedDeclaration).declaration as t.ClassDeclaration).id!.name);
  const paths = new Set(tree.all().map((f) => f.path));
  const resolve = (from: string, specifier: string) => {
    if (!specifier.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    for (const suffix of SUFFIXES) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
  const clientBody = target.ast.program.body;
  const imports = clientBody.filter((st) => t.isImportDeclaration(st));
  if (!imports.some((st) => resolve(client.path, (st as t.ImportDeclaration).source.value) === lone.path)) return 0;
  if (names.some((name) => programPath(target.ast).scope.hasBinding(name) && !imports.some((st) => resolve(client.path, (st as t.ImportDeclaration).source.value) === lone.path && (st as t.ImportDeclaration).specifiers.some((spec) => spec.local.name === name)))) return 0;
  const kept = clientBody.filter((st) => !(t.isImportDeclaration(st) && resolve(client.path, st.source.value) === lone.path));
  const at = kept.findIndex((st) => !t.isImportDeclaration(st));
  kept.splice(at < 0 ? kept.length : at, 0, ...body.map((st) => t.cloneNode(st, true)));
  target.ast.program.body = kept;
  save(target);
  rewriteImporters(tree, lone.path, new Map(names.map((name) => [name, client.path] as const)), resolve);
  tree.remove(lone.path);
  return names.length;
}
