import type { NodePath } from "@babel/traverse";
import { literalKey, parseProgram, print, t, traverse } from "../unpack/ast.ts";

class Unsupported extends Error {}

function unsupported(reason: string): never {
  throw new Unsupported(reason);
}

type Node = { kind: "element"; index: number; tag: string; attrs: string[]; children: Node[] } | { kind: "text"; index: number; value: string | null } | { kind: "block"; index: number; text: string[] } | { kind: "projection"; index: number; selector: string };

interface Scope {
  params: string[];
  item: string | null;
  alias: string;
  parent: Scope | null;
}

interface Condition {
  group: number;
  test: string;
  alias?: string;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function calleeName(node: t.Node | null | undefined): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && !node.computed) return literalKey(node.property);
  return null;
}

function flattenCalls(expr: t.Expression): t.CallExpression[] {
  if (t.isSequenceExpression(expr)) return expr.expressions.flatMap((e) => flattenCalls(e));
  if (!t.isCallExpression(expr)) unsupported(`statement ${expr.type}`);
  if (t.isCallExpression(expr.callee)) return [...flattenCalls(expr.callee), t.callExpression(t.identifier(calleeName(innermost(expr.callee)) ?? "?"), expr.arguments)];
  return [expr];
}

function innermost(call: t.CallExpression): t.Expression {
  return t.isCallExpression(call.callee) ? innermost(call.callee) : (call.callee as t.Expression);
}

function blocks(fn: t.Function): { create: t.Statement[]; update: t.Statement[]; prelude: t.Statement[] } {
  const out = { create: [] as t.Statement[], update: [] as t.Statement[], prelude: [] as t.Statement[] };
  if (!t.isBlockStatement(fn.body)) unsupported("template body");
  const flags = t.isIdentifier(fn.params[0]) ? fn.params[0].name : null;
  for (const stmt of fn.body.body) {
    if (t.isIfStatement(stmt) && t.isBinaryExpression(stmt.test, { operator: "&" }) && t.isIdentifier(stmt.test.left, { name: flags ?? "" }) && t.isNumericLiteral(stmt.test.right)) {
      const body = t.isBlockStatement(stmt.consequent) ? stmt.consequent.body : [stmt.consequent];
      (stmt.test.right.value === 1 ? out.create : out.update).push(...body);
    } else if (t.isExpressionStatement(stmt) && t.isLogicalExpression(stmt.expression, { operator: "&&" }) && t.isBinaryExpression(stmt.expression.left, { operator: "&" }) && t.isNumericLiteral(stmt.expression.left.right)) {
      (stmt.expression.left.right.value === 1 ? out.create : out.update).push(t.expressionStatement(stmt.expression.right));
    } else out.prelude.push(stmt);
  }
  return out;
}

function constAttrs(consts: t.ArrayExpression | null, index: number | null): string[] {
  if (!consts || index === null) return [];
  const entry = consts.elements[index];
  if (!t.isArrayExpression(entry)) return [];
  const attrs: string[] = [];
  let marker = 0;
  for (let i = 0; i < entry.elements.length; i++) {
    const item = entry.elements[i];
    if (t.isNumericLiteral(item)) {
      marker = item.value;
      continue;
    }
    if (!t.isStringLiteral(item)) continue;
    if (marker === 0) {
      const value = entry.elements[i + 1];
      attrs.push(t.isStringLiteral(value) ? (value.value === "" ? item.value : `${item.value}="${value.value.replace(/"/g, "&quot;")}"`) : item.value);
      i++;
    } else if (marker === 1) attrs.push(`__class:${item.value}`);
    else if (marker === 2) {
      const value = entry.elements[i + 1];
      if (t.isStringLiteral(value)) attrs.push(`__style:${item.value}:${value.value}`);
      i++;
    }
  }
  const classes = attrs.filter((a) => a.startsWith("__class:")).map((a) => a.slice(8));
  const styles = attrs.filter((a) => a.startsWith("__style:")).map((a) => a.slice(8).replace(":", ": "));
  return [...attrs.filter((a) => !a.startsWith("__")), ...(classes.length ? [`class="${classes.join(" ")}"`] : []), ...(styles.length ? [`style="${styles.join("; ")}"`] : [])];
}

