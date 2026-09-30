import type { ModuleRecord } from "../types.ts";
import { moduleFileName, parseProgram, print, t, traverse, type NodePath } from "./ast.ts";

export interface BannerPackage {
  name: string;
  specifier: string;
  version?: string;
}

const REACT_BUILDS: Record<string, string> = {
  "react-jsx-runtime": "react/jsx-runtime",
  "react-jsx-dev-runtime": "react/jsx-dev-runtime",
  "react-dom-client": "react-dom/client",
  "react-dom-server": "react-dom/server",
  "react-dom-server-legacy.browser": "react-dom/server",
  "react-dom-server.browser": "react-dom/server",
  "use-sync-external-store-shim": "use-sync-external-store/shim",
  "use-sync-external-store-shim-with-selector": "use-sync-external-store/shim/with-selector",
  "use-sync-external-store-with-selector": "use-sync-external-store/with-selector",
};

const NOT_PACKAGES = new Set(["mit", "isc", "apache", "bsd", "copyright", "license", "the", "version", "react", "v"]);
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[a-z0-9][\w.-]*)*$/;
const MAX_PENDING = 60;
const MAX_LABEL_GAP = 6000;

function packageOf(specifier: string, generic = true): BannerPackage | null {
  if (!PACKAGE_NAME.test(specifier) || (generic && NOT_PACKAGES.has(specifier))) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  if (specifier.startsWith("@") && parts.length < 2) return null;
  return { name, specifier };
}

export function bannerPackage(comment: string): BannerPackage | null {
  const found = bannerName(comment);
  const version = /\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/.exec(comment)?.[1];
  return found && version ? { ...found, version } : found;
}

function bannerName(comment: string): BannerPackage | null {
  if (/github\.com\/microsoft\/monaco-editor/.test(comment)) return { name: "monaco-editor", specifier: "monaco-editor" };
  const react = /@license React[\s*]*([\w.-]+?)\.(?:production|development|profiling)(?:\.min)?\.js/.exec(comment);
  if (react) return packageOf(REACT_BUILDS[react[1]!] ?? react[1]!, false);
  const licensed = /@license\s+(@?[\w.-]+(?:\/[\w.-]+)?)\s+v?\d+\.\d+/.exec(comment);
  if (licensed) return packageOf(licensed[1]!.toLowerCase());
  for (const line of comment.split("\n")) {
    const titled = /^[\s*!]*(@?[A-Za-z][\w.-]*(?:\/[\w.-]+)?(?: [A-Z][\w.-]*){0,3}) v(\d+\.\d+\.\d+)\b/.exec(line);
    if (titled) return packageOf(titled[1]!.toLowerCase().replace(/ /g, "-"));
  }
  return null;
}

const FAMILIES: Array<[RegExp, BannerPackage]> = [[/^@vue\/(shared|reactivity|runtime-core|runtime-dom)$/, { name: "vue", specifier: "vue" }]];
const MIN_CLUSTER = 8;

function familyOf(pkg: string): BannerPackage {
  return FAMILIES.find(([pattern]) => pattern.test(pkg))?.[1] ?? { name: pkg.split("/").slice(0, pkg.startsWith("@") ? 2 : 1).join("/"), specifier: pkg };
}

