import { RESERVED } from "./rename.ts";
import generate from "@babel/generator";
import type { NodePath } from "@babel/traverse";
import { literalKey, print, t } from "../unpack/ast.ts";

const BLOCK_TAGS = new Set(["Fragment", "Comment", "Text", "Static", "Teleport", "Suspense", "KeepAlive"]);
const VUE_API = new Set([
  "ref", "shallowRef", "computed", "reactive", "shallowReactive", "readonly", "watch", "watchEffect", "toRef", "toRefs", "unref", "isRef",
  "onMounted", "onUnmounted", "onBeforeMount", "onBeforeUnmount", "onUpdated", "onBeforeUpdate", "nextTick", "provide", "inject",
  "defineComponent", "getCurrentInstance", "useSlots", "useAttrs", "h", "markRaw", "toRaw", "triggerRef", "customRef",
]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export type Roles = Map<string, string>;

function calleeId(node: t.Node | null | undefined): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isSequenceExpression(node) && node.expressions.length === 2 && t.isNumericLiteral(node.expressions[0])) return calleeId(node.expressions[1]);
  return null;
}

export function componentOptions(node: t.Node | null | undefined): { object: t.ObjectExpression; setup: t.Function | null; render: t.Function | null; props: t.Expression | null; emits: t.Expression | null; name: string | null } | null {
  if (!t.isObjectExpression(node)) return null;
  let setup: t.Function | null = null;
  let render: t.Function | null = null;
  let props: t.Expression | null = null;
  let emits: t.Expression | null = null;
  let name: string | null = null;
  for (const prop of node.properties) {
    if (t.isSpreadElement(prop)) continue;
    const key = literalKey(prop.key);
    const value = t.isObjectMethod(prop) ? prop : t.isObjectProperty(prop) ? prop.value : null;
    if (key === "setup" && (t.isObjectMethod(value) || t.isFunctionExpression(value) || t.isArrowFunctionExpression(value))) setup = value;
    if (key === "render" && (t.isObjectMethod(value) || t.isFunctionExpression(value) || t.isArrowFunctionExpression(value))) render = value;
    if (key === "props" && t.isExpression(value)) props = value;
    if (key === "emits" && t.isExpression(value)) emits = value;
    if ((key === "__name" || key === "name") && t.isStringLiteral(value)) name ??= value.value;
  }
  if (!setup && !render) return null;
  return { object: node, setup, render, props, emits, name };
}

export function renderFunction(options: NonNullable<ReturnType<typeof componentOptions>>): t.Function | null {
  if (options.render) return options.render;
  const setup = options.setup;
  if (!setup || !t.isBlockStatement(setup.body)) return null;
  const last = setup.body.body.at(-1);
  if (!t.isReturnStatement(last)) return null;
  const arg = last.argument;
  return t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg) ? arg : null;
}

function add(roles: Map<string, Map<string, number>>, name: string | null, role: string): void {
  if (!name) return;
  const table = roles.get(name) ?? new Map<string, number>();
  table.set(role, (table.get(role) ?? 0) + 1);
  roles.set(name, table);
}

function isComponentRef(node: t.Node | undefined, known: (n: string) => string | null): boolean {
  if (t.isStringLiteral(node)) return false;
  if (t.isIdentifier(node)) return !BLOCK_TAGS.has(known(node.name) ?? node.name);
  return t.isCallExpression(node) || t.isMemberExpression(node);
}

const TRANSITION_PROPS = /^(name|mode|appear|css|type|duration|persisted|(enter|leave|appear)(From|Active|To)Class|on(Before|After)?(Enter|Leave|Appear)(Cancelled)?)$/;

function builtinRole(call: t.CallExpression, roles: Map<string, Map<string, number>>, known: (n: string) => string | null): void {
  const [component, props, slots] = call.arguments;
  if (!t.isIdentifier(component) || known(component.name) || !t.isObjectExpression(props) || !t.isObjectExpression(slots)) return;
  if (!slots.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "default")) return;
  const keys = props.properties.map((p) => (t.isObjectProperty(p) || t.isObjectMethod(p) ? literalKey(p.key) : null));
  if (!keys.length || keys.some((k) => !k)) return;
  const group = keys.some((k) => k === "tag" || k === "moveClass");
  if (!keys.every((k) => TRANSITION_PROPS.test(k!) || (group && /^(tag|moveClass)$/.test(k!)))) return;
  if (!keys.some((k) => /^(name|mode|appear|tag|moveClass)$|Class$/.test(k!))) return;
  add(roles, component.name, group ? "TransitionGroup" : "Transition");
}

