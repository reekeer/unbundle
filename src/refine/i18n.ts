import { posix } from "node:path";
import type { OutputFile } from "../types.ts";
import { literalKey, parseProgram, print, t, traverse } from "../unpack/ast.ts";

type Node = Record<string, unknown>;

function field(object: t.ObjectExpression, key: string): t.Node | undefined {
  return object.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === key)?.value;
}

function plain(node: t.Node | undefined): unknown {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isArrayExpression(node)) return node.elements.map((e) => (e ? plain(e) : null));
  if (t.isObjectExpression(node)) {
    const out: Node = {};
    for (const prop of node.properties) {
      if (!t.isObjectProperty(prop)) return undefined;
      const key = literalKey(prop.key);
      if (!key) return undefined;
      const value = plain(prop.value);
      if (value === undefined) return undefined;
      out[key] = value;
    }
    return out;
  }
  return undefined;
}

function escapeText(text: string): string {
  return text.replace(/[{}@|]/g, (c) => `{'${c}'}`);
}

function messageSource(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Node;
  switch (n.t) {
    case 0:
      return messageSource(n.b);
    case 1: {
      const cases = Array.isArray(n.c) ? n.c.map(messageSource) : [];
      return cases.every((c) => c !== null) ? cases.join(" | ") : null;
    }
    case 2: {
      if (typeof n.s === "string") return escapeText(n.s);
      const items = Array.isArray(n.i) ? n.i.map(messageSource) : [];
      return items.every((i) => i !== null) ? items.join("") : null;
    }
    case 3:
      return typeof n.v === "string" ? escapeText(n.v) : "";
    case 4:
      return typeof n.k === "string" ? `{${n.k}}` : null;
    case 5:
      return typeof n.i === "number" ? `{${n.i}}` : null;
    case 6: {
      const key = messageSource(n.k);
      const modifier = n.m && typeof (n.m as Node).v === "string" ? `.${(n.m as Node).v}` : "";
      return key === null ? null : `@${modifier}:${key}`;
    }
    case 7:
    case 8:
      return typeof n.v === "string" ? n.v : null;
    case 9:
      return typeof n.v === "string" ? `{'${n.v}'}` : null;
    default:
      return null;
  }
}

function isCompiledMessage(node: t.Node): node is t.ObjectExpression {
  if (!t.isObjectExpression(node)) return false;
  const type = field(node, "t");
  const body = field(node, "b");
  return t.isNumericLiteral(type, { value: 0 }) && t.isObjectExpression(body) && node.properties.length === 2;
}

export function decompileMessages(code: string): { code: string; count: number } {
  if (!/\bt:\s*0,\s*b:\s*\{/.test(code)) return { code, count: 0 };
  let ast: t.File;
  try {
    ast = parseProgram(code);
  } catch {
    return { code, count: 0 };
  }
  let count = 0;
  traverse(ast, {
    ObjectExpression(path) {
      if (!isCompiledMessage(path.node)) return;
      const source = messageSource(plain(path.node));
      if (source === null) return;
      path.replaceWith(t.stringLiteral(source));
      count++;
      path.skip();
    },
  });
  return count ? { code: print(ast), count } : { code, count: 0 };
}

function stringOf(node: t.Node | undefined): string | null {
  return t.isStringLiteral(node) ? node.value : null;
}

function localeFile(key: string | null, code: string | null): string | null {
  const encoded = key ? /^locale_(.+?)_([0-9a-f]{6,})$/.exec(key)?.[1] : undefined;
  if (encoded) {
    const decoded = encoded.replace(/_(\d{2,3})/g, (_, n: string) => String.fromCharCode(Number(n)));
    if (/^[\w.-]+\.(ts|js|json|mjs|yaml|yml)$/.test(decoded)) return decoded;
  }
  return code ? `${code}.ts` : null;
}

export function nuxtLocales(files: OutputFile[]): Map<string, string> {
  const byPath = new Set(files.filter((f) => f.kind === "module" || f.kind === "script").map((f) => f.path));
  const resolve = (from: string, spec: string) => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    return [base, `${base}.js`, `${base}.ts`].find((p) => byPath.has(p)) ?? null;
  };
  const moves = new Map<string, string>();
  for (const file of files) {
    if ((file.kind !== "module" && file.kind !== "script") || !/\.m?js$/.test(file.path) || !file.content.includes("locale_")) continue;
    let ast: t.File;
    try {
      ast = parseProgram(file.content);
    } catch {
      continue;
    }
    t.traverseFast(ast.program, (n) => {
      if (!t.isObjectExpression(n)) return;
      for (const prop of n.properties) {
        if (!t.isObjectProperty(prop) || !t.isArrayExpression(prop.value)) continue;
        const code = literalKey(prop.key);
        for (const entry of prop.value.elements) {
          if (!t.isObjectExpression(entry)) continue;
          const key = stringOf(field(entry, "key"));
          const load = field(entry, "load");
          if (!key?.startsWith("locale_") || !(t.isArrowFunctionExpression(load) || t.isFunctionExpression(load))) continue;
          let spec: string | null = null;
          t.traverseFast(load, (x) => {
            if (!spec && t.isCallExpression(x) && t.isImport(x.callee)) spec = stringOf(x.arguments[0]);
          });
          const target = spec ? resolve(file.path, spec) : null;
          const name = localeFile(key, code);
          if (target && name && !moves.has(target)) moves.set(target, posix.join("i18n", "locales", name.replace(/\.(ts|mjs)$/, ".js")));
        }
      }
    });
  }
  return moves;
}

