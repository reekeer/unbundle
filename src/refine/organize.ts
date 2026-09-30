import type { NodePath } from "@babel/traverse";
import { posix } from "node:path";
import { DIRS, relativeImport, safeSegment, type OutputTree } from "../output.ts";
import type { Manifest, OutputFile } from "../types.ts";
import { literalKey, parseProgram, print, t, traverse } from "../unpack/ast.ts";
import { UTILITY_CLASS } from "./analyze.ts";
import { camel, capitalize, jsxRoot, RESERVED, tidyAst } from "./rename.ts";
import type { LibraryComponent } from "./fingerprint.ts";
import { mergeImports, packageNamespaceCode, reactNamespaceCode } from "./cleanup.ts";
import { angularSourceCode } from "./angular.ts";
import { hasApiPath, nameClasses, type ClassName } from "./classes.ts";
import { algorithmTopic } from "./crypto.ts";
import { componentOptions, composableSource, inferVueRoles, isVueApi, renameVueHelpers, renderFunction, renderTemplate, type Roles, type SfcContext } from "./vue.ts";

export type Folder = "components" | "pages" | "hooks" | "stores" | "functions" | "constants" | "icons" | "api" | "plugins";

const FOLDERS: Folder[] = ["components", "pages", "hooks", "stores", "functions", "constants", "icons", "api", "plugins"];
const STORE_FACTORIES = new Set(["create", "createStore", "defineStore", "createSlice", "configureStore"]);
const COMPONENT_WRAPPERS = new Set(["forwardRef", "memo", "defineComponent", "observer", "lazy"]);
const RENDER_CALLS = new Set(["jsx", "jsxs", "jsxDEV", "createElement", "h", "createVNode", "createElementBlock", "createElementVNode", "createBlock", "openBlock"]);

interface Unit {
  index: number;
  name: string;
  statement: t.Statement;
  exported: string[];
  isDefault: boolean;
  init: t.Node | null;
  functionLike: boolean;
}

interface Piece {
  folder: Folder | null;
  name: string;
  units: Unit[];
  path: string;
  jsx: boolean;
  vue?: { template: string; components: Set<string>; free: Set<string>; style?: string };
}

interface Plan {
  path: string;
  file: OutputFile;
  pieces: Piece[];
  remainder: t.Statement[];
  keepImports: t.ImportDeclaration[];
  exportsTo: Map<string, { path: string; name: string }>;
  ast: t.File;
  program: NodePath<t.Program>;
  pieceOf: Map<string, Piece>;
  units: Unit[];
  remainderExports: Set<string>;
  roles: Roles;
  vendor: string | null;
  vendorPackage?: string | null;
  namespaces: Map<string, string>;
  outPath: string;
  components: ReadonlyMap<string, LibraryComponent>;
  autoImports: boolean;
  bare: Map<string, string>;
  route?: string;
}

export interface OrganizeResult {
  files: number;
  split: number;
  packageRoles: Map<string, Map<string, Set<string>>>;
  moved: Map<string, { primary: string | null; parts: string[]; exports: Record<string, string> }>;
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

function isValidName(name: string): boolean {
  return t.isValidIdentifier(name, true) && !RESERVED.has(name);
}

function isMangled(name: string): boolean {
  return name.length <= 2 || /^_?(component|module|value|fn)\d*$/i.test(name) || /^_[a-z]\d*$/i.test(name);
}

function hasJsx(node: t.Node): boolean {
  let found = false;
  t.traverseFast(node, (n) => {
    if (!found && (t.isJSXElement(n) || t.isJSXFragment(n))) found = true;
  });
  return found;
}

function calleeName(node: t.Node | null | undefined): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) return node.property.name;
  if (t.isSequenceExpression(node)) return calleeName(node.expressions.at(-1));
  if (t.isCallExpression(node)) return calleeName(node.callee);
  return null;
}

function rendersMarkup(node: t.Node): boolean {
  if (hasJsx(node)) return true;
  let found = false;
  t.traverseFast(node, (n) => {
    if (found || !t.isCallExpression(n)) return;
    const callee = calleeName(n.callee) ?? "";
    if (!RENDER_CALLS.has(callee) || (t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.object, { name: "document" }))) return;
    if (callee.length === 1 && !(n.arguments.length >= 2 && (t.isStringLiteral(n.arguments[0]) || t.isIdentifier(n.arguments[0])) && (t.isObjectExpression(n.arguments[1]) || t.isArrayExpression(n.arguments[1]) || t.isNullLiteral(n.arguments[1])))) return;
    found = true;
  });
  return found;
}

function hookComponent(fn: t.Function): boolean {
  if (!t.isBlockStatement(fn.body) || fn.params.length > 1) return false;
  const body = fn.body.body;
  const last = body.at(-1);
  if (!t.isReturnStatement(last) || !t.isNullLiteral(last.argument)) return false;
  return body.some((s) => {
    const expr = t.isExpressionStatement(s) ? s.expression : t.isVariableDeclaration(s) ? s.declarations[0]?.init : null;
    return t.isCallExpression(expr) && /^use[A-Z]/.test(calleeName(expr.callee) ?? "");
  });
}

const GENERIC_PROPS = /^(children|className|class|style|styles|props|t|lang|locale|key|ref|id|onClick|onChange|onClose|onSubmit|disabled|variant|size|tone|as|type|value|data|item|items|options|open|show|visible)$/;

function qualifiedName(unit: Unit, base: string, taken: (name: string) => boolean): string | null {
  const fn = functionNode(unit);
  if (!fn || !hasJsx(unit.statement)) return null;
  const param = fn.params[0];
  const keys = t.isObjectPattern(param) ? param.properties.flatMap((p) => (t.isObjectProperty(p) ? [literalKey(p.key)] : [])).filter((k): k is string => !!k) : [];
  const candidates: string[] = [];
  const tag = markupName(unit).tag;
  if (keys.includes("label") && keys.includes("value")) candidates.push(`Stat${base}`);
  if (tag === "button" && !/Button$/.test(base)) candidates.push(`${base}Button`);
  if (tag === "a" && !/Link$/.test(base)) candidates.push(`${base}Link`);
  for (const key of keys) if (key.length > 2 && !GENERIC_PROPS.test(key) && /^[a-z][A-Za-z0-9]*$/.test(key)) candidates.push(`${pascal(key)}${base}`);
  return candidates.find((candidate) => isValidName(candidate) && !taken(candidate)) ?? null;
}

function functionNode(unit: Unit): t.Function | null {
  const stmt = unit.statement;
  if (t.isFunctionDeclaration(stmt)) return stmt;
  const init = unit.init;
  if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) return init;
  if (t.isCallExpression(init) && init.arguments.length === 1 && (t.isFunctionExpression(init.arguments[0]) || t.isArrowFunctionExpression(init.arguments[0])) && rendersMarkup(init.arguments[0])) return init.arguments[0];
  if (t.isCallExpression(init) && COMPONENT_WRAPPERS.has(calleeName(init.callee) ?? "")) {
    const inner = init.arguments.find((a) => t.isFunctionExpression(a) || t.isArrowFunctionExpression(a));
    return (inner as t.Function | undefined) ?? null;
  }
  return null;
}

function returnedRoot(fn: t.Function): t.Node | null {
  if (t.isExpression(fn.body)) return fn.body;
  const returns = fn.body.body.filter((s): s is t.ReturnStatement => t.isReturnStatement(s));
  return returns.length === 1 ? (returns[0]!.argument ?? null) : null;
}

function svgRoot(unit: Unit): t.JSXElement | null {
  const fn = functionNode(unit);
  if (!fn) return null;
  const root = returnedRoot(fn);
  if (!t.isJSXElement(root) || !t.isJSXIdentifier(root.openingElement.name, { name: "svg" })) return null;
  let hooks = false;
  t.traverseFast(fn.body, (n) => {
    if (t.isCallExpression(n) && /^use[A-Z]/.test(calleeName(n.callee) ?? "")) hooks = true;
  });
  return hooks ? null : root;
}

function attrValue(el: t.JSXElement, name: string): string | null {
  for (const attr of el.openingElement.attributes) {
    if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name, { name })) continue;
    if (t.isStringLiteral(attr.value)) return attr.value.value;
    const expr = t.isJSXExpressionContainer(attr.value) ? attr.value.expression : null;
    return t.isExpression(expr) ? staticPrefix(expr) : null;
  }
  return null;
}

function staticPrefix(expr: t.Expression): string | null {
  if (t.isStringLiteral(expr)) return expr.value.trim() || null;
  if (t.isCallExpression(expr) && t.isStringLiteral(expr.arguments[0])) return expr.arguments[0].value;
  if (t.isTemplateLiteral(expr) && expr.quasis[0]?.value.cooked?.trim()) return expr.quasis[0].value.cooked.trim();
  if (t.isBinaryExpression(expr, { operator: "+" }) && t.isExpression(expr.left)) return staticPrefix(expr.left);
  return null;
}

function pascal(text: string): string {
  return capitalize(camel(text));
}

function iconNameOf(svg: t.JSXElement): string | null {
  const title = svg.children.find((c): c is t.JSXElement => t.isJSXElement(c) && t.isJSXIdentifier(c.openingElement.name, { name: "title" }));
  const titleText = title?.children.map((c) => (t.isJSXText(c) ? c.value : "")).join("").trim();
  const className = attrValue(svg, "className")?.split(/\s+/).find((c) => c && !UTILITY_CLASS.test(c) && !/^(icon|svg)$/i.test(c));
  for (const raw of [attrValue(svg, "aria-label"), titleText, attrValue(svg, "data-icon"), className]) {
    const name = raw ? pascal(raw.replace(/^(icon|svg)[-_]/i, "")) : "";
    if (name && /^[A-Z]/.test(name) && name.length <= 40) return name;
  }
  return null;
}

function localInit(fn: t.Function, name: string): t.Expression | null {
  if (!t.isBlockStatement(fn.body)) return null;
  for (const stmt of fn.body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) if (t.isIdentifier(d.id, { name }) && t.isExpression(d.init)) return d.init;
  }
  return null;
}

function rootClassOf(unit: Unit): string | null {
  const fn = functionNode(unit);
  const root = fn ? returnedRoot(fn) : null;
  const el = t.isJSXElement(root) ? root : null;
  const expr = el?.openingElement.attributes.find((a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: "className" }))?.value;
  const local = t.isJSXExpressionContainer(expr) && t.isIdentifier(expr.expression) && fn ? localInit(fn, expr.expression.name) : null;
  const className = el ? (attrValue(el, "className") ?? (local ? staticPrefix(local) : null)) : null;
  const token = className?.split(/\s+/).find((c) => c && !UTILITY_CLASS.test(c));
  return token && /^[a-z][a-z0-9_-]{2,}$/i.test(token) ? pascal(token) : null;
}

const SEMANTIC_ROOTS: Record<string, string> = { header: "Header", footer: "Footer", nav: "Nav", aside: "Sidebar", dialog: "Dialog", table: "Table", menu: "Menu", main: "Main" };

const PLUMBING_PROPS = new Set(["t", "children", "className", "style", "onClick", "key", "ref", "id"]);

function propKeys(fn: t.Function): string[] {
  const param = fn.params[0];
  return t.isObjectPattern(param) ? param.properties.flatMap((p) => (t.isObjectProperty(p) && literalKey(p.key) ? [literalKey(p.key)!] : [])) : [];
}

function shapeName(u: Unit, nameOfUnit: (name: string) => string | null, initOf: (name: string) => t.Node | null = () => null): string | null {
  const fn = functionNode(u);
  if (!fn) return null;
  const root = jsxRoot(fn);
  if (!root) return null;
  const keys = propKeys(fn);
  const tag = tagName(root);
  if (tag === "svg" && keys.includes("name")) return "Icon";
  if (keys.includes("onSubmit") && (keys.includes("onCancel") || keys.includes("busy") || keys.includes("initial"))) return "Form";
  if (keys.includes("icon") && keys.includes("title") && keys.some((k) => /^(sub|subtitle|description|desc|hint)$/.test(k)) && keys.some((k) => /^(right|action|onClick|last|trailing)$/.test(k))) return "ListRow";
  let logo = false;
  t.traverseFast(fn.body, (n) => {
    if (logo || !t.isJSXAttribute(n) || !t.isJSXIdentifier(n.name, { name: "src" })) return;
    const value = t.isStringLiteral(n.value) ? n.value.value : t.isJSXExpressionContainer(n.value) && t.isIdentifier(n.value.expression) ? initOf(n.value.expression.name) : null;
    const text = typeof value === "string" ? value : t.isStringLiteral(value) ? value.value : "";
    if (/(^|\/)logo[-.]/i.test(text)) logo = true;
  });
  if (logo) return "Logo";
  if (keys.includes("tone") && root.openingElement.attributes.some((a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: "role" }))) return "Notice";
  if (descendants(root, (e) => tagName(e) === "textarea").length || tag === "textarea") return "Textarea";
  const inner = tag && /^[A-Z_]/.test(tag) ? nameOfUnit(tag) : null;
  const own = keys.filter((k) => !PLUMBING_PROPS.has(k));
  if (inner && own.length === 1 && /^[a-z][A-Za-z]{2,}$/.test(own[0]!)) return `${pascal(own[0]!)}${inner}`;
  return null;
}

function elementText(el: t.JSXElement): string {
  return el.children.map((c) => (t.isJSXText(c) ? c.value : t.isJSXElement(c) ? elementText(c) : t.isJSXExpressionContainer(c) && t.isStringLiteral(c.expression) ? c.expression.value : "")).join(" ").replace(/\s+/g, " ").trim();
}

function shortName(text: string | null | undefined): string | null {
  if (!text || /[^\x20-\x7e]/.test(text) || /\b[A-Z0-9]+_[A-Z0-9_]+\b/.test(text)) return null;
  const words = (text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).filter((w) => !/^(the|a|an|of|and|or|to|for|your|our)$/i.test(w));
  if (!words.length || words.join("").length > 40) return null;
  if (words.length >= 3) return capitalize(words.map((w) => w[0]!.toLowerCase()).join(""));
  return words.map((w) => capitalize(w.toLowerCase())).join("");
}

function descendants(el: t.JSXElement, test: (e: t.JSXElement) => boolean): t.JSXElement[] {
  const out: t.JSXElement[] = [];
  t.traverseFast(el, (n) => {
    if (t.isJSXElement(n) && n !== el && test(n)) out.push(n);
  });
  return out;
}

function tagName(el: t.JSXElement): string | null {
  return t.isJSXIdentifier(el.openingElement.name) ? el.openingElement.name.name : null;
}

function shapeSuffix(root: t.JSXElement): string | null {
  const tag = tagName(root) ?? "";
  const classes = (attrValue(root, "className") ?? "").split(/\s+/);
  const has = (re: RegExp) => classes.some((c) => re.test(c));
  if (tag === "button") return "Button";
  if (tag === "a") return "Link";
  if (tag === "input" || tag === "textarea" || tag === "select") return "Input";
  if (tag === "img") return "Image";
  if (tag === "li") return "Item";
  if (tag === "tr") return "Row";
  if (tag === "blockquote" || descendants(root, (e) => tagName(e) === "blockquote").length) return "Quote";
  if (has(/^rounded-full$/) && (has(/^(h|size)-\d/) && has(/^(w|size)-\d/))) return "Avatar";
  if (has(/^rounded-full$/) && has(/^px-/)) return "Badge";
  if (has(/^rounded/) && (has(/^border$/) || has(/^shadow/))) return "Card";
  if (has(/^border-b$/) || has(/^divide-/)) return "Item";
  return null;
}

function markupName(unit: Unit): { name: string | null; suffix: string | null; tag: string | null } {
  const fn = functionNode(unit);
  const root = fn ? jsxRoot(fn) : null;
  if (!root) return { name: null, suffix: null, tag: null };
  const tag = tagName(root);
  const suffix = shapeSuffix(root);
  const byAttr = shortName(attrValue(root, "id")?.replace(/[-_]/g, " ")) ?? shortName(attrValue(root, "aria-label"));
  if (byAttr) return { name: byAttr, suffix, tag };
  if (tag && SEMANTIC_ROOTS[tag]) return { name: SEMANTIC_ROOTS[tag]!, suffix, tag };
  const param = fn?.params[0];
  if (tag === "svg" && t.isObjectPattern(param) && param.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "name")) return { name: "Icon", suffix, tag };
  if (tag === "form") {
    const button = descendants(root, (e) => tagName(e) === "button" || /^_?[A-Z]/.test(tagName(e) ?? ""))[0];
    const subject = shortName(button ? elementText(button) : null) ?? shortName(attrValue(descendants(root, (e) => tagName(e) === "input")[0] ?? root, "placeholder"));
    return { name: `${subject ?? ""}Form`, suffix, tag };
  }
  if (tag === "section" && descendants(root, (e) => tagName(e) === "h1").length) return { name: "Hero", suffix, tag };
  const heading = descendants(root, (e) => /^h[1-3]$/.test(tagName(e) ?? ""))[0];
  const title = heading ? shortName(elementText(heading)) : null;
  if (title) return { name: title, suffix, tag };
  if (suffix && /^(Button|Avatar|Badge|Input|Link|Image)$/.test(suffix)) return { name: suffix, suffix, tag };
  return { name: null, suffix, tag };
}

function singularName(name: string): string {
  if (/ies$/.test(name)) return name.replace(/ies$/, "y");
  if (/(ss|us|is)$/.test(name)) return name;
  return name.replace(/s$/, "");
}

function storeState(init: t.Node | null): t.ObjectExpression | null {
  if (!t.isCallExpression(init)) return null;
  for (const arg of [...init.arguments, ...(t.isCallExpression(init.callee) ? init.callee.arguments : [])]) {
    if (t.isObjectExpression(arg)) {
      const state = arg.properties.find((p): p is t.ObjectProperty | t.ObjectMethod => (t.isObjectProperty(p) || t.isObjectMethod(p)) && literalKey(p.key) === "state");
      const value = t.isObjectMethod(state) ? state : state?.value;
      if (value && (t.isFunction(value) || t.isArrowFunctionExpression(value))) {
        const body = t.isFunction(value) && t.isBlockStatement(value.body) ? (value.body.body.find((b): b is t.ReturnStatement => t.isReturnStatement(b))?.argument ?? null) : (value as t.ArrowFunctionExpression).body;
        if (t.isObjectExpression(body)) return body;
      }
    }
    if (!(t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg))) continue;
    const setter = arg.params[0];
    let callsSetter = false;
    if (t.isIdentifier(setter)) {
      t.traverseFast(arg.body, (n) => {
        if (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: setter.name })) callsSetter = true;
      });
    }
    if (!callsSetter) continue;
    const body = t.isBlockStatement(arg.body) ? (arg.body.body.find((b): b is t.ReturnStatement => t.isReturnStatement(b))?.argument ?? null) : arg.body;
    if (t.isObjectExpression(body)) return body;
  }
  return null;
}

function isStoreInit(init: t.Node | null, importedAs: (local: string) => string | null): boolean {
  if (!t.isCallExpression(init)) return false;
  let callee: t.Node = init.callee;
  while (t.isCallExpression(callee)) callee = callee.callee;
  const local = t.isIdentifier(callee) ? callee.name : null;
  if (local === "defineStore") return true;
  const imported = local ? importedAs(local) : null;
  if (imported && STORE_FACTORIES.has(imported)) return true;
  return imported === "library" && storeState(init) !== null;
}

function isComponentObject(node: t.Node | null): boolean {
  if (!t.isObjectExpression(node)) return false;
  const keys = new Set(node.properties.map((p) => (t.isObjectProperty(p) || t.isObjectMethod(p) ? literalKey(p.key) : null)));
  return keys.has("__name") || ((keys.has("setup") || keys.has("render") || keys.has("template")) && (keys.has("props") || keys.has("name") || keys.has("emits") || keys.has("setup") || keys.has("render")));
}

function componentObjectName(node: t.Node | null): string | null {
  if (!t.isObjectExpression(node)) return null;
  for (const key of ["__name", "name"]) {
    const prop = node.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === key);
    if (t.isStringLiteral(prop?.value) && /^[A-Za-z][\w-]*$/.test(prop.value.value)) return /^[A-Z][A-Za-z0-9]*$/.test(prop.value.value) ? prop.value.value : pascal(prop.value.value);
  }
  return null;
}

function classify(unit: Unit, page: boolean, importedAs: (local: string) => string | null): Folder {
  const fn = functionNode(unit);
  const name = unit.name;
  if (isStoreInit(unit.init, importedAs)) return "stores";
  if (/^use[A-Z]\w*Store$/.test(name) && t.isCallExpression(unit.init) && t.isStringLiteral(unit.init.arguments[0])) return "stores";
  if (isComponentObject(unit.init)) return page && unit.isDefault ? "pages" : "components";
  if (fn || t.isClassDeclaration(unit.statement)) {
    if (/^use[A-Z0-9]/.test(name) && fn) return "hooks";
    if (svgRoot(unit)) return "icons";
    const markup = rendersMarkup(unit.statement) || (!!fn && hookComponent(fn));
    if (markup && (/^[A-Z]/.test(name) || isMangled(name))) return page && unit.isDefault ? "pages" : "components";
    if (t.isClassDeclaration(unit.statement) && markup) return "components";
    return "functions";
  }
  return "constants";
}

function isRouteRecord(node: t.Node | null | undefined): boolean {
  if (!t.isObjectExpression(node)) return false;
  const keys = new Set(node.properties.map((p) => (t.isObjectProperty(p) || t.isObjectMethod(p) ? literalKey(p.key) : null)));
  if (!keys.has("path") || !keys.has("component")) return false;
  const component = node.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "component");
  return !!component && (t.isArrowFunctionExpression(component.value) || t.isFunctionExpression(component.value)) && t.isCallExpression(t.isArrowFunctionExpression(component.value) && !t.isBlockStatement(component.value.body) ? component.value.body : null) && t.isImport((component.value as t.ArrowFunctionExpression & { body: t.CallExpression }).body.callee);
}

function topicOf(statements: t.Statement[]): string | null {
  const votes = new Map<string, number>();
  for (const stmt of statements) {
    t.traverseFast(stmt, (n) => {
      const text = t.isStringLiteral(n) ? n.value : t.isTemplateLiteral(n) ? (n.quasis[0]?.value.cooked ?? "") : null;
      const segment = text ? /^\/([a-z][a-z-]{2,})(?:\/|$)/.exec(text)?.[1] : undefined;
      if (segment && !/^(api|v\d+)$/.test(segment)) votes.set(segment, (votes.get(segment) ?? 0) + 1);
    });
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) : null;
}