function expression(node: t.Node, scope: Scope, locals: Map<string, string>, components: ReadonlySet<string> = new Set(), ctx?: Context, temporaries?: ReadonlySet<string>): string {
  const copy = t.cloneNode(node, true) as t.Node;
  const file = t.file(t.program([t.expressionStatement(copy as t.Expression)]));
  traverse(file, {
    ConditionalExpression(path) {
      if (!temporaries) return;
      const { test, consequent, alternate } = path.node;
      if (!t.isBinaryExpression(test, { operator: "==" }) || !t.isNullLiteral(test.right) || !t.isNullLiteral(consequent) || !t.isAssignmentExpression(test.left, { operator: "=" }) || !t.isIdentifier(test.left.left) || !temporaries.has(test.left.left.name)) return;
      if (t.isMemberExpression(alternate) && t.isExpression(alternate.property) && t.isIdentifier(alternate.object, { name: test.left.left.name })) {
        path.replaceWith(t.optionalMemberExpression(test.left.right, alternate.property, alternate.computed, true));
      }
    },
    AssignmentExpression(path) {
      if (temporaries) unsupported(`update assignment ${print(path.node.left)}`);
    },
    CallExpression(path) {
      const name = ctx?.names(calleeName(path.node.callee) ?? "") ?? "";
      const pure = /^ɵɵpureFunction([0-9])$/.exec(name);
      if (!pure) return;
      const [slot, factory, ...values] = path.node.arguments;
      const fn = t.isIdentifier(factory) ? ctx?.functions.get(factory.name) : factory;
      if (!t.isNumericLiteral(slot) || values.length !== Number(pure[1]) || (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn) && !t.isFunctionDeclaration(fn))) unsupported(`${name} factory`);
      const first = t.isBlockStatement(fn.body) && fn.body.body.length === 1 ? fn.body.body[0] : undefined;
      const result = t.isReturnStatement(first) ? first.argument : fn.body;
      if (!t.isExpression(result) || fn.params.length !== values.length || !fn.params.every((param) => t.isIdentifier(param)) || !values.every((value) => t.isExpression(value))) unsupported(`${name} expression`);
      const args = new Map(fn.params.map((param, i) => [(param as t.Identifier).name, values[i] as t.Expression]));
      const body = t.expressionStatement(t.cloneNode(result, true));
      traverse(t.file(t.program([body])), {
        ReferencedIdentifier(ref) {
          const arg = args.get(ref.node.name);
          if (!arg) unsupported(`${name} free variable ${ref.node.name}`);
          ref.replaceWith(t.cloneNode(arg, true));
          ref.skip();
        },
      });
      path.replaceWith(body.expression);
    },
    MemberExpression(path) {
      const object = path.node.object;
      if (t.isIdentifier(object) && (isComponent(object.name, scope) || components.has(object.name))) {
        path.replaceWith(path.node.computed ? t.identifier(print(path.node.property)) : path.node.property);
        return;
      }
      if (t.isIdentifier(object) && !path.node.computed && literalKey(path.node.property) === "$implicit" && scope.params.includes(object.name) && scope.item) path.replaceWith(t.identifier(scope.alias));
    },
    Identifier(path) {
      const local = locals.get(path.node.name);
      if (local && path.isReferencedIdentifier()) path.replaceWith(t.identifier(local));
    },
  });
  const statement = file.program.body[0];
  return t.isExpressionStatement(statement) ? print(statement.expression).replace(/;$/, "").replace(/\s*\n\s*/g, " ") : "";
}

function isComponent(name: string, scope: Scope): boolean {
  let current: Scope | null = scope;
  while (current) {
    if (!current.item && current.params[1] === name) return true;
    current = current.parent;
  }
  return false;
}

function listenerBody(handler: t.Node, scope: Scope, names: (name: string) => string): string {
  if (!t.isFunctionExpression(handler) && !t.isArrowFunctionExpression(handler)) unsupported("listener");
  const locals = new Map<string, string>();
  if (t.isIdentifier(handler.params[0])) locals.set(handler.params[0].name, "$event");
  const body = t.isBlockStatement(handler.body) ? handler.body.body : [t.returnStatement(handler.body)];
  const parts: string[] = [];
  const componentAliases: string[] = [];
  for (const stmt of body) {
    if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1 && t.isIdentifier(stmt.declarations[0]!.id)) {
      const d = stmt.declarations[0]!;
      const init = d.init;
      if (t.isMemberExpression(init) && literalKey(init.property) === "$implicit") {
        locals.set((d.id as t.Identifier).name, scope.alias);
        continue;
      }
      if (t.isCallExpression(init) && (names(calleeName(init.callee) ?? "") === "ɵɵnextContext" || (init.arguments.length === 0 && !calleeName(init.callee)?.startsWith("ɵɵ")))) {
        componentAliases.push((d.id as t.Identifier).name);
        continue;
      }
      unsupported("listener local");
    }
    const expr = t.isReturnStatement(stmt) ? stmt.argument : t.isExpressionStatement(stmt) ? stmt.expression : null;
    if (!expr) unsupported("listener statement");
    let value: t.Expression = expr;
    if (t.isCallExpression(value)) {
      const helper = names(calleeName(value.callee) ?? "");
      if (helper === "ɵɵrestoreView") continue;
      if (helper === "ɵɵresetView" && t.isExpression(value.arguments[0])) value = value.arguments[0];
    }
    parts.push(expression(value, { ...scope, params: [...scope.params], parent: { params: ["", ...componentAliases], item: null, alias: "", parent: null } }, locals));
  }
  return parts.join("; ");
}

interface Context {
  consts: t.ArrayExpression | null;
  functions: Map<string, t.Function>;
  names: (callee: string) => string;
  projectionSelectors: readonly string[] | undefined;
}

