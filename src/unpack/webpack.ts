import type { Asset, ChunkParseResult, ModuleRecord } from "../types.ts";
import { deminifyAst } from "../refine/deminify.ts";
import { chunkStem, containerBody, lazyRequireTarget } from "./wrappers.ts";
import { buildModule, functionDeclarations, levelOf, literalId, snippetOf, dynamicImport, hoistImport, isFactory, literalKey, parseProgram, print, renameParam, requireCall, t, traverse, type NodePath, type RewriteState } from "./ast.ts";

type Factory = t.FunctionExpression | t.ArrowFunctionExpression;

export interface WebpackChunk {
  global: string;
  shape: string;
  chunkIds: string[];
  containers: number;
  factories: Array<{ id: string; factory: Factory }>;
  skipped: Array<{ id: string; reason: string }>;
  notes: string[];
}

const CHUNK_GLOBAL = /webpack(?:Chunk|Jsonp)[\w$]*/;

export function parseWebpackChunk(code: string): WebpackChunk | null {
  if (!CHUNK_GLOBAL.test(code)) return null;
  const ast = parseProgram(code);
  const named = functionDeclarations(ast);
  const chunk: WebpackChunk = { global: "webpack", shape: "unknown", chunkIds: [], containers: 0, factories: [], skipped: [], notes: [] };

  traverse(ast, {
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (!t.isMemberExpression(callee) || literalKey(callee.property) !== "push" || path.getFunctionParent()) return;
      const global = CHUNK_GLOBAL.exec(print(callee.object))?.[0];
      if (!global) return;
      chunk.containers++;
      chunk.global = global;
      const payload = args[0];
      const [ids, modules, extra] = t.isArrayExpression(payload) ? payload.elements : [];
      if (!t.isArrayExpression(ids) || !(t.isObjectExpression(modules) || t.isArrayExpression(modules))) {
        chunk.notes.push(`unknown ${global}.push payload: ${snippetOf(payload ?? path.node)}`);
        return;
      }
      chunk.shape = `${global.startsWith("webpackJsonp") ? "webpack4" : "webpack5"}-jsonp${t.isArrayExpression(extra) ? "+entries" : ""}${t.isArrayExpression(modules) ? "+array" : ""}`;
      chunk.chunkIds.push(...ids.elements.map((e) => literalId(e)).filter((e): e is string => e !== null));
      collectFactories(modules, named, chunk);
    },
  });
  return chunk.containers ? chunk : null;
}

function collectFactories(modules: t.ObjectExpression | t.ArrayExpression, named: Map<string, t.FunctionExpression>, chunk: WebpackChunk): void {
  const take = (id: string, value: t.Node | null | undefined) => {
    if (isFactory(value)) chunk.factories.push({ id, factory: value });
    else if (t.isIdentifier(value) && named.has(value.name)) chunk.factories.push({ id, factory: named.get(value.name)! });
    else chunk.skipped.push({ id, reason: `module value is ${value?.type ?? "empty"}` });
  };
  if (t.isArrayExpression(modules)) {
    modules.elements.forEach((el, index) => {
      if (el) take(String(index), el);
    });
    return;
  }
  for (const prop of modules.properties) {
    if (t.isObjectMethod(prop) && prop.kind === "method") {
      const id = literalKey(prop.key);
      if (id !== null) chunk.factories.push({ id, factory: t.functionExpression(null, prop.params, prop.body, prop.generator, prop.async) });
    } else if (t.isObjectProperty(prop)) {
      const id = literalKey(prop.key);
      if (id !== null) take(id, prop.value);
      else chunk.skipped.push({ id: "?", reason: `computed module key ${snippetOf(prop.key)}` });
    } else {
      chunk.skipped.push({ id: "?", reason: `unexpected ${prop.type} in module map` });
    }
  }
}