function stringsOf(node: t.Node): string[] {
  const out: string[] = [];
  t.traverseFast(node, (n) => {
    if (t.isStringLiteral(n)) out.push(n.value);
    else if (t.isTemplateLiteral(n)) out.push(n.quasis[0]?.value.cooked ?? "");
  });
  return out;
}

const PREFIX = /^([a-z]{2,4})[-_:](?=[a-z])/;

function appStringPrefix(units: Unit[], evident: Set<Unit>, recognized: Set<Unit>): string | null {
  const total = new Map<string, Set<string>>();
  const inApp = new Set<string>();
  const inLibrary = new Set<string>();
  for (const u of units) {
    for (const text of stringsOf(u.statement)) {
      const prefix = PREFIX.exec(text)?.[1];
      if (!prefix) continue;
      if (!total.has(prefix)) total.set(prefix, new Set());
      total.get(prefix)!.add(text);
      if (evident.has(u)) inApp.add(prefix);
      if (recognized.has(u)) inLibrary.add(prefix);
    }
  }
  const candidates = [...inApp].filter((p) => !inLibrary.has(p) && (total.get(p)?.size ?? 0) >= 3).sort((a, b) => total.get(b)!.size - total.get(a)!.size);
  return candidates[0] ?? null;
}

function hasPrefixedString(node: t.Node, prefix: string): boolean {
  return stringsOf(node).some((text) => PREFIX.exec(text)?.[1] === prefix);
}

function appConfigUnit(program: NodePath<t.Program>, byName: Map<string, Unit>): Unit | null {
  let found: Unit | null = null;
  program.traverse({
    AssignmentExpression(path) {
      if (found || path.node.operator !== "||=" || !t.isMemberExpression(path.node.left) || literalKey(path.node.left.property) !== "_appConfig") return;
      const arg = t.isCallExpression(path.node.right) ? path.node.right.arguments[0] : path.node.right;
      const merged = t.isIdentifier(arg) ? program.scope.getBinding(arg.name)?.path.node : null;
      const init = t.isVariableDeclarator(merged) ? merged.init : null;
      const last = t.isCallExpression(init) ? init.arguments.at(-1) : init;
      const unit = t.isIdentifier(last) ? byName.get(last.name) : undefined;
      if (unit && t.isObjectExpression(unit.init)) found = unit;
    },
  });
  return found;
}

function isPlugin(unit: Unit): boolean {
  return t.isCallExpression(unit.init) && calleeName(unit.init.callee) === "defineNuxtPlugin";
}

function pluginName(unit: Unit, program: NodePath<t.Program>): string {
  const resolveString = (node: t.Node | undefined): string | null => {
    if (t.isStringLiteral(node)) return node.value;
    if (t.isIdentifier(node)) {
      const bound = program.scope.getBinding(node.name)?.path.node;
      if (t.isVariableDeclarator(bound) && t.isStringLiteral(bound.init)) return bound.init.value;
    }
    return null;
  };
  const words = (text: string) => camel(text.replace(/^[a-z]{2,4}[-_:](?=[a-z])/, "").replace(/[^A-Za-z0-9]+/g, " ").trim());
  const found: Record<string, string | null> = { config: null, state: null, global: null, store: null };
  const scan = (node: t.Node, depth: number) => {
    t.traverseFast(node, (n) => {
      if (t.isMemberExpression(n) && !n.computed && t.isMemberExpression(n.object) && literalKey(n.object.property) === "public") {
        const key = literalKey(n.property);
        if (key && !found.config) found.config = key.replace(/(Id|Url|Key|Enabled)$/, "");
      }
      if (t.isCallExpression(n)) {
        const callee = calleeName(n.callee) ?? "";
        const text = /^(useState|useCookie|Bt|useLocalStorage)$/.test(callee) || n.arguments.length === 2 ? resolveString(n.arguments[0] as t.Node) : null;
        if (text && /[a-z]-[a-z]|_[a-z]/.test(text) && !found.state) found.state = text;
        const store = /^use([A-Z]\w*?)Store$/.exec(callee);
        if (store && !found.store) found.store = store[1]!;
        if (depth < 1 && t.isIdentifier(n.callee)) {
          const bound = program.scope.getBinding(n.callee.name)?.path.node;
          if (t.isFunctionDeclaration(bound)) scan(bound.body, depth + 1);
          else if (t.isVariableDeclarator(bound) && (t.isArrowFunctionExpression(bound.init) || t.isFunctionExpression(bound.init))) scan(bound.init.body, depth + 1);
        }
      }
      if (t.isMemberExpression(n) && t.isIdentifier(n.object, { name: "globalThis" }) && !found.global) found.global = literalKey(n.property);
    });
  };
  scan(unit.statement, 0);
  const raw = found.config ?? found.store ?? (found.state ? words(found.state) : null) ?? found.global;
  return raw && /^[A-Za-z]/.test(raw) ? raw[0]!.toLowerCase() + raw.slice(1) : "plugin";
}

function importerTopic(paths: string[]): string | null {
  const votes = new Map<string, number>();
  for (const path of paths) {
    const stem = posix.basename(path).replace(/\.\w+$/, "");
    const word = /^([A-Z][a-z]+|[a-z]+)/.exec(stem)?.[1]?.toLowerCase();
    const dir = posix.basename(posix.dirname(path));
    const topic = word && !/^(ui|app|use|index|base|the|my|module|merged|constants|utils|format|formatValue|is|isValue|chunk|shared|load|get|create)$/.test(word) ? word : !/^(js|components|pages|composables|functions|stores|utils)$/.test(dir) ? dir.replace(/[[\].]/g, "") : null;
    if (topic && /^[a-z][a-z-]{2,}$/.test(topic)) votes.set(topic, (votes.get(topic) ?? 0) + 1);
  }
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  return ranked[0] && ranked[0][1] * 2 > paths.length ? ranked[0][0] : null;
}

function isIdentityFunction(unit: Unit): boolean {
  const fn = functionNode(unit);
  if (!fn || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return false;
  const name = fn.params[0].name;
  const body = t.isBlockStatement(fn.body) ? (fn.body.body.length === 1 && t.isReturnStatement(fn.body.body[0]) ? fn.body.body[0].argument : null) : fn.body;
  return t.isIdentifier(body, { name });
}

function isStrongEvidence(unit: Unit): boolean {
  if (t.isCallExpression(unit.init) && calleeName(unit.init.callee) === "defineStore") return true;
  return t.isArrayExpression(unit.init) && unit.init.elements.some((e) => isRouteRecord(e));
}

function isPureValue(node: t.Node | null | undefined, depth = 0): boolean {
  if (!node || depth > 12) return false;
  if (t.isLiteral(node) && !t.isTemplateLiteral(node)) return true;
  if (t.isTemplateLiteral(node)) return node.expressions.every((e) => isPureValue(e, depth + 1));
  if (t.isIdentifier(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node) || t.isClassExpression(node)) return true;
  if (t.isUnaryExpression(node)) return node.operator !== "delete" && isPureValue(node.argument, depth + 1);
  if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) return isPureValue(node.left, depth + 1) && isPureValue(node.right, depth + 1);
  if (t.isConditionalExpression(node)) return [node.test, node.consequent, node.alternate].every((n) => isPureValue(n, depth + 1));
  if (t.isArrayExpression(node)) return node.elements.every((e) => e === null || (t.isSpreadElement(e) ? isPureValue(e.argument, depth + 1) : isPureValue(e, depth + 1)));
  if (t.isObjectExpression(node)) {
    return node.properties.every((p) => {
      if (t.isObjectMethod(p)) return true;
      if (t.isSpreadElement(p)) return isPureValue(p.argument, depth + 1);
      return (!p.computed || isPureValue(p.key, depth + 1)) && isPureValue(p.value, depth + 1);
    });
  }
  if (t.isMemberExpression(node)) return isPureValue(node.object, depth + 1) && (!node.computed || isPureValue(node.property, depth + 1));
  if (t.isCallExpression(node) || t.isNewExpression(node)) {
    return (t.isExpression(node.callee) && isPureValue(node.callee, depth + 1)) && node.arguments.every((a) => (t.isSpreadElement(a) ? isPureValue(a.argument, depth + 1) : t.isExpression(a) && isPureValue(a, depth + 1)));
  }
  if (t.isTaggedTemplateExpression(node)) return isPureValue(node.tag, depth + 1) && isPureValue(node.quasi, depth + 1);
  if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
  return false;
}

const ROUTE_API = /^(meta|links|loader|clientLoader|action|clientAction|headers|handle|shouldRevalidate|ErrorBoundary|HydrateFallback|Layout|middleware|clientMiddleware)$/;

const NUXT_GLOBALS = /^(Teleport|KeepAlive|Suspense|Transition|TransitionGroup|NuxtLink|NuxtPage|NuxtLayout|NuxtErrorBoundary|NuxtLoadingIndicator|NuxtRouteAnnouncer|NuxtIsland|NuxtImg|NuxtPicture|NuxtTime|NuxtWelcome|ClientOnly|DevOnly)$/;

function freeSetupKeys(program: NodePath<t.Program>): void {
  const keys = new Set<string>();
  program.traverse({
    ObjectMethod(path) {
      if (literalKey(path.node.key) !== "setup" || !t.isBlockStatement(path.node.body)) return;
      const body = path.node.body.body;
      const last = body.at(-1);
      let returned: t.Node | null | undefined = t.isReturnStatement(last) ? last.argument : null;
      if (t.isIdentifier(returned)) {
        const name = returned.name;
        const decl = body.find((st): st is t.VariableDeclaration => t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0]!.id, { name }));
        returned = decl?.declarations[0]!.init;
      }
      if (!t.isObjectExpression(returned)) return;
      for (const prop of returned.properties) {
        if (!t.isObjectProperty(prop) || prop.computed || !t.isIdentifier(prop.value)) continue;
        const key = literalKey(prop.key);
        if (key && key !== prop.value.name) keys.add(key);
      }
    },
  });
  for (const key of keys) {
    const binding = program.scope.getBinding(key);
    if (!binding || binding.scope !== program.scope) continue;
    let next = `${key}$`;
    for (let n = 2; program.scope.hasBinding(next); n++) next = `${key}$${n}`;
    program.scope.rename(key, next);
  }
}

function scriptSetupBody(setupFn: t.Function, body: t.Statement[]): t.Statement[] | null {
  const last = body.at(-1);
  let returned: t.Expression | null | undefined = t.isReturnStatement(last) ? last.argument : null;
  const statements = body.slice(0, -1);
  let bindingsDecl: t.Statement | null = null;
  if (t.isIdentifier(returned)) {
    const name = returned.name;
    bindingsDecl = statements.find((st) => t.isVariableDeclaration(st) && st.declarations.length === 1 && t.isIdentifier(st.declarations[0]!.id, { name })) ?? null;
    returned = bindingsDecl ? (bindingsDecl as t.VariableDeclaration).declarations[0]!.init : null;
  }
  if (!t.isObjectExpression(returned)) return null;
  const renames = new Map<string, string>();
  for (const prop of returned.properties) {
    if (!t.isObjectProperty(prop) || prop.computed || !t.isIdentifier(prop.value)) continue;
    const key = literalKey(prop.key);
    if (key && key !== prop.value.name && /^[A-Za-z_$][\w$]*$/.test(key)) renames.set(prop.value.name, key);
  }
  const inline: t.Statement[] = [];
  for (const prop of returned.properties) {
    const key = t.isObjectProperty(prop) || t.isObjectMethod(prop) ? (prop.computed ? null : literalKey(prop.key)) : null;
    if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    if (t.isObjectMethod(prop) && prop.kind === "method") inline.push(t.functionDeclaration(t.identifier(key), prop.params, prop.body, prop.generator, prop.async));
    else if (t.isObjectProperty(prop) && t.isExpression(prop.value) && !t.isIdentifier(prop.value)) inline.push(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(key), prop.value)]));
  }
  const kept = statements.filter((st) => {
    if (st === bindingsDecl) return false;
    if (!t.isExpressionStatement(st)) return true;
    const call = st.expression;
    if (t.isCallExpression(call) && t.isMemberExpression(call.callee) && t.isIdentifier(call.callee.object, { name: "Object" }) && literalKey(call.callee.property) === "defineProperty") return false;
    if (t.isCallExpression(call) && !call.arguments.length && t.isIdentifier(call.callee) && t.isObjectPattern(setupFn.params[1]) && setupFn.params[1].properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "expose" && t.isIdentifier(p.value, { name: (call.callee as t.Identifier).name }))) return false;
    return true;
  });
  kept.push(...inline);
  if (!renames.size) return kept;
  const holder = t.file(t.program([t.expressionStatement(t.functionExpression(null, setupFn.params.map((p) => t.cloneNode(p, true)) as t.FunctionExpression["params"], t.blockStatement(kept.map((st) => t.cloneNode(st, true)))))]));
  traverse(holder, {
    Function(path) {
      for (const [from, to] of renames) if (path.scope.getOwnBinding(from) && !path.scope.hasBinding(to)) path.scope.rename(from, to);
      path.stop();
    },
  });
  return ((holder.program.body[0] as t.ExpressionStatement).expression as t.FunctionExpression).body.body;
}

const assigned = new WeakMap<t.CallExpression, t.ObjectExpression | null>();

function assignedComponent(init: t.CallExpression, resolve?: (name: string) => t.Node | null | undefined): t.ObjectExpression | null {
  if (assigned.has(init)) return assigned.get(init)!;
  const properties: t.ObjectExpression["properties"] = [];
  for (const arg of init.arguments) {
    const source = t.isIdentifier(arg) ? resolve?.(arg.name) : arg;
    const object = t.isObjectExpression(source) ? source : sfcExport(source, resolve);
    if (!object) {
      assigned.set(init, null);
      return null;
    }
    properties.push(...object.properties);
  }
  const merged = t.objectExpression(properties);
  const out = isComponentObject(merged) ? merged : null;
  assigned.set(init, out);
  return out;
}

function sfcExport(init: t.Node | null | undefined, resolve?: (name: string) => t.Node | null | undefined): t.ObjectExpression | null {
  if (t.isCallExpression(init) && t.isMemberExpression(init.callee) && t.isIdentifier(init.callee.object, { name: "Object" }) && literalKey(init.callee.property) === "assign" && init.arguments.length >= 2) return assignedComponent(init, resolve);
  if (t.isCallExpression(init) && init.arguments.length === 1 && t.isObjectExpression(init.arguments[0]) && isComponentObject(init.arguments[0])) return init.arguments[0];
  if (t.isCallExpression(init) && init.arguments.length === 2 && t.isArrayExpression(init.arguments[1]) && isScopePairs(init.arguments[1])) {
    const renderPair = init.arguments[1].elements.find((p): p is t.ArrayExpression => t.isArrayExpression(p) && t.isStringLiteral(p.elements[0], { value: "render" }));
    const raw = t.isIdentifier(init.arguments[0]) ? resolve?.(init.arguments[0].name) : init.arguments[0];
    const target = t.isCallExpression(raw) ? sfcExport(raw, resolve) : raw;
    if (renderPair && t.isObjectExpression(target)) {
      const raw = renderPair.elements[1];
      const fn = t.isIdentifier(raw) ? resolve?.(raw.name) : raw;
      const render = t.isFunctionDeclaration(fn) ? t.functionExpression(null, fn.params, fn.body) : t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn) ? fn : null;
      if (render && render.params.length >= 1) {
        const existing = target.properties.find((p): p is t.ObjectMethod | t.ObjectProperty => (t.isObjectMethod(p) || t.isObjectProperty(p)) && literalKey(p.key) === "setup");
        const setupFn = t.isObjectMethod(existing) ? existing : t.isObjectProperty(existing) && (t.isFunctionExpression(existing.value) || t.isArrowFunctionExpression(existing.value)) ? existing.value : null;
        const setupBody = setupFn && t.isBlockStatement(setupFn.body) ? setupFn.body.body : null;
        const scriptSetup = setupFn && setupBody ? scriptSetupBody(setupFn, setupBody) : null;
        if (setupFn && scriptSetup) {
          const setup = t.objectMethod("method", t.identifier("setup"), setupFn.params, t.blockStatement([...scriptSetup, t.returnStatement(render)]));
          return t.objectExpression([...target.properties.filter((p) => p !== existing), setup]);
        }
        const setup = t.objectMethod("method", t.identifier("setup"), [], t.blockStatement([t.returnStatement(render)]));
        return t.objectExpression([...target.properties, setup]);
      }
    }
  }
  if (t.isCallExpression(init) && init.arguments.length === 2 && t.isCallExpression(init.arguments[0])) {
    const inner = sfcExport(init.arguments[0]);
    if (inner && t.isArrayExpression(init.arguments[1])) return inner;
  }
  if (!t.isCallExpression(init) || init.arguments.length !== 2 || !t.isObjectExpression(init.arguments[0]) || !t.isArrayExpression(init.arguments[1])) return null;
  const pairs = init.arguments[1].elements;
  if (!pairs.length || !pairs.every((p) => t.isArrayExpression(p) && p.elements.length === 2 && t.isStringLiteral(p.elements[0]) && /^(__scopeId|__file|__cssModules|__hmrId|render|ssrRender)$/.test(p.elements[0].value))) return null;
  return isComponentObject(init.arguments[0]) ? init.arguments[0] : null;
}

function collectUnits(program: NodePath<t.Program>, moduleName: string): { units: Unit[]; rest: t.Statement[]; imports: t.ImportDeclaration[] } {
  const units: Unit[] = [];
  const rest: t.Statement[] = [];
  const imports: t.ImportDeclaration[] = [];
  const exportsOf = new Map<string, string[]>();
  const defaults = new Set<string>();
  const body = program.node.body;
  for (const stmt of body) {
    if (t.isExportNamedDeclaration(stmt) && !stmt.source && !stmt.declaration) {
      for (const spec of stmt.specifiers) {
        if (!t.isExportSpecifier(spec)) continue;
        const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
        if (exported === "default") defaults.add(spec.local.name);
        else exportsOf.set(spec.local.name, [...(exportsOf.get(spec.local.name) ?? []), exported]);
      }
    }
    if (t.isExportDefaultDeclaration(stmt) && t.isIdentifier(stmt.declaration)) defaults.add(stmt.declaration.name);
  }
  const add = (name: string, statement: t.Statement, init: t.Node | null, exported: boolean, isDefault: boolean) => {
    units.push({
      index: units.length,
      name,
      statement,
      exported: [...(exported ? [name] : []), ...(exportsOf.get(name) ?? [])],
      isDefault: isDefault || defaults.has(name),
      init,
      functionLike: t.isFunctionDeclaration(statement) || t.isClassDeclaration(statement) || t.isFunctionExpression(init) || t.isArrowFunctionExpression(init) || t.isClassExpression(init),
    });
  };
  const declaration = (decl: t.Node, exported: boolean, isDefault: boolean, original: t.Statement): boolean => {
    if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) {
      add(decl.id.name, decl, null, exported, isDefault);
      return true;
    }
    if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && isDefault) {
      const name = isValidName(moduleName) && !program.scope.hasBinding(moduleName) ? moduleName : null;
      if (!name) return false;
      decl.id = t.identifier(name);
      add(name, decl, null, false, true);
      return true;
    }
    if (t.isVariableDeclaration(decl) && decl.declarations.every((d) => t.isIdentifier(d.id))) {
      const resolve = (name: string) => {
        const node = program.scope.getBinding(name)?.path.node;
        return t.isVariableDeclarator(node) ? node.init : t.isFunctionDeclaration(node) ? node : null;
      };
      for (const d of decl.declarations) add((d.id as t.Identifier).name, t.variableDeclaration(decl.kind, [d]), sfcExport(d.init, resolve) ?? d.init ?? null, exported, false);
      return true;
    }
    rest.push(original);
    return false;
  };
  for (const stmt of body) {
    if (t.isImportDeclaration(stmt)) imports.push(stmt);
    else if (t.isExportNamedDeclaration(stmt) && stmt.declaration) declaration(stmt.declaration, true, false, stmt);
    else if (t.isExportNamedDeclaration(stmt) && !stmt.source) {
      const external = stmt.specifiers.filter((s) => t.isExportSpecifier(s) && !isUnitBinding(program, s.local.name));
      if (external.length) rest.push(t.exportNamedDeclaration(null, external));
    } else if (t.isExportDefaultDeclaration(stmt)) {
      if (t.isIdentifier(stmt.declaration) && isUnitBinding(program, stmt.declaration.name)) continue;
      if (!declaration(stmt.declaration, false, true, stmt)) continue;
    } else if (t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt) || t.isVariableDeclaration(stmt)) declaration(stmt, false, false, stmt);
    else rest.push(stmt);
  }
  return { units, rest, imports };
}

function isUnitBinding(program: NodePath<t.Program>, name: string): boolean {
  const binding = program.scope.getBinding(name);
  if (!binding || binding.kind === "module") return false;
  const node = binding.path.node;
  if (!t.isVariableDeclarator(node)) return true;
  const decl = binding.path.parentPath?.node;
  return t.isVariableDeclaration(decl) && decl.declarations.every((d) => t.isIdentifier(d.id));
}

function topStatementIndex(path: NodePath, body: t.Statement[]): t.Statement | null {
  let current: NodePath | null = path;
  while (current && current.parentPath && !current.parentPath.isProgram()) current = current.parentPath;
  return current && body.includes(current.node as t.Statement) ? (current.node as t.Statement) : null;
}

const BUILTINS = new Set(["Object", "Array", "Reflect", "Symbol", "Math", "JSON", "Promise", "Number", "String", "Function", "globalThis", "window", "document"]);

function isRuntimeAlias(program: NodePath<t.Program>, unit: Unit): boolean {
  if (unit.name === "__vite__mapDeps" || unit.name === "__vitePreload") return true;
  let node = unit.init;
  while (t.isMemberExpression(node)) node = node.object;
  return unit.init !== node && t.isIdentifier(node) && BUILTINS.has(node.name) && !program.scope.getBinding(node.name);
}

function decoratedName(program: NodePath<t.Program>, init: t.Node | null | undefined): string | null {
  if (!t.isCallExpression(init) || !t.isIdentifier(init.callee) || init.arguments.length !== 1) return null;
  const bound = program.scope.getBinding(init.callee.name)?.path.node;
  const fn = t.isFunctionDeclaration(bound) ? bound : t.isVariableDeclarator(bound) && (t.isArrowFunctionExpression(bound.init) || t.isFunctionExpression(bound.init)) ? bound.init : null;
  const param = fn && t.isIdentifier(fn.params[0]) ? fn.params[0].name : null;
  if (!fn || !param) return null;
  let name: string | null = null;
  t.traverseFast(fn.body, (n) => {
    if (t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && t.isIdentifier(n.left.object, { name: param }) && literalKey(n.left.property) === "displayName" && t.isStringLiteral(n.right) && /^[A-Z][A-Za-z0-9]*$/.test(n.right.value)) name = n.right.value;
  });
  return name;
}

