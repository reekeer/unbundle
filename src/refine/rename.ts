import type { Binding } from "@babel/traverse";
import { literalKey, parseProgram, print, renameBinding, t, traverse, type NodePath } from "../unpack/ast.ts";

export const KEEP_SHORT = new Set(["id", "el", "fn", "cb", "ok", "to", "on", "db", "io", "ui", "op", "$", "_", "React"]);
const LOOP_COUNTERS = new Set(["i", "j", "k"]);

export const CONSTRUCTOR_NAMES: Record<string, string> = {
  Map: "map",
  Set: "set",
  WeakMap: "weakMap",
  WeakSet: "weakSet",
  Error: "error",
  TypeError: "error",
  Date: "date",
  URL: "url",
  URLSearchParams: "searchParams",
  RegExp: "regex",
  Promise: "promise",
  AbortController: "controller",
  XMLHttpRequest: "xhr",
  FormData: "formData",
  Headers: "headers",
  Request: "request",
  Response: "response",
  TextEncoder: "encoder",
  TextDecoder: "decoder",
  Uint8Array: "bytes",
  ArrayBuffer: "buffer",
  Blob: "blob",
  Image: "image",
  Worker: "worker",
  WebSocket: "socket",
  EventSource: "eventSource",
  MutationObserver: "observer",
  IntersectionObserver: "observer",
  ResizeObserver: "observer",
  Proxy: "proxy",
  Function: "fn",
  Array: "array",
  Object: "object",
};

export const CALL_RESULT_NAMES: Record<string, string> = {
  fetch: "response",
  json: "data",
  text: "text",
  blob: "blob",
  arrayBuffer: "buffer",
  parse: "parsed",
  stringify: "json",
  keys: "keys",
  values: "values",
  entries: "entries",
  assign: "merged",
  split: "parts",
  join: "joined",
  trim: "trimmed",
  toLowerCase: "lower",
  toUpperCase: "upper",
  toString: "str",
  toFixed: "fixed",
  slice: "slice",
  substring: "substring",
  replace: "replaced",
  concat: "combined",
  filter: "filtered",
  map: "mapped",
  reduce: "result",
  find: "found",
  findIndex: "index",
  indexOf: "index",
  lastIndexOf: "index",
  includes: "included",
  some: "hasSome",
  every: "hasAll",
  from: "array",
  isArray: "isArray",
  max: "max",
  min: "min",
  floor: "floored",
  round: "rounded",
  ceil: "ceiled",
  abs: "absolute",
  random: "random",
  now: "now",
  setTimeout: "timeoutId",
  setInterval: "intervalId",
  requestAnimationFrame: "frameId",
  getBoundingClientRect: "rect",
  getComputedStyle: "style",
  createElement: "element",
  cloneElement: "element",
  querySelector: "element",
  getElementById: "element",
  closest: "element",
  querySelectorAll: "elements",
  getElementsByClassName: "elements",
  getElementsByTagName: "elements",
  getItem: "storedValue",
  match: "match",
  exec: "match",
  test: "matches",
  encodeURIComponent: "encoded",
  decodeURIComponent: "decoded",
  useRef: "ref",
  useMemo: "memoized",
  useCallback: "callback",
  useContext: "context",
  useId: "id",
  useRouter: "router",
  usePathname: "pathname",
  useSearchParams: "searchParams",
  useParams: "params",
  createContext: "Context",
  forwardRef: "Component",
  memo: "Component",
  lazy: "LazyComponent",
};

export const VERB_PREFIX = /^(get|fetch|create|load|read|find|compute|build|make|resolve|select|use|calc|calculate|parse)(?=[A-Z])/;

export const ITERATOR_METHODS = new Set(["map", "forEach", "filter", "find", "findIndex", "findLast", "some", "every", "flatMap", "findLastIndex"]);

export const RESERVED = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "eval", "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "package", "private", "protected", "public", "return", "static",
  "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "undefined",
  "NaN", "Infinity", "module", "exports", "require", "window", "document", "self", "globalThis",
]);

