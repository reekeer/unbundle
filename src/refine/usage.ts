import type { NodePath } from "@babel/traverse";
import { literalKey, parseProgram, t, traverse } from "../unpack/ast.ts";
import { moduleIdFromSpecifier } from "./rename.ts";

interface Signature {
  name: string;
  keys: string[];
  without?: string[];
}

const DEFAULT_MEMBERS: Array<{ packages: RegExp; members: RegExp }> = [
  { packages: /^axios$/, members: /^(create|get|post|put|patch|delete|request|interceptors|defaults|isAxiosError|all|isCancel)$/ },
  { packages: /^react$/, members: /^(createElement|useState|useEffect|Fragment|forwardRef|memo)$/ },
];

const SIGNATURES: Array<{ packages: RegExp; signatures: Signature[] }> = [
  {
    packages: /^@tanstack\//,
    signatures: [
      { name: "useInfiniteQuery", keys: ["queryKey", "getNextPageParam"] },
      { name: "useQuery", keys: ["queryKey"], without: ["getNextPageParam"] },
      { name: "useMutation", keys: ["mutationFn"] },
      { name: "useQueries", keys: ["queries"] },
    ],
  },
];

function returnsObject(node: t.Node | undefined): boolean {
  if (!t.isArrowFunctionExpression(node) && !t.isFunctionExpression(node)) return false;
  if (t.isObjectExpression(node.body)) return true;
  return t.isBlockStatement(node.body) && node.body.body.some((s) => t.isReturnStatement(s) && t.isObjectExpression(s.argument));
}

function storeFactoryName(path: NodePath<t.CallExpression>): string | null {
  const creator = path.node.arguments[0];
  if (path.node.arguments.length !== 1 || !returnsObject(creator)) return null;
  const declarator = path.parentPath;
  if (!declarator?.isVariableDeclarator() || !t.isIdentifier(declarator.node.id)) return null;
  const binding = declarator.scope.getBinding(declarator.node.id.name);
  if (!binding?.referencePaths.length) return null;
  const called = binding.referencePaths.some((ref) => ref.parentPath?.isCallExpression() && ref.parentPath.node.callee === ref.node);
  const asStore = binding.referencePaths.some((ref) => ref.parentPath?.isMemberExpression() && /^(getState|setState|subscribe)$/.test(literalKey(ref.parentPath.node.property) ?? ""));
  if (called) return "create";
  return asStore ? "createStore" : null;
}

function keysOf(node: t.Node | undefined): Set<string> | null {
  if (!t.isObjectExpression(node)) return null;
  const keys = new Set<string>();
  for (const prop of node.properties) {
    if ((t.isObjectProperty(prop) || t.isObjectMethod(prop)) && !prop.computed) {
      const key = literalKey(prop.key);
      if (key) keys.add(key);
    }
  }
  return keys;
}

export interface UsageTarget {
  id: string;
  package: string;
}

export function usageRenames(importers: Array<{ code: string }>, targets: Map<string, UsageTarget>, resolve: (id: string) => string): Map<string, Map<string, string>> {
  const votes = new Map<string, Map<string, Map<string, number>>>();
  for (const importer of importers) {
    if (![...targets.keys()].some((id) => importer.code.includes(id))) continue;
    let ast: t.File;
    try {
      ast = parseProgram(importer.code);
    } catch {
      continue;
    }
    const locals = new Map<string, { target: string; export: string | null }>();
    for (const stmt of ast.program.body) {
      if (!t.isImportDeclaration(stmt)) continue;
      const raw = moduleIdFromSpecifier(stmt.source.value);
      const id = raw ? resolve(raw) : null;
      if (!id || !targets.has(id)) continue;
      for (const spec of stmt.specifiers) {
        if (t.isImportSpecifier(spec)) locals.set(spec.local.name, { target: id, export: t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value });
        else if (t.isImportNamespaceSpecifier(spec)) locals.set(spec.local.name, { target: id, export: null });
      }
    }
    if (!locals.size) continue;
    const vote = (target: string, exported: string, name: string) => {
      const byExport = votes.get(target) ?? new Map<string, Map<string, number>>();
      const byName = byExport.get(exported) ?? new Map<string, number>();
      byName.set(name, (byName.get(name) ?? 0) + 1);
      byExport.set(exported, byName);
      votes.set(target, byExport);
    };
    traverse(ast, {
      MemberExpression(path) {
        const object = path.node.object;
        let found: { target: string; export: string } | null = null;
        if (t.isIdentifier(object) && locals.get(object.name)?.export) found = locals.get(object.name) as { target: string; export: string };
        else if (t.isMemberExpression(object) && !object.computed && t.isIdentifier(object.object) && locals.get(object.object.name)?.export === null) {
          const prop = literalKey(object.property);
          if (prop) found = { target: locals.get(object.object.name)!.target, export: prop };
        }
        const member = path.node.computed ? null : literalKey(path.node.property);
        if (!found || !member || found.export.length > 2) return;
        const pkg = targets.get(found.target)!.package;
        if (DEFAULT_MEMBERS.some((d) => d.packages.test(pkg) && d.members.test(member))) vote(found.target, found.export, "default");
      },
      CallExpression(path) {
        let callee: t.Node = path.node.callee;
        if (t.isSequenceExpression(callee)) callee = callee.expressions.at(-1)!;
        let found: { target: string; export: string } | null = null;
        if (t.isIdentifier(callee) && locals.get(callee.name)?.export) found = locals.get(callee.name) as { target: string; export: string };
        else if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.object) && locals.has(callee.object.name) && locals.get(callee.object.name)!.export === null) {
          const prop = literalKey(callee.property);
          if (prop) found = { target: locals.get(callee.object.name)!.target, export: prop };
        }
        if (!found || found.export.length > 2) return;
        const pkg = targets.get(found.target)!.package;
        if (/^zustand$/.test(pkg)) {
          const factory = storeFactoryName(path);
          if (factory) vote(found.target, found.export, factory);
          return;
        }
        const keys = keysOf(path.node.arguments[0] as t.Node | undefined);
        if (!keys) return;
        const table = SIGNATURES.find((s) => s.packages.test(pkg));
        const match = table?.signatures.find((sig) => sig.keys.every((k) => keys.has(k)) && !(sig.without ?? []).some((k) => keys.has(k)));
        if (!match) return;
        vote(found.target, found.export, match.name);
      },
    });
  }
  const out = new Map<string, Map<string, string>>();
  for (const [target, byExport] of votes) {
    const renames = new Map<string, string>();
    const used = new Set<string>();
    for (const [exported, names] of byExport) {
      const ranked = [...names].sort((a, b) => b[1] - a[1]);
      if (ranked.length > 1 && ranked[1]![1] === ranked[0]![1]) continue;
      const name = ranked[0]![0];
      if (used.has(name)) continue;
      used.add(name);
      renames.set(exported, name);
    }
    if (renames.size) out.set(target, renames);
  }
  return out;
}