function collectRenderRoles(render: t.Function, roles: Map<string, Map<string, number>>, known: (n: string) => string | null): void {
  const blockCallees = new Set<t.CallExpression>();
  const pairBlock = (opener: t.Expression | null | undefined, block: t.Expression | null | undefined) => {
    if (!t.isCallExpression(opener) || !t.isCallExpression(block)) return;
    if (opener.arguments.length > 1 || (opener.arguments.length === 1 && !t.isBooleanLiteral(opener.arguments[0]))) return;
    const blockName = calleeId(block.callee);
    if (!blockName || !block.arguments.length) return;
    add(roles, calleeId(opener.callee), "openBlock");
    const [, props, , flag] = block.arguments;
    const fragment = t.isNumericLiteral(flag) && [64, 128, 256].includes(flag.value) && (t.isNullLiteral(props) || (t.isObjectExpression(props) && props.properties.every((p) => t.isObjectProperty(p) && literalKey(p.key) === "key")));
    add(roles, blockName, !fragment && isComponentRef(block.arguments[0] as t.Node, known) ? "createBlock" : "createElementBlock");
    builtinRole(block, roles, known);
    const dynamic = block.arguments[0];
    if (t.isCallExpression(dynamic) && dynamic.arguments.length === 1 && !t.isCallExpression(dynamic.arguments[0])) {
      add(roles, calleeId(dynamic.callee), "resolveDynamicComponent");
      blockCallees.add(dynamic);
    }
    blockCallees.add(block);
  };
  t.traverseFast(render.body, (node) => {
    if (t.isSequenceExpression(node) && node.expressions.length === 2) pairBlock(node.expressions[0], node.expressions[1]);
    if (t.isBlockStatement(node)) {
      for (let i = 1; i < node.body.length; i++) {
        const prev = node.body[i - 1];
        const cur = node.body[i];
        if (t.isExpressionStatement(prev) && t.isReturnStatement(cur)) pairBlock(prev.expression, cur.argument);
      }
    }
    if (t.isCallExpression(node) && node.arguments.length === 2 && t.isStringLiteral(node.arguments[0]) && t.isBooleanLiteral(node.arguments[1], { value: true })) {
      add(roles, calleeId(node.callee), "createCommentVNode");
      blockCallees.add(node);
    }
    if (t.isObjectExpression(node) && node.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "_" && t.isNumericLiteral(p.value))) {
      for (const p of node.properties) {
        if (!t.isObjectProperty(p) || literalKey(p.key) === "_" || !t.isCallExpression(p.value)) continue;
        const fn = p.value.arguments[0];
        if (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) add(roles, calleeId(p.value.callee), "withCtx");
      }
    }
  });
  const displayCalls = (node: t.Node | null | undefined): void => {
    if (t.isBinaryExpression(node, { operator: "+" })) {
      displayCalls(node.left);
      displayCalls(node.right);
    } else if (t.isCallExpression(node) && node.arguments.length === 1 && t.isExpression(node.arguments[0]) && !t.isStringLiteral(node.arguments[0])) {
      const name = calleeId(node.callee);
      if (name && !known(name)) add(roles, name, "toDisplayString");
    }
  };
  const keyedVNode = (fn: t.Node | undefined): boolean => {
    if (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn)) return false;
    let returned: t.Node | null | undefined = t.isBlockStatement(fn.body) ? fn.body.body.find((st): st is t.ReturnStatement => t.isReturnStatement(st))?.argument : fn.body;
    if (t.isSequenceExpression(returned)) returned = returned.expressions.at(-1);
    return t.isCallExpression(returned) && t.isObjectExpression(returned.arguments[1]) && returned.arguments[1].properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "key");
  };
  t.traverseFast(render.body, (node) => {
    if (!t.isCallExpression(node) || !calleeId(node.callee)) return;
    const name = calleeId(node.callee)!;
    if (!known(name) && node.arguments.length >= 2 && node.arguments.length <= 4 && t.isExpression(node.arguments[0]) && keyedVNode(node.arguments[1])) add(roles, name, "renderList");
    if (!known(name) && node.arguments.length === 2 && t.isObjectExpression(node.arguments[0]) && node.arguments[0].properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "_") && t.isArrayExpression(node.arguments[1])) add(roles, name, "createSlots");
    if (!known(name) && node.arguments.length === 2 && t.isCallExpression(node.arguments[0]) && t.isArrayExpression(node.arguments[1]) && node.arguments[1].elements.length > 0 && node.arguments[1].elements.every((e) => t.isArrayExpression(e) && e.elements.length >= 1 && e.elements.length <= 4 && (t.isIdentifier(e.elements[0]) || t.isMemberExpression(e.elements[0])))) add(roles, name, "withDirectives");
    const [first, second, third, flag] = node.arguments;
    const keyOnly = t.isNullLiteral(second) || (t.isObjectExpression(second) && second.properties.every((p) => t.isObjectProperty(p) && literalKey(p.key) === "key"));
    if (t.isIdentifier(first) && !known(first.name) && keyOnly && t.isNumericLiteral(flag) && [64, 128, 256].includes(flag.value) && (t.isArrayExpression(third) || t.isCallExpression(third))) add(roles, first.name, "Fragment");
    if (t.isStringLiteral(first) && node.arguments.length === 4 && t.isNumericLiteral(flag) && (flag.value & 1) === 1 && (t.isCallExpression(third) || t.isBinaryExpression(third))) displayCalls(third);
    const merged = t.isCallExpression(second) && calleeId(second.callee) ? second : null;
    if (merged && !known(calleeId(merged.callee)!) && merged.arguments.length >= 2 && merged.arguments.some((a) => t.isObjectExpression(a)) && merged.arguments.some((a) => t.isMemberExpression(a) && !a.computed && /^\$(attrs|props)$/.test(literalKey(a.property) ?? "")) && merged.arguments.every((a) => t.isObjectExpression(a) || t.isMemberExpression(a) || t.isIdentifier(a))) add(roles, calleeId(merged.callee), "mergeProps");
    if (node.arguments.length === 2 && t.isNumericLiteral(second, { value: 1 }) && t.isBinaryExpression(first, { operator: "+" }) && (t.isStringLiteral(first.left) || t.isStringLiteral(first.right) || t.isBinaryExpression(first.left))) displayCalls(first);
  });
  t.traverse(render.body, (node, ancestors) => {
    if (!t.isCallExpression(node) || blockCallees.has(node)) return;
    const name = calleeId(node.callee);
    if (!name || known(name)) return;
    const [first, second] = node.arguments;
    const parent = ancestors.at(-1)?.node;
    const asChild = t.isArrayExpression(parent) || t.isReturnStatement(parent) || t.isArrowFunctionExpression(parent) || (t.isAssignmentExpression(parent) && parent.right === node);
    const displayed = t.isCallExpression(first) && first.arguments.length === 1 && !!calleeId(first.callee) && (calleeId(first.callee) === "toDisplayString" || (!known(calleeId(first.callee)!) && t.isNumericLiteral(second, { value: 1 }) && node.arguments.length === 2 && asChild));
    const textual = t.isStringLiteral(first) || displayed || (t.isBinaryExpression(first, { operator: "+" }));
    if (displayed && calleeId(first.callee) !== "toDisplayString") displayCalls(first);
    if (t.isMemberExpression(first) && !first.computed && literalKey(first.property) === "$slots") add(roles, name, "renderSlot");
    else if (textual && (t.isNumericLiteral(second) || (t.isUnaryExpression(second) && t.isNumericLiteral(second.argument))) && node.arguments.length === 2) add(roles, name, "createTextVNode");
    else if (t.isStringLiteral(first) && node.arguments.length >= 2) add(roles, name, "createElementVNode");
    else if (first && isComponentRef(first as t.Node, known) && (asChild || node.arguments.length > 1) && (node.arguments.length === 1 || t.isObjectExpression(second) || t.isNullLiteral(second))) {
      add(roles, name, "createVNode");
      builtinRole(node, roles, known);
    }
    else if (node.arguments.length === 1 && t.isIdentifier(first)) add(roles, name, "unref");
  });
}

function isCompiledRender(fn: t.Function | null): fn is t.Function {
  return !!fn && (fn.params.length === 2 || fn.params.length === 6) && fn.params.every((p) => t.isIdentifier(p));
}

