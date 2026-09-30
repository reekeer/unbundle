import type { NodePath } from "@babel/traverse";
import { literalKey, parseProgram, print, t, traverse, renameBinding } from "../unpack/ast.ts";
import { camel, capitalize, moduleIdFromSpecifier, REACT_DOM_MEMBERS, REACT_MEMBERS, RESERVED, splitExports, tidyAst } from "./rename.ts";

type ExportPair = { local: string; exported: string };

function isExportsRef(node: t.Node | null | undefined): boolean {
  return t.isIdentifier(node, { name: "exports" }) || (t.isMemberExpression(node) && t.isIdentifier(node.object, { name: "module" }) && literalKey(node.property) === "exports");
}

function getterTarget(value: t.Node | null | undefined): t.Expression | null {
  if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value) || t.isObjectMethod(value)) {
    const body = value.body;
    if (t.isExpression(body)) return body;
    if (t.isBlockStatement(body) && body.body.length === 1 && t.isReturnStatement(body.body[0])) return body.body[0].argument ?? null;
  }
  return null;
}

function definePropertyExport(expr: t.Expression): { name: string; value: t.Expression | null } | null {
  if (!t.isCallExpression(expr) || expr.arguments.length !== 3) return null;
  const { callee } = expr;
  if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object, { name: "Object" }) || literalKey(callee.property) !== "defineProperty") return null;
  const [target, key, descriptor] = expr.arguments;
  if (!isExportsRef(target) || !t.isStringLiteral(key) || !t.isObjectExpression(descriptor)) return null;
  if (key.value === "__esModule") return { name: "__esModule", value: null };
  for (const prop of descriptor.properties) {
    const name = literalKey((prop as t.ObjectProperty).key);
    if (name === "get") return { name: key.value, value: getterTarget(t.isObjectMethod(prop) ? prop : (prop as t.ObjectProperty).value) };
    if (name === "value" && t.isObjectProperty(prop) && t.isExpression(prop.value)) return { name: key.value, value: prop.value };
  }
  return null;
}

function isInteropTail(stmt: t.Statement): boolean {
  if (!t.isIfStatement(stmt)) return false;
  const text = print(stmt.test);
  return text.includes("exports.default") && text.includes("__esModule");
}

function requireSpecifier(node: t.Node | null | undefined): string | null {
  if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: "require" }) && node.arguments.length === 1 && t.isStringLiteral(node.arguments[0])) {
    return node.arguments[0].value;
  }
  return null;
}

function unwrapInteropRequire(node: t.Node | null | undefined): string | null {
  const direct = requireSpecifier(node);
  if (direct) return direct;
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return null;
  const callee = node.callee;
  const name = t.isIdentifier(callee) ? callee.name : t.isMemberExpression(callee) ? literalKey(callee.property) : null;
  if (!name || !/^(_|_interop_require_(default|wildcard)|__importDefault|__importStar|interopRequire\w*)$/.test(name)) return null;
  return requireSpecifier(node.arguments[0]);
}

function isValidName(name: string): boolean {
  return t.isValidIdentifier(name, true) && !RESERVED.has(name);
}

function getterObjectExports(obj: t.ObjectExpression): Array<{ name: string; value: t.Expression | null }> | null {
  const out: Array<{ name: string; value: t.Expression | null }> = [];
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) return null;
    const name = literalKey(prop.key);
    if (!name || prop.computed) return null;
    out.push({ name, value: getterTarget(t.isObjectMethod(prop) ? prop : prop.value) });
  }
  return out;
}

function isForInExportLoop(stmt: t.Statement): string | null {
  if (!t.isForInStatement(stmt) || !t.isIdentifier(stmt.right)) return null;
  let found = false;
  t.traverseFast(stmt.body, (node) => {
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && literalKey(node.callee.property) === "defineProperty" && isExportsRef(node.arguments[0])) found = true;
  });
  return found ? stmt.right.name : null;
}

function exportHelperCall(expr: t.Expression): t.ObjectExpression | null {
  if (!t.isCallExpression(expr) || expr.arguments.length !== 2) return null;
  const [target, getters] = expr.arguments;
  return isExportsRef(target) && t.isObjectExpression(getters) ? getters : null;
}

function isInteropDefaultCall(node: t.Node | null | undefined): node is t.CallExpression {
  if (!t.isCallExpression(node) || node.arguments.length !== 1 || !t.isIdentifier(node.arguments[0])) return false;
  const callee = node.callee;
  return t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: "__webpack_require__" }) && literalKey(callee.property) === "n";
}

function unwrapInteropDefault(ast: t.File): boolean {
  const program = programPath(ast);
  const namespaces = namespaceImports(program);
  let changed = false;
  const toDefault = (ns: string) => t.memberExpression(t.identifier(ns), t.identifier("default"));
  program.traverse({
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!t.isIdentifier(path.node.id) || !isInteropDefaultCall(init)) return;
      const ns = (init.arguments[0] as t.Identifier).name;
      if (!namespaces.has(ns) || program.scope.getBinding(ns) !== path.scope.getBinding(ns)) return;
      const binding = path.scope.getBinding(path.node.id.name);
      if (!binding?.constant) return;
      const uses = binding.referencePaths.map((ref) => {
        const parent = ref.parentPath;
        if (parent?.isCallExpression() && parent.node.callee === ref.node && !parent.node.arguments.length) return parent;
        if (parent?.isMemberExpression() && parent.node.object === ref.node && !parent.node.computed && literalKey(parent.node.property) === "a") return parent;
        return null;
      });
      if (uses.some((u) => !u)) return;
      for (const use of uses) use!.replaceWith(toDefault(ns));
      path.remove();
      changed = true;
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (path.node.arguments.length || !isInteropDefaultCall(callee)) return;
      const ns = (callee.arguments[0] as t.Identifier).name;
      if (!namespaces.has(ns)) return;
      path.replaceWith(toDefault(ns));
      changed = true;
    },
    MemberExpression(path) {
      if (path.node.computed || literalKey(path.node.property) !== "a" || !isInteropDefaultCall(path.node.object)) return;
      const ns = (path.node.object.arguments[0] as t.Identifier).name;
      if (!namespaces.has(ns)) return;
      path.replaceWith(toDefault(ns));
      changed = true;
    },
  });
  return changed;
}

function foldInlinedFactoryCalls(ast: t.File): boolean {
  const program = programPath(ast);
  let changed = false;
  const folded = new Set<string>();
  program.traverse({
    ConditionalExpression(path) {
      const { test, consequent, alternate } = path.node;
      if (!t.isAssignmentExpression(test, { operator: "=" }) || !t.isIdentifier(test.left)) return;
      const value = test.right;
      if (!(t.isFunctionExpression(value) || t.isArrowFunctionExpression(value) || t.isObjectExpression(value) || t.isClassExpression(value))) return;
      if (!t.isCallExpression(consequent) || consequent.arguments.length !== 1 || !t.isIdentifier(consequent.arguments[0], { name: test.left.name })) return;
      if (!t.isExpression(consequent.callee) || !t.isNodesEquivalent(consequent.callee, alternate)) return;
      const binding = path.scope.getBinding(test.left.name);
      if (!binding || binding.referencePaths.length !== 1 || binding.constantViolations.length !== 1) return;
      path.replaceWith(t.callExpression(consequent.callee, [value]));
      folded.add(test.left.name);
      changed = true;
    },
  });
  if (!changed) return false;
  program.scope.crawl();
  for (const name of folded) {
    const binding = program.scope.getBinding(name);
    if (!binding || binding.referenced || binding.constantViolations.length || !binding.path.isVariableDeclarator() || binding.path.node.init) continue;
    binding.path.remove();
  }
  return true;
}