function twoWayTarget(handler: t.Node | null | undefined, scope: Scope, ctx: Context): string {
  if ((!t.isFunctionExpression(handler) && !t.isArrowFunctionExpression(handler)) || !t.isIdentifier(handler.params[0]) || !t.isBlockStatement(handler.body)) unsupported("two-way listener");
  const event = handler.params[0].name;
  const assignment = handler.body.body.find((stmt) => t.isIfStatement(stmt) && t.isUnaryExpression(stmt.test, { operator: "!" }) && t.isCallExpression(stmt.test.argument) && ctx.names(calleeName(stmt.test.argument.callee) ?? "") === "ɵɵtwoWayBindingSet");
  if (!t.isIfStatement(assignment) || !t.isUnaryExpression(assignment.test) || !t.isCallExpression(assignment.test.argument)) unsupported("two-way listener target");
  const [target, value] = assignment.test.argument.arguments;
  if (!t.isMemberExpression(target) || !t.isIdentifier(value, { name: event })) unsupported("two-way listener arguments");
  const consequent = t.isBlockStatement(assignment.consequent) && assignment.consequent.body.length === 1 ? assignment.consequent.body[0] : assignment.consequent;
  const fallback = t.isExpressionStatement(consequent) ? consequent.expression : null;
  if (assignment.alternate || !t.isAssignmentExpression(fallback, { operator: "=" }) || !t.isNodesEquivalent(fallback.left, target) || !t.isIdentifier(fallback.right, { name: event })) unsupported("two-way listener fallback");
  const components = new Set<string>();
  for (const stmt of handler.body.body) {
    if (stmt === assignment) continue;
    if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
      const { id, init } = stmt.declarations[0]!;
      if (t.isIdentifier(id) && t.isCallExpression(init) && ctx.names(calleeName(init.callee) ?? "") === "ɵɵnextContext" && init.arguments.length <= 1) {
        components.add(id.name);
        continue;
      }
    }
    const expr = t.isReturnStatement(stmt) ? stmt.argument : t.isExpressionStatement(stmt) ? stmt.expression : null;
    if (t.isReturnStatement(stmt) && t.isIdentifier(expr, { name: event })) continue;
    if (t.isCallExpression(expr)) {
      const name = ctx.names(calleeName(expr.callee) ?? "");
      if ((t.isExpressionStatement(stmt) && name === "ɵɵrestoreView") || (t.isReturnStatement(stmt) && name === "ɵɵresetView" && t.isIdentifier(expr.arguments[0], { name: event }))) continue;
    }
    unsupported("two-way listener statement");
  }
  return expression(target, scope, new Map(), components);
}

