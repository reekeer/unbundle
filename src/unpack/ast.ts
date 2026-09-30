import generateModule from "@babel/generator";
import { parse } from "@babel/parser";
import traverseModule, { type NodePath, type Scope, type Visitor } from "@babel/traverse";
import * as t from "@babel/types";
import { deminifyPath } from "../refine/deminify.ts";
import { safeSegment } from "../output.ts";

export { t };
export type { NodePath, Scope, Visitor };



export const traverse = traverseModule;
const generate = generateModule;

export function parseProgram(code: string): t.File {
  return parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    errorRecovery: true,
    plugins: ["jsx", "decorators-legacy"],
  });
}

export function parseForFile(path: string, code: string): t.File {
  const ts = /\.(c|m)?tsx?$/i.test(path);
  return parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    errorRecovery: true,
    plugins: ts ? ["typescript", ...(/x$/i.test(path) ? (["jsx"] as const) : [])] : ["jsx"],
  });
}

export function print(node: t.Node): string {
  return generate(node, { comments: true, jsescOption: { minimal: true } }).code;
}

export function literalKey(node: t.Node | null | undefined): string | null {
  if (!node) return null;
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isStringLiteral(node)) return node.value;
  if (t.isIdentifier(node)) return node.name;
  return null;
}

export function literalId(node: t.Node | null | undefined): string | null {
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isStringLiteral(node)) return node.value;
  return null;
}

export function isFactory(node: t.Node | null | undefined): node is t.FunctionExpression | t.ArrowFunctionExpression {
  return t.isFunctionExpression(node) || t.isArrowFunctionExpression(node);
}

export const MODULES_DIR = "modules";

export function moduleFileName(id: string): string {
  return `${safeSegment(id.replace(/[\\/]/g, "_"))}.js`;
}

export function moduleSpecifier(id: string): string {
  return `./${moduleFileName(id)}`;
}

export type FactoryPath = NodePath<t.FunctionExpression | t.ArrowFunctionExpression>;

export type ExportSpec =
  | { exported: string; local: string }
  | { exported: string; value: t.Expression };

export interface RewriteState {
  fn: FactoryPath;
  deps: Set<string>;
  imports: Map<string, string>;
  exports: ExportSpec[];
}

export type FactoryRewriter = (state: RewriteState) => void;

export interface BuiltModule {
  code: string;
  deps: string[];
}

export function buildModule(factory: t.FunctionExpression | t.ArrowFunctionExpression, rewrite: FactoryRewriter): BuiltModule {
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(factory, true))]));
  let fnPath: FactoryPath | undefined;
  traverse(file, {
    "FunctionExpression|ArrowFunctionExpression"(path) {
      fnPath = path as FactoryPath;
      path.stop();
    },
  });
  if (!fnPath) throw new Error("factory function not found");
  const fn = fnPath;

  deminifyPath(fn);
  fn.scope.crawl();

  const state: RewriteState = { fn, deps: new Set(), imports: new Map(), exports: [] };
  rewrite(state);
  fn.scope.crawl();

  const body = fn.node.body;
  const statements: t.Statement[] = t.isBlockStatement(body) ? body.body : [t.expressionStatement(body)];
  const directives = t.isBlockStatement(body) ? body.directives.filter((d) => d.value.value !== "use strict") : [];

  const exportStatements = emitExports(fn, statements, state.exports);
  const importStatements = [...state.imports].map(([local, source]) =>
    t.importDeclaration([t.importNamespaceSpecifier(t.identifier(local))], t.stringLiteral(source)),
  );

  const program = t.program([...importStatements, ...statements, ...exportStatements], directives, "module");
  return { code: print(program), deps: [...state.deps] };
}

export function hoistImport(state: RewriteState, declarator: NodePath<t.VariableDeclarator>, id: string): boolean {
  const decl = declarator.parentPath;
  if (!decl?.isVariableDeclaration() || decl.parentPath?.node !== state.fn.node.body) return false;
  if (!t.isIdentifier(declarator.node.id)) return false;
  const local = declarator.node.id.name;
  const binding = state.fn.scope.getBinding(local);
  if (!binding || !binding.constant || state.imports.has(local)) return false;
  state.imports.set(local, moduleSpecifier(id));
  state.deps.add(id);
  if (decl.node.declarations.length === 1) decl.remove();
  else declarator.remove();
  return true;
}

