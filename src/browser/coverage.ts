import type { NodePath } from "@babel/traverse";
import type { LoaderFinding } from "../types.ts";
import { literalKey, parseForFile, print, t, traverse } from "../unpack/ast.ts";

export interface SeenUrl {
  value: string;
  file: string;
  line: number;
}

export interface LoaderScan {
  loaders: LoaderFinding[];
  urls: SeenUrl[];
}

const SCRIPT_URL = /^(https?:\/\/[^\s"'`<>]+|\/[^\s"'`<>]*)\.(m?js|css)(\?[^\s"'`<>]*)?$/i;
const HTML_WITH_SCRIPT = /<script\b[^>]*\bsrc\s*=/i;

function isStatic(node: t.Node | null | undefined): boolean {
  return t.isStringLiteral(node) || (t.isTemplateLiteral(node) && node.expressions.length === 0);
}

function staticValue(node: t.Node | null | undefined): string | null {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function snippet(node: t.Node): string {
  const text = print(node).replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function isCreateScript(node: t.Node | null | undefined): boolean {
  return t.isCallExpression(node) && literalKey(t.isMemberExpression(node.callee) ? node.callee.property : node.callee) === "createElement" && staticValue(node.arguments[0])?.toLowerCase() === "script";
}

function calleeName(node: t.Node): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && !node.computed) return literalKey(node.property);
  return null;
}

function scriptElementBinding(path: NodePath, object: t.Node): boolean {
  if (isCreateScript(object)) return true;
  if (!t.isIdentifier(object)) return false;
  const binding = path.scope.getBinding(object.name);
  if (!binding) return false;
  if (binding.path.isVariableDeclarator() && isCreateScript(binding.path.node.init)) return true;
  return binding.constantViolations.some((v) => v.isAssignmentExpression() && isCreateScript(v.node.right));
}

export function scanLoaders(file: string, code: string): LoaderScan {
  const loaders: LoaderFinding[] = [];
  const urls: SeenUrl[] = [];
  let ast: t.File;
  try {
    ast = parseForFile(file, code);
  } catch {
    return { loaders, urls };
  }
  const regionStrings = (path: NodePath) => {
    let top: NodePath = path;
    while (top.parentPath && !top.parentPath.isProgram()) top = top.parentPath;
    const found = new Set<string>();
    t.traverseFast(top.node, (node) => {
      if (t.isStringLiteral(node) && node.value.length >= 8) found.add(node.value);
    });
    return [...found].slice(0, 200);
  };
  let current: NodePath | null = null;
  const regionName = (path: NodePath): string | undefined => {
    let top: NodePath = path;
    while (top.parentPath && !top.parentPath.isProgram()) top = top.parentPath;
    const node = t.isExportNamedDeclaration(top.node) || t.isExportDefaultDeclaration(top.node) ? top.node.declaration : top.node;
    if ((t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) && node.id) return node.id.name;
    if (t.isVariableDeclaration(node) && node.declarations.length === 1 && t.isIdentifier(node.declarations[0]!.id)) return node.declarations[0]!.id.name;
    return undefined;
  };
  const add = (kind: string, node: t.Node) =>
    loaders.push({
      kind,
      file,
      line: node.loc?.start.line ?? 0,
      snippet: snippet(node),
      ...(current ? { regionStrings: regionStrings(current), regionName: regionName(current) } : {}),
    });
  const seen = (value: string, node: t.Node) => {
    if (SCRIPT_URL.test(value)) urls.push({ value, file, line: node.loc?.start.line ?? 0 });
  };

  traverse(ast, {
    StringLiteral(path) {
      seen(path.node.value, path.node);
    },
    TemplateLiteral(path) {
      const value = staticValue(path.node);
      if (value) seen(value, path.node);
    },
    CallExpression(path) {
      current = path;
      const { callee, arguments: args } = path.node;
      if (t.isImport(callee)) {
        if (!isStatic(args[0])) add("dynamic-import", path.node);
        return;
      }
      const name = calleeName(callee);
      if (isModuleLoader(callee) && args.length && !isStatic(args[0]) && !t.isNumericLiteral(args[0])) {
        add("dynamic-require", path.node);
        return;
      }
      if (name === "importScripts" && args.some((a) => !isStatic(a))) add("import-scripts", path.node);
      else if (name === "eval" && t.isIdentifier(callee) && !isStatic(args[0])) add("eval", path.node);
      else if (name === "ensure" && t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: "require" })) add("require-ensure", path.node);
      else if (name === "import" && t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: "System" })) add("system-import", path.node);
      else if (name === "setAttribute" && t.isMemberExpression(callee) && staticValue(args[0]) === "src" && scriptElementBinding(path, callee.object)) {
        if (!isStatic(args[1])) add("script-element", path.node);
      } else if ((name === "insertAdjacentHTML" || name === "write" || name === "writeln") && args.some((a) => HTML_WITH_SCRIPT.test(staticValue(a) ?? ""))) {
        add("inject-html", path.node);
      }
    },
    NewExpression(path) {
      current = path;
      const { callee, arguments: args } = path.node;
      const name = calleeName(callee);
      if ((name === "Worker" || name === "SharedWorker") && !isStatic(args[0]) && !isStaticUrl(args[0])) add("worker", path.node);
      else if (name === "Function" && args.length && !args.every((a) => isStatic(a))) add("eval", path.node);
      else if (name === "URL" && t.isMetaProperty(t.isMemberExpression(args[1]) ? args[1].object : null) && !isStatic(args[0])) add("url-import-meta", path.node);
    },
    AssignmentExpression(path) {
      current = path;
      const { left, right } = path.node;
      if (!t.isMemberExpression(left) || left.computed) return;
      const prop = literalKey(left.property);
      if (prop === "src" && scriptElementBinding(path, left.object)) {
        if (!isStatic(right)) add("script-element", path.node);
      } else if ((prop === "innerHTML" || prop === "outerHTML") && HTML_WITH_SCRIPT.test(staticValue(right) ?? "")) {
        add("inject-html", path.node);
      }
    },
  });
  return { loaders, urls };
}

function isModuleLoader(callee: t.Node): boolean {
  if (t.isIdentifier(callee)) return callee.name === "__webpack_require__" || callee.name === "require";
  return t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: "__turbopack_context__" }) && ["i", "r", "A"].includes(literalKey(callee.property) ?? "");
}

function isStaticUrl(node: t.Node | null | undefined): boolean {
  return t.isNewExpression(node) && calleeName(node.callee) === "URL" && isStatic(node.arguments[0]);
}