function displayNameOf(program: NodePath<t.Program>, local: string): string | null {
  const bound = program.scope.getBinding(local)?.path.node;
  const decorated = t.isVariableDeclarator(bound) ? decoratedName(program, bound.init) : null;
  if (decorated) return decorated;
  for (const ref of program.scope.getBinding(local)?.referencePaths ?? []) {
    const member = ref.parentPath;
    const assign = member?.parentPath;
    if (member?.isMemberExpression() && member.node.object === ref.node && literalKey(member.node.property) === "displayName" && assign?.isAssignmentExpression() && assign.node.left === member.node && t.isStringLiteral(assign.node.right) && /^[A-Z][A-Za-z0-9]*$/.test(assign.node.right.value)) return assign.node.right.value;
  }
  return null;
}

function builtinComponent(node: t.Node | null | undefined): string | null {
  if (!t.isObjectExpression(node)) return null;
  const keys = new Set(node.properties.map((p) => (t.isObjectProperty(p) || t.isObjectMethod(p) ? literalKey(p.key) : null)));
  if (keys.has("__isTeleport")) return "Teleport";
  if (keys.has("__isKeepAlive")) return "KeepAlive";
  if (keys.has("__isSuspense")) return "Suspense";
  return null;
}

function exportedComponentNames(program: NodePath<t.Program>): Map<string, string> {
  const out = new Map<string, string>();
  const nameOf = (local: string, depth = 0): string | null => {
    const node = program.scope.getBinding(local)?.path.node;
    const init = t.isVariableDeclarator(node) ? node.init : null;
    if (t.isIdentifier(init) && depth < 4) return nameOf(init.name, depth + 1);
    const shown = displayNameOf(program, local);
    if (shown) return shown;
    const builtin = builtinComponent(init);
    if (builtin) return builtin;
    const object = sfcExport(init, (n) => {
      const bound = program.scope.getBinding(n)?.path.node;
      return t.isVariableDeclarator(bound) ? bound.init : t.isFunctionDeclaration(bound) ? bound : null;
    }) ?? (isComponentObject(init ?? null) ? init : null);
    return object ? componentObjectName(object) : null;
  };
  for (const stmt of program.node.body) {
    if (t.isExportNamedDeclaration(stmt) && !stmt.source) {
      for (const spec of stmt.specifiers) {
        if (!t.isExportSpecifier(spec)) continue;
        const name = nameOf(spec.local.name);
        if (name) out.set(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value, name);
      }
      if (t.isVariableDeclaration(stmt.declaration)) {
        for (const d of stmt.declaration.declarations) {
          const name = t.isIdentifier(d.id) ? nameOf(d.id.name) : null;
          if (name) out.set((d.id as t.Identifier).name, name);
        }
      }
    }
    if (t.isExportDefaultDeclaration(stmt) && t.isIdentifier(stmt.declaration)) {
      const name = nameOf(stmt.declaration.name);
      if (name) out.set("default", name);
    }
  }
  return out;
}

function routeFilePath(route: string, sfcName: string | null): string {
  const base = route.replace(/\/+$/, "");
  if (sfcName === "index") return `${base}/index`;
  return route.endsWith("/") ? `${base}/${sfcName ?? "index"}` : base;
}

function isScopePairs(node: t.Node | null | undefined): boolean {
  return t.isArrayExpression(node) && node.elements.length > 0 && node.elements.every((p) => t.isArrayExpression(p) && p.elements.length === 2 && t.isStringLiteral(p.elements[0]) && /^(__scopeId|__file|__cssModules|__hmrId|render|ssrRender)$/.test(p.elements[0].value));
}

function wrappedComponent(init: t.Node | null | undefined): { holder: t.CallExpression; index: number } | null {
  if (!t.isCallExpression(init)) return null;
  const isAssign = t.isMemberExpression(init.callee) && t.isIdentifier(init.callee.object, { name: "Object" }) && literalKey(init.callee.property) === "assign";
  if (isAssign) {
    const [target, extra] = init.arguments;
    if (!t.isObjectExpression(extra) || !extra.properties.every((p) => t.isObjectProperty(p) && /^(__name|name)$/.test(literalKey(p.key) ?? ""))) return null;
    if (t.isIdentifier(target)) return { holder: init, index: 0 };
    return wrappedComponent(target);
  }
  if (init.arguments.length === 2 && t.isIdentifier(init.arguments[0]) && isScopePairs(init.arguments[1])) return { holder: init, index: 0 };
  return null;
}

function mergeNamedAssign(program: NodePath<t.Program>): void {
  let changed = false;
  for (const stmt of program.get("body")) {
    const decl = stmt.isExportNamedDeclaration() ? stmt.get("declaration") : stmt;
    if (!decl.isVariableDeclaration() || decl.node.declarations.length !== 1) continue;
    const wrapped = wrappedComponent(decl.node.declarations[0]!.init);
    if (!wrapped) continue;
    const target = wrapped.holder.arguments[wrapped.index] as t.Identifier;
    const binding = program.scope.getBinding(target.name);
    const source = binding?.path;
    if (!binding || binding.references !== 1 || binding.constantViolations.length || !source?.isVariableDeclarator() || !source.parentPath.parentPath?.isProgram()) continue;
    const init = source.node.init;
    const options = sfcExport(init) ?? (isComponentObject(init ?? null) ? (init as t.ObjectExpression) : null);
    if (!options || !init) continue;
    wrapped.holder.arguments[wrapped.index] = init;
    source.parentPath.remove();
    changed = true;
  }
  if (changed) program.scope.crawl();
}

function hoistComponentRegistry(program: NodePath<t.Program>): void {
  const body = program.node.body;
  const registries: { stmt: t.Statement; name: string; object: t.ObjectExpression }[] = [];
  for (const stmt of body) {
    if (!t.isVariableDeclaration(stmt) || stmt.declarations.length !== 1) continue;
    const d = stmt.declarations[0]!;
    if (t.isIdentifier(d.id) && t.isObjectExpression(d.init)) registries.push({ stmt, name: d.id.name, object: d.init });
  }
  if (!registries.length) return;
  const exportedNames = new Set<string>();
  const collectExport = (decl: t.Node | null | undefined) => {
    if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) exportedNames.add(decl.id.name);
    if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) if (t.isIdentifier(d.id)) exportedNames.add(d.id.name);
    if (t.isIdentifier(decl)) exportedNames.add(decl.name);
  };
  for (const stmt of body) {
    if (t.isExportNamedDeclaration(stmt)) {
      collectExport(stmt.declaration);
      for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec)) exportedNames.add(spec.local.name);
    } else if (t.isExportDefaultDeclaration(stmt)) collectExport(stmt.declaration);
  }
  const dynamicAccess = new Set<string>();
  program.traverse({
    MemberExpression(path) {
      const { object, property, computed } = path.node;
      if (computed && t.isIdentifier(object) && !t.isStringLiteral(property) && !t.isNumericLiteral(property)) dynamicAccess.add(object.name);
    },
  });
  const inlineComponent = (value: t.Node): value is t.FunctionExpression | t.ArrowFunctionExpression =>
    ((t.isFunctionExpression(value) && !value.id) || t.isArrowFunctionExpression(value)) && rendersMarkup(value);
  const usesContext = (node: t.Node): boolean => {
    let found = false;
    t.traverseFast(node, (n) => {
      if (!found && (t.isThisExpression(n) || (t.isIdentifier(n) && n.name === "arguments"))) found = true;
    });
    return found;
  };
  const used = new Set<string>();
  const uniqueName = (key: string): string | null => {
    const base = pascal(key);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(base) || RESERVED.has(base)) return null;
    let name = base;
    for (let i = 2; used.has(name) || program.scope.hasBinding(name); i++) name = `${base}${i}`;
    used.add(name);
    return name;
  };
  let changed = false;
  const renamed = new Map<string, string>();
  for (const registry of registries) {
    if (!dynamicAccess.has(registry.name)) continue;
    const members = registry.object.properties.filter(
      (p): p is t.ObjectProperty | t.ObjectMethod =>
        (t.isObjectProperty(p) && !p.computed && inlineComponent(p.value)) || (t.isObjectMethod(p) && p.kind === "method" && !p.computed && rendersMarkup(p) && !usesContext(p.body)),
    );
    if (members.length < 3) continue;
    const declarations: t.Statement[] = [];
    for (const member of members) {
      const key = literalKey(member.key);
      const name = key ? uniqueName(key) : null;
      if (!name) continue;
      let declaration: t.Statement;
      if (t.isObjectMethod(member)) declaration = t.functionDeclaration(t.identifier(name), member.params, member.body, member.generator, member.async);
      else {
        const fn = member.value as t.FunctionExpression | t.ArrowFunctionExpression;
        declaration = t.isFunctionExpression(fn)
          ? t.functionDeclaration(t.identifier(name), fn.params, fn.body, fn.generator, fn.async)
          : t.variableDeclaration("const", [t.variableDeclarator(t.identifier(name), fn)]);
      }
      declarations.push(declaration);
      const index = registry.object.properties.indexOf(member);
      registry.object.properties[index] = t.objectProperty(t.isIdentifier(member.key) ? t.identifier(key!) : member.key, t.identifier(name), false, key === name);
    }
    if (declarations.length) {
      const at = body.indexOf(registry.stmt);
      body.splice(at, 0, ...declarations);
      changed = true;
    }
    for (const property of registry.object.properties) {
      if (!t.isObjectProperty(property) || property.computed || !t.isIdentifier(property.value)) continue;
      const key = literalKey(property.key);
      const local = property.value.name;
      if (!key || local === "default" || /^[A-Z]/.test(local) || exportedNames.has(local)) continue;
      const binding = program.scope.getBinding(local);
      const node = binding?.path.node;
      const fn = t.isFunctionDeclaration(node) ? node : t.isVariableDeclarator(node) && (t.isFunctionExpression(node.init) || t.isArrowFunctionExpression(node.init)) ? node.init : null;
      if (!fn || !rendersMarkup(fn)) continue;
      const name = uniqueName(key);
      if (!name || name === local) continue;
      program.scope.rename(local, name);
      renamed.set(local, name);
      changed = true;
    }
  }
  if (renamed.size) {
    program.traverse({
      JSXIdentifier(path) {
        const to = renamed.get(path.node.name);
        if (!to) return;
        const parent = path.parent;
        if ((t.isJSXOpeningElement(parent) && parent.name === path.node) || (t.isJSXClosingElement(parent) && parent.name === path.node)) path.node.name = to;
      },
    });
  }
  if (changed) program.scope.crawl();
}

function hoistMountedComponent(program: NodePath<t.Program>): void {
  if (program.scope.getBinding("App")) return;
  let target: NodePath<t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectExpression> | null = null;
  program.traverse({
    CallExpression(path) {
      if (target) return;
      const name = calleeName(path.node.callee);
      if (name !== "render" && name !== "createApp") return;
      let arg = path.get("arguments")[0];
      if (arg?.isCallExpression() && /^(createElement|jsx|h)$/.test(calleeName(arg.node.callee) ?? "")) arg = arg.get("arguments")[0];
      if (!arg) return;
      if ((arg.isFunctionExpression() || arg.isArrowFunctionExpression()) && rendersMarkup(arg.node)) target = arg;
      else if (name === "createApp" && arg.isObjectExpression() && isComponentObject(arg.node)) target = arg;
    },
  });
  if (!target) return;
  const found = target as NodePath<t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectExpression>;
  let top: NodePath = found;
  while (top.parentPath && !top.parentPath.isProgram()) top = top.parentPath;
  const node = found.node;
  const declaration = t.isFunctionExpression(node) && !node.id
    ? t.functionDeclaration(t.identifier("App"), node.params, node.body, node.generator, node.async)
    : t.variableDeclaration("const", [t.variableDeclarator(t.identifier("App"), node)]);
  found.replaceWith(t.identifier("App"));
  top.insertBefore(declaration);
  program.scope.crawl();
}

function mountedComponents(program: NodePath<t.Program>): Set<string> {
  const out = new Set<string>();
  const componentOf = (node: t.Node | null | undefined): string | null => {
    if (t.isIdentifier(node)) return node.name;
    if (t.isCallExpression(node) && /^(createElement|jsx|jsxs|h)$/.test(calleeName(node.callee) ?? "")) return t.isIdentifier(node.arguments[0]) ? node.arguments[0].name : null;
    if (t.isJSXElement(node) && t.isJSXIdentifier(node.openingElement.name)) return node.openingElement.name.name;
    return null;
  };
  program.traverse({
    CallExpression(path) {
      const name = calleeName(path.node.callee);
      const args = path.node.arguments;
      let found: string | null = null;
      if (name === "render" && t.isMemberExpression(path.node.callee)) found = componentOf(args[0] as t.Node);
      else if (name === "hydrateRoot" || name === "hydrate") found = componentOf(args[1] as t.Node) ?? componentOf(args[0] as t.Node);
      else if (name === "createApp" || name === "createSSRApp") found = componentOf(args[0] as t.Node);
      if (found && program.scope.getBinding(found)?.scope === program.scope) out.add(found);
    },
  });
  return out;
}

function isDeferred(ref: NodePath): boolean {
  let current: NodePath | null = ref.parentPath;
  while (current && !current.isProgram()) {
    if (current.isFunction()) return true;
    current = current.parentPath;
  }
  return false;
}

interface AngularDefinition {
  kind: "component" | "directive" | "pipe" | "service";
  name: string;
  path: string;
}

