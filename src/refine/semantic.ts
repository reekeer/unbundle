import { literalKey, t } from "../unpack/ast.ts";

interface Facts {
  reads: Set<string>;
  writes: Set<string>;
  calls: Set<string>;
  strings: string[];
  regexes: string[];
  constructed: Set<string>;
  returns: t.Node[];
  params: number;
}

function chain(node: t.Node | null | undefined): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isThisExpression(node)) return "this";
  if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed) {
    const head = chain(node.object);
    const key = literalKey(node.property);
    return head && key ? `${head}.${key}` : key ? `?.${key}` : null;
  }
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const head = chain(node.callee);
    return head ? `${head}()` : null;
  }
  return null;
}

function globalChain(path: string | null): string | null {
  if (!path) return null;
  return path.replace(/^(window|globalThis|self)\./, "");
}

function facts(fn: t.Function): Facts {
  const out: Facts = { reads: new Set(), writes: new Set(), calls: new Set(), strings: [], regexes: [], constructed: new Set(), returns: [], params: fn.params.length };
  const body = fn.body;
  if (t.isExpression(body)) out.returns.push(body);
  t.traverseFast(body, (node) => {
    if (t.isReturnStatement(node) && node.argument) out.returns.push(node.argument);
    if (t.isStringLiteral(node)) out.strings.push(node.value);
    if (t.isTemplateLiteral(node)) for (const q of node.quasis) if (q.value.cooked) out.strings.push(q.value.cooked);
    if (t.isRegExpLiteral(node)) out.regexes.push(node.pattern);
    if (t.isNewExpression(node) && t.isIdentifier(node.callee)) out.constructed.add(node.callee.name);
    if (t.isAssignmentExpression(node)) {
      const target = globalChain(chain(node.left));
      if (target) out.writes.add(target);
    }
    if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed) {
      const read = globalChain(chain(node));
      if (read) out.reads.add(read);
    }
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      const callee = globalChain(chain(node.callee));
      if (callee) out.calls.add(callee);
    }
  });
  return out;
}

function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

function has(set: Set<string>, pattern: RegExp): boolean {
  for (const item of set) if (pattern.test(item)) return true;
  return false;
}

function returnsBoolean(f: Facts): boolean {
  return f.returns.length > 0 && f.returns.every((r) => t.isBooleanLiteral(r) || (t.isUnaryExpression(r, { operator: "!" })) || (t.isBinaryExpression(r) && /^(===|!==|==|!=|<|>|<=|>=|instanceof|in)$/.test(r.operator)) || (t.isLogicalExpression(r) && returnsBoolean({ ...f, returns: [r.left, r.right] })) || (t.isCallExpression(r) && t.isMemberExpression(r.callee) && /^(test|includes|startsWith|endsWith|some|every|has|contains|matches)$/.test(literalKey(r.callee.property) ?? "")));
}

export type Resolve = (name: string) => string | null;

const GENERIC_KEY_WORDS = /^(key|data|value|state|store|storage|cache|v\d+|app|admin|user|site)$/;

export function keySubject(key: string): string {
  const words = key.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
  const meaningful = words.filter((w) => !GENERIC_KEY_WORDS.test(w));
  return meaningful.at(-1) ?? words.at(-1) ?? key;
}

function storeHook(fn: t.Function): string | null {
  if (!t.isBlockStatement(fn.body) || fn.body.body.length !== 2) return null;
  const [first, last] = fn.body.body;
  if (!t.isVariableDeclaration(first) || first.declarations.length !== 1) return null;
  const init = first.declarations[0]!.init;
  const store = t.isCallExpression(init) && t.isIdentifier(init.callee) && !init.arguments.length ? /^use([A-Z]\w*)Store$/.exec(init.callee.name)?.[1] : undefined;
  if (!store || !t.isReturnStatement(last) || !last.argument || !t.isFunction(last.argument)) return null;
  return `use${store}`;
}

function storageKey(fn: t.Function, method: string, resolve: Resolve): string | null {
  let key: string | null = null;
  t.traverseFast(fn.body, (node) => {
    if (key || !t.isCallExpression(node) || !t.isMemberExpression(node.callee) || literalKey(node.callee.property) !== method) return;
    const arg = node.arguments[0];
    const value = t.isStringLiteral(arg) ? arg.value : t.isIdentifier(arg) ? resolve(arg.name) : null;
    if (value && /[A-Za-z]/.test(value)) key = value;
  });
  return key;
}