function hoistInlineRequires(ast: t.File): boolean {
  const program = programPath(ast);
  const locals = new Map<string, string>();
  let changed = false;
  program.traverse({
    Function(path) {
      path.skip();
    },
    CallExpression(path) {
      const source = requireSpecifier(path.node);
      if (!source || !moduleIdFromSpecifier(source)) return;
      const parent = path.parentPath;
      if (parent.isExpressionStatement() || (parent.isVariableDeclarator() && parent.parentPath?.parentPath?.isProgram())) return;
      if (parent.isCallExpression() && unwrapInteropRequire(parent.node) && parent.parentPath?.isVariableDeclarator()) return;
      if (path.findParent((p) => p.isConditionalExpression() || p.isLogicalExpression() || p.isIfStatement() || p.isTryStatement())) return;
      let local = locals.get(source);
      if (!local) {
        local = program.scope.generateUid(camel(`module ${moduleIdFromSpecifier(source)}`) || "module");
        locals.set(source, local);
        program.unshiftContainer("body", t.importDeclaration([t.importNamespaceSpecifier(t.identifier(local))], t.stringLiteral(source)));
      }
      path.replaceWith(t.identifier(local));
      changed = true;
    },
  });
  return changed;
}

function liveExports(ast: t.File): boolean {
  const topLevel = new Set<t.Node>();
  for (const stmt of ast.program.body) {
    if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression, { operator: "=" }) && t.isMemberExpression(stmt.expression.left) && isExportsRef(stmt.expression.left.object)) topLevel.add(stmt.expression.left);
  }
  const program = programPath(ast);
  const locals = new Map<string, string>();
  traverse(ast, {
    MemberExpression(path) {
      const node = path.node;
      if (node.computed || !isExportsRef(node.object) || topLevel.has(node) || path.scope.getBinding("exports") || path.scope.getBinding("module")) return;
      const key = literalKey(node.property);
      if (!key || key === "__esModule" || !isValidName(key) || locals.has(key)) return;
      locals.set(key, program.scope.hasBinding(key) ? program.scope.generateUid(key) : key);
    },
  });
  if (!locals.size) return false;
  traverse(ast, {
    MemberExpression(path) {
      const node = path.node;
      if (node.computed || !isExportsRef(node.object) || path.scope.getBinding("exports") || path.scope.getBinding("module")) return;
      const local = locals.get(literalKey(node.property) ?? "");
      if (local) path.replaceWith(t.identifier(local));
    },
  });
  const body = ast.program.body;
  const at = body.findIndex((s) => !t.isImportDeclaration(s));
  body.splice(at < 0 ? body.length : at, 0, t.variableDeclaration("let", [...locals.values()].map((local) => t.variableDeclarator(t.identifier(local)))));
  body.push(t.exportNamedDeclaration(null, [...locals].map(([name, local]) => t.exportSpecifier(t.identifier(local), t.identifier(name)))));
  return true;
}

export function normalizeExports(code: string): string {
  const ast = parseProgram(code);
  let changed = code.includes("__webpack_require__.n") && unwrapInteropDefault(ast);
  if (code.includes("require(") && hoistInlineRequires(ast)) changed = true;
  if (/\?\s*\w+\(\w+\)\s*:/.test(code) && foldInlinedFactoryCalls(ast)) changed = true;
  if (/\bexports\.\w/.test(code) && liveExports(ast)) changed = true;
  const taken = new Set(Object.keys(programPath(ast).scope.bindings));
  const body = ast.program.body;
  const loopObjects = new Set(body.map(isForInExportLoop).filter((n): n is string => n !== null));
  const exports: ExportPair[] = [];
  const kept: t.Statement[] = [];
  const imports: t.Statement[] = [];

  const removedImports = new Set<t.Statement>();
  for (const stmt of body) {
    if (removedImports.has(stmt)) continue;
    if (t.isExportNamedDeclaration(stmt) && !stmt.source && !stmt.declaration && stmt.specifiers.every((sp) => t.isExportSpecifier(sp))) {
      changed = true;
      for (const spec of stmt.specifiers as t.ExportSpecifier[]) {
        exports.push({ local: spec.local.name, exported: t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value });
      }
      continue;
    }
    if (isInteropTail(stmt) || isForInExportLoop(stmt)) {
      changed = true;
      continue;
    }
    if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
      const decl = stmt.declarations[0]!;
      const getters = t.isIdentifier(decl.id) && loopObjects.has(decl.id.name) && t.isObjectExpression(decl.init) ? getterObjectExports(decl.init) : null;
      if (getters) {
        changed = true;
        for (const g of getters) {
          if (t.isIdentifier(g.value)) exports.push({ local: g.value.name, exported: g.name });
          else if (g.value) kept.push(...exportValue(g.name, g.value, taken));
        }
        continue;
      }
    }
    if (t.isExpressionStatement(stmt)) {
      const helperGetters = exportHelperCall(stmt.expression);
      const getters = helperGetters ? getterObjectExports(helperGetters) : null;
      if (getters) {
        changed = true;
        for (const g of getters) {
          if (t.isIdentifier(g.value)) exports.push({ local: g.value.name, exported: g.name });
          else if (g.value) kept.push(...exportValue(g.name, g.value, taken));
        }
        continue;
      }
    }
    if (t.isExpressionStatement(stmt)) {
      const expr = stmt.expression;
      const defined = definePropertyExport(expr);
      if (defined) {
        changed = true;
        if (defined.name === "__esModule") continue;
        if (t.isIdentifier(defined.value)) exports.push({ local: defined.value.name, exported: defined.name });
        else if (defined.value) kept.push(...exportValue(defined.name, defined.value, taken));
        continue;
      }
      if (t.isAssignmentExpression(expr, { operator: "=" }) && t.isMemberExpression(expr.left) && isExportsRef(expr.left.object)) {
        const name = literalKey(expr.left.property);
        if (name === "__esModule") {
          changed = true;
          continue;
        }
        if (name && !expr.left.computed) {
          changed = true;
          if (t.isIdentifier(expr.right)) exports.push({ local: expr.right.name, exported: name });
          else kept.push(...exportValue(name, expr.right, taken));
          continue;
        }
      }
      const spec = requireSpecifier(expr);
      if (spec) {
        changed = true;
        imports.push(t.importDeclaration([], t.stringLiteral(spec)));
        continue;
      }
      if (t.isAssignmentExpression(expr, { operator: "=" }) && isExportsRef(expr.left) && t.isMemberExpression(expr.left) && t.isIdentifier(expr.right)) {
        const name = expr.right.name;
        const source = body.find(
          (s): s is t.ImportDeclaration => t.isImportDeclaration(s) && s.specifiers.length === 1 && t.isImportNamespaceSpecifier(s.specifiers[0]) && s.specifiers[0].local.name === name,
        );
        const uses = source ? countIdentifier(body, name) : 0;
        if (source && uses === 2) {
          changed = true;
          const index = kept.indexOf(source);
          if (index >= 0) kept.splice(index, 1);
          removedImports.add(source);
          kept.push(t.exportAllDeclaration(t.stringLiteral(source.source.value)));
          continue;
        }
      }
      if (t.isAssignmentExpression(expr, { operator: "=" }) && isExportsRef(expr.left) && t.isMemberExpression(expr.left)) {
        const target = requireSpecifier(expr.right);
        if (target && body.length === 1) {
          changed = true;
          kept.push(t.exportAllDeclaration(t.stringLiteral(target)));
          continue;
        }
        if (!target) {
          changed = true;
          kept.push(t.exportDefaultDeclaration(expr.right));
          continue;
        }
      }
    }
    if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
      const decl = stmt.declarations[0]!;
      const spec = unwrapInteropRequire(decl.init);
      if (spec && t.isIdentifier(decl.id)) {
        changed = true;
        imports.push(t.importDeclaration([t.importNamespaceSpecifier(t.identifier(decl.id.name))], t.stringLiteral(spec)));
        continue;
      }
    }
    kept.push(stmt);
  }
  if (!changed) return code;

  const firstNonImport = kept.findIndex((s) => !t.isImportDeclaration(s));
  const leading = firstNonImport < 0 ? kept : kept.slice(0, firstNonImport);
  const rest = firstNonImport < 0 ? [] : kept.slice(firstNonImport);
  ast.program.body = [...leading, ...imports, ...rest];
  emitProgramExports(ast, exports);
  removeUnusedExportHelpers(ast);
  tidyAst(ast);
  return print(ast);
}

