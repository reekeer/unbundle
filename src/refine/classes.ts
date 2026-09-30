import type { NodePath } from "@babel/traverse";
import { literalKey, t } from "../unpack/ast.ts";

export type ClassRole = "api" | "client" | "model" | "error" | "other";

export interface ClassName {
  name: string;
  role: ClassRole;
}

const API_PATH = /^\/(api|v\d+)(\/|$)/;
const STATUS_ERRORS: Record<number, string> = { 400: "BadRequestError", 401: "UnauthorizedError", 403: "ForbiddenError", 404: "NotFoundError", 409: "ConflictError", 422: "ValidationError", 429: "RateLimitError" };

interface Usage {
  keys: string[];
  props: Array<{ word: string; owner: string | null }>;
  vars: string[];
  params: string[];
  returned: boolean;
  subclasses: string[];
  statuses: number[];
}

function pascal(word: string): string {
  return word
    .replace(/^[_$]+/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

function readable(word: string | null | undefined): word is string {
  return !!word && /^[A-Za-z_$][\w$]*$/.test(word) && word.replace(/^[_$]+/, "").length > 2;
}

function isRequestDescriptor(node: t.ObjectExpression): boolean {
  const keys = new Map(node.properties.flatMap((p) => (t.isObjectProperty(p) ? [[literalKey(p.key), p.value] as const] : [])));
  const path = keys.get("path") ?? keys.get("url");
  const text = t.isStringLiteral(path) ? path.value : t.isTemplateLiteral(path) ? (path.quasis[0]?.value.cooked ?? "") : null;
  const method = keys.get("method");
  return !!text && text.startsWith("/") && t.isStringLiteral(method) && /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/i.test(method.value);
}

export function hasApiPath(node: t.Node): boolean {
  let found = false;
  t.traverseFast(node, (n) => {
    if (found) return;
    if (t.isStringLiteral(n) && API_PATH.test(n.value)) found = true;
    else if (t.isTemplateLiteral(n) && API_PATH.test(n.quasis[0]?.value.cooked ?? "")) found = true;
    else if (t.isObjectExpression(n) && isRequestDescriptor(n)) found = true;
  });
  return found;
}

function enclosingClass(path: NodePath): string | null {
  const cls = path.findParent((p) => p.isClassDeclaration() || p.isClassExpression());
  const id = cls && (cls.node as t.Class).id;
  return id ? id.name : null;
}

function constructorParams(program: NodePath<t.Program>, name: string): string[] {
  const node = program.scope.getBinding(name)?.path.node;
  if (!t.isClassDeclaration(node)) return [];
  const ctor = node.body.body.find((m): m is t.ClassMethod => t.isClassMethod(m) && m.kind === "constructor");
  return (ctor?.params ?? []).map((p) => (t.isIdentifier(p) ? p.name : t.isAssignmentPattern(p) && t.isIdentifier(p.left) ? p.left.name : ""));
}

function usageOf(program: NodePath<t.Program>, name: string): Usage {
  const usage: Usage = { keys: [], props: [], vars: [], params: [], returned: false, subclasses: [], statuses: [] };
  for (const ref of program.scope.getBinding(name)?.referencePaths ?? []) {
    const parent = ref.parentPath;
    if (!parent) continue;
    if ((parent.isClassDeclaration() || parent.isClassExpression()) && parent.node.superClass === ref.node) {
      const id = (parent.node as t.Class).id;
      if (id) usage.subclasses.push(id.name);
      continue;
    }
    if (!parent.isNewExpression() || parent.node.callee !== ref.node) continue;
    const status = parent.node.arguments[0];
    if (t.isNumericLiteral(status)) usage.statuses.push(status.value);
    let up: NodePath | null = parent.parentPath;
    while (up && (up.isLogicalExpression() || up.isAwaitExpression() || up.isParenthesizedExpression() || up.isSequenceExpression())) up = up.parentPath;
    if (!up) continue;
    if (up.isVariableDeclarator() && t.isIdentifier(up.node.id)) usage.vars.push(up.node.id.name);
    else if (up.isAssignmentExpression() && t.isMemberExpression(up.node.left) && !up.node.left.computed) {
      const word = literalKey(up.node.left.property);
      if (word) usage.props.push({ word, owner: t.isThisExpression(up.node.left.object) ? enclosingClass(up) : null });
    } else if (up.isAssignmentExpression() && t.isIdentifier(up.node.left)) usage.vars.push(up.node.left.name);
    else if (up.isObjectProperty() && up.node.value === parent.node) {
      const word = literalKey(up.node.key);
      if (word) usage.props.push({ word, owner: null });
    } else if (up.isArrowFunctionExpression() || up.isFunctionExpression()) {
      const holder = up.parentPath;
      if (holder?.isObjectProperty()) {
        const word = literalKey(holder.node.key);
        if (word) usage.keys.push(word);
      } else if (holder?.isCallExpression() && t.isStringLiteral(holder.node.arguments[0])) usage.keys.push(holder.node.arguments[0].value);
    } else if (up.isReturnStatement()) usage.returned = true;
    else if ((up.isNewExpression() || up.isCallExpression()) && t.isIdentifier(up.node.callee)) {
      const index = up.node.arguments.indexOf(parent.node as never);
      const param = t.isNewExpression(up.node) ? constructorParams(program, up.node.callee.name)[index] : undefined;
      if (readable(param)) usage.params.push(param);
    } else if (up.isThrowStatement()) usage.returned = usage.returned || false;
  }
  return usage;
}

function extendsError(program: NodePath<t.Program>, name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const node = program.scope.getBinding(name)?.path.node;
  if (!t.isClassDeclaration(node) || !node.superClass) return false;
  if (t.isIdentifier(node.superClass) && /^(Error|TypeError|RangeError)$/.test(node.superClass.name) && !program.scope.getBinding(node.superClass.name)) return true;
  return t.isIdentifier(node.superClass) && extendsError(program, node.superClass.name, seen);
}

function ownFields(node: t.ClassDeclaration): string[] {
  const ctor = node.body.body.find((m): m is t.ClassMethod => t.isClassMethod(m) && m.kind === "constructor");
  const fields: string[] = [];
  if (!ctor) return fields;
  t.traverseFast(ctor.body, (n) => {
    if (t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && t.isThisExpression(n.left.object) && !n.left.computed) {
      const key = literalKey(n.left.property);
      if (key) fields.push(key);
    }
  });
  return fields;
}

function unique(words: string[]): string | null {
  const set = new Set(words.filter(readable));
  return set.size === 1 ? [...set][0]! : null;
}

function declaredErrorName(node: t.ClassDeclaration): string | null {
  let found: string | null = null;
  t.traverseFast(node.body, (n) => {
    if (found || !t.isAssignmentExpression(n) || !t.isMemberExpression(n.left) || !t.isThisExpression(n.left.object) || n.left.computed || !t.isIdentifier(n.left.property, { name: "name" })) return;
    if (t.isStringLiteral(n.right) && /^[A-Z][A-Za-z0-9]*Error$/.test(n.right.value)) found = n.right.value;
  });
  return found;
}

export function nameClasses(program: NodePath<t.Program>, candidates: Iterable<string>, taken: (name: string) => boolean): Map<string, ClassName> {
  const out = new Map<string, ClassName>();
  const list = [...candidates].filter((n) => t.isClassDeclaration(program.scope.getBinding(n)?.path.node));
  const usages = new Map(list.map((n) => [n, usageOf(program, n)]));
  const node = (n: string) => program.scope.getBinding(n)!.path.node as t.ClassDeclaration;
  const apiLike = new Set(list.filter((n) => hasApiPath(node(n))));
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of list) {
      if (apiLike.has(n)) continue;
      const children = list.filter((c) => usages.get(c)!.props.some((p) => p.owner === n));
      if (children.length && children.every((c) => apiLike.has(c))) {
        apiLike.add(n);
        grew = true;
      }
    }
  }
  const proposals = new Map<string, ClassName & { owner?: string | null }>();
  for (const n of list) {
    const usage = usages.get(n)!;
    const key = unique(usage.keys);
    const prop = unique(usage.props.map((p) => p.word));
    const owners = [...new Set(usage.props.map((p) => p.owner))];
    if (extendsError(program, n)) {
      const status = [...new Set(usage.statuses)];
      const fields = ownFields(node(n));
      const name = declaredErrorName(node(n)) ?? (status.length === 1 && STATUS_ERRORS[status[0]!] ? STATUS_ERRORS[status[0]!]! : fields.includes("status") ? "HttpError" : usage.subclasses.length ? "BaseError" : fields[0] && readable(fields[0]) ? `${pascal(fields[0])}Error` : null);
      if (name) proposals.set(n, { name, role: "error" });
      continue;
    }
    if (key && /^[A-Za-z]/.test(key)) {
      proposals.set(n, { name: pascal(key), role: "model" });
      continue;
    }
    if (prop && apiLike.has(n)) {
      proposals.set(n, { name: `${pascal(prop)}Api`, role: "api", owner: owners.length === 1 ? owners[0] : null });
      continue;
    }
    const children = list.filter((c) => apiLike.has(c) && usages.get(c)!.props.some((p) => p.owner === n));
    if (usage.returned && children.length >= 3) {
      proposals.set(n, { name: "ApiClient", role: "client" });
      continue;
    }
    const word = prop ?? unique(usage.vars) ?? unique(usage.params);
    if (word) proposals.set(n, { name: pascal(word), role: "other" });
  }
  for (const n of list) {
    if (proposals.has(n)) continue;
    const subs = usages.get(n)!.subclasses.filter((s) => proposals.get(s)?.role === "model");
    if (subs.length >= 2) proposals.set(n, { name: "Model", role: "model" });
  }
  const counts = new Map<string, number>();
  for (const p of proposals.values()) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const used = new Set<string>();
  for (const [n, p] of proposals) {
    let name = p.name;
    if ((counts.get(name) ?? 0) > 1 && p.owner) {
      const owner = proposals.get(p.owner);
      if (owner && owner.role === "api") name = `${owner.name.replace(/Api$/, "")}${name}`;
    }
    if ((used.has(name) || taken(name)) && p.role === "model") name = `${name}Model`;
    const base = name;
    for (let i = 2; used.has(name) || taken(name); i++) name = `${base}${i}`;
    used.add(name);
    out.set(n, { name, role: p.role });
  }
  return out;
}