export function camel(words: string): string {
  const parts = words
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (!parts.length) return "";
  const joined = parts[0]! + parts.slice(1).map(capitalize).join("");
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

export function capitalize(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

export function lowerFirst(word: string): string {
  return word ? word[0]!.toLowerCase() + word.slice(1) : word;
}

export function singular(word: string): string | null {
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return null;
  if (/(ch|sh|x|s)es$/.test(word) && word.length > 4) return word.slice(0, -2);
  if (/s$/.test(word) && word.length > 3) return word.slice(0, -1);
  if (/(List|Array)$/.test(word)) return word.replace(/(List|Array)$/, "") || null;
  return null;
}

export function stripVerb(name: string): string {
  const stripped = name.replace(VERB_PREFIX, "");
  return stripped === name ? name : lowerFirst(stripped);
}

export class Votes {
  private readonly table = new Map<Binding, Map<string, number>>();
  readonly statePairs: Array<{ state: Binding; setter: Binding | null }> = [];

  add(binding: Binding | undefined | null, name: string | null | undefined, weight: number): void {
    if (!binding || !name) return;
    let names = this.table.get(binding);
    if (!names) this.table.set(binding, (names = new Map()));
    names.set(name, (names.get(name) ?? 0) + weight);
  }

  best(binding: Binding): { name: string; weight: number } | null {
    const names = this.table.get(binding);
    if (!names) return null;
    let top: { name: string; weight: number } | null = null;
    for (const [name, weight] of names) if (!top || weight > top.weight) top = { name, weight };
    return top;
  }

  bindings(): Binding[] {
    return [...this.table.keys()];
  }
}

export function calleeName(callee: t.Node): string | null {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) return callee.computed ? null : literalKey(callee.property);
  if (t.isSequenceExpression(callee)) return calleeName(callee.expressions.at(-1)!);
  return null;
}

export function moduleIdFromSpecifier(source: string): string | null {
  const match = /^\.\/(.+)\.js$/.exec(source);
  return match ? match[1]! : null;
}

export function moduleName(id: string): string {
  return /^\d+$/.test(id) ? `module${id}` : camel(id) || "module";
}

function firstStringArg(call: t.CallExpression | t.NewExpression): string | null {
  const arg = call.arguments[0];
  if (t.isStringLiteral(arg)) return arg.value;
  if (t.isTemplateLiteral(arg) && arg.quasis.length === 1) return arg.quasis[0]!.value.cooked ?? null;
  return null;
}

function fromSelector(selector: string): string {
  const cleaned = selector.replace(/^[#.]/, "").replace(/\[.*?\]/g, "");
  return camel(cleaned.split(/[\s>+~:]/).pop() ?? "");
}

export function nameFromExpression(node: t.Node | null | undefined): string | null {
  if (!node) return null;
  if (t.isAwaitExpression(node)) return nameFromExpression(node.argument);
  if (t.isParenthesizedExpression(node)) return nameFromExpression(node.expression);
  if (t.isLogicalExpression(node)) return nameFromExpression(node.left) ?? nameFromExpression(node.right);
  if (t.isConditionalExpression(node)) return nameFromExpression(node.consequent) ?? nameFromExpression(node.alternate);

  if (t.isNewExpression(node) && t.isIdentifier(node.callee)) {
    const ctor = node.callee.name;
    return CONSTRUCTOR_NAMES[ctor] ?? (ctor.length > 2 ? lowerFirst(ctor) : null);
  }

  if (t.isImport(node)) return null;
  if (t.isCallExpression(node)) {
    if (t.isImport(node.callee)) {
      const source = firstStringArg(node);
      const id = source ? moduleIdFromSpecifier(source) : null;
      return id ? moduleName(id) : "module";
    }
    const name = calleeName(node.callee);
    if (!name) return null;
    if (name === "require") {
      const source = firstStringArg(node);
      const id = source ? moduleIdFromSpecifier(source) : null;
      return id ? moduleName(id) : null;
    }
    const arg = firstStringArg(node);
    if (arg && /^(createElement|querySelector|getElementById|closest)$/.test(name)) {
      const base = name === "createElement" ? camel(arg) : fromSelector(arg);
      return base ? `${base}Element` : "element";
    }
    if (arg && name === "getItem") return camel(arg) || "storedValue";
    if (arg && name === "createContext") return null;
    const selector = node.arguments.length === 1 && !/^(map|filter|find|findLast|findIndex|some|every|forEach|reduce|flatMap|sort|then|catch|finally|call|apply|bind)$/.test(name) ? node.arguments[0] : null;
    if (t.isArrowFunctionExpression(selector) && selector.params.length === 1 && t.isIdentifier(selector.params[0]) && t.isMemberExpression(selector.body) && !selector.body.computed && t.isIdentifier(selector.body.object, { name: selector.params[0].name })) {
      const prop = literalKey(selector.body.property);
      if (prop && prop.length > 2) return prop;
    }
    if (name === "create" && t.isObjectExpression(node.arguments[0]) && node.arguments[0].properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "baseURL")) return "api";
    if (name === "lazy" || name === "defineAsyncComponent") {
      let target: string | null = null;
      t.traverseFast(node, (n) => {
        if (target || !t.isCallExpression(n) || !t.isImport(n.callee)) return;
        const source = firstStringArg(n);
        const stem = source ? /([^/]+?)(?:-[\w-]{8})?\.m?js$/.exec(source)?.[1] : undefined;
        if (stem && /^[A-Za-z]/.test(stem) && !/^\d+$/.test(stem)) target = capitalize(camel(stem));
      });
      if (target) return target;
    }
    const mapped = CALL_RESULT_NAMES[name];
    if (mapped) return mapped;
    if (name.length > 3 && VERB_PREFIX.test(name)) return stripVerb(name);
    const participle = /^(normalize|format|sanitize|encode|decode|serialize|merge|sort|filter|trim)([A-Z]\w*)$/.exec(name);
    if (participle) return `${PARTICIPLES[participle[1]!]}${participle[2]}`;
    return null;
  }

  if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed) {
    const prop = literalKey(node.property);
    if (prop && prop.length > 2 && prop !== "default" && prop !== "prototype") return lowerFirst(prop);
    return null;
  }

  if (t.isStringLiteral(node) && /^(https?:)?\/\//.test(node.value)) return "url";
  if (t.isArrayExpression(node) && node.elements.length === 0) return "list";
  if (t.isBinaryExpression(node) && /^(===|!==|==|!=|<|>|<=|>=|instanceof|in)$/.test(node.operator)) return null;
  return null;
}

export function containsJsx(node: t.Node): boolean {
  let found = false;
  t.traverseFast(node, (child) => {
    if (found) return;
    if (t.isJSXElement(child) || t.isJSXFragment(child)) found = true;
    else if (t.isCallExpression(child)) {
      const name = calleeName(child.callee);
      const documentCall = t.isMemberExpression(child.callee) && t.isIdentifier(child.callee.object) && /^(document|doc|ownerDocument)$/.test(child.callee.object.name);
      if (name === "jsx" || name === "jsxs" || name === "jsxDEV" || (name === "createElement" && !documentCall && !t.isStringLiteral(child.arguments[0], { value: "script" }))) found = true;
    }
  });
  return found;
}

export function jsxRoot(fn: t.Function): t.JSXElement | null {
  const pick = (node: t.Node | null | undefined): t.JSXElement | null => {
    if (t.isJSXElement(node)) return node;
    if (t.isJSXFragment(node)) return node.children.map((c) => pick(c)).find(Boolean) ?? null;
    if (t.isConditionalExpression(node)) return pick(node.consequent) ?? pick(node.alternate);
    if (t.isLogicalExpression(node)) return pick(node.right);
    if (t.isParenthesizedExpression(node)) return pick(node.expression);
    return null;
  };
  if (t.isExpression(fn.body)) return pick(fn.body);
  const returns: t.ReturnStatement[] = [];
  const walk = (node: t.Node) => {
    if (t.isReturnStatement(node)) returns.push(node);
    if (t.isFunction(node)) return;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) for (const c of child) if (c && typeof c === "object" && "type" in c) walk(c as t.Node);
      if (child && typeof child === "object" && "type" in child) walk(child as t.Node);
    }
  };
  for (const st of fn.body.body) walk(st);
  return returns.map((r) => pick(r.argument)).find(Boolean) ?? null;
}