function removeUnusedExportHelpers(ast: t.File): void {
  const program = programPath(ast);
  program.scope.crawl();
  ast.program.body = ast.program.body.filter((stmt) => {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id) return true;
    const binding = program.scope.getBinding(stmt.id.name);
    if (!binding || binding.referenced) return true;
    let definesExports = false;
    t.traverseFast(stmt.body, (node) => {
      if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && literalKey(node.callee.property) === "defineProperty") definesExports = true;
    });
    return !definesExports;
  });
}

function countIdentifier(body: t.Statement[], name: string): number {
  let count = 0;
  for (const stmt of body) {
    t.traverseFast(stmt, (node) => {
      if (t.isIdentifier(node, { name })) count++;
    });
  }
  return count;
}

function exportValue(name: string, value: t.Expression, taken: Set<string>): t.Statement[] {
  if (name === "default") return [t.exportDefaultDeclaration(value)];
  if (isValidName(name) && !taken.has(name)) {
    taken.add(name);
    return [t.exportNamedDeclaration(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(name), value)]))];
  }
  let base = `_${camel(name) || "value"}`;
  for (let n = 2; taken.has(base); n++) base = `_${camel(name) || "value"}${n}`;
  taken.add(base);
  const local = t.identifier(base);
  return [
    t.variableDeclaration("const", [t.variableDeclarator(local, value)]),
    t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(local.name), t.stringLiteral(name))]),
  ];
}

function emitProgramExports(ast: t.File, pairs: ExportPair[]): void {
  if (!pairs.length) return;
  let program: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  if (!program) return;
  const scope = program.scope;
  const counts = new Map<string, number>();
  for (const pair of pairs) counts.set(pair.local, (counts.get(pair.local) ?? 0) + 1);
  const tail: t.Statement[] = [];

  for (const pair of pairs) {
    let local = pair.local;
    const binding = scope.getBinding(local);
    const single = counts.get(local) === 1;
    if (binding && single && pair.exported !== "default" && pair.exported !== local && isValidName(pair.exported) && !scope.hasBinding(pair.exported)) {
      const free = [...binding.referencePaths, ...binding.constantViolations].every((ref) => !ref.scope.getBinding(pair.exported));
      if (free) {
        scope.rename(local, pair.exported);
        local = pair.exported;
      }
    }
    const statement = binding ? topStatement(binding.path) : null;
    const index = statement ? ast.program.body.indexOf(statement) : -1;
    if (single && index >= 0 && statement) {
      if (pair.exported === local && (t.isFunctionDeclaration(statement) || t.isClassDeclaration(statement) || (t.isVariableDeclaration(statement) && statement.declarations.length === 1))) {
        ast.program.body[index] = t.exportNamedDeclaration(statement);
        continue;
      }
      if (pair.exported === "default" && (t.isFunctionDeclaration(statement) || t.isClassDeclaration(statement))) {
        ast.program.body[index] = t.exportDefaultDeclaration(statement);
        continue;
      }
    }
    tail.push(
      pair.exported === "default"
        ? t.exportDefaultDeclaration(t.identifier(local))
        : t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(local), isValidName(pair.exported) ? t.identifier(pair.exported) : t.stringLiteral(pair.exported))]),
    );
  }
  ast.program.body.push(...tail);
}

function topStatement(path: NodePath): t.Statement | null {
  let current: NodePath | null = path;
  while (current && current.parentPath && !current.parentPath.isProgram()) current = current.parentPath;
  return current && t.isStatement(current.node) ? current.node : null;
}

function isLocalCall(expr: t.Expression, ast: t.File): boolean {
  if (!t.isCallExpression(expr) || !t.isIdentifier(expr.callee)) return false;
  const name = expr.callee.name;
  return ast.program.body.some((s) => t.isFunctionDeclaration(s) && s.id?.name === name);
}

export type TrivialModule = { kind: "alias"; target: string } | { kind: "stub"; targets: string[] } | null;

export function trivialModule(code: string): TrivialModule {
  let ast: t.File;
  try {
    ast = parseProgram(code);
  } catch {
    return null;
  }
  const withoutHelpers = ast.program.body.filter((stmt) => !t.isFunctionDeclaration(stmt) && !(t.isExpressionStatement(stmt) && isLocalCall(stmt.expression, ast)));
  if (withoutHelpers.length === 1 && t.isExportAllDeclaration(withoutHelpers[0])) {
    const id = moduleIdFromSpecifier(withoutHelpers[0].source.value);
    return id ? { kind: "alias", target: id } : null;
  }
  const defaultAlias = reexportedDefault(withoutHelpers);
  if (defaultAlias) return { kind: "alias", target: defaultAlias };
  const targets: string[] = [];
  const onlyLoads = ast.program.body.every((stmt) => {
    if (t.isImportDeclaration(stmt)) {
      if (stmt.specifiers.length) return false;
      const id = moduleIdFromSpecifier(stmt.source.value);
      if (id) targets.push(id);
      return true;
    }
    if (!t.isExpressionStatement(stmt)) return false;
    const expr = t.isAwaitExpression(stmt.expression) ? stmt.expression.argument : stmt.expression;
    if (!t.isCallExpression(expr) || !(t.isImport(expr.callee) || t.isIdentifier(expr.callee, { name: "require" })) || !expr.arguments.every((a) => t.isStringLiteral(a))) return false;
    for (const arg of expr.arguments as t.StringLiteral[]) {
      const id = moduleIdFromSpecifier(arg.value);
      if (id) targets.push(id);
    }
    return true;
  });
  return onlyLoads ? { kind: "stub", targets } : null;
}

function reexportedDefault(body: t.Statement[]): string | null {
  if (body.length !== 2) return null;
  const [imported, exported] = body;
  if (!t.isImportDeclaration(imported) || imported.specifiers.length !== 1 || !t.isExportDefaultDeclaration(exported)) return null;
  const spec = imported.specifiers[0]!;
  const value = exported.declaration;
  const ns = t.isImportNamespaceSpecifier(spec) && t.isMemberExpression(value) && !value.computed && t.isIdentifier(value.object, { name: spec.local.name }) && literalKey(value.property) === "default";
  const direct = t.isImportDefaultSpecifier(spec) && t.isIdentifier(value, { name: spec.local.name });
  return ns || direct ? moduleIdFromSpecifier(imported.source.value) : null;
}