function eventName(fn: t.Function): string | null {
  let name: string | null = null;
  t.traverseFast(fn.body, (node) => {
    if (name || !t.isNewExpression(node) || !t.isIdentifier(node.callee) || !/^(Custom)?Event$/.test(node.callee.name)) return;
    const arg = node.arguments[0];
    if (t.isStringLiteral(arg)) name = arg.value.split(/[:/]/).pop() ?? null;
  });
  return name;
}

function readyFlag(f: Facts): string | null {
  for (const write of f.writes) {
    const flag = /^__?([A-Za-z][A-Za-z0-9]*?)(Ready|Initialized|Inited|Installed|Loaded|Bound|Setup)$/.exec(write.replace(/^window\./, ""));
    if (flag) return flag[1]!.replace(/^[a-z]/, (c) => c.toUpperCase());
  }
  return null;
}

const IPV4 = /\\d\{1,3\}\(\\\.\\d\{1,3\}\)\{3\}|\\d\{1,3\}\\\.\\d\{1,3\}\\\.\\d\{1,3\}\\\.\\d\{1,3\}/;

const PLAIN_CALLS = /(^|\.)(split|join|trim|push|slice|includes|startsWith|endsWith|toLowerCase|toUpperCase|replace|test|map|filter|find|some|every|forEach|reduce|indexOf|concat|keys|values|entries|toString|String|Number|Boolean|parseInt|parseFloat|isArray|stringify|parse)$/;

function equalityStrings(node: t.Node, param: string): string[] | null {
  if (t.isLogicalExpression(node, { operator: "||" })) {
    const left = equalityStrings(node.left, param);
    const right = equalityStrings(node.right, param);
    return left && right ? [...left, ...right] : null;
  }
  if (t.isBinaryExpression(node) && /^===?$/.test(node.operator)) {
    const [a, b] = t.isIdentifier(node.left, { name: param }) ? [node.left, node.right] : [node.right, node.left];
    if (t.isIdentifier(a, { name: param }) && t.isStringLiteral(b)) return [b.value];
  }
  return null;
}

function comparisonName(fn: t.Function): string | null {
  const param = fn.params.length === 1 && t.isIdentifier(fn.params[0]) ? fn.params[0].name : null;
  const body = t.isBlockStatement(fn.body) ? (fn.body.body.length === 1 && t.isReturnStatement(fn.body.body[0]) ? fn.body.body[0].argument : null) : fn.body;
  if (!param || !body) return null;
  if (t.isBinaryExpression(body) && /^===?$/.test(body.operator) && t.isIdentifier(body.left, { name: param }) && t.isNullLiteral(body.right)) return "isNull";
  const strings = equalityStrings(body, param);
  if (!strings || strings.length > 3 || !strings.every((v) => /^[a-z][a-z0-9]*([_-][a-z0-9]+)?$/i.test(v) && v.length <= 14)) return null;
  return `is${strings.map(pascal).join("Or")}`;
}

function cookieCallKey(fn: t.Function, callee: RegExp, resolve: Resolve): string | null {
  let key: string | null = null;
  t.traverseFast(fn.body, (node) => {
    if (key || !t.isCallExpression(node) || !t.isIdentifier(node.callee) || !callee.test(node.callee.name)) return;
    const arg = node.arguments[0];
    const value = t.isStringLiteral(arg) ? arg.value : t.isIdentifier(arg) ? resolve(arg.name) : null;
    if (value && /[A-Za-z]/.test(value)) key = value;
  });
  return key;
}

function consentCall(fn: t.Function): "accepted" | "rejected" | null {
  let found: "accepted" | "rejected" | null = null;
  t.traverseFast(fn.body, (node) => {
    if (found || !t.isCallExpression(node) || !t.isIdentifier(node.callee) || node.arguments.length !== 1) return;
    const arg = node.arguments[0];
    if (t.isStringLiteral(arg) && /^(accepted|granted|all)$/.test(arg.value)) found = "accepted";
    if (t.isStringLiteral(arg) && /^(rejected|denied|declined|necessary)$/.test(arg.value)) found = "rejected";
  });
  return found;
}