export function rewriteWebpackFactory(state: RewriteState): void {
  const { fn } = state;
  renameParam(fn, 0, "module");
  const exportsName = renameParam(fn, 1, "exports");
  const requireName = renameParam(fn, 2, "__webpack_require__");
  if (!requireName) return;
  const binding = fn.scope.getBinding(requireName);
  if (!binding) return;

  for (const ref of binding.referencePaths) {
    if (ref.node.type !== "Identifier" || !ref.parentPath) continue;
    const parent = ref.parentPath;

    if (parent.isCallExpression() && parent.node.callee === ref.node) {
      const id = literalId(parent.node.arguments[0]);
      if (id === null) continue;
      const declarator = parent.parentPath;
      if (declarator?.isVariableDeclarator() && declarator.node.init === parent.node && hoistImport(state, declarator, id)) continue;
      state.deps.add(id);
      parent.replaceWith(requireCall(id));
      continue;
    }

    if (!parent.isMemberExpression() || parent.node.object !== ref.node) continue;
    const method = literalKey(parent.node.property);
    if (method === "t" && rewriteNamespaceBind(state, parent, requireName)) continue;
    if (method === "e") {
      const then = parent.parentPath?.parentPath?.parentPath;
      const lazyId = then?.isCallExpression() ? lazyRequireTarget(then.node) : null;
      if (lazyId !== null && then) {
        state.deps.add(lazyId);
        then.replaceWith(dynamicImport(lazyId));
        continue;
      }
    }
    const call = parent.parentPath;
    if (!call?.isCallExpression() || call.node.callee !== parent.node) continue;
    const args = call.node.arguments;

    if (method === "r" && isRef(args[0], exportsName) && call.parentPath?.isExpressionStatement()) {
      call.parentPath.remove();
    } else if (method === "d" && isRef(args[0], exportsName) && t.isObjectExpression(args[1])) {
      collectDefineExports(state, args[1]);
      if (call.parentPath?.isExpressionStatement()) call.parentPath.remove();
      else call.replaceWith(t.identifier("undefined"));
    } else if (method === "bind" && isRef(args[0], requireName)) {
      const id = literalId(args[1]);
      if (id !== null) rewriteLazyImport(state, call, id);
    }
  }
}

function rewriteNamespaceBind(state: RewriteState, member: NodePath<t.MemberExpression>, requireName: string): boolean {
  const bindMember = member.parentPath;
  if (!bindMember?.isMemberExpression() || literalKey(bindMember.node.property) !== "bind") return false;
  const call = bindMember.parentPath;
  if (!call?.isCallExpression() || call.node.callee !== bindMember.node) return false;
  const [self, idNode] = call.node.arguments;
  const id = literalId(idNode);
  if (!isRef(self, requireName) || id === null) return false;
  rewriteLazyImport(state, call, id);
  return true;
}

function isRef(node: t.Node | undefined, name: string | null): boolean {
  return name !== null && t.isIdentifier(node, { name });
}

function collectDefineExports(state: RewriteState, getters: t.ObjectExpression): void {
  for (const prop of getters.properties) {
    let exported: string | null = null;
    let value: t.Expression | null = null;
    if (t.isObjectProperty(prop) && (t.isArrowFunctionExpression(prop.value) || t.isFunctionExpression(prop.value))) {
      exported = literalKey(prop.key);
      value = getterValue(prop.value.body);
    } else if (t.isObjectMethod(prop)) {
      exported = literalKey(prop.key);
      value = getterValue(prop.body);
    }
    if (exported === null || !value) continue;
    state.exports.push(t.isIdentifier(value) ? { exported, local: value.name } : { exported, value });
  }
}

function getterValue(body: t.Node): t.Expression | null {
  if (t.isExpression(body)) return body;
  if (t.isBlockStatement(body) && body.body.length === 1 && t.isReturnStatement(body.body[0])) {
    return body.body[0].argument ?? null;
  }
  return null;
}

function rewriteLazyImport(state: RewriteState, bindCall: NodePath<t.CallExpression>, id: string): void {
  state.deps.add(id);
  const thenCall = bindCall.parentPath;
  if (
    thenCall?.isCallExpression() &&
    thenCall.node.arguments[0] === bindCall.node &&
    t.isMemberExpression(thenCall.node.callee) &&
    literalKey(thenCall.node.callee.property) === "then"
  ) {
    thenCall.replaceWith(dynamicImport(id));
    return;
  }
  bindCall.replaceWith(t.arrowFunctionExpression([], dynamicImport(id)));
}

export interface ChunkUrlTemplates {
  script?: (chunkId: string) => string | undefined;
  style?: (chunkId: string) => string | undefined;
  knownIds: string[];
}

type Env = { param: string; id: string };
type Value = string | number | boolean | undefined;

const MAX_DEPTH = 64;