function jsxTag(el: t.JSXElement): string | null {
  return t.isJSXIdentifier(el.openingElement.name) ? el.openingElement.name.name : null;
}

export function markupComponentName(fn: t.Function): string | null {
  const root = jsxRoot(fn);
  if (!root) return null;
  const param = fn.params[0];
  const props = new Map(t.isObjectPattern(param) ? param.properties.flatMap((p) => (t.isObjectProperty(p) && t.isIdentifier(p.value) ? [[p.value.name, literalKey(p.key)] as const] : [])) : []);
  const propsObject = t.isIdentifier(param) ? param.name : null;
  const isProp = (node: t.Node) => (t.isIdentifier(node) && props.has(node.name)) || (!!propsObject && t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.object, { name: propsObject }));
  const shown: t.JSXElement[] = [];
  t.traverseFast(root, (n) => {
    if (t.isJSXElement(n) && n.children.some((c) => t.isJSXExpressionContainer(c) && isProp(c.expression))) shown.push(n);
  });
  const heading = shown.find((el) => /^h[1-6]$/.test(jsxTag(el) ?? ""));
  if (!heading) return null;
  const wraps = shown.some((el) => el.children.some((c) => t.isJSXExpressionContainer(c) && ((t.isIdentifier(c.expression) && props.get(c.expression.name) === "children") || (t.isMemberExpression(c.expression) && t.isIdentifier(c.expression.property, { name: "children" })))));
  if (wraps) return "Section";
  return `${jsxTag(heading) === "h1" ? "Page" : "Section"}${shown.length > 1 ? "Header" : "Title"}`;
}

export const REACT_MEMBERS = /^(useState|useEffect|useLayoutEffect|useInsertionEffect|useRef|useMemo|useCallback|useContext|useReducer|useId|useTransition|useDeferredValue|useSyncExternalStore|useImperativeHandle|useDebugValue|useOptimistic|useActionState|use|createElement|Fragment|Component|PureComponent|memo|forwardRef|createContext|lazy|Suspense|StrictMode|Profiler|startTransition|Children|cloneElement|isValidElement|createRef|act|version)$/;
export const REACT_DOM_MEMBERS = /^(createPortal|flushSync|preload|preinit|preinitModule|preloadModule|prefetchDNS|preconnect|createRoot|hydrateRoot|render|hydrate|unmountComponentAtNode|findDOMNode|unstable_batchedUpdates|useFormStatus|requestFormReset|version|__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE)$/;
const JSX_RUNTIME_MEMBERS = /^(jsx|jsxs|jsxDEV|Fragment)$/;

