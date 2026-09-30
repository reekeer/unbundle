import { posix } from "node:path";
import { deminifyCode } from "../refine/deminify.ts";
import type { ChunkParseResult, ModuleRecord } from "../types.ts";
import { buildModule, dynamicImport, isFactory, literalKey, moduleSpecifier, parseProgram, print, renameParam, t, traverse, type NodePath, type RewriteState } from "./ast.ts";

type Factory = t.FunctionExpression | t.ArrowFunctionExpression;

interface Wrapper {
  name: string;
  id: string;
  factory: Factory;
  order: "exports-module" | "module-exports";
}

const transpiler = new Bun.Transpiler({ loader: "js" });

export function chunkStem(url: string): string {
  const file = new URL(url).pathname.split("/").pop() ?? "chunk";
  return file.replace(/\.(m?js|cjs)$/i, "") || "chunk";
}

export function containerBody(ast: t.File): t.Statement[] {
  const body = ast.program.body;
  const code = body.filter((s) => !t.isEmptyStatement(s));
  if (code.length === 1 && t.isExpressionStatement(code[0])) {
    let expr = code[0].expression;
    if (t.isUnaryExpression(expr)) expr = expr.argument;
    if (t.isCallExpression(expr) && (t.isArrowFunctionExpression(expr.callee) || t.isFunctionExpression(expr.callee)) && t.isBlockStatement(expr.callee.body)) {
      return expr.callee.body.body;
    }
  }
  return body;
}

interface OrderEvidence {
  cjs: boolean;
  order: Wrapper["order"] | null;
}

function paramOrder(factory: Factory): OrderEvidence {
  const params = factory.params.filter((p): p is t.Identifier => t.isIdentifier(p));
  if (params.length !== factory.params.length || params.length === 0 || params.length > 2) return { cjs: false, order: null };
  let usesExportsOf: string | null = null;
  let assignsTo = false;
  t.traverseFast(factory.body, (node) => {
    if (t.isMemberExpression(node) && t.isIdentifier(node.object) && literalKey(node.property) === "exports") {
      const owner = params.find((p) => p.name === (node.object as t.Identifier).name);
      if (owner) usesExportsOf = owner.name;
    }
    if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left) && params.some((p) => t.isIdentifier((node.left as t.MemberExpression).object, { name: p.name }))) assignsTo = true;
  });
  if (!usesExportsOf && !assignsTo) return { cjs: false, order: null };
  if (!usesExportsOf) return { cjs: true, order: null };
  return { cjs: true, order: params.length === 1 || usesExportsOf === params[0]!.name ? "module-exports" : "exports-module" };
}

function findWrappers(statements: t.Statement[], prefix: string): Map<string, Wrapper> {
  const byCallee = new Map<string, Array<{ name: string; factory: Factory }>>();
  for (const stmt of statements) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const decl of stmt.declarations) {
      if (!t.isIdentifier(decl.id) || !t.isCallExpression(decl.init) || decl.init.arguments.length !== 1) continue;
      const factory = decl.init.arguments[0];
      if (!isFactory(factory)) continue;
      const callee = print(decl.init.callee);
      if (!/^[\w$.]+$/.test(callee)) continue;
      byCallee.set(callee, [...(byCallee.get(callee) ?? []), { name: decl.id.name, factory }]);
    }
  }
  const wrappers = new Map<string, Wrapper>();
  for (const [callee, entries] of byCallee) {
    const evidence = entries.map((e) => paramOrder(e.factory));
    const cjs = evidence.filter((e) => e.cjs).length;
    if (!cjs || (entries.length < 2 && !/__commonJS|\.cw$/.test(callee))) continue;
    if (cjs * 2 < entries.length) continue;
    const votes = evidence.map((e) => e.order).filter((o): o is Wrapper["order"] => o !== null);
    const groupOrder: Wrapper["order"] = votes.length
      ? votes.filter((o) => o === "module-exports").length * 2 >= votes.length
        ? "module-exports"
        : "exports-module"
      : /\.cw$/.test(callee)
        ? "module-exports"
        : "exports-module";
    for (const entry of entries) {
      const single = entry.factory.params.length === 1;
      wrappers.set(entry.name, { name: entry.name, id: `${prefix}~${entry.name}`, factory: entry.factory, order: single && groupOrder === "module-exports" && !/\.cw$/.test(callee) ? "exports-module" : groupOrder });
    }
  }
  return wrappers;
}