function collectSetupRoles(setup: t.Function, roles: Map<string, Map<string, number>>): void {
  if (!t.isBlockStatement(setup.body)) return;
  const propsLike = new Set<string>(t.isIdentifier(setup.params[0]) ? [setup.params[0].name] : []);
  for (const stmt of setup.body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) {
      if (t.isIdentifier(d.id) && t.isIdentifier(d.init) && propsLike.has(d.init.name)) propsLike.add(d.id.name);
      if (t.isObjectPattern(d.id) && t.isCallExpression(d.init) && d.init.arguments.length === 1 && t.isIdentifier(d.init.arguments[0]) && propsLike.has(d.init.arguments[0].name)) add(roles, calleeId(d.init.callee), "toRefs");
    }
  }
  const members = new Map<string, Set<string>>();
  const assignedProps = new Set<string>();
  t.traverseFast(setup.body, (node) => {
    if (t.isMemberExpression(node) && t.isIdentifier(node.object)) {
      const key = node.computed ? null : literalKey(node.property);
      if (key) members.set(node.object.name, (members.get(node.object.name) ?? new Set()).add(key));
    }
    if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left) && t.isIdentifier(node.left.object)) assignedProps.add(node.left.object.name);
  });
  const SEO = /^(title|titleTemplate|description|ogTitle|ogDescription|ogImage|ogUrl|ogType|twitterCard|twitterTitle|twitterDescription|twitterImage|robots|keywords|author)$/;
  const HEAD = /^(title|titleTemplate|meta|link|script|style|htmlAttrs|bodyAttrs|noscript|base)$/;
  for (const stmt of setup.body.body) {
    const call = t.isExpressionStatement(stmt) ? stmt.expression : null;
    if (t.isCallExpression(call) && call.arguments.length === 1 && t.isObjectExpression(call.arguments[0])) {
      const keys = call.arguments[0].properties.map((p) => (t.isObjectProperty(p) || t.isObjectMethod(p) ? literalKey(p.key) : null));
      if (keys.length && keys.every((k) => k && SEO.test(k)) && keys.some((k) => k !== "title")) add(roles, calleeId(call.callee), "useSeoMeta");
      else if (keys.length && keys.every((k) => k && HEAD.test(k))) add(roles, calleeId(call.callee), "useHead");
    }
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) {
      if (!t.isCallExpression(d.init)) continue;
      const callee = calleeId(d.init.callee);
      const storeArg = d.init.arguments.length === 1 && (t.isCallExpression(d.init.arguments[0]) || t.isIdentifier(d.init.arguments[0]));
      if (t.isObjectPattern(d.id) && storeArg && d.id.properties.every((p) => t.isObjectProperty(p))) add(roles, callee, "storeToRefs");
      else if (t.isObjectPattern(d.id) && d.id.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "t") && (d.init.arguments.length === 0 || t.isObjectExpression(d.init.arguments[0]))) add(roles, callee, "useI18n");
      if (!t.isIdentifier(d.id)) continue;
      const used = members.get(d.id.name) ?? new Set<string>();
      if (!d.init.arguments.length && [...used].some((m) => /^(push|replace|back|go|forward|resolve|currentRoute)$/.test(m))) add(roles, callee, "useRouter");
      else if (!d.init.arguments.length && [...used].some((m) => /^(params|query|fullPath|hash|matched)$/.test(m))) add(roles, callee, "useRoute");
      else if (d.init.arguments.length === 1 && t.isObjectExpression(d.init.arguments[0]) && assignedProps.has(d.id.name) && !used.has("value")) add(roles, callee, "reactive");
    }
  }
  const valueUsed = new Set<string>();
  t.traverseFast(setup.body, (node) => {
    if (t.isMemberExpression(node) && t.isIdentifier(node.object) && literalKey(node.property) === "value" && !node.computed) valueUsed.add(node.object.name);
  });
  for (const stmt of setup.body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) {
      if (!t.isIdentifier(d.id) || !t.isCallExpression(d.init) || d.init.arguments.length !== 1) continue;
      const arg = d.init.arguments[0];
      const getter = (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) && arg.params.length === 0 && !arg.async;
      if (!valueUsed.has(d.id.name)) {
        if (getter && t.isExpression(arg.body)) add(roles, calleeId(d.init.callee), "computed");
        continue;
      }
      add(roles, calleeId(d.init.callee), t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg) ? "computed" : "ref");
    }
  }
}

function declaredWithin(fn: t.Function): Set<string> {
  const names = new Set<string>();
  const bind = (node: t.Node | null | undefined) => {
    if (node) for (const name of Object.keys(t.getBindingIdentifiers(node))) names.add(name);
  };
  fn.params.forEach(bind);
  if (!t.isBlockStatement(fn.body)) return names;
  for (const stmt of fn.body.body) {
    if (t.isVariableDeclaration(stmt)) stmt.declarations.forEach((d) => bind(d.id));
    else if ((t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt)) && stmt.id) names.add(stmt.id.name);
  }
  return names;
}

export function inferVueRoles(program: NodePath<t.Program>, knownName: (local: string) => string | null): Roles {
  const counts = new Map<string, Map<string, number>>();
  const known = (name: string) => knownName(name);
  program.traverse({
    ObjectExpression(path) {
      const options = componentOptions(path.node);
      if (!options) return;
      const render = renderFunction(options);
      const compiled = isCompiledRender(render);
      if (!compiled && !(options.setup && options.name)) return;
      const local = new Map<string, Map<string, number>>();
      if (compiled) collectRenderRoles(render, local, known);
      if (options.setup) collectSetupRoles(options.setup, local);
      const models = options.props;
      if (t.isCallExpression(models) && models.arguments.length === 2 && models.arguments.every((arg) => t.isObjectExpression(arg) || t.isArrayExpression(arg)) && t.isObjectExpression(models.arguments[1]) && models.arguments[1].properties.some((p) => t.isObjectProperty(p) && /^(modelValue|\w+Modifiers|modelModifiers)$/.test(literalKey(p.key) ?? ""))) add(counts, calleeId(models.callee), "mergeModels");
      const shadowed = options.setup ? declaredWithin(options.setup) : new Set<string>();
      for (const [name, table] of local) {
        if (shadowed.has(name)) continue;
        for (const [role, n] of table) for (let i = 0; i < n; i++) add(counts, name, role);
      }
    },
    ArrayExpression(path) {
      const [key, value] = path.node.elements;
      if (path.node.elements.length !== 2 || !t.isStringLiteral(key, { value: "render" }) || !t.isIdentifier(value)) return;
      const bound = path.scope.getBinding(value.name)?.path.node;
      const render = t.isFunctionDeclaration(bound) ? bound : t.isVariableDeclarator(bound) && (t.isFunctionExpression(bound.init) || t.isArrowFunctionExpression(bound.init)) ? bound.init : null;
      if (isCompiledRender(render)) collectRenderRoles(render, counts, known);
    },
  });
  const roles: Roles = new Map();
  const taken = new Set<string>();
  const candidates: Array<{ name: string; role: string; count: number }> = [];
  for (const [name, table] of counts) {
    const ranked = [...table].sort((a, b) => b[1] - a[1]);
    const [best, second] = ranked;
    if (!best || (second && second[1] * 2 > best[1])) continue;
    candidates.push({ name, role: best[0], count: best[1] });
  }
  const REPEATABLE = /^(openBlock|createElementBlock|createElementVNode|createBlock|createVNode|createTextVNode|createCommentVNode|toDisplayString|withCtx|renderList|Fragment|withDirectives|createSlots|renderSlot|unref)$/;
  const imported = (name: string) => program.scope.getBinding(name)?.path.isImportSpecifier() === true;
  for (const { name, role, count } of candidates.sort((a, b) => b.count - a.count)) {
    if (taken.has(role) && !(REPEATABLE.test(role) && imported(name) && count >= 2)) continue;
    taken.add(role);
    roles.set(name, role);
  }
  const importKey = (name: string) => {
    const binding = program.scope.getBinding(name);
    if (!binding?.path.isImportSpecifier() || !t.isImportDeclaration(binding.path.parent)) return null;
    const imported = binding.path.node.imported;
    return `${binding.path.parent.source.value}\u0000${t.isIdentifier(imported) ? imported.name : imported.value}`;
  };
  const byImport = new Map<string, string>();
  for (const [name, role] of roles) {
    const key = importKey(name);
    if (key) byImport.set(key, role);
  }
  for (const name of counts.keys()) {
    const key = roles.has(name) ? null : importKey(name);
    if (key && byImport.has(key)) roles.set(name, byImport.get(key)!);
  }
  const sourceOf = (name: string) => {
    const binding = program.scope.getBinding(name);
    return binding?.path.isImportSpecifier() && t.isImportDeclaration(binding.path.parent) ? binding.path.parent.source.value : null;
  };
  const helperSources = new Set([...roles].filter(([, role]) => /^(openBlock|createBlock|createElementBlock|createVNode|createElementVNode|withCtx|ref|computed)$/.test(role)).map(([name]) => sourceOf(name)).filter((s): s is string => !!s));
  for (const [name, role] of roles) if (/^Transition(Group)?$/.test(role) && !helperSources.has(sourceOf(name) ?? "")) roles.delete(name);
  return roles;
}