const MEMBER_HINTS: Array<[RegExp, string, number]> = [
  [/^(preventDefault|stopPropagation|currentTarget|target|clientX|clientY|nativeEvent)$/, "event", 3],
  [/^(json|status|ok|headers|statusText)$/, "response", 2],
  [/^current$/, "ref", 3],
  [/^(trim|toLowerCase|toUpperCase|startsWith|endsWith|charAt|charCodeAt|padStart|padEnd|localeCompare)$/, "text", 1],
  [/^(push|forEach|filter|reduce|reduceRight|flatMap|splice|findIndex|every|some|map)$/, "items", 2],
  [/^then$/, "promise", 1],
  [/^(setAttribute|getAttribute|appendChild|classList|addEventListener|removeEventListener|querySelector|innerHTML|textContent)$/, "element", 2],
];

export function isMinified(name: string): boolean {
  return name.length <= 2 && !KEEP_SHORT.has(name);
}

export function isMinifiedBinding(binding: Binding): boolean {
  const name = binding.identifier.name;
  if (/^_Component\d*$/.test(name) && binding.kind !== "module") return true;
  if (LOOP_COUNTERS.has(name) && binding.path.parentPath?.parentPath?.isForStatement()) return false;
  if (binding.kind === "module" || binding.kind === "hoisted") return name.length <= 2 && name !== "$" && name !== "_";
  return isMinified(name);
}

export function readableName(node: t.Node | null | undefined): string | null {
  if (!node) return null;
  if (t.isIdentifier(node)) return isMinified(node.name) ? null : node.name;
  if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed) {
    const prop = literalKey(node.property);
    return prop && !isMinified(prop) ? prop : null;
  }
  if (t.isCallExpression(node)) return nameFromExpression(node);
  return null;
}

function paramBinding(fn: NodePath<t.Function>, index: number): Binding | undefined {
  const param = fn.node.params[index];
  if (t.isIdentifier(param)) return fn.scope.getOwnBinding(param.name);
  if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) return fn.scope.getOwnBinding(param.left.name);
  return undefined;
}

function asFunction(path: NodePath | null | undefined): NodePath<t.Function> | null {
  return path && (path.isArrowFunctionExpression() || path.isFunctionExpression()) ? (path as NodePath<t.Function>) : null;
}

function booleanValue(node: t.Node | null | undefined): boolean | null {
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isUnaryExpression(node, { operator: "!" }) && t.isNumericLiteral(node.argument)) return !node.argument.value;
  return null;
}

function handlerName(key: string): string | null {
  return /^on[A-Z]/.test(key) ? `handle${key.slice(2)}` : null;
}

function initialStateName(init: t.Node | undefined): string {
  const value = t.isArrowFunctionExpression(init) && t.isExpression(init.body) ? init.body : init;
  if (t.isArrayExpression(value)) return "items";
  if (t.isStringLiteral(value) || t.isTemplateLiteral(value)) return "text";
  if (t.isNumericLiteral(value)) return "count";
  if (t.isBooleanLiteral(value)) return "flag";
  if (t.isObjectExpression(value)) return "data";
  return "state";
}