function render(fn: t.Function, ctx: Context, scope: Scope, depth: number): string[] {
  const { create, update, prelude } = blocks(fn);
  for (const stmt of prelude) if (!t.isVariableDeclaration(stmt)) unsupported("template prelude");
  const root: Node[] = [];
  const stack: Array<Extract<Node, { kind: "element" }>> = [];
  const byIndex = new Map<number, Node>();
  const pipes = new Map<number, string>();
  const embedded = new Map<number, { fn: t.Function; kind: "if" | "for"; empty?: t.Function; track?: t.Node }>();
  const attach = (node: Node) => {
    (stack.length ? stack.at(-1)!.children : root).push(node);
    byIndex.set(node.index, node);
  };
  const itemAlias = scope.alias;
  const twoWay = new Map<number, Map<string, string>>();
  let current: Extract<Node, { kind: "element" }> | null = null;

  for (const stmt of create) {
    if (t.isVariableDeclaration(stmt)) continue;
    if (!t.isExpressionStatement(stmt)) unsupported("create statement");
    for (const call of flattenCalls(stmt.expression)) {
      const name = ctx.names(calleeName(call.callee) ?? "");
      const [a, b, c] = call.arguments;
      if (/^ɵɵ(dom)?element(?:Container)?Start$/i.test(name) || name === "?start") {
        const tag = /Container/.test(name) ? "ng-container" : t.isStringLiteral(b) ? b.value : unsupported("tag");
        const element = { kind: "element" as const, index: (a as t.NumericLiteral).value, tag, attrs: constAttrs(ctx.consts, t.isNumericLiteral(c) ? c.value : null), children: [] };
        attach(element);
        stack.push(element);
        current = element;
      } else if (/^ɵɵ(dom)?element$|^ɵɵ(dom)?elementContainer$/i.test(name)) {
        const tag = /Container/.test(name) ? "ng-container" : t.isStringLiteral(b) ? b.value : unsupported("tag");
        const element = { kind: "element" as const, index: (a as t.NumericLiteral).value, tag, attrs: constAttrs(ctx.consts, t.isNumericLiteral(c) ? c.value : null), children: [] };
        attach(element);
        current = element;
      } else if (/^ɵɵ(dom)?element(?:Container)?End$/i.test(name) || name === "?end") {
        if (!stack.pop()) unsupported("unbalanced end");
        current = stack.at(-1) ?? null;
      } else if (name === "ɵɵtext" || name === "?text") {
        attach({ kind: "text", index: (a as t.NumericLiteral).value, value: t.isStringLiteral(b) ? b.value : null });
      } else if (name === "ɵɵprojectionDef") {
        if (call.arguments.length && !ctx.projectionSelectors?.length) unsupported("ɵɵprojectionDef selectors");
      } else if (name === "ɵɵprojection") {
        const slot = b === undefined ? 0 : t.isNumericLiteral(b) ? b.value : unsupported("ɵɵprojection slot");
        const selector = ctx.projectionSelectors?.[slot] ?? (!ctx.projectionSelectors && slot === 0 ? "*" : undefined);
        if (!t.isNumericLiteral(a) || !selector || call.arguments.length > 2) unsupported("ɵɵprojection arguments");
        attach({ kind: "projection", index: a.value, selector });
      } else if (/^ɵɵ(dom)?listener$/i.test(name)) {
        if (!current || !t.isStringLiteral(a)) unsupported("listener target");
        current.attrs.push(`(${a.value})="${listenerBody(b as t.Node, scope, ctx.names).replace(/"/g, "&quot;")}"`);
      } else if (name === "ɵɵtwoWayListener") {
        if (!current || !t.isStringLiteral(a) || !a.value.endsWith("Change")) unsupported("two-way listener event");
        const bindings = twoWay.get(current.index) ?? new Map<string, string>();
        bindings.set(a.value.slice(0, -"Change".length), twoWayTarget(b, scope, ctx));
        twoWay.set(current.index, bindings);
      } else if (name === "ɵɵpipe") {
        if (t.isNumericLiteral(a) && t.isStringLiteral(b)) pipes.set(a.value, b.value);
      } else if (name === "ɵɵconditionalCreate" || name === "ɵɵtemplate" || name === "ɵɵconditionalBranchCreate") {
        const target = t.isIdentifier(b) ? ctx.functions.get(b.name) : null;
        if (!target || !t.isNumericLiteral(a)) unsupported("embedded template");
        const node = { kind: "block" as const, index: a.value, text: [] };
        attach(node);
        embedded.set(a.value, { fn: target, kind: "if" });
      } else if (name === "ɵɵrepeaterCreate") {
        const target = t.isIdentifier(b) ? ctx.functions.get(b.name) : null;
        if (!target || !t.isNumericLiteral(a)) unsupported("repeater");
        const empty = call.arguments[8];
        const node = { kind: "block" as const, index: a.value, text: [] };
        attach(node);
        embedded.set(a.value, { fn: target, kind: "for", ...(t.isIdentifier(empty) && ctx.functions.get(empty.name) ? { empty: ctx.functions.get(empty.name)! } : {}), ...(call.arguments[6] ? { track: call.arguments[6] } : {}) });
      } else if (name === "ɵɵgetCurrentView" || name === "?view") {
        continue;
      } else unsupported(`create ${name || "anonymous"}`);
    }
  }
  if (stack.length) unsupported("unclosed element");
  void itemAlias;

  let cursor = 0;
  const ordered = [...byIndex.keys()].sort((x, y) => x - y);
  const conditions = new Map<number, Condition>();
  let conditionGroup = 0;
  const collections = new Map<number, string>();
  const locals = new Map<string, string>();
  if (scope.item === "conditional" && scope.params[1]) locals.set(scope.params[1], scope.alias);
  const components = new Set<string>();
  const temporaries = new Set<string>();
  for (const stmt of [...prelude, ...update]) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) {
      if (!t.isIdentifier(d.id)) continue;
      if (!d.init) {
        temporaries.add(d.id.name);
        continue;
      }
      if (scope.item && (t.isIdentifier(d.init, { name: scope.params[1] }) || (t.isMemberExpression(d.init) && literalKey(d.init.property) === "$implicit"))) locals.set(d.id.name, scope.alias);
      else if (t.isCallExpression(d.init) && d.init.arguments.length <= 1) components.add(d.id.name);
      else unsupported("update local");
    }
  }
  const expr = (node: t.Node): string => {
    if (t.isCallExpression(node) && /pipeBind\d$/.test(ctx.names(calleeName(node.callee) ?? ""))) {
      const [slot, , ...values] = node.arguments;
      const pipe = t.isNumericLiteral(slot) ? pipes.get(slot.value) : undefined;
      if (pipe && values[0]) return `${expr(values[0] as t.Node)} | ${pipe}${values.slice(1).map((v) => `: ${expr(v as t.Node)}`).join("")}`;
    }
    return expression(node, scope, locals, components, ctx, temporaries);
  };
  for (const stmt of update) {
    if (t.isVariableDeclaration(stmt)) continue;
    if (!t.isExpressionStatement(stmt)) unsupported("update statement");
    for (const call of flattenCalls(stmt.expression)) {
      const name = ctx.names(calleeName(call.callee) ?? "");
      const args = call.arguments;
      if (name === "ɵɵadvance" || name === "?advance") {
        const step = t.isNumericLiteral(args[0]) ? args[0].value : 1;
        cursor += step;
        continue;
      }
      const target = byIndex.get(cursor) ?? byIndex.get(ordered.find((i) => i >= cursor) ?? -1);
      const guessed = /^\?(pair|binding|interpolate)$/.test(name);
      if (/^ɵɵtextInterpolate\d*$|^ɵɵtextInterpolateV$/.test(name) || (guessed && target?.kind === "text")) {
        if (!target || target.kind !== "text") unsupported("interpolation target");
        const values = name === "ɵɵtextInterpolateV" && t.isArrayExpression(args[0]) ? args[0].elements : args;
        const parts = values.map((arg, i) => (i % 2 === 0 && t.isStringLiteral(arg) ? arg.value : `{{ ${expr(arg ?? unsupported("interpolation argument"))} }}`));
        target.value = name === "ɵɵtextInterpolate" ? `{{ ${expr(args[0]!)} }}` : parts.join("");
      } else if (/^ɵɵ(?:dom|twoWay)?property$|^ɵɵattribute$|^ɵɵclassProp$|^ɵɵstyleProp$/i.test(name) || (guessed && target?.kind === "element")) {
        if (!target || target.kind !== "element" || !t.isStringLiteral(args[0])) unsupported("binding target");
        const prefix = name === "ɵɵattribute" ? "attr." : name === "ɵɵclassProp" ? "class." : name === "ɵɵstyleProp" ? "style." : "";
        const value = expr(args[1]!);
        const suffix = name === "ɵɵstyleProp" && t.isStringLiteral(args[2]) ? `.${args[2].value}` : "";
        const key = args[0].value + suffix;
        if (name === "ɵɵtwoWayProperty") {
          if (twoWay.get(target.index)?.get(key) !== value) unsupported(`unmatched two-way property ${key}`);
          twoWay.get(target.index)!.delete(key);
          target.attrs.push(`[(${key})]="${value.replace(/"/g, "&quot;")}"`);
        } else target.attrs.push(`[${prefix}${key}]="${value.replace(/"/g, "&quot;")}"`);
      } else if (name === "ɵɵconditional") {
        collectConditions(args[0] as t.Node, args[1], expr, conditionGroup++, conditions);
      } else if (name === "ɵɵrepeater") {
        if (!target || target.kind !== "block") unsupported("repeater target");
        collections.set(target.index, expr(args[0]!));
      } else if (name === "ɵɵnextContext" || name === "?context") {
        continue;
      } else unsupported(`update ${name || "anonymous"}`);
    }
  }
  for (const bindings of twoWay.values()) {
    if (bindings.size) unsupported(`unmatched two-way listener ${[...bindings.keys()].join(", ")}`);
  }

  const lines: string[] = [];
  const pad = (n: number) => "  ".repeat(n);
  const emit = (nodes: Node[], level: number) => {
    const conditional = [...nodes];
    for (let i = 0; i < conditional.length; i++) {
      const node = conditional[i]!;
      if (node.kind === "text") {
        if (node.value !== null && node.value.trim()) lines.push(`${pad(level)}${node.value.trim()}`);
      } else if (node.kind === "element") {
        const open = `<${node.tag}${node.attrs.length ? ` ${node.attrs.join(" ")}` : ""}`;
        if (VOID.has(node.tag)) lines.push(`${pad(level)}${open} />`);
        else if (!node.children.length) lines.push(`${pad(level)}${open}${node.tag.includes("-") ? " />" : `></${node.tag}>`}`);
        else if (node.children.length === 1 && node.children[0]!.kind === "text") lines.push(`${pad(level)}${open}>${(node.children[0] as { value: string | null }).value?.trim() ?? ""}</${node.tag}>`);
        else {
          lines.push(`${pad(level)}${open}>`);
          emit(node.children, level + 1);
          lines.push(`${pad(level)}</${node.tag}>`);
        }
      } else if (node.kind === "projection") {
        const select = node.selector === "*" ? "" : ` select="${escapeAttribute(node.selector)}"`;
        lines.push(`${pad(level)}<ng-content${select}></ng-content>`);
      } else {
        const block = embedded.get(node.index)!;
        if (block.kind === "for") {
          const collection = collections.get(node.index) ?? unsupported("repeater collection");
          const alias = singular(collection);
          const trackFn = t.isIdentifier(block.track) ? ctx.functions.get(block.track.name) : block.track;
          const track = trackFn && (t.isArrowFunctionExpression(trackFn) || t.isFunctionExpression(trackFn)) ? trackExpression(trackFn, alias) : "$index";
          lines.push(`${pad(level)}@for (${alias} of ${collection}; track ${track}) {`);
          lines.push(...render(block.fn, ctx, { params: block.fn.params.map((p) => (t.isIdentifier(p) ? p.name : "")), item: "$implicit", alias, parent: scope }, level + 1));
          if (block.empty) {
            lines.push(`${pad(level)}} @empty {`);
            lines.push(...render(block.empty, ctx, { params: block.empty.params.map((p) => (t.isIdentifier(p) ? p.name : "")), item: null, alias: scope.alias, parent: scope }, level + 1));
          }
          lines.push(`${pad(level)}}`);
        } else {
          const condition = conditions.get(node.index) ?? unsupported("conditional");
          const previous = conditional[i - 1];
          const continuing = previous?.kind === "block" && conditions.get(previous.index)?.group === condition.group && lines.at(-1)?.trim() === "}";
          if (!condition.test) {
            if (!continuing) unsupported("conditional else without if");
            lines[lines.length - 1] = `${pad(level)}} @else {`;
          } else {
            const test = condition.alias ? `${condition.test}; as ${condition.alias}` : condition.test;
            if (continuing) lines[lines.length - 1] = `${pad(level)}} @else if (${test}) {`;
            else lines.push(`${pad(level)}@if (${test}) {`);
          }
          lines.push(...render(block.fn, ctx, {
            params: block.fn.params.map((p) => (t.isIdentifier(p) ? p.name : "")),
            item: condition.alias ? "conditional" : null,
            alias: condition.alias ?? scope.alias,
            parent: scope,
          }, level + 1));
          lines.push(`${pad(level)}}`);
        }
      }
    }
  };
  emit(root, depth);
  return lines;
}