function returnsJsx(fn: t.Function): boolean {
  if ((t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) && (t.isJSXElement(fn.body) || t.isJSXFragment(fn.body))) return true;
  if (!t.isBlockStatement(fn.body)) return false;
  let found = false;
  const scan = (nodes: t.Node[]) => {
    for (const node of nodes) {
      if (found) return;
      if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node) || t.isClassDeclaration(node)) continue;
      if (t.isReturnStatement(node)) {
        const arg = node.argument;
        if (t.isJSXElement(arg) || t.isJSXFragment(arg) || (t.isConditionalExpression(arg) && [arg.consequent, arg.alternate].some((b) => t.isJSXElement(b) || t.isJSXFragment(b)))) found = true;
        continue;
      }
      const children = Object.values(node).flatMap((value) => (Array.isArray(value) ? value : [value])).filter((value): value is t.Node => !!value && typeof value === "object" && typeof (value as t.Node).type === "string");
      scan(children);
    }
  };
  scan(fn.body.body);
  return found;
}

export function semanticFunctionName(fn: t.Function, resolve: Resolve = () => null): string | null {
  if (returnsJsx(fn)) return null;
  const compared = comparisonName(fn);
  if (compared) return compared;
  const consent = consentCall(fn);
  if (consent) return consent === "accepted" ? "acceptCookies" : "rejectCookies";
  const cookieKey = cookieCallKey(fn, /^(getCookie|readCookie)$/, resolve);
  if (cookieKey && fn.params.length === 0) return `get${pascal(keySubject(cookieKey))}`;
  const f = facts(fn);
  if (returnsBoolean(f) && f.strings.includes("accepted") && fn.params.length >= 1) return "hasConsent";
  const loader = [...f.calls].find((c) => /^load[A-Z]\w*(Metrika|Analytics|Gtag|Pixel)$/.test(c));
  if (loader && [...f.calls].some((c) => /^track[A-Z]/.test(c))) return `init${loader.slice(4)}`;
  const returns = f.returns.length > 0;
  const boolean = returnsBoolean(f);
  const effects = [...f.calls].filter((c) => !PLAIN_CALLS.test(c)).length;
  const focused = effects <= 3;
  const cookieRead = f.reads.has("document.cookie") && !f.writes.has("document.cookie");
  if (f.writes.has("document.cookie") && focused) return f.strings.some((s) => /Max-Age=0|expires=Thu, 01 Jan 1970/i.test(s)) ? "deleteCookie" : "setCookie";
  if (cookieRead && returns && focused) return "getCookie";
  for (const store of ["localStorage", "sessionStorage"]) {
    if (!focused) break;
    const get = f.calls.has(`${store}.getItem`);
    const set = f.calls.has(`${store}.setItem`);
    const remove = f.calls.has(`${store}.removeItem`);
    if (get && returns && !set) {
      const key = storageKey(fn, "getItem", resolve);
      return key ? `get${pascal(keySubject(key))}` : "readStorage";
    }
    if (set && !get) {
      const key = storageKey(fn, "setItem", resolve);
      if (has(f.calls, /classList\.toggle$/)) return key ? `apply${pascal(keySubject(key))}` : "applyTheme";
      return key ? `set${pascal(keySubject(key))}` : "writeStorage";
    }
    if (remove && !get && !set) {
      const key = storageKey(fn, "removeItem", resolve);
      return key ? `clear${pascal(keySubject(key))}` : "clearStorage";
    }
  }
  if (f.strings.includes("light") && f.strings.includes("dark") && returns && f.params === 0 && f.calls.size >= 2 && f.calls.size <= 3) return "toggleTheme";
  if (f.calls.has("useContext") && returns && fn.params.length === 0) {
    const hook = f.strings.map((s) => /\b(use[A-Z][A-Za-z0-9]*)\b/.exec(s)?.[1]).find((name) => name);
    if (hook) return hook;
  }
  const store = storeHook(fn);
  if (store) return store;
  if (f.strings.some((v) => v === "wss" || v === "wss:") && f.strings.some((v) => /^(ws|ws:)$/.test(v)) && returns && f.returns.every((r) => t.isTemplateLiteral(r) || t.isBinaryExpression(r, { operator: "+" }) || t.isStringLiteral(r))) return "buildWsUrl";
  if (f.writes.has("location.href") || f.calls.has("location.assign") || f.calls.has("location.replace")) return f.params ? "navigate" : "redirect";
  if (f.calls.has("location.reload") && !returns) return "reload";
  if (f.calls.has("navigator.clipboard.writeText")) return "copyToClipboard";
  if (f.calls.has("navigator.sendBeacon")) return "sendBeacon";
  if (has(f.calls, /(^|\.)ym$/) && f.strings.includes("reachGoal")) return "reachGoal";
  if ((has(f.calls, /(^|\.)ym$/) && f.strings.includes("hit")) || (has(f.calls, /(^|\.)gtag$/) && f.strings.includes("page_view"))) return "trackPageView";
  const flag = readyFlag(f);
  if (f.calls.has("document.createElement") && f.strings.includes("script") && has(f.calls, /appendChild$/)) return flag ? `load${flag}` : "loadScript";
  const attribute = f.strings.map((s) => /^\[data-([a-z][a-z0-9-]*)\]$/.exec(s)?.[1]).find((a) => a);
  if (attribute && has(f.calls, /addEventListener$/) && has(f.calls, /closest$/)) return `bind${pascal(attribute)}`;
  if (has(f.calls, /(^|\.)gtag$/) && f.strings.includes("event")) return "trackEvent";
  if (f.calls.has("dataLayer.push")) return "pushDataLayer";
  const event = eventName(fn);
  if (event && has(f.calls, /(^|\.)dispatchEvent$/)) return `emit${pascal(event)}`;
  if (flag && has(f.calls, /addEventListener$/)) return `init${flag}`;
  if (f.reads.has("PublicKeyCredential") && boolean) return "isWebAuthnSupported";
  const base64Url = f.regexes.some((r) => /[-_]/.test(r)) || f.strings.some((s) => s === "-" || s === "_");
  if (f.calls.has("atob") && (f.constructed.has("ArrayBuffer") || f.constructed.has("Uint8Array"))) return base64Url ? "base64UrlToBuffer" : "base64ToBuffer";
  if (f.calls.has("btoa") && has(f.calls, /fromCharCode$/)) return base64Url ? "bufferToBase64Url" : "bufferToBase64";
  if (f.calls.has("matchMedia") && f.strings.some((s) => /prefers-color-scheme:\s*dark/.test(s)) && returns) return "prefersDark";
  if (has(f.calls, /classList\.toggle$/) && f.strings.includes("dark")) return "applyTheme";
  if (f.regexes.some((r) => r === "^www\\.") && has(f.calls, /toLowerCase$/)) return "normalizeHost";
  if (boolean && f.strings.includes("localhost") && f.strings.includes("127.0.0.1")) return "isLocalhost";
  if (boolean && f.regexes.some((r) => IPV4.test(r))) return "isIpAddress";
  if (f.constructed.has("Promise") && f.calls.has("setTimeout") && f.params === 1 && f.calls.size <= 2) return "sleep";
  if (f.calls.has("clearTimeout") && f.calls.has("setTimeout") && f.returns.some((r) => t.isFunction(r))) return "debounce";
  if (f.calls.has("navigator.clipboard.readText")) return "pasteFromClipboard";
  if (f.calls.has("crypto.randomUUID")) return "createId";
  if (f.calls.has("Math.random") && has(f.calls, /toString$/) && f.strings.length <= 1 && returns) return "randomId";
  if (f.calls.has("Math.min") && f.calls.has("Math.max") && f.params === 3 && f.calls.size === 2) return "clamp";
  if (has(f.calls, /padStart$/) && returns && f.calls.size <= 3 && f.params <= 2) return "pad";
  if (has(f.calls, /toLocaleDateString$/) && returns) return "formatDate";
  if (has(f.calls, /toLocaleString$/) && f.strings.some((v) => v === "2-digit" || v === "numeric" || v === "short" || v === "long") && returns) return "formatDate";
  if (has(f.calls, /toLocaleTimeString$/) && returns) return "formatTime";
  if (f.strings.some((s) => /^\s*(KB|MB|GB|Кб|КБ|МБ|ГБ)\s*$/.test(s)) && has(f.calls, /(Math\.(floor|log|round)|toFixed)$/)) return "formatBytes";
  if (f.regexes.some((r) => /\[\^a-z0-9\]\+|\[\^\\w\]\+|\\s\+/.test(r)) && f.strings.includes("-") && has(f.calls, /toLowerCase$/) && returns) return "slugify";
  if (has(f.calls, /\.split$/) && has(f.calls, /\.reduce$/) && f.strings.includes(".") && returns) return "getByPath";
  if (f.calls.has("encodeURIComponent") && f.calls.has("Object.entries") && has(f.calls, /\.join$/) && f.strings.includes("&")) return "toQueryString";
  if (has(f.calls, /scrollIntoView$/) || f.calls.has("scrollTo")) return "scrollToSection";
  if (f.calls.has("navigator.userAgent.test") || (f.reads.has("navigator.userAgent") && boolean)) return "isMobile";
  if (has(f.calls, /\.focus$/) && !returns && f.params <= 1 && f.calls.size <= 2) return "focusElement";
  if (f.reads.has("document.documentElement.scrollTop") || f.reads.has("scrollY")) return returns ? "getScrollTop" : "handleScroll";
  if (f.calls.has("URL.createObjectURL") && f.calls.has("document.createElement") && f.strings.includes("a")) return "downloadFile";
  if (f.calls.has("fetch") && f.params >= 1 && f.params <= 2 && !f.constructed.has("FormData") && requestShape(fn)) return "request";
  if (f.constructed.has("FormData") && f.calls.has("fetch")) {
    const segment = f.strings.find((v) => v.startsWith("/"))?.split("/").filter((part) => /^[a-z][a-z-]*$/i.test(part) && !/^(api|v\d+)$/i.test(part)).at(-1);
    return segment ? `upload${pascal(segment)}` : "uploadFile";
  }
  return null;
}