const ANGULAR_LIBRARY_SELECTOR = /^\[?(router-outlet|ng-|mat-|cdk-|routerLink|ngModel|ngForm|ngIf|ngFor|ngClass|ngStyle|ngSwitch|ngTemplateOutlet|ngComponentOutlet)/;

function angularClass(unit: Unit): t.Class | null {
  if (t.isClassDeclaration(unit.statement)) return unit.statement;
  if (t.isClassExpression(unit.init)) return unit.init;
  if (t.isCallExpression(unit.init) && (t.isArrowFunctionExpression(unit.init.callee) || t.isFunctionExpression(unit.init.callee)) && t.isBlockStatement(unit.init.callee.body)) {
    const body = unit.init.callee.body.body;
    const returned = body.at(-1);
    const name = t.isReturnStatement(returned) && t.isIdentifier(returned.argument) ? returned.argument.name : null;
    return (body.find((s): s is t.ClassDeclaration => t.isClassDeclaration(s) && s.id?.name === name) as t.Class | undefined) ?? null;
  }
  return null;
}

function kebab(words: string): string {
  return words.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function hasIvyStatics(unit: Unit): boolean {
  const cls = angularClass(unit);
  return !!cls && cls.body.body.some((m) => t.isClassProperty(m) && m.static && /^ɵ(fac|prov|cmp|dir|pipe|mod|inj)$/.test(t.isIdentifier(m.key) ? m.key.name : t.isStringLiteral(m.key) ? m.key.value : ""));
}

function angularDefinition(unit: Unit): AngularDefinition | null {
  const cls = angularClass(unit);
  if (!cls) return null;
  const statics = new Map<string, t.ObjectExpression>();
  for (const member of cls.body.body) {
    if (!t.isClassProperty(member) || !member.static || !t.isCallExpression(member.value)) continue;
    const key = t.isIdentifier(member.key) ? member.key.name : t.isStringLiteral(member.key) ? member.key.value : "";
    const options = member.value.arguments[0];
    if (/^ɵ(cmp|dir|pipe|prov)$/.test(key) && t.isObjectExpression(options)) statics.set(key.slice(1), options);
  }
  const option = (object: t.ObjectExpression | undefined, name: string) => object?.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === name)?.value;
  const selectorOf = (object: t.ObjectExpression | undefined) => {
    const selectors = option(object, "selectors");
    const first = t.isArrayExpression(selectors) && t.isArrayExpression(selectors.elements[0]) ? selectors.elements[0].elements : [];
    if (t.isStringLiteral(first[0]) && first[0].value) return first[0].value;
    if (t.isStringLiteral(first[1])) return `[${first[1].value}]`;
    return null;
  };
  const component = statics.get("cmp");
  if (component) {
    const selector = selectorOf(component);
    if (!selector || ANGULAR_LIBRARY_SELECTOR.test(selector)) return null;
    const base = selector.replace(/^(app|[a-z]{1,3})-(?=[a-z])/, "");
    const name = `${pascal(base)}Component`;
    if (selector === "app-root") return { kind: "component", name: "AppComponent", path: "app/app.component" };
    return { kind: "component", name, path: `app/${kebab(base)}/${kebab(base)}.component` };
  }
  const directive = statics.get("dir");
  if (directive) {
    const selector = selectorOf(directive);
    if (!selector || ANGULAR_LIBRARY_SELECTOR.test(selector)) return null;
    const base = selector.replace(/^\[|\]$/g, "").replace(/^app(?=[A-Z])/, "");
    return { kind: "directive", name: `${pascal(base)}Directive`, path: `app/${kebab(base)}.directive` };
  }
  const pipe = statics.get("pipe");
  if (pipe) {
    const name = option(pipe, "name");
    if (!t.isStringLiteral(name)) return null;
    return { kind: "pipe", name: `${pascal(name.value)}Pipe`, path: `app/${kebab(name.value)}.pipe` };
  }
  const service = statics.get("prov");
  if (service && t.isStringLiteral(option(service, "providedIn"))) {
    const fields = cls.body.body.flatMap((m) => ((t.isClassProperty(m) || t.isClassMethod(m)) && !m.static && t.isIdentifier(m.key) && !m.key.name.startsWith("_") ? [m.key.name] : []));
    const plural = fields.find((f) => /^[a-z]{3,}s$/.test(f) && !/ss$/.test(f));
    const base = plural ? plural.replace(/ies$/, "y").replace(/s$/, "") : null;
    if (!base) return null;
    return { kind: "service", name: `${pascal(base)}Service`, path: `app/${kebab(base)}.service` };
  }
  return null;
}

function plan(file: OutputFile, program: NodePath<t.Program>, ast: t.File, page: boolean, used: Map<Folder, Set<string>>, libraryFunctions: Map<string, string>, components: ReadonlyMap<string, LibraryComponent>, foreign?: (from: string, source: string, imported: string) => string | null, route?: string, autoImports = false, bareFunctions: ReadonlyMap<string, string> = new Map(), importedByApp: ReadonlyMap<string, string[]> = new Map(), stringOwner?: (value: string) => string | null): Plan | null {
  const stem = posix.basename(file.path).replace(/\.[jt]sx?$/, "");
  mergeNamedAssign(program);
  hoistComponentRegistry(program);
  hoistMountedComponent(program);
  const vueRoles = inferVueRoles(program, (n) => (isMangled(n) ? null : n));
  if (vueRoles.size) {
    renameVueHelpers(program, vueRoles);
    program.scope.crawl();
  }
  const originalBody = [...program.node.body];
  const { units, rest, imports } = collectUnits(program, /^[A-Z][A-Za-z0-9]*$/.test(stem) ? stem : "");
  if (!units.length) return null;

  const angular = new Map<Unit, AngularDefinition>();
  for (const u of units) {
    const definition = angularDefinition(u);
    if (definition) angular.set(u, definition);
  }
  if (angular.size) {
    const components = new Set([...angular.keys()].map((u) => u.name));
    for (const u of units) {
      if (!t.isArrayExpression(u.init) || angular.has(u)) continue;
      const routes = u.init.elements.filter((e): e is t.ObjectExpression => t.isObjectExpression(e));
      const keys = (o: t.ObjectExpression) => new Set(o.properties.flatMap((p) => (t.isObjectProperty(p) || t.isObjectMethod(p) ? [literalKey(p.key)] : [])));
      if (!routes.length || !routes.every((r) => keys(r).has("path"))) continue;
      const linked = routes.some((r) => r.properties.some((p) => t.isObjectProperty(p) && ((literalKey(p.key) === "component" && t.isIdentifier(p.value) && components.has(p.value.name)) || literalKey(p.key) === "loadComponent")));
      if (linked) angular.set(u, { kind: "service", name: "routes", path: "app/app.routes" });
    }
    const owners = new Set<t.Node>([...angular].filter(([, d]) => d.kind !== "service").map(([u]) => (t.isVariableDeclaration(u.statement) ? u.statement.declarations[0]! : u.statement)));
    for (const [u, definition] of [...angular]) {
      if (definition.kind !== "service" || definition.name === "routes") continue;
      const used = (program.scope.getBinding(u.name)?.referencePaths ?? []).some((ref) => !!ref.findParent((p) => owners.has(p.node)));
      if (!used) angular.delete(u);
    }
  }
  const unitOfStatement = new Map<t.Statement, Unit>();
  const byName = new Map(units.map((u) => [u.name, u]));
  const ownerOf = (stmt: t.Statement | null): Unit | "rest" | null => {
    if (!stmt) return null;
    if (unitOfStatement.has(stmt)) return unitOfStatement.get(stmt)!;
    return "rest";
  };
  const originalOwner = new Map<t.Statement, Unit | "rest">();
  for (const stmt of originalBody) {
    let owner: Unit | "rest" = "rest";
    const names = new Set<string>();
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration) collectDeclared(stmt.declaration, names);
    else if (t.isExportDefaultDeclaration(stmt)) collectDeclared(stmt.declaration, names);
    else collectDeclared(stmt, names);
    if (t.isImportDeclaration(stmt)) continue;
    if (names.size === 1) owner = byName.get([...names][0]!) ?? "rest";
    originalOwner.set(stmt, owner);
  }
  for (const u of units) unitOfStatement.set(u.statement, u);

  const deps = new Map<Unit, Set<Unit>>(units.map((u) => [u, new Set()]));
  const importUse = new Map<Unit | "rest", Set<string>>();
  const usedBy = new Map<Unit, Set<Unit | "rest">>(units.map((u) => [u, new Set()]));
  const blocked = new Set<Unit>();
  const statementOwner = (path: NodePath): Unit | "rest" | null => {
    const top = topStatementIndex(path, originalBody);
    if (!top) return null;
    const direct = ownerOf(top);
    if (direct !== "rest") return direct;
    const multi = originalOwner.get(top);
    if (multi && multi !== "rest") return multi;
    if (t.isVariableDeclaration(top) || (t.isExportNamedDeclaration(top) && t.isVariableDeclaration(top.declaration))) {
      let declarator: NodePath | null = path;
      while (declarator && !declarator.isVariableDeclarator()) declarator = declarator.parentPath;
      const id = declarator?.isVariableDeclarator() ? declarator.node.id : null;
      if (t.isIdentifier(id) && byName.has(id.name)) return byName.get(id.name)!;
    }
    return "rest";
  };
  const refs = new Map<Unit, Map<string, { deferred: boolean; hoisted: boolean }>>(units.map((u) => [u, new Map()]));
  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    const target = byName.get(name);
    for (const ref of binding.referencePaths) {
      const owner = statementOwner(ref);
      if (!owner) continue;
      if (binding.kind === "module") {
        if (!importUse.has(owner)) importUse.set(owner, new Set());
        importUse.get(owner)!.add(name);
        continue;
      }
      if (owner === target) continue;
      if (target) usedBy.get(target)!.add(owner);
      if (owner === "rest") continue;
      if (target) deps.get(owner)!.add(target);
      const known = refs.get(owner)!.get(name);
      const deferred = isDeferred(ref);
      refs.get(owner)!.set(name, { deferred: (known?.deferred ?? true) && deferred, hoisted: binding.kind === "hoisted" });
    }
    for (const violation of binding.constantViolations) {
      const owner = statementOwner(violation);
      if (target) blocked.add(target);
      if (owner && owner !== "rest") blocked.add(owner);
    }
  }

  const libraryNames = new Set<string>();
  const bare = new Map<string, string>();
  const renamedFrom = new Map<string, string>();
  const importedAs = (local: string): string | null => {
    const binding = program.scope.getBinding(local);
    const spec = binding?.path.node;
    if (t.isImportSpecifier(spec)) return t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
    if (t.isImportDefaultSpecifier(spec)) return "default";
    if (libraryNames.has(local)) return "library";
    return null;
  };
  const closure = (seeds: Iterable<Unit>, allowed: (u: Unit) => boolean): Set<Unit> => {
    const out = new Set<Unit>();
    const queue = [...seeds].filter(allowed);
    while (queue.length) {
      const u = queue.pop()!;
      if (out.has(u)) continue;
      out.add(u);
      for (const d of deps.get(u)!) if (!out.has(d) && allowed(d)) queue.push(d);
    }
    return out;
  };
  const helperNames = new Set(vueRoles.values());
  const recognized = units.filter((u) => (angular.size > 0 && !angular.has(u) && hasIvyStatics(u)) || (t.isCallExpression(u.init) && !u.init.arguments.length && t.isIdentifier(u.init.callee) && /^require[A-Z]/.test(u.init.callee.name)) || (u.name.length > 2 && libraryFunctions.has(u.name) && !(route !== undefined && (u.isDefault || u.exported.length > 0))) || isRuntimeAlias(program, u) || helperNames.has(u.name) || (vueRoles.size > 0 && isVueApi(u.name) && !componentOptions(u.init)));
  const frameworkComponent = (u: Unit): boolean => {
    const options = componentOptions(u.init);
    if (!options) return false;
    const known = componentObjectName(u.init);
    if (known && components.has(known)) return true;
    const sfcName = options.object.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "__name");
    if (sfcName) return !page && t.isStringLiteral(sfcName.value) && /^(nuxt-[a-z-]+|client-only|server-placeholder|dev-only)$/.test(sfcName.value.value);
    const render = renderFunction(options);
    return !(render && render.params.length >= 2 && render.params.every((p) => t.isIdentifier(p)));
  };
  const appComponent = (u: Unit): boolean => {
    const sfcName = componentOptions(u.init)?.object.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "__name");
    return !!sfcName && !frameworkComponent(u);
  };
  for (const u of units) {
    if (!t.isCallExpression(u.init) || !t.isIdentifier(u.init.callee) || !storeState(u.init)) continue;
    const factory = byName.get(u.init.callee.name);
    const selected = (program.scope.getBinding(u.name)?.referencePaths ?? []).some((ref) => ref.parentPath?.isCallExpression() && ref.parentPath.node.callee === ref.node && (t.isArrowFunctionExpression(ref.parentPath.node.arguments[0]) || t.isFunctionExpression(ref.parentPath.node.arguments[0])));
    if (factory && selected && !recognized.includes(factory)) recognized.push(factory);
  }
  const recognizedSet = new Set(recognized);
  const strong = units.filter((u) => !recognizedSet.has(u) && !frameworkComponent(u) && (appComponent(u) || isStrongEvidence(u)));
  const mixed = strong.length > 0 && recognized.length >= 3;
  const evident = new Set(mixed ? units.filter((u) => !recognizedSet.has(u) && !frameworkComponent(u) && (strong.includes(u) || hasApiPath(u.statement))) : strong);
  const prefix = mixed ? appStringPrefix(units, evident, recognizedSet) : null;
  const prefixed = new Set(prefix ? units.filter((u) => !recognizedSet.has(u) && !frameworkComponent(u) && hasPrefixedString(u.statement, prefix)) : []);
  for (const u of prefixed) evident.add(u);
  const carries = (d: Unit) => d.functionLike || prefixed.has(d) || storeState(d.init) || (t.isCallExpression(d.init) && calleeName(d.init.callee) === "defineStore");
  const propagate = (skip: (u: Unit) => boolean) => {
    for (let grew = true; grew; ) {
      grew = false;
      for (const u of units) {
        if (evident.has(u) || recognizedSet.has(u) || frameworkComponent(u) || skip(u)) continue;
        const found = [...deps.get(u)!].filter((d) => evident.has(d));
        if (!found.length) continue;
        if (!found.some(carries) && [...deps.get(u)!].some((d) => !evident.has(d) && (d.functionLike || recognizedSet.has(d)))) continue;
        evident.add(u);
        grew = true;
      }
    }
  };
  propagate(() => false);
  const libraryUnits = closure(recognized, (u) => !evident.has(u));
  for (const u of closure(units.filter(frameworkComponent), (d) => !appComponent(d) && !storeState(d.init) && !evident.has(d))) libraryUnits.add(u);
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of units) {
      if (libraryUnits.has(u) || evident.has(u) || angular.has(u) || !isMangled(u.name) || storeState(u.init) || rendersMarkup(u.statement)) continue;
      if (![...deps.get(u)!].some((d) => libraryUnits.has(d))) continue;
      if ([...deps.get(u)!].some((d) => !libraryUnits.has(d) && (componentOptions(d.init) || rendersMarkup(d.statement)))) continue;
      libraryUnits.add(u);
      grew = true;
    }
  }
  for (const u of units) {
    if (libraryUnits.has(u) || !storeState(u.init) || !t.isCallExpression(u.init) || !t.isIdentifier(u.init.callee)) continue;
    const factory = byName.get(u.init.callee.name);
    if (!factory || !libraryUnits.has(factory) || !isMangled(factory.name) || program.scope.getBinding("create")) continue;
    byName.delete(factory.name);
    renamedFrom.set(factory.name, "create");
    program.scope.rename(factory.name, "create");
    factory.name = "create";
    byName.set("create", factory);
    bare.set("create", "zustand");
  }
  for (const u of libraryUnits) libraryNames.add(u.name);
  for (const u of libraryUnits) if (bareFunctions.has(u.name)) bare.set(u.name, bareFunctions.get(u.name)!);
  for (const u of units) {
    if (!mixed || evident.has(u) || libraryUnits.has(u) || frameworkComponent(u) || isIdentityFunction(u) || !u.exported.some((e) => importedByApp.has(e))) continue;
    if ([...deps.get(u)!].some((d) => libraryUnits.has(d)) && !topicOf([u.statement])) continue;
    evident.add(u);
  }
  if (mixed) propagate((u) => libraryUnits.has(u));
  const classNames: Map<string, ClassName> = mixed || recognized.length < 3 ? nameClasses(program, units.filter((u) => t.isClassDeclaration(u.statement) && isMangled(u.name) && !libraryUnits.has(u)).map((u) => u.name), (n) => program.scope.hasBinding(n)) : new Map();
  const appConfig = autoImports ? appConfigUnit(program, byName) : null;
  const createdClass = (u: Unit): ClassName | null => {
    const fn = functionNode(u);
    if (!fn || !t.isBlockStatement(fn.body)) return null;
    const last = fn.body.body.at(-1);
    const value = t.isReturnStatement(last) ? last.argument : null;
    return t.isNewExpression(value) && t.isIdentifier(value.callee) ? (classNames.get(value.callee.name) ?? null) : null;
  };
  const libraryOnly = (): Plan | null => {
    const size = (u: Unit) => (u.statement.end ?? 0) - (u.statement.start ?? 0);
    const total = units.reduce((n, u) => n + size(u), 0);
    const share = total ? units.filter((u) => libraryUnits.has(u)).reduce((n, u) => n + size(u), 0) / total : 0;
    if (route === undefined && (units.length >= 20 || total >= 10_000) && share >= 0.85 && rest.every((st) => !t.isExportDefaultDeclaration(st) && !(t.isExportNamedDeclaration(st) && st.declaration))) return heavyVendor();
    if (units.some((u) => !libraryUnits.has(u)) || !rest.every((st) => (t.isExportNamedDeclaration(st) && !st.declaration) || (t.isExportDefaultDeclaration(st) && t.isIdentifier(st.declaration)) || t.isVariableDeclaration(st))) return null;
    const known = units.flatMap((u) => {
      const found = components.get(componentObjectName(u.init) ?? "");
      return found ? [found] : [];
    });
    const votes = new Map<string, number>();
    for (const u of units) {
      const pkg = libraryFunctions.get(u.name);
      if (pkg) votes.set(pkg, (votes.get(pkg) ?? 0) + 1);
    }
    const pkg = known[0]?.package ?? [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!pkg) return null;
    const remainder = [...rest, ...units.map((u) => u.statement)].sort((a, b) => orderOf(originalBody, a) - orderOf(originalBody, b));
    return { path: file.path, file, pieces: [], remainder, keepImports: imports, exportsTo: new Map(), ast, program, pieceOf: new Map(), units, remainderExports: new Set(), roles: vueRoles, vendor: known.length ? `${pkg}/${sharedWords(known.map((c) => c.name))}` : pkg, vendorPackage: pkg, outPath: file.path, components, autoImports, bare, namespaces: new Map() };
  };
  const appish = (u: Unit): boolean => {
    if (angular.has(u) || evident.has(u)) return true;
    if (libraryUnits.has(u)) return false;
    if (storeState(u.init) || (t.isCallExpression(u.init) && calleeName(u.init.callee) === "defineStore")) return true;
    const sfc = componentOptions(u.init)?.object.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "__name");
    if (sfc) return t.isStringLiteral(sfc.value) && !components.has(sfc.value.value);
    return !libraryFunctions.has(u.name) && ((classify(u, page, importedAs) === "components" && rendersMarkup(u.statement) && !isComponentObject(u.init)) || !!topicOf([u.statement]));
  };
  const heavyVendor = (): Plan | null => {
    if (units.some(appish)) return null;
    const votes = new Map<string, number>();
    for (const u of units) {
      const pkg = libraryFunctions.get(u.name);
      if (pkg) votes.set(pkg, (votes.get(pkg) ?? 0) + 1);
    }
    const pkg = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!pkg) return null;
    const remainder = [...rest, ...units.map((u) => u.statement)].sort((a, b) => orderOf(originalBody, a) - orderOf(originalBody, b));
    return { path: file.path, file, pieces: [], remainder, keepImports: imports, exportsTo: new Map(), ast, program, pieceOf: new Map(), units, remainderExports: new Set(), roles: vueRoles, vendor: pkg, vendorPackage: pkg, outPath: file.path, components, autoImports, bare, namespaces: new Map() };
  };
  const heavy = recognized.length >= 3;
  const merged = units.length > 40;
  const vendorish = recognized.length >= 30 && recognized.length * 3 >= units.length;
  const seeds = units.filter((u) => {
    if (angular.has(u) || (vendorish && evident.has(u) && !libraryUnits.has(u))) return true;
    if (libraryUnits.has(u)) return false;
    const folder = classify(u, page, importedAs);
    if (vendorish) {
      const sfc = componentOptions(u.init)?.object.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "__name");
      if (sfc) return t.isStringLiteral(sfc.value) && !sfc.value.value.includes("-");
      return folder === "stores" || folder === "icons" || (folder === "components" && rendersMarkup(u.statement) && !isComponentObject(u.init));
    }
    return evident.has(u) || folder === "components" || folder === "pages" || folder === "stores" || folder === "hooks" || folder === "icons" || (u.exported.length > 0 && !isMangled(u.name)) || u.isDefault;
  });
  const app = heavy ? closure(seeds, (u) => !libraryUnits.has(u)) : new Set(units.filter((u) => !libraryUnits.has(u)));
  const extractable = new Set(
    units.filter((u) => {
      if (blocked.has(u) || !app.has(u)) return false;
      if (t.isClassDeclaration(u.statement)) return !u.statement.superClass || t.isIdentifier(u.statement.superClass) || t.isMemberExpression(u.statement.superClass);
      if (t.isFunctionDeclaration(u.statement)) return true;
      return u.init === null ? false : isPureValue(u.init) || (t.isCallExpression(u.init) && !!lazyImport(u.init));
    }),
  );
  const rootComponents = mountedComponents(program);
  const apiRole = (u: Unit): boolean => {
    const known = classNames.get(u.name) ?? createdClass(u);
    if (known && known.role !== "other") return true;
    const name = derivedName(u);
    return !!name && /^(fetch|create|update|delete)[A-Z]/.test(name) && endpointName(u.statement) === name;
  };
  const grouped = new Set<Unit>();
  const attachedTo = new Map<Unit, Unit>();
  const hostOf = (u: Unit): Unit => {
    let current = u;
    for (let hop = 0; attachedTo.has(current) && hop < 50; hop++) current = attachedTo.get(current)!;
    return current;
  };
  const nameOf = new Map<Unit, string | null>();
  const componentName = (u: Unit): string | null => {
    const markup = markupName(u);
    if (markup.name) return markup.name;
    const hosts = [...usedBy.get(u)!].filter((h): h is Unit => h !== "rest");
    if (hosts.length !== 1 || usedBy.get(u)!.has("rest")) return null;
    const parent = derivedName(hosts[0]!);
    if (!parent) return null;
    const suffix = markup.suffix ?? (markup.tag && !/^(div|span|p|section)$/.test(markup.tag) ? pascal(markup.tag) : "Item");
    const base = singularName(parent).replace(/^[a-z]/, (c) => c.toUpperCase());
    return base.endsWith(suffix) ? base : `${base}${suffix}`;
  };
  const derivedName = (u: Unit): string | null => {
    if (nameOf.has(u)) return nameOf.get(u)!;
    nameOf.set(u, null);
    const folder = classify(u, page, importedAs);
    let name: string | null = angular.get(u)?.name ?? (isMangled(u.name) ? null : u.name);
    if (route !== undefined && (u.isDefault || u.exported.includes("component")) && /^[A-Za-z][\w-]*$/.test(stem) && (isMangled(u.name) || !u.isDefault)) name = pascal(stem);
    const sfcName = componentOptions(u.init)?.object.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "__name") ? componentObjectName(u.init) : null;
    if (sfcName) name = sfcName;
    if (!name && classNames.has(u.name)) name = classNames.get(u.name)!.name;
    if (!name && createdClass(u)?.role === "client") name = `create${createdClass(u)!.name}`;
    if (!name && mixed && evident.has(u) && isPlugin(u)) name = pluginName(u, program);
    if (u === appConfig) name = "appConfig";
    if (!name && rootComponents.has(u.name)) name = "App";
    if (!name) {
      const svg = folder === "icons" ? svgRoot(u) : null;
      if (svg) name = iconNameOf(svg) ?? "Icon";
      else if (isComponentObject(u.init) && componentObjectName(u.init)) name = componentObjectName(u.init);
      else if (folder === "stores") name = storeName(u.init);
      else if (folder === "functions") name = endpointName(u.statement) ?? composableName(u, program) ?? (vueRoles.size > 0 ? reactiveFactory(u) : null);
      else if (folder === "components" || folder === "pages") name = (u.isDefault && route !== undefined && /^[A-Za-z][\w-]*$/.test(stem) ? pascal(stem) : null) ?? shapeName(u, (tag) => (byName.has(tag) ? derivedName(byName.get(tag)!) : isMangled(tag) || /^_?Component\d*$/.test(tag) ? null : tag), (name) => byName.get(name)?.init ?? null) ?? rootClassOf(u) ?? (u.isDefault && /^[A-Z]/.test(stem) ? stem : null) ?? componentName(u);
      else if (u.isDefault && /^[A-Za-z]/.test(stem) && !/^module-/.test(stem)) name = stem;
    }
    nameOf.set(u, name);
    return name;
  };
  for (let round = 0; round < 6; round++) {
    for (let changed = true; changed; ) {
      changed = false;
      const neededByRest = closure(
        units.filter((u) => extractable.has(u) && [...usedBy.get(u)!].some((user) => user === "rest" || !extractable.has(user))),
        (u) => extractable.has(u),
      );
      for (const u of [...extractable]) {
        const stuck = !angular.has(u) && [...refs.get(u)!].some(([name, info]) => {
          const d = byName.get(name);
          if (d && extractable.has(d)) return false;
          if (bare.has(renamedFrom.get(name) ?? name)) return false;
          return !(info.deferred || info.hoisted) && neededByRest.has(u);
        });
        if (stuck) {
          extractable.delete(u);
          changed = true;
        }
      }
    }
    if (!extractable.size) return libraryOnly();

    attachedTo.clear();
    if (route !== undefined) {
      const host = units.find((u) => u.isDefault && extractable.has(u));
      if (host) for (const u of units) if (u !== host && extractable.has(u) && u.exported.some((e) => ROUTE_API.test(e))) attachedTo.set(u, host);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const u of units) {
        if (!extractable.has(u) || attachedTo.has(u) || u.exported.length || u.isDefault || angular.has(u) || (classNames.get(u.name)?.role ?? "other") !== "other" || createdClass(u)?.role === "client") continue;
        const users = [...usedBy.get(u)!];
        if (users.length !== 1 || users[0] === "rest") continue;
        const host = users[0] as Unit;
        if (!extractable.has(host) || hostOf(host) === u) continue;
        const folder = classify(u, false, importedAs);
        const renderOnly = (program.scope.getBinding(u.name)?.referencePaths ?? []).some((ref) => ref.parentPath?.isArrayExpression() && t.isStringLiteral(ref.parentPath.node.elements[0], { value: "render" }));
        if (folder === "stores" || (vueRoles.size > 0 && folder === "functions" && reactiveFactory(u))) continue;
        const helper = renderOnly || folder === "constants" || (folder === "functions" && (merged || isMangled(u.name) || /^(format|is|render)Value\d*$/.test(u.name))) || (folder === "components" && !derivedName(u));
        if (!helper) continue;
        attachedTo.set(u, host);
        changed = true;
      }
    }


    const unnamed = [...extractable].filter((u) => !attachedTo.has(u) && !angular.has(u) && !grouped.has(u) && u !== appConfig && !(mixed && evident.has(u) && isPlugin(u)) && (!derivedName(u) || (/^(format|is|render)Value\d*$/.test(u.name) && classify(u, page, importedAs) === "functions") || (merged && !classNames.has(u.name) && createdClass(u)?.role !== "client" && /^(functions|constants)$/.test(classify(u, page, importedAs)) && !(vueRoles.size > 0 && reactiveFactory(u)))));
    const toGroup = merged && mixed ? unnamed.filter((u) => evident.has(u) || (usedBy.get(u)!.size > 0 && ![...deps.get(u)!].some((d) => libraryUnits.has(d)) && [...usedBy.get(u)!].every((user) => user !== "rest" && (evident.has(user) || grouped.has(user) || (extractable.has(user) && !!derivedName(user) && (classNames.has(user.name) || apiRole(user))))))) : [];
    for (const u of toGroup) grouped.add(u);
    const drop = unnamed.filter((u) => !grouped.has(u));
    if (!drop.length && !toGroup.length) break;
    for (const u of drop) extractable.delete(u);
  }
  const exportsTo = new Map<string, { path: string; name: string }>();
  const pieces: Piece[] = [];
  const pieceOf = new Map<string, Piece>();
  const dir = posix.dirname(file.path);
  const jsRoot = dir === DIRS.js || dir.startsWith(`${DIRS.js}/`) ? DIRS.js : dir;
  const vueModule = autoImports || vueRoles.size > 0 || imports.some((d) => d.source.value === "vue");
  const apiUnits = new Set(units.filter((u) => extractable.has(u) && apiRole(u)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of units) {
      if (apiUnits.has(u) || !extractable.has(u) || !t.isClassDeclaration(u.statement)) continue;
      const users = [...usedBy.get(u)!];
      if (!users.length || !users.every((user) => user !== "rest" && apiUnits.has(user))) continue;
      apiUnits.add(u);
      grew = true;
    }
  }
  const groupHosts = new Map<string, Unit[]>();
  const loose = units.filter((u) => grouped.has(u) && extractable.has(u) && !attachedTo.has(u));
  const looseSet = new Set(loose);
  const topic = new Map<Unit, string>();
  const membersOf = (u: Unit) => units.filter((m) => m === u || (extractable.has(m) && attachedTo.has(m) && hostOf(m) === u));
  for (const u of loose) {
    const api = hasApiPath(u.statement) || [...usedBy.get(u)!].some((x) => x !== "rest" && apiUnits.has(hostOf(x)));
    const own = api ? "api/utils" : (topicOf(membersOf(u).map((m) => m.statement)) ?? importerTopic(u.exported.flatMap((e) => importedByApp.get(e) ?? [])));
    if (own) topic.set(u, api ? own : `functions/${own}`);
  }
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const u of loose) {
      if (topic.has(u)) continue;
      const votes = new Map<string, number>();
      const neighbours = [...[...usedBy.get(u)!].filter((x): x is Unit => x !== "rest").map(hostOf), ...[...deps.get(u)!].map(hostOf)];
      for (const x of neighbours) {
        const key = looseSet.has(x) ? topic.get(x) : apiUnits.has(x) ? "api/utils" : undefined;
        if (key) votes.set(key, (votes.get(key) ?? 0) + (usedBy.get(u)!.has(x) ? 2 : 1));
      }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0];
      if (!best) continue;
      topic.set(u, best[0]);
      changed = true;
    }
    if (!changed) break;
  }
  for (const u of loose) {
    const key = topic.get(u) ?? "functions/shared";
    groupHosts.set(key, [...(groupHosts.get(key) ?? []), u]);
  }
  for (const [key, hosts] of groupHosts) {
    const members = units.filter((m) => extractable.has(m) && hosts.includes(hostOf(m)));
    const [folder, base] = key.split("/") as [Folder, string];
    const taken = used.get(folder)!;
    let fileName = base;
    for (let n = 2; taken.has(fileName.toLowerCase()); n++) fileName = `${base}${n}`;
    taken.add(fileName.toLowerCase());
    const path = posix.join(jsRoot, folder, `${fileName}.js`);
    const piece: Piece = { folder, name: members[0]!.name, units: members, path, jsx: members.some((m) => hasJsx(m.statement)) };
    pieces.push(piece);
    for (const m of members) {
      pieceOf.set(m.name, piece);
      for (const exported of m.exported) exportsTo.set(exported, { path, name: exported });
    }
  }
  for (const host of units) {
    if (!extractable.has(host) || attachedTo.has(host) || grouped.has(host) || !(componentOptions(host.init) || rendersMarkup(host.statement))) continue;
    const size = (u: Unit) => (u.statement.end ?? 0) - (u.statement.start ?? 0);
    const plain = (u: Unit) => (!!functionNode(u) || (t.isClassDeclaration(u.statement) && !u.statement.superClass) || (isPureValue(u.init) && !usedBy.get(u)!.has(host))) && !importUse.has(u) && !componentOptions(u.init) && !rendersMarkup(u.statement);
    const members = new Set(units.filter((m) => m !== host && extractable.has(m) && attachedTo.has(m) && hostOf(m) === host && plain(m)));
    if (members.size < 3) continue;
    for (let grew = true; grew; ) {
      grew = false;
      for (const u of units) {
        if (members.has(u) || u === host || pieceOf.has(u.name) || (extractable.has(u) && !attachedTo.has(u)) || !plain(u)) continue;
        const users = [...usedBy.get(u)!];
        if (!users.length || !users.every((x) => x !== "rest" && members.has(x))) continue;
        members.add(u);
        grew = true;
      }
    }
    for (let shrank = true; shrank; ) {
      shrank = false;
      for (const m of [...members]) {
        if ([...deps.get(m)!].every((d) => members.has(d))) continue;
        members.delete(m);
        shrank = true;
      }
    }
    const list = units.filter((m) => members.has(m));
    if (list.length < 3 || list.reduce((n, m) => n + size(m), 0) < 2500 || !list.some((m) => usedBy.get(m)!.has(host))) continue;
    const topicName = algorithmTopic(list.map((m) => m.statement)) ?? topicOf(list.map((m) => m.statement));
    if (!topicName) continue;
    const taken = used.get("functions")!;
    let fileName = topicName;
    for (let n = 2; taken.has(fileName.toLowerCase()); n++) fileName = `${topicName}${n}`;
    taken.add(fileName.toLowerCase());
    const path = posix.join(jsRoot, "functions", `${fileName}.js`);
    const piece: Piece = { folder: "functions", name: list[0]!.name, units: list, path, jsx: false };
    pieces.push(piece);
    for (const m of list) {
      attachedTo.delete(m);
      grouped.add(m);
      extractable.add(m);
      pieceOf.set(m.name, piece);
    }
  }
  for (const u of units) {
    if (!extractable.has(u) || attachedTo.has(u) || grouped.has(u)) continue;
    const members = units.filter((m) => m === u || (extractable.has(m) && attachedTo.has(m) && hostOf(m) === u));
    let name = derivedName(u) ?? u.name;
    const classified = classify(u, page, importedAs);
    const folder = apiUnits.has(u) ? "api" : mixed && evident.has(u) && isPlugin(u) ? "plugins" : classified === "functions" && /^use[A-Z]/.test(name) && functionNode(u) ? "hooks" : classified;
    const taken = used.get(folder)!;
    if (taken.has(safeSegment(name).toLowerCase())) name = qualifiedName(u, name, (candidate) => taken.has(safeSegment(candidate).toLowerCase()) || program.scope.hasBinding(candidate)) ?? name;
    let fileName = safeSegment(name);
    for (let n = 2; taken.has(fileName.toLowerCase()); n++) fileName = `${safeSegment(name)}${n}`;
    taken.add(fileName.toLowerCase());
    if (name !== u.name && isValidName(fileName) && !program.scope.hasBinding(fileName)) {
      program.scope.rename(u.name, fileName);
      byName.delete(u.name);
      u.name = fileName;
      byName.set(fileName, u);
    }
    const jsx = members.some((m) => hasJsx(m.statement));
    const vue = vueTemplate(u, program, vueRoles, foreign ? (source, imported) => foreign(file.path, source, imported) : undefined);
    const sfcName = t.isObjectExpression(u.init) ? u.init.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "__name") : undefined;
    const routed = route !== undefined && (folder === "pages" || folder === "components" || /^(components|routes)\//.test(route)) && (u.isDefault || u.exported.includes("component")) ? routeFilePath(route, t.isStringLiteral(sfcName?.value) ? sfcName.value.value : null) : null;
    const extension = vue ? ".vue" : jsx ? ".jsx" : ".js";
    const ng = angular.get(u);
    let path = u === appConfig ? posix.join(jsRoot, "app.config.js") : routed ? posix.join(jsRoot, `${routed}${extension}`) : ng ? posix.join(jsRoot, `${ng.path}${extension}`) : posix.join(jsRoot, folder === "hooks" && vueModule ? "composables" : folder, `${fileName}${extension}`);
    if (routed) for (let n = 2; taken.has(path.toLowerCase()); n++) path = posix.join(jsRoot, `${routed}-${n}${extension}`);
    if (routed) taken.add(path.toLowerCase());
    for (const m of members) {
      const known = m !== u ? classNames.get(m.name) : undefined;
      if (!known || !isValidName(known.name) || program.scope.hasBinding(known.name)) continue;
      program.scope.rename(m.name, known.name);
      byName.delete(m.name);
      m.name = known.name;
      byName.set(known.name, m);
    }
    const piece: Piece = { folder, name: u.name, units: members, path, jsx, ...(vue ? { vue } : {}) };
    pieces.push(piece);
    for (const m of members) pieceOf.set(m.name, piece);
    const readable = !isMangled(u.name) && u.exported.length > 0 && u.exported.every((e) => e.length <= 2);
    for (const exported of u.exported) exportsTo.set(exported, { path, name: vue ? "default" : readable ? u.name : exported });
    for (const m of members) if (m !== u) for (const exported of m.exported) exportsTo.set(exported, { path, name: exported });
    if (readable) u.exported = [u.name];
    if (u.isDefault) exportsTo.set("default", { path, name: "default" });
  }
  if (!pieces.length && !merged && route === undefined && !mixed && units.length && units.every((u) => !libraryUnits.has(u) && (functionNode(u) || t.isVariableDeclaration(u.statement)) && !componentOptions(u.init) && !rendersMarkup(u.statement)) && units.some((u) => functionNode(u)) && /^[A-Za-z][\w-]{2,}$/.test(stem) && !/^(module-|chunk|utils|constants|merged|index|main|entry|app|shared)/i.test(stem) && !/\d{3,}|[A-Z].*[A-Z].*\d|^[a-z0-9]{8,}$/.test(stem)) {
    const whole = posix.join(jsRoot, "functions", `${safeSegment(stem)}.js`);
    if (whole !== file.path) {
      const exportsTo = new Map<string, { path: string; name: string }>();
      for (const u of units) for (const exported of u.exported) exportsTo.set(exported, { path: whole, name: exported });
      return { path: file.path, file, pieces: [], remainder: originalBody.filter((st) => !t.isImportDeclaration(st)), keepImports: imports, exportsTo, ast, program, pieceOf: new Map(), units, remainderExports: new Set(), roles: vueRoles, vendor: null, outPath: whole, components, autoImports, bare, namespaces: new Map() };
    }
  }
  if (!pieces.length) return libraryOnly();
  if (!merged && route === undefined && pieces.every((p) => p.folder === "functions" || p.folder === "constants" || (p.folder === "api" && !p.units.some((u) => t.isClassDeclaration(u.statement)))) && !units.some((u) => !pieceOf.has(u.name) && (componentOptions(u.init) || rendersMarkup(u.statement)))) {
    const functionsHere = units.filter((u) => functionNode(u));
    const shared = units.filter((u) => !functionNode(u) && !isMangled(u.name) && functionsHere.length > 1 && functionsHere.every((f) => deps.get(f)?.has(u)));
    const own = shared.length === 1 ? shared[0]!.name : /^[A-Za-z][\w-]{2,}$/.test(stem) && !/^(module-|chunk|utils|constants|merged|index)/i.test(stem) ? stem : null;
    const apiModule = pieces.some((p) => p.folder === "api");
    const base = safeSegment(own ?? pieces.find((p) => p.folder === "functions")?.name ?? stem);
    const whole = apiModule ? posix.join(jsRoot, "api", `${base === "api" ? "index" : base}.js`) : posix.join(jsRoot, "functions", `${base}.js`);
    if (whole !== file.path && !units.some((u) => angular.has(u))) {
      for (const [exported, target] of exportsTo) exportsTo.set(exported, { path: whole, name: target.name });
      return { path: file.path, file, pieces: [], remainder: originalBody.filter((st) => !t.isImportDeclaration(st)), keepImports: imports, exportsTo, ast, program, pieceOf: new Map(), units, remainderExports: new Set(), roles: vueRoles, vendor: null, outPath: whole, components, autoImports, bare, namespaces: new Map() };
    }
  }

  const leftover = units.filter((u) => !pieceOf.has(u.name));
  const sizeOf = (u: Unit) => (u.statement.end ?? 0) - (u.statement.start ?? 0);
  const leftoverSize = leftover.reduce((n, u) => n + sizeOf(u), 0);
  const libraryShare = leftoverSize ? leftover.filter((u) => libraryUnits.has(u)).reduce((n, u) => n + sizeOf(u), 0) / leftoverSize : 0;
  const libraryHeavy = route === undefined && (leftover.length >= 20 || leftoverSize >= 20_000) && libraryShare >= 0.6 && (mixed || !leftover.some(appish));
  let bootstrap: t.Statement[] = [];
  if (libraryHeavy) {
    const appNames = new Set(pieceOf.keys());
    const usesApp = (stmt: t.Statement) => {
      let found = false;
      t.traverseFast(stmt, (n) => {
        if (!found && (t.isIdentifier(n) || t.isJSXIdentifier(n)) && appNames.has(n.name)) found = true;
      });
      return found;
    };
    bootstrap = rest.filter((st) => t.isExpressionStatement(st) && usesApp(st));
    if (bootstrap.length) {
      const name = ["main", "bootstrap", "start"].find((n) => !program.scope.hasBinding(n) && !pieceOf.has(n))!;
      const members: Unit[] = bootstrap.map((statement, i) => ({ index: units.length + i, name: i ? `${name}$${i}` : name, statement, exported: [], isDefault: false, init: null, functionLike: false }));
      const jsx = bootstrap.some((st) => hasJsx(st));
      const piece: Piece = { folder: null, name, units: members, path: posix.join(jsRoot, `${name}${jsx ? ".jsx" : ".js"}`), jsx };
      pieces.push(piece);
      for (const m of members) pieceOf.set(m.name, piece);
    }
  }
  const restLeft = rest.filter((st) => !bootstrap.includes(st));
  const remainder = [...restLeft];
  for (const u of units) if (!pieceOf.has(u.name)) remainder.push(u.statement);
  let vendor: string | null = null;
  let vendorPackage: string | null = null;
  const onlyExports = restLeft.every((st) => t.isExportNamedDeclaration(st) && !st.declaration);
  const plainRest = restLeft.every((st) => !t.isExportDefaultDeclaration(st) && !(t.isExportNamedDeclaration(st) && st.declaration));
  const nuxtEntry = autoImports && stem === "entry" && route === undefined && !leftover.some((u) => evident.has(u) || storeState(u.init));
  if (leftover.length && ((leftover.every((u) => libraryUnits.has(u)) && onlyExports) || ((bootstrap.length || (libraryHeavy && libraryShare >= 0.85) || nuxtEntry) && plainRest))) {
    const votes = new Map<string, number>();
    for (const u of leftover) {
      const pkg = libraryFunctions.get(u.name);
      if (pkg) votes.set(pkg, (votes.get(pkg) ?? 0) + 1);
    }
    if (!votes.size && stringOwner) {
      for (const u of leftover) {
        t.traverseFast(u.statement, (n) => {
          const owner = t.isStringLiteral(n) ? stringOwner(n.value) : null;
          if (owner) votes.set(owner, (votes.get(owner) ?? 0) + 1);
        });
      }
    }
    vendorPackage = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    vendor = vendorPackage ?? stem;
    if (mixed && stem === "entry" && vendorPackage) {
      vendorPackage = autoImports ? "nuxt" : vendorPackage;
      vendor = `${vendorPackage}/entry`;
    }
  }
  remainder.sort((a, b) => orderOf(originalBody, a) - orderOf(originalBody, b));
  return { path: file.path, file, pieces, remainder, keepImports: imports, exportsTo, ast, program, pieceOf, units, remainderExports: new Set(), roles: vueRoles, vendor, vendorPackage, outPath: file.path, components, autoImports, bare, namespaces: new Map(), route };
}