export function renameVueHelpers(program: NodePath<t.Program>, roles: Roles): void {
  for (const [local, role] of roles) {
    const binding = program.scope.getBinding(local);
    if (!binding || local === role || program.scope.getBinding(role)) continue;
    if ([...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.getBinding(role) && ref.scope.getBinding(role) !== binding)) continue;
    program.scope.rename(local, role);
  }
}

class Unsupported extends Error {}

export interface SfcContext {
  role: (local: string) => string | null;
  componentName: (node: t.Expression) => string | null;
  hoisted: (name: string) => t.Expression | null;
  refs: Set<string>;
  propsParam: string | null;
  propNames: Set<string>;
  free?: Set<string>;
  aliases?: Map<string, string>;
  flat?: Set<string>;
}

function unsupported(what: string): never {
  throw new Unsupported(what);
}

function escapeText(text: string): string {
  return text.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;")).replace(/\{\{/g, "{{ '{{' }}");
}

function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;");
}

function rewriteExpression(node: t.Node, ctx: SfcContext, locals: Set<string>): t.Node {
  if (t.isMemberExpression(node) && !node.computed && literalKey(node.property) === "value" && t.isIdentifier(node.object) && ctx.refs.has(node.object.name) && !locals.has(node.object.name)) {
    return t.identifier(node.object.name);
  }
  if (t.isCallExpression(node) && ctx.role(calleeId(node.callee) ?? "") === "unref" && node.arguments.length === 1) return rewriteExpression(node.arguments[0]!, ctx, locals);
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.object) && ctx.propsParam && (node.object.name === ctx.propsParam || ctx.aliases?.get(node.object.name) === ctx.propsParam) && !locals.has(node.object.name)) {
    const key = literalKey(node.property);
    if (key && (RESERVED.has(key) || !t.isValidIdentifier(key))) return t.memberExpression(t.identifier("$props"), t.isValidIdentifier(key, false) ? t.identifier(key) : t.stringLiteral(key), !t.isValidIdentifier(key, false));
    return t.identifier(key ?? "props");
  }
  if (t.isCallExpression(node) && /^create/.test(ctx.role(calleeId(node.callee) ?? "") ?? "")) unsupported("vnode call inside an expression");
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.object) && !locals.has(node.object.name) && node.object.name !== ctx.propsParam && /^\$(slots|attrs|props|emit)$/.test(literalKey(node.property) ?? "")) {
    return t.identifier(literalKey(node.property)!);
  }
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.object) && ctx.flat?.has(node.object.name)) {
    const key = literalKey(node.property);
    if (key && ctx.propsParam && ctx.aliases?.get(key) === ctx.propsParam) return t.identifier("props");
    if (key && (RESERVED.has(key) || !t.isValidIdentifier(key))) return t.memberExpression(t.identifier("$props"), t.isValidIdentifier(key, false) ? t.identifier(key) : t.stringLiteral(key), !t.isValidIdentifier(key, false));
    if (key) return rewriteExpression(t.identifier(key), ctx, locals);
  }
  if (t.isIdentifier(node) && !locals.has(node.name) && ctx.aliases?.has(node.name)) return t.identifier(ctx.aliases.get(node.name)!);
  if (t.isIdentifier(node) && !locals.has(node.name)) ctx.free?.add(node.name);
  const scope = t.isFunction(node) ? new Set([...locals, ...node.params.flatMap((p) => Object.keys(t.getBindingIdentifiers(p)))]) : locals;
  const copy = { ...node } as unknown as Record<string, unknown>;
  if (t.isStringLiteral(node)) delete copy.extra;
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    if ((t.isMemberExpression(node) && key === "property" && !node.computed) || (t.isObjectProperty(node) && key === "key" && !node.computed)) continue;
    const child = copy[key];
    if (Array.isArray(child)) copy[key] = child.map((c) => (c && typeof c === "object" && "type" in c ? rewriteExpression(c as t.Node, ctx, scope) : c));
    else if (child && typeof child === "object" && "type" in child) copy[key] = rewriteExpression(child as t.Node, ctx, scope);
  }
  return copy as unknown as t.Node;
}

function templateExpression(node: t.Expression, ctx: SfcContext, locals: Set<string> = new Set()): string {
  return generate(rewriteExpression(node, ctx, locals), { jsescOption: { quotes: "single", minimal: true } }).code.replace(/;$/, "").replace(/\s*\n\s*/g, " ");
}

function unwrapCache(node: t.Node): t.Node {
  if (t.isAssignmentExpression(node) && (node.operator === "||=" || node.operator === "??=") && t.isMemberExpression(node.left)) return unwrapCache(node.right);
  if (t.isLogicalExpression(node) && node.operator === "||" && t.isMemberExpression(node.left)) {
    const right = node.right;
    if (t.isAssignmentExpression(right) && t.isMemberExpression(right.left)) return unwrapCache(right.right);
  }
  if (t.isSequenceExpression(node) && node.expressions.length === 2 && t.isCallExpression(node.expressions[0])) return unwrapCache(node.expressions[1]!);
  if (t.isParenthesizedExpression(node)) return unwrapCache(node.expression);
  return node;
}

interface Directive {
  model?: string;
  show?: string;
}

function modelTarget(handler: t.Node | undefined, ctx: SfcContext, locals: Set<string>): string | null {
  let assignment: t.Node | null | undefined = t.isArrowFunctionExpression(handler) ? handler.body : null;
  if (t.isConditionalExpression(assignment)) assignment = assignment.consequent;
  if (!t.isAssignmentExpression(assignment)) return null;
  if (t.isMemberExpression(assignment.left) && literalKey(assignment.left.property) === "value" && t.isIdentifier(assignment.left.object) && !ctx.refs.has(assignment.left.object.name)) ctx.refs.add(assignment.left.object.name);
  return templateExpression(assignment.left as t.Expression, ctx, locals);
}