function templateFrom(fn: t.Node | null | undefined, ids: Set<string>): ((id: string) => string | undefined) | null {
  if (!(t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn) || t.isFunctionDeclaration(fn)) || fn.params.length !== 1) return null;
  const param = fn.params[0];
  if (!t.isIdentifier(param)) return null;
  const body = returnedExpression(fn.body);
  if (!body) return null;
  collectLiteralKeys(body, ids);
  return (id: string) => {
    const value = evaluateNode(body, { param: param.name, id }, 0);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
}

function looksLikeChunkPath(fn: t.Function): boolean {
  const body = returnedExpression(fn.body);
  if (!body) return false;
  let hasExtension = false;
  let concatenates = false;
  t.traverseFast(body, (node) => {
    if (t.isStringLiteral(node) && /\.(m?js|css)$/.test(node.value)) hasExtension = true;
    if (t.isBinaryExpression(node, { operator: "+" })) concatenates = true;
  });
  return hasExtension && concatenates;
}

export function readChunkUrlTemplates(code: string): ChunkUrlTemplates | null {
  if (!/\.(u|miniCssF)\s*=|\.p\s*\+|jsonpScriptSrc/.test(code)) return null;
  const ast = parseProgram(code);
  const templates: ChunkUrlTemplates = { knownIds: [] };
  const ids = new Set<string>();
  const legacy: t.Function[] = [];

  traverse(ast, {
    AssignmentExpression(path) {
      const { left, right } = path.node;
      if (!t.isMemberExpression(left)) return;
      const name = literalKey(left.property);
      if (name !== "u" && name !== "miniCssF") return;
      const evaluate = templateFrom(right, ids);
      if (!evaluate) return;
      if (name === "u") templates.script = evaluate;
      else templates.style = evaluate;
    },
    "FunctionDeclaration|FunctionExpression"(path) {
      const fn = path.node as t.Function;
      if (fn.params.length === 1 && looksLikeChunkPath(fn)) legacy.push(fn);
    },
  });

  if (!templates.script) {
    const script = legacy.find((fn) => {
      let js = false;
      t.traverseFast(returnedExpression(fn.body)!, (node) => {
        if (t.isStringLiteral(node) && /\.m?js$/.test(node.value)) js = true;
      });
      return js;
    });
    const evaluate = script ? templateFrom(script, ids) : null;
    if (evaluate) templates.script = evaluate;
  }
  if (!templates.script && !templates.style) return null;
  templates.knownIds = [...ids];
  return templates;
}

function returnedExpression(body: t.Node): t.Expression | null {
  if (t.isExpression(body)) return body;
  if (t.isBlockStatement(body)) {
    const ret = body.body.find((s): s is t.ReturnStatement => t.isReturnStatement(s));
    return ret?.argument ?? null;
  }
  return null;
}

function collectLiteralKeys(node: t.Node, into: Set<string>): void {
  if (t.isObjectExpression(node)) {
    for (const prop of node.properties) {
      if (t.isObjectProperty(prop) && (t.isNumericLiteral(prop.key) || t.isStringLiteral(prop.key))) {
        into.add(String(prop.key.value));
      }
    }
  }
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c === "object") collectLiteralKeys(c as t.Node, into);
    } else if (child && typeof child === "object") collectLiteralKeys(child as t.Node, into);
  }
}

function evaluateNode(node: t.Node, env: Env, depth: number): Value {
  if (depth > MAX_DEPTH) return undefined;
  const next = (n: t.Node) => evaluateNode(n, env, depth + 1);

  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isIdentifier(node)) return node.name === env.param ? env.id : undefined;
  if (t.isParenthesizedExpression(node)) return next(node.expression);
  if (t.isSequenceExpression(node)) return next(node.expressions.at(-1)!);
  if (t.isUnaryExpression(node, { operator: "void" })) return undefined;
  if (t.isUnaryExpression(node, { operator: "!" })) return !next(node.argument);
  if (t.isTemplateLiteral(node)) {
    let out = "";
    node.quasis.forEach((q, i) => {
      out += q.value.cooked ?? q.value.raw;
      const expr = node.expressions[i];
      if (expr) out += String(next(expr) ?? "");
    });
    return out;
  }
  if (t.isBinaryExpression(node)) {
    const left = next(node.left);
    const right = next(node.right);
    switch (node.operator) {
      case "+":
        return typeof left === "number" && typeof right === "number" ? left + right : String(left ?? "") + String(right ?? "");
      case "===":
      case "==":
        return String(left) === String(right);
      case "!==":
      case "!=":
        return String(left) !== String(right);
      default:
        return undefined;
    }
  }
  if (t.isLogicalExpression(node)) {
    const left = next(node.left);
    if (node.operator === "||") return left || next(node.right);
    if (node.operator === "&&") return left && next(node.right);
    return left ?? next(node.right);
  }
  if (t.isConditionalExpression(node)) return next(node.test) ? next(node.consequent) : next(node.alternate);
  if (t.isMemberExpression(node) && t.isObjectExpression(node.object)) {
    const key = node.computed ? next(node.property) : literalKey(node.property);
    if (key === undefined || key === null) return undefined;
    for (const prop of node.object.properties) {
      if (t.isObjectProperty(prop) && literalKey(prop.key) === String(key)) return next(prop.value);
    }
    return undefined;
  }
  return undefined;
}