const HTTP_VERBS: Record<string, string> = { get: "fetch", post: "create", put: "update", patch: "update", delete: "delete", fetch: "fetch" };

function singularize(word: string): string {
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/(ss|us)$/.test(word)) return word;
  return word.replace(/s$/, "");
}

export function endpointName(node: t.Node): string | null {
  const names = new Set<string>();
  t.traverseFast(node, (n) => {
    if (!t.isCallExpression(n)) return;
    const callee = n.callee;
    const method = t.isIdentifier(callee, { name: "fetch" }) ? "fetch" : t.isMemberExpression(callee) && !callee.computed ? literalKey(callee.property) : null;
    const verb = method ? HTTP_VERBS[method] : undefined;
    const url = n.arguments[0];
    if (!verb || !(t.isStringLiteral(url) || t.isTemplateLiteral(url))) return;
    const parts: Array<string | null> = [];
    if (t.isStringLiteral(url)) parts.push(...url.value.split(/[?#]/)[0]!.split("/"));
    else url.quasis.forEach((q, i) => {
      parts.push(...(q.value.cooked ?? "").split(/[?#]/)[0]!.split("/"));
      if (i < url.expressions.length) parts.push(null);
    });
    const cleaned = parts.filter((p) => p !== "");
    const index = cleaned.map((p, i) => (p && /^[A-Za-z][\w-]*$/.test(p) && !/^(api|v\d+)$/i.test(p) ? i : -1)).filter((i) => i >= 0).pop();
    if (index === undefined) return;
    const resource = cleaned[index]!;
    const followedByParam = cleaned.slice(index + 1).includes(null);
    names.add(`${verb}${pascal(followedByParam ? singularize(resource) : resource)}`);
  });
  return names.size === 1 ? [...names][0]! : null;
}

const COMPOSABLE_VERB = /^(?:start|stop|open|close|get|set|fetch|load|is|has|can|should|toggle|reset|update|create|delete|remove|add|handle|on|run|check|use)(?=[A-Z])/;

function sharedWords(names: string[]): string {
  const split = names.map((n) => n.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [n]);
  const shared: string[] = [];
  for (let i = 0; split.every((w) => w[i] !== undefined && w[i] === split[0]![i]); i++) shared.push(split[0]![i]!);
  return shared.length ? shared.join("") : names[0]!;
}

function composableName(unit: Unit, program: NodePath<t.Program>): string | null {
  const fn = functionNode(unit);
  if (!fn || !t.isBlockStatement(fn.body)) return null;
  if (!/^use[A-Z]/.test(unit.name) && !unit.exported.some((e) => /^u[\w$]?$/.test(e))) return null;
  const stores = new Set<string>();
  const called = new Set<string>();
  let hooks = false;
  t.traverseFast(fn.body, (n) => {
    if (t.isCallExpression(n)) {
      const callee = calleeName(n.callee) ?? "";
      const bound = program.scope.getBinding(callee)?.path.node;
      const defined = t.isVariableDeclarator(bound) && t.isCallExpression(bound.init) && calleeName(bound.init.callee) === "defineStore" ? storeName(bound.init) : null;
      const store = /^use([A-Z]\w*?)Store$/.exec(defined ?? callee);
      if (defined) hooks = true;
      if (store) stores.add(store[1]!);
      if (/^use[A-Z]/.test(callee)) hooks = true;
      const spec = program.scope.getBinding(callee)?.path.parentPath?.node;
      if (t.isImportDeclaration(spec) && spec.source.value === "vue") hooks = true;
    }
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id) && t.isCallExpression(n.init)) called.add(n.id.name);
    if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.object) && called.has(n.object.name) && literalKey(n.property) === "value") hooks = true;
  });
  if (!hooks) return null;
  const returned = [...fn.body.body].reverse().find((st): st is t.ReturnStatement => t.isReturnStatement(st))?.argument;
  if (!t.isObjectExpression(returned)) return null;
  if (stores.size === 1 && returned.properties.some((p) => t.isSpreadElement(p))) return `use${[...stores][0]}`;
  for (const prop of returned.properties) {
    const key = t.isObjectProperty(prop) || t.isObjectMethod(prop) ? literalKey(prop.key) : null;
    const base = key?.replace(COMPOSABLE_VERB, "");
    if (base && base.length >= 3 && /^[A-Za-z]\w*$/.test(base)) return `use${capitalize(base)}`;
  }
  return null;
}

function reactiveFactory(unit: Unit): string | null {
  const fn = functionNode(unit);
  if (!fn || !t.isBlockStatement(fn.body) || fn.params.length > 2) return null;
  const refs = new Set<string>();
  for (const st of fn.body.body) if (t.isVariableDeclaration(st)) for (const d of st.declarations) if (t.isIdentifier(d.id) && t.isCallExpression(d.init) && d.init.arguments.length <= 1) refs.add(d.id.name);
  let reads = 0;
  let socket = false;
  t.traverseFast(fn.body, (n) => {
    if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.object) && refs.has(n.object.name) && literalKey(n.property) === "value") reads++;
    if (t.isNewExpression(n) && t.isIdentifier(n.callee, { name: "WebSocket" })) socket = true;
  });
  const returned = [...fn.body.body].reverse().find((st): st is t.ReturnStatement => t.isReturnStatement(st))?.argument;
  if (reads < 2 || !t.isObjectExpression(returned)) return null;
  const exposed = returned.properties.filter((p) => t.isObjectProperty(p) && t.isIdentifier(p.value) && refs.has(p.value.name));
  if (exposed.length < 2) return null;
  const topic = topicOf([fn.body]);
  const first = exposed.map((p) => literalKey((p as t.ObjectProperty).key)).find((k) => !!k && k.length >= 3);
  const base = topic ?? first;
  return base ? `use${socket ? "Live" : ""}${capitalize(base)}` : null;
}

function storeName(init: t.Node | null): string | null {
  if (!t.isCallExpression(init)) return null;
  const id = init.arguments[0];
  if (t.isStringLiteral(id) && /^[A-Za-z][\w-]*$/.test(id.value)) return `use${pascal(id.value)}Store`;
  if (t.isObjectExpression(id)) {
    const prop = id.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "id");
    if (t.isStringLiteral(prop?.value)) return `use${pascal(prop.value.value)}Store`;
  }
  const state = storeState(init);
  const first = state?.properties.map((p) => (t.isObjectProperty(p) && !t.isFunction(p.value) && !t.isArrowFunctionExpression(p.value) ? literalKey(p.key) : null)).find((k) => k && /^[A-Za-z]\w*$/.test(k));
  return first ? `use${pascal(first)}Store` : null;
}

type ForeignComponent = (source: string, imported: string) => string | null;

function lazyImport(call: t.CallExpression): string | null {
  const loader = call.arguments[0];
  if (call.arguments.length !== 1 || !(t.isArrowFunctionExpression(loader) || t.isFunctionExpression(loader))) return null;
  let found: string | null = null;
  t.traverseFast(loader.body, (n) => {
    if (!found && t.isCallExpression(n) && t.isImport(n.callee) && t.isStringLiteral(n.arguments[0])) found = n.arguments[0].value;
  });
  return found;
}

function resolveComponentName(node: t.Expression, program: NodePath<t.Program>, roles: Roles, seen = new Set<string>(), foreign?: ForeignComponent): { name: string; base: string } | null {
  if (t.isCallExpression(node)) {
    const callee = calleeName(node.callee) ?? "";
    const role = roles.get(callee) ?? callee;
    if (role === "unref" && t.isExpression(node.arguments[0])) return resolveComponentName(node.arguments[0], program, roles, seen, foreign);
    if ((role === "resolveComponent" || isMangled(callee)) && (node.arguments.length === 1 || (node.arguments.length === 2 && t.isBooleanLiteral(node.arguments[1], { value: true }))) && t.isStringLiteral(node.arguments[0]) && /^[A-Za-z][\w-]*$/.test(node.arguments[0].value)) {
      const value = node.arguments[0].value;
      return { name: /^[A-Z][A-Za-z0-9]*$/.test(value) ? value : pascal(value), base: "" };
    }
    return null;
  }
  if (!t.isIdentifier(node) || seen.has(node.name)) return null;
  seen.add(node.name);
  const binding = program.scope.getBinding(node.name);
  if (!binding) return null;
  if (binding.kind === "module") {
    const spec = binding.path.node;
    const decl = binding.path.parentPath?.node;
    const imported = t.isImportSpecifier(spec) ? (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) : t.isImportDefaultSpecifier(spec) ? "default" : null;
    const vueFile = t.isImportDeclaration(decl) && imported === "default" ? /([A-Z][A-Za-z0-9]*)\.vue$/.exec(decl.source.value)?.[1] : undefined;
    if (vueFile) return { name: vueFile, base: node.name };
    const found = imported && t.isImportDeclaration(decl) ? foreign?.(decl.source.value, imported) : null;
    if (found) return { name: found, base: node.name };
    if (imported && /^[A-Z][A-Za-z0-9]*$/.test(imported) && !isMangled(imported)) return { name: imported, base: node.name };
    return /^[A-Z][A-Za-z0-9]*$/.test(node.name) ? { name: node.name, base: node.name } : null;
  }
  const shown = displayNameOf(program, node.name);
  if (shown) return { name: shown, base: node.name };
  if (!binding.path.isVariableDeclarator()) return null;
  const init = binding.path.node.init;
  const builtin = builtinComponent(init);
  if (builtin) return { name: builtin, base: node.name };
  if (isComponentObject(init ?? null)) {
    const name = componentObjectName(init ?? null);
    return name ? { name, base: node.name } : null;
  }
  const lazy = t.isCallExpression(init) ? lazyImport(init) : null;
  if (lazy) {
    const found = foreign?.(lazy, "default") ?? /([A-Z][A-Za-z0-9]*)\.(?:vue|m?jsx?)$/.exec(lazy)?.[1];
    if (found) return { name: found, base: node.name };
  }
  if (t.isCallExpression(init)) {
    const component = sfcExport(init, (n) => {
      const bound = program.scope.getBinding(n)?.path.node;
      return t.isVariableDeclarator(bound) ? bound.init : t.isFunctionDeclaration(bound) ? bound : null;
    });
    const componentName = component ? componentObjectName(component) : null;
    if (componentName) return { name: componentName, base: node.name };
    const first = init.arguments[0];
    const firstName = t.isObjectExpression(first) ? componentObjectName(first) : null;
    if (firstName) return { name: firstName, base: node.name };
    if (t.isIdentifier(first)) {
      const found = resolveComponentName(first, program, roles, seen, foreign);
      if (found) return found;
    }
  }
  if (t.isIdentifier(init)) {
    const found = resolveComponentName(init, program, roles, seen, foreign);
    return found ? { name: found.name, base: node.name } : null;
  }
  return /^[A-Z][A-Za-z0-9]*$/.test(node.name) && !isMangled(node.name) ? { name: node.name, base: node.name } : null;
}