function collectConditions(node: t.Node, value: t.Node | undefined, text: (node: t.Node) => string, group: number, into: Map<number, Condition>): void {
  if (t.isConditionalExpression(node) && t.isNumericLiteral(node.consequent)) {
    const test = node.test;
    if (t.isAssignmentExpression(test, { operator: "=" }) && t.isIdentifier(value) && t.isIdentifier(test.left, { name: value.name })) {
      const expr = text(test.right);
      const alias = /\b([a-z][\w$]*)\(\)$/.exec(expr)?.[1] ?? "value";
      into.set(node.consequent.value, { group, test: expr, alias });
    } else {
      into.set(node.consequent.value, { group, test: text(test) });
    }
    collectConditions(node.alternate, value, text, group, into);
  } else if (t.isNumericLiteral(node) && node.value >= 0) into.set(node.value, { group, test: "" });
}

function singular(collection: string): string {
  const last = /([A-Za-z_$][\w$]*)(?:\(\))?$/.exec(collection)?.[1] ?? "item";
  const word = last.replace(/ies$/, "y").replace(/([^s])s$/, "$1");
  return word === last || !/^[a-z]/.test(word) ? "item" : word;
}

function trackExpression(fn: t.ArrowFunctionExpression | t.FunctionExpression, alias: string): string {
  const [index, item] = fn.params.map((p) => (t.isIdentifier(p) ? p.name : ""));
  const body = t.isExpression(fn.body) ? fn.body : null;
  if (!body) return "$index";
  const text = print(body).replace(/;$/, "");
  return text.replace(new RegExp(`\\b${item}\\b`, "g"), alias).replace(new RegExp(`\\b${index}\\b`, "g"), "$index");
}