export function collectVotes(ast: t.File): Votes {
  const votes = new Votes();
  const setterBase = new Map<Binding, Binding>();
  const loopDepth: string[] = ["i", "j", "k"];

  const identifierBinding = (path: NodePath, node: t.Node | null | undefined): Binding | undefined =>
    t.isIdentifier(node) ? path.scope.getBinding(node.name) : undefined;

  const voteValueKey = (path: NodePath, value: t.Node | null | undefined, key: string | null) => {
    if (!key || isMinified(key)) return;
    const binding = identifierBinding(path, value);
    if (binding) {
      const declared = binding.path.isFunctionDeclaration() ? binding.path.node : binding.path.isVariableDeclarator() && t.isFunction(binding.path.node.init) ? binding.path.node.init : null;
      if (declared && /^[a-z][A-Za-z0-9]*$/.test(key) && containsJsx(declared)) votes.add(binding, capitalize(key), 5);
      votes.add(binding, key, 4);
      const handler = handlerName(key);
      if (handler && (binding.path.isFunctionDeclaration() || binding.path.isVariableDeclarator())) votes.add(binding, handler, 8);
    }
    const handler = handlerName(key);
    const fnPath = asFunction(path.get(t.isJSXAttribute(path.node) ? "value.expression" : "value") as NodePath);
    if (handler && fnPath) votes.add(paramBinding(fnPath, 0), "event", 6);
  };

  traverse(ast, {
    JSXElement(path) {
      const name = path.node.openingElement.name;
      if (!t.isJSXIdentifier(name) || !(isMinified(name.name) || /^_Component\d*$/.test(name.name))) return;
      const binding = path.scope.getBinding(name.name);
      const attrs = new Set(path.node.openingElement.attributes.flatMap((a) => (t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) ? [a.name.name] : [])));
      if (attrs.has("path") && (attrs.has("element") || attrs.has("component") || attrs.has("Component"))) votes.add(binding, "Route", 5);
      else if (attrs.has("to") && !attrs.has("path")) votes.add(binding, attrs.has("end") || attrs.has("activeClassName") ? "NavLink" : "Link", 5);
      const children = path.node.children.filter((c): c is t.JSXElement => t.isJSXElement(c));
      const routeChild = (c: t.JSXElement) => c.openingElement.attributes.some((a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: "path" }));
      if (children.length && children.every(routeChild)) votes.add(binding, "Routes", 5);
    },
    VariableDeclarator(path) {
      const { id, init } = path.node;
      if (t.isIdentifier(id)) {
        const binding = path.scope.getBinding(id.name);
        votes.add(binding, nameFromExpression(init), 6);
        if (t.isUnaryExpression(init, { operator: "typeof" }) || (t.isBinaryExpression(init) && t.isUnaryExpression(init.left, { operator: "typeof" }))) {
          const checked = readableName(t.isUnaryExpression(init) ? init.argument : (init.left as t.UnaryExpression).argument);
          if (checked) votes.add(binding, `has${capitalize(checked)}`, 3);
        }
        if (booleanValue(init) === false && binding && binding.constantViolations.length > 0 && binding.constantViolations.every((v) => t.isAssignmentExpression(v.node) && booleanValue(v.node.right) === true)) votes.add(binding, "done", 2);
        if ((t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) && containsJsx(init)) {
          votes.add(binding, "Component", 2);
          votes.add(binding, markupComponentName(init), 3);
        }
        return;
      }
      if (t.isArrayPattern(id) && t.isCallExpression(init)) {
        const hook = calleeName(init.callee);
        const [first, second] = id.elements;
        const state = identifierBinding(path, first);
        const setter = identifierBinding(path, second);
        if (hook === "useState" && state) {
          votes.statePairs.push({ state, setter: setter ?? null });
          votes.add(state, initialStateName(init.arguments[0]), 2);
          if (setter) setterBase.set(setter, state);
        } else if (hook === "useReducer") {
          votes.add(state, "state", 6);
          votes.add(setter, "dispatch", 8);
        } else if (hook === "useTransition") {
          votes.add(state, "isPending", 8);
          votes.add(setter, "startTransition", 8);
        }
      }
    },

    ObjectPattern(path) {
      for (const prop of path.node.properties) {
        if (!t.isObjectProperty(prop)) continue;
        const key = literalKey(prop.key);
        const value = t.isAssignmentPattern(prop.value) ? prop.value.left : prop.value;
        if (key && !isMinified(key) && t.isIdentifier(value) && value.name !== key) {
          votes.add(path.scope.getBinding(value.name), key, 10);
        }
      }
    },

    ObjectProperty(path) {
      if (!path.parentPath.isObjectExpression()) return;
      voteValueKey(path, path.node.value, literalKey(path.node.key));
    },

    JSXAttribute(path) {
      const { name, value } = path.node;
      if (!t.isJSXIdentifier(name) || !t.isJSXExpressionContainer(value)) return;
      voteValueKey(path, value.expression, name.name);
    },

    AssignmentExpression(path) {
      const { left, right } = path.node;
      if (t.isIdentifier(left) && t.isIdentifier(right) && path.node.operator === "=") {
        const binding = path.scope.getBinding(left.name);
        const name = readableName(right);
        if (binding && name && binding.scope !== path.scope && binding.scope.path.isProgram() && binding.referencePaths.some((ref) => t.isBinaryExpression(ref.parent) && /^[!=]==?$/.test(ref.parent.operator))) votes.add(binding, `last${capitalize(name)}`, 4);
      }
      if (t.isMemberExpression(left) && !left.computed) {
        const key = literalKey(left.property);
        if (key && !isMinified(key)) votes.add(identifierBinding(path, right), key, 3);
      }
    },

    OptionalCallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      const binding = path.scope.getBinding(callee.name);
      if (binding?.kind === "param") votes.add(binding, "callback", 3);
    },

    CatchClause(path) {
      const param = path.node.param;
      if (t.isIdentifier(param)) votes.add(path.scope.getBinding(param.name), "error", 8);
    },

    NewExpression(path) {
      if (t.isIdentifier(path.node.callee, { name: "Promise" })) {
        const fn = asFunction(path.get("arguments.0") as NodePath);
        if (fn) {
          votes.add(paramBinding(fn, 0), "resolve", 9);
          votes.add(paramBinding(fn, 1), "reject", 9);
        }
      }
    },

    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      const method = calleeName(callee);
      if (!method) return;
      const fnArg = (index: number) => asFunction(path.get(`arguments.${index}`) as NodePath);

      if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && ITERATOR_METHODS.has(method)) {
        const fn = fnArg(0);
        if (fn) {
          const receiver = readableName(callee.object);
          const item = receiver ? singular(receiver) : null;
          votes.add(paramBinding(fn, 0), item ?? "item", item ? 5 : 3);
          votes.add(paramBinding(fn, 1), "index", 4);
        }
      } else if (method === "reduce" || method === "reduceRight") {
        const fn = fnArg(0);
        if (fn) {
          const receiver = t.isMemberExpression(callee) ? readableName(callee.object) : null;
          votes.add(paramBinding(fn, 0), "acc", 4);
          votes.add(paramBinding(fn, 1), (receiver && singular(receiver)) ?? "item", 4);
        }
      } else if (method === "then") {
        const fn = fnArg(0);
        if (fn) votes.add(paramBinding(fn, 0), "result", 2);
        const rejected = fnArg(1);
        if (rejected) votes.add(paramBinding(rejected, 0), "error", 5);
      } else if (method === "catch") {
        const fn = fnArg(0);
        if (fn) votes.add(paramBinding(fn, 0), "error", 6);
      } else if (method === "addEventListener" && t.isStringLiteral(args[0])) {
        const eventName = camel(args[0].value);
        const fn = fnArg(1);
        if (fn) votes.add(paramBinding(fn, 0), "event", 6);
        else votes.add(identifierBinding(path, args[1]), `handle${capitalize(eventName)}`, 6);
      } else if (method === "fetch" && (t.isStringLiteral(args[0]) || t.isTemplateLiteral(args[0]))) {
        const url = t.isStringLiteral(args[0]) ? args[0].value : (args[0].quasis[0]?.value.cooked ?? "");
        const segment = camel(url.split("?")[0]!.split("/").filter((s) => s && !s.startsWith("$")).pop() ?? "");
        const fn = path.getFunctionParent();
        const fnBinding = fn && fn.isFunctionDeclaration() && fn.node.id ? fn.scope.parent?.getBinding(fn.node.id.name) : undefined;
        if (segment) votes.add(fnBinding, `fetch${capitalize(segment)}`, 3);
      }

      if (t.isIdentifier(callee)) {
        const target = path.scope.getBinding(callee.name);
        const declared = target?.path.isFunctionDeclaration() ? (target.path as NodePath<t.Function>) : target?.path.isVariableDeclarator() ? asFunction(target.path.get("init") as NodePath) : null;
        if (declared && target!.constantViolations.length === 0) {
          args.forEach((arg, index) => {
            const name = readableName(arg);
            if (name && !GENERIC_ARGUMENTS.test(name)) votes.add(paramBinding(declared, index), name, 2);
          });
        }
        const setter = path.scope.getBinding(callee.name);
        const state = setter ? setterBase.get(setter) : undefined;
        const fn = fnArg(0);
        if (state && fn) {
          const base = readableName(state.identifier) ?? votes.best(state)?.name;
          if (base && base !== "state") votes.add(paramBinding(fn, 0), `prev${capitalize(base)}`, 5);
          else votes.add(paramBinding(fn, 0), "prev", 4);
        }
      }
    },

    ForStatement(path) {
      const init = path.node.init;
      if (!t.isVariableDeclaration(init) || init.declarations.length !== 1) return;
      const decl = init.declarations[0]!;
      if (!t.isIdentifier(decl.id) || !t.isNumericLiteral(decl.init)) return;
      const depth = path.getAncestry().filter((p) => p.isForStatement()).length - 1;
      votes.add(path.scope.getBinding(decl.id.name), loopDepth[depth] ?? `i${depth}`, 5);
    },

    "ForOfStatement|ForInStatement"(path) {
      const node = path.node as t.ForOfStatement | t.ForInStatement;
      if (!t.isVariableDeclaration(node.left)) return;
      const id = node.left.declarations[0]?.id;
      if (!t.isIdentifier(id)) return;
      const binding = path.scope.getBinding(id.name);
      if (t.isForInStatement(node)) {
        votes.add(binding, "key", 4);
        return;
      }
      const source = readableName(node.right);
      const item = source ? singular(source) : null;
      votes.add(binding, item ?? "item", item ? 5 : 3);
    },

    MemberExpression(path) {
      const { object, property, computed } = path.node;
      if (computed || !t.isIdentifier(object)) return;
      const prop = literalKey(property);
      if (!prop) return;
      const binding = path.scope.getBinding(object.name);
      if (!binding) return;
      for (const [pattern, name, weight] of MEMBER_HINTS) {
        if (pattern.test(prop)) votes.add(binding, name, weight);
      }
    },

    ImportDeclaration(path) {
      const source = path.node.source.value;
      for (const spec of path.node.specifiers) {
        if (!t.isImportNamespaceSpecifier(spec) && !t.isImportDefaultSpecifier(spec)) continue;
        const binding = path.scope.getBinding(spec.local.name);
        if (!binding) continue;
        const members = new Set<string>();
        for (const ref of binding.referencePaths) {
          const parent = ref.parent;
          if (t.isMemberExpression(parent) && parent.object === ref.node && !parent.computed) {
            const key = literalKey(parent.property);
            if (key) members.add(key);
          }
        }
        const list = [...members];
        if (!list.length && binding.referencePaths.length === 0 && containsJsx(ast.program)) votes.add(binding, "jsxRuntime", 3);
        else if (list.length && list.every((m) => JSX_RUNTIME_MEMBERS.test(m))) votes.add(binding, "jsxRuntime", 7);
        else if (list.length && list.every((m) => REACT_DOM_MEMBERS.test(m)) && list.some((m) => /^(createPortal|flushSync|createRoot|hydrateRoot|preload|preinit)$/.test(m))) {
          votes.add(binding, "ReactDOM", 7);
        } else if (list.length && list.every((m) => REACT_MEMBERS.test(m)) && list.some((m) => m.startsWith("use") || m === "createElement")) {
          votes.add(binding, "React", 7);
        }
        else {
          const id = moduleIdFromSpecifier(source);
          votes.add(binding, id ? moduleName(id) : "module", 5);
        }
      }
    },

    FunctionDeclaration(path) {
      const id = path.node.id;
      const placeholder = !!id && /^_Component\d*$/.test(id.name);
      if (!id || !(isMinified(id.name) || placeholder) || !containsJsx(path.node.body)) return;
      const binding = path.parentPath.scope.getBinding(id.name);
      if (!placeholder) votes.add(binding, "Component", 2);
      votes.add(binding, markupComponentName(path.node), 3);
    },

    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id && isMinified(decl.id.name) && containsJsx(decl.body)) {
        votes.add(path.scope.getBinding(decl.id.name), "Component", 2);
        votes.add(path.scope.getBinding(decl.id.name), markupComponentName(decl), 3);
      }
    },
  });

  return votes;
}