function requestShape(fn: t.Function): boolean {
  const param = t.isIdentifier(fn.params[0]) ? fn.params[0].name : null;
  let found = false;
  t.traverseFast(fn.body, (n) => {
    if (found || !t.isCallExpression(n) || !t.isIdentifier(n.callee, { name: "fetch" })) return;
    const url = n.arguments[0];
    if (t.isTemplateLiteral(url) && url.expressions.some((e) => t.isIdentifier(e, { name: param ?? "" }))) found = true;
    if (t.isBinaryExpression(url, { operator: "+" }) && (t.isIdentifier(url.right, { name: param ?? "" }) || t.isIdentifier(url.left, { name: param ?? "" }))) found = true;
  });
  return found;
}

function upperSnake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .join("_")
    .toUpperCase();
}

const DURATIONS: Record<number, string> = { 31536000: "ONE_YEAR", 2592000: "THIRTY_DAYS", 604800: "ONE_WEEK", 86400: "ONE_DAY", 3600: "ONE_HOUR", 31557600000: "ONE_YEAR_MS", 31536000000: "ONE_YEAR_MS", 2592000000: "THIRTY_DAYS_MS", 604800000: "ONE_WEEK_MS", 86400000: "ONE_DAY_MS", 3600000: "ONE_HOUR_MS", 60000: "ONE_MINUTE_MS" };