function wrapperCall(node: t.Node | null | undefined, wrappers: Map<string, Wrapper>): Wrapper | null {
  if (!t.isCallExpression(node) || node.arguments.length !== 0 || !t.isIdentifier(node.callee)) return null;
  return wrappers.get(node.callee.name) ?? null;
}

function replaceWrapperCalls(path: NodePath, wrappers: Map<string, Wrapper>, isFree: (p: NodePath, name: string) => boolean, use: (wrapper: Wrapper) => t.Expression): void {
  path.traverse({
    CallExpression(call) {
      const direct = wrapperCall(call.node, wrappers);
      if (direct && isFree(call, direct.name)) {
        call.replaceWith(use(direct));
        return;
      }
      const inner = call.node.arguments[0];
      const wrapped = wrapperCall(inner, wrappers);
      if (wrapped && isFree(call, wrapped.name) && call.node.arguments.length <= 2 && (t.isIdentifier(call.node.callee) || t.isMemberExpression(call.node.callee))) {
        call.replaceWith(use(wrapped));
      }
    },
  });
}

function namespaceLocal(wrapper: Wrapper): string {
  return `${wrapper.name.replace(/[^\w$]/g, "_")}Module`;
}

function wrapperRewriter(wrapper: Wrapper, wrappers: Map<string, Wrapper>) {
  return (state: RewriteState): void => {
    const { fn } = state;
    if (wrapper.order === "module-exports") {
      renameParam(fn, 0, "module");
      renameParam(fn, 1, "exports");
    } else {
      renameParam(fn, 0, "exports");
      renameParam(fn, 1, "module");
    }
    replaceWrapperCalls(fn, wrappers, (p, name) => !p.scope.hasBinding(name), (target) => {
      const local = namespaceLocal(target);
      state.deps.add(target.id);
      state.imports.set(local, moduleSpecifier(target.id));
      return t.identifier(local);
    });
    fn.scope.crawl();
  };
}