function propsToAttributes(node: t.Node | undefined, ctx: SfcContext, locals: Set<string>, directive: Directive): string[] {
  let props = node;
  if (t.isCallExpression(props)) {
    const role = ctx.role(calleeId(props.callee) ?? "") ?? calleeId(props.callee);
    if (role === "mergeProps") return props.arguments.flatMap((arg) => (t.isObjectExpression(arg) || (t.isIdentifier(arg) && ctx.hoisted(arg.name)) ? propsToAttributes(arg, ctx, locals, directive) : [`v-bind="${escapeAttr(templateExpression(bindTarget(arg as t.Expression, ctx), ctx, locals))}"`]));
    if (role === "normalizeProps" || role === "guardReactiveProps") return [`v-bind="${escapeAttr(templateExpression(bindTarget(props, ctx), ctx, locals))}"`];
  }
  if (t.isIdentifier(props) && !ctx.hoisted(props.name)) return [`v-bind="${escapeAttr(templateExpression(props, ctx, locals))}"`];
  if (t.isIdentifier(props)) props = ctx.hoisted(props.name)!;
  if (!props || t.isNullLiteral(props)) return [];
  if (!t.isObjectExpression(props)) unsupported("dynamic props");
  const attrs: string[] = [];
  const models = new Set<string>();
  for (const prop of props.properties) {
    const key = t.isObjectProperty(prop) && !prop.computed ? literalKey(prop.key) : null;
    if (!key?.startsWith("onUpdate:") || directive.model) continue;
    const value = unwrapCache((prop as t.ObjectProperty).value);
    const first = t.isArrayExpression(value) ? value.elements[0] : value;
    let body: t.Node | null | undefined = t.isArrowFunctionExpression(first ? unwrapCache(first) : null) ? (unwrapCache(first!) as t.ArrowFunctionExpression).body : null;
    if (t.isConditionalExpression(body)) body = body.consequent;
    if (t.isAssignmentExpression(body)) models.add(key.slice("onUpdate:".length));
  }
  for (const prop of props.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) unsupported("spread or computed props");
    const key = literalKey(prop.key);
    if (!key) unsupported("props key");
    if (models.has(key) || (models.has("modelValue") && key === "modelModifiers")) continue;
    const value = unwrapCache(prop.value);
    if (key.startsWith("onUpdate:")) {
      if (directive.model) continue;
      const model = key.slice("onUpdate:".length);
      const handlers = (t.isArrayExpression(value) ? value.elements : [value]).filter((h): h is t.Expression => t.isExpression(h)).map((h) => unwrapCache(h) as t.Expression);
      const target = modelTarget(handlers[0], ctx, locals);
      if (target) attrs.push(model === "modelValue" ? `v-model="${escapeAttr(target)}"` : `v-model:${model}="${escapeAttr(target)}"`);
      const event = `update:${model.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      for (const handler of target ? handlers.slice(1) : handlers) attrs.push(`@${event}="${escapeAttr(templateExpression(handler, ctx, locals))}"`);
      continue;
    }
    if (/^on[A-Z]/.test(key)) {
      let name = key.slice(2);
      const options: string[] = [];
      for (let match = /(Once|Capture|Passive)$/.exec(name); match && name.length > match[1]!.length; match = /(Once|Capture|Passive)$/.exec(name)) {
        options.unshift(`.${match[1]!.toLowerCase()}`);
        name = name.slice(0, -match[1]!.length);
      }
      const event = name.replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      const list = t.isArrayExpression(value) ? value.elements.filter((h): h is t.Expression => t.isExpression(h)).map((h) => unwrapCache(h) as t.Expression) : [value as t.Expression];
      for (const entry of list) {
        const { handler, modifiers } = eventHandler(entry, ctx);
        attrs.push(`@${event}${modifiers.map((m) => `.${m}`).join("")}${options.join("")}="${escapeAttr(templateExpression(handler, ctx, locals))}"`);
      }
      continue;
    }
    if (key === "ref_for") continue;
    if (key === "ref_key" && t.isStringLiteral(value)) {
      attrs.push(`ref="${escapeAttr(value.value)}"`);
      continue;
    }
    if (key === "ref" && props.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "ref_key")) continue;
    if (key === "modelValue" && directive.model) continue;
    if (key === "key" && t.isNumericLiteral(value)) continue;
    if ((key === "class" || key === "style") && t.isCallExpression(value) && value.arguments.length === 1 && /^normalize(Class|Style)$/.test(ctx.role(calleeId(value.callee) ?? "") ?? calleeId(value.callee) ?? "") && t.isExpression(value.arguments[0])) {
      const inner = value.arguments[0];
      attrs.push(t.isStringLiteral(inner) ? `${key}="${escapeAttr(inner.value)}"` : `:${key}="${escapeAttr(templateExpression(inner, ctx, locals))}"`);
      continue;
    }
    if (t.isStringLiteral(value)) attrs.push(`${key}="${escapeAttr(value.value)}"`);
    else if (t.isExpression(value)) attrs.push(`:${key}="${escapeAttr(templateExpression(value, ctx, locals))}"`);
    else unsupported("prop value");
  }
  return attrs;
}

function eventHandler(node: t.Expression, ctx: SfcContext): { handler: t.Expression; modifiers: string[] } {
  let handler = unwrapCache(node) as t.Expression;
  const modifiers: string[] = [];
  for (;;) {
    if (!t.isCallExpression(handler) || handler.arguments.length !== 2 || !t.isArrayExpression(handler.arguments[1]) || !t.isExpression(handler.arguments[0])) break;
    const role = ctx.role(calleeId(handler.callee) ?? "") ?? calleeId(handler.callee);
    if (role !== "withModifiers" && role !== "withKeys") break;
    const names = handler.arguments[1].elements.flatMap((e) => (t.isStringLiteral(e) ? [e.value] : []));
    modifiers.push(...names);
    handler = unwrapCache(handler.arguments[0]) as t.Expression;
  }
  if (t.isArrowFunctionExpression(handler) && t.isExpression(handler.body) && handler.params.length <= 1) {
    const param = handler.params[0];
    const usesParam = t.isIdentifier(param) && JSON.stringify(handler.body).includes(`"name":"${param.name}"`);
    if (!usesParam) handler = handler.body;
  }
  return { handler, modifiers };
}

function bindTarget(node: t.Expression, ctx: SfcContext): t.Expression {
  let current: t.Expression = node;
  while (t.isCallExpression(current) && current.arguments.length === 1 && /^(normalizeProps|guardReactiveProps)$/.test(ctx.role(calleeId(current.callee) ?? "") ?? calleeId(current.callee) ?? "") && t.isExpression(current.arguments[0])) {
    current = current.arguments[0];
  }
  return current;
}

function textChildren(node: t.Node, ctx: SfcContext, locals: Set<string>): string | null {
  if (t.isStringLiteral(node)) return escapeText(node.value);
  if (t.isTemplateLiteral(node)) {
    return node.quasis.map((q, i) => escapeText(q.value.cooked ?? "") + (node.expressions[i] ? textChildren(node.expressions[i] as t.Node, ctx, locals) : "")).join("");
  }
  if (t.isBinaryExpression(node, { operator: "+" })) {
    const left = textChildren(node.left, ctx, locals);
    const right = textChildren(node.right, ctx, locals);
    if (left !== null && right !== null) return left + right;
  }
  if (t.isCallExpression(node) && calleeId(node.callee) === "toDisplayString" && t.isExpression(node.arguments[0])) return `{{ ${templateExpression(node.arguments[0], ctx, locals)} }}`;
  if (t.isCallExpression(node) && ctx.role(calleeId(node.callee) ?? "") === "toDisplayString" && t.isExpression(node.arguments[0])) return `{{ ${templateExpression(node.arguments[0], ctx, locals)} }}`;
  return null;
}

function renderNode(raw: t.Node, ctx: SfcContext, depth: number, locals: Set<string>, extra: string[] = []): string[] {
  const node = unwrapCache(raw);
  const pad = "  ".repeat(depth);
  if (t.isSpreadElement(node)) return renderChildren(node.argument, ctx, depth, locals);
  if (t.isArrayExpression(node)) return node.elements.flatMap((el) => (el ? renderNode(el, ctx, depth, locals) : []));
  if (t.isConditionalExpression(node)) return renderConditional(node, ctx, depth, locals, extra);
  const text = textChildren(node, ctx, locals);
  if (text !== null && !extra.length) return [`${pad}${text}`];
  if (!t.isCallExpression(node)) unsupported(`node ${node.type}`);
  const callee = calleeId(node.callee);
  const role = callee ? (ctx.role(callee) ?? callee) : null;
  const args = node.arguments;
  if (role === "withDirectives") {
    const [vnode, list] = args;
    const directive: Directive = {};
    const attrs: string[] = [];
    if (!t.isArrayExpression(list)) unsupported("directives");
    for (const item of list.elements) {
      if (!t.isArrayExpression(item)) unsupported("directive");
      const [dir, value, arg, modifiers] = item.elements;
      const name = t.isIdentifier(dir) ? (ctx.role(dir.name) ?? dir.name) : t.isMemberExpression(dir) && !dir.computed && t.isIdentifier(dir.property) ? dir.property.name : null;
      if (name && /^v[A-Z][\w$]*$/.test(name) && !/^vModel/.test(name) && name !== "vShow") {
        const kebab = name.slice(1).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        const argText = t.isStringLiteral(arg) ? `:${arg.value}` : "";
        const mods = t.isObjectExpression(modifiers) ? modifiers.properties.flatMap((p) => (t.isObjectProperty(p) && literalKey(p.key) ? [`.${literalKey(p.key)}`] : [])).join("") : "";
        const bound = t.isExpression(value) && !t.isIdentifier(value, { name: "undefined" }) && !(t.isUnaryExpression(value) && value.operator === "void") ? `="${escapeAttr(templateExpression(value, ctx, locals))}"` : "";
        attrs.push(`v-${kebab}${argText}${mods}${bound}`);
        continue;
      }
      if (!name || !t.isExpression(value)) unsupported("directive");
      const expr = templateExpression(value, ctx, locals);
      const inner = unwrapCache(vnode as t.Node);
      const innerProps = t.isCallExpression(inner) ? inner.arguments[1] : null;
      const withUpdate = t.isObjectExpression(innerProps) && innerProps.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "onUpdate:modelValue");
      if (/^vModel/.test(name) || (withUpdate && !directive.model)) {
        directive.model = expr;
        attrs.push(`v-model="${escapeAttr(expr)}"`);
      } else if (name === "vShow") attrs.push(`v-show="${escapeAttr(expr)}"`);
      else unsupported(`directive ${name}`);
    }
    return renderNode(vnode as t.Node, ctx, depth, locals, [...extra, ...attrs, ...(directive.model ? ["__model"] : [])]);
  }
  if (role === "createCommentVNode") return [];
  if (role === "createStaticVNode" && t.isStringLiteral(args[0])) return [`${pad}${args[0].value}`];
  if (role === "createTextVNode") {
    if (!args[0]) return [];
    const text = textChildren(args[0] as t.Node, ctx, locals);
    return text !== null ? [`${pad}${text}`] : unsupported(`text vnode :: ${args[0] ? generate(args[0]).code.slice(0, 160) : ""}`);
  }
  if (role === "renderSlot") {
    const [, nameNode, slotProps, fallback] = args;
    const name = t.isStringLiteral(nameNode) ? nameNode.value : unsupported("slot name");
    const attrs = [...extra.filter((a) => a !== "__model"), ...(name === "default" ? [] : [`name="${escapeAttr(name)}"`]), ...propsToAttributes(slotProps as t.Node | undefined, ctx, locals, {})];
    const fallbackBody = t.isArrowFunctionExpression(fallback) || t.isFunctionExpression(fallback) ? (t.isBlockStatement(fallback.body) ? (fallback.body.body.find((b): b is t.ReturnStatement => t.isReturnStatement(b))?.argument ?? null) : fallback.body) : null;
    const inner = fallbackBody ? renderNode(fallbackBody, ctx, depth + 1, locals) : [];
    const open = `${pad}<slot${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
    if (!inner.length) return [`${open} />`];
    if (inner.length === 1 && !inner[0]!.trim().startsWith("<")) return [`${open}>${inner[0]!.trim()}</slot>`];
    return [`${open}>`, ...inner, `${pad}</slot>`];
  }
  if (role === "renderList") unsupported("renderList outside v-for");
  if (!role || !/^(createElementBlock|createElementVNode|createBlock|createVNode)$/.test(role)) unsupported(`call ${callee} :: ${generate(node).code.slice(0, 160).replace(/\s+/g, " ")}`);
  const [tagNode, propsNode, childrenNode] = args;
  let tag: string;
  const dynamic = t.isCallExpression(tagNode) && (ctx.role(calleeId(tagNode.callee) ?? "") ?? calleeId(tagNode.callee)) === "resolveDynamicComponent" ? tagNode.arguments[0] : null;
  if (dynamic && t.isExpression(dynamic)) {
    tag = "component";
    extra = [`:is="${escapeAttr(templateExpression(dynamic, ctx, locals))}"`, ...extra];
  } else if (t.isStringLiteral(tagNode)) tag = tagNode.value;
  else if (t.isIdentifier(tagNode) && (ctx.role(tagNode.name) ?? tagNode.name) === "Fragment") {
    const attrs = [...extra.filter((e) => e !== "__model"), ...propsToAttributes(propsNode as t.Node | undefined, ctx, locals, {})];
    if (!attrs.length) return renderFragment(childrenNode as t.Node | undefined, ctx, depth, locals);
    return [`${pad}<template ${attrs.join(" ")}>`, ...renderFragment(childrenNode as t.Node | undefined, ctx, depth + 1, locals), `${pad}</template>`];
  } else {
    const name = ctx.componentName(tagNode as t.Expression);
    if (name) tag = name;
    else if (t.isExpression(tagNode)) {
      tag = "component";
      extra = [`:is="${escapeAttr(templateExpression(tagNode, ctx, locals))}"`, ...extra];
    } else unsupported("component tag");
  }
  const model = extra.includes("__model");
  const attrs = [...extra.filter((e) => e !== "__model"), ...propsToAttributes(propsNode as t.Node | undefined, ctx, locals, model ? { model: "set" } : {})];
  const open = `${pad}<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
  const dynamicSlots = childrenNode && t.isCallExpression(childrenNode) && (ctx.role(calleeId(childrenNode.callee) ?? "") ?? calleeId(childrenNode.callee)) === "createSlots" ? renderDynamicSlots(childrenNode, ctx, depth + 1, locals) : null;
  const slotChildren = dynamicSlots ?? (childrenNode && t.isObjectExpression(childrenNode) && (!t.isStringLiteral(tagNode) || dynamic) ? renderSlots(childrenNode, ctx, depth + 1, locals) : null);
  const children = slotChildren ?? (childrenNode && !t.isNullLiteral(childrenNode) ? renderChildren(childrenNode as t.Node, ctx, depth + 1, locals) : []);
  if (!children.length) return [VOID_TAGS.has(tag) ? `${open}>` : `${open} />`];
  if (children.length === 1 && !children[0]!.trim().startsWith("<") && children[0]!.length < 80) return [`${open}>${children[0]!.trim()}</${tag}>`];
  return [`${open}>`, ...children, `${pad}</${tag}>`];
}

function renderChildren(node: t.Node, ctx: SfcContext, depth: number, locals: Set<string>): string[] {
  return renderNode(node, ctx, depth, locals);
}

function renderSlots(object: t.ObjectExpression, ctx: SfcContext, depth: number, locals: Set<string>): string[] {
  const out: string[] = [];
  const named = object.properties.filter((p) => t.isObjectProperty(p) && literalKey(p.key) !== "_");
  for (const prop of named) {
    if (!t.isObjectProperty(prop) || !t.isCallExpression(prop.value)) unsupported("slot");
    const fn = prop.value.arguments[0];
    if (!(t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn))) unsupported("slot function");
    const body = t.isBlockStatement(fn.body) ? (fn.body.body.find((s): s is t.ReturnStatement => t.isReturnStatement(s))?.argument ?? null) : fn.body;
    if (!body) unsupported("slot body");
    const scope = new Set([...locals, ...fn.params.flatMap((p) => Object.keys(t.getBindingIdentifiers(p)))]);
    const key = literalKey(prop.key);
    const inner = renderNode(body, ctx, named.length === 1 && key === "default" && !fn.params.length ? depth : depth + 1, scope);
    if (named.length === 1 && key === "default" && !fn.params.length) out.push(...inner);
    else {
      const params = fn.params.length ? `="${escapeAttr(print(fn.params[0]!))}"` : "";
      out.push(`${"  ".repeat(depth)}<template #${key}${params}>`, ...inner, `${"  ".repeat(depth)}</template>`);
    }
  }
  return out;
}

