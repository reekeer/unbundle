import type { NodePath } from "@babel/traverse";
import { literalKey, parseProgram, print, t, traverse } from "../unpack/ast.ts";

function asyncBody(node: t.Node | undefined): t.Expression | null {
  if (!t.isArrowFunctionExpression(node) && !t.isFunctionExpression(node)) return null;
  if (!t.isBlockStatement(node.body)) return node.body;
  const only = node.body.body.length === 1 ? node.body.body[0] : null;
  return t.isReturnStatement(only) && only.argument ? only.argument : null;
}

function contextPair(stmt: t.Statement | undefined): { value: string; restore: string; expression: t.Expression } | null {
  if (!t.isExpressionStatement(stmt) || !t.isAssignmentExpression(stmt.expression, { operator: "=" })) return null;
  const { left, right } = stmt.expression;
  if (!t.isArrayPattern(left) || left.elements.length !== 2 || !left.elements.every((e) => t.isIdentifier(e))) return null;
  if (!t.isCallExpression(right) || right.arguments.length !== 1) return null;
  const expression = asyncBody(right.arguments[0] as t.Node);
  if (!expression) return null;
  return { value: (left.elements[0] as t.Identifier).name, restore: (left.elements[1] as t.Identifier).name, expression };
}

function awaits(stmt: t.Statement | undefined, name: string): boolean {
  if (!t.isExpressionStatement(stmt)) return false;
  const e = stmt.expression;
  if (t.isAwaitExpression(e) && t.isIdentifier(e.argument, { name })) return true;
  return t.isAssignmentExpression(e, { operator: "=" }) && t.isIdentifier(e.left, { name }) && t.isAwaitExpression(e.right) && t.isIdentifier(e.right.argument, { name });
}

function restores(stmt: t.Statement | undefined, name: string): boolean {
  return t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression) && t.isIdentifier(stmt.expression.callee, { name }) && !stmt.expression.arguments.length;
}

function restoreAwaits(body: t.Statement[]): { body: t.Statement[]; helpers: Set<string>; temps: Set<string> } {
  const out: t.Statement[] = [];
  const helpers = new Set<string>();
  const temps = new Set<string>();
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i]!;
    if (t.isIfStatement(stmt) || t.isBlockStatement(stmt)) {
      const visit = (node: t.Statement): t.Statement => {
        if (t.isBlockStatement(node)) {
          const inner = restoreAwaits(node.body);
          inner.helpers.forEach((h) => helpers.add(h));
          inner.temps.forEach((h) => temps.add(h));
          return t.blockStatement(inner.body);
        }
        if (t.isIfStatement(node)) return t.ifStatement(node.test, visit(node.consequent), node.alternate ? visit(node.alternate) : null);
        return node;
      };
      out.push(visit(stmt));
      continue;
    }
    const pair = contextPair(stmt);
    if (!pair || !awaits(body[i + 1], pair.value) || !restores(body[i + 2], pair.restore)) {
      out.push(stmt);
      continue;
    }
    const call = (stmt as t.ExpressionStatement).expression as t.AssignmentExpression;
    const callee = (call.right as t.CallExpression).callee;
    if (t.isIdentifier(callee)) helpers.add(callee.name);
    temps.add(pair.value);
    temps.add(pair.restore);
    const next = body[i + 3];
    const awaited = t.awaitExpression(pair.expression);
    if (t.isVariableDeclaration(next) && next.declarations.length === 1 && t.isIdentifier(next.declarations[0]!.init, { name: pair.value })) {
      out.push(t.variableDeclaration(next.kind, [t.variableDeclarator(next.declarations[0]!.id, awaited)]));
      i += 3;
    } else {
      out.push(t.expressionStatement(awaited));
      i += 2;
    }
  }
  return { body: out, helpers, temps };
}

function objectOf(node: t.Node | undefined): t.ObjectExpression | null {
  return t.isObjectExpression(node) ? node : null;
}