function setupAliases(setup: t.Function): Map<string, string> {
  const aliases = new Map<string, string>();
  const context = setup.params[1];
  if (!t.isBlockStatement(setup.body)) return aliases;
  const macros = new Set(t.isObjectPattern(context) ? context.properties.flatMap((p) => (t.isObjectProperty(p) && t.isIdentifier(p.value) ? [p.value.name] : [])) : []);
  if (t.isIdentifier(setup.params[0])) macros.add(setup.params[0].name);
  for (const stmt of setup.body.body) {
    if (!t.isVariableDeclaration(stmt) || stmt.kind === "var" || stmt.declarations.length !== 1) continue;
    const d = stmt.declarations[0]!;
    if (t.isIdentifier(d.id) && t.isIdentifier(d.init) && macros.has(d.init.name)) aliases.set(d.id.name, d.init.name);
  }
  if (aliases.size) {
    t.traverseFast(setup.body, (node) => {
      if (t.isAssignmentExpression(node) && t.isIdentifier(node.left)) aliases.delete(node.left.name);
      if (t.isUpdateExpression(node) && t.isIdentifier(node.argument)) aliases.delete(node.argument.name);
    });
  }
  return aliases;
}

function classSwitchSubject(fn: t.Function, propsLike: Set<string>): string | null {
  const subjects = new Set<string>();
  let strings = 0;
  let classy = 0;
  const subjectOf = (node: t.Node | null | undefined) => {
    t.traverseFast(node ?? t.nullLiteral(), (n) => {
      if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.object) && propsLike.has(n.object.name)) subjects.add(literalKey(n.property) ?? "");
    });
  };
  t.traverseFast(fn.body, (n) => {
    if (t.isConditionalExpression(n) || t.isIfStatement(n)) subjectOf(n.test);
    if (t.isSwitchStatement(n)) subjectOf(n.discriminant);
    if (t.isStringLiteral(n)) {
      strings++;
      if (/^[\w:[\]().\/-]+(\s+[\w:[\]().\/-]+)+$|^[a-z]+-[\w-]+$/.test(n.value.trim())) classy++;
    }
  });
  const [subject] = [...subjects].filter(Boolean);
  return subjects.size === 1 && subject && strings >= 2 && classy * 2 >= strings ? subject : null;
}

function propertyOf(node: t.Node | null | undefined): string | null {
  if (t.isLogicalExpression(node) && t.isNumericLiteral(node.right)) return propertyOf(node.left);
  return t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property) && node.property.name !== "value" ? node.property.name : null;
}

function computedName(body: t.Expression | null): string | null {
  const word = (text: string) => (/^[A-Za-z][\w-]*$/.test(text) ? text.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase()) : null);
  if (t.isBinaryExpression(body, { operator: "===" }) && t.isStringLiteral(body.right) && propertyOf(body.left)) {
    const value = word(body.right.value);
    return value && value.length > 2 ? `is${capitalize(value)}` : null;
  }
  if (t.isBinaryExpression(body) && /^(>|!==)$/.test(body.operator) && t.isNumericLiteral(body.right, { value: 0 })) {
    const prop = propertyOf(body.left);
    return prop && prop.length > 2 ? `has${capitalize(prop)}` : null;
  }
  if (t.isLogicalExpression(body) && /^(\|\||\?\?)$/.test(body.operator) && (t.isIdentifier(body.right, { name: "undefined" }) || t.isNullLiteral(body.right))) {
    const prop = propertyOf(body.left);
    return prop && prop.length > 2 ? prop : null;
  }
  if (t.isConditionalExpression(body) && t.isArrayExpression(body.alternate) && !body.alternate.elements.length && t.isCallExpression(body.consequent) && t.isIdentifier(body.consequent.callee)) {
    const name = /^(?:get)?([A-Za-z]\w*?)(?:Of|For)?$/.exec(body.consequent.callee.name)?.[1];
    return name && name.length > 2 ? name[0]!.toLowerCase() + name.slice(1) : null;
  }
  return null;
}

function setupLocalName(init: t.Node | null | undefined, role: (local: string) => string | null, names: Map<string, string>, propsParam: string | null, propsLike: Set<string> = new Set(propsParam ? [propsParam] : [])): string | null {
  if (!t.isCallExpression(init)) return null;
  const callee = t.isIdentifier(init.callee) ? init.callee.name : null;
  const api = callee ? (role(callee) ?? callee) : null;
  const arg = init.arguments[0];
  if (api && /^use([A-Z]\w*)Store$/.test(api)) return `${camel(api.replace(/^use|Store$/g, ""))}Store`;
  if (api === "useRoute") return "route";
  if (api === "useRouter") return "router";
  if (api === "useNuxtApp") return "nuxtApp";
  if (api === "useRuntimeConfig") return "config";
  if (api === "reactive" && t.isObjectExpression(arg)) return "state";
  if (api === "ref" || api === "shallowRef") {
    if (t.isNumericLiteral(arg)) return "count";
    if (t.isStringLiteral(arg)) return "text";
    if (t.isArrayExpression(arg)) return "items";
    if (t.isBooleanLiteral(arg)) return "flag";
    if (t.isObjectExpression(arg)) return "state";
    if (t.isMemberExpression(arg) && !arg.computed && t.isIdentifier(arg.object) && arg.object.name === propsParam) return `${literalKey(arg.property)}Value`;
    return null;
  }
  if (api === "computed" && (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg))) {
    const classes = classSwitchSubject(arg, propsLike);
    if (classes) return `${classes}Class`;
    const body = t.isExpression(arg.body) ? arg.body : null;
    const derived = computedName(body);
    if (derived) return derived;
    if (t.isBinaryExpression(body) && /^(>=|>|<=|<|===|!==)$/.test(body.operator)) {
      const left = t.isMemberExpression(body.left) && t.isIdentifier(body.left.object) ? body.left.object.name : t.isIdentifier(body.left) ? body.left.name : null;
      const subject = left ? (names.get(left) ?? left) : null;
      const kind = /^>/.test(body.operator) ? "Max" : /^</.test(body.operator) ? "Min" : body.operator === "===" ? "Equal" : "Different";
      return subject && subject.length > 2 ? `is${capitalize(subject)}${kind}` : null;
    }
  }
  return null;
}

const DIRECTIVE_HOOKS = new Set(["created", "beforeMount", "mounted", "beforeUpdate", "updated", "beforeUnmount", "unmounted", "getSSRProps"]);

function isDirectiveObject(node: t.Node | null | undefined): boolean {
  return t.isObjectExpression(node) && node.properties.length > 0 && node.properties.every((p) => (t.isObjectProperty(p) || t.isObjectMethod(p)) && DIRECTIVE_HOOKS.has(literalKey(p.key) ?? ""));
}

function directiveName(node: t.ObjectExpression): string {
  const code = JSON.stringify(node);
  if (/"name":"focus"/.test(code)) return "Focus";
  if (/"name":"contains"/.test(code) && /"value":"(click|mousedown|pointerdown)"/.test(code)) return "ClickOutside";
  if (/"name":"IntersectionObserver"/.test(code)) return "Intersect";
  if (/"name":"ResizeObserver"/.test(code)) return "Resize";
  if (/"name":"select"/.test(code)) return "Select";
  return "Directive";
}

function nameSetupLocals(program: NodePath<t.Program>, setup: t.Function, role: (local: string) => string | null, propKeys: string[] = []): void {
  let setupPath: NodePath<t.Function> | null = null;
  program.traverse({
    Function(path) {
      if (path.node === setup) {
        setupPath = path;
        path.stop();
      }
    },
  });
  const found = setupPath as NodePath<t.Function> | null;
  if (!found || !t.isBlockStatement(setup.body)) return;
  const propsParam = t.isIdentifier(setup.params[0]) ? setup.params[0].name : null;
  const names = new Map<string, string>();
  const counted = new Set<string>();
  t.traverseFast(setup.body, (n) => {
    const target = t.isUpdateExpression(n) ? n.argument : t.isAssignmentExpression(n) && (n.operator === "+=" || n.operator === "-=" || (n.operator === "=" && t.isBinaryExpression(n.right) && /^[+-]$/.test(n.right.operator) && JSON.stringify(n.right).includes(JSON.stringify(n.left).slice(0, 60)))) ? n.left : null;
    if (t.isMemberExpression(target) && t.isIdentifier(target.object) && literalKey(target.property) === "value") counted.add(target.object.name);
  });
  t.traverseFast(setup.body, (n) => {
    if (!t.isAssignmentExpression(n, { operator: "=" }) || !t.isMemberExpression(n.left) || !t.isIdentifier(n.left.object) || literalKey(n.left.property) !== "value") return;
    const right = n.right;
    if (t.isCallExpression(right) && right.arguments.some((a) => t.isBinaryExpression(a) && /^[+-]$/.test(a.operator) && t.isMemberExpression(a.left) && t.isIdentifier(a.left.object, { name: (n.left as t.MemberExpression & { object: t.Identifier }).object.name }))) counted.add(n.left.object.name);
  });
  const flags = new Map<string, string>();
  const valueOf = (node: t.Node | null | undefined): string | null => (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.object) && literalKey(node.property) === "value" ? node.object.name : null);
  t.traverseFast(setup.body, (n) => {
    if (t.isTryStatement(n) && n.finalizer) {
      for (const stmt of n.finalizer.body) {
        const expr = t.isExpressionStatement(stmt) ? stmt.expression : null;
        const target = t.isAssignmentExpression(expr, { operator: "=" }) && t.isBooleanLiteral(expr.right, { value: false }) ? valueOf(expr.left) : null;
        if (target) flags.set(target, "loading");
      }
    }
    if (t.isObjectProperty(n) && !n.computed) {
      const key = literalKey(n.key) ?? "";
      const target = valueOf(n.value);
      if (!target || flags.has(target)) return;
      if (/^(open|isOpen|show|visible|modelValue)$/.test(key)) flags.set(target, "isOpen");
      else if (/^(loading|pending|isLoading)$/.test(key)) flags.set(target, "loading");
    }
  });
  const propsLike = new Set<string>(propsParam ? [propsParam] : []);
  for (const stmt of setup.body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) if (t.isIdentifier(d.id) && t.isIdentifier(d.init) && propsLike.has(d.init.name)) propsLike.add(d.id.name);
  }
  t.traverseFast(setup.body, (n) => {
    if (!t.isObjectExpression(n)) return;
    const key = n.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "ref_key" && t.isStringLiteral(p.value));
    const target = n.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "ref" && t.isIdentifier(p.value));
    if (!key || !target) return;
    const wanted = (key.value as t.StringLiteral).value;
    const local = (target.value as t.Identifier).name;
    const binding = found.scope.getBinding(local);
    if (!binding || binding.scope !== found.scope || !isValidName(wanted) || local === wanted || found.scope.hasBinding(wanted) || program.scope.hasBinding(wanted)) return;
    found.scope.rename(local, wanted);
    names.set(local, wanted);
    names.set(wanted, wanted);
  });
  for (const key of propKeys) {
    const binding = found.scope.getBinding(key);
    if (!binding || binding.scope !== found.scope || binding.kind === "param") continue;
    let name = `${key}Local`;
    for (let n = 2; found.scope.hasBinding(name) || program.scope.hasBinding(name); n++) name = `${key}Local${n}`;
    found.scope.rename(key, name);
    names.set(key, name);
  }
  const directives = new Set<string>();
  t.traverseFast(setup.body, (n) => {
    if (!t.isCallExpression(n) || !t.isIdentifier(n.callee) || (role(n.callee.name) ?? n.callee.name) !== "withDirectives" || !t.isArrayExpression(n.arguments[1])) return;
    for (const item of n.arguments[1].elements) if (t.isArrayExpression(item) && t.isIdentifier(item.elements[0])) directives.add(item.elements[0].name);
  });
  for (const local of directives) {
    const binding = found.scope.getBinding(local) ?? program.scope.getBinding(local);
    const init = binding?.path.isVariableDeclarator() ? binding.path.node.init : null;
    if (!binding || /^v[A-Z]/.test(local) || !isDirectiveObject(init)) continue;
    const base = `v${directiveName(init as t.ObjectExpression)}`;
    let name = base;
    for (let n = 2; found.scope.hasBinding(name) || program.scope.hasBinding(name); n++) name = `${base}${n}`;
    binding.scope.rename(local, name);
    names.set(local, name);
    names.set(name, name);
  }
  for (const stmt of setup.body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) {
      if (!t.isIdentifier(d.id) || !isMangled(d.id.name)) continue;
      const initial = t.isCallExpression(d.init) ? d.init.arguments[0] : null;
      const flag = t.isBooleanLiteral(initial) && t.isCallExpression(d.init) && t.isIdentifier(d.init.callee) && /^(ref|shallowRef)$/.test(role(d.init.callee.name) ?? d.init.callee.name) ? flags.get(d.id.name) : undefined;
      const base = counted.has(d.id.name) && t.isCallExpression(d.init) ? "count" : (flag ?? setupLocalName(d.init, role, names, propsParam, propsLike));
      if (!base || !isValidName(base)) continue;
      let name = base;
      for (let n = 2; found.scope.hasBinding(name) || program.scope.hasBinding(name); n++) name = `${base}${n}`;
      const old = d.id.name;
      found.scope.rename(old, name);
      names.set(old, name);
      names.set(name, name);
    }
  }
  found.traverse({
    CallExpression(path) {
      const callee = t.isIdentifier(path.node.callee) ? path.node.callee.name : null;
      if (!callee || (role(callee) ?? callee) !== "renderList") return;
      const [source, fn] = path.get("arguments");
      if (!fn || !(fn.isArrowFunctionExpression() || fn.isFunctionExpression())) return;
      const property = source?.isMemberExpression() && !source.node.computed ? literalKey(source.node.property) : source?.isIdentifier() ? source.node.name : null;
      const wanted = [property ? singularName(property) : "item", "index"];
      fn.node.params.forEach((param, i) => {
        if (!t.isIdentifier(param) || !isMangled(param.name) || i > 1) return;
        let name = wanted[i]!;
        if (name === property || !isValidName(name)) name = i === 0 ? "item" : "index";
        if (!fn.scope.hasBinding(name) || fn.scope.getBinding(name)?.scope !== fn.scope) {
          if (!fn.scope.parent?.hasBinding(name)) fn.scope.rename(param.name, name);
        }
      });
    },
  });
}

function vueTemplate(unit: Unit, program: NodePath<t.Program>, roles: Roles, foreign?: ForeignComponent): Piece["vue"] | null {
  const options = componentOptions(unit.init);
  if (!options) return null;
  const propKeys = t.isObjectExpression(options.props) ? options.props.properties.flatMap((p) => ((t.isObjectProperty(p) || t.isObjectMethod(p)) && literalKey(p.key) ? [literalKey(p.key)!] : [])) : t.isArrayExpression(options.props) ? options.props.elements.flatMap((e) => (t.isStringLiteral(e) ? [e.value] : [])) : [];
  if (options.setup) nameSetupLocals(program, options.setup, (local) => roles.get(local) ?? (isMangled(local) ? null : local), propKeys);
  const renderFn = renderFunction(options);
  if (renderFn) {
    t.traverseFast(renderFn, (n) => {
      if (!t.isCallExpression(n) || !t.isIdentifier(n.callee) || (roles.get(n.callee.name) ?? n.callee.name) !== "resolveDynamicComponent") return;
      const arg = n.arguments[0];
      const binding = t.isIdentifier(arg) && isMangled(arg.name) ? program.scope.getBinding(arg.name) : undefined;
      if (binding?.path.isVariableDeclarator() && t.isStringLiteral(binding.path.node.init) && !program.scope.hasBinding("tag")) program.scope.rename((arg as t.Identifier).name, "tag");
    });
  }
  const render = renderFunction(options);
  if (!render || !options.setup || options.setup.params.length > 2) {
    return null;
  }
  const context = options.setup.params[1];
  if (context && !(t.isObjectPattern(context) && context.properties.every((p) => t.isObjectProperty(p) && /^(emit|attrs|slots|expose)$/.test(literalKey(p.key) ?? "") && t.isIdentifier(p.value)))) {
    return null;
  }
  const roleOf = (local: string) => {
    if (roles.has(local)) return roles.get(local)!;
    return isMangled(local) ? null : local;
  };
  const refs = new Set<string>();
  if (t.isBlockStatement(options.setup.body)) {
    for (const stmt of options.setup.body.body) {
      if (!t.isVariableDeclaration(stmt)) continue;
      for (const d of stmt.declarations) {
        if (t.isIdentifier(d.id) && t.isCallExpression(d.init) && /^(ref|shallowRef|computed|toRef|customRef)$/.test(roleOf(calleeName(d.init.callee) ?? "") ?? "")) refs.add(d.id.name);
      }
    }
  }
  const components = new Set<string>();
  const free = new Set<string>();
  const aliases = setupAliases(options.setup);
  const propsParam = t.isIdentifier(options.setup.params[0]) ? options.setup.params[0].name : null;
  const ctx: SfcContext = {
    role: roleOf,
    componentName: (node) => {
      const found = resolveComponentName(node, program, roles, new Set(), foreign);
      if (found) components.add(found.base ? `${found.name}\u0000${found.base}` : found.name);
      return found?.name ?? null;
    },
    hoisted: (name) => {
      const binding = program.scope.getBinding(name);
      const init = binding?.path.isVariableDeclarator() ? binding.path.node.init : null;
      return t.isObjectExpression(init) || t.isArrayExpression(init) ? init : null;
    },
    refs,
    propsParam,
    propNames: new Set(),
    free,
    aliases,
  };
  const template = renderTemplate(render, ctx);
  return template ? { template, components, free } : null;
}

function orderOf(body: t.Statement[], stmt: t.Statement): number {
  const direct = body.indexOf(stmt);
  if (direct >= 0) return direct;
  const names = new Set<string>();
  collectDeclared(stmt, names);
  const index = body.findIndex((s) => {
    const own = new Set<string>();
    collectDeclared(t.isExportNamedDeclaration(s) && s.declaration ? s.declaration : t.isExportDefaultDeclaration(s) ? s.declaration : s, own);
    return [...names].some((n) => own.has(n));
  });
  return index >= 0 ? index + 0.5 : body.length;
}

function collectDeclared(node: t.Node | null | undefined, into: Set<string>): void {
  if (!node) return;
  if ((t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) && node.id) into.add(node.id.name);
  if (t.isVariableDeclaration(node)) for (const d of node.declarations) for (const name of Object.keys(t.getBindingIdentifiers(d.id))) into.add(name);
  if (t.isExportNamedDeclaration(node) && node.declaration) collectDeclared(node.declaration, into);
}

interface CssBlock {
  prelude: string;
  body: string;
  children: CssBlock[] | null;
}

function cssBlocks(css: string): CssBlock[] {
  const out: CssBlock[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
    }
    const body = css.slice(open + 1, j - 1);
    const nested = /^@(media|supports|layer|container)\b/.test(prelude);
    out.push({ prelude, body, children: nested ? cssBlocks(body) : null });
    i = j;
  }
  return out;
}

function declarations(body: string): string {
  return body.trim().split(";").map((d) => d.trim()).filter(Boolean).map((d) => `  ${d};`).join("\n");
}

export function scopedRules(css: string, scopeId: string): string | null {
  const attr = `[${scopeId}]`;
  const hash = scopeId.replace(/^data-v-/, "");
  const unhash = (text: string) => text.split(`-${hash}`).join("");
  const render = (blocks: CssBlock[], indent: string): string[] => {
    const rules: string[] = [];
    for (const block of blocks) {
      if (block.children) {
        const inner = render(block.children, `${indent}  `);
        if (inner.length) rules.push(`${indent}${block.prelude} {\n${inner.join("\n\n")}\n${indent}}`);
      } else if (/^@(-webkit-)?keyframes\s/.test(block.prelude) && block.prelude.endsWith(`-${hash}`)) {
        rules.push(`${indent}${unhash(block.prelude)} {\n${block.body.trim().replace(/\s*([^{}]+)\{([^{}]*)\}/g, (_, sel: string, decl: string) => `${indent}  ${sel.trim()} {\n${declarations(decl).replace(/^/gm, `${indent}  `)}\n${indent}  }\n`).trimEnd()}\n${indent}}`);
      } else if (block.prelude.includes(attr) && !block.prelude.startsWith("@")) {
        rules.push(`${indent}${block.prelude.split(attr).join("").replace(/\s+/g, " ").trim()} {\n${unhash(declarations(block.body)).replace(/^/gm, indent)}\n${indent}}`);
      }
    }
    return rules;
  };
  const rules = render(cssBlocks(css), "");
  return rules.length ? rules.join("\n\n") : null;
}

export function removeScopedRules(css: string, scopeIds: ReadonlySet<string>): string {
  if (!scopeIds.size) return css;
  const hashes = [...scopeIds].map((s) => s.replace(/^data-v-/, ""));
  const owned = (block: CssBlock) => [...scopeIds].some((id) => block.prelude.includes(`[${id}]`)) || (/^@(-webkit-)?keyframes\s/.test(block.prelude) && hashes.some((h) => block.prelude.endsWith(`-${h}`)));
  const strip = (text: string): string => {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) {
        out += text.slice(i);
        break;
      }
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      const start = text.lastIndexOf("}", open) + 1 > i ? text.lastIndexOf("}", open) + 1 : i;
      const lead = text.slice(i, start);
      const prelude = text.slice(start, open).trim();
      const body = text.slice(open + 1, j - 1);
      const block: CssBlock = { prelude, body, children: null };
      if (/^@(media|supports|layer|container)\b/.test(prelude)) {
        const inner = strip(body);
        out += inner.trim() ? `${lead}${text.slice(start, open + 1)}${inner}}` : lead;
      } else if (!owned(block)) out += text.slice(i, j);
      else out += lead;
      i = j;
    }
    return out;
  };
  return strip(css).replace(/\n{3,}/g, "\n\n");
}