function dynamicSlot(entry: t.Node | null, ctx: SfcContext, depth: number, locals: Set<string>, directive: string): string[] {
  if (!t.isObjectExpression(entry)) unsupported("dynamic slot");
  const field = (key: string) => entry.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === key)?.value;
  const name = field("name");
  const fnCall = field("fn");
  const fn = t.isCallExpression(fnCall) ? fnCall.arguments[0] : fnCall;
  if (!name || !(t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn))) unsupported("dynamic slot");
  const body = t.isBlockStatement(fn.body) ? (fn.body.body.find((st): st is t.ReturnStatement => t.isReturnStatement(st))?.argument ?? null) : fn.body;
  if (!body) unsupported("slot body");
  const scope = new Set([...locals, ...fn.params.flatMap((p) => Object.keys(t.getBindingIdentifiers(p)))]);
  const slot = t.isStringLiteral(name) ? `#${name.value}` : `#[${templateExpression(name as t.Expression, ctx, locals)}]`;
  const params = fn.params.length ? `="${escapeAttr(print(fn.params[0]!))}"` : "";
  const pad = "  ".repeat(depth);
  return [`${pad}<template ${directive ? `${directive} ` : ""}${slot}${params}>`, ...renderNode(body, ctx, depth + 1, scope), `${pad}</template>`];
}