export function unpackWrappedBundle(code: string, chunkUrl: string, namespace: string): ChunkParseResult | null {
  const ast = parseProgram(code);
  const stem = chunkStem(chunkUrl);
  const statements = containerBody(ast);
  const wrappers = findWrappers(statements, stem);
  if (!wrappers.size) return null;

  const modules: ModuleRecord[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const wrapper of wrappers.values()) {
    try {
      const built = buildModule(wrapper.factory, wrapperRewriter(wrapper, wrappers));
      modules.push({ id: wrapper.id, namespace, origin: "library", chunkUrl, code: built.code, deps: built.deps });
    } catch (err) {
      skipped.push({ id: wrapper.id, reason: `rewrite failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  for (let i = statements.length - 1; i >= 0; i--) {
    const stmt = statements[i]!;
    if (!t.isVariableDeclaration(stmt)) continue;
    stmt.declarations = stmt.declarations.filter((d) => !(t.isIdentifier(d.id) && wrappers.has(d.id.name)));
    if (!stmt.declarations.length) statements.splice(i, 1);
  }
  const deps = new Set<string>();
  rewriteLazyRequires(statements, deps);
  const require = webpackRequireName(statements);
  let body = statements;
  if (require) {
    const { runtime, rest } = splitRuntime(statements, require);
    const runtimeId = `${stem}~runtime`;
    const runtimeFile = t.file(t.program([...runtime, t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(require), t.identifier("__webpack_require__"))])], [], "module"));
    modules.push({ id: runtimeId, namespace, origin: "library", nameHint: "webpack-runtime", chunkUrl, code: deminifyCode(print(runtimeFile)), deps: [] });
    body = [t.importDeclaration([t.importSpecifier(t.identifier(require), t.identifier("__webpack_require__"))], t.stringLiteral(moduleSpecifier(runtimeId))), ...rest];
    deps.add(runtimeId);
  }
  const entry = t.file(t.program([...body.filter((s) => t.isImportDeclaration(s)), ...body.filter((s) => !t.isImportDeclaration(s))], [], "module"));
  const imports = new Map<string, string>();
  traverse(entry, {
    Program(program) {
      replaceWrapperCalls(program, wrappers, (p, name) => !p.scope.hasBinding(name) || p.scope.getBinding(name)?.scope === program.scope, (target) => {
        deps.add(target.id);
        imports.set(namespaceLocal(target), moduleSpecifier(target.id));
        return t.identifier(namespaceLocal(target));
      });
      program.stop();
    },
  });
  entry.program.body.unshift(...[...imports].map(([local, source]) => t.importDeclaration([t.importNamespaceSpecifier(t.identifier(local))], t.stringLiteral(source))));
  for (const dep of esmDependencies(code)) deps.add(dep);
  modules.push({ id: stem, namespace, origin: "bundle", chunkUrl, code: deminifyCode(print(entry)), deps: [...deps] });

  return {
    format: "cjs-wrappers",
    chunkIds: [stem],
    modules,
    diagnostics: {
      level: skipped.length ? "partial" : "full",
      shape: `cjs-wrappers(${[...new Set([...wrappers.values()].map((w) => w.order))].join(",")})`,
      containers: wrappers.size,
      recognized: modules.length,
      skipped,
      notes: [],
    },
  };
}

export function lazyRequireTarget(then: t.CallExpression): string | null {
  const { callee, arguments: args } = then;
  if (!t.isMemberExpression(callee) || literalKey(callee.property) !== "then" || args.length !== 1) return null;
  let require: string | null = null;
  t.traverseFast(callee.object, (node) => {
    if (!require && t.isCallExpression(node) && t.isMemberExpression(node.callee) && literalKey(node.callee.property) === "e" && t.isIdentifier(node.callee.object)) {
      require = node.callee.object.name;
    }
  });
  if (!require) return null;
  const arg = args[0]!;
  const idOf = (node: t.Node | undefined) => (t.isNumericLiteral(node) ? String(node.value) : t.isStringLiteral(node) ? node.value : null);
  if (t.isCallExpression(arg) && t.isMemberExpression(arg.callee) && literalKey(arg.callee.property) === "bind") {
    const target = arg.callee.object;
    const fn = t.isMemberExpression(target) && literalKey(target.property) === "t" ? target.object : target;
    if (t.isIdentifier(fn, { name: require }) && t.isIdentifier(arg.arguments[0], { name: require })) return idOf(arg.arguments[1]);
  }
  if (t.isArrowFunctionExpression(arg) && arg.params.length === 0 && t.isCallExpression(arg.body)) {
    const call = arg.body;
    const fn = t.isMemberExpression(call.callee) && literalKey(call.callee.property) === "t" ? call.callee.object : call.callee;
    if (t.isIdentifier(fn, { name: require })) return idOf(call.arguments[0]);
  }
  return null;
}

const RUNTIME_PROPS = /^(m|c|cw|d|o|r|n|t|e|f|u|p|l|g|h|a|b|j|O|s|nmd|hmd|nc|miniCssF)$/;

function assignsRuntimeProp(node: t.Node, require: string): boolean {
  let found = false;
  t.traverseFast(node, (child) => {
    if (found || !t.isAssignmentExpression(child) || !t.isMemberExpression(child.left)) return;
    if (t.isIdentifier(child.left.object, { name: require }) && RUNTIME_PROPS.test(literalKey(child.left.property) ?? "")) found = true;
  });
  return found;
}

function webpackRequireName(statements: t.Statement[]): string | null {
  const declared = new Set(statements.flatMap((s) => (t.isFunctionDeclaration(s) && s.id ? [s.id.name] : [])));
  for (const name of declared) {
    if (statements.some((s) => t.isExpressionStatement(s) && assignsRuntimeProp(s, name))) return name;
  }
  return null;
}

function splitRuntime(statements: t.Statement[], require: string): { runtime: t.Statement[]; rest: t.Statement[] } {
  const fn = statements.find((s): s is t.FunctionDeclaration => t.isFunctionDeclaration(s) && s.id?.name === require)!;
  const used = new Set<string>();
  t.traverseFast(fn.body, (node) => {
    if (t.isIdentifier(node)) used.add(node.name);
  });
  const runtime: t.Statement[] = [];
  const rest: t.Statement[] = [];
  for (const stmt of statements) {
    const isRuntime =
      stmt === fn ||
      (t.isVariableDeclaration(stmt) && stmt.declarations.every((d) => t.isIdentifier(d.id) && used.has(d.id.name) && (!d.init || t.isObjectExpression(d.init) || t.isArrayExpression(d.init)))) ||
      (t.isExpressionStatement(stmt) && assignsRuntimeProp(stmt, require) && !statementUsesApp(stmt));
    (isRuntime ? runtime : rest).push(stmt);
  }
  return { runtime, rest };
}

function statementUsesApp(stmt: t.ExpressionStatement): boolean {
  let app = false;
  t.traverseFast(stmt, (node) => {
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && literalKey(node.callee.property) === "render") app = true;
  });
  return app;
}

function rewriteLazyRequires(statements: t.Statement[], deps: Set<string>): void {
  const file = t.file(t.program(statements));
  traverse(file, {
    CallExpression(path) {
      const id = lazyRequireTarget(path.node);
      if (id === null) return;
      deps.add(id);
      path.replaceWith(dynamicImport(id));
    },
  });
}

export function esmDependencies(code: string): string[] {
  try {
    return transpiler
      .scanImports(code)
      .map((i) => i.path)
      .filter((p) => /^\.{1,2}\//.test(p))
      .map((p) => p.split("/").pop()!.replace(/\.(m?js|cjs)$/i, ""));
  } catch {
    return [];
  }
}

export function isEsmChunk(code: string): boolean {
  return /(^|[;\s}])(import\s*[{*\w"'`]|export\s*[{*]|export\s+(default|const|let|var|function|class)\b)/.test(code);
}

export function applyImportMap(code: string, chunkUrl: string, map: ReadonlyMap<string, string>): string {
  if (!map.size) return code;
  const from = new URL(chunkUrl);
  let out = code;
  for (const [specifier, target] of map) {
    if (!out.includes(specifier)) continue;
    const to = new URL(target);
    if (to.origin !== from.origin) continue;
    let relative = posix.relative(posix.dirname(from.pathname), to.pathname);
    if (!relative.startsWith(".")) relative = `./${relative}`;
    const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s*)(["'\`])${quoted}\\2`, "g"), (_, lead: string, quote: string) => `${lead}${quote}${relative}${quote}`);
  }
  return out;
}

export function normalizeChunkSpecifiers(code: string): string {
  if (!/["'`]\.\.?\/[^"'`]*\//.test(code)) return code;
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'`])(\.\.?\/[^"'`]*?)([^/"'`]+\.m?js)\2/g, (whole, lead: string, quote: string, dir: string, file: string) => (dir === "./" ? whole : `${lead}${quote}./${file}${quote}`));
}

export function unpackEsmChunk(code: string, chunkUrl: string, namespace: string): ChunkParseResult | null {
  if (!isEsmChunk(code)) return null;
  code = normalizeChunkSpecifiers(code);
  const stem = chunkStem(chunkUrl);
  return {
    format: "esm",
    chunkIds: [stem],
    modules: [{ id: stem, namespace, origin: "bundle", chunkUrl, code: deminifyCode(code), deps: esmDependencies(code) }],
    diagnostics: { level: "full", shape: "esm-chunk", containers: 1, recognized: 1, skipped: [], notes: [] },
  };
}