export function requireCall(id: string): t.CallExpression {
  return t.callExpression(t.identifier("require"), [t.stringLiteral(moduleSpecifier(id))]);
}

export function dynamicImport(id: string): t.CallExpression {
  return t.callExpression(t.import(), [t.stringLiteral(moduleSpecifier(id))]);
}

export function renameParam(fn: FactoryPath, index: number, preferred: string): string | null {
  const param = fn.node.params[index];
  if (!t.isIdentifier(param)) return null;
  if (param.name === preferred) return preferred;
  const name = fn.scope.hasBinding(preferred, true) || isGlobalIn(fn.scope, preferred) ? fn.scope.generateUid(preferred) : preferred;
  fn.scope.rename(param.name, name);
  return name;
}

function isGlobalIn(scope: Scope, name: string): boolean {
  return Boolean((scope.getProgramParent() as unknown as { globals: Record<string, unknown> }).globals[name]);
}

function isValidIdentifier(name: string): boolean {
  return t.isValidIdentifier(name, true);
}

function emitExports(fn: FactoryPath, statements: t.Statement[], specs: ExportSpec[]): t.Statement[] {
  const out: t.Statement[] = [];
  const exportCount = new Map<string, number>();
  for (const spec of specs) if ("local" in spec) exportCount.set(spec.local, (exportCount.get(spec.local) ?? 0) + 1);

  for (const spec of specs) {
    if ("value" in spec) {
      out.push(...valueExport(spec.exported, spec.value));
      continue;
    }
    let local = spec.local;
    const binding = fn.scope.getBinding(local);
    const topLevel = binding && statements.includes(topStatementOf(binding.path, fn) as t.Statement);

    if (binding && topLevel && exportCount.get(local) === 1) {
      if (spec.exported !== "default" && spec.exported !== local && isValidIdentifier(spec.exported) && !fn.scope.hasBinding(spec.exported, true) && !isGlobalIn(fn.scope, spec.exported)) {
        fn.scope.rename(local, spec.exported);
        local = spec.exported;
      }
      const stmt = topStatementOf(binding.path, fn) as t.Statement;
      const index = statements.indexOf(stmt);
      if (spec.exported === local && (t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt) || (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1))) {
        statements[index] = t.exportNamedDeclaration(stmt);
        continue;
      }
      if (spec.exported === "default" && (t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt))) {
        statements[index] = t.exportDefaultDeclaration(stmt);
        continue;
      }
    }
    out.push(
      spec.exported === "default"
        ? t.exportDefaultDeclaration(t.identifier(local))
        : t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(local), exportName(spec.exported))]),
    );
  }
  return out;
}

function exportName(name: string): t.Identifier | t.StringLiteral {
  return isValidIdentifier(name) ? t.identifier(name) : t.stringLiteral(name);
}

function valueExport(exported: string, value: t.Expression): t.Statement[] {
  if (exported === "default") {
    if (t.isFunctionExpression(value)) return [t.exportDefaultDeclaration(t.functionDeclaration(value.id, value.params, value.body, value.generator, value.async))];
    if (t.isClassExpression(value)) return [t.exportDefaultDeclaration(t.classDeclaration(value.id, value.superClass, value.body, value.decorators))];
    return [t.exportDefaultDeclaration(value)];
  }
  if (isValidIdentifier(exported)) {
    if (t.isFunctionExpression(value)) {
      return [t.exportNamedDeclaration(t.functionDeclaration(t.identifier(exported), value.params, value.body, value.generator, value.async))];
    }
    if (t.isClassExpression(value)) {
      return [t.exportNamedDeclaration(t.classDeclaration(t.identifier(exported), value.superClass, value.body, value.decorators))];
    }
    return [t.exportNamedDeclaration(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(exported), value)]))];
  }
  const local = t.identifier(`__export_${exported.replace(/\W/g, "_")}`);
  return [
    t.variableDeclaration("const", [t.variableDeclarator(local, value)]),
    t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(local.name), t.stringLiteral(exported))]),
  ];
}