function related(a: string, b: string): boolean {
  a = familyOf(a).name;
  b = familyOf(b).name;
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`) || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

interface Statement {
  node: t.Statement;
  decls: Set<string>;
  uses: Set<string>;
  writes: Set<string>;
  banner: BannerPackage | null;
}

const APP = -1;
const HELPERS = -2;
const INFERRED = new WeakSet<BannerPackage>();

function inferredBanner(pkg: string): BannerPackage {
  const banner = { ...familyOf(pkg), specifier: familyOf(pkg).name };
  INFERRED.add(banner);
  return banner;
}

function flatten(body: t.Statement[]): t.Statement[] {
  const out: t.Statement[] = [];
  for (const stmt of body) {
    if (t.isExpressionStatement(stmt) && t.isSequenceExpression(stmt.expression)) {
      const parts = stmt.expression.expressions;
      parts.forEach((expr, i) => {
        const single = t.expressionStatement(expr);
        single.start = i === 0 ? stmt.start : expr.start;
        single.end = i === parts.length - 1 ? stmt.end : expr.end;
        single.leadingComments = [...(i === 0 ? (stmt.leadingComments ?? []) : []), ...(expr.leadingComments ?? [])];
        if (!single.leadingComments.length) single.leadingComments = null;
        if (i === parts.length - 1) single.trailingComments = stmt.trailingComments ?? null;
        out.push(single);
      });
      continue;
    }
    if (!t.isVariableDeclaration(stmt) || stmt.declarations.length < 2) {
      out.push(stmt);
      continue;
    }
    stmt.declarations.forEach((decl, i) => {
      const single = t.variableDeclaration(stmt.kind, [decl]);
      single.start = i === 0 ? stmt.start : decl.start;
      single.end = i === stmt.declarations.length - 1 ? stmt.end : decl.end;
      single.leadingComments = [...(i === 0 ? (stmt.leadingComments ?? []) : []), ...(decl.leadingComments ?? [])];
      if (!single.leadingComments.length) single.leadingComments = null;
      if (i === stmt.declarations.length - 1) single.trailingComments = stmt.trailingComments ?? null;
      out.push(single);
    });
  }
  out.forEach((stmt, i) => {
    const next = new Set(out[i + 1]?.leadingComments ?? []);
    if (stmt.trailingComments && next.size) stmt.trailingComments = stmt.trailingComments.filter((c) => !next.has(c) && ![...next].some((n) => n.start === c.start));
  });
  return out;
}

function analyze(ast: t.File): { statements: Statement[]; imports: Map<string, { source: string; imported: string | null }> } {
  const body = ast.program.body;
  const index = new Map<t.Node, number>(body.map((s, i) => [s, i]));
  const statements: Statement[] = body.map((node) => ({
    node,
    decls: new Set(),
    uses: new Set(),
    writes: new Set(),
    banner: (node.leadingComments ?? []).map((c) => bannerPackage(c.value)).find((b) => b) ?? null,
  }));
  const imports = new Map<string, { source: string; imported: string | null }>();
  const top = (path: NodePath): number | undefined => {
    const found = path.find((p) => p.parentPath?.isProgram() === true);
    return found ? index.get(found.node) : undefined;
  };
  traverse(ast, {
    Program(program) {
      for (const [name, binding] of Object.entries(program.scope.bindings)) {
        if (binding.path.isImportSpecifier() || binding.path.isImportDefaultSpecifier() || binding.path.isImportNamespaceSpecifier()) {
          const decl = binding.path.parentPath!.node as t.ImportDeclaration;
          const spec = binding.path.node;
          imports.set(name, { source: decl.source.value, imported: t.isImportSpecifier(spec) ? (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) : t.isImportDefaultSpecifier(spec) ? "default" : null });
          continue;
        }
        const owner = top(binding.path);
        if (owner === undefined) continue;
        statements[owner]!.decls.add(name);
        for (const ref of binding.referencePaths) {
          const at = top(ref);
          if (at !== undefined && at !== owner) statements[at]!.uses.add(name);
        }
        for (const write of binding.constantViolations) {
          const at = top(write);
          if (at !== undefined && at !== owner) {
            statements[at]!.writes.add(name);
            statements[at]!.uses.add(name);
          }
        }
      }
      for (const [name] of imports) {
        const binding = program.scope.bindings[name]!;
        for (const ref of binding.referencePaths) {
          const at = top(ref);
          if (at !== undefined) statements[at]!.uses.add(name);
        }
      }
      program.stop();
    },
  });
  return { statements, imports };
}

function exportsOf(node: t.Node | null | undefined): boolean {
  return t.isMemberExpression(node) && t.isIdentifier(node.object) && t.isIdentifier(node.property, { name: "exports" });
}

function simpleArgument(node: t.Node | null | undefined): boolean {
  if (t.isIdentifier(node) || exportsOf(node) || t.isNullLiteral(node)) return true;
  if (t.isArrayExpression(node)) return node.elements.every((e) => t.isIdentifier(e));
  if (t.isObjectExpression(node)) return node.properties.every((p) => t.isObjectProperty(p) && (t.isIdentifier(p.value) || t.isNullLiteral(p.value) || t.isBooleanLiteral(p.value)));
  return false;
}

function isCode(node: t.Statement): boolean {
  if (t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) return true;
  if (!t.isVariableDeclaration(node)) return false;
  return node.declarations.some((d) => {
    let init = d.init;
    while (t.isCallExpression(init) && init.arguments.length === 1 && (t.isFunction(init.arguments[0]) || t.isObjectExpression(init.arguments[0]))) init = init.arguments[0];
    return t.isFunction(init) || t.isClass(init) || (t.isObjectExpression(init) && init.properties.some((p) => t.isObjectMethod(p) || (t.isObjectProperty(p) && t.isFunction(p.value))));
  });
}

function isContainer(node: t.Statement): boolean {
  if (!t.isVariableDeclaration(node) || node.declarations.length !== 1) return false;
  const init = node.declarations[0]!.init;
  return t.isObjectExpression(init) && (init.properties.length === 0 || (init.properties.length === 1 && t.isObjectProperty(init.properties[0]) && t.isIdentifier(init.properties[0].key, { name: "exports" }) && t.isObjectExpression(init.properties[0].value)));
}

function isGlue(node: t.Statement): boolean {
  if (t.isExpressionStatement(node)) {
    const expr = node.expression;
    return t.isAssignmentExpression(expr, { operator: "=" }) && exportsOf(expr.left) && (t.isIdentifier(expr.right) || exportsOf(expr.right) || (t.isCallExpression(expr.right) && t.isIdentifier(expr.right.callee) && expr.right.arguments.length === 0));
  }
  if (!t.isVariableDeclaration(node) || node.declarations.length !== 1) return false;
  const init = node.declarations[0]!.init;
  if (t.isObjectExpression(init)) return init.properties.length === 0 || (init.properties.length === 1 && t.isObjectProperty(init.properties[0]) && t.isIdentifier(init.properties[0].key, { name: "exports" }) && t.isObjectExpression(init.properties[0].value));
  if (exportsOf(init)) return true;
  return t.isCallExpression(init) && t.isIdentifier(init.callee) && init.arguments.length >= 1 && init.arguments.length <= 2 && init.arguments.every(simpleArgument);
}

function assignRegions(statements: Statement[], labels: ReadonlyMap<string, string>, owners: ReadonlyMap<string, number>): { region: number[]; banners: BannerPackage[] } {
  const n = statements.length;
  const jsxRuntime = new Set<number>();
  const region = new Array<number>(n).fill(APP);
  const starts = statements.flatMap((s, i) => (s.banner ? [i] : []));
  const banners = starts.map((i) => statements[i]!.banner!);
  const users = new Map<string, number[]>();
  statements.forEach((s, i) => s.uses.forEach((name) => users.set(name, [...(users.get(name) ?? []), i])));
  const prelude = starts[0] ?? 0;
  const family = new Set<string>();
  const include = (i: number, k: number) => {
    region[i] = k;
    for (const name of statements[i]!.decls) family.add(name);
  };
  const ownerOf = (name: string) => owners.get(name) ?? n;
  const libraryOwned = (name: string) => family.has(name) || (owners.has(name) && isContainer(statements[ownerOf(name)]!.node));
  const tolerated = (name: string, i: number, pending: Set<string>) => family.has(name) || pending.has(name) || ownerOf(name) >= i || isGlue(statements[ownerOf(name)]!.node);
  starts.forEach((start, k) => {
    const end = starts[k + 1] ?? n;
    const pkg = banners[k]!.name;
    if (banners[k]!.specifier === "react/jsx-runtime" || banners[k]!.specifier === "react/jsx-dev-runtime") jsxRuntime.add(k);
    let last = start;
    for (let i = start + 1; i < end && statements[i]!.node.start! - statements[last]!.node.end! <= MAX_LABEL_GAP; i++) {
      const hit = [...statements[i]!.decls].some((name) => {
        const label = labels.get(name);
        return label !== undefined && related(label, pkg);
      });
      if (hit) last = i;
    }
    for (let i = start; i <= last; i++) include(i, k);
    const jsx = new Set([...jsxRuntime].flatMap((r) => statements.flatMap((s, i) => (region[i] === r ? [...s.decls] : []))));
    let pending: number[] = [];
    const pendingDecls = () => new Set(pending.flatMap((p) => [...statements[p]!.decls]));
    const flushGlue = () => {
      const declared = pendingDecls();
      for (const p of pending) {
        const node = statements[p]!.node;
        if (!isGlue(node)) continue;
        if ([...statements[p]!.uses].every((u) => tolerated(u, p, declared) || ownerOf(u) < prelude)) include(p, k);
      }
    };
    const strict = k === starts.length - 1;
    for (let i = last + 1; i < end; i++) {
      const stmt = statements[i]!;
      const uses = [...stmt.uses];
      if (isGlue(stmt.node)) {
        pending.push(i);
        continue;
      }
      if (!jsxRuntime.has(k) && uses.some((u) => jsx.has(u))) break;
      const declared = pendingDecls();
      if (uses.some((u) => !tolerated(u, i, declared))) break;
      const needed = [...stmt.decls].some((name) => (users.get(name) ?? []).some((j) => region[j] === k));
      if (strict && isCode(stmt.node) && !needed) break;
      if (needed || uses.some(libraryOwned)) {
        for (const p of pending) include(p, k);
        include(i, k);
        pending = [];
        continue;
      }
      pending.push(i);
      if (pending.length > MAX_PENDING) break;
    }
    flushGlue();
  });
  for (let changed = true; changed; ) {
    changed = false;
    starts.forEach((start, k) => {
      const end = starts[k + 1] ?? n;
      for (let i = start + 1; i < end; i++) {
        if (region[i] !== APP) continue;
        const stmt = statements[i]!;
        if ([...stmt.uses].some((u) => ownerOf(u) < i && region[ownerOf(u)] === APP && !isGlue(statements[ownerOf(u)]!.node) && ownerOf(u) >= prelude)) continue;
        const usedByLibrary = [...stmt.decls].some((name) => (users.get(name) ?? []).some((j) => region[j]! >= k));
        const extendsLibrary = !stmt.decls.size && [...stmt.uses].some(libraryOwned);
        const bounded = k < starts.length - 1;
        if (!bounded && !usedByLibrary && !extendsLibrary) continue;
        include(i, k);
        changed = true;
      }
    });
  }
  return { region, banners };
}

function attachGlue(statements: Statement[], region: number[], owners: Map<string, number>): void {
  const users = new Map<string, Set<number>>();
  statements.forEach((s, i) => {
    for (const name of s.uses) {
      if (!users.has(name)) users.set(name, new Set());
      users.get(name)!.add(i);
    }
  });
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = statements.length - 1; i >= 0; i--) {
      const s = statements[i]!;
      if (!s.decls.size || !t.isVariableDeclaration(s.node)) continue;
      if (region[i] !== APP) {
        if (s.uses.size || !isGlue(s.node)) continue;
        const at = [...s.decls].flatMap((name) => [...(users.get(name) ?? [])]).map((j) => region[j]!);
        if (!at.length || at.some((r) => r < 0)) continue;
        const home = Math.min(...at);
        if (home !== region[i]) {
          region[i] = home;
          changed = true;
        }
        continue;
      }
      const libraryUsers = [...s.decls].flatMap((name) => [...(users.get(name) ?? [])]).map((j) => region[j]!).filter((r) => r >= 0);
      if (!libraryUsers.length) continue;
      const sources = [...s.uses].map((name) => owners.get(name)).filter((at): at is number => at !== undefined).map((at) => region[at]!);
      if (sources.some((r) => r === APP)) continue;
      const target = sources.some((r) => r >= 0) ? Math.max(...sources) : Math.min(...libraryUsers);
      if (target > Math.min(...libraryUsers)) continue;
      region[i] = target;
      changed = true;
    }
  }
}

function helpersFor(statements: Statement[], region: number[], first: number): void {
  const owner = new Map<string, number>();
  statements.forEach((s, i) => s.decls.forEach((name) => owner.set(name, i)));
  const users = new Map<number, Set<number>>();
  statements.forEach((s, i) => {
    for (const name of s.uses) {
      const at = owner.get(name);
      if (at === undefined) continue;
      if (!users.has(at)) users.set(at, new Set());
      users.get(at)!.add(i);
    }
  });
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = first - 1; i >= 0; i--) {
      if (region[i] !== APP || !statements[i]!.decls.size) continue;
      const by = [...(users.get(i) ?? [])].map((j) => region[j]!);
      if (!by.length || by.some((r) => r < 0)) continue;
      region[i] = Math.min(...by);
      changed = true;
    }
  }
  const queue: number[] = [];
  statements.forEach((s, i) => {
    if (region[i]! < 0) return;
    for (const name of s.uses) {
      const at = owner.get(name);
      if (at !== undefined && at < first && region[at] === APP) queue.push(at);
    }
  });
  while (queue.length) {
    const i = queue.pop()!;
    if (region[i] === HELPERS) continue;
    region[i] = HELPERS;
    for (const name of statements[i]!.uses) {
      const at = owner.get(name);
      if (at !== undefined && region[at] === APP) queue.push(at);
    }
  }
}

function literalValue(node: t.Node | null | undefined): boolean {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return true;
  if (t.isTemplateLiteral(node)) return !node.expressions.length;
  return t.isArrayExpression(node) && node.elements.length > 0 && node.elements.every((element) => literalValue(element));
}

function enforce(statements: Statement[], region: number[], labeled: (i: number) => boolean = () => false): boolean {
  const owner = new Map<string, number>();
  statements.forEach((s, i) => s.decls.forEach((name) => owner.set(name, i)));
  for (let i = 0; i < statements.length; i++) {
    const node = statements[i]!.node;
    if (region[i]! < 0 || labeled(i) || statements[i]!.banner || !t.isVariableDeclaration(node) || !node.declarations.every((d) => literalValue(d.init))) continue;
    const users = statements.flatMap((s, j) => (j !== i && [...statements[i]!.decls].some((name) => s.uses.has(name)) ? [j] : []));
    if (users.length && users.every((j) => region[j] === APP)) region[i] = APP;
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < statements.length; i++) {
      const mine = region[i]!;
      if (mine === APP) continue;
      for (const name of statements[i]!.uses) {
        const at = owner.get(name);
        if (at === undefined) continue;
        const theirs = region[at]!;
        const backwards = theirs === APP || (mine === HELPERS && theirs !== HELPERS) || (mine >= 0 && theirs > mine);
        if (!backwards) continue;
        if (mine === HELPERS && theirs >= 0) {
          region[i] = theirs;
          changed = true;
          break;
        }
        if (mine === HELPERS) return false;
        if (mine >= 0 && theirs === APP && !labeled(i) && !statements[i]!.banner) {
          region[i] = APP;
          changed = true;
          break;
        }
        if (mine >= 0 && theirs > mine) {
          if (statements[at]!.banner) {
            const next = region.findIndex((r, j) => j > at && r === theirs);
            if (next < 0) continue;
            statements[next]!.banner = statements[at]!.banner;
            statements[at]!.banner = null;
          }
          region[at] = mine;
          changed = true;
          break;
        }
        for (let j = 0; j < region.length; j++) if (region[j] === mine) region[j] = APP;
        changed = true;
        break;
      }
    }
  }
  for (let i = 0; i < statements.length; i++) {
    for (const name of statements[i]!.writes) {
      const at = owner.get(name);
      if (at === undefined || region[at] === region[i]) continue;
      if (region[i] === APP && region[at]! >= 0 && !labeled(at) && t.isVariableDeclaration(statements[at]!.node)) {
        region[at] = APP;
        return enforce(statements, region, labeled);
      }
      if (region[at] === HELPERS || region[i] === HELPERS) return false;
      const lib = region[at]! >= 0 ? region[at]! : region[i]!;
      for (let j = 0; j < region.length; j++) if (region[j] === lib) region[j] = APP;
      return enforce(statements, region, labeled);
    }
  }
  return true;
}

function memberName(node: t.Node | null | undefined): string | null {
  return t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property) && /^[A-Za-z_$][\w$]{2,}$/.test(node.property.name) ? node.property.name : null;
}

function nameReexports(ast: t.File, statements: Statement[], region: number[]): void {
  const at = new Map<string, number>();
  statements.forEach((s, i) => s.decls.forEach((name) => at.set(name, i)));
  const usedByApp = new Set(statements.flatMap((s, i) => (region[i] === APP ? [...s.uses] : [])));
  const renames = new Map<string, string>();
  traverse(ast, {
    Program(program) {
      for (const [name, binding] of Object.entries(program.scope.bindings)) {
        const owner = at.get(name);
        if (owner === undefined || region[owner]! < 0 || name.length > 3 || !usedByApp.has(name)) continue;
        const values = [binding.path.isVariableDeclarator() ? binding.path.node.init : null, ...binding.constantViolations.map((v) => (v.isAssignmentExpression() ? v.node.right : undefined))].filter((v) => v !== null);
        const names = new Set(values.map(memberName));
        if (names.size !== 1) continue;
        const next = [...names][0];
        if (!next || next === "exports" || next === "default" || program.scope.hasBinding(next, true) || program.scope.hasGlobal(next) || [...renames.values()].includes(next)) continue;
        renames.set(name, next);
      }
      for (const [from, to] of renames) program.scope.rename(from, to);
      program.stop();
    },
  });
  if (!renames.size) return;
  const swap = (set: Set<string>) => {
    for (const [from, to] of renames) if (set.delete(from)) set.add(to);
  };
  for (const s of statements) {
    swap(s.decls);
    swap(s.uses);
    swap(s.writes);
  }
}

function slug(specifier: string): string {
  return specifier.replace(/^@/, "").replace(/[^\w.-]+/g, "_");
}

function isPreloadPolyfill(source: string, stmt: t.Statement): boolean {
  return t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression) && t.isFunction(stmt.expression.callee) && source.includes("relList") && source.includes("modulepreload");
}

function markClusters(statements: Statement[], labels: ReadonlyMap<string, string>, components: ReadonlySet<string> = new Set()): void {
  const families = new Set([...labels.values()].map((pkg) => familyOf(pkg).name));
  const vue = families.has("vue") || statements.some((s) => s.banner && familyOf(s.banner.name).name === "vue");
  const react = !vue && (families.has("react") || families.has("react-dom"));
  let current: string | null = null;
  let real = false;
  let cluster: Array<{ index: number; family: string }> = [];
  const close = () => {
    if (cluster.length >= MIN_CLUSTER) {
      const votes = new Map<string, number>();
      for (const hit of cluster) votes.set(hit.family, (votes.get(hit.family) ?? 0) + 1);
      const [voted, count] = [...votes].sort((a, b) => b[1] - a[1])[0]!;
      const start = cluster.find((hit) => hit.family === voted)!.index;
      const counterpart = vue ? voted.replace(/(^|[/-])react([/-]|$)/, "$1vue$2") : react ? voted.replace(/(^|[/-])vue([/-]|$)/, "$1react$2") : voted;
      const family = counterpart !== voted && families.has(counterpart) ? counterpart : vue && families.has(`${voted}-vue`) ? `${voted}-vue` : voted;
      const foreign = (vue && /(^|[/-])react([/-]|$)/.test(family)) || (react && /(^|[/-])vue([/-]|$)/.test(family));
      let later = false;
      for (let i = start; current && real && i < statements.length && !statements[i]!.banner && !later; i++) later = [...statements[i]!.decls].some((name) => labels.get(name) !== undefined && familyOf(labels.get(name)!).name === current);
      const named = cluster.some((hit) => hit.family === voted && [...statements[hit.index]!.decls].some((name) => components.has(name)));
      if (family !== current && (count >= MIN_CLUSTER || named) && !later && !foreign && !statements[start]!.banner) {
        const known = [...labels.values()].find((pkg) => familyOf(pkg).name === family)!;
        statements[start]!.banner = inferredBanner(known);
        current = family;
        real = false;
      }
    }
    cluster = [];
  };
  for (let i = 0; i < statements.length; i++) {
    if (statements[i]!.banner) {
      close();
      current = familyOf(statements[i]!.banner!.name).name;
      real = true;
      continue;
    }
    const label = [...statements[i]!.decls].map((name) => labels.get(name)).find((l) => l !== undefined);
    if (label === undefined) continue;
    const family = familyOf(label).name;
    const last = cluster[cluster.length - 1];
    if (last && (statements[i]!.node.start! - statements[last.index]!.node.end! > MAX_LABEL_GAP || (family !== last.family && family === current))) close();
    if (family === current && !cluster.length) continue;
    cluster.push({ index: i, family });
  }
  close();
}

function componentName(node: t.Statement, named: ReadonlyMap<string, string> = new Map()): string | null {
  if (!t.isVariableDeclaration(node) || node.declarations.length !== 1) return null;
  let found: string | null = null;
  const visit = (expr: t.Node | null | undefined, depth: number) => {
    if (found || !expr || depth > 3) return;
    if (t.isObjectExpression(expr)) {
      const keys = new Set(expr.properties.flatMap((p) => ((t.isObjectProperty(p) || t.isObjectMethod(p)) && t.isIdentifier(p.key) ? [p.key.name] : [])));
      for (const prop of expr.properties) {
        if (t.isSpreadElement(prop) && t.isIdentifier(prop.argument) && named.has(prop.argument.name) && (keys.has("setup") || keys.has("render") || keys.has("props"))) found = named.get(prop.argument.name)!;
        if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key) || !t.isStringLiteral(prop.value)) continue;
        if (prop.key.name === "__name" || (prop.key.name === "name" && /^[A-Z]/.test(prop.value.value) && (keys.has("setup") || keys.has("render") || keys.has("props") || keys.has("compatConfig")))) found = prop.value.value;
      }
      return;
    }
    if (t.isCallExpression(expr)) for (const arg of expr.arguments) visit(arg, depth + 1);
  };
  visit(node.declarations[0]!.init, 0);
  return found;
}

function isStore(node: t.Statement, packageOf: (name: string) => string | null): boolean {
  if (!t.isVariableDeclaration(node) || node.declarations.length !== 1) return false;
  const init = node.declarations[0]!.init;
  if (!t.isCallExpression(init) || !t.isIdentifier(init.callee) || packageOf(init.callee.name) !== "pinia") return false;
  const [id, options] = init.arguments;
  if (!t.isStringLiteral(id)) return false;
  return t.isFunction(options) || (t.isObjectExpression(options) && options.properties.some((p) => t.isObjectProperty(p) && t.isIdentifier(p.key) && /^(state|actions|getters)$/.test(p.key.name)));
}

function appStrings(node: t.Node, siteWords: readonly string[]): boolean {
  let found = false;
  const check = (text: string) => {
    if (found || !text) return;
    const letters = text.match(/[\p{L}\s]/gu)?.length ?? 0;
    if (/[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}]{3,}/u.test(text) && letters >= text.length * 0.6) found = true;
    else if (/^\/api\/|\/api\/v\d+\/|^\/v\d+\//.test(text)) found = true;
    else if (siteWords.some((word) => text.toLowerCase().includes(word))) found = true;
  };
  t.traverseFast(node, (n) => {
    if (t.isStringLiteral(n)) check(n.value);
    else if (t.isTemplateElement(n)) check(n.value.cooked ?? "");
  });
  return found;
}

function appPrefixes(statements: Statement[], region: number[], labeled: (i: number) => boolean): string[] {
  const strings = (node: t.Node) => {
    const out: string[] = [];
    t.traverseFast(node, (n) => {
      if (t.isStringLiteral(n)) out.push(n.value);
      else if (t.isTemplateElement(n) && n.value.cooked) out.push(n.value.cooked);
    });
    return out;
  };
  const counts = new Map<string, Set<string>>();
  statements.forEach((s, i) => {
    if (region[i] !== APP) return;
    for (const text of strings(s.node)) {
      const prefix = /^([a-z][a-z0-9]{2,})[_:]/i.exec(text)?.[1]?.toLowerCase();
      if (!prefix || /^(data|aria|http|https|mailto|tel|font|icon|vue|router|input|text|item|user|page|app|api|use|on|is|has|get|set)$/.test(prefix)) continue;
      if (!counts.has(prefix)) counts.set(prefix, new Set());
      counts.get(prefix)!.add(text);
    }
  });
  const library = new Set<string>();
  statements.forEach((s, i) => {
    if (region[i]! < 0 || !labeled(i)) return;
    for (const text of strings(s.node)) library.add(text.toLowerCase());
  });
  return [...counts].filter(([prefix, texts]) => texts.size >= 2 && ![...library].some((text) => text.startsWith(`${prefix}_`) || text.startsWith(`${prefix}:`))).map(([prefix]) => `${prefix}_`);
}

function releaseAppCode(statements: Statement[], region: number[], banners: BannerPackage[], labels: ReadonlyMap<string, string>, component: (name: string) => string | null, siteWords: readonly string[]): Set<number> {
  const owner = new Map<string, number>();
  statements.forEach((s, i) => s.decls.forEach((name) => owner.set(name, i)));
  const packageOf = (name: string) => {
    const label = labels.get(name);
    if (label) return familyOf(label).name;
    const at = owner.get(name);
    const r = at === undefined ? -1 : region[at]!;
    return r >= 0 ? familyOf(banners[r]!.name).name : null;
  };
  const familyAt = statements.map((s) => {
    const label = [...s.decls].map((name) => labels.get(name)).find((l) => l !== undefined);
    return label ? familyOf(label).name : null;
  });
  const sandwiched = (i: number) => {
    let before: string | null = null;
    let after: string | null = null;
    for (let k = i - 1; k >= Math.max(0, i - 40) && !before; k--) before = familyAt[k] ?? null;
    for (let k = i + 1; k < Math.min(statements.length, i + 41) && !after; k++) after = familyAt[k] ?? null;
    return !!before && before === after;
  };
  const prefixes = appPrefixes(statements, region, (i) => [...statements[i]!.decls].some((d) => labels.has(d)));
  const words = [...siteWords, ...prefixes];
  const seeds = new Set<number>();
  statements.forEach((s, i) => {
    if (region[i]! < 0) return;
    const name = componentName(s.node);
    if ((name && !component(name) && !/^(Teleport|KeepAlive|Suspense|Transition|TransitionGroup|BaseTransition|RouterLink|RouterView)$/.test(name) && !sandwiched(i)) || isStore(s.node, packageOf)) seeds.add(i);
    else if (![...s.decls].some((d) => labels.has(d)) && appStrings(s.node, words)) seeds.add(i);
  });
  if (!seeds.size) return new Set();
  const users = new Map<number, Set<number>>();
  statements.forEach((s, i) => {
    if (isExportList(s.node)) return;
    for (const name of s.uses) {
      const at = owner.get(name);
      if (at === undefined || at === i) continue;
      if (!users.has(at)) users.set(at, new Set());
      users.get(at)!.add(i);
    }
  });
  const closure = new Set<number>();
  const uses = statements.map((st, i) => new Set([...st.uses].map((name) => owner.get(name)).filter((at): at is number => at !== undefined && at !== i)));
  const labeled = (i: number) => [...statements[i]!.decls].some((name) => labels.has(name));
  const marks: number[] = [];
  let seen = 0;
  statements.forEach((st, i) => {
    marks.push(seen);
    if (st.banner || labeled(i)) seen++;
  });
  marks.push(seen);
  const adjacent = (at: number, by: Set<number>) => {
    const first = Math.min(...by);
    return first > at && marks[first]! - marks[at + 1]! === 0;
  };
  const queue = [...seeds];
  const add = (i: number) => {
    if (closure.has(i) || region[i] === HELPERS || isExportList(statements[i]!.node)) return;
    closure.add(i);
    queue.push(i);
  };
  for (const seed of seeds) closure.add(seed);
  while (queue.length) {
    const k = queue.pop()!;
    for (const j of users.get(k) ?? []) add(j);
    for (const at of uses[k]!) {
      if (closure.has(at) || !statements[at]!.decls.size || labeled(at)) continue;
      const by = users.get(at);
      if (by?.size && [...by].every((j) => closure.has(j)) && adjacent(at, by)) add(at);
    }
  }
  for (const i of closure) region[i] = APP;
  return closure;
}

function extendToLastLabel(statements: Statement[], region: number[], banners: BannerPackage[], app: Set<number>, labels: ReadonlyMap<string, string>): void {
  const starts = banners.map((banner) => statements.findIndex((s) => s.banner === banner));
  banners.forEach((banner, k) => {
    const family = familyOf(banner.name).name;
    const start = starts[k]!;
    const end = starts.filter((i) => i > start).sort((a, b) => a - b)[0] ?? statements.length;
    let last = -1;
    for (let i = start + 1; i < end; i++) if ([...statements[i]!.decls].some((name) => labels.get(name) !== undefined && familyOf(labels.get(name)!).name === family)) last = i;
    for (let i = start + 1; i <= last; i++) {
      const s = statements[i]!;
      if (region[i] !== APP || app.has(i) || isExportList(s.node) || t.isImportDeclaration(s.node)) continue;
      region[i] = k;
    }
  });
}

function claimRemainder(statements: Statement[], region: number[], banners: BannerPackage[], app: Set<number>, labels: ReadonlyMap<string, string>): void {
  const owner = banners.findIndex((b) => b.name === "monaco-editor");
  if (owner < 0) return;
  const first = statements.findIndex((s) => s.banner);
  const ownerOf = new Map<string, number>();
  statements.forEach((s, i) => s.decls.forEach((name) => ownerOf.set(name, i)));
  banners.forEach((banner, k) => {
    if (k === owner) return;
    const family = familyOf(banner.name).name;
    const start = statements.findIndex((s) => s.banner === banner);
    const members = statements.flatMap((_, i) => (region[i] === k ? [i] : []));
    const last = Math.max(start, ...members.filter((i) => [...statements[i]!.decls].some((name) => labels.get(name) !== undefined && familyOf(labels.get(name)!).name === family)));
    const keep = new Set(members.filter((i) => i <= last));
    for (let grew = true; grew; ) {
      grew = false;
      for (const i of keep) {
        for (const name of statements[i]!.uses) {
          const at = ownerOf.get(name);
          if (at !== undefined && region[at] === k && !keep.has(at)) {
            keep.add(at);
            grew = true;
          }
        }
      }
    }
    for (const i of members) if (!keep.has(i) && !app.has(i)) region[i] = owner;
  });
  statements.forEach((s, i) => {
    if (i < first || region[i] !== APP || app.has(i) || isExportList(s.node) || t.isImportDeclaration(s.node)) return;
    region[i] = owner;
  });
}

function wholeLibrary(ast: t.File, labelsOf: () => ReadonlyMap<string, string>): BannerPackage | null {
  const names = ast.program.body.flatMap((s) => (t.isFunctionDeclaration(s) && s.id ? [s.id.name] : t.isVariableDeclaration(s) ? s.declarations.flatMap((d) => (t.isIdentifier(d.id) && t.isFunction(d.init) ? [d.id.name] : [])) : []));
  if (names.length < 20) return null;
  const labels = labelsOf();
  const votes = new Map<string, number>();
  for (const name of names) {
    const label = labels.get(name);
    if (label) votes.set(familyOf(label).name, (votes.get(familyOf(label).name) ?? 0) + 1);
  }
  const [family, count] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!family || !count || count < names.length * 0.4) return null;
  let bootstrap = false;
  t.traverseFast(ast.program, (node) => {
    if (bootstrap || !t.isCallExpression(node)) return;
    const callee = node.callee;
    const method = t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property) ? callee.property.name : null;
    if (method === "getElementById" && t.isStringLiteral(node.arguments[0]) && /^(root|app|__next|__nuxt|main)$/.test(node.arguments[0].value)) bootstrap = true;
    if (method === "mount" && t.isStringLiteral(node.arguments[0]) && /^#/.test(node.arguments[0].value)) bootstrap = true;
    if (t.isIdentifier(callee, { name: "bootstrapApplication" })) bootstrap = true;
  });
  if (bootstrap) return null;
  const known = [...labels.values()].find((pkg) => familyOf(pkg).name === family)!;
  return { ...familyOf(known), specifier: familyOf(known).name };
}

function releaseTails(statements: Statement[], region: number[], banners: BannerPackage[], labels: ReadonlyMap<string, string>): void {
  const owner = new Map<string, number>();
  statements.forEach((s, i) => s.decls.forEach((name) => owner.set(name, i)));
  const scope = (pkg: string) => (pkg.startsWith("@") ? pkg.split("/")[0]! : familyOf(pkg).name);
  const present = (pkg: string) => banners.some((banner) => related(pkg, banner.name) || scope(pkg) === scope(banner.name));
  const lastOwn = banners.map((banner, k) => {
    let last = -1;
    statements.forEach((s, i) => {
      if (region[i] === k && (s.banner === banner || [...s.decls].some((name) => labels.has(name) && present(labels.get(name)!)))) last = i;
    });
    return last;
  });
  const candidate = (i: number) => {
    const k = region[i]!;
    return k >= 0 && INFERRED.has(banners[k]!) && i > lastOwn[k]! && !statements[i]!.banner && ![...statements[i]!.decls].some((name) => labels.has(name)) && !isExportList(statements[i]!.node);
  };
  const needed = new Set<number>();
  const keep = (i: number) => region[i]! >= 0 && (!candidate(i) || needed.has(i));
  const queue = statements.flatMap((_, i) => (keep(i) ? [i] : []));
  for (let grew = true; grew; ) {
    grew = false;
    while (queue.length) {
      const i = queue.pop()!;
      for (const name of statements[i]!.uses) {
        const at = owner.get(name);
        if (at === undefined || needed.has(at) || !candidate(at)) continue;
        needed.add(at);
        queue.push(at);
      }
    }
    statements.forEach((s, i) => {
      if (!candidate(i) || needed.has(i)) return;
      if ([...s.writes].some((name) => owner.has(name) && keep(owner.get(name)!))) {
        needed.add(i);
        queue.push(i);
        grew = true;
      }
    });
  }
  statements.forEach((_, i) => {
    if (candidate(i) && !needed.has(i)) region[i] = APP;
  });
}

function inlineImportAliases(ast: t.File): void {
  traverse(ast, {
    Program(program) {
      for (const stmt of program.get("body")) {
        if (!stmt.isVariableDeclaration() || stmt.node.declarations.length !== 1) continue;
        const decl = stmt.node.declarations[0]!;
        if (!t.isIdentifier(decl.id) || !t.isIdentifier(decl.init)) continue;
        const source = decl.init.name;
        const target = program.scope.getBinding(source);
        const alias = program.scope.getBinding(decl.id.name);
        if (!target || !alias || !alias.constant || target.kind !== "module" || !target.path.isImportNamespaceSpecifier()) continue;
        if (alias.referencePaths.some((ref) => ref.parentPath?.isExportSpecifier() || ref.scope.getBinding(source) !== target)) continue;
        for (const ref of alias.referencePaths) ref.replaceWith(t.identifier(source));
        stmt.remove();
      }
      program.scope.crawl();
      program.stop();
    },
  });
}

function isExportList(node: t.Node): boolean {
  return t.isExportNamedDeclaration(node) && !node.declaration && !node.source;
}

export interface HoistedLabel {
  package: string;
  name: string | null;
}

const RESERVED_NAMES = /^(do|if|in|for|let|new|try|var|case|else|enum|eval|this|void|with|await|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof|undefined|NaN|Infinity)$/;

function renameBinding(binding: NonNullable<ReturnType<NodePath["scope"]["getBinding"]>>, from: string, to: string): void {
  const rename = (id: t.Identifier, parent: t.Node | null | undefined) => {
    if (t.isObjectProperty(parent) && parent.shorthand && (parent.value === id || parent.key === id)) {
      parent.shorthand = false;
      parent.key = t.identifier(from);
      parent.value = id;
    }
    if (t.isExportSpecifier(parent) && parent.local === id && (parent.exported === id || (t.isIdentifier(parent.exported) && parent.exported.name === from))) parent.exported = t.identifier(from);
    id.name = to;
  };
  rename(binding.identifier, binding.path.isVariableDeclarator() ? binding.path.node : binding.path.parent);
  for (const ref of binding.referencePaths) if (t.isIdentifier(ref.node)) rename(ref.node, ref.parent);
  for (const violation of binding.constantViolations) {
    const ids = violation.getBindingIdentifiers() as Record<string, t.Identifier | t.Identifier[]>;
    const found = ids[from];
    for (const id of Array.isArray(found) ? found : found ? [found] : []) id.name = to;
  }
}

function nameLibraryLocals(ast: t.File, statements: Statement[], region: number[], banners: BannerPackage[], names: ReadonlyMap<string, HoistedLabel>): void {
  const at = new Map<string, number>();
  statements.forEach((s, i) => s.decls.forEach((name) => at.set(name, i)));
  const proposals = new Map<string, string>();
  const targets = new Map<string, number>();
  for (const [local, label] of names) {
    const owner = at.get(local);
    if (owner === undefined || region[owner]! < 0 || !label.name || label.name === local) continue;
    if (!/^[A-Za-z_$][\w$]{2,}$/.test(label.name) || RESERVED_NAMES.test(label.name)) continue;
    if (familyOf(label.package).name !== familyOf(banners[region[owner]!]!.name).name) continue;
    proposals.set(local, label.name);
    targets.set(label.name, (targets.get(label.name) ?? 0) + 1);
  }
  if (!proposals.size) return;
  const renames = new Map<string, string>();
  traverse(ast, {
    Program(program) {
      for (const [from, to] of proposals) {
        if (targets.get(to) !== 1 || program.scope.hasBinding(to, true) || program.scope.hasGlobal(to)) continue;
        const binding = program.scope.getBinding(from);
        if (!binding || [...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope !== program.scope && ref.scope.hasBinding(to))) continue;
        renameBinding(binding, from, to);
        renames.set(from, to);
      }
      program.stop();
    },
  });
  if (!renames.size) return;
  const swap = (set: Set<string>) => {
    for (const [from, to] of renames) if (set.delete(from)) set.add(to);
  };
  for (const s of statements) {
    swap(s.decls);
    swap(s.uses);
    swap(s.writes);
  }
}

export function splitHoisted(mod: ModuleRecord, labelsFor: (code: string) => ReadonlyMap<string, HoistedLabel>, component: (name: string) => string | null = () => null, siteWords: readonly string[] = []): ModuleRecord[] | null {
  const ast = parseProgram(mod.code);
  if (ast.program.body.some((s) => t.isExportDeclaration(s))) {
    const whole = wholeLibrary(ast, () => new Map([...labelsFor(mod.code)].map(([name, label]) => [name, label.package] as const)));
    if (whole) return [{ ...mod, origin: "library", package: whole }];
    if (ast.program.body.some((s) => t.isExportDeclaration(s) && !isExportList(s))) return null;
  }
  ast.program.body = flatten(ast.program.body).filter((stmt) => !isPreloadPolyfill(mod.code.slice(stmt.start ?? 0, stmt.end ?? 0), stmt));
  inlineImportAliases(ast);
  const { statements, imports } = analyze(ast);
  const found = labelsFor(mod.code);
  const labels = new Map([...found].map(([name, label]) => [name, label.package] as const));
  const named = new Map<string, string>();
  for (const s of statements) {
    const decl = t.isVariableDeclaration(s.node) && s.node.declarations.length === 1 ? s.node.declarations[0]! : null;
    const object = decl && t.isIdentifier(decl.id) && t.isObjectExpression(decl.init) ? decl.init : null;
    const nameProp = object?.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "name" }) && t.isStringLiteral(p.value) && /^[A-Z]/.test(p.value.value));
    if (decl && nameProp && object!.properties.some((p) => t.isObjectProperty(p) && t.isIdentifier(p.key) && /^(compatConfig|inheritAttrs)$/.test(p.key.name))) named.set((decl.id as t.Identifier).name, (nameProp.value as t.StringLiteral).value);
  }
  const componentLabels = new Set<string>();
  for (const s of statements) {
    const name = componentName(s.node, named);
    const pkg = name ? component(name) : null;
    if (pkg) {
      for (const decl of s.decls) {
        if (!labels.has(decl)) labels.set(decl, pkg);
        componentLabels.add(decl);
      }
    }
  }
  markClusters(statements, labels, componentLabels);
  const bannered = new Set(statements.flatMap((s) => (s.banner ? [familyOf(s.banner.name).name] : [])));
  let current: string | null = null;
  for (const s of statements) {
    if (s.banner) {
      current = familyOf(s.banner.name).name;
      continue;
    }
    const decl = [...s.decls].find((name) => componentLabels.has(name));
    const pkg = decl ? labels.get(decl) : undefined;
    if (!pkg || bannered.has(familyOf(pkg).name) || familyOf(pkg).name === current || (current && related(pkg, current))) continue;
    s.banner = inferredBanner(pkg);
    current = familyOf(pkg).name;
    bannered.add(current);
  }
  const first = statements.findIndex((s) => s.banner);
  if (first < 0) return null;
  const owners = new Map<string, number>();
  statements.forEach((s, i) => s.decls.forEach((name) => owners.set(name, i)));
  const { region, banners } = assignRegions(statements, labels, owners);
  statements.forEach((s, i) => {
    if (isExportList(s.node)) region[i] = APP;
  });
  const app = releaseAppCode(statements, region, banners, labels, component, siteWords);
  extendToLastLabel(statements, region, banners, app, labels);
  claimRemainder(statements, region, banners, app, labels);
  attachGlue(statements, region, owners);
  helpersFor(statements, region, first);
  const labeledAt = (i: number) => [...statements[i]!.decls].some((name) => labels.has(name));
  if (!enforce(statements, region, labeledAt)) return null;
  const settled = [...region];
  releaseTails(statements, region, banners, labels);
  if (!enforce(statements, region, labeledAt)) region.splice(0, region.length, ...settled);
  const groups = [...new Set(region)].filter((g) => g !== APP);
  nameReexports(ast, statements, region);
  if (!groups.some((g) => g >= 0)) return null;
  nameLibraryLocals(ast, statements, region, banners, found);

  const idOf = new Map<number, string>([[APP, mod.id], [HELPERS, `${mod.id}~helpers`]]);
  const used = new Set<string>();
  for (const g of groups.filter((g) => g >= 0)) {
    let id = `${mod.id}~${slug(banners[g]!.specifier)}`;
    for (let n = 2; used.has(id); n++) id = `${mod.id}~${slug(banners[g]!.specifier)}-${n}`;
    used.add(id);
    idOf.set(g, id);
  }
  const owner = new Map<string, number>();
  statements.forEach((s, i) => s.decls.forEach((name) => owner.set(name, region[i]!)));
  const importsOf = new Map<number, Map<number, Set<string>>>();
  const exportsOf = new Map<number, Set<string>>();
  const externalOf = new Map<number, Set<string>>();
  statements.forEach((s, i) => {
    const mine = region[i]!;
    for (const name of s.uses) {
      if (imports.has(name)) {
        if (!externalOf.has(mine)) externalOf.set(mine, new Set());
        externalOf.get(mine)!.add(name);
        continue;
      }
      const theirs = owner.get(name);
      if (theirs === undefined || theirs === mine) continue;
      if (!importsOf.has(mine)) importsOf.set(mine, new Map());
      const from = importsOf.get(mine)!;
      if (!from.has(theirs)) from.set(theirs, new Set());
      from.get(theirs)!.add(name);
      if (!exportsOf.has(theirs)) exportsOf.set(theirs, new Set());
      exportsOf.get(theirs)!.add(name);
    }
  });

  const originalImports = ast.program.body.filter((s): s is t.ImportDeclaration => t.isImportDeclaration(s));
  const build = (group: number): string => {
    const body: t.Statement[] = [];
    if (group === APP) body.push(...originalImports);
    else {
      const bySource = new Map<string, t.ImportDeclaration["specifiers"]>();
      for (const name of externalOf.get(group) ?? []) {
        const info = imports.get(name)!;
        const spec = info.imported === null ? t.importNamespaceSpecifier(t.identifier(name)) : info.imported === "default" ? t.importDefaultSpecifier(t.identifier(name)) : t.importSpecifier(t.identifier(name), t.identifier(info.imported));
        bySource.set(info.source, [...(bySource.get(info.source) ?? []), spec]);
      }
      for (const [source, specs] of bySource) body.push(t.importDeclaration(specs, t.stringLiteral(source)));
    }
    for (const [from, names] of importsOf.get(group) ?? []) {
      body.push(t.importDeclaration([...names].sort().map((name) => t.importSpecifier(t.identifier(name), t.identifier(name))), t.stringLiteral(`./${moduleFileName(idOf.get(from)!)}`)));
    }
    statements.forEach((s, i) => {
      if (region[i] === group && !t.isImportDeclaration(s.node)) body.push(s.node);
    });
    const exported = exportsOf.get(group);
    const specifiers = [...(exported ?? [])].sort().map((name) => t.exportSpecifier(t.identifier(name), t.identifier(name)));
    if (group >= 0) {
      const names = new Set(specifiers.map((s) => (s.exported as t.Identifier).name));
      for (const s of statements) {
        if (!isExportList(s.node)) continue;
        for (const spec of (s.node as t.ExportNamedDeclaration).specifiers) {
          if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported) || owner.get(spec.local.name) !== group || names.has(spec.exported.name) || spec.exported.name === spec.local.name) continue;
          names.add(spec.exported.name);
          specifiers.push(t.exportSpecifier(t.identifier(spec.local.name), t.identifier(spec.exported.name)));
        }
      }
    }
    if (specifiers.length) body.push(t.exportNamedDeclaration(null, specifiers));
    return print(t.file(t.program(body)));
  };

  const depsOf = (group: number) => [...(importsOf.get(group)?.keys() ?? [])].map((g) => idOf.get(g)!);
  const out: ModuleRecord[] = [];
  for (const group of [HELPERS, ...groups.filter((g) => g >= 0).sort((a, b) => a - b)]) {
    if (!region.includes(group)) continue;
    const banner = group >= 0 ? banners[group]! : null;
    const code = build(group);
    const version = banner && (banner.version ?? /\bversion\s*[=:]\s*"(\d+\.\d+\.\d+)[^"]*"/.exec(code)?.[1]);
    out.push({
      id: idOf.get(group)!,
      namespace: mod.namespace,
      origin: banner ? "library" : "app",
      nameHint: banner ? banner.specifier : "commonjsHelpers",
      ...(banner ? { package: version ? { ...banner, version } : banner } : {}),
      chunkUrl: mod.chunkUrl,
      code,
      deps: depsOf(group),
    });
  }
  out.push({ ...mod, code: build(APP), deps: [...new Set([...mod.deps, ...depsOf(APP)])] });
  return out;
}
