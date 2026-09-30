import type { NodePath } from "@babel/traverse";
import { literalKey, parseForFile, parseProgram, t, traverse } from "../unpack/ast.ts";
import type { ModuleHint } from "../types.ts";
import { camel, capitalize, moduleIdFromSpecifier } from "./rename.ts";
import { semanticConstantName, semanticFunctionName } from "./semantic.ts";

export interface NamedModule {
  id: string;
  code: string;
}

const NAMESPACE_TO_FILE: Record<string, string> = {
  React: "react",
  ReactDOM: "react-dom",
  jsxRuntime: "jsx-runtime",
};

const GENERIC = new Set(["default", "Component", "module", "exports", "__esModule"]);

function exportedNames(ast: t.File): string[] {
  const names: string[] = [];
  for (const stmt of ast.program.body) {
    if (t.isExportNamedDeclaration(stmt)) {
      const decl = stmt.declaration;
      if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) names.push(decl.id.name);
      else if (t.isVariableDeclaration(decl)) {
        for (const d of decl.declarations) if (t.isIdentifier(d.id)) names.push(d.id.name);
      }
      for (const spec of stmt.specifiers) {
        if (t.isExportSpecifier(spec)) names.push(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value);
      }
    } else if (t.isExportDefaultDeclaration(stmt)) {
      const decl = stmt.declaration;
      if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) names.unshift(decl.id.name);
    }
  }
  return names.filter((n) => n.length > 2 && !GENERIC.has(n));
}

function hasJsx(ast: t.File): boolean {
  let found = false;
  t.traverseFast(ast, (node) => {
    if (!found && (t.isJSXElement(node) || t.isJSXFragment(node))) found = true;
  });
  return found;
}

function isFunctionValue(node: t.Node | null | undefined): boolean {
  return t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node) || t.isClassDeclaration(node);
}

function contentName(ast: t.File): string | null {
  let functions = 0;
  let values = 0;
  let defaultJsx = false;
  const jsx = hasJsx(ast);
  for (const stmt of ast.program.body) {
    if (t.isExportDefaultDeclaration(stmt)) {
      if (isFunctionValue(stmt.declaration) && jsx) defaultJsx = true;
      if (isFunctionValue(stmt.declaration)) functions++;
      else values++;
    } else if (t.isExportNamedDeclaration(stmt)) {
      const decl = stmt.declaration;
      if (isFunctionValue(decl)) functions++;
      else if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) isFunctionValue(d.init) ? functions++ : values++;
      else values += stmt.specifiers.length;
    }
  }
  if (defaultJsx) return "Component";
  if (functions && !values && !jsx) return "utils";
  if (values && !functions) return "constants";
  return null;
}

export const UTILITY_CLASS = /[:[\]\/]|^-|^(flex|grid|block|inline|hidden|contents|table|flow|relative|absolute|fixed|sticky|static|container|group|peer|sr-only|truncate|underline|italic|antialiased|visible|invisible|isolate|transform|transition|shadow|rounded|border|outline|ring|blur|filter|resize|select|cursor|pointer|overflow|object|aspect|columns|break|box|float|clear|z|order|col|row|gap|space|divide|place|justify|content|items|self|basis|grow|shrink|p[xytrbl]?|m[xytrbl]?|w|h|min|max|size|text|font|leading|tracking|align|whitespace|bg|from|via|to|fill|stroke|opacity|mix|inset|top|right|bottom|left|translate|rotate|scale|skew|origin|duration|ease|delay|animate|list|decoration|indent|line|sm|md|lg|xl|dark)(-|$)/;

const SEMANTIC_TAGS: Record<string, string> = {
  nav: "Nav",
  header: "Header",
  footer: "Footer",
  aside: "Sidebar",
  form: "Form",
  dialog: "Dialog",
  table: "Table",
  article: "Article",
  menu: "Menu",
};

function classToken(value: t.Node | null | undefined): string | null {
  if (!t.isStringLiteral(value)) return null;
  const token = value.value.trim().split(/\s+/).find((c) => c && !UTILITY_CLASS.test(c));
  return token && /^[a-z][a-z0-9_-]{2,}$/i.test(token) ? token : null;
}

function returnedJsx(fn: t.Function): t.JSXElement | null {
  const pick = (node: t.Node | null | undefined): t.JSXElement | null => {
    if (t.isJSXElement(node)) return node;
    if (t.isConditionalExpression(node)) return pick(node.consequent) ?? pick(node.alternate);
    if (t.isLogicalExpression(node)) return pick(node.right);
    if (t.isParenthesizedExpression(node)) return pick(node.expression);
    return null;
  };
  if (t.isExpression(fn.body)) return pick(fn.body);
  for (const stmt of fn.body.body) if (t.isReturnStatement(stmt)) return pick(stmt.argument);
  return null;
}