export function importPackageFunctions(code: string, imports: Map<string, string>): string {
  const ast = parseProgram(code);
  const program = programPath(ast);
  const bySource = new Map<string, string[]>();
  const leaves = new Map<string, string>();
  for (const [name, pkg] of imports) {
    const binding = program.scope.getBinding(name);
    if (!binding || binding.constantViolations.length) continue;
    let leaf = true;
    binding.path.traverse({
      Identifier(path) {
        if (!path.isReferencedIdentifier() || path.node.name === name) return;
        const target = path.scope.getBinding(path.node.name);
        if (target && target.scope === program.scope) leaf = false;
      },
    });
    if (leaf) leaves.set(name, pkg);
  }
  for (const [name, pkg] of leaves) {
    const binding = program.scope.getBinding(name);
    if (!binding) continue;
    const node = binding.path.isVariableDeclarator() ? binding.path.node.init : binding.path.node;
    if (!(t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node))) continue;
    if (binding.path.isVariableDeclarator() && (binding.path.parentPath?.node as t.VariableDeclaration).declarations.length !== 1) continue;
    const statement = binding.path.isVariableDeclarator() ? binding.path.parentPath! : binding.path;
    const parent = statement.parentPath;
    if (parent?.isExportNamedDeclaration()) {
      parent.replaceWith(t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(name), t.identifier(name))]));
    } else if (parent?.isProgram()) statement.remove();
    else continue;
    bySource.set(pkg, [...(bySource.get(pkg) ?? []), name]);
  }
  if (!bySource.size) return code;
  for (const [pkg, names] of bySource) ast.program.body.unshift(t.importDeclaration(names.map((n) => t.importSpecifier(t.identifier(n), t.identifier(n))), t.stringLiteral(pkg)));
  return print(ast);
}

export interface FinalizeOptions {
  specifierFor: (id: string) => string | null;
  moduleName?: string;
  defaultNameFor?: (specifier: string) => string | null;
  exportRenamesFor?: (id: string) => Map<string, string> | undefined;
  sideEffectsFor?: (id: string) => string[] | null;
  isEmptyModule?: (id: string) => boolean;
  bareImport?: (id: string, name: string) => string | null;
}

export function renameExports(code: string, renames: Map<string, string>): string {
  if (!renames.size) return code;
  const ast = parseProgram(code);
  splitExports(ast);
  const program = programPath(ast);
  for (const stmt of ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
    for (const spec of stmt.specifiers) {
      if (!t.isExportSpecifier(spec)) continue;
      const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
      const next = renames.get(exported);
      if (!next) continue;
      spec.exported = t.identifier(next);
      const local = spec.local.name;
      const binding = program.scope.getBinding(local);
      const free = binding && !program.scope.hasBinding(next) && [...binding.referencePaths, ...binding.constantViolations].every((ref) => !ref.scope.getBinding(next));
      if (local === exported && free && isValidName(next)) program.scope.rename(local, next);
    }
  }
  tidyAst(ast);
  return print(ast);
}

function keptName(init: t.Node | null | undefined, depth = 0): string | null {
  if (!t.isCallExpression(init) || depth > 2) return null;
  const [fn, name] = init.arguments;
  if ((t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn)) && t.isStringLiteral(name) && /^[A-Z][A-Za-z0-9]*$/.test(name.value) && init.arguments.length === 2) return name.value;
  for (const arg of init.arguments) {
    const found = keptName(arg as t.Node, depth + 1);
    if (found) return found;
  }
  return null;
}

function componentName(init: t.Node | null | undefined, objects: Map<string, t.ObjectExpression>): string | null {
  const fromObject = (node: t.Node | null | undefined): string | null => {
    const object = t.isIdentifier(node) ? objects.get(node.name) : node;
    if (!t.isObjectExpression(object)) return null;
    const keys = new Map(object.properties.flatMap((p) => (t.isObjectProperty(p) || t.isObjectMethod(p) ? [[literalKey(p.key), p] as const] : [])));
    const named = (key: string) => {
      const prop = keys.get(key);
      return t.isObjectProperty(prop) && t.isStringLiteral(prop.value) && /^[A-Z][A-Za-z0-9]*$/.test(prop.value.value) ? prop.value.value : null;
    };
    if (named("componentName")) return named("componentName");
    return named("name") && (keys.has("setup") || keys.has("render") || keys.has("props")) ? named("name") : null;
  };
  if (t.isCallExpression(init) && init.arguments.length === 1) return fromObject(init.arguments[0]);
  return fromObject(init);
}

function iifeCandidates(program: NodePath<t.Program>): Array<NodePath<t.CallExpression>> {
  const out: Array<NodePath<t.CallExpression>> = [];
  program.traverse({
    CallExpression(path) {
      const callee = path.get("callee");
      if (!(callee.isFunctionExpression() || callee.isArrowFunctionExpression()) || callee.node.generator) return;
      if (!path.findParent((p) => p.isFunction())) return;
      const body = callee.node.body;
      if (!t.isBlockStatement(body) || body.body.length < 3) return;
      let captured = false;
      callee.traverse({
        Identifier(ref) {
          if (captured || !ref.isReferencedIdentifier()) return;
          const binding = ref.scope.getBinding(ref.node.name);
          if (binding && binding.scope !== program.scope && !binding.path.findParent((p) => p === callee) && binding.path !== callee) captured = true;
        },
        ThisExpression(ref) {
          if (!ref.findParent((p) => p !== callee && p.isFunction() && !p.isArrowFunctionExpression() && !!p.findParent((q) => q === callee))) captured = true;
        },
      });
      if (!captured) out.push(path);
    },
  });
  return out;
}

export function outlineIifes(code: string, nameFor: (hoisted: string, index: number) => string | null): string {
  if (!/\)\s*\(/.test(code)) return code;
  const probe = parseProgram(code);
  const probeProgram = programPath(probe);
  const probes = iifeCandidates(probeProgram);
  if (!probes.length) return code;
  probes.forEach((path, i) => {
    const fn = path.node.callee as t.FunctionExpression | t.ArrowFunctionExpression;
    const name = `__iife_${i}`;
    probe.program.body.push(t.functionDeclaration(t.identifier(name), fn.params, t.isBlockStatement(fn.body) ? fn.body : t.blockStatement([t.returnStatement(fn.body)]), false, fn.async));
    path.node.callee = t.identifier(name);
  });
  const names = new Map<number, string>();
  const probeCode = print(probe);
  probes.forEach((_, i) => {
    const name = nameFor(probeCode, i);
    if (name && isValidName(name)) names.set(i, name);
  });
  if (!names.size) return code;
  const ast = parseProgram(code);
  const program = programPath(ast);
  const candidates = iifeCandidates(program);
  if (candidates.length !== probes.length) return code;
  const taken = new Set<string>();
  candidates.forEach((path, i) => {
    let name = names.get(i);
    if (!name) return;
    for (let n = 2; program.scope.hasBinding(name) || taken.has(name); n++) name = `${names.get(i)}${n}`;
    taken.add(name);
    const fn = path.node.callee as t.FunctionExpression | t.ArrowFunctionExpression;
    program.node.body.push(t.functionDeclaration(t.identifier(name), fn.params, t.isBlockStatement(fn.body) ? fn.body : t.blockStatement([t.returnStatement(fn.body)]), false, fn.async));
    path.node.callee = t.identifier(name);
  });
  return print(ast);
}