function defineModels(program: NodePath<t.Program>): boolean {
  let changed = false;
  const body = program.node.body;
  const propsDecl = body.find((s): s is t.VariableDeclaration => t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isCallExpression(s.declarations[0]!.init) && t.isIdentifier(s.declarations[0]!.init.callee, { name: "defineProps" }));
  const propsCall = propsDecl?.declarations[0]!.init as t.CallExpression | undefined;
  const merged = propsCall?.arguments[0];
  const models = t.isCallExpression(merged) && t.isIdentifier(merged.callee, { name: "mergeModels" }) ? objectOf(merged.arguments[1]) : null;
  if (!propsCall || !propsDecl || !models) return false;
  const own = objectOf(merged!.type === "CallExpression" ? (merged as t.CallExpression).arguments[0] : undefined) ?? t.objectExpression([]);
  const options = new Map<string, t.Expression>();
  for (const prop of models.properties) {
    if (!t.isObjectProperty(prop)) continue;
    const key = literalKey(prop.key);
    if (key && !key.endsWith("Modifiers") && key !== "modelModifiers") options.set(key, prop.value as t.Expression);
  }
  const propsName = t.isIdentifier(propsDecl.declarations[0]!.id) ? propsDecl.declarations[0]!.id.name : null;
  for (const stmt of body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) {
      const init = d.init;
      if (!t.isCallExpression(init) || !t.isIdentifier(init.callee, { name: "useModel" }) || !t.isIdentifier(init.arguments[0], { name: propsName ?? "" }) || !t.isStringLiteral(init.arguments[1])) continue;
      const name = init.arguments[1].value;
      const opts = options.get(name);
      const args: t.Expression[] = [];
      if (name !== "modelValue") args.push(t.stringLiteral(name));
      if (t.isObjectExpression(opts) && opts.properties.length) args.push(opts);
      d.init = t.callExpression(t.identifier("defineModel"), args);
      options.delete(name);
      changed = true;
    }
  }
  if (!changed) return false;
  for (const [key, value] of options) own.properties.push(t.objectProperty(t.identifier(key), value));
  propsCall.arguments = [own];
  for (const stmt of body) {
    if (!t.isVariableDeclaration(stmt)) continue;
    for (const d of stmt.declarations) {
      const init = d.init;
      if (!t.isCallExpression(init) || !t.isIdentifier(init.callee, { name: "defineEmits" })) continue;
      const arg = init.arguments[0];
      if (t.isCallExpression(arg) && t.isIdentifier(arg.callee, { name: "mergeModels" })) init.arguments = [arg.arguments[0] as t.Expression];
    }
  }
  return true;
}

function exposeAlias(program: NodePath<t.Program>): boolean {
  let changed = false;
  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    const node = binding.path.node;
    if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.init, { name: "defineExpose" })) continue;
    for (const ref of binding.referencePaths) if (ref.parentPath?.isCallExpression() && ref.parentPath.node.callee === ref.node) ref.replaceWith(t.identifier("defineExpose"));
    binding.path.remove();
    changed = true;
    void name;
  }
  return changed;
}

function unusedDeclarations(program: NodePath<t.Program>, names: Set<string>): void {
  program.scope.crawl();
  for (const name of names) {
    const binding = program.scope.getBinding(name);
    if (!binding || binding.referenced || binding.constantViolations.length) continue;
    if (binding.path.isVariableDeclarator()) binding.path.remove();
  }
  program.scope.crawl();
  for (const name of names) {
    const binding = program.scope.getBinding(name);
    if (!binding || binding.referenced) continue;
    if (binding.path.isVariableDeclarator() && !binding.path.node.init && binding.constantViolations.every((v) => v.isAssignmentExpression() && t.isIdentifier(v.node.left))) {
      binding.path.remove();
    }
  }
  program.scope.crawl();
  for (const [local, binding] of Object.entries(program.scope.bindings)) {
    if (binding.kind !== "module" || binding.referenced || !/^(withAsyncContext|useModel|mergeModels)$/.test(local)) continue;
    const spec = binding.path;
    const decl = spec.parentPath;
    if (decl?.isImportDeclaration() && decl.node.specifiers.length === 1) decl.remove();
    else spec.remove();
  }
}

