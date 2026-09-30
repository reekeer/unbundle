import type { ChunkParseResult, ModuleRecord } from "../types.ts";
import { buildModule, functionDeclarations, levelOf, literalId, snippetOf, dynamicImport, hoistImport, isFactory, literalKey, moduleSpecifier, parseProgram, print, renameParam, requireCall, t, traverse, type NodePath, type RewriteState } from "./ast.ts";

type Factory = t.FunctionExpression | t.ArrowFunctionExpression;

export interface TurbopackChunk {
  chunkPath: string | null;
  shape: string;
  containers: number;
  runtime: { otherChunks: string[]; runtimeModuleIds: string[] } | null;
  factories: Array<{ ids: string[]; factory: Factory }>;
  skipped: Array<{ id: string; reason: string }>;
  notes: string[];
}

const CHUNK_GLOBAL = /TURBOPACK/;

export function parseTurbopackChunk(code: string): TurbopackChunk | null {
  if (!CHUNK_GLOBAL.test(code)) return null;
  const ast = parseProgram(code);
  const named = functionDeclarations(ast);
  const chunk: TurbopackChunk = { chunkPath: null, shape: "unknown", containers: 0, runtime: null, factories: [], skipped: [], notes: [] };

  traverse(ast, {
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (!t.isMemberExpression(callee) || literalKey(callee.property) !== "push" || path.getFunctionParent()) return;
      if (!CHUNK_GLOBAL.test(print(callee.object))) return;
      chunk.containers++;
      const payload = args[0];
      if (!t.isArrayExpression(payload)) {
        chunk.notes.push(`unknown TURBOPACK.push payload: ${snippetOf(payload ?? path.node)}`);
        return;
      }
      const [head, ...rest] = payload.elements;
      if (t.isStringLiteral(head)) chunk.chunkPath = head.value;
      collect(rest, chunk, named);
    },
  });
  return chunk.containers ? chunk : null;
}

function collect(elements: Array<t.Node | null>, into: TurbopackChunk, named: Map<string, t.FunctionExpression>): void {
  let pending: string[] = [];
  for (const el of elements) {
    if (!el) continue;
    if (t.isNumericLiteral(el) || t.isStringLiteral(el)) {
      pending.push(String(el.value));
      continue;
    }
    const factory: Factory | null = isFactory(el) ? el : t.isIdentifier(el) && named.has(el.name) ? named.get(el.name)! : null;
    if (factory) {
      if (pending.length) into.factories.push({ ids: pending, factory });
      else into.notes.push(`factory without module id: ${snippetOf(el)}`);
      into.shape = "turbopack-flat";
      pending = [];
    } else if (t.isObjectExpression(el)) {
      const runtime = readRuntime(el);
      if (runtime) {
        into.runtime = runtime;
        into.shape = "turbopack-runtime";
      } else {
        into.shape = "turbopack-object";
        collectObject(el, into, named);
      }
    } else {
      into.skipped.push({ id: pending.join(",") || "?", reason: `unexpected ${el.type} in TURBOPACK.push` });
      pending = [];
    }
  }
  for (const id of pending) into.skipped.push({ id, reason: "module id without factory" });
}

function collectObject(obj: t.ObjectExpression, into: TurbopackChunk, named: Map<string, t.FunctionExpression>): void {
  for (const prop of obj.properties) {
    const id = t.isObjectProperty(prop) || t.isObjectMethod(prop) ? literalKey(prop.key) : null;
    if (id === null) {
      into.skipped.push({ id: "?", reason: `unexpected ${prop.type} in module map` });
      continue;
    }
    if (t.isObjectMethod(prop)) into.factories.push({ ids: [id], factory: t.functionExpression(null, prop.params, prop.body, prop.generator, prop.async) });
    else if (isFactory((prop as t.ObjectProperty).value)) into.factories.push({ ids: [id], factory: (prop as t.ObjectProperty).value as Factory });
    else if (t.isIdentifier((prop as t.ObjectProperty).value) && named.has(((prop as t.ObjectProperty).value as t.Identifier).name)) {
      into.factories.push({ ids: [id], factory: named.get(((prop as t.ObjectProperty).value as t.Identifier).name)! });
    } else into.skipped.push({ id, reason: `module value is ${(prop as t.ObjectProperty).value.type}` });
  }
}

function readRuntime(obj: t.ObjectExpression): TurbopackChunk["runtime"] {
  const get = (name: string) =>
    obj.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === name)?.value;
  const otherChunks = get("otherChunks");
  const runtimeModuleIds = get("runtimeModuleIds");
  if (!t.isArrayExpression(otherChunks) && !t.isArrayExpression(runtimeModuleIds)) return null;
  const strings = (node: t.Node | undefined) =>
    t.isArrayExpression(node) ? node.elements.map((e) => literalKey(e)).filter((e): e is string => e !== null) : [];
  return { otherChunks: strings(otherChunks), runtimeModuleIds: strings(runtimeModuleIds) };
}

const IMPORTERS = new Set(["i", "r"]);