function topStatementOf(path: NodePath, fn: FactoryPath): t.Node | undefined {
  let current: NodePath | null = path;
  while (current && current.parentPath && current.parentPath.node !== fn.node.body) current = current.parentPath;
  return current?.node;
}

export function levelOf(containers: number, recognized: number, skipped: number): "full" | "partial" | "raw" {
  if (!containers || !recognized) return skipped || containers ? "raw" : "full";
  return skipped ? "partial" : "full";
}

export function snippetOf(node: t.Node, max = 80): string {
  const text = print(node).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function functionDeclarations(ast: t.File): Map<string, t.FunctionExpression> {
  const out = new Map<string, t.FunctionExpression>();
  t.traverseFast(ast, (node) => {
    if (t.isFunctionDeclaration(node) && node.id) out.set(node.id.name, t.functionExpression(null, node.params, node.body, node.generator, node.async));
    else if (t.isVariableDeclarator(node) && t.isIdentifier(node.id) && isFactory(node.init)) out.set(node.id.name, node.init as t.FunctionExpression);
  });
  return out;
}

type Binding = NonNullable<ReturnType<Scope["getBinding"]>>;

function renameAt(path: NodePath, from: string, to: string): void {
  const node = path.node;
  if (t.isJSXIdentifier(node)) {
    node.name = to;
    return;
  }
  if (!t.isIdentifier(node)) return;
  const parent = path.parent;
  if (t.isObjectProperty(parent) && parent.shorthand && parent.value === node) {
    parent.shorthand = false;
    parent.key = t.identifier(from);
  }
  if (t.isAssignmentPattern(parent) && parent.left === node && t.isObjectProperty(path.parentPath?.parent) && path.parentPath!.parent.shorthand) {
    path.parentPath!.parent.shorthand = false;
    path.parentPath!.parent.key = t.identifier(from);
  }
  if (t.isImportSpecifier(parent) && parent.imported === node) parent.imported = t.identifier(from);
  if (t.isExportSpecifier(parent) && parent.local === node && (parent.exported === node || (t.isIdentifier(parent.exported) && parent.exported.name === from))) parent.exported = t.identifier(from);
  node.name = to;
}

function splitExport(binding: Binding, from: string, to: string): void {
  const owner = binding.path.isVariableDeclarator() ? binding.path.parentPath : binding.path;
  const exported = owner?.parentPath;
  if (!owner || !exported?.isExportNamedDeclaration() || exported.node.declaration !== owner.node) return;
  const names = Object.keys(t.getBindingIdentifiers(owner.node as t.Declaration));
  const specifiers = names.map((name) => (name === from ? t.exportSpecifier(t.identifier(to), t.identifier(from)) : t.exportSpecifier(t.identifier(name), t.identifier(name))));
  exported.replaceWithMultiple([owner.node as t.Statement, t.exportNamedDeclaration(null, specifiers)]);
}

export function renameBinding(binding: Binding, to: string): void {
  const from = binding.identifier.name;
  splitExport(binding, from, to);
  const declared = (binding.path.getBindingIdentifierPaths(true, true) as Record<string, NodePath[] | undefined>)[from] ?? [];
  const own = declared.filter((p) => p.node === binding.identifier);
  if (own.length) for (const p of own) renameAt(p, from, to);
  else binding.identifier.name = to;
  for (const ref of binding.referencePaths) renameAt(ref, from, to);
  for (const violation of binding.constantViolations) {
    const ids = (violation.getBindingIdentifierPaths(true) as Record<string, NodePath[] | undefined>)[from] ?? [];
    for (const p of ids) renameAt(p, from, to);
  }
  binding.scope.removeOwnBinding(from);
  binding.scope.bindings[to] = binding;
}
