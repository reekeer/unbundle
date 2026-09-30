import { posix } from "node:path";
import { DIRS, relativeImport, repointImports, type OutputTree } from "../output.ts";
import { parseProgram, print, t, traverse, type NodePath } from "../unpack/ast.ts";

const GENERIC = /^(_?Component\d*|[A-Za-z_$][\w$]?)$/;

function attr(el: t.JSXOpeningElement, name: string): t.JSXAttribute | null {
  return el.attributes.find((a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name })) ?? null;
}

function stringAttr(el: t.JSXOpeningElement, name: string): string | null {
  const value = attr(el, name)?.value;
  if (t.isStringLiteral(value)) return value.value;
  if (t.isJSXExpressionContainer(value) && t.isStringLiteral(value.expression)) return value.expression.value;
  return null;
}

function elementTarget(el: t.JSXOpeningElement): string | null {
  const value = attr(el, "element")?.value;
  const inner = t.isJSXExpressionContainer(value) ? value.expression : null;
  return t.isJSXElement(inner) && t.isJSXIdentifier(inner.openingElement.name) && !inner.openingElement.attributes.length ? inner.openingElement.name.name : null;
}

function pascal(word: string): string {
  return word
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|us)$/.test(word)) return word;
  return word.replace(/s$/, "");
}

export function routeName(segments: string[], index: boolean): string | null {
  if (segments.includes("*")) return segments.length === 1 ? "NotFound" : `${routeName(segments.filter((s) => s !== "*"), false) ?? ""}NotFound`;
  const words: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(":")) {
      if (words.length) words[words.length - 1] = singular(words[words.length - 1]!);
      continue;
    }
    if (!/^[A-Za-z][\w.-]*$/.test(segment)) return null;
    words.push(pascal(segment));
  }
  if (index) words.push(words.length ? "Index" : "Home");
  if (!words.length) return "Home";
  return words.join("");
}

function returnedJsx(fn: t.Node): t.JSXElement | null {
  const body = t.isFunction(fn) ? fn.body : null;
  if (t.isJSXElement(body)) return body;
  if (!t.isBlockStatement(body)) return null;
  const last = [...body.body].reverse().find((s): s is t.ReturnStatement => t.isReturnStatement(s));
  return t.isJSXElement(last?.argument) ? last.argument : null;
}

function rootComponents(program: NodePath<t.Program>): Map<string, string> {
  const out = new Map<string, string>();
  const declaration = (name: string) => {
    const binding = program.scope.getBinding(name);
    const node = binding?.path.node;
    if (t.isFunctionDeclaration(node)) return node;
    if (t.isVariableDeclarator(node) && t.isFunction(node.init)) return node.init;
    return null;
  };
  program.traverse({
    JSXOpeningElement(path) {
      if (!t.isJSXIdentifier(path.node.name, { name: "Routes" })) return;
      const fn = path.getFunctionParent();
      const owner = fn?.isFunctionDeclaration() ? fn.node.id?.name : fn?.parentPath?.isVariableDeclarator() && t.isIdentifier(fn.parentPath.node.id) ? fn.parentPath.node.id.name : null;
      if (owner && GENERIC.test(owner) && fn?.parentPath?.parentPath?.isProgram() !== false) out.set(owner, "App");
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: "render" }) || !t.isJSXElement(path.node.arguments[0])) return;
      const visit = (el: t.JSXElement) => {
        const name = t.isJSXIdentifier(el.openingElement.name) ? el.openingElement.name.name : null;
        const children = el.children.filter((c): c is t.JSXElement => t.isJSXElement(c));
        if (name && GENERIC.test(name) && /^[A-Z_]/.test(name)) {
          const root = declaration(name) ? returnedJsx(declaration(name)!) : null;
          const provider = root && t.isJSXMemberExpression(root.openingElement.name) && root.openingElement.name.property.name === "Provider";
          if (!children.length && !el.children.some((c) => t.isJSXExpressionContainer(c) && !t.isJSXEmptyExpression(c.expression)) && ![...out.values()].includes("App")) out.set(name, "App");
          else if (provider) out.set(name, "AppProvider");
        }
        for (const child of children) visit(child);
      };
      visit(path.node.arguments[0]);
    },
  });
  return out;
}