function renderDynamicSlots(call: t.CallExpression, ctx: SfcContext, depth: number, locals: Set<string>): string[] {
  const [base, list] = call.arguments;
  if (!t.isObjectExpression(base) || !t.isArrayExpression(list)) unsupported("createSlots");
  const out = renderSlots(base, ctx, depth, locals);
  for (const raw of list.elements) {
    const entry = raw ? unwrapCache(raw) : null;
    if (t.isConditionalExpression(entry) && isUndefinedLike(entry.alternate)) out.push(...dynamicSlot(entry.consequent, ctx, depth, locals, `v-if="${escapeAttr(templateExpression(entry.test, ctx, locals))}"`));
    else if (t.isLogicalExpression(entry, { operator: "&&" })) out.push(...dynamicSlot(entry.right, ctx, depth, locals, `v-if="${escapeAttr(templateExpression(entry.left, ctx, locals))}"`));
    else if (t.isCallExpression(entry) && (ctx.role(calleeId(entry.callee) ?? "") ?? calleeId(entry.callee)) === "renderList") {
      const [source, fn] = entry.arguments;
      if (!t.isExpression(source) || !(t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn))) unsupported("slot list");
      const body = t.isBlockStatement(fn.body) ? (fn.body.body.find((st): st is t.ReturnStatement => t.isReturnStatement(st))?.argument ?? null) : fn.body;
      const params = fn.params.map((p) => print(p));
      const scope = new Set([...locals, ...fn.params.flatMap((p) => Object.keys(t.getBindingIdentifiers(p)))]);
      out.push(...dynamicSlot(body ?? null, ctx, depth, scope, `v-for="${escapeAttr(`${params.length > 1 ? `(${params.join(", ")})` : params[0] ?? "item"} in ${templateExpression(source, ctx, locals)}`)}"`));
    } else if (entry) out.push(...dynamicSlot(entry, ctx, depth, locals, ""));
  }
  return out;
}

function isUndefinedLike(node: t.Node): boolean {
  return t.isIdentifier(node, { name: "undefined" }) || (t.isUnaryExpression(node, { operator: "void" }) && t.isNumericLiteral(node.argument));
}

function renderFragment(children: t.Node | undefined, ctx: SfcContext, depth: number, locals: Set<string>): string[] {
  if (!children) return [];
  const node = unwrapCache(children);
  if (t.isCallExpression(node) && (ctx.role(calleeId(node.callee) ?? "") ?? calleeId(node.callee)) === "renderList") return renderList(node, ctx, depth, locals);
  if (t.isCallExpression(node) && calleeId(node.callee) === "renderList") return renderList(node, ctx, depth, locals);
  return renderNode(node, ctx, depth, locals);
}