function rootSignals(ast: t.File): { rootClass: string | null; rootTag: string | null; descendantClass: string | null } {
  let rootClass: string | null = null;
  let rootTag: string | null = null;
  let descendantClass: string | null = null;
  for (const stmt of ast.program.body) {
    if (!t.isExportDefaultDeclaration(stmt) || !t.isFunctionDeclaration(stmt.declaration)) continue;
    const root = returnedJsx(stmt.declaration);
    if (root && t.isJSXIdentifier(root.openingElement.name)) {
      const tag = root.openingElement.name.name;
      rootTag = SEMANTIC_TAGS[tag] ?? null;
      for (const attr of root.openingElement.attributes) {
        if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name: "className" })) rootClass = classToken(attr.value);
      }
    }
    t.traverseFast(stmt.declaration.body, (node) => {
      if (descendantClass) return;
      if (t.isJSXOpeningElement(node)) {
        for (const attr of node.attributes) if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name: "className" })) descendantClass ??= classToken(attr.value);
      } else if (t.isObjectProperty(node) && !node.computed && t.isIdentifier(node.key, { name: "className" })) descendantClass ??= classToken(node.value);
    });
  }
  return { rootClass, rootTag, descendantClass };
}

function pascalFromClass(token: string): string {
  return token
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

export function suggestModuleNames(
  modules: NamedModule[],
  hints: ModuleHint[] = [],
  used = new Set<string>(),
  resolveId: (id: string) => string = (id) => id,
): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  const vote = (id: string, name: string, weight: number) => {
    if (!name) return;
    let table = votes.get(id);
    if (!table) votes.set(id, (table = new Map()));
    table.set(name, (table.get(name) ?? 0) + weight);
  };

  const strongest = new Map<string, ModuleHint>();
  for (const hint of hints) {
    const key = `${hint.id}\u0000${hint.name}`;
    if ((strongest.get(key)?.weight ?? -1) < hint.weight) strongest.set(key, hint);
  }
  for (const hint of strongest.values()) vote(hint.id, hint.name, hint.weight);

  for (const mod of modules) {
    let ast: t.File;
    try {
      ast = parseProgram(mod.code);
    } catch {
      continue;
    }
    const exports = exportedNames(ast);
    const signals = rootSignals(ast);
    if (signals.rootClass) vote(mod.id, pascalFromClass(signals.rootClass), 8);
    else if (signals.rootTag) vote(mod.id, signals.rootTag, 7);
    else if (signals.descendantClass) vote(mod.id, pascalFromClass(signals.descendantClass), 2);
    if (exports.length) vote(mod.id, exports[0]!, 5);
    else {
      const fallback = contentName(ast);
      if (fallback) vote(mod.id, fallback, 1);
    }

    for (const stmt of ast.program.body) {
      if (!t.isImportDeclaration(stmt)) continue;
      const raw = moduleIdFromSpecifier(stmt.source.value);
      if (!raw) continue;
      const target = resolveId(raw);
      for (const spec of stmt.specifiers) {
        const local = spec.local.name;
        if (NAMESPACE_TO_FILE[local]) vote(target, NAMESPACE_TO_FILE[local]!, 8);
        else if (t.isImportDefaultSpecifier(spec) && local.length > 2) vote(target, local, 3);
      }
    }
  }

  const names = new Map<string, string>();
  for (const mod of modules) {
    const table = votes.get(mod.id);
    let best: string | null = null;
    let weight = 0;
    for (const [name, w] of table ?? []) if (w > weight) [best, weight] = [name, w];
    const base = best ? best.replace(/[^\w-]/g, "_") : `module-${mod.id}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    used.add(name.toLowerCase());
    names.set(mod.id, name);
  }
  return names;
}

export type StringKind = "url" | "endpoint" | "path" | "email" | "text";

export interface StringEntry {
  value: string;
  kind: StringKind;
  count: number;
  locations: string[];
}

export interface StringsIndex {
  total: number;
  endpoints: string[];
  urls: string[];
  strings: StringEntry[];
}

const MIN_LENGTH = 2;
const MAX_LOCATIONS = 20;

export function classifyString(value: string): StringKind {
  if (/^(https?:|wss?:)?\/\/[\w.-]+/i.test(value)) return "url";
  if (/^\/(api|graphql|v\d+|rest|rpc|trpc|auth|oauth)(\/|$|\?)/i.test(value) || /\/api\//i.test(value)) return "endpoint";
  if (/^\/[\w\-.~%@:[\]]+(\/[\w\-.~%@:[\]]*)*(\?.*)?$/.test(value)) return "path";
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(value)) return "email";
  return "text";
}

export class StringCollector {
  private readonly entries = new Map<string, StringEntry>();

  addCode(file: string, code: string): void {
    let ast: t.File;
    try {
      ast = parseForFile(file, code);
    } catch {
      return;
    }
    t.traverseFast(ast, (node) => {
      if (t.isStringLiteral(node)) this.add(node.value, file, node.loc?.start.line);
      else if (t.isTemplateLiteral(node)) {
        for (const quasi of node.quasis) this.add(quasi.value.cooked ?? quasi.value.raw, file, quasi.loc?.start.line);
      } else if (t.isJSXText(node)) this.add(node.value.trim(), file, node.loc?.start.line);
      else if (t.isDirectiveLiteral(node)) return;
    });
  }

  private add(value: string, file: string, line: number | undefined): void {
    if (value.length < MIN_LENGTH || !/\S/.test(value)) return;
    let entry = this.entries.get(value);
    if (!entry) this.entries.set(value, (entry = { value, kind: classifyString(value), count: 0, locations: [] }));
    entry.count++;
    const location = line ? `${file}:${line}` : file;
    if (entry.locations.length < MAX_LOCATIONS && !entry.locations.includes(location)) entry.locations.push(location);
  }

  build(): StringsIndex {
    const strings = [...this.entries.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return {
      total: strings.length,
      endpoints: strings.filter((s) => s.kind === "endpoint").map((s) => s.value),
      urls: strings.filter((s) => s.kind === "url").map((s) => s.value),
      strings,
    };
  }
}

function isDataNode(node: t.Node | null | undefined): boolean {
  if (!node) return true;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return true;
  if (t.isTemplateLiteral(node)) return node.expressions.length === 0;
  if (t.isUnaryExpression(node, { operator: "-" })) return t.isNumericLiteral(node.argument);
  if (t.isArrayExpression(node)) return node.elements.every((e) => isDataNode(e));
  if (t.isObjectExpression(node)) return node.properties.every((p) => t.isObjectProperty(p) && !p.computed && isDataNode(p.value));
  return false;
}

const FRAMEWORK_SCRIPTS = [
  /^\s*(?:\$R[A-Z]\s*=|requestAnimationFrame\(\s*function\s*\(\)\s*\{\s*\$RT\s*=)/,
  /^\s*window\.__(?:reactRouter|remix)Context\s*=/,
  /^\s*window\.__(?:reactRouter|remix)Context\.streamController\.(?:enqueue|close)\(/,
  /window\.__(?:reactRouter|remix)RouteModules\s*=/,
  /\bself\.Astro\b|["']astro-island["']|["']astro:(?:load|idle|visible|media|only)["']/,
  /reactrouter\.com\/start\/framework\/route-module#hydratefallback/,
  /["']nuxt-color-mode["'][\s\S]*data-color-mode-forced|data-color-mode-forced[\s\S]*["']nuxt-color-mode["']/,
  /^\s*document\.querySelectorAll\(["']link\[data-(?:beasties|critters)-media\]["']\)/,
];

export function isFrameworkScript(code: string): boolean {
  return FRAMEWORK_SCRIPTS.some((pattern) => pattern.test(code));
}

export function isDataOnlyScript(code: string): boolean {
  let ast: t.File;
  try {
    ast = parseProgram(code);
  } catch {
    return false;
  }
  const body = ast.program.body;
  if (!body.length) return false;
  return body.every((stmt) => {
    if (!t.isExpressionStatement(stmt)) return false;
    const expr = stmt.expression;
    if (t.isAssignmentExpression(expr)) return (t.isObjectExpression(expr.right) || t.isArrayExpression(expr.right)) && isDataNode(expr.right);
    return t.isCallExpression(expr) && expr.arguments.length > 0 && expr.arguments.every((a) => isDataNode(a));
  });
}

type Returned = "string" | "boolean" | "jsx" | "other";

function kindOf(node: t.Node | null | undefined): Returned {
  if (!node) return "other";
  if (t.isTemplateLiteral(node) || t.isStringLiteral(node)) return "string";
  if (t.isBinaryExpression(node, { operator: "+" }) && (kindOf(node.left) === "string" || kindOf(node.right) === "string")) return "string";
  if (t.isCallExpression(node)) {
    const callee = node.callee;
    const name = t.isMemberExpression(callee) && t.isIdentifier(callee.property) ? callee.property.name : t.isIdentifier(callee) ? callee.name : "";
    if (/^(toFixed|toLocaleString|toLocaleDateString|toLocaleTimeString|toString|join|padStart|toUpperCase|toLowerCase|String)$/.test(name)) return "string";
    if (t.isMemberExpression(callee) && /^(includes|has|startsWith|endsWith|test|some|every|contains|matches|isArray|isInteger|isFinite|isNaN)$/.test(name)) return "boolean";
  }
  if (t.isLogicalExpression(node) && node.operator !== "??" && kindOf(node.left) === "boolean" && kindOf(node.right) === "boolean") return "boolean";
  if (t.isBooleanLiteral(node) || t.isUnaryExpression(node, { operator: "!" })) return "boolean";
  if (t.isBinaryExpression(node) && /^(===|!==|==|!=|<|>|<=|>=|instanceof|in)$/.test(node.operator)) return "boolean";
  if (t.isJSXElement(node) || t.isJSXFragment(node)) return "jsx";
  if (t.isConditionalExpression(node)) {
    const a = kindOf(node.consequent);
    const b = kindOf(node.alternate);
    return a === b ? a : a === "other" ? b : b === "other" ? a : "other";
  }
  if (t.isLogicalExpression(node)) return kindOf(node.right);
  return "other";
}

function returnKind(fn: t.Function): Returned {
  if (t.isExpression(fn.body)) return kindOf(fn.body);
  const kinds = new Set<Returned>();
  t.traverseFast(fn.body, (node) => {
    if (t.isReturnStatement(node)) kinds.add(kindOf(node.argument));
  });
  if (kinds.size === 1) return [...kinds][0]!;
  kinds.delete("other");
  return kinds.size === 1 ? [...kinds][0]! : "other";
}

const PREFIX: Record<Exclude<Returned, "other">, string> = { string: "format", boolean: "is", jsx: "render" };

export function behaviorNames(code: string, mangled: string[], strict: Set<string> = new Set()): Map<string, string> {
  const out = new Map<string, string>();
  if (!mangled.length) return out;
  const ast = parseProgram(code);
  const wanted = new Set(mangled);
  traverse(ast, {
    Program(program) {
      for (const name of wanted) {
        const binding = program.scope.getBinding(name);
        const node = binding?.path.node;
        const fn = t.isFunctionDeclaration(node) ? node : t.isVariableDeclarator(node) && (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init)) ? node.init : null;
        if (!fn) continue;
        const semantic = semanticFunctionName(fn, (local) => {
          const bound = program.scope.getBinding(local)?.path.node;
          return t.isVariableDeclarator(bound) && t.isStringLiteral(bound.init) ? bound.init.value : null;
        });
        if (semantic) {
          if (!program.scope.hasBinding(semantic) && ![...out.values()].includes(semantic)) out.set(name, semantic);
          continue;
        }
        if (strict.has(name)) continue;
        const kind = returnKind(fn);
        if (kind === "other") continue;
        const param = fn.params.find((p) => t.isIdentifier(p) && p.name.length > 2) ?? fn.params[0];
        const subject = t.isIdentifier(param) && param.name.length > 2 ? capitalize(param.name) : "Value";
        const candidate = `${PREFIX[kind]}${subject}`;
        if (!program.scope.hasBinding(candidate) && ![...out.values()].includes(candidate)) out.set(name, candidate);
      }
      program.stop();
    },
  });
  return out;
}

export function constantNames(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const ast = parseProgram(code);
  traverse(ast, {
    Program(program) {
      for (const stmt of program.node.body) {
        const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
        if (!t.isVariableDeclaration(decl)) continue;
        for (const d of decl.declarations) {
          const strings = t.isArrayExpression(d.init) && d.init.elements.length > 0 && d.init.elements.every((e) => t.isStringLiteral(e));
          if (!t.isIdentifier(d.id) || d.id.name.length > 2 || !(t.isStringLiteral(d.init) || t.isNumericLiteral(d.init) || t.isRegExpLiteral(d.init) || strings)) continue;
          const binding = program.scope.getBinding(d.id.name);
          if (!binding || binding.constantViolations.length) continue;
          const usages = binding.referencePaths.map((ref) => {
            const parent = ref.parentPath;
            if (parent?.isBinaryExpression() && /^[<>]=?$/.test(parent.node.operator)) return parent.node;
            return parent?.isTemplateLiteral() || parent?.isCallExpression() || parent?.isNewExpression() ? parent.node : (parent?.parentPath?.node ?? parent?.node ?? ref.node);
          });
          const name = semanticConstantName(d.init, usages);
          if (!name || program.scope.hasBinding(name) || [...out.values()].includes(name)) continue;
          out.set(d.id.name, name);
        }
      }
      program.stop();
    },
  });
  return out;
}

function namedComponent(init: t.Node | null | undefined, program: NodePath<t.Program>): string | null {
  const fromObject = (node: t.Node | null | undefined): string | null => {
    const bound = t.isIdentifier(node) ? program.scope.getBinding(node.name)?.path.node : null;
    const object = t.isVariableDeclarator(bound) ? bound.init : node;
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
  return t.isObjectExpression(init) ? fromObject(init) : null;
}

function storeShape(call: t.CallExpression): boolean {
  if (call.arguments.length !== 2 || !t.isStringLiteral(call.arguments[0])) return false;
  const options = call.arguments[1];
  if (t.isObjectExpression(options)) return options.properties.some((p) => t.isObjectProperty(p) || t.isObjectMethod(p) ? /^(state|actions|getters)$/.test(literalKey(p.key) ?? "") : false);
  if (!t.isArrowFunctionExpression(options) && !t.isFunctionExpression(options)) return false;
  const body = options.body;
  const returned = t.isBlockStatement(body) ? body.body.findLast((st): st is t.ReturnStatement => t.isReturnStatement(st))?.argument : body;
  if (!t.isObjectExpression(returned) || returned.properties.length < 2) return false;
  return t.isBlockStatement(body) && body.body.some((st) => t.isVariableDeclaration(st) && st.declarations.some((d) => t.isCallExpression(d.init)));
}

export function factoryResultNames(code: string): Map<string, string> {
  const out = new Map<string, string>();
  traverse(parseProgram(code), {
    Program(program) {
      for (const [name, binding] of Object.entries(program.scope.bindings)) {
        if (!(name.length <= 2 || /^_*Component\d*$/.test(name))) continue;
        const node = binding.path.node;
        const component = t.isVariableDeclarator(node) && name.length <= 2 ? namedComponent(node.init, program) : null;
        if (component) {
          if (!program.scope.hasBinding(component) && ![...out.values()].includes(component)) out.set(name, component);
          continue;
        }
        if (!t.isVariableDeclarator(node) || !t.isCallExpression(node.init) || !t.isIdentifier(node.init.callee)) continue;
        const factory = node.init.callee.name;
        const arg = node.init.arguments[0];
        if ((factory === "defineStore" || storeShape(node.init)) && t.isStringLiteral(arg) && /^[A-Za-z][\w-]*$/.test(arg.value)) {
          const store = `use${capitalize(camel(arg.value))}Store`;
          if (!program.scope.hasBinding(store) && ![...out.values()].includes(store)) out.set(name, store);
          continue;
        }
        if (!/^create[A-Z]\w*$/.test(factory) || !t.isStringLiteral(arg) || !/^[A-Z][A-Za-z0-9]*$/.test(arg.value) || !arg.value.endsWith(factory.slice(6))) continue;
        if (!program.scope.hasBinding(arg.value) && ![...out.values()].includes(arg.value)) out.set(name, arg.value);
      }
      program.stop();
    },
  });
  return out;
}

const KEEP_SHORT_NAMES = new Set(["i", "j", "k", "x", "y", "z", "id", "el", "fn", "cb", "ok", "to", "on", "db", "io", "ui", "op", "$", "_"]);

export function mangledRatio(code: string, path: string): { total: number; mangled: number } {
  let ast: t.File;
  try {
    ast = parseForFile(path, code);
  } catch {
    return { total: 0, mangled: 0 };
  }
  let total = 0;
  let mangled = 0;
  traverse(ast, {
    Scope(scope) {
      for (const name of Object.keys(scope.scope.bindings)) {
        total++;
        if (name.length <= 2 && !KEEP_SHORT_NAMES.has(name)) mangled++;
      }
    },
  });
  return { total, mangled };
}

export function boilerplateCounts(code: string) {
  return {
    defineExports: (code.match(/Object\.defineProperty\(exports,/g) ?? []).length,
    exportsAssignments: (code.match(/(^|[^.\w$])exports\.[\w$]+\s*=/gm) ?? []).length,
    requireCalls: (code.match(/(^|[^.\w$])require\(/gm) ?? []).length,
    indirectCalls: (code.match(/\(0,\s*[\w$.]+\)\(/g) ?? []).length,
  };
}
