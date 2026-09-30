import type { NodePath } from "@babel/traverse";
import { parseProgram, print, t, traverse } from "../unpack/ast.ts";
import { camel, capitalize } from "./rename.ts";

export interface WrappedModule {
  package: string;
  file: string;
}

interface Wrapper {
  fn: string;
  exports: string;
  body: t.Statement[];
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

function returnedIdentifier(stmt: t.Statement | undefined): string | null {
  if (t.isReturnStatement(stmt) && t.isIdentifier(stmt.argument)) return stmt.argument.name;
  if (t.isBlockStatement(stmt) && stmt.body.length === 1) return returnedIdentifier(stmt.body[0]);
  return null;
}

function wrapperOf(fn: t.FunctionDeclaration): Wrapper | null {
  const body = fn.body.body;
  if (fn.params.length || body.length < 4 || !fn.id) return null;
  const [guard, mark] = body;
  if (!t.isIfStatement(guard) || !t.isIdentifier(guard.test) || guard.alternate) return null;
  const exports = returnedIdentifier(guard.consequent);
  if (!exports || returnedIdentifier(body.at(-1)) !== exports) return null;
  const flag = guard.test.name;
  if (!t.isExpressionStatement(mark) || !t.isAssignmentExpression(mark.expression) || !t.isIdentifier(mark.expression.left, { name: flag })) return null;
  return { fn: fn.id.name, exports, body: body.slice(2, -1) };
}

function moduleName(file: string): string {
  const stem = file.replace(/^.*\//, "").replace(/\.[cm]?js$/, "");
  return camel(stem.replace(/[._-]+/g, " ")) || "module";
}

export function nameCommonJsWrappers(code: string, identify: (body: string) => WrappedModule | null): { code: string; found: Array<WrappedModule & { fn: string }>; namespaces: Map<string, string> } {
  const ast = parseProgram(code);
  const wrappers = ast.program.body.flatMap((stmt) => (t.isFunctionDeclaration(stmt) ? [wrapperOf(stmt)].filter((w): w is Wrapper => !!w) : []));
  if (!wrappers.length) return { code, found: [], namespaces: new Map() };
  const program = programPath(ast);
  const found: Array<WrappedModule & { fn: string }> = [];
  for (const wrapper of wrappers) {
    const scratch = t.file(t.program([t.variableDeclaration("var", [t.variableDeclarator(t.identifier(wrapper.exports), t.objectExpression([]))]), ...wrapper.body.map((s) => t.cloneNode(s, true))]));
    const scratchProgram = programPath(scratch);
    if (!scratchProgram.scope.hasBinding("exports")) scratchProgram.scope.rename(wrapper.exports, "exports");
    let match: WrappedModule | null = null;
    try {
      match = identify(print(scratch));
    } catch {
      match = null;
    }
    if (!match) continue;
    const base = moduleName(match.file);
    const names: Array<[string, string]> = [
      [wrapper.fn, `require${capitalize(base)}`],
      [wrapper.exports, base],
    ];
    for (const [from, to] of names) {
      if (from === to || program.scope.hasBinding(to) || from.length > 3) continue;
      const binding = program.scope.getBinding(from);
      if (!binding || [...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(to))) continue;
      program.scope.rename(from, to);
    }
    const binding = program.scope.getBinding(`require${capitalize(base)}`);
    found.push({ ...match, fn: binding ? `require${capitalize(base)}` : wrapper.fn });
  }
  const namespaces = new Map<string, string>();
  if (found.length) nameEntryWrappers(ast, program, found, namespaces);
  return { code: found.length ? print(ast) : code, found, namespaces };
}

export const NAMESPACE_LOCAL = /^(React|ReactDOM\w*|jsxRuntime|Scheduler)$/;

const NAMESPACE_NAMES: Record<string, string> = { react: "React", "react-dom": "ReactDOM", "react-dom/client": "ReactDOMClient", "react/jsx-runtime": "jsxRuntime", "react-dom/server": "ReactDOMServer", scheduler: "Scheduler" };

export function specifierOf(found: WrappedModule): string {
  const stem = found.file.replace(/^.*\//, "").replace(/\.(production|development)(\.min)?\.[cm]?js$/, "").replace(/\.[cm]?js$/, "");
  const bare = found.package.replace(/^@[^/]+\//, "");
  if (stem === bare || stem === "index") return found.package;
  return stem.startsWith(`${bare}-`) ? `${found.package}/${stem.slice(bare.length + 1)}` : found.package;
}

function namespaceName(specifier: string): string {
  return NAMESPACE_NAMES[specifier] ?? camel(specifier.replace(/^@/, "").replace(/[/._-]+/g, " "));
}

function nameEntryWrappers(ast: t.File, program: NodePath<t.Program>, found: Array<WrappedModule & { fn: string }>, namespaces: Map<string, string>): void {
  const byFn = new Map(found.map((f) => [f.fn, f]));
  for (const top of ast.program.body) {
    const exported = t.isExportNamedDeclaration(top);
    const stmt = exported ? top.declaration : top;
    if (!t.isFunctionDeclaration(stmt) || !stmt.id || stmt.params.length) continue;
    const last = stmt.body.body.at(-1);
    if (!t.isReturnStatement(last) || !t.isMemberExpression(last.argument) || !t.isIdentifier(last.argument.object)) continue;
    let inner: (WrappedModule & { fn: string }) | undefined;
    t.traverseFast(stmt.body, (n) => {
      if (!inner && t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && t.isCallExpression(n.right) && t.isIdentifier(n.right.callee)) inner = byFn.get(n.right.callee.name);
    });
    if (!inner) continue;
    const specifier = specifierOf(inner);
    const entry = `require${capitalize(namespaceName(specifier))}`;
    const fnName = stmt.id.name;
    if (!exported && fnName.length <= 3 && !program.scope.hasBinding(entry)) program.scope.rename(fnName, entry);
    const callee = program.scope.getBinding(entry) ? entry : fnName;
    for (const other of ast.program.body) {
      const declarations = t.isVariableDeclaration(other) ? other.declarations : t.isExportNamedDeclaration(other) && t.isVariableDeclaration(other.declaration) ? other.declaration.declarations : [];
      for (const d of declarations) {
        if (!t.isIdentifier(d.id) || !t.isCallExpression(d.init) || !t.isIdentifier(d.init.callee, { name: callee }) || d.init.arguments.length) continue;
        const wanted = namespaceName(specifier);
        let local = d.id.name;
        if (local.length <= 3 && t.isVariableDeclaration(other) && !program.scope.hasBinding(wanted)) {
          program.scope.rename(local, wanted);
          local = wanted;
        }
        namespaces.set(local, specifier);
      }
    }
  }
}