function renderList(call: t.CallExpression, ctx: SfcContext, depth: number, locals: Set<string>): string[] {
  const [source, fn] = call.arguments;
  if (!t.isExpression(source) || !(t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn))) unsupported("renderList");
  const params = fn.params.map((p) => print(p));
  const scope = new Set([...locals, ...fn.params.flatMap((p) => Object.keys(t.getBindingIdentifiers(p)))]);
  const body = t.isBlockStatement(fn.body) ? (fn.body.body.find((s): s is t.ReturnStatement => t.isReturnStatement(s))?.argument ?? null) : fn.body;
  if (!body) unsupported("renderList body");
  const alias = params.length > 1 ? `(${params.join(", ")})` : (params[0] ?? "item");
  return renderNode(body, ctx, depth, scope, [`v-for="${escapeAttr(`${alias} in ${templateExpression(source, ctx, locals)}`)}"`]);
}

function renderConditional(node: t.ConditionalExpression, ctx: SfcContext, depth: number, locals: Set<string>, extra: string[]): string[] {
  const out: string[] = [];
  let current: t.Node = node;
  let first = true;
  const isComment = (n: t.Node) => {
    const inner = unwrapCache(n);
    return t.isCallExpression(inner) && (ctx.role(calleeId(inner.callee) ?? "") ?? calleeId(inner.callee)) === "createCommentVNode";
  };
  while (t.isConditionalExpression(current)) {
    const nested = (n: t.Node) => t.isConditionalExpression(unwrapCache(n));
    if ((isComment(current.consequent) && !isComment(current.alternate)) || (nested(current.consequent) && !nested(current.alternate))) {
      const negated = t.isUnaryExpression(current.test, { operator: "!" }) ? current.test.argument : t.unaryExpression("!", current.test);
      current = t.conditionalExpression(negated, current.alternate, current.consequent);
    }
    const test = templateExpression(current.test, ctx, locals);
    const directive = `${first ? "v-if" : "v-else-if"}="${escapeAttr(test)}"`;
    if (nested(current.consequent)) {
      const pad = "  ".repeat(depth);
      out.push(`${pad}<template ${[...extra, directive].join(" ")}>`, ...renderNode(current.consequent, ctx, depth + 1, locals), `${pad}</template>`);
    } else out.push(...renderNode(current.consequent, ctx, depth, locals, [...extra, directive]));
    first = false;
    current = unwrapCache(current.alternate);
  }
  if (t.isCallExpression(current) && ctx.role(calleeId(current.callee) ?? "") === "createCommentVNode") return out;
  out.push(...renderNode(current, ctx, depth, locals, [...extra, "v-else"]));
  return out;
}

function renderAliases(body: t.BlockStatement): Map<string, t.Expression> {
  const aliases = new Map<string, t.Expression>();
  for (const stmt of body.body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) {
      if (!t.isIdentifier(d.id)) continue;
      if (t.isIdentifier(d.init)) aliases.set(d.id.name, d.init);
      else if (t.isCallExpression(d.init) && (d.init.arguments.length === 1 || (d.init.arguments.length === 2 && t.isBooleanLiteral(d.init.arguments[1], { value: true }))) && t.isStringLiteral(d.init.arguments[0]) && /^[A-Za-z][\w-]*$/.test(d.init.arguments[0].value)) aliases.set(d.id.name, d.init);
    }
  }
  return aliases;
}

function substitute(node: t.Expression, aliases: Map<string, t.Expression>): t.Expression {
  if (!aliases.size) return node;
  const copy = t.cloneNode(node, true);
  t.traverse(copy, (child, ancestors) => {
    if (!t.isIdentifier(child) || !aliases.has(child.name)) return;
    const parent = ancestors.at(-1);
    if (parent && ((t.isMemberExpression(parent.node) && parent.key === "property" && !parent.node.computed) || (t.isObjectProperty(parent.node) && parent.key === "key" && !parent.node.computed))) return;
    const target = aliases.get(child.name)!;
    if (t.isIdentifier(target)) child.name = target.name;
    else if (parent && t.isCallExpression(parent.node) && parent.key === "arguments") (parent.node.arguments as t.Node[])[parent.index ?? 0] = t.cloneNode(target, true);
  });
  return copy;
}

function returnedExpression(statements: t.Statement[], ctx: SfcContext): t.Expression | null {
  const skip = (s: t.Statement) => t.isVariableDeclaration(s) || (t.isExpressionStatement(s) && t.isCallExpression(s.expression) && ctx.role(calleeId(s.expression.callee) ?? "") === "openBlock");
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!;
    if (skip(stmt)) continue;
    if (t.isReturnStatement(stmt)) return stmt.argument ?? null;
    if (t.isIfStatement(stmt)) {
      const consequent = returnedExpression(t.isBlockStatement(stmt.consequent) ? stmt.consequent.body : [stmt.consequent], ctx);
      const alternate = stmt.alternate ? returnedExpression(t.isBlockStatement(stmt.alternate) ? stmt.alternate.body : [stmt.alternate], ctx) : returnedExpression(statements.slice(i + 1), ctx);
      return consequent && alternate ? t.conditionalExpression(stmt.test, consequent, alternate) : null;
    }
    return null;
  }
  return null;
}

export function renderTemplate(render: t.Function, ctx: SfcContext): string | null {
  try {
    const body = render.body;
    const returned = t.isBlockStatement(body) ? returnedExpression(body.body, ctx) : body;
    if (!returned) {
      return null;
    }
    const aliases = t.isBlockStatement(body) ? renderAliases(body) : new Map<string, t.Expression>();
    const result = substitute(returned, aliases);
    const allowed = (s: t.Statement) => t.isReturnStatement(s) || t.isIfStatement(s) || (t.isExpressionStatement(s) && t.isCallExpression(s.expression) && ctx.role(calleeId(s.expression.callee) ?? "") === "openBlock") || (t.isVariableDeclaration(s) && s.declarations.every((d) => t.isIdentifier(d.id) && aliases.has(d.id.name)));
    if (t.isBlockStatement(body) && !body.body.every(allowed)) {
      return null;
    }
    if (render.params.length >= 4) ctx.flat = new Set(render.params.filter((_, i) => i !== 1).flatMap((p) => (t.isIdentifier(p) ? [p.name] : [])));
    const lines = renderNode(result, ctx, 1, new Set(render.params.flatMap((p) => Object.keys(t.getBindingIdentifiers(p)))));
    return lines.length ? `<template>\n${lines.join("\n")}\n</template>\n` : null;
  } catch (err) {
    if (err instanceof Unsupported) {
      return null;
    }
    throw err;
  }
}

export function isVueApi(name: string): boolean {
  return VUE_API.has(name);
}

const COMPOSABLES: Record<string, string> = {
  useI18n: "vue-i18n",
  storeToRefs: "pinia",
  useRoute: "vue-router",
  useRouter: "vue-router",
  useSeoMeta: "@unhead/vue",
  useHead: "@unhead/vue",
};

export function composableSource(name: string): string | null {
  return COMPOSABLES[name] ?? null;
}