export function rewriteTurbopackFactory(state: RewriteState): void {
  const { fn } = state;
  const ctxName = renameParam(fn, 0, "__turbopack_context__");
  renameParam(fn, 1, "module");
  renameParam(fn, 2, "exports");
  if (!ctxName) return;
  const binding = fn.scope.getBinding(ctxName);
  if (!binding) return;

  for (const ref of binding.referencePaths) {
    const member = ref.parentPath;
    if (!member?.isMemberExpression() || member.node.object !== ref.node) continue;
    const method = literalKey(member.node.property);
    const call = member.parentPath;
    if (!method || !call?.isCallExpression() || call.node.callee !== member.node) continue;
    const args = call.node.arguments;

    if (IMPORTERS.has(method)) {
      const id = literalId(args[0]);
      if (id === null) continue;
      const declarator = call.parentPath;
      if (declarator?.isVariableDeclarator() && declarator.node.init === call.node && hoistImport(state, declarator, id)) continue;
      state.deps.add(id);
      call.replaceWith(requireCall(id));
    } else if (method === "A") {
      const id = literalId(args[0]);
      if (id === null) continue;
      state.deps.add(id);
      call.replaceWith(dynamicImport(id));
    } else if (method === "s" && t.isArrayExpression(args[0])) {
      collectEsmExports(state, args[0]);
      removeCall(call);
    } else if (method === "v" && args[0] && t.isExpression(args[0])) {
      rewriteExportValue(state, call, args[0]);
    }
  }
}

function removeCall(call: NodePath<t.CallExpression>): void {
  if (call.parentPath?.isExpressionStatement()) call.parentPath.remove();
  else call.replaceWith(t.identifier("undefined"));
}

function collectEsmExports(state: RewriteState, list: t.ArrayExpression): void {
  const els = list.elements;
  for (let i = 0; i < els.length; ) {
    const name = literalKey(els[i]);
    if (name === null || !t.isStringLiteral(els[i])) {
      i++;
      continue;
    }
    const next = els[i + 1];
    let value: t.Expression | null = null;
    if (t.isNumericLiteral(next, { value: 0 })) {
      const raw = els[i + 2];
      value = raw && t.isExpression(raw) ? raw : null;
      i += 3;
    } else if (isFunction(next)) {
      value = getterBody(next);
      i += 2;
      if (isFunction(els[i]) && !t.isStringLiteral(els[i])) i++;
    } else {
      i++;
      continue;
    }
    if (value) state.exports.push(t.isIdentifier(value) ? { exported: name, local: value.name } : { exported: name, value });
  }
}

function isFunction(node: t.Node | null | undefined): node is t.ArrowFunctionExpression | t.FunctionExpression {
  return t.isArrowFunctionExpression(node) || t.isFunctionExpression(node);
}

function getterBody(node: t.ArrowFunctionExpression | t.FunctionExpression): t.Expression | null {
  if (t.isExpression(node.body)) return node.body;
  const ret = node.body.body.length === 1 ? node.body.body[0] : undefined;
  return t.isReturnStatement(ret) ? (ret.argument ?? null) : null;
}

function rewriteExportValue(state: RewriteState, call: NodePath<t.CallExpression>, value: t.Expression): void {
  const target = lazyLoaderTarget(value);
  if (target !== null && call.parentPath?.isExpressionStatement()) {
    state.deps.add(target);
    call.parentPath.replaceWith(t.exportAllDeclaration(t.stringLiteral(moduleSpecifier(target))));
    return;
  }
  call.replaceWith(t.assignmentExpression("=", t.memberExpression(t.identifier("module"), t.identifier("exports")), value));
}

function lazyLoaderTarget(value: t.Expression): string | null {
  if (!t.isArrowFunctionExpression(value) && !t.isFunctionExpression(value)) return null;
  const param = value.params[0];
  if (value.params.length !== 1 || !t.isIdentifier(param)) return null;
  let target: string | null = null;
  t.traverseFast(value.body, (node) => {
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: param.name })) {
      const id = literalId(node.arguments[0]);
      if (id !== null) target = id;
    }
  });
  return target;
}

export function isTurbopackChunk(code: string): boolean {
  return /TURBOPACK/.test(code);
}

export function readTurbopackRuntime(code: string): { otherChunks: string[] } | null {
  const chunk = parseTurbopackChunk(code);
  return chunk?.runtime ?? null;
}

export function unpackTurbopackChunk(code: string, chunkUrl: string): ChunkParseResult | null {
  const chunk = parseTurbopackChunk(code);
  if (!chunk) return null;
  const modules: ModuleRecord[] = [];
  for (const { ids, factory } of chunk.factories) {
    const [primary, ...aliases] = ids as [string, ...string[]];
    try {
      const built = buildModule(factory, rewriteTurbopackFactory);
      modules.push({ id: primary, namespace: "turbopack", chunkUrl, code: built.code, deps: built.deps });
    } catch (err) {
      chunk.skipped.push({ id: primary, reason: `rewrite failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    for (const alias of aliases) {
      modules.push({ id: alias, namespace: "turbopack", chunkUrl, code: `export * from "${moduleSpecifier(primary)}";\n`, deps: [primary] });
    }
  }
  const problems = chunk.skipped.length + chunk.notes.length;
  return {
    format: chunk.runtime ? "turbopack-runtime" : "turbopack",
    chunkIds: chunk.chunkPath ? [chunk.chunkPath] : [],
    modules,
    diagnostics: {
      level: chunk.runtime && !problems ? "full" : levelOf(chunk.containers, modules.length, problems),
      shape: chunk.shape,
      containers: chunk.containers,
      recognized: modules.length,
      skipped: chunk.skipped,
      notes: chunk.notes,
    },
  };
}