const PARTICIPLES: Record<string, string> = { normalize: "normalized", format: "formatted", sanitize: "sanitized", encode: "encoded", decode: "decoded", serialize: "serialized", merge: "merged", sort: "sorted", filter: "filtered", trim: "trimmed" };
const MIN_WEIGHT = 2;
const GENERIC_ARGUMENTS = /^(value|values|data|item|items|result|args|arguments|options|props|length|default|current|target|this|undefined|null|true|false|key|index|i|j|k|n|x|y|z|event|error|state|text|string|number|object|array|fn|cb|callback)$/;

function programGlobals(binding: Binding): Record<string, unknown> {
  return (binding.scope.getProgramParent() as unknown as { globals: Record<string, unknown> }).globals;
}

export function canRename(binding: Binding, name: string): boolean {
  if (!t.isValidIdentifier(name, true) || RESERVED.has(name)) return false;
  if (binding.scope.hasBinding(name)) return false;
  if (programGlobals(binding)[name]) return false;
  for (const ref of [...binding.referencePaths, ...binding.constantViolations]) {
    if (ref.scope.getBinding(name)) return false;
  }
  return true;
}

function uniqueName(binding: Binding, base: string): string | null {
  if (canRename(binding, base)) return base;
  for (let n = 2; n < 50; n++) {
    const candidate = `${base}${n}`;
    if (canRename(binding, candidate)) return candidate;
  }
  return null;
}