function inferNames(fns: t.Function[]): (callee: string) => string {
  const roles = new Map<string, Map<string, number>>();
  const vote = (name: string | null, role: string) => {
    if (!name || name.startsWith("ɵɵ")) return;
    const table = roles.get(name) ?? new Map<string, number>();
    table.set(role, (table.get(role) ?? 0) + 1);
    roles.set(name, table);
  };
  for (const fn of fns) {
    let parts: ReturnType<typeof blocks>;
    try {
      parts = blocks(fn);
    } catch {
      continue;
    }
    for (const [block, stmts] of [["create", parts.create], ["update", parts.update]] as const) {
      for (const stmt of stmts) {
        if (t.isVariableDeclaration(stmt)) {
          for (const d of stmt.declarations) if (t.isCallExpression(d.init) && !d.init.arguments.length) vote(calleeName(d.init.callee), block === "create" ? "?view" : "?context");
          continue;
        }
        if (!t.isExpressionStatement(stmt)) continue;
        let calls: t.CallExpression[];
        try {
          calls = flattenCalls(stmt.expression);
        } catch {
          continue;
        }
        for (const call of calls) {
          const name = calleeName(call.callee);
          const [a, b] = call.arguments;
          if (block === "create") {
            if (!call.arguments.length) vote(name, "?end");
            else if (t.isNumericLiteral(a) && t.isStringLiteral(b) && /^[a-z][a-z0-9-]*$/.test(b.value) && call.arguments.length <= 4) vote(name, "?start");
            else if (t.isNumericLiteral(a) && (call.arguments.length === 1 || (call.arguments.length === 2 && t.isStringLiteral(b)))) vote(name, "?text");
          } else {
            if (!call.arguments.length || (call.arguments.length === 1 && t.isNumericLiteral(a))) vote(name, "?advance");
            else if (t.isStringLiteral(a) && call.arguments.length >= 2 && call.arguments.length % 2 === 0 === false) vote(name, "?interpolate");
            else if (t.isStringLiteral(a) && call.arguments.length === 2) vote(name, "?pair");
          }
        }
      }
    }
  }
  return (callee: string) => {
    if (callee.startsWith("ɵɵ")) return callee;
    const table = roles.get(callee);
    if (!table) return callee;
    const [best] = [...table].sort((x, y) => y[1] - x[1]);
    if (!best) return callee;
    return best[0];
  };
}