function attachScopedStyles(plans: Map<string, Plan>, files: OutputFile[]): Set<string> {
  const attached = new Set<string>();
  const css = files.filter((f) => f.kind === "style").map((f) => f.content).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  if (!css.includes("[data-v-")) return attached;
  const scopes = new Map<string, string>();
  for (const plan of plans.values()) {
    plan.program.traverse({
      CallExpression(path) {
        const [comp, list] = path.node.arguments;
        if (!t.isArrayExpression(list)) return;
        for (const item of list.elements) {
          if (!t.isArrayExpression(item) || !t.isStringLiteral(item.elements[0], { value: "__scopeId" }) || !t.isStringLiteral(item.elements[1])) continue;
          const direct = t.isObjectExpression(comp) ? componentObjectName(comp) : t.isCallExpression(comp) ? componentObjectName(sfcExport(comp) ?? null) : null;
          const found = direct ? { name: direct } : t.isExpression(comp) ? resolveComponentName(comp, plan.program, plan.roles) : null;
          if (found) scopes.set(found.name, item.elements[1].value);
        }
      },
    });
  }
  for (const plan of plans.values()) {
    for (const piece of plan.pieces) {
      if (!piece.vue) continue;
      const host = piece.units.find((u) => u.name === piece.name);
      const name = host ? componentObjectName(host.init) : null;
      const scope = name ? scopes.get(name) : undefined;
      const style = scope ? scopedRules(css, scope) : null;
      if (style && scope) {
        piece.vue.style = style;
        attached.add(scope);
      }
    }
  }
  return attached;
}

function safeRelativeName(name: string): string {
  return name.split("/").map(safeSegment).join("/");
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return posix.normalize(posix.join(posix.dirname(fromFile), specifier));
}

function reimport(decl: t.ImportDeclaration, from: string, to: string, keep: (local: string) => boolean): t.ImportDeclaration | null {
  const specifiers = decl.specifiers.filter((s) => keep(s.local.name));
  if (!specifiers.length) return null;
  const target = resolveSpecifier(from, decl.source.value);
  const source = target ? relativeImport(to, target) : decl.source.value;
  return t.importDeclaration(specifiers.map((s) => t.cloneNode(s)), t.stringLiteral(source));
}

function usedNames(statements: t.Statement[], program: NodePath<t.Program>): Set<string> {
  const names = new Set<string>();
  const wrapper = t.file(t.program(statements.map((s) => t.cloneNode(s, true))));
  traverse(wrapper, {
    ReferencedIdentifier(path: NodePath) {
      const name = (path.node as t.Identifier).name;
      if (!path.scope.getBinding(name) && program.scope.getBinding(name)) names.add(name);
    },
  } as never);
  traverse(wrapper, {
    Identifier(path) {
      if (path.parentPath.isExportSpecifier()) names.add(path.node.name);
    },
  });
  return names;
}

function pieceCode(piece: Piece, plan: Plan): string {
  if (piece.vue) return sfcCode(piece, plan);
  const statements: t.Statement[] = piece.units.map((u) => u.statement);
  const used = usedNames(statements, plan.program);
  const own = new Set(piece.units.map((u) => u.name));
  const header: t.Statement[] = [];
  for (const decl of plan.keepImports) {
    const next = reimport(decl, plan.path, piece.path, (local) => used.has(local));
    if (next) header.push(next);
  }
  const siblings = new Map<string, string[]>();
  const packages = new Map<string, string[]>();
  for (const name of used) {
    if (own.has(name)) continue;
    const other = plan.pieceOf.get(name);
    if (other && other !== piece) siblings.set(other.path, [...(siblings.get(other.path) ?? []), name]);
    else if (!other && plan.namespaces.has(name) && isRemainderBinding(plan, name)) header.push(t.importDeclaration([t.importNamespaceSpecifier(t.identifier(name))], t.stringLiteral(plan.namespaces.get(name)!)));
    else if (!other && plan.bare.has(name) && isRemainderBinding(plan, name)) packages.set(plan.bare.get(name)!, [...(packages.get(plan.bare.get(name)!) ?? []), name]);
    else if (!other && isRemainderBinding(plan, name)) {
      siblings.set(plan.outPath, [...(siblings.get(plan.outPath) ?? []), name]);
      plan.remainderExports.add(name);
    }
  }
  for (const [path, names] of siblings) header.push(importFrom(plan, path, names, piece.path));
  for (const [source, names] of packages) header.push(t.importDeclaration(names.map((n) => t.importSpecifier(t.identifier(n), t.identifier(n))), t.stringLiteral(source)));
  const bodyOut: t.Statement[] = [];
  const referenced = isReferencedOutside(plan, piece);
  for (const u of piece.units) {
    const host = u === piece.units.find((m) => m.name === piece.name);
    const exportedHere = host ? [...u.exported, ...(referenced && !u.isDefault && !u.exported.includes(u.name) ? [u.name] : [])] : [];
    let stmt: t.Statement = relocateLoads(t.cloneNode(u.statement, true), plan.path, piece.path);
    if (host && u.isDefault && (t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt))) stmt = t.exportDefaultDeclaration(stmt);
    else if (exportedHere.includes(u.name) && (t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt) || t.isVariableDeclaration(stmt))) stmt = t.exportNamedDeclaration(stmt);
    bodyOut.push(stmt);
    if (host && u.isDefault && !t.isExportDefaultDeclaration(stmt)) bodyOut.push(t.exportDefaultDeclaration(t.identifier(u.name)));
    const aliases = exportedHere.filter((e) => e !== u.name);
    if (aliases.length) bodyOut.push(t.exportNamedDeclaration(null, aliases.map((a) => t.exportSpecifier(t.identifier(u.name), t.identifier(a)))));
    if (!host) {
      const names = [...(memberUsedOutside(plan, piece, u.name) && !u.exported.includes(u.name) ? [u.name] : []), ...u.exported];
      if (names.length) bodyOut.push(t.exportNamedDeclaration(null, names.map((a) => t.exportSpecifier(t.identifier(u.name), t.identifier(a)))));
    }
  }
  const hostUnit = piece.units.find((m) => m.name === piece.name)!;
  if (piece.path.endsWith("/app.config.js")) {
    const decl = bodyOut.find((st): st is t.ExportNamedDeclaration => t.isExportNamedDeclaration(st) && t.isVariableDeclaration(st.declaration)) ?? null;
    const target = decl ? (decl.declaration as t.VariableDeclaration).declarations[0] : bodyOut.flatMap((st) => (t.isVariableDeclaration(st) ? st.declarations : []))[0];
    if (target?.init) target.init = t.callExpression(t.identifier("defineAppConfig"), [target.init]);
    bodyOut.push(t.exportDefaultDeclaration(t.identifier(piece.name)));
  }
  if (piece.folder === "plugins" && !hostUnit.isDefault) bodyOut.push(t.exportDefaultDeclaration(t.identifier(piece.name)));
  if (referenced && hostUnit.isDefault && !hostUnit.exported.includes(piece.name)) bodyOut.push(t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(piece.name), t.identifier(piece.name))]));
  const out = t.file(t.program([...header, ...bodyOut]));
  tidyAst(out);
  return print(out);
}

function relocateLoads<T extends t.Node>(node: T, from: string, to: string): T {
  if (from === to) return node;
  t.traverseFast(node, (n) => {
    if (!t.isCallExpression(n) || !(t.isImport(n.callee) || t.isIdentifier(n.callee, { name: "require" }))) return;
    const arg = n.arguments[0];
    if (!t.isStringLiteral(arg)) return;
    const target = resolveSpecifier(from, arg.value);
    if (target) arg.value = relativeImport(to, target);
  });
  return node;
}

function isRemainderBinding(plan: Plan, name: string): boolean {
  return plan.remainder.some((s) => {
    const names = new Set<string>();
    collectDeclared(s, names);
    return names.has(name);
  });
}

function memberUsedOutside(plan: Plan, piece: Piece, name: string): boolean {
  const binding = plan.program.scope.getBinding(name);
  if (!binding) return false;
  const inside = new Set<t.Node>(piece.units.flatMap((u) => [u.statement, ...(t.isVariableDeclaration(u.statement) ? u.statement.declarations : [])]));
  return binding.referencePaths.some((ref) => !ref.parentPath?.isExportSpecifier() && !ref.findParent((p) => inside.has(p.node)));
}

function isReferencedOutside(plan: Plan, piece: Piece): boolean {
  const binding = plan.program.scope.getBinding(piece.name);
  if (!binding) return false;
  const inside = new Set(piece.units.map((u) => u.statement));
  return binding.referencePaths.some((ref) => {
    if (ref.parentPath?.isExportDefaultDeclaration() || ref.parentPath?.isExportSpecifier()) return false;
    let current: NodePath | null = ref;
    while (current && current.parentPath && !current.parentPath.isProgram()) current = current.parentPath;
    return current ? !inside.has(current.node as t.Statement) : false;
  });
}

function importFrom(plan: Plan, path: string, names: string[], from: string): t.ImportDeclaration {
  const vue = path.endsWith(".vue");
  const specifiers = names.map((name, i) => (vue && i === 0 ? t.importDefaultSpecifier(t.identifier(name)) : t.importSpecifier(t.identifier(name), t.identifier(name))));
  return t.importDeclaration(specifiers, t.stringLiteral(relativeImport(from, path)));
}

function sfcCode(piece: Piece, plan: Plan): string {
  const host = piece.units.find((m) => m.name === piece.name)!;
  const options = componentOptions(host.init)!;
  const setup = options.setup!;
  const aliases = setupAliases(setup);
  const body = (t.isBlockStatement(setup.body) ? setup.body.body.slice(0, -1).map((s) => t.cloneNode(s, true)) : []).filter(
    (s) => !(t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isIdentifier(s.declarations[0]!.id) && aliases.has(s.declarations[0]!.id.name)),
  );
  if (aliases.size) {
    traverse(t.file(t.program(body)), {
      Identifier(path) {
        const next = aliases.get(path.node.name);
        if (next && path.isReferencedIdentifier() && !path.scope.getBinding(path.node.name)) path.node.name = next;
      },
    });
  }
  const propsParam = t.isIdentifier(setup.params[0]) ? setup.params[0].name : null;
  const script: t.Statement[] = [];
  const program = t.program(body);
  if (propsParam) {
    traverse(t.file(program), {
      Identifier(path) {
        if (path.node.name === propsParam && path.isReferencedIdentifier() && !path.scope.getBinding(propsParam)) path.node.name = "props";
      },
    });
  }
  const context = setup.params[1];
  const macros: t.Statement[] = [];
  const vueHelpers = new Set<string>();
  if (t.isObjectPattern(context)) {
    for (const prop of context.properties) {
      if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.value)) continue;
      const key = literalKey(prop.key);
      const local = prop.value.name;
      if (key === "emit") macros.push(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(local), t.callExpression(t.identifier("defineEmits"), options.emits ? [t.cloneNode(options.emits, true)] : []))]));
      else if (key === "attrs" || key === "slots") {
        const helper = key === "attrs" ? "useAttrs" : "useSlots";
        vueHelpers.add(helper);
        macros.push(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(local), t.callExpression(t.identifier(helper), []))]));
      } else if (key === "expose" && body.some((st) => JSON.stringify(st).includes(`"name":"${local}"`))) macros.push(t.variableDeclaration("const", [t.variableDeclarator(t.identifier(local), t.identifier("defineExpose"))]));
    }
  }
  const usesProps = options.props || (propsParam && print(program).includes("props"));
  if (usesProps) script.push(t.variableDeclaration("const", [t.variableDeclarator(t.identifier("props"), t.callExpression(t.identifier("defineProps"), options.props ? [t.cloneNode(options.props, true)] : []))]));
  script.push(...macros);
  const others = piece.units.filter((u) => u !== host);
  const templateFree = piece.vue!.free;
  const bodyDeclared = new Set<string>();
  for (const stmt of [...script, ...body]) collectDeclared(stmt, bodyDeclared);
  let used = usedNames([...script, ...body], plan.program);
  for (const name of templateFree) if (!bodyDeclared.has(name) && plan.program.scope.getBinding(name)) used.add(name);
  const declaredBy = (u: Unit) => {
    const names = new Set<string>([u.name]);
    collectDeclared(u.statement, names);
    return names;
  };
  const wanted = new Set(used);
  let keptUnits = others.filter((u) => [...declaredBy(u)].some((n) => wanted.has(n)) && ![...declaredBy(u)].some((n) => bodyDeclared.has(n)));
  for (let size = -1; size !== keptUnits.length; ) {
    size = keptUnits.length;
    for (const name of usedNames(keptUnits.map((u) => u.statement), plan.program)) wanted.add(name);
    keptUnits = others.filter((u) => [...declaredBy(u)].some((n) => wanted.has(n)) && ![...declaredBy(u)].some((n) => bodyDeclared.has(n)));
  }
  used = usedNames([...script, ...keptUnits.map((u) => u.statement), ...body], plan.program);
  for (const name of templateFree) if (!bodyDeclared.has(name) && plan.program.scope.getBinding(name)) used.add(name);
  const vueImports = new Set<string>(vueHelpers);
  const renamed = new Map<string, string>();
  for (const name of used) {
    const role = plan.roles.get(name);
    if (role && (isVueApi(role) || composableSource(role)) && role !== name) renamed.set(name, role);
  }
  const vueAliases = new Map<string, string>();
  const composableImports = new Map<string, string[]>();
  if (renamed.size) {
    const scratch = t.file(t.program([...keptUnits.map((u) => u.statement), ...body].map((s) => s)));
    const blocked = new Set<string>();
    traverse(scratch, {
      Scope(path) {
        for (const to of renamed.values()) if (path.scope.getOwnBinding(to)) blocked.add(to);
      },
    });
    traverse(scratch, {
      Identifier(path) {
        const next = renamed.get(path.node.name);
        if (next && !blocked.has(next) && path.isReferencedIdentifier() && !path.scope.getBinding(path.node.name)) path.node.name = next;
      },
    });
    for (const [from, to] of renamed) {
      if (blocked.has(to)) {
        vueAliases.set(from, to);
        used.delete(from);
        continue;
      }
      used.delete(from);
      used.add(to);
      const source = composableSource(to);
      if (!source) vueImports.add(to);
      else if (!plan.autoImports) composableImports.set(source, [...(composableImports.get(source) ?? []), to]);
    }
  }
  const header: t.Statement[] = [];
  const roleNames = new Set(plan.roles.values());
  for (const decl of plan.keepImports) {
    const fromVue = /^(vue|@vue\/)/.test(decl.source.value);
    const vueApi = (local: string) => isVueApi(local) && (fromVue || local.length > 2 || roleNames.has(local));
    const next = reimport(decl, plan.path, piece.path, (local) => used.has(local) && !vueApi(local) && !composableSource(local));
    if (next) header.push(next);
    for (const spec of decl.specifiers) if (used.has(spec.local.name) && vueApi(spec.local.name)) vueImports.add(spec.local.name);
    for (const spec of decl.specifiers) {
      const source = used.has(spec.local.name) ? composableSource(spec.local.name) : null;
      if (source && !plan.autoImports) composableImports.set(source, [...new Set([...(composableImports.get(source) ?? []), spec.local.name])]);
    }
  }
  const own = new Set(piece.units.map((u) => u.name));
  const siblings = new Map<string, string[]>();
  for (const name of used) {
    if (own.has(name) || plan.keepImports.some((d) => d.specifiers.some((s) => s.local.name === name))) continue;
    if (isVueApi(name) && isRemainderBinding(plan, name)) {
      vueImports.add(name);
      continue;
    }
    const other = plan.pieceOf.get(name);
    if (other && other !== piece) siblings.set(other.path, [...(siblings.get(other.path) ?? []), name]);
    else if (!other && plan.namespaces.has(name) && isRemainderBinding(plan, name)) header.push(t.importDeclaration([t.importNamespaceSpecifier(t.identifier(name))], t.stringLiteral(plan.namespaces.get(name)!)));
    else if (!other && plan.bare.has(name) && isRemainderBinding(plan, name)) header.push(t.importDeclaration([t.importSpecifier(t.identifier(name), t.identifier(name))], t.stringLiteral(plan.bare.get(name)!)));
    else if (!other && isRemainderBinding(plan, name)) {
      siblings.set(plan.outPath, [...(siblings.get(plan.outPath) ?? []), name]);
      plan.remainderExports.add(name);
    }
  }
  for (const entry of piece.vue!.components) {
    const [name, base] = entry.split("\u0000") as [string, string | undefined];
    const library = plan.components.get(name);
    if (library) {
      if (!library.global) header.push(t.importDeclaration([t.importSpecifier(t.identifier(name), t.identifier(library.export))], t.stringLiteral(library.package)));
      continue;
    }
    if (!base || NUXT_GLOBALS.test(name)) continue;
    const other = plan.pieceOf.get(base);
    const importDecl = plan.keepImports.find((d) => d.specifiers.some((s) => s.local.name === base));
    if (other && other !== piece) header.push(t.importDeclaration([other.vue ? t.importDefaultSpecifier(t.identifier(name)) : t.importSpecifier(t.identifier(name), t.identifier(base))], t.stringLiteral(relativeImport(piece.path, other.path))));
    else if (importDecl) {
      const spec = importDecl.specifiers.find((x) => x.local.name === base)!;
      const source = t.stringLiteral(relativeImport(piece.path, resolveSpecifier(plan.path, importDecl.source.value) ?? importDecl.source.value));
      if (t.isImportSpecifier(spec)) header.push(t.importDeclaration([t.importSpecifier(t.identifier(name), spec.imported)], importDecl.source.value.startsWith(".") ? source : importDecl.source));
      else if (t.isImportDefaultSpecifier(spec)) header.push(t.importDeclaration([t.importDefaultSpecifier(t.identifier(name))], importDecl.source.value.startsWith(".") ? source : importDecl.source));
      else {
        const next = reimport(importDecl, plan.path, piece.path, (local) => local === base);
        if (next) header.push(next);
      }
    } else if (NUXT_GLOBALS.test(name)) continue;
    else if (name === "RouterLink" || name === "RouterView") header.push(t.importDeclaration([t.importSpecifier(t.identifier(name), t.identifier(name))], t.stringLiteral("vue-router")));
    else if (isRemainderBinding(plan, base)) {
      header.push(t.importDeclaration([t.importSpecifier(t.identifier(name), t.identifier(base))], t.stringLiteral(relativeImport(piece.path, plan.outPath))));
      plan.remainderExports.add(base);
    }
  }
  for (const [source, names] of composableImports) header.unshift(t.importDeclaration(names.map((n) => t.importSpecifier(t.identifier(n), t.identifier(n))), t.stringLiteral(source)));
  if (vueImports.size || vueAliases.size) header.unshift(t.importDeclaration([...[...vueImports].map((n) => t.importSpecifier(t.identifier(n), t.identifier(n))), ...[...vueAliases].map(([local, api]) => t.importSpecifier(t.identifier(local), t.identifier(api)))], t.stringLiteral("vue")));
  for (const [path, names] of siblings) header.push(importFrom(plan, path, names, piece.path));
  const merged: t.Statement[] = [];
  for (const decl of header) {
    const same = t.isImportDeclaration(decl) ? merged.find((m): m is t.ImportDeclaration => t.isImportDeclaration(m) && m.source.value === decl.source.value && !m.specifiers.some((x) => t.isImportNamespaceSpecifier(x))) : undefined;
    if (same && t.isImportDeclaration(decl) && !decl.specifiers.some((x) => t.isImportNamespaceSpecifier(x) || t.isImportDefaultSpecifier(x))) {
      for (const spec of decl.specifiers) if (!same.specifiers.some((x) => x.local.name === spec.local.name)) same.specifiers.push(spec);
    } else merged.push(decl);
  }
  const code = print(t.file(t.program([...merged, ...script, ...keptUnits.map((u) => relocateLoads(t.cloneNode(u.statement, true), plan.path, piece.path)), ...body.map((s) => relocateLoads(s, plan.path, piece.path))])));
  const style = piece.vue!.style ? `\n<style scoped>\n${piece.vue!.style}\n</style>\n` : "";
  return `<script setup>\n${code}\n</script>\n\n${piece.vue!.template}${style}`;
}

function pruneTemplateHoists(plan: Plan): void {
  plan.remainder = prunedRemainder(plan);
}

function prunedRemainder(plan: Plan): t.Statement[] {
  const remainder = [...plan.remainder];
  if (!plan.pieces.some((p) => p.vue)) return remainder;
  const unitOf = new Map(plan.units.map((u) => [u.statement, u]));
  const candidates = remainder.filter((stmt) => {
    if (!t.isVariableDeclaration(stmt) || !stmt.declarations.every((d) => t.isIdentifier(d.id) && d.init && isPureValue(d.init))) return false;
    const unit = unitOf.get(stmt);
    return !(unit && (unit.exported.length || unit.isDefault)) && !stmt.declarations.some((d) => plan.remainderExports.has((d.id as t.Identifier).name));
  });
  if (!candidates.length) return remainder;
  const nonVue = plan.pieces.filter((p) => !p.vue).flatMap((p) => p.units.map((u) => u.statement));
  const external = nonVue.length ? usedNames(nonVue, plan.program) : new Set<string>();
  const refs = new Map<t.Statement, Set<string>>();
  for (const stmt of remainder) {
    const names = new Set<string>();
    t.traverseFast(stmt, (node) => {
      if (t.isIdentifier(node)) names.add(node.name);
    });
    refs.set(stmt, names);
  }
  const alive = new Set(remainder);
  for (let changed = true; changed; ) {
    changed = false;
    for (const stmt of candidates) {
      if (!alive.has(stmt)) continue;
      const names = (stmt as t.VariableDeclaration).declarations.map((d) => (d.id as t.Identifier).name);
      if (names.some((n) => external.has(n))) continue;
      if ([...alive].some((other) => other !== stmt && names.some((n) => refs.get(other)!.has(n)))) continue;
      alive.delete(stmt);
      changed = true;
    }
  }
  return remainder.filter((s) => alive.has(s));
}