export function inlineLocaleModules(files: OutputFile[]): OutputFile[] {
  const added: OutputFile[] = [];
  const taken = new Set(files.map((f) => f.path));
  for (const file of files) {
    if ((file.kind !== "module" && file.kind !== "script") || !/\.m?js$/.test(file.path) || !file.content.includes("locale_") || !file.content.includes("Promise.resolve")) continue;
    let ast: t.File;
    try {
      ast = parseProgram(file.content);
    } catch {
      continue;
    }
    const moved: string[] = [];
    traverse(ast, {
      ObjectExpression(path) {
        const key = stringOf(field(path.node, "key"));
        const load = field(path.node, "load");
        if (!key?.startsWith("locale_") || !(t.isArrowFunctionExpression(load) || t.isFunctionExpression(load))) return;
        const body = t.isBlockStatement(load.body) ? (load.body.body.length === 1 && t.isReturnStatement(load.body.body[0]) ? load.body.body[0].argument : null) : load.body;
        if (!t.isCallExpression(body) || !t.isMemberExpression(body.callee) || !t.isIdentifier(body.callee.object, { name: "Promise" }) || literalKey(body.callee.property) !== "resolve" || !t.isIdentifier(body.arguments[0])) return;
        const local = body.arguments[0].name;
        const binding = path.scope.getBinding(local);
        const init = binding?.path.isVariableDeclarator() ? binding.path.node.init : null;
        if (!binding || !t.isObjectExpression(init) || binding.references !== 1 || binding.scope.path.type !== "Program") return;
        const name = (localeFile(key, null) ?? `${local}.js`).replace(/\.(json|ts|mjs|yaml|yml)$/, "");
        let target = posix.join(posix.dirname(file.path), "locales", `${name}.js`);
        for (let n = 2; taken.has(target); n++) target = posix.join(posix.dirname(file.path), "locales", `${name}-${n}.js`);
        taken.add(target);
        added.push({ ...file, path: target, content: `export default ${print(t.file(t.program([t.expressionStatement(t.cloneNode(init, true))]))).replace(/;\s*$/, "")};\n` });
        const specifier = `./${posix.relative(posix.dirname(file.path), target)}`;
        load.body = t.callExpression(t.import(), [t.stringLiteral(specifier)]);
        if (t.isArrowFunctionExpression(load)) load.expression = true;
        const holder = binding.path.parentPath;
        if (holder?.isVariableDeclaration() && holder.node.declarations.length === 1) holder.remove();
        else binding.path.remove();
        moved.push(target);
      },
    });
    if (moved.length) file.content = print(ast);
  }
  return added;
}

export function defaultExportJson(code: string): string | null {
  try {
    const ast = parseProgram(code);
    const stmt = ast.program.body.find((st): st is t.ExportDefaultDeclaration => t.isExportDefaultDeclaration(st));
    const value = stmt && t.isExpression(stmt.declaration) ? plain(stmt.declaration) : undefined;
    return value === undefined ? null : `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return null;
  }
}