function rename(binding: Binding, base: string): boolean {
  const name = uniqueName(binding, base);
  if (!name) return false;
  renameBinding(binding, name);
  return true;
}

export function applyVotes(votes: Votes): number {
  const setters = new Set(votes.statePairs.flatMap((p) => (p.setter ? [p.setter] : [])));
  const ranked = votes
    .bindings()
    .filter((b) => isMinifiedBinding(b) && !setters.has(b))
    .map((b) => ({ binding: b, best: votes.best(b) }))
    .filter((e): e is { binding: Binding; best: { name: string; weight: number } } => e.best !== null && e.best.weight >= MIN_WEIGHT)
    .sort((a, b) => b.best.weight - a.best.weight);

  let renamed = 0;
  for (const { binding, best } of ranked) {
    if (isMinifiedBinding(binding) && rename(binding, best.name)) renamed++;
  }

  for (const { state, setter } of votes.statePairs) {
    if (!setter || !isMinified(setter.identifier.name)) continue;
    const base = isMinified(state.identifier.name) ? "state" : state.identifier.name;
    if (rename(setter, `set${capitalize(base)}`)) renamed++;
  }
  return renamed;
}

export function tidyAst(ast: t.File): void {
  const body = ast.program.body;
  const imported = new Map<string, t.ImportDeclaration>();
  for (const stmt of body) if (t.isImportDeclaration(stmt)) for (const spec of stmt.specifiers) if (t.isImportNamespaceSpecifier(spec)) imported.set(spec.local.name, stmt);
  const touched = new Set<t.ImportDeclaration>();
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i]!;
    if (!t.isExpressionStatement(stmt) || !t.isIdentifier(stmt.expression) || !imported.has(stmt.expression.name)) continue;
    touched.add(imported.get(stmt.expression.name)!);
    body.splice(i, 1);
  }
  if (touched.size) {
    const names = new Set<string>();
    t.traverseFast(t.program(body.filter((s) => !t.isImportDeclaration(s))), (n) => {
      if (t.isIdentifier(n)) names.add(n.name);
    });
    for (const decl of touched) {
      decl.specifiers = decl.specifiers.filter((s) => !t.isImportNamespaceSpecifier(s) || names.has(s.local.name));
      if (decl.specifiers.length) continue;
      const same = body.some((s) => s !== decl && t.isImportDeclaration(s) && s.source.value === decl.source.value);
      if (same) body.splice(body.indexOf(decl), 1);
    }
  }
  traverse(ast, {
    ObjectProperty(path) {
      const { key, value, computed } = path.node;
      if (!computed && t.isIdentifier(key) && t.isIdentifier(value) && key.name === value.name) path.node.shorthand = true;
      if (!computed && t.isIdentifier(key) && t.isAssignmentPattern(value) && t.isIdentifier(value.left, { name: key.name })) {
        path.node.shorthand = true;
      }
    },
  });

  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i]!;
    if (!t.isExportDefaultDeclaration(stmt) || !t.isIdentifier(stmt.declaration)) continue;
    const localName = stmt.declaration.name;
    const index = body.findIndex((s) => (t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) && s.id?.name === localName);
    if (index < 0 || index > i) continue;
    body[index] = t.exportDefaultDeclaration(body[index] as t.FunctionDeclaration | t.ClassDeclaration);
    body.splice(i, 1);
  }
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i]!;
    if (!t.isExportNamedDeclaration(stmt) || stmt.declaration || stmt.source || stmt.specifiers.length !== 1) continue;
    const spec = stmt.specifiers[0]!;
    if (!t.isExportSpecifier(spec)) continue;
    const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
    const localName = spec.local.name;
    const index = body.findIndex(
      (s) =>
        ((t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) && s.id?.name === localName) ||
        (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isIdentifier(s.declarations[0]!.id, { name: localName })),
    );
    if (index < 0 || index > i) continue;
    const decl = body[index] as t.FunctionDeclaration | t.ClassDeclaration | t.VariableDeclaration;
    if (exported === "default" && !t.isVariableDeclaration(decl)) body[index] = t.exportDefaultDeclaration(decl);
    else if (exported === localName) body[index] = t.exportNamedDeclaration(decl);
    else continue;
    body.splice(i, 1);
  }
}