export function displayNameExports(code: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!code.includes("displayName") && !/,\s*"[A-Z]\w*"\)/.test(code) && !/\b(name|componentName)\s*:\s*"[A-Z]/.test(code)) return out;
  const ast = parseProgram(code);
  const names = new Map<string, string>();
  const objects = new Map<string, t.ObjectExpression>();
  for (const stmt of ast.program.body) {
    const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
    if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) if (t.isIdentifier(d.id) && t.isObjectExpression(d.init)) objects.set(d.id.name, d.init);
  }
  for (const stmt of ast.program.body) {
    const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
    if (!t.isVariableDeclaration(decl)) continue;
    for (const d of decl.declarations) {
      const name = t.isIdentifier(d.id) && d.id.name.length <= 2 ? (keptName(d.init) ?? componentName(d.init, objects)) : null;
      if (name) names.set((d.id as t.Identifier).name, name);
    }
  }
  const constants = new Map<string, string>();
  for (const stmt of ast.program.body) {
    const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
    if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) if (t.isIdentifier(d.id) && t.isStringLiteral(d.init)) constants.set(d.id.name, d.init.value);
  }
  t.traverseFast(ast.program, (node) => {
    if (!t.isAssignmentExpression(node, { operator: "=" })) return;
    const { left, right } = node;
    const value = t.isStringLiteral(right) ? right.value : t.isIdentifier(right) ? constants.get(right.name) : undefined;
    if (t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.object) && literalKey(left.property) === "displayName" && value && isValidName(value)) {
      names.set(left.object.name, value);
    }
  });
  if (!names.size) return out;
  const taken = new Set<string>();
  for (const stmt of ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
    for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec)) taken.add(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value);
    if (stmt.declaration) {
      const declared = new Set<string>();
      if (t.isVariableDeclaration(stmt.declaration)) for (const d of stmt.declaration.declarations) if (t.isIdentifier(d.id)) declared.add(d.id.name);
      if ((t.isFunctionDeclaration(stmt.declaration) || t.isClassDeclaration(stmt.declaration)) && stmt.declaration.id) declared.add(stmt.declaration.id.name);
      for (const d of declared) taken.add(d);
    }
  }
  for (const stmt of ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
    const pairs: Array<[string, string]> = stmt.specifiers.flatMap((spec) => (t.isExportSpecifier(spec) ? [[t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value, spec.local.name] as [string, string]] : []));
    if (t.isVariableDeclaration(stmt.declaration)) for (const d of stmt.declaration.declarations) if (t.isIdentifier(d.id)) pairs.push([d.id.name, d.id.name]);
    if ((t.isFunctionDeclaration(stmt.declaration) || t.isClassDeclaration(stmt.declaration)) && stmt.declaration.id) pairs.push([stmt.declaration.id.name, stmt.declaration.id.name]);
    for (const [exported, local] of pairs) {
      const name = names.get(local);
      if (!name || exported.length > 2 || taken.has(name)) continue;
      taken.add(name);
      out.set(exported, name);
    }
  }
  return out;
}

export function readableLocalExports(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const ast = parseProgram(code);
  const used = new Set<string>();
  for (const stmt of ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt)) continue;
    for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec)) used.add(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value);
  }
  for (const stmt of ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
    for (const spec of stmt.specifiers) {
      if (!t.isExportSpecifier(spec)) continue;
      const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
      const local = spec.local.name;
      if (exported.length <= 2 && local.length > 2 && !used.has(local) && isValidName(local)) {
        out.set(exported, local);
        used.add(local);
      }
    }
  }
  return out;
}

export function renameLocals(code: string, renames: Map<string, string>): string {
  if (!renames.size) return code;
  const ast = parseProgram(code);
  splitExports(ast);
  const program = programPath(ast);
  for (const [from, to] of renames) {
    const binding = program.scope.getBinding(from);
    if (!binding || program.scope.hasBinding(to) || !isValidName(to)) continue;
    if ([...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.getBinding(to))) continue;
    renameBinding(binding, to);
  }
  tidyAst(ast);
  return print(ast);
}

function renameImportedExports(ast: t.File, renamesFor: (id: string) => Map<string, string> | undefined): void {
  const program = programPath(ast);
  for (const stmt of ast.program.body) {
    if (!(t.isImportDeclaration(stmt) || t.isExportNamedDeclaration(stmt)) || !stmt.source) continue;
    const id = moduleIdFromSpecifier(stmt.source.value);
    const renames = id ? renamesFor(id) : undefined;
    if (!renames?.size) continue;
    if (t.isExportNamedDeclaration(stmt)) {
      for (const spec of stmt.specifiers) {
        if (!t.isExportSpecifier(spec) || !renames.has(spec.local.name)) continue;
        const same = (t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value) === spec.local.name;
        spec.local = t.identifier(renames.get(spec.local.name)!);
        if (same) spec.exported = t.identifier(spec.local.name);
      }
      continue;
    }
    stmt.specifiers = stmt.specifiers.map((spec) => {
      const next = t.isImportDefaultSpecifier(spec) ? renames.get("default") : undefined;
      return next ? t.importSpecifier(t.identifier(spec.local.name), t.identifier(next)) : spec;
    });
    for (const spec of stmt.specifiers) {
      if (t.isImportSpecifier(spec)) {
        const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
        const next = renames.get(imported);
        if (next) spec.imported = t.identifier(next);
        const wanted = next ?? imported;
        if (spec.local.name !== wanted && (next || renames.has("default")) && isValidName(wanted) && freeFor(program, spec.local.name, wanted)) program.scope.rename(spec.local.name, wanted);
      } else if (t.isImportNamespaceSpecifier(spec)) {
        const binding = program.scope.getBinding(spec.local.name);
        for (const ref of binding?.referencePaths ?? []) {
          const parent = ref.parentPath;
          if (parent?.isMemberExpression() && parent.node.object === ref.node && !parent.node.computed) {
            const next = renames.get(literalKey(parent.node.property) ?? "");
            if (next) parent.node.property = t.identifier(next);
          } else if (parent?.isJSXMemberExpression() && parent.node.object === ref.node) {
            const next = renames.get(parent.node.property.name);
            if (next) parent.node.property = t.jsxIdentifier(next);
          }
        }
      }
    }
  }
}

const REACT_SOURCES: Array<[RegExp, string]> = [
  [REACT_MEMBERS, "react"],
  [/^(createRoot|hydrateRoot)$/, "react-dom/client"],
  [REACT_DOM_MEMBERS, "react-dom"],
];