function option(object: t.ObjectExpression, key: string): t.Node | undefined {
  return object.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === key)?.value;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function stringArray(value: t.Node | null | undefined): string[] | undefined {
  if (t.isArrayExpression(value) && value.elements.every((element) => t.isStringLiteral(element))) {
    return value.elements.map((element) => (element as t.StringLiteral).value);
  }
}

export function angularSourceCode(code: string, instructions: ReadonlyMap<string, string> = new Map(), report?: (message: string) => void, importedSelectors?: (name: string) => readonly string[] | undefined): string | null {
  if (!/static\s+ɵ(cmp|pipe|prov|dir)\b/.test(code)) return null;
  const ast = parseProgram(code);
  const aliases = new Map(instructions);
  for (const stmt of ast.program.body) {
    if (!t.isImportDeclaration(stmt) || stmt.source.value !== "@angular/core") continue;
    for (const spec of stmt.specifiers) {
      if (t.isImportSpecifier(spec) && /^ɵɵ/.test(literalKey(spec.imported) ?? "")) aliases.set(spec.local.name, literalKey(spec.imported)!);
    }
  }
  const functions = new Map<string, t.Function>();
  const selectors = new Map<string, string[]>();
  for (const stmt of ast.program.body) {
    if (t.isFunctionDeclaration(stmt) && stmt.id) functions.set(stmt.id.name, stmt);
    const declaration = t.isVariableDeclaration(stmt) ? stmt : null;
    for (const d of declaration?.declarations ?? []) {
      if (!t.isIdentifier(d.id)) continue;
      if (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init)) functions.set(d.id.name, d.init);
      const values = stringArray(d.init);
      if (values) selectors.set(d.id.name, values);
    }
  }
  let changed = false;
  const decorators = new Set<string>();
  const body = ast.program.body;
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i]!;
    const exported = t.isExportNamedDeclaration(stmt);
    const inner = exported ? (stmt as t.ExportNamedDeclaration).declaration : stmt;
    const declarator = t.isVariableDeclaration(inner) && inner.declarations.length === 1 ? inner.declarations[0]! : null;
    const cls = declarator && t.isClassExpression(declarator.init) ? declarator.init : t.isClassDeclaration(inner) ? inner : null;
    const name = declarator && t.isIdentifier(declarator.id) ? declarator.id.name : t.isClassDeclaration(inner) ? inner.id?.name : null;
    if (!cls || !name) continue;
    const statics = new Map<string, t.ObjectExpression>();
    for (const member of cls.body.body) {
      if (!t.isClassProperty(member) || !member.static) continue;
      const key = t.isIdentifier(member.key) ? member.key.name : "";
      if (t.isCallExpression(member.value) && t.isObjectExpression(member.value.arguments[0])) statics.set(key, member.value.arguments[0]);
    }
    let decorator: t.Decorator | null = null;
    try {
      decorator = decoratorFor(statics, functions, aliases, (name) => selectors.get(name) ?? importedSelectors?.(name));
    } catch (err) {
      if (err instanceof Unsupported) {
        if (statics.has("ɵcmp")) report?.(`${name}: ${err.message}`);
        continue;
      }
      throw err;
    }
    if (!decorator) continue;
    decorators.add(((decorator.expression as t.CallExpression).callee as t.Identifier).name);
    const self = t.isClassExpression(cls) && cls.id ? cls.id.name : null;
    const members = cls.body.body.filter((m) => !(t.isClassProperty(m) && m.static && t.isIdentifier(m.key) && /^ɵ/.test(m.key.name)));
    const declaration = t.classDeclaration(t.identifier(name), cls.superClass ?? null, t.classBody(members));
    declaration.decorators = [decorator];
    if (self && self !== name) {
      traverse(t.file(t.program([declaration])), {
        Identifier(path) {
          if (path.node.name === self && path.isReferencedIdentifier()) path.node.name = name;
        },
      });
    }
    body[i] = exported ? t.exportNamedDeclaration(declaration) : declaration;
    changed = true;
  }
  if (!changed) return null;
  removeUnused(ast);
  t.traverseFast(ast.program, (n) => {
    if (t.isMemberExpression(n) && t.isIdentifier(n.object, { name: "ViewEncapsulation" })) decorators.add("ViewEncapsulation");
  });
  const imports = [...decorators].sort();
  const core = ast.program.body.find((s): s is t.ImportDeclaration => t.isImportDeclaration(s) && s.source.value === "@angular/core");
  if (core) {
    for (const name of imports) if (!core.specifiers.some((s) => s.local.name === name)) core.specifiers.push(t.importSpecifier(t.identifier(name), t.identifier(name)));
  } else ast.program.body.unshift(t.importDeclaration(imports.map((n) => t.importSpecifier(t.identifier(n), t.identifier(n))), t.stringLiteral("@angular/core")));
  return print(ast).replace(/export (@(?:Component|Pipe|Injectable|Directive)\([\s\S]*?\n\}\)\n)(class )/g, "$1export $2");
}