function comparedSubject(node: t.Node): string | null {
  if (t.isCallExpression(node) && t.isIdentifier(node.callee) && /^(Number|parseInt|parseFloat|String)$/.test(node.callee.name) && node.arguments[0]) return comparedSubject(node.arguments[0]);
  if (t.isLogicalExpression(node)) return comparedSubject(node.left);
  if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed) {
    const key = literalKey(node.property);
    if (key === "length") {
      const owner = comparedSubject(node.object);
      return owner ? `${owner}_LENGTH` : "LENGTH";
    }
    return key && key.length > 2 ? upperSnake(key) : null;
  }
  if (t.isIdentifier(node) && node.name.length > 2) return upperSnake(node.name);
  return null;
}

function comparisonConstant(use: t.BinaryExpression, value: t.NumericLiteral): string | null {
  const constantRight = t.isIdentifier(use.right);
  const other = constantRight ? use.left : use.right;
  const subject = comparedSubject(other);
  if (!subject) return null;
  const greater = /^>=?$/.test(use.operator) === constantRight;
  if (value.value === 0) return null;
  return `${greater ? "MIN" : "MAX"}_${subject}`;
}

export function semanticConstantName(init: t.Node | null | undefined, usages: t.Node[]): string | null {
  if (t.isStringLiteral(init)) {
    const value = init.value;
    for (const use of usages) {
      if (t.isCallExpression(use) && t.isMemberExpression(use.callee) && /^(getItem|setItem|removeItem)$/.test(literalKey(use.callee.property) ?? "") && use.arguments[0] && t.isIdentifier(use.arguments[0])) return `${upperSnake(keySubject(value))}_KEY`.replace(/_KEY_KEY$/, "_KEY");
      if (t.isCallExpression(use) && t.isMemberExpression(use.callee) && /^(addEventListener|removeEventListener)$/.test(literalKey(use.callee.property) ?? "")) return `${upperSnake(value)}_EVENT`.replace(/_EVENT_EVENT$/, "_EVENT");
      if (t.isNewExpression(use) && t.isIdentifier(use.callee) && /^(Custom)?Event$/.test(use.callee.name)) return `${upperSnake(value)}_EVENT`.replace(/_EVENT_EVENT$/, "_EVENT");
    }
    if (/^https?:\/\//.test(value)) return /\/api(\/|$)/.test(value) ? "API_URL" : "BASE_URL";
    if (/^\/api(\/v\d+)?\/?$/.test(value)) return "API_BASE";
    if (/^[a-z][a-z0-9]*([_:.-][a-z0-9]+)+$/i.test(value) && value.length <= 48) return upperSnake(value);
    return null;
  }
  if (t.isNumericLiteral(init)) {
    for (const use of usages) {
      if (t.isTemplateLiteral(use)) {
        const index = use.expressions.findIndex((e) => t.isIdentifier(e));
        const before = index >= 0 ? use.quasis[index]?.value.cooked ?? "" : "";
        const key = /([A-Za-z][\w-]*)=$/.exec(before)?.[1];
        if (key) return upperSnake(key);
      }
      const timer = t.isCallExpression(use) ? /(?:^|\.)(set(?:Timeout|Interval))$/.exec(chain(use.callee as t.Expression) ?? "")?.[1] : undefined;
      if (timer) return timer === "setInterval" ? "POLL_INTERVAL" : "DELAY";
      if ((t.isCallExpression(use) || t.isOptionalCallExpression(use)) && t.isExpression(use.callee) && /(^|\.)ym$/.test(chain(use.callee) ?? "")) return "METRIKA_ID";
    }
    if (DURATIONS[init.value]) return DURATIONS[init.value]!;
    for (const use of usages) if (t.isBinaryExpression(use) && /^[<>]=?$/.test(use.operator)) {
      const name = comparisonConstant(use, init);
      if (name) return name;
    }
    return null;
  }
  if (t.isArrayExpression(init) && init.elements.every((e) => t.isStringLiteral(e))) {
    for (const use of usages) {
      if (!t.isCallExpression(use) || !t.isMemberExpression(use.callee) || literalKey(use.callee.property) !== "includes") continue;
      const arg = use.arguments[0];
      const subject = t.isIdentifier(arg) && arg.name.length > 2 ? arg.name : (t.isMemberExpression(arg) || t.isOptionalMemberExpression(arg)) && !arg.computed ? literalKey(arg.property) : null;
      if (subject && subject.length > 2) return `ALLOWED_${upperSnake(subject)}${/s$/.test(subject) ? "" : "S"}`;
    }
    return null;
  }
  if (t.isRegExpLiteral(init)) {
    if (IPV4.test(init.pattern)) return "IPV4_PATTERN";
    if (/@/.test(init.pattern) && /\\\./.test(init.pattern)) return "EMAIL_PATTERN";
    if (/\[0-9a-f\]\{8\}-/.test(init.pattern)) return "UUID_PATTERN";
    return null;
  }
  return null;
}

const COLORS = /^(red|green|blue|gray|grey|orange|yellow|purple|pink|amber|emerald|slate|zinc|neutral|sky|teal|cyan|indigo|violet|rose|lime|black|white|success|danger|warning|info|primary|secondary|muted|error)$/;

export function subjectFunctionName(fn: t.Function, subject: string): string | null {
  const f = facts(fn);
  if (!f.returns.length || fn.params.length !== 1) return null;
  const base = subject.replace(/^[A-Z]/, (c) => c.toLowerCase());
  const values: t.Node[] = f.returns.flatMap((r): t.Node[] => (t.isLogicalExpression(r) ? [r.left, r.right] : [r]));
  const lookup = values.some((v) => t.isMemberExpression(v) && v.computed && t.isObjectExpression(v.object));
  if (lookup) return `${base}Label`;
  if (values.every((v) => t.isStringLiteral(v) && COLORS.test(v.value))) return `${base}Color`;
  if (returnsBoolean(f)) return `is${base[0]!.toUpperCase()}${base.slice(1)}`;
  return null;
}