export function packageNamespaceCode(code: string): string {
  if (!/import\s*\*\s*as\s+[\w$]+\s+from\s*["'][^./]/.test(code)) return code;
  const ast = parseProgram(code);
  const program = programPath(ast);
  let changed = false;
  for (const stmt of [...ast.program.body]) {
    if (!t.isImportDeclaration(stmt) || stmt.source.value.startsWith(".") || stmt.specifiers.length !== 1 || !t.isImportNamespaceSpecifier(stmt.specifiers[0])) continue;
    const local = stmt.specifiers[0].local.name;
    const binding = program.scope.getBinding(local);
    if (!binding?.referencePaths.length || binding.constantViolations.length) continue;
    const members: Array<{ ref: NodePath; name: string }> = [];
    const ok = binding.referencePaths.every((ref) => {
      const parent = ref.parentPath;
      if (parent?.isMemberExpression() && parent.node.object === ref.node && !parent.node.computed && !(parent.parentPath?.isAssignmentExpression() && parent.parentPath.node.left === parent.node)) {
        const name = literalKey(parent.node.property);
        if (name && isValidName(name)) members.push({ ref: parent, name });
        return !!name && isValidName(name);
      }
      if (parent?.isJSXMemberExpression() && parent.node.object === ref.node) {
        members.push({ ref: parent, name: parent.node.property.name });
        return true;
      }
      return false;
    });
    const names = [...new Set(members.map((m) => m.name))];
    if (!ok || !names.length || names.some((n) => n === "default" || program.scope.hasBinding(n) || members.some((m) => m.ref.scope.hasBinding(n)))) continue;
    for (const { ref, name } of members) ref.replaceWith(ref.isJSXMemberExpression() ? t.jsxIdentifier(name) : t.identifier(name));
    stmt.specifiers = names.map((n) => t.importSpecifier(t.identifier(n), t.identifier(n)));
    changed = true;
  }
  if (!changed) return code;
  mergeImports(ast);
  return print(ast);
}

export function reactNamespaceCode(code: string): string {
  if (!/\.\/|\.\.\/|["']react["']/.test(code)) return code;
  const ast = parseProgram(code);
  return reactNamespaces(ast) ? print(ast) : code;
}

function reactNamespaces(ast: t.File): boolean {
  const program = programPath(ast);
  const added = new Map<string, Set<string>>();
  const touched = new Set<t.ImportDeclaration>();
  let changed = false;
  for (const stmt of [...program.node.body]) {
    if (!t.isImportDeclaration(stmt)) continue;
    const bareReact = stmt.source.value === "react";
    if (!stmt.source.value.startsWith(".") && !bareReact) continue;
    for (const spec of [...stmt.specifiers]) {
      if (bareReact && t.isImportSpecifier(spec)) continue;
      const binding = program.scope.getBinding(spec.local.name);
      if (!binding?.referencePaths.length || binding.constantViolations.length) continue;
      const members: Array<{ ref: NodePath; name: string }> = [];
      const ok = binding.referencePaths.every((ref) => {
        const parent = ref.parentPath;
        if (parent?.isMemberExpression() && parent.node.object === ref.node && !parent.node.computed) {
          const name = literalKey(parent.node.property);
          if (name) members.push({ ref: parent, name });
          return !!name;
        }
        if (parent?.isJSXMemberExpression() && parent.node.object === ref.node) {
          members.push({ ref: parent, name: parent.node.property.name });
          return true;
        }
        return false;
      });
      if (!ok || !members.length) continue;
      const source = REACT_SOURCES.find(([pattern]) => members.every((m) => pattern.test(m.name)))?.[1];
      if (!source || !members.some((m) => /^use|^createElement$|^createRoot$|^Fragment$|^Suspense$/.test(m.name))) continue;
      if (members.some((m) => m.name === "version" || program.scope.hasBinding(m.name) && !added.get(source)?.has(m.name))) continue;
      for (const { ref, name } of members) {
        const holder = ref.parentPath;
        if (holder?.isSequenceExpression() && holder.node.expressions.length === 2 && t.isNumericLiteral(holder.node.expressions[0]) && holder.node.expressions[1] === ref.node) holder.replaceWith(t.identifier(name));
        else ref.replaceWith(ref.isJSXMemberExpression() ? t.jsxIdentifier(name) : t.identifier(name));
      }
      added.set(source, new Set([...(added.get(source) ?? []), ...members.map((m) => m.name)]));
      stmt.specifiers = stmt.specifiers.filter((x) => x !== spec);
      touched.add(stmt);
      changed = true;
    }
    if (!stmt.specifiers.length && touched.has(stmt)) program.node.body.splice(program.node.body.indexOf(stmt), 1);
  }
  if (!changed) return false;
  for (const [source, names] of added) {
    const existing = program.node.body.find((st): st is t.ImportDeclaration => t.isImportDeclaration(st) && st.source.value === source && !st.specifiers.some((x) => t.isImportNamespaceSpecifier(x)));
    const specifiers = [...names].filter((n) => !existing?.specifiers.some((x) => x.local.name === n)).map((n) => t.importSpecifier(t.identifier(n), t.identifier(n)));
    if (existing) existing.specifiers.push(...specifiers);
    else program.node.body.unshift(t.importDeclaration(specifiers, t.stringLiteral(source)));
  }
  program.scope.crawl();
  return true;
}

export function finalizeModule(code: string, options: FinalizeOptions): string {
  const ast = parseProgram(code);
  if (options.exportRenamesFor) renameImportedExports(ast, options.exportRenamesFor);
  if (options.isEmptyModule) inlineEmptyModules(ast, options.isEmptyModule);
  if (options.sideEffectsFor) expandSideEffectImports(ast, options.sideEffectsFor);
  const bare = options.bareImport;
  if (bare) {
    const candidates = bareNamespaces(ast, bare);
    if (candidates.size) {
      collapseNamespaceAliases(ast);
      const defaultFor = (source: string) => {
        const id = moduleIdFromSpecifier(source);
        const spec = id ? options.specifierFor(id) : null;
        return spec ? (options.defaultNameFor?.(spec) ?? null) : null;
      };
      namespaceToNamed(ast, defaultFor, (source) => !candidates.has(source));
    }
    splitBareImports(ast, bare);
  }
  reactNamespaces(ast);
  rewriteSpecifiers(ast, options.specifierFor);
  collapseNamespaceVariables(ast);
  collapseNamespaceAliases(ast);
  namespaceToNamed(ast, options.defaultNameFor ?? (() => null));
  unwrapIndirectCalls(ast);
  inlineImportAliases(ast);
  shortFragments(ast);
  nameDefaultExport(ast, options.moduleName);
  mergeImports(ast);
  tidyAst(ast);
  return print(ast);
}

function bareNamespaces(ast: t.File, bare: (id: string, name: string) => string | null): Set<string> {
  const out = new Set<string>();
  const program = programPath(ast);
  for (const [local, decl] of namespaceImports(program)) {
    const id = moduleIdFromSpecifier(decl.source.value);
    if (!id) continue;
    for (const ref of program.scope.getBinding(local)?.referencePaths ?? []) {
      const parent = ref.parentPath;
      const prop = parent?.isMemberExpression() && !parent.node.computed ? literalKey(parent.node.property) : parent?.isJSXMemberExpression() ? parent.node.property.name : null;
      if (prop && bare(id, prop)) out.add(decl.source.value);
    }
  }
  return out;
}

function splitBareImports(ast: t.File, bare: (id: string, name: string) => string | null): void {
  const body = ast.program.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i]!;
    if (!t.isImportDeclaration(stmt)) continue;
    const id = moduleIdFromSpecifier(stmt.source.value);
    if (!id) continue;
    const moved = new Map<string, t.ImportSpecifier[]>();
    stmt.specifiers = stmt.specifiers.filter((spec) => {
      if (t.isImportDefaultSpecifier(spec)) {
        const target = bare(id, "default");
        if (!target) return true;
        moved.set(target, [...(moved.get(target) ?? []), t.importSpecifier(spec.local, t.identifier("default"))]);
        return false;
      }
      if (!t.isImportSpecifier(spec)) return true;
      const name = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
      const target = bare(id, name);
      if (!target) return true;
      moved.set(target, [...(moved.get(target) ?? []), spec]);
      return false;
    });
    if (!moved.size) continue;
    const added = [...moved].map(([source, specs]) =>
      t.importDeclaration(
        specs.map((spec) => ((t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) === "default" ? t.importDefaultSpecifier(spec.local) : spec)),
        t.stringLiteral(source),
      ),
    );
    for (const [source, specs] of moved) {
      for (const spec of specs) {
        const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
        const wanted = camel(source.replace(/^@[^/]+\//, "").replace(/\/.*$/, ""));
        if (imported !== "default" || !(spec.local.name.length <= 2 || /Default\d*$/.test(spec.local.name)) || !isValidName(wanted)) continue;
        const program = programPath(ast);
        if (!program.scope.hasBinding(wanted)) program.scope.rename(spec.local.name, wanted);
      }
    }
    body.splice(i, stmt.specifiers.length ? 0 : 1, ...added);
  }
}

function inlineEmptyModules(ast: t.File, isEmpty: (id: string) => boolean): void {
  const empty = (node: t.Node | undefined) => {
    const id = t.isStringLiteral(node) ? moduleIdFromSpecifier(node.value) : null;
    return !!id && isEmpty(id);
  };
  const body = ast.program.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i]!;
    if (!t.isImportDeclaration(stmt) || !empty(stmt.source) || !stmt.specifiers.length) continue;
    const declarations = stmt.specifiers.map((spec) =>
      t.variableDeclaration("const", [t.variableDeclarator(t.identifier(spec.local.name), t.isImportSpecifier(spec) ? t.identifier("undefined") : t.objectExpression([]))]),
    );
    body.splice(i, 1, ...declarations);
  }
  traverse(ast, {
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (!empty(args[0])) return;
      if (t.isIdentifier(callee, { name: "require" })) path.replaceWith(t.objectExpression([]));
      else if (t.isImport(callee)) path.replaceWith(t.callExpression(t.memberExpression(t.identifier("Promise"), t.identifier("resolve")), [t.objectExpression([])]));
    },
  });
}

function expandSideEffectImports(ast: t.File, sideEffectsFor: (id: string) => string[] | null): void {
  const body = ast.program.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i]!;
    if (!t.isImportDeclaration(stmt) || stmt.specifiers.length) continue;
    const id = moduleIdFromSpecifier(stmt.source.value);
    const replacement = id ? sideEffectsFor(id) : null;
    if (replacement === null) continue;
    body.splice(i, 1, ...replacement.map((source) => t.importDeclaration([], t.stringLiteral(source))));
  }
}

