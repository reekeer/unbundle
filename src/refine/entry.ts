import { posix } from "node:path";
import { DIRS, relativeImport, repointImports, type OutputTree } from "../output.ts";
import { parseProgram, print, t, traverse, type NodePath } from "../unpack/ast.ts";

const BOOT_METHODS = new Set(["mount", "render"]);
const MIN_SHARED = 5;

function isBootstrap(stmt: t.Statement): boolean {
  if (!t.isExpressionStatement(stmt)) return false;
  let expr = stmt.expression;
  if (t.isAwaitExpression(expr)) expr = expr.argument;
  if (!t.isCallExpression(expr) || !t.isMemberExpression(expr.callee) || !t.isIdentifier(expr.callee.property)) return false;
  return BOOT_METHODS.has(expr.callee.property.name) && t.isCallExpression(expr.callee.object);
}

function isBareCall(stmt: t.Statement): boolean {
  return t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression) && t.isIdentifier(stmt.expression.callee) && stmt.expression.arguments.length === 0;
}

function holdsState(body: t.Statement[]): boolean {
  let found = false;
  for (const stmt of body) {
    const decls = t.isVariableDeclaration(stmt) ? stmt.declarations : [];
    for (const d of decls) {
      if (t.isCallExpression(d.init) && t.isIdentifier(d.init.callee) && /^(reactive|defineStore|createStore|create|createSlice|configureStore|atom|writable)$/.test(d.init.callee.name)) found = true;
    }
  }
  return found;
}

function scopeOf(ast: t.File): NodePath<t.Program>["scope"] | null {
  let found: NodePath<t.Program>["scope"] | null = null;
  traverse(ast, {
    Program(path) {
      found = path.scope;
      path.stop();
    },
  });
  return found;
}

function freePath(tree: OutputTree, dir: string, base: string, ext: string): string {
  const taken = new Set(tree.all().map((f) => f.path));
  let path = posix.join(dir, `${base}${ext}`);
  for (let n = 2; taken.has(path); n++) path = posix.join(dir, `${base}${n}${ext}`);
  return path;
}