function decoratorFor(statics: Map<string, t.ObjectExpression>, functions: Map<string, t.Function>, aliases: ReadonlyMap<string, string>, resolveSelectors: (name: string) => readonly string[] | undefined): t.Decorator | null {
  const cmp = statics.get("ɵcmp");
  if (cmp) {
    const selectors = option(cmp, "selectors");
    const selector = t.isArrayExpression(selectors) && t.isArrayExpression(selectors.elements[0]) && t.isStringLiteral(selectors.elements[0].elements[0]) ? selectors.elements[0].elements[0].value : unsupported("selector");
    const template = option(cmp, "template");
    if (!t.isFunctionExpression(template) && !t.isArrowFunctionExpression(template)) unsupported("template");
    const consts = option(cmp, "consts");
    const all = [template, ...functions.values()];
    const guessed = inferNames(all);
    const projection = option(cmp, "ngContentSelectors");
    const ctx: Context = {
      consts: t.isArrayExpression(consts) ? consts : null,
      functions,
      names: (name) => aliases.get(name) ?? guessed(name),
      projectionSelectors: t.isIdentifier(projection) ? resolveSelectors(projection.name) : stringArray(projection),
    };
    const lines = render(template, ctx, { params: template.params.map((p) => (t.isIdentifier(p) ? p.name : "")), item: null, alias: "", parent: null }, 2);
    const properties: t.ObjectProperty[] = [t.objectProperty(t.identifier("selector"), t.stringLiteral(selector))];
    const dependencies = option(cmp, "dependencies");
    if (t.isArrayExpression(dependencies) && dependencies.elements.length) properties.push(t.objectProperty(t.identifier("imports"), t.cloneNode(dependencies, true)));
    const text = `\n${lines.join("\n")}\n  `;
    properties.push(t.objectProperty(t.identifier("template"), t.templateLiteral([t.templateElement({ raw: text.replace(/`/g, "\\`").replace(/\$\{/g, "\\${"), cooked: text })], [])));
    const encapsulation = option(cmp, "encapsulation");
    if (t.isNumericLiteral(encapsulation) && encapsulation.value === 2) properties.push(t.objectProperty(t.identifier("encapsulation"), t.memberExpression(t.identifier("ViewEncapsulation"), t.identifier("None"))));
    const styles = option(cmp, "styles");
    if (styles) {
      if (!t.isArrayExpression(styles) || !styles.elements.every((value) => t.isStringLiteral(value))) unsupported("computed component styles");
      const restored = styles.elements.map((value) => t.stringLiteral((value as t.StringLiteral).value.replaceAll("[_nghost-%COMP%]", ":host").replaceAll("[_ngcontent-%COMP%]", "")));
      properties.push(t.objectProperty(t.identifier("styles"), t.arrayExpression(restored)));
    }
    return t.decorator(t.callExpression(t.identifier("Component"), [t.objectExpression(properties)]));
  }
  const pipe = statics.get("ɵpipe");
  if (pipe) {
    const name = option(pipe, "name");
    if (!t.isStringLiteral(name)) unsupported("pipe name");
    const properties = [t.objectProperty(t.identifier("name"), t.stringLiteral(name.value))];
    const pure = option(pipe, "pure");
    if (t.isBooleanLiteral(pure) && !pure.value) properties.push(t.objectProperty(t.identifier("pure"), t.booleanLiteral(false)));
    return t.decorator(t.callExpression(t.identifier("Pipe"), [t.objectExpression(properties)]));
  }
  const prov = statics.get("ɵprov");
  if (prov) {
    const provided = option(prov, "providedIn");
    if (!t.isStringLiteral(provided)) unsupported("providedIn");
    return t.decorator(t.callExpression(t.identifier("Injectable"), [t.objectExpression([t.objectProperty(t.identifier("providedIn"), t.stringLiteral(provided.value))])]));
  }
  return null;
}

function removeUnused(ast: t.File): void {
  for (let round = 0; round < 4; round++) {
    let program: NodePath<t.Program> | undefined;
    traverse(ast, {
      Program(path) {
        program = path;
        path.stop();
      },
    });
    program!.scope.crawl();
    const scope = program!.scope;
    let removed = false;
    ast.program.body = ast.program.body.filter((stmt) => {
      if (t.isFunctionDeclaration(stmt) && stmt.id && !scope.getBinding(stmt.id.name)?.referenced) return !(removed = true);
      if (t.isVariableDeclaration(stmt) && stmt.declarations.every((d) => t.isIdentifier(d.id) && !scope.getBinding(d.id.name)?.referenced && (t.isFunction(d.init) || t.isArrowFunctionExpression(d.init)))) return !(removed = true);
      if (t.isImportDeclaration(stmt)) {
        const before = stmt.specifiers.length;
        stmt.specifiers = stmt.specifiers.filter((s) => scope.getBinding(s.local.name)?.referenced);
        if (stmt.specifiers.length !== before) removed = true;
        return stmt.specifiers.length > 0 || before === 0;
      }
      return true;
    });
    if (!removed) break;
  }
}