export function findEnsureChunkIds(code: string): string[] {
  const ids = new Set<string>();
  for (const match of code.matchAll(/\.e\(\s*(\d+|"[^"\\]+")\s*\)/g)) {
    ids.add(match[1]!.replace(/"/g, ""));
  }
  return [...ids];
}

export function isWebpackChunk(code: string): boolean {
  return /webpackChunk|webpackJsonp/.test(code);
}

export function unpackWebpackChunk(code: string, chunkUrl: string): ChunkParseResult | null {
  const chunk = parseWebpackChunk(code);
  if (!chunk) return null;
  const modules: ModuleRecord[] = [];
  for (const { id, factory } of chunk.factories) {
    try {
      const built = buildModule(factory, rewriteWebpackFactory);
      modules.push({ id, namespace: chunk.global, chunkUrl, code: built.code, deps: built.deps });
    } catch (err) {
      chunk.skipped.push({ id, reason: `rewrite failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return {
    format: "webpack-jsonp",
    chunkIds: chunk.chunkIds,
    modules,
    diagnostics: {
      level: levelOf(chunk.containers, modules.length, chunk.skipped.length + chunk.notes.length),
      shape: chunk.shape,
      containers: chunk.containers,
      recognized: modules.length,
      skipped: chunk.skipped,
      notes: chunk.notes,
    },
  };
}

function moduleMap(statements: t.Statement[]): { declarator: t.VariableDeclarator; statement: t.VariableDeclaration; factories: Array<{ id: string; factory: t.FunctionExpression | t.ArrowFunctionExpression }> } | null {
  let best: ReturnType<typeof moduleMap> = null;
  for (const statement of statements) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declarator of statement.declarations) {
      const init = declarator.init;
      if (!t.isObjectExpression(init) || !init.properties.length) continue;
      const factories: Array<{ id: string; factory: t.FunctionExpression | t.ArrowFunctionExpression }> = [];
      const ok = init.properties.every((prop) => {
        const id = (t.isObjectProperty(prop) || t.isObjectMethod(prop)) && !prop.computed ? literalKey(prop.key) : null;
        if (id === null || !/^[\w./~@-]+$/.test(id)) return false;
        if (t.isObjectMethod(prop) && prop.kind === "method" && prop.params.length <= 3) {
          factories.push({ id, factory: t.functionExpression(null, prop.params, prop.body, prop.generator, prop.async) });
          return true;
        }
        if (t.isObjectProperty(prop) && isFactory(prop.value) && prop.value.params.length <= 3) {
          factories.push({ id, factory: prop.value });
          return true;
        }
        return false;
      });
      if (ok && factories.length && (!best || factories.length > best.factories.length)) best = { declarator, statement, factories };
    }
  }
  return best;
}

function requireFunction(statements: t.Statement[]): string | null {
  for (const stmt of statements) {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id || stmt.params.length !== 1) continue;
    const name = stmt.id.name;
    const assigned = statements.some((other) => {
      let hit = false;
      t.traverseFast(other, (node) => {
        if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left) && t.isIdentifier(node.left.object, { name }) && /^(m|c|d|o|r|n|e|u|p|t|g)$/.test(literalKey(node.left.property) ?? "")) hit = true;
      });
      return hit;
    });
    if (assigned) return name;
  }
  return null;
}

function joinDeclarations(statements: t.Statement[]): t.Statement[] {
  const out = [...statements];
  const bare = new Map<string, number>();
  out.forEach((st, i) => {
    if (t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0]!.id) && !st.declarations[0]!.init) bare.set(st.declarations[0]!.id.name, i);
  });
  const mentions = (node: t.Node, name: string) => {
    let hit = false;
    const holder = t.isStatement(node) ? node : t.expressionStatement(node as t.Expression);
    traverse(t.file(t.program([t.cloneNode(holder, true)])), {
      Identifier(path) {
        if (hit || path.node.name !== name) return;
        const lhs = path.parentPath?.isAssignmentExpression() && path.key === "left";
        if ((lhs || path.isReferencedIdentifier()) && !path.scope.getBinding(name)) hit = true;
      },
    });
    return hit;
  };
  for (const [name, declIndex] of bare) {
    const assignments = out.map((st, i) => ({ st, i })).filter(({ st }) => st && mentions(st, name));
    const first = assignments.find(({ i }) => i !== declIndex);
    if (!first) continue;
    const st = first.st;
    if (!t.isExpressionStatement(st) || !t.isAssignmentExpression(st.expression, { operator: "=" }) || !t.isIdentifier(st.expression.left, { name }) || mentions(st.expression.right, name)) continue;
    const reassigned = assignments.some(({ st: other, i }) => i > first.i && t.isExpressionStatement(other) && t.isAssignmentExpression(other.expression) && t.isIdentifier(other.expression.left, { name }));
    const decl = out[declIndex] as t.VariableDeclaration;
    out[first.i] = t.variableDeclaration(reassigned || decl.kind === "var" ? decl.kind : "const", [t.variableDeclarator(t.identifier(name), st.expression.right)]);
    out[declIndex] = t.emptyStatement();
  }
  return out.filter((st) => !t.isEmptyStatement(st));
}

export function unpackBootstrapBundle(code: string, chunkUrl: string, namespace: string): ChunkParseResult | null {
  const ast = parseProgram(code);
  deminifyAst(ast);
  const statements = containerBody(ast);
  const map = moduleMap(statements);
  const require = requireFunction(statements);
  if (!map || !require) return null;
  const modules: ModuleRecord[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const { id, factory } of map.factories) {
    try {
      const built = buildModule(factory, rewriteWebpackFactory);
      modules.push({ id, namespace, chunkUrl, code: built.code, deps: built.deps });
    } catch (err) {
      skipped.push({ id, reason: `rewrite failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  map.statement.declarations = map.statement.declarations.filter((d) => d !== map.declarator);
  const rest = statements.filter((st) => !(st === map.statement && !map.statement.declarations.length));
  const declaredIds = new Map<string, t.Identifier>();
  for (const st of rest) {
    if (t.isVariableDeclaration(st)) for (const d of st.declarations) if (t.isIdentifier(d.id)) declaredIds.set(d.id.name, d.id);
    if (t.isFunctionDeclaration(st) && st.id) declaredIds.set(st.id.name, st.id);
  }
  const top = new Set<t.Node>(rest);
  const refsOf = new Map<t.Statement, Set<string>>(rest.map((st) => [st, new Set<string>()]));
  const assignsOf = new Map<t.Statement, Set<string>>(rest.map((st) => [st, new Set<string>()]));
  const loads = new Set<t.Statement>();
  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      const own = declaredIds.get(name);
      if (!own || path.node === own) return;
      const lhs = path.parentPath?.isAssignmentExpression() && path.key === "left";
      if (!lhs && !path.isReferencedIdentifier()) return;
      const binding = path.scope.getBinding(name);
      if (!binding || binding.identifier !== own) return;
      const holder = path.find((p) => top.has(p.node));
      if (!holder) return;
      const stmt = holder.node as t.Statement;
      refsOf.get(stmt)!.add(name);
      let target: NodePath = path;
      while (target.parentPath?.isMemberExpression() && target.parentPath.node.object === target.node) target = target.parentPath;
      if (target.parentPath?.isAssignmentExpression() && target.parentPath.node.left === target.node) assignsOf.get(stmt)!.add(target === path ? name : `${name}.*`);
      if (name === require && path.parentPath?.isCallExpression() && path.parentPath.node.callee === path.node) {
        const arg = path.parentPath.node.arguments[0];
        if (path.parentPath.node.arguments.length === 1 && (t.isNumericLiteral(arg) || t.isStringLiteral(arg))) loads.add(stmt);
      }
    },
  });
  const runtimeVars = new Set<string>([require]);
  const runtimeSet = new Set<t.Statement>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const st of rest) {
      if (runtimeSet.has(st)) continue;
      const assigned = [...assignsOf.get(st)!];
      const refs = [...refsOf.get(st)!];
      const helper = !t.isVariableDeclaration(st) && refs.some((r) => runtimeVars.has(r)) && refs.every((r) => runtimeVars.has(r) || assigned.some((a) => a.replace(/\.\*$/, "") === r));
      const runtimeLike = (t.isFunctionDeclaration(st) && st.id?.name === require) || assigned.includes(`${require}.*`) || (assigned.length > 0 && assigned.every((a) => runtimeVars.has(a.replace(/\.\*$/, "")))) || helper;
      if (!runtimeLike || (loads.has(st) && !t.isFunctionDeclaration(st))) continue;
      runtimeSet.add(st);
      grew = true;
      for (const name of refsOf.get(st)!) runtimeVars.add(name);
    }
  }
  const usedOutside = (name: string) => rest.some((st) => !runtimeSet.has(st) && !t.isVariableDeclaration(st) && refsOf.get(st)!.has(name));
  const isRuntimeDecl = (st: t.Statement) => t.isVariableDeclaration(st) && st.declarations.every((d) => t.isIdentifier(d.id) && (runtimeVars.has(d.id.name) || !usedOutside(d.id.name)));
  const isRuntime = (st: t.Statement) => isRuntimeDecl(st) || runtimeSet.has(st) || (t.isVariableDeclaration(st) && st.declarations.every((d) => t.isIdentifier(d.id) && runtimeVars.has(d.id.name)));
  const runtime = rest.filter((st) => isRuntime(st));
  const entry = joinDeclarations(rest.filter((st) => !runtime.includes(st)));
  const stem = chunkStem(chunkUrl);
  const runtimeId = `${stem}~runtime`;
  modules.push({ id: runtimeId, namespace, origin: "library", nameHint: "webpack-runtime", chunkUrl, code: print(t.file(t.program(runtime))), deps: [] });
  try {
    const factory = t.functionExpression(null, [t.identifier("module"), t.identifier("exports"), t.identifier(require)], t.blockStatement(entry.map((st) => t.cloneNode(st, true))));
    const built = buildModule(factory, rewriteWebpackFactory);
    modules.push({ id: stem, namespace, origin: "bundle", chunkUrl, code: built.code, deps: built.deps });
  } catch (err) {
    skipped.push({ id: stem, reason: `entry rewrite failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  return {
    format: "webpack-bootstrap",
    chunkIds: [stem],
    modules,
    diagnostics: { level: skipped.length ? "partial" : "full", shape: "webpack-bootstrap(module map)", containers: 1, recognized: modules.length, skipped, notes: [] },
  };
}

const JSONP_HEADER = /webpackChunk\w*\s*=\s*[^;]*?\.push\(\[\[([\d,\s"']+)\]/;

function isScriptAsset(asset: Asset): boolean {
  return asset.ref.type === "script" || asset.ref.type === "module" || /javascript/.test(asset.contentType);
}

export function isWebpackRuntime(asset: Asset): boolean {
  return /\.u\s*=/.test(asset.body) && /webpack(Chunk|Jsonp)/.test(asset.body) && !JSONP_HEADER.test(asset.body.slice(0, 512));
}

export function readPublicPath(code: string): string | null {
  const match = /\b[\w$]+\.p\s*=\s*"([^"]*)"/.exec(code);
  return match && match[1] !== "auto" ? match[1]! : null;
}

export function webpackLazyState(all: ReadonlyMap<string, Asset> | Iterable<Asset>) {
  const knownChunkIds = new Set<string>();
  const requested = new Set<string>();
  let runtime: Asset | undefined;
  const assets = all instanceof Map ? all.values() : (all as Iterable<Asset>);
  for (const asset of assets) {
    if (!isScriptAsset(asset)) continue;
    const header = JSONP_HEADER.exec(asset.body.slice(0, 512));
    if (header) for (const id of header[1]!.split(",")) knownChunkIds.add(id.trim().replace(/["']/g, ""));
    for (const id of findEnsureChunkIds(asset.body)) requested.add(id);
    if (!runtime && isWebpackRuntime(asset)) runtime = asset;
  }
  const templates = runtime ? readChunkUrlTemplates(runtime.body) : null;
  const ids = [...new Set([...requested, ...(templates?.knownIds ?? [])])].filter((id) => !knownChunkIds.has(id));
  const unresolved = [...requested].filter((id) => !knownChunkIds.has(id) && !templates?.script?.(id) && !templates?.style?.(id));
  return { templates, ids, unresolved, runtime, publicPath: runtime ? readPublicPath(runtime.body) : null };
}