export function nameRouteComponents(code: string, pages: Set<string>): string {
  if (!(/\belement=\{</.test(code) && /\bpath=/.test(code)) && !/\.render\(\s*</.test(code)) return code;
  const ast = parseProgram(code);
  let program: NodePath<t.Program> | undefined;
  const wanted = new Map<string, string>();
  const tags = new Set<string>();
  traverse(ast, {
    Program(path) {
      program = path;
    },
    JSXOpeningElement(path) {
      const el = path.node;
      const target = elementTarget(el);
      const own = stringAttr(el, "path");
      const index = !!attr(el, "index");
      if (!target || (own === null && !index) || !t.isJSXIdentifier(el.name)) return;
      const segments: string[] = [];
      for (let parent = path.parentPath?.parentPath; parent; parent = parent.parentPath) {
        if (!parent.isJSXElement()) continue;
        const prefix = stringAttr(parent.node.openingElement, "path");
        if (prefix && elementTarget(parent.node.openingElement)) segments.unshift(...prefix.split("/").filter(Boolean));
      }
      segments.push(...(own ?? "").split("/").filter(Boolean));
      if (own === "*") segments.splice(0, segments.length, "*");
      const name = routeName(segments, index);
      tags.add(el.name.name);
      if (!name || wanted.has(target)) return;
      wanted.set(target, name);
    },
  });
  if (!program) return code;
  const scope = program.scope;
  let changed = false;
  const taken = new Set(Object.keys(scope.bindings));
  const routed = new Set(wanted.keys());
  for (const [local, name] of rootComponents(program)) if (!wanted.has(local)) wanted.set(local, name);
  for (const tag of tags) {
    const binding = scope.getBinding(tag);
    const imported = binding?.path.isImportSpecifier() && /react-router/.test((binding.path.parent as t.ImportDeclaration).source.value);
    if (!binding || !imported || tag === "Route" || taken.has("Route")) continue;
    scope.rename(tag, "Route");
    taken.add("Route");
    changed = true;
  }
  for (const [local, name] of wanted) {
    const binding = scope.getBinding(local);
    if (binding && !GENERIC.test(local) && routed.has(local)) pages.add(local);
    if (!binding || !GENERIC.test(local) || binding.path.isImportSpecifier() || binding.path.isImportDefaultSpecifier()) continue;
    let next = name;
    for (let n = 2; taken.has(next); n++) next = `${name}${n}`;
    scope.rename(local, next);
    taken.add(next);
    if (routed.has(local)) pages.add(next);
    changed = true;
  }
  return changed ? print(ast) : code;
}

export function movePages(tree: OutputTree, pages: ReadonlySet<string>): Map<string, string> {
  const moved = new Map<string, string>();
  const taken = new Set(tree.all().map((f) => f.path));
  for (const file of tree.all()) {
    const match = new RegExp(`^${DIRS.js}/components/([A-Z][\\w]*)(\\.m?[jt]sx?|\\.vue)$`).exec(file.path);
    if (!match || !pages.has(match[1]!)) continue;
    const next = posix.join(DIRS.js, "pages", `${match[1]}${match[2]}`);
    if (taken.has(next)) continue;
    tree.remove(file.path);
    const content = file.content.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g, (_, lead: string, quote: string, spec: string) => `${lead}${quote}${relativeImport(next, posix.normalize(posix.join(posix.dirname(file.path), spec)))}${quote}`);
    tree.add({ ...file, path: next, content });
    taken.add(next);
    repointImports(tree, file.path, next);
    moved.set(file.path, next);
  }
  return moved;
}