export function tidyScript(code: string): string {
  if (!/withAsyncContext|useModel|mergeModels|defineExpose|__vite__mapDeps|\]\s*=\s*\w+\(\s*(async\s*)?\(\)\s*=>/.test(code)) return code;
  let ast: t.File;
  try {
    ast = parseProgram(code);
  } catch {
    return code;
  }
  let program: NodePath<t.Program> | null = null;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  if (!program) return code;
  const p = program as NodePath<t.Program>;
  let changed = false;
  const restored = restoreAwaits(p.node.body);
  if (restored.temps.size) {
    p.node.body = restored.body;
    const fns: t.Function[] = [];
    t.traverseFast(p.node, (n) => {
      if (t.isFunction(n) && t.isBlockStatement(n.body)) fns.push(n);
    });
    for (const fn of fns) {
      const inner = restoreAwaits((fn.body as t.BlockStatement).body);
      if (inner.temps.size) {
        (fn.body as t.BlockStatement).body = inner.body;
        inner.temps.forEach((x) => restored.temps.add(x));
      }
    }
    changed = true;
  } else {
    const fns: t.Function[] = [];
    t.traverseFast(p.node, (n) => {
      if (t.isFunction(n) && t.isBlockStatement(n.body)) fns.push(n);
    });
    for (const fn of fns) {
      const inner = restoreAwaits((fn.body as t.BlockStatement).body);
      if (!inner.temps.size) continue;
      (fn.body as t.BlockStatement).body = inner.body;
      inner.temps.forEach((x) => restored.temps.add(x));
      changed = true;
    }
  }
  p.scope.crawl();
  if (defineModels(p)) changed = true;
  p.scope.crawl();
  if (exposeAlias(p)) changed = true;
  const deps = p.scope.getBinding("__vite__mapDeps");
  if (deps && !deps.referencePaths.some((ref) => !ref.findParent((x) => x === deps.path))) {
    deps.path.remove();
    changed = true;
  }
  if (!changed) return code;
  traverse(ast, {
    Program(path) {
      unusedDeclarations(path, restored.temps);
      path.stop();
    },
  });
  return print(ast);
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function tidyTemplate(template: string): string {
  return template.replace(/<([A-Za-z][\w.-]*)(\s[^<>]*?)?(\/?)>/g, (tag, name: string, attrs: string | undefined, close: string) => {
    if (!attrs) return tag;
    let next = attrs;
    for (const match of attrs.matchAll(/\sv-model(?::([\w-]+))?="([^"]*)"/g)) {
      const arg = match[1] ?? "modelValue";
      const value = match[2]!;
      for (const prop of new Set([arg, kebab(arg)])) {
        next = next.replace(new RegExp(`\\s:${prop.replace(/[-]/g, "\\-")}="${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), "");
      }
    }
    if (/^[A-Z]/.test(name)) next = next.replace(/(\s[a-z][\w-]*)=""/g, "$1");
    return next === attrs ? tag : `<${name}${next}${close}>`;
  });
}

const MODIFIERS = /^(stop|prevent|self|ctrl|shift|alt|meta|exact|left|middle|right|once|capture|passive)$/;

function simplifyHandler(value: string): { value: string; modifiers: string[] } | null {
  let expression: t.Expression;
  try {
    const statement = parseProgram(`(${value})`).program.body[0];
    if (!t.isExpressionStatement(statement)) return null;
    expression = statement.expression;
  } catch {
    return null;
  }
  const modifiers: string[] = [];
  let current = expression;
  for (;;) {
    if (!t.isCallExpression(current) || current.arguments.length !== 2 || !t.isIdentifier(current.callee) || !/^with(Keys|Modifiers)$/.test(current.callee.name)) break;
    const [inner, list] = current.arguments;
    if (!t.isExpression(inner) || !t.isArrayExpression(list) || !list.elements.every((e) => t.isStringLiteral(e))) break;
    const names = list.elements.map((e) => (e as t.StringLiteral).value);
    if (current.callee.name === "withModifiers" && !names.every((n) => MODIFIERS.test(n))) break;
    modifiers.push(...names);
    current = inner;
  }
  if (t.isArrowFunctionExpression(current) && current.params.length === 1 && t.isRestElement(current.params[0]) && t.isIdentifier(current.params[0].argument)) {
    const rest = current.params[0].argument.name;
    const body = current.body;
    const call = t.isLogicalExpression(body, { operator: "&&" }) ? body.right : body;
    const guard = t.isLogicalExpression(body, { operator: "&&" }) ? body.left : null;
    if (t.isCallExpression(call) && call.arguments.length === 1 && t.isSpreadElement(call.arguments[0]) && t.isIdentifier(call.arguments[0].argument, { name: rest }) && (!guard || print(guard) === print(call.callee))) current = call.callee as t.Expression;
  }
  if (t.isArrowFunctionExpression(current) && t.isExpression(current.body) && (current.params.length === 0 || (current.params.length === 1 && t.isIdentifier(current.params[0]) && !print(current.body).match(new RegExp(`\\b${(current.params[0] as t.Identifier).name}\\b`))))) current = current.body;
  if (current === expression && !modifiers.length) return null;
  return { value: print(current).replace(/;\s*$/, "").trim(), modifiers };
}

export function tidyEvents(template: string): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("<", i);
    if (open < 0 || !/[A-Za-z]/.test(template[open + 1] ?? "")) {
      out += template.slice(i, open < 0 ? template.length : open + 1);
      i = open < 0 ? template.length : open + 1;
      continue;
    }
    let j = open + 1;
    let quote: string | null = null;
    for (; j < template.length; j++) {
      const c = template[j]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    out += template.slice(i, open);
    const tag = template.slice(open, j + 1);
    const next = tag.replace(/(\s)@([\w:-]+)((?:\.[\w-]+)*)="([^"]*)"/g, (match, space: string, event: string, existing: string, raw: string) => {
      const value = raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const simplified = simplifyHandler(value);
      if (!simplified) return match;
      const suffix = [...existing.split(".").filter(Boolean), ...simplified.modifiers].map((m) => `.${m}`).join("");
      return `${space}@${event}${suffix}="${simplified.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
    });
    out += next;
    i = j + 1;
  }
  return out.replace(/(["\s(,!{])unref\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\)/g, "$1$2").replace(/\{\{(\s*)unref\(([A-Za-z_$][\w$]*)\)/g, "{{$1$2");
}

export function tidySfc(content: string): string {
  const script = /(<script\b[^>]*\bsetup\b[^>]*>)([\s\S]*?)(<\/script>)/.exec(content);
  let out = content;
  if (script) {
    const next = tidyScript(script[2]!);
    if (next !== script[2]) out = out.slice(0, script.index) + script[1] + (next.startsWith("\n") ? next : `\n${next}`) + script[3] + out.slice(script.index + script[0].length);
  }
  const template = /<template>([\s\S]*)<\/template>/.exec(out);
  if (template) {
    const next = tidyEvents(tidyTemplate(template[1]!));
    if (next !== template[1]) out = out.slice(0, template.index) + `<template>${next}</template>` + out.slice(template.index + template[0].length);
  }
  return out;
}