export function splitExports(ast: t.File): void {
  const body = ast.program.body;
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i]!;
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration && !stmt.source) {
      const decl = stmt.declaration;
      const ids = t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl) ? (decl.id ? [decl.id.name] : []) : t.isVariableDeclaration(decl) ? decl.declarations.flatMap((d) => (t.isIdentifier(d.id) ? [d.id.name] : [])) : [];
      if (t.isVariableDeclaration(decl) && ids.length !== decl.declarations.length) continue;
      body.splice(i, 1, decl, ...ids.map((id) => t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(id), t.identifier(id))])));
      i += ids.length;
    } else if (t.isExportDefaultDeclaration(stmt) && (t.isFunctionDeclaration(stmt.declaration) || t.isClassDeclaration(stmt.declaration)) && stmt.declaration.id) {
      const decl = stmt.declaration;
      body.splice(i, 1, decl, t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(decl.id!.name), t.identifier("default"))]));
      i++;
    }
  }
}

const PASSES = 3;


export type BindingSnapshot = Map<t.Identifier, t.Node | null>;

export function snapshotBindings(ast: t.File): BindingSnapshot {
  const snapshot: BindingSnapshot = new Map();
  traverse(ast, {
    Identifier(path) {
      const generic = path as NodePath;
      if (generic.isReferencedIdentifier()) snapshot.set(path.node, path.scope.getBinding(path.node.name)?.identifier ?? null);
    },
  });
  return snapshot;
}

export function bindingViolations(ast: t.File, snapshot: BindingSnapshot): string[] {
  traverse.cache.clear();
  const violations: string[] = [];
  traverse(ast, {
    Identifier(path) {
      if (!snapshot.has(path.node)) return;
      const before = snapshot.get(path.node);
      const after = path.scope.getBinding(path.node.name)?.identifier ?? null;
      if (before !== after) violations.push(`${path.node.name} at line ${path.node.loc?.start.line ?? "?"} now resolves to a different binding`);
    },
  });
  return violations;
}

export interface RenameResult {
  code: string;
  renamed: number;
  violations?: string[];
}

export function renameIdentifiers(code: string): RenameResult {
  const ast = parseProgram(code);
  splitExports(ast);
  const snapshot = snapshotBindings(ast);
  let renamed = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    const count = applyVotes(collectVotes(ast));
    renamed += count;
    if (count === 0) break;
  }
  if (!renamed) return { code, renamed };
  const violations = bindingViolations(ast, snapshot);
  if (violations.length) return { code, renamed: 0, violations };
  tidyAst(ast);
  return { code: print(ast), renamed };
}