export function splitEntry(tree: OutputTree): Map<string, string> {
  const moved = new Map<string, string>();
  for (const file of tree.all()) {
    if (file.kind !== "module" || file.library || posix.dirname(file.path) !== DIRS.js || !/\.m?jsx?$/.test(file.path)) continue;
    const ast = parseProgram(file.content);
    const body = ast.program.body;
    const boot = body.findIndex(isBootstrap);
    if (boot < 0) continue;
    let start = boot;
    while (start > 0 && isBareCall(body[start - 1]!)) start--;
    const main = new Set(body.slice(start).filter((s) => isBootstrap(s) || isBareCall(s)));
    const declaredBy = (stmt: t.Statement) => Object.keys(t.getBindingIdentifiers(stmt));
    const exportedLocal = new Set(body.flatMap((s) => (t.isExportNamedDeclaration(s) && !s.declaration && !s.source ? s.specifiers.flatMap((spec) => (t.isExportSpecifier(spec) ? [spec.local.name] : [])) : [])));
    const referencedOnlyByMain = (name: string) => {
      const binding = scopeOf(ast)?.getBinding(name);
      if (!binding || exportedLocal.has(name)) return false;
      return binding.referencePaths.every((ref) => {
        const top = ref.find((p) => p.parentPath?.isProgram() === true)?.node as t.Statement | undefined;
        return !!top && main.has(top);
      });
    };
    for (let i = start - 1; i >= 0; i--) {
      const stmt = body[i]!;
      if (t.isImportDeclaration(stmt) || t.isExportNamedDeclaration(stmt)) break;
      const names = declaredBy(stmt);
      const guard = t.isIfStatement(stmt) && t.isThrowStatement(t.isBlockStatement(stmt.consequent) ? stmt.consequent.body[0] : stmt.consequent);
      if (names.length ? !names.every(referencedOnlyByMain) : !guard) break;
      main.add(stmt);
    }
    const imports = body.filter((s): s is t.ImportDeclaration => t.isImportDeclaration(s));
    const exportList = body.filter((s): s is t.ExportNamedDeclaration => t.isExportNamedDeclaration(s) && !s.declaration && !s.source);
    const rest = body.filter((s) => !main.has(s) && !t.isImportDeclaration(s) && !exportList.includes(s as t.ExportNamedDeclaration));
    const declared = rest.filter((s) => t.isDeclaration(s)).length;
    if (declared < MIN_SHARED || !exportList.length) continue;

    const usedIn = new Map<t.Statement, Set<string>>();
    let program: NodePath<t.Program> | undefined;
    traverse(ast, {
      Program(path) {
        program = path;
        path.stop();
      },
    });
    for (const [name, binding] of Object.entries(program!.scope.bindings)) {
      for (const ref of binding.referencePaths) {
        const top = ref.find((p) => p.parentPath?.isProgram() === true)?.node as t.Statement | undefined;
        if (!top) continue;
        if (!usedIn.has(top)) usedIn.set(top, new Set());
        usedIn.get(top)!.add(name);
      }
    }
    const namesOf = (stmts: Iterable<t.Statement>) => new Set([...stmts].flatMap((s) => [...(usedIn.get(s) ?? [])]));
    const restDeclared = new Set(rest.flatMap((s) => Object.keys(t.getBindingIdentifiers(s))));
    const mainUses = namesOf(main);
    const restUses = namesOf([...rest, ...exportList]);
    const pick = (uses: Set<string>) =>
      imports.flatMap((decl) => {
        const specifiers = decl.specifiers.filter((s) => uses.has(s.local.name));
        return specifiers.length ? [t.importDeclaration(specifiers.map((s) => t.cloneNode(s)), t.stringLiteral(decl.source.value))] : [];
      });

    const ext = posix.extname(file.path);
    const shared = freePath(tree, DIRS.js, holdsState(rest) ? "store" : "shared", ext);
    const entryPath = posix.basename(file.path).startsWith("index.") ? freePath(tree, DIRS.js, "main", ext) : file.path;
    const exported = new Map<string, string>();
    for (const s of exportList) for (const spec of s.specifiers) if (t.isExportSpecifier(spec)) exported.set(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value, spec.local.name);
    for (const name of mainUses) if (restDeclared.has(name) && !exported.has(name)) exported.set(name, name);
    const sharedBody: t.Statement[] = [...pick(restUses).map((d) => rewriteRelative(d, file.path, shared)), ...rest, t.exportNamedDeclaration(null, [...exported].map(([name, local]) => t.exportSpecifier(t.identifier(local), t.identifier(name))))];
    const fromShared = [...mainUses].filter((name) => restDeclared.has(name));
    const mainBody: t.Statement[] = [...pick(mainUses).map((d) => rewriteRelative(d, file.path, entryPath)), ...(fromShared.length ? [t.importDeclaration(fromShared.map((name) => t.importSpecifier(t.identifier(name), t.identifier(name))), t.stringLiteral(relativeImport(entryPath, shared)))] : []), ...body.filter((s) => main.has(s))];

    tree.remove(file.path);
    tree.add({ ...file, path: shared, content: print(t.file(t.program(sharedBody))) });
    tree.add({ ...file, path: entryPath, content: print(t.file(t.program(mainBody))) });
    moved.set(file.path, entryPath);
    repointImports(tree, file.path, shared, new Set([shared, entryPath]));
  }
  return moved;
}

function rewriteRelative(decl: t.ImportDeclaration, from: string, to: string): t.ImportDeclaration {
  const spec = decl.source.value;
  if (!spec.startsWith(".") || posix.dirname(from) === posix.dirname(to)) return decl;
  decl.source = t.stringLiteral(relativeImport(to, posix.normalize(posix.join(posix.dirname(from), spec))));
  return decl;
}