function remainderCode(plan: Plan, barrel: boolean): string | null {
  pruneTemplateHoists(plan);
  const used = usedNames(plan.remainder, plan.program);
  const header: t.Statement[] = [];
  for (const decl of plan.keepImports) {
    if (!decl.specifiers.length) {
      const target = resolveSpecifier(plan.path, decl.source.value);
      header.push(t.importDeclaration([], t.stringLiteral(target ? relativeImport(plan.outPath, target) : decl.source.value)));
      continue;
    }
    const next = reimport(decl, plan.path, plan.outPath, (local) => used.has(local));
    if (next) header.push(next);
  }
  const fromPieces = new Map<string, string[]>();
  for (const name of used) {
    const piece = plan.pieceOf.get(name);
    if (piece) fromPieces.set(piece.path, [...(fromPieces.get(piece.path) ?? []), name]);
  }
  for (const [path, names] of fromPieces) header.push(importFrom(plan, path, names, plan.outPath));
  const unitByStatement = new Map(plan.units.map((u) => [u.statement, u]));
  const body: t.Statement[] = [];
  for (const original of plan.remainder) {
    const stmt = relocateLoads(t.cloneNode(original, true), plan.path, plan.outPath);
    const unit = unitByStatement.get(original);
    if (!unit) {
      body.push(stmt);
      continue;
    }
    const declarable = t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt) || t.isVariableDeclaration(stmt);
    if (unit.isDefault && (t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt))) body.push(t.exportDefaultDeclaration(stmt));
    else if (unit.exported.includes(unit.name) && declarable) body.push(t.exportNamedDeclaration(stmt));
    else body.push(stmt);
    if (unit.isDefault && !t.isFunctionDeclaration(stmt) && !t.isClassDeclaration(stmt)) body.push(t.exportDefaultDeclaration(t.identifier(unit.name)));
    const aliases = unit.exported.filter((e) => e !== unit.name || !declarable);
    if (aliases.length) body.push(t.exportNamedDeclaration(null, aliases.map((a) => t.exportSpecifier(t.identifier(unit.name), t.identifier(a)))));
  }
  const exportLines: t.Statement[] = [];
  const alreadyExported = new Set<string>();
  for (const stmt of body) {
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration) collectDeclared(stmt.declaration, alreadyExported);
    if (t.isExportNamedDeclaration(stmt) && !stmt.source) for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec) && (t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value) === spec.local.name) alreadyExported.add(spec.local.name);
  }
  const forPieces = [...plan.remainderExports].filter((n) => !alreadyExported.has(n));
  if (forPieces.length) exportLines.push(t.exportNamedDeclaration(null, forPieces.map((n) => t.exportSpecifier(t.identifier(n), t.identifier(n)))));
  if (barrel) {
    const byPath = new Map<string, t.ExportSpecifier[]>();
    for (const [exported, target] of plan.exportsTo) {
      byPath.set(target.path, [...(byPath.get(target.path) ?? []), t.exportSpecifier(t.identifier(target.name), t.identifier(exported))]);
    }
    for (const [path, specs] of byPath) exportLines.push(t.exportNamedDeclaration(null, specs, t.stringLiteral(relativeImport(plan.outPath, path))));
  }
  const meaningful = body.length || exportLines.length || header.some((h) => t.isImportDeclaration(h) && !h.specifiers.length);
  if (!meaningful) return null;
  return print(t.file(t.program(uniqueExports([...header, ...body, ...exportLines]))));
}

function uniqueExports(statements: t.Statement[]): t.Statement[] {
  const seen = new Set<string>();
  for (const stmt of statements) if (t.isExportNamedDeclaration(stmt) && stmt.declaration) collectDeclared(stmt.declaration, seen);
  return statements.filter((stmt) => {
    if (!t.isExportNamedDeclaration(stmt) || stmt.declaration) return true;
    stmt.specifiers = stmt.specifiers.filter((spec) => {
      const name = t.isExportSpecifier(spec) ? (t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value) : null;
      if (name === null) return true;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    return stmt.specifiers.length > 0;
  });
}

function destructuredImport(path: NodePath<t.CallExpression>): string[] | null {
  if (path.parentPath?.isArrowFunctionExpression() && path.parentPath.node.body === path.node && !path.parentPath.parentPath?.isCallExpression({ callee: { type: "MemberExpression" } } as never)) return ["default"];
  const awaited = path.parentPath;
  const declarator = awaited?.isAwaitExpression() ? awaited.parentPath : null;
  if (!declarator?.isVariableDeclarator() || !t.isObjectPattern(declarator.node.id)) return null;
  const names: string[] = [];
  for (const prop of declarator.node.id.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) return null;
    const key = literalKey(prop.key);
    if (!key) return null;
    names.push(key);
  }
  return names;
}

function dynamicTarget(plan: Plan, names: string[] | null): string | null {
  if (!names?.length) return null;
  const paths = new Set(names.map((n) => plan.exportsTo.get(n)?.path ?? null));
  return paths.size === 1 && !paths.has(null) ? [...paths][0]! : null;
}

function needsBarrel(files: OutputFile[], plan: Plan): boolean {
  if (!plan.pieces.length) return false;
  const target = plan.path;
  for (const file of files) {
    if (file.path === target || !file.content.includes(posix.basename(target))) continue;
    let ast: t.File;
    try {
      ast = parseProgram(file.content);
    } catch {
      continue;
    }
    let found = false;
    traverse(ast, {
      ImportDeclaration(path) {
        if (resolveSpecifier(file.path, path.node.source.value) === target && path.node.specifiers.some((s) => t.isImportNamespaceSpecifier(s))) found = true;
      },
      ExportAllDeclaration(path) {
        if (resolveSpecifier(file.path, path.node.source.value) === target) found = true;
      },
      CallExpression(path) {
        const { callee, arguments: args } = path.node;
        if (!(t.isImport(callee) || t.isIdentifier(callee, { name: "require" })) || !t.isStringLiteral(args[0]) || resolveSpecifier(file.path, args[0].value) !== target) return;
        if (t.isImport(callee) && dynamicTarget(plan, destructuredImport(path))) return;
        found = true;
      },
    });
    if (found) return true;
  }
  return false;
}

function soleTarget(plan: Plan): string | null {
  if (prunedRemainder(plan).length || !plan.exportsTo.size) return null;
  const paths = new Set([...plan.exportsTo.values()].map((to) => to.path));
  if (paths.size !== 1 || [...plan.exportsTo].some(([exported, to]) => to.name !== exported)) return null;
  return [...paths][0]!;
}

function redirectFile(file: OutputFile, plans: Map<string, Plan>, dropped: Set<string>, forwarded: Map<string, string>): string | null {
  if (!file.path.endsWith(".vue")) return redirectImports(file, plans, dropped, forwarded);
  const script = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/.exec(file.content);
  if (!script) return null;
  const outside = `${file.content.slice(0, script.index)}${file.content.slice(script.index + script[0].length)}`;
  const next = redirectImports({ path: file.path, content: script[2]! }, plans, dropped, forwarded, (name) => new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}($|[^\\w$])`).test(outside));
  if (next === null) return null;
  return `${file.content.slice(0, script.index)}${script[1]}\n${next.trim()}\n${script[3]}${file.content.slice(script.index + script[0].length)}`;
}

function redirectImports(file: Pick<OutputFile, "path" | "content">, plans: Map<string, Plan>, dropped: Set<string>, forwarded: Map<string, string>, frozen: (name: string) => boolean = () => false): string | null {
  if (![...plans.keys()].some((p) => file.content.includes(posix.basename(p)))) return null;
  let ast: t.File;
  try {
    ast = parseProgram(file.content);
  } catch (err) {
    return null;
  }
  let changed = false;
  const renames = new Map<string, string>();
  const namespaceRenames = new Map<string, Plan>();
  const body = ast.program.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i]!;
    const isImport = t.isImportDeclaration(stmt);
    const isReexport = t.isExportNamedDeclaration(stmt) && !!stmt.source;
    if (!isImport && !isReexport) continue;
    const source = (stmt as t.ImportDeclaration | t.ExportNamedDeclaration).source!;
    const target = resolveSpecifier(file.path, source.value);
    const plan = target ? plans.get(target) : undefined;
    if (!plan) continue;
    const forward = forwarded.get(plan.path);
    if (forward && isImport && (stmt as t.ImportDeclaration).specifiers.some((x) => t.isImportNamespaceSpecifier(x))) {
      (stmt as t.ImportDeclaration).source = t.stringLiteral(relativeImport(file.path, forward));
      for (const spec of (stmt as t.ImportDeclaration).specifiers) if (t.isImportNamespaceSpecifier(spec)) namespaceRenames.set(spec.local.name, plan);
      changed = true;
      continue;
    }
    const groups = new Map<string, t.Node[]>();
    const packages = new Map<string, t.Node[]>();
    const keep: t.Node[] = [];
    const specs: t.Node[] = isImport ? (stmt as t.ImportDeclaration).specifiers : (stmt as t.ExportNamedDeclaration).specifiers;
    const home = plan.outPath !== plan.path ? t.stringLiteral(relativeImport(file.path, plan.outPath)) : source;
    if (isImport && !specs.length) {
      if (plan.outPath !== plan.path) {
        (stmt as t.ImportDeclaration).source = home;
        changed = true;
      } else if (dropped.has(plan.path)) {
        body.splice(i, 1);
        changed = true;
      }
      continue;
    }
    for (const spec of specs) {
      let name: string | null = null;
      if (t.isImportSpecifier(spec)) name = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
      else if (t.isImportDefaultSpecifier(spec)) name = "default";
      else if (t.isExportSpecifier(spec)) name = spec.local.name;
      const to = name ? plan.exportsTo.get(name) : undefined;
      const pkg = !to && name && plan.vendorPackage && t.isImportSpecifier(spec) ? plan.bare.get(name) : undefined;
      if (pkg) packages.set(pkg, [...(packages.get(pkg) ?? []), spec]);
      else if (!to) keep.push(spec);
      else groups.set(to.path, [...(groups.get(to.path) ?? []), spec]);
    }
    if (!groups.size && !packages.size && home === source) continue;
    const replacement: t.Statement[] = [];
    for (const [pkg, list] of packages) replacement.push(t.importDeclaration(list as t.ImportSpecifier[], t.stringLiteral(pkg)));
    for (const [path, list] of groups) {
      const src = t.stringLiteral(relativeImport(file.path, path));
      for (let k = 0; k < list.length; k++) {
        const spec = list[k]!;
        const name = t.isImportSpecifier(spec) ? (t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value) : t.isExportSpecifier(spec) ? spec.local.name : null;
        const target = name ? plan.exportsTo.get(name)?.name : undefined;
        if (name && target && target !== "default" && target !== name) {
          if (t.isImportSpecifier(spec)) {
            spec.imported = t.identifier(target);
            if ((spec.local.name === name || (isMangled(spec.local.name) && isValidName(target))) && !frozen(spec.local.name)) renames.set(spec.local.name, target);
          } else if (t.isExportSpecifier(spec)) spec.local = t.identifier(target);
          continue;
        }
        if (!name || target !== "default" || name === "default") continue;
        if (t.isImportSpecifier(spec)) list[k] = t.importDefaultSpecifier(t.identifier(spec.local.name));
        else if (t.isExportSpecifier(spec)) list[k] = t.exportSpecifier(t.identifier("default"), spec.exported);
      }
      replacement.push(isImport ? t.importDeclaration(list as t.ImportDeclaration["specifiers"], src) : t.exportNamedDeclaration(null, list as t.ExportSpecifier[], src));
    }
    if (keep.length) replacement.push(isImport ? t.importDeclaration(keep as t.ImportDeclaration["specifiers"], home) : t.exportNamedDeclaration(null, keep as t.ExportSpecifier[], home));
    body.splice(i, 1, ...replacement);
    changed = true;
  }
  if (renames.size) {
    let program: NodePath<t.Program>;
    try {
      program = programPath(ast);
    } catch {
      return null;
    }
    for (const [from, to] of renames) {
      const binding = program.scope.getBinding(from);
      if (!binding || program.scope.getBinding(to) || [...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.getBinding(to))) {
        for (const stmt of ast.program.body) {
          if (!t.isImportDeclaration(stmt)) continue;
          for (const spec of stmt.specifiers) if (t.isImportSpecifier(spec) && spec.local.name === from && t.isIdentifier(spec.imported, { name: to })) spec.local = t.identifier(from);
        }
        continue;
      }
      program.scope.rename(from, to);
    }
  }
  traverse(ast, {
    ExportAllDeclaration(path) {
      const target = resolveSpecifier(file.path, path.node.source.value);
      const forward = target ? forwarded.get(target) : undefined;
      if (!forward) return;
      path.node.source = t.stringLiteral(relativeImport(file.path, forward));
      changed = true;
    },
    MemberExpression(path) {
      const object = path.node.object;
      const plan = t.isIdentifier(object) ? namespaceRenames.get(object.name) : undefined;
      if (!plan || path.node.computed || path.scope.getBinding((object as t.Identifier).name)?.kind !== "module") return;
      const key = literalKey(path.node.property);
      const next = key ? plan.exportsTo.get(key)?.name : undefined;
      if (!next || next === key || next === "default") return;
      path.node.property = t.identifier(next);
      changed = true;
    },
    CallExpression(path) {
      const arg = path.node.arguments[0];
      const loader = t.isImport(path.node.callee) || t.isIdentifier(path.node.callee, { name: "require" });
      if (!loader || !t.isStringLiteral(arg)) return;
      const target = resolveSpecifier(file.path, arg.value);
      const plan = target ? plans.get(target) : undefined;
      const forward = plan ? forwarded.get(plan.path) : undefined;
      const whole = plan && !plan.pieces.length && plan.outPath !== plan.path ? plan.outPath : null;
      const to = plan ? (forward ?? (t.isImport(path.node.callee) ? dynamicTarget(plan, destructuredImport(path)) : null) ?? whole) : null;
      if (!to) return;
      arg.value = relativeImport(file.path, to);
      changed = true;
      if (!forward || !plan) return;
      const declarator = path.parentPath?.isAwaitExpression() ? path.parentPath.parentPath : null;
      if (!declarator?.isVariableDeclarator() || !t.isObjectPattern(declarator.node.id)) return;
      for (const prop of declarator.node.id.properties) {
        if (!t.isObjectProperty(prop) || prop.computed) continue;
        const key = literalKey(prop.key);
        const next = key ? plan.exportsTo.get(key)?.name : undefined;
        if (!next || next === key || next === "default") continue;
        const value = prop.value;
        prop.key = t.identifier(next);
        prop.value = value;
        prop.shorthand = t.isIdentifier(value) && value.name === next;
      }
    },
  });
  if (changed) mergeImports(ast);
  return changed ? print(ast) : null;
}

export function organizeModules(tree: OutputTree, modules: Manifest["modules"], pages: Set<string>, libraryFunctions: Map<string, string> = new Map(), components: ReadonlyMap<string, LibraryComponent> = new Map(), routeFiles: ReadonlyMap<string, string> = new Map(), autoImports = false, bareFunctions: ReadonlyMap<string, string> = new Map(), namespaces: ReadonlyMap<string, string> = new Map(), stringOwner?: (value: string) => string | null): OrganizeResult {
  const result: OrganizeResult = { files: 0, split: 0, moved: new Map(), packageRoles: new Map() };
  const all = tree.all();
  const appPaths = new Set(modules.filter((m) => m.group === "app" && m.localPath).map((m) => m.localPath!));
  const candidates = all.filter((f) => f.kind === "module" && !f.library && appPaths.has(f.path) && !f.path.includes("/_missing/") && !f.path.startsWith(`${DIRS.libraries}/`));
  const used = new Map<Folder, Set<string>>(FOLDERS.map((f) => [f, new Set<string>()]));
  const plans = new Map<string, Plan>();
  const parsed = new Map<string, { ast: t.File; program: NodePath<t.Program> }>();
  const exported = new Map<string, Map<string, string>>();
  for (const file of candidates) {
    try {
      const ast = parseProgram(file.content);
      const program = programPath(ast);
      mergeNamedAssign(program);
      freeSetupKeys(program);
      parsed.set(file.path, { ast, program });
      exported.set(file.path, exportedComponentNames(program));
    } catch {
      continue;
    }
  }
  const byPath = new Map(all.map((f) => [f.path, f]));
  const appImports = new Map<string, Map<string, string[]>>();
  for (const file of all) {
    if (file.library || (file.kind !== "module" && file.kind !== "script") || !/\.(m?jsx?|vue)$/.test(file.path) || file.path.startsWith(`${DIRS.libraries}/`)) continue;
    for (const match of file.content.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
      const target = resolveSpecifier(file.path, match[2]!);
      if (!target || target === file.path) continue;
      const names = appImports.get(target) ?? new Map<string, string[]>();
      for (const part of match[1]!.split(",")) {
        const imported = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (imported) names.set(imported, [...(names.get(imported) ?? []), file.path]);
      }
      appImports.set(target, names);
    }
  }
  const foreign = (from: string, source: string, imported: string) => {
    const target = resolveSpecifier(from, source);
    if (!target) return null;
    if (!exported.has(target)) {
      const file = byPath.get(target);
      let names = new Map<string, string>();
      if (file && (file.kind === "module" || file.kind === "script") && /\.m?jsx?$/.test(file.path)) {
        try {
          const program = programPath(parseProgram(file.content));
          mergeNamedAssign(program);
          names = exportedComponentNames(program);
        } catch {
          names = new Map();
        }
      }
      exported.set(target, names);
    }
    return exported.get(target)!.get(imported) ?? null;
  };
  for (const file of candidates) {
    const entry = parsed.get(file.path);
    if (!entry) continue;
    try {
      const found = plan(file, entry.program, entry.ast, pages.has(file.path), used, libraryFunctions, components, foreign, routeFiles.get(file.path), autoImports, bareFunctions, appImports.get(file.path), stringOwner);
      if (found) for (const u of found.units) if (namespaces.has(u.name)) found.namespaces.set(u.name, namespaces.get(u.name)!);
      if (found) plans.set(file.path, found);
      if (found) {
        for (const decl of found.keepImports) {
          if (/^[./]/.test(decl.source.value)) continue;
          for (const spec of decl.specifiers) {
            const role = found.roles.get(spec.local.name) ?? (isVueApi(spec.local.name) ? spec.local.name : undefined);
            if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported) || !role || !isVueApi(role) || spec.imported.name === role) continue;
            const table = result.packageRoles.get(decl.source.value) ?? new Map<string, Set<string>>();
            table.set(spec.imported.name, (table.get(spec.imported.name) ?? new Set()).add(role));
            result.packageRoles.set(decl.source.value, table);
          }
        }
      }
    } catch (err) {
      continue;
    }
  }
  if (!plans.size) return result;

  const dropped = new Set<string>();
  const outputs: Array<{ path: string; content: string; jsx: boolean }> = [];
  const scoped = attachScopedStyles(plans, all);
  for (const file of all) if (file.kind === "style" && scoped.size) file.content = removeScopedRules(file.content, scoped);
  const forwarded = new Map<string, string>();
  const barrels = new Set<string>();
  for (const plan of plans.values()) {
    if (!plan.pieces.length && plan.outPath !== plan.path) {
      forwarded.set(plan.path, plan.outPath);
      continue;
    }
    if (!needsBarrel(all, plan)) continue;
    const sole = soleTarget(plan);
    if (sole) forwarded.set(plan.path, sole);
    else barrels.add(plan.path);
  }
  const taken = new Set(all.map((f) => f.path));
  for (const plan of plans.values()) {
    if (plan.vendor || plan.route === undefined || !plan.pieces.some((p) => p.vue || p.folder === "pages") || barrels.has(plan.path) || !prunedRemainder(plan).some((st) => !t.isExportNamedDeclaration(st) || !!st.declaration)) continue;
    const words = posix.basename(plan.path).replace(/\.[jt]sx?$/, "").replace(/Page$/, "").match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
    const meaningful = words.filter((w) => !/^(Id|Slug|Index)$/.test(w));
    for (let size = 1; size <= meaningful.length; size++) {
      const base = meaningful.slice(-size).map((w, i) => (i ? w : w.toLowerCase())).join("");
      const candidate = posix.join(DIRS.js, "functions", `${base}.js`);
      if (!base || taken.has(candidate) || used.get("functions")!.has(base.toLowerCase())) continue;
      taken.add(candidate);
      used.get("functions")!.add(base.toLowerCase());
      plan.outPath = candidate;
      break;
    }
  }
  for (const plan of plans.values()) {
    if (!plan.vendor || barrels.has(plan.path)) continue;
    const base = plan.vendorPackage ? posix.join(DIRS.libraries, safeRelativeName(plan.vendor === plan.vendorPackage ? `${plan.vendor}/chunk` : plan.vendor)) : posix.join(DIRS.js, "vendor", safeRelativeName(plan.vendor));
    let candidate = `${base}.js`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}.js`;
    taken.add(candidate);
    plan.outPath = candidate;
  }
  for (const plan of plans.values()) {
    const parts: string[] = [];
    for (const piece of plan.pieces) {
      let content: string;
      try {
        content = pieceCode(piece, plan);
      } catch (err) {
        if (!piece.vue) throw err;
        const previous = piece.path;
        const host = piece.units.find((u) => u.name === piece.name)!;
        piece.vue = undefined;
        piece.path = previous.replace(/\.vue$/, ".js");
        for (const [exported, target] of plan.exportsTo) if (target.path === previous) plan.exportsTo.set(exported, { path: piece.path, name: exported === "default" || host.exported.includes(exported) ? exported : host.name });
        content = pieceCode(piece, plan);
      }
      outputs.push({ path: piece.path, content, jsx: piece.jsx });
      parts.push(piece.path);
    }
    const remainder = remainderCode(plan, barrels.has(plan.path));
    if (remainder === null) dropped.add(plan.path);
    else if (plan.outPath !== plan.path) {
      dropped.add(plan.path);
      outputs.push({ path: plan.outPath, content: remainder, jsx: false });
    } else plan.file.content = remainder;
    const primary = plan.exportsTo.get("default")?.path ?? (plan.pieces.length === 1 ? plan.pieces[0]!.path : remainder !== null ? plan.outPath : (plan.pieces[0]?.path ?? null));
    result.moved.set(plan.path, { primary, parts: remainder !== null ? [plan.outPath, ...parts] : parts, exports: Object.fromEntries([...plan.exportsTo].map(([k, v]) => [k, v.path])) });
    result.split++;
    result.files += plan.pieces.length;
  }
  for (const path of dropped) tree.remove(path);
  for (const out of outputs) {
    const vendor = [...plans.values()].some((p) => p.vendor !== null && p.outPath === out.path && p.outPath !== p.path);
    const stored = tree.add({ path: out.path, content: out.content, kind: "module", renamable: false, ...(vendor ? { library: true } : {}) });
    if (stored.path !== out.path) {
      for (const plan of plans.values()) {
        for (const piece of plan.pieces) if (piece.path === out.path) piece.path = stored.path;
        for (const target of plan.exportsTo.values()) if (target.path === out.path) target.path = stored.path;
      }
    }
  }
  for (const file of tree.all()) {
    if (file.kind !== "module" && file.kind !== "script") continue;
    const next = redirectFile(file, plans, dropped, forwarded);
    if (next !== null) file.content = next;
  }
  for (const out of outputs) {
    const file = tree.all().find((f) => f.path === out.path);
    if (!file || file.path.endsWith(".vue")) continue;
    try {
      file.content = packageNamespaceCode(reactNamespaceCode(file.content));
      if (/static\s+ɵ(cmp|pipe|prov)\b/.test(file.content)) file.content = angularSourceCode(file.content) ?? file.content;
    } catch {
      continue;
    }
  }
  return result;
}