function rewriteSpecifiers(ast: t.File, specifierFor: (id: string) => string | null): void {
  const rewrite = (lit: t.StringLiteral) => {
    const id = moduleIdFromSpecifier(lit.value);
    const target = id ? specifierFor(id) : null;
    if (target) lit.value = target;
  };
  traverse(ast, {
    "ImportDeclaration|ExportAllDeclaration|ExportNamedDeclaration"(path) {
      const source = (path.node as t.ImportDeclaration).source;
      if (source) rewrite(source);
    },
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if ((t.isImport(callee) || t.isIdentifier(callee, { name: "require" })) && t.isStringLiteral(args[0])) rewrite(args[0]);
    },
  });
}

function programPath(ast: t.File): NodePath<t.Program> {
  let program: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program!;
}

function namespaceImports(program: NodePath<t.Program>): Map<string, t.ImportDeclaration> {
  const out = new Map<string, t.ImportDeclaration>();
  for (const stmt of program.node.body) {
    if (!t.isImportDeclaration(stmt) || stmt.specifiers.length !== 1) continue;
    const spec = stmt.specifiers[0]!;
    if (t.isImportNamespaceSpecifier(spec)) out.set(spec.local.name, stmt);
  }
  return out;
}

function collapseNamespaceVariables(ast: t.File): void {
  const program = programPath(ast);
  const namespaces = namespaceImports(program);
  const body = program.node.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i]!;
    if (!t.isExpressionStatement(stmt) || !t.isIdentifier(stmt.expression)) continue;
    const decl = namespaces.get(stmt.expression.name);
    if (!decl) continue;
    body.splice(i, 1);
    if (!body.some((s) => t.isImportDeclaration(s) && !s.specifiers.length && s.source.value === decl.source.value)) {
      body.splice(body.indexOf(decl), 0, t.importDeclaration([], t.stringLiteral(decl.source.value)));
    }
  }
  program.scope.crawl();
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i]!;
    if (!t.isVariableDeclaration(stmt) || stmt.declarations.length !== 1) continue;
    const decl = stmt.declarations[0]!;
    if (!t.isIdentifier(decl.id) || !t.isIdentifier(decl.init) || !namespaces.has(decl.init.name)) continue;
    const binding = program.scope.getBinding(decl.id.name);
    if (!binding?.constant) continue;
    for (const ref of binding.referencePaths) ref.replaceWith(ref.isJSXIdentifier() ? t.jsxIdentifier(decl.init.name) : t.identifier(decl.init.name));
    body.splice(i, 1);
  }
  program.scope.crawl();
}

function collapseNamespaceAliases(ast: t.File): void {
  const program = programPath(ast);
  const namespaces = namespaceImports(program);
  const body = program.node.body;
  const collapsed: Array<{ stmt: t.Statement; ns: t.ImportDeclaration; local: string; prop: string }> = [];
  for (const stmt of body) {
    if (!t.isVariableDeclaration(stmt) || stmt.declarations.length !== 1) continue;
    const decl = stmt.declarations[0]!;
    if (!t.isIdentifier(decl.id) || !t.isMemberExpression(decl.init) || decl.init.computed || !t.isIdentifier(decl.init.object)) continue;
    const ns = namespaces.get(decl.init.object.name);
    const prop = literalKey(decl.init.property);
    if (!ns || !prop || !(isValidName(prop) || prop === "default") || !program.scope.getBinding(decl.id.name)?.constant) continue;
    collapsed.push({ stmt, ns, local: decl.id.name, prop });
  }
  for (const { stmt, ns, local, prop } of collapsed) {
    body.splice(body.indexOf(stmt), 1);
    const specifier = prop === "default" ? t.importDefaultSpecifier(t.identifier(local)) : t.importSpecifier(t.identifier(local), t.identifier(prop));
    body.splice(body.indexOf(ns) + 1, 0, t.importDeclaration([specifier], t.stringLiteral(ns.source.value)));
  }
}

