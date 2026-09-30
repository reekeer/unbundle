import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { NodePath } from "@babel/traverse";
import { parseProgram, print, t, traverse } from "../../src/unpack/ast.ts";

type Value = number | string | boolean;

const cache = new Map<string, Map<string, Value>>();
const importsCache = new Map<string, Record<string, unknown>>();

function primitive(value: unknown): value is Value {
  return (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
}

function literal(value: Value): t.Expression {
  if (typeof value === "number") return value < 0 ? t.unaryExpression("-", t.numericLiteral(-value)) : t.numericLiteral(value);
  if (typeof value === "boolean") return t.booleanLiteral(value);
  return t.stringLiteral(value);
}

function constantsOf(file: string): Map<string, Value> {
  const known = cache.get(file);
  if (known) return known;
  const out = new Map<string, Value>();
  cache.set(file, out);
  if (!existsSync(file)) return out;
  try {
    traverse(parseProgram(readFileSync(file, "utf8")), {
      Program(program) {
        for (const stmt of program.get("body")) {
          const decl = stmt.isExportNamedDeclaration() ? stmt.get("declaration") : stmt;
          if (!decl.isVariableDeclaration() || decl.node.kind !== "const") continue;
          for (const declarator of decl.get("declarations")) {
            const id = declarator.node.id;
            const init = declarator.get("init");
            if (!t.isIdentifier(id) || !init.node) continue;
            const result = init.evaluate();
            if (result.confident && primitive(result.value)) out.set(id.name, result.value);
          }
        }
        program.stop();
      },
    });
  } catch {
    return out;
  }
  return out;
}

function packageImports(root: string): Record<string, unknown> {
  let imports = importsCache.get(root);
  if (!imports) {
    try {
      imports = ((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { imports?: Record<string, unknown> }).imports ?? {}) as Record<string, unknown>;
    } catch {
      imports = {};
    }
    importsCache.set(root, imports);
  }
  return imports;
}

function resolveSpecifier(specifier: string, from: string, root: string): string | null {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(from), specifier);
    return [base, `${base}.js`, `${base}.mjs`, join(base, "index.js")].find((p) => existsSync(p) && /\.[cm]?js$/.test(p)) ?? null;
  }
  if (specifier.startsWith("#")) {
    const target = packageImports(root)[specifier];
    const path = typeof target === "string" ? target : target && typeof target === "object" ? ((target as Record<string, unknown>).default ?? (target as Record<string, unknown>).import) : null;
    return typeof path === "string" && /\.[cm]?js$/.test(path) ? join(root, path) : null;
  }
  return null;
}

export function inlineConstants(code: string, file: string, root: string): string {
  if (!/^\s*import\s/m.test(code) && !/\bconst\s/.test(code)) return code;
  let ast: t.File;
  try {
    ast = parseProgram(code);
  } catch {
    return code;
  }
  const values = new Map<string, Value>();
  for (const stmt of ast.program.body) {
    if (!t.isImportDeclaration(stmt)) continue;
    const target = resolveSpecifier(stmt.source.value, file, root);
    if (!target) continue;
    const constants = constantsOf(target);
    if (!constants.size) continue;
    for (const spec of stmt.specifiers) {
      if (!t.isImportSpecifier(spec)) continue;
      const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
      if (constants.has(imported)) values.set(spec.local.name, constants.get(imported)!);
    }
  }
  for (const [name, value] of constantsOf(file)) values.set(name, value);
  if (!values.size) return code;
  let changed = false;
  traverse(ast, {
    Identifier(path) {
      const value = values.get(path.node.name);
      if (value === undefined || !path.isReferencedIdentifier()) return;
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || binding.scope.block !== ast.program || (binding.kind !== "module" && binding.kind !== "const")) return;
      if (path.parentPath.isExportSpecifier()) return;
      if (path.parentPath.isObjectProperty() && path.parentPath.node.shorthand) path.parentPath.node.shorthand = false;
      path.replaceWith(literal(value));
      changed = true;
    },
  });
  if (!changed) return code;
  traverse(ast, {
    "BinaryExpression|UnaryExpression|LogicalExpression": {
      exit(path: NodePath<t.BinaryExpression | t.UnaryExpression | t.LogicalExpression>) {
        if (t.isUnaryExpression(path.node) && path.node.operator === "-" && t.isNumericLiteral(path.node.argument)) return;
        const result = path.evaluate();
        if (result.confident && primitive(result.value) && typeof result.value === "number") path.replaceWith(literal(result.value));
      },
    },
  });
  return print(ast);
}