function namespaceToNamed(ast: t.File, defaultNameFor: (specifier: string) => string | null, skip: (source: string) => boolean = () => false): void {
  const program = programPath(ast);
  program.scope.crawl();
  for (const [local, decl] of namespaceImports(program)) {
    if (skip(decl.source.value)) continue;
    const binding = program.scope.getBinding(local);
    if (!binding) continue;
    if (!binding.referencePaths.length) {
      program.node.body.splice(program.node.body.indexOf(decl), 1);
      continue;
    }
    const members = new Map<string, NodePath[]>();
    let simple = binding.constantViolations.length === 0;
    for (const ref of binding.referencePaths) {
      const parent = ref.parentPath;
      let prop: string | null = null;
      if (parent?.isMemberExpression() && parent.node.object === ref.node && !parent.node.computed) {
        const assigned = parent.parentPath?.isAssignmentExpression() && parent.parentPath.node.left === parent.node;
        if (!assigned) prop = literalKey(parent.node.property);
      } else if (parent?.isJSXMemberExpression() && parent.node.object === ref.node) {
        prop = parent.node.property.name;
      }
      if (!prop || !parent || !(isValidName(prop) || prop === "default")) {
        simple = false;
        break;
      }
      members.set(prop, [...(members.get(prop) ?? []), parent]);
    }
    if (!simple) continue;

    const existing = new Map<string, string>();
    for (const stmt of program.node.body) {
      if (!t.isImportDeclaration(stmt) || stmt === decl || stmt.source.value !== decl.source.value) continue;
      for (const spec of stmt.specifiers) {
        if (t.isImportSpecifier(spec)) existing.set(t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value, spec.local.name);
        else if (t.isImportDefaultSpecifier(spec)) existing.set("default", spec.local.name);
      }
    }
    const specifiers: Array<t.ImportSpecifier | t.ImportDefaultSpecifier> = [];
    for (const [prop, uses] of members) {
      const reuse = existing.get(prop);
      if (reuse) {
        for (const use of uses) use.replaceWith(use.isJSXMemberExpression() ? t.jsxIdentifier(reuse) : t.identifier(reuse));
        continue;
      }
      let wanted = prop === "default" ? (defaultNameFor(decl.source.value) ?? `${camel(decl.source.value.replace(/^.*\//, "").replace(/\.js$/, "")) || "module"}Default`) : prop;
      if (/^[a-z_$]/.test(wanted) && uses.some((use) => use.isJSXMemberExpression())) wanted = capitalize(wanted.replace(/^[_$]+/, "")) || "Component";
      const name = freeName(program, uses, wanted);
      specifiers.push(prop === "default" ? t.importDefaultSpecifier(t.identifier(name)) : t.importSpecifier(t.identifier(name), t.identifier(prop)));
      for (const use of uses) use.replaceWith(use.isJSXMemberExpression() ? t.jsxIdentifier(name) : t.identifier(name));
    }
    specifiers.sort((a, b) => (t.isImportDefaultSpecifier(a) ? -1 : t.isImportDefaultSpecifier(b) ? 1 : 0));
    decl.specifiers = specifiers;
    program.scope.crawl();
  }
}

const FRAGMENT_SOURCES = new Set(["react", "react/jsx-runtime"]);

function shortFragments(ast: t.File): void {
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      if (!t.isJSXIdentifier(opening.name) || opening.attributes.length) return;
      const binding = path.scope.getBinding(opening.name.name);
      const spec = binding?.path.node;
      const decl = binding?.path.parentPath?.node;
      if (!t.isImportSpecifier(spec) || !t.isImportDeclaration(decl) || !FRAGMENT_SOURCES.has(decl.source.value)) return;
      if ((t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) !== "Fragment") return;
      path.replaceWith(t.jsxFragment(t.jsxOpeningFragment(), t.jsxClosingFragment(), path.node.children));
    },
  });
  const program = programPath(ast);
  program.scope.crawl();
  for (const stmt of [...ast.program.body]) {
    if (!t.isImportDeclaration(stmt) || !stmt.specifiers.length) continue;
    stmt.specifiers = stmt.specifiers.filter((spec) => program.scope.getBinding(spec.local.name)?.referenced !== false);
    if (!stmt.specifiers.length) ast.program.body.splice(ast.program.body.indexOf(stmt), 1);
  }
}

function unwrapIndirectCalls(ast: t.File): void {
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (t.isSequenceExpression(callee) && callee.expressions.length === 2 && t.isNumericLiteral(callee.expressions[0]) && t.isIdentifier(callee.expressions[1])) {
        path.node.callee = callee.expressions[1];
      }
    },
  });
}

function inlineImportAliases(ast: t.File): void {
  const program = programPath(ast);
  program.scope.crawl();
  program.traverse({
    VariableDeclarator(path) {
      const { id, init } = path.node;
      if (!t.isIdentifier(id) || !t.isIdentifier(init) || path.scope === program.scope) return;
      const target = program.scope.getBinding(init.name);
      if (!target || path.scope.getBinding(init.name) !== target || !(t.isImportSpecifier(target.path.node) || t.isImportDefaultSpecifier(target.path.node))) return;
      const binding = path.scope.getBinding(id.name);
      if (!binding?.constant || binding.referencePaths.some((ref) => ref.scope.getBinding(init.name) !== target)) return;
      for (const ref of binding.referencePaths) ref.replaceWith(ref.isJSXIdentifier() ? t.jsxIdentifier(init.name) : t.identifier(init.name));
      path.remove();
    },
  });
  program.scope.crawl();
}

function freeFor(program: NodePath<t.Program>, local: string, wanted: string): boolean {
  const binding = program.scope.getBinding(local);
  if (!binding || program.scope.hasBinding(wanted)) return false;
  return [...binding.referencePaths, ...binding.constantViolations].every((ref) => !ref.scope.hasBinding(wanted));
}

function freeName(program: NodePath<t.Program>, uses: NodePath[], wanted: string): string {
  const base = isValidName(wanted) ? wanted : `_${camel(wanted) || "value"}`;
  const taken = (name: string) =>
    program.scope.hasBinding(name) || uses.some((use) => use.scope.hasBinding(name)) || Boolean((program.scope as unknown as { globals: Record<string, unknown> }).globals[name]);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}${n}`)) return `${base}${n}`;
}

function nameDefaultExport(ast: t.File, moduleName: string | undefined): void {
  if (!moduleName || !/^[A-Z][A-Za-z0-9]*$/.test(moduleName)) return;
  const program = programPath(ast);
  for (const stmt of program.node.body) {
    if (!t.isExportDefaultDeclaration(stmt)) continue;
    const decl = stmt.declaration;
    if (!t.isFunctionDeclaration(decl) && !t.isClassDeclaration(decl)) return;
    if (!decl.id) decl.id = t.identifier(moduleName);
    else if ((decl.id.name.length <= 2 || decl.id.name === "Component") && !program.scope.hasBinding(moduleName)) program.scope.rename(decl.id.name, moduleName);
    return;
  }
}

export function mergeImports(ast: t.File): void {
  const body = ast.program.body;
  const bySource = new Map<string, t.ImportDeclaration>();
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i]!;
    if (!t.isImportDeclaration(stmt)) continue;
    const source = stmt.source.value;
    const existing = bySource.get(source);
    const namespace = stmt.specifiers.some((s) => t.isImportNamespaceSpecifier(s)) || existing?.specifiers.some((s) => t.isImportNamespaceSpecifier(s));
    if (!existing || namespace) {
      if (!existing) bySource.set(source, stmt);
      continue;
    }
    const names = new Set(existing.specifiers.map((s) => s.local.name));
    for (const spec of stmt.specifiers) {
      if (names.has(spec.local.name)) continue;
      if (t.isImportDefaultSpecifier(spec) && existing.specifiers.some((s) => t.isImportDefaultSpecifier(s))) continue;
      if (t.isImportDefaultSpecifier(spec)) existing.specifiers.unshift(spec);
      else existing.specifiers.push(spec);
    }
    body.splice(i--, 1);
  }
}

export function pascal(name: string): string {
  return capitalize(camel(name));
}
