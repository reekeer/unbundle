import { posix } from "node:path";
import type { NodePath } from "@babel/traverse";
import type { OutputTree } from "../output.ts";
import type { OutputFile } from "../types.ts";
import { literalKey, parseProgram, print, t, traverse } from "../unpack/ast.ts";
import { RESERVED } from "./rename.ts";
import { semanticFunctionName, subjectFunctionName } from "./semantic.ts";

export interface Source {
  file: OutputFile;
  ast: t.File;
  script: RegExpExecArray | null;
  outside: string;
  templateRenames: Map<string, string>;
}

const CODE = /\.(m?jsx?|vue)$/;

function isMangled(name: string): boolean {
  return name.length <= 2 || /^[a-z]\d+$/i.test(name) || /^(merged|module|constants|utils|hook)\d*$/.test(name);
}

function threeLetter(path: string, name: string): boolean {
  return !/(^|\/)(node_modules|vendor)\//.test(path) && /^[A-Za-z_$][\w$]{2}$/.test(name) && !RESERVED.has(name);
}

function stringBinding(program: NodePath<t.Program>): (local: string) => string | null {
  return (local) => {
    const bound = program.scope.getBinding(local)?.path.node;
    return t.isVariableDeclarator(bound) && t.isStringLiteral(bound.init) ? bound.init.value : null;
  };
}

function mangledIn(path: string, name: string): boolean {
  return isMangled(name) || (/(^|\/)(node_modules|vendor)\//.test(path) && /^[A-Za-z_$][A-Za-z_$\d]{2}$/.test(name) && !/^[a-z]+$/.test(name));
}

function isPlaceholder(name: string): boolean {
  return isMangled(name) || /^(formatValue|isValue|renderValue)\d*$/.test(name);
}

function isReadable(name: string): boolean {
  return name.length > 2 && /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED.has(name) && !/^(module|value|fn|component)\d*$/i.test(name) && !/^_/.test(name);
}

function resolve(from: string, specifier: string): string | null {
  return specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(from), specifier)) : null;
}

export function programPath(ast: t.File): NodePath<t.Program> {
  let program: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program!;
}

export function load(file: OutputFile): Source | null {
  const script = file.path.endsWith(".vue") ? /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/.exec(file.content) : null;
  if (file.path.endsWith(".vue") && !script) return null;
  const code = script ? script[2]! : file.content;
  const ast = parseProgram(code);
  if ((ast as { errors?: unknown[] }).errors?.length) return null;
  const outside = script ? `${file.content.slice(0, script.index)}${file.content.slice(script.index + script[0].length)}` : "";
  return { file, ast, script, outside, templateRenames: new Map() };
}

export interface OutlineImport {
  source: string;
  specifiers: Array<{ kind: "named" | "default" | "namespace"; imported: string; local: string }>;
}

export interface Outline {
  imports: OutlineImport[];
  exports: Array<{ local: string; exported: string }>;
  reexports: Array<{ source: string; locals: string[] }>;
  exportAll: string[];
  dynamic: string[];
}

const OUTLINES = new Map<string, Outline | null>();
const MAX_OUTLINED_CHARS = 64 * 1024 * 1024;
let outlinedChars = 0;

export function outline(file: OutputFile): Outline | null {
  if (file.path.endsWith(".vue")) return null;
  const cached = OUTLINES.get(file.content);
  if (cached !== undefined) return cached;
  let found: Outline | null = null;
  try {
    const ast = parseProgram(file.content);
    if (!(ast as { errors?: unknown[] }).errors?.length) {
      found = { imports: [], exports: [], reexports: [], exportAll: [], dynamic: [] };
      for (const stmt of ast.program.body) {
        if (t.isImportDeclaration(stmt)) {
          found.imports.push({
            source: stmt.source.value,
            specifiers: stmt.specifiers.map((spec) => (t.isImportNamespaceSpecifier(spec) ? { kind: "namespace" as const, imported: "*", local: spec.local.name } : t.isImportDefaultSpecifier(spec) ? { kind: "default" as const, imported: "default", local: spec.local.name } : { kind: "named" as const, imported: t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value, local: spec.local.name })),
          });
        } else if (t.isExportAllDeclaration(stmt)) found.exportAll.push(stmt.source.value);
        else if (t.isExportNamedDeclaration(stmt) && !stmt.declaration) {
          const specs = stmt.specifiers.filter((spec): spec is t.ExportSpecifier => t.isExportSpecifier(spec));
          if (stmt.source) found.reexports.push({ source: stmt.source.value, locals: specs.map((spec) => spec.local.name) });
          else for (const spec of specs) found.exports.push({ local: spec.local.name, exported: t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value });
        }
      }
      t.traverseFast(ast.program, (node) => {
        if (t.isCallExpression(node) && t.isImport(node.callee) && t.isStringLiteral(node.arguments[0])) found!.dynamic.push(node.arguments[0].value);
      });
    }
  } catch {
    found = null;
  }
  OUTLINES.set(file.content, found);
  outlinedChars += file.content.length;
  for (const key of OUTLINES.keys()) {
    if (outlinedChars <= MAX_OUTLINED_CHARS) break;
    OUTLINES.delete(key);
    outlinedChars -= key.length;
  }
  return found;
}

function vendorFile(file: OutputFile): boolean {
  return !!file.library || /(^|\/)(node_modules|vendor)\//.test(file.path);
}

export function save(source: Source): void {
  const code = print(source.ast);
  const { file, script } = source;
  if (!script) {
    file.content = code;
    return;
  }
  const imported = importedComponents(source.ast.program);
  const before = componentTags(renameTemplate(file.content.slice(0, script.index), source.templateRenames), imported);
  const after = componentTags(renameTemplate(file.content.slice(script.index + script[0].length), source.templateRenames), imported);
  file.content = `${before}${script[1]}\n${code.trim()}\n${script[3]}${after}`;
}

function importedComponents(program: t.Program): Set<string> {
  const names = new Set<string>();
  for (const stmt of program.body) {
    if (!t.isImportDeclaration(stmt)) continue;
    for (const spec of stmt.specifiers) if (!t.isImportNamespaceSpecifier(spec) && /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(spec.local.name)) names.add(spec.local.name);
  }
  return names;
}

function componentTags(html: string, names: Set<string>): string {
  if (!names.size || !html.includes("<component")) return html;
  const stack: Array<string | null> = [];
  return html.replace(/<\/component\s*>|<component\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g, (whole, attrs: string | undefined, selfClosing: string | undefined) => {
    if (whole.startsWith("</")) {
      const name = stack.pop();
      return name ? `</${name}>` : whole;
    }
    const is = /\s:is\s*=\s*"([A-Za-z_$][\w$]*)"/.exec(attrs!);
    const name = is && names.has(is[1]!) ? is[1]! : null;
    if (!selfClosing) stack.push(name);
    return name ? `<${name}${attrs!.replace(is![0], "")}${selfClosing}>` : whole;
  });
}

function templateCode(outside: string): string {
  const parts: string[] = [];
  for (const match of outside.matchAll(/\{\{([\s\S]*?)\}\}/g)) parts.push(match[1]!);
  for (const match of outside.matchAll(/\s(?::|@|#|v-)[\w:.\-[\]]*\s*=\s*"([^"]*)"/g)) parts.push(match[1]!);
  for (const match of outside.matchAll(/<([A-Za-z][\w.-]*)/g)) parts.push(match[1]!);
  return parts.join("\n");
}

function templatePrograms(source: Source): t.Program[] {
  if (!source.script) return [];
  const out: t.Program[] = [];
  for (const expression of templateCode(source.outside).split("\n")) {
    if (!/\(/.test(expression)) continue;
    try {
      const ast = parseProgram(`(${expression});`);
      if (!(ast as { errors?: unknown[] }).errors?.length) out.push(ast.program);
    } catch {
      continue;
    }
  }
  return out;
}

function renameCode(part: string, renames: Map<string, string>): string {
  return part.replace(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g, (name: string, _: string, at: number, whole: string) => (/[{,]\s*$/.test(whole.slice(0, at)) && /^\s*:(?!:)/.test(whole.slice(at + name.length)) ? name : (renames.get(name) ?? name)));
}

function renameExpression(code: string, renames: Map<string, string>): string {
  return code
    .split(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/)
    .map((part, i) => {
      if (!(i % 2)) return renameCode(part, renames);
      if (!part.startsWith("`")) return part;
      return part.replace(/\$\{([^{}]*)\}/g, (_, inner: string) => `\${${renameExpression(inner, renames)}}`);
    })
    .join("");
}

function renameTemplate(html: string, renames: Map<string, string>): string {
  if (!renames.size) return html;
  return html
    .replace(/(<\/?)([A-Z][\w$]*)(?=[\s/>])/g, (whole, open: string, name: string) => (renames.has(name) && /^[A-Z][A-Za-z0-9]*$/.test(renames.get(name)!) ? `${open}${renames.get(name)}` : whole))
    .replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) => `{{${renameExpression(expr, renames)}}}`)
    .replace(/(\s(?::|@|#|v-)[\w:.\-[\]]*\s*=\s*")([^"]*)(")/g, (_, open: string, expr: string, close: string) => `${open}${renameExpression(expr, renames)}${close}`);
}

function templateDeclares(source: Source, name: string): boolean {
  const pattern = new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, "\\$")}($|[^\\w$])`);
  for (const match of source.outside.matchAll(/\sv-for\s*=\s*"([^"]*?)\s+(?:in|of)\s/g)) if (pattern.test(match[1]!)) return true;
  for (const match of source.outside.matchAll(/\s(?:#|v-slot)[\w:.\-[\]]*\s*=\s*"([^"]*)"/g)) if (pattern.test(match[1]!)) return true;
  return false;
}

function templateSafe(source: Source, from: string, to: string): boolean {
  if (!source.script) return true;
  const tag = (name: string) => new RegExp(`</?${name.replace(/\$/g, "\\$")}(?![\\w$.-])`).test(source.outside);
  return !templateDeclares(source, from) && !templateDeclares(source, to) && !inTemplate(source, to) && (!tag(from) || /^[a-z]/.test(from) || (/^[A-Z]/.test(from) && /^[A-Z][A-Za-z0-9]*$/.test(to) && !tag(to)));
}

function withoutStrings(code: string): string {
  let out = "";
  const stack: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const char = code[i]!;
    const mode = stack.at(-1);
    if (mode === "'" || mode === '"') {
      if (char === "\\") i++;
      else if (char === mode) stack.pop();
      out += " ";
      continue;
    }
    if (mode === "`") {
      if (char === "\\") i++;
      else if (char === "`") stack.pop();
      else if (char === "$" && code[i + 1] === "{") {
        stack.push("{");
        i++;
      }
      out += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      stack.push(char);
      out += " ";
      continue;
    }
    if (mode === "{" && char === "}") {
      stack.pop();
      out += " ";
      continue;
    }
    if (char === "{" && mode === "{") stack.push("{");
    out += char;
  }
  return out;
}

function elementSpan(template: string, at: number): number {
  const open = template.lastIndexOf("<", at);
  const name = /^<([A-Za-z][\w.:-]*)/.exec(template.slice(open))?.[1];
  if (!name) return template.length;
  const pattern = new RegExp(`<(/?)${name.replace(/[.:-]/g, "\\$&")}(?=[\\s/>])`, "g");
  pattern.lastIndex = open + 1;
  let depth = 1;
  for (let match = pattern.exec(template); match; match = pattern.exec(template)) {
    depth += match[1] ? -1 : 1;
    if (!depth) return match.index;
  }
  return template.length;
}

function inTemplate(source: Source, name: string): boolean {
  return new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, "\\$")}($|[^\\w$])`).test(withoutStrings(templateCode(source.outside)));
}

const CALL_SHAPES: Array<{ name: string; accepts: (keys: string[]) => boolean; body: RegExp }> = [
  { name: "useSeoMeta", accepts: (keys) => keys.some((k) => /^(og|twitter)[A-Z]/.test(k)) && keys.every((k) => /^((og|twitter|article|fb|msapplication)[A-Z]\w*|description|title|titleTemplate|robots|keywords|author|themeColor|colorScheme|applicationName|referrer|viewport|charset)$/.test(k)), body: /\bhead\b/ },
  { name: "useHead", accepts: (keys) => keys.length > 0 && keys.every((k) => /^(title|titleTemplate|templateParams|meta|link|script|style|noscript|base|htmlAttrs|bodyAttrs)$/.test(k)) && keys.some((k) => /^(meta|link|script|style|htmlAttrs|bodyAttrs)$/.test(k)), body: /\bhead\b/ },
];

function usageNames(sources: Map<string, Source>, blocked: Set<string>): Map<string, Map<string, string>> {
  const votes = new Map<string, Map<string, Set<string>>>();
  for (const [path, source] of sources) {
    const imported = new Map<string, { target: string; name: string }>();
    for (const stmt of source.ast.program.body) {
      if (!t.isImportDeclaration(stmt)) continue;
      const target = resolve(path, stmt.source.value);
      if (!target || blocked.has(target) || !sources.has(target)) continue;
      for (const spec of stmt.specifiers) if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && isMangled(spec.imported.name)) imported.set(spec.local.name, { target, name: spec.imported.name });
    }
    if (!imported.size) continue;
    const members = new Map<string, Set<string>>();
    t.traverseFast(source.ast.program, (node) => {
      if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.object) && t.isIdentifier(node.property)) members.set(node.object.name, (members.get(node.object.name) ?? new Set()).add(node.property.name));
    });
    t.traverseFast(source.ast.program, (node) => {
      if (!t.isVariableDeclarator(node) || !t.isIdentifier(node.id) || !t.isCallExpression(node.init) || node.init.arguments.length || !t.isIdentifier(node.init.callee) || !imported.has(node.init.callee.name)) return;
      const used = [...(members.get(node.id.name) ?? [])];
      const toast = used.filter((m) => /^(success|error|warning|info)$/.test(m)).length >= 2;
      if (!toast) return;
      const { target, name } = imported.get(node.init.callee.name)!;
      const byExport = votes.get(target) ?? new Map<string, Set<string>>();
      byExport.set(name, (byExport.get(name) ?? new Set()).add("useToast"));
      votes.set(target, byExport);
    });
    t.traverseFast(source.ast.program, (node) => {
      if (!t.isCallExpression(node) || !t.isIdentifier(node.callee) || !imported.has(node.callee.name)) return;
      if (!node.arguments.length) return;
      const { target, name } = imported.get(node.callee.name)!;
      const arg = node.arguments[0];
      const keys = t.isObjectExpression(arg) && node.arguments.length === 1 ? arg.properties.map((p) => (t.isObjectProperty(p) || t.isObjectMethod(p)) && !p.computed && t.isIdentifier(p.key) ? p.key.name : "") : [""];
      const shape = keys.includes("") ? undefined : CALL_SHAPES.find((c) => c.accepts(keys));
      const byExport = votes.get(target) ?? new Map<string, Set<string>>();
      byExport.set(name, (byExport.get(name) ?? new Set()).add(shape?.name ?? ""));
      votes.set(target, byExport);
    });
  }
  const out = new Map<string, Map<string, string>>();
  for (const [target, byExport] of votes) {
    const source = sources.get(target)!;
    const program = programPath(source.ast);
    const table = new Map<string, string>();
    for (const [exported, shapes] of byExport) {
      const name = [...shapes][0]!;
      if (shapes.size !== 1 || !name || program.scope.hasBinding(name)) continue;
      let local: string | null = null;
      let declared = false;
      for (const stmt of source.ast.program.body) {
        if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
        for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported, { name: exported })) local = spec.local.name;
        if (stmt.declaration && Object.keys(t.getBindingIdentifiers(stmt.declaration)).includes(exported)) {
          local = exported;
          declared = true;
        }
      }
      const binding = local ? program.scope.getBinding(local) : undefined;
      if (!binding || !isMangled(local!)) continue;
      const shape = CALL_SHAPES.find((c) => c.name === name);
      if (shape && !shape.body.test(print(binding.path.node))) continue;
      program.scope.rename(local!, name);
      if (declared) table.set(exported, name);
    }
    if (table.size) out.set(target, table);
  }
  return out;
}

const GENERIC_RESULT = /^(result|results|value|values|res|ret|tmp|temp|data|response|item|items|output|out|val|obj|args|options|props|fn|callback|handler|el|element|node|str|text|list|array|arr|key|index|count|id)$/;

function resultTarget(node: t.Node | null | undefined): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && !node.computed) {
    const key = literalKey(node.property);
    if (key === "value" && t.isIdentifier(node.object)) return node.object.name;
    return key;
  }
  return null;
}

function resultName(base: string | null): string | null {
  if (!base || isMangled(base) || !isReadable(base) || GENERIC_RESULT.test(base) || /^[A-Z_]+$/.test(base)) return null;
  const boolean = /^(is|has|should|can)([A-Z]\w*)$/.exec(base);
  if (boolean) return `check${boolean[2]}`;
  return `get${base[0]!.toUpperCase()}${base.slice(1)}`;
}

function argumentVotes(program: t.Program, callee: (name: string) => string | null, into: Map<string, Set<string>>): void {
  t.traverseFast(program, (node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee) || node.arguments.length !== 1) return;
    const key = callee(node.callee.name);
    if (!key) return;
    const arg = node.arguments[0];
    const subject = t.isIdentifier(arg) ? arg.name : t.isMemberExpression(arg) && !arg.computed ? literalKey(arg.property) : null;
    into.set(key, (into.get(key) ?? new Set()).add(subject && !isMangled(subject) && isReadable(subject) && !GENERIC_RESULT.test(subject) ? subject : ""));
  });
}

function resultVotes(program: t.Program, callee: (name: string) => string | null, into: Map<string, Set<string>>): void {
  const vote = (call: t.Node | null | undefined, target: string | null) => {
    const inner = t.isAwaitExpression(call) ? call.argument : call;
    if (!t.isCallExpression(inner) || !t.isIdentifier(inner.callee)) return;
    const key = callee(inner.callee.name);
    if (!key) return;
    const name = resultName(target);
    into.set(key, (into.get(key) ?? new Set()).add(name ?? ""));
  };
  t.traverseFast(program, (node) => {
    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) vote(node.init, node.id.name);
    if (t.isAssignmentExpression(node, { operator: "=" })) vote(node.right, resultTarget(node.left));
  });
}

function resultNames(sources: Map<string, Source>, blocked: Set<string>): Map<string, Map<string, string>> {
  const votes = new Map<string, Map<string, Set<string>>>();
  const subjects = new Map<string, Map<string, Set<string>>>();
  for (const [path, source] of sources) {
    const imported = new Map<string, string>();
    for (const stmt of source.ast.program.body) {
      if (!t.isImportDeclaration(stmt)) continue;
      const target = resolve(path, stmt.source.value);
      if (!target || blocked.has(target) || !sources.has(target) || /(^|\/)(node_modules|vendor)\//.test(target)) continue;
      for (const spec of stmt.specifiers) if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && isPlaceholder(spec.imported.name)) imported.set(spec.local.name, `${target}\u0000${spec.imported.name}`);
    }
    if (!imported.size) continue;
    const local = new Map<string, Set<string>>();
    resultVotes(source.ast.program, (name) => imported.get(name) ?? null, local);
    for (const [key, names] of local) {
      const [target, exported] = key.split("\u0000") as [string, string];
      const byExport = votes.get(target) ?? new Map<string, Set<string>>();
      byExport.set(exported, new Set([...(byExport.get(exported) ?? []), ...names]));
      votes.set(target, byExport);
    }
    const args = new Map<string, Set<string>>();
    argumentVotes(source.ast.program, (name) => imported.get(name) ?? null, args);
    for (const program of templatePrograms(source)) argumentVotes(program, (name) => imported.get(name) ?? null, args);
    for (const [key, names] of args) {
      const [target, exported] = key.split("\u0000") as [string, string];
      const bySubject = subjects.get(target) ?? new Map<string, Set<string>>();
      bySubject.set(exported, new Set([...(bySubject.get(exported) ?? []), ...names]));
      subjects.set(target, bySubject);
    }
  }
  for (const [target, bySubject] of subjects) {
    const source = sources.get(target);
    if (!source) continue;
    const program = programPath(source.ast);
    const byExport = votes.get(target) ?? new Map<string, Set<string>>();
    for (const [exported, names] of bySubject) {
      const existing = byExport.get(exported);
      if (existing && existing.size === 1 && [...existing][0]) continue;
      if (names.size !== 1 || ![...names][0]) continue;
      let local: string | null = null;
      for (const stmt of source.ast.program.body) {
        if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
        for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported, { name: exported })) local = spec.local.name;
        if (stmt.declaration && Object.keys(t.getBindingIdentifiers(stmt.declaration)).includes(exported)) local = exported;
      }
      const bound = local ? program.scope.getBinding(local)?.path.node : null;
      const fn = t.isFunctionDeclaration(bound) ? bound : t.isVariableDeclarator(bound) && (t.isArrowFunctionExpression(bound.init) || t.isFunctionExpression(bound.init)) ? bound.init : null;
      const name = fn ? subjectFunctionName(fn, [...names][0]!) : null;
      if (name) byExport.set(exported, new Set([name]));
    }
    if (byExport.size) votes.set(target, byExport);
  }
  const out = new Map<string, Map<string, string>>();
  for (const [target, byExport] of votes) {
    const source = sources.get(target)!;
    const body = source.ast.program.body;
    const program = programPath(source.ast);
    const exported = exportedNames(body);
    const table = new Map<string, string>();
    for (const [name, all] of byExport) {
      const names = new Set([...all].filter(Boolean));
      if (names.size !== 1 || !exported.has(name)) continue;
      const next = [...names][0]!;
      if (!next || exported.has(next) || program.scope.hasBinding(next)) continue;
      let local: string | null = null;
      for (const stmt of body) {
        if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
        for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported, { name })) local = spec.local.name;
        if (stmt.declaration && Object.keys(t.getBindingIdentifiers(stmt.declaration)).includes(name)) local = name;
      }
      const bound = local ? program.scope.getBinding(local)?.path.node : null;
      const fn = t.isFunctionDeclaration(bound) || (t.isVariableDeclarator(bound) && (t.isArrowFunctionExpression(bound.init) || t.isFunctionExpression(bound.init)));
      if (!fn || !isPlaceholder(local!)) continue;
      if (renameExport(body, exported, name, next)) {
        program.scope.rename(local!, next);
        table.set(name, next);
      }
    }
    if (table.size) out.set(target, table);
  }
  return out;
}

function exportedNames(body: t.Statement[]): Set<string> {
  const exported = new Set<string>();
  for (const stmt of body) {
    if (t.isExportDefaultDeclaration(stmt)) exported.add("default");
    if (!t.isExportNamedDeclaration(stmt)) continue;
    for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec)) exported.add(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value);
    if (stmt.declaration) for (const name of Object.keys(t.getBindingIdentifiers(stmt.declaration))) exported.add(name);
  }
  return exported;
}

function renameExport(body: t.Statement[], exported: Set<string>, name: string, next: string): boolean {
  if (exported.has(next)) return false;
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i]!;
    if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
    const spec = stmt.specifiers.find((x): x is t.ExportSpecifier => t.isExportSpecifier(x) && t.isIdentifier(x.exported, { name }));
    if (spec) {
      if (!isMangled(spec.local.name)) return false;
      spec.exported = t.identifier(next);
    } else if ((t.isVariableDeclaration(stmt.declaration) && stmt.declaration.declarations.length === 1 && t.isIdentifier(stmt.declaration.declarations[0]!.id, { name })) || (t.isFunctionDeclaration(stmt.declaration) && stmt.declaration.id?.name === name)) {
      body.splice(i, 1, stmt.declaration!, t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(name), t.identifier(next))]));
    } else continue;
    exported.delete(name);
    exported.add(next);
    return true;
  }
  return false;
}

function returnedValues(fn: t.Function): t.Node[] {
  if (!t.isBlockStatement(fn.body)) return [fn.body];
  const out: t.Node[] = [];
  t.traverseFast(fn.body, (n) => {
    if (t.isReturnStatement(n) && n.argument) out.push(n.argument);
  });
  return out;
}

function pathSegment(node: t.Node): string | null {
  const text = t.isStringLiteral(node) ? node.value : t.isTemplateLiteral(node) ? node.quasis.map((q) => q.value.cooked ?? "").join("\u0000") : null;
  if (!text?.startsWith("/") && !(text?.startsWith("\u0000") && /^\u0000[a-z][a-z-]{2,}\//.test(text))) return null;
  const segment = text.split(/[/\u0000]/).find((part) => /^[a-z][a-z-]{2,}$/.test(part));
  return segment ?? null;
}

function localePrefix(fn: t.Function): boolean {
  const param = fn.params.length === 1 && t.isIdentifier(fn.params[0]) ? fn.params[0].name : null;
  const [value] = returnedValues(fn);
  if (!param || !t.isConditionalExpression(value) || !t.isBinaryExpression(value.test) || !/^===?$/.test(value.test.operator)) return false;
  const sides = [value.test.left, value.test.right];
  if (!sides.some((side) => t.isIdentifier(side, { name: param })) || !sides.some((side) => t.isStringLiteral(side) && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(side.value))) return false;
  const plain = (node: t.Node) => t.isStringLiteral(node, { value: "/" }) || t.isStringLiteral(node, { value: "" });
  const prefixed = (node: t.Node) => t.isTemplateLiteral(node) && node.expressions.length === 1 && t.isIdentifier(node.expressions[0], { name: param }) && /^\/?$/.test(node.quasis[0]?.value.cooked ?? "");
  return (plain(value.consequent) && prefixed(value.alternate)) || (prefixed(value.consequent) && plain(value.alternate));
}

function bodyName(fn: t.Function): string | null {
  if (localePrefix(fn)) return "localePath";
  const values = returnedValues(fn);
  if (!values.length) return null;
  const code = t.isBlockStatement(fn.body) ? fn.body : fn.body;
  let calls = "";
  t.traverseFast(code, (n) => {
    if (t.isMemberExpression(n) && !n.computed) calls += `.${literalKey(n.property)}`;
    if (t.isNewExpression(n) && t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.object, { name: "Intl" })) calls += `|Intl.${literalKey(n.callee.property)}`;
  });
  if (/\|Intl\.NumberFormat/.test(calls) && calls.includes(".format")) return "formatNumber";
  if (/\|Intl\.DateTimeFormat/.test(calls) && calls.includes(".format")) return "formatDate";
  if (/\|Intl\.RelativeTimeFormat/.test(calls)) return "formatRelativeTime";
  const segments = values.map(pathSegment);
  if (segments.every((s) => s !== null) && new Set(segments).size === 1) return `${segments[0]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}Path`;
  const only = values.length === 1 ? values[0]! : null;
  const printed = only ? t.isBinaryExpression(only) || t.isCallExpression(only) || t.isConditionalExpression(only) ? JSON.stringify(only, (k, v) => (k === "start" || k === "end" || k === "loc" ? undefined : v)) : "" : "";
  if (/"charAt"[\s\S]*"toUpperCase"[\s\S]*"slice"/.test(printed) && !/"split"/.test(printed)) return "capitalize";
  if (only && t.isCallExpression(only) && t.isMemberExpression(only.callee) && literalKey(only.callee.property) === "trim" && t.isCallExpression(only.callee.object) && t.isIdentifier(only.callee.object.callee, { name: "String" })) return "normalizeString";
  if (only && t.isCallExpression(only) && t.isMemberExpression(only.callee) && literalKey(only.callee.property) === "toLowerCase" && /"trim"/.test(printed) && /"String"/.test(printed)) return "normalizeKey";
  return null;
}

const LIFECYCLE: Record<string, string> = { bm: "onBeforeMount", m: "onMounted", bu: "onBeforeUpdate", u: "onUpdated", bum: "onBeforeUnmount", um: "onUnmounted", a: "onActivated", da: "onDeactivated", ec: "onErrorCaptured", rtc: "onRenderTracked", rtg: "onRenderTriggered", sp: "onServerPrefetch" };

function requestPaths(node: t.Node): string[] {
  const out: string[] = [];
  t.traverseFast(node, (n) => {
    if (!t.isCallExpression(n)) return;
    const first = n.arguments[0];
    const text = t.isStringLiteral(first) ? first.value : t.isTemplateLiteral(first) ? (first.quasis[0]?.value.cooked ?? "") : null;
    if (text && text.startsWith("/")) out.push(text);
  });
  return out;
}

function resourceName(node: t.Node | null | undefined): string | null {
  if (!t.isObjectExpression(node)) return null;
  const members = node.properties.filter((p) => (t.isObjectProperty(p) && (t.isArrowFunctionExpression(p.value) || t.isFunctionExpression(p.value))) || t.isObjectMethod(p));
  if (members.length < 2 || members.length < node.properties.length * 0.6) return null;
  const paths = members.flatMap((p) => requestPaths(t.isObjectMethod(p) ? p.body : (p as t.ObjectProperty).value));
  if (paths.length < 2) return null;
  const split = paths.map((path) => path.split(/[?#]/)[0]!.split("/").filter(Boolean));
  const common: string[] = [];
  for (let i = 0; split.every((parts) => parts.length > i && parts[i] === split[0]![i]); i++) {
    const part = split[0]![i]!;
    if (!/^[a-z][a-z-]*$/.test(part)) break;
    if (!/^(api|v\d+)$/.test(part)) common.push(part);
  }
  if (!common.length) {
    const counts = new Map<string, number>();
    for (const parts of split) {
      const head = parts.find((part) => !/^(api|v\d+)$/.test(part));
      if (head && /^[a-z][a-z-]*$/.test(head)) counts.set(head, (counts.get(head) ?? 0) + 1);
    }
    const [top] = [...counts].sort((a, b) => b[1] - a[1]);
    if (!top || top[1] < split.length * 0.6) return null;
    common.push(top[0]);
  }
  const words = common.join("-").split("-");
  return `${words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1) : w)).join("")}Api`;
}

function shapeName(node: t.Node | null | undefined): string | null {
  const resource = resourceName(node);
  if (resource) return resource;
  if (t.isClassDeclaration(node) || t.isClassExpression(node)) {
    let declared: string | null = null;
    t.traverseFast(node.body, (n) => {
      if (!declared && t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && t.isThisExpression(n.left.object) && t.isIdentifier(n.left.property, { name: "name" }) && t.isStringLiteral(n.right) && /^[A-Z][A-Za-z0-9]*Error$/.test(n.right.value)) declared = n.right.value;
    });
    if (declared) return declared;
  }
  if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: "createHook" }) && t.isStringLiteral(node.arguments[0])) return LIFECYCLE[node.arguments[0].value] ?? null;
  if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: "defineStore" }) && t.isStringLiteral(node.arguments[0]) && /^[A-Za-z][\w-]*$/.test(node.arguments[0].value)) return `use${node.arguments[0].value.replace(/(^|[-_])([a-z])/g, (_, __: string, c: string) => c.toUpperCase())}Store`;
  if (t.isFunction(node) && t.isBlockStatement(node.body)) {
    const hook = semanticFunctionName(node);
    if (hook && /^use[A-Z]/.test(hook)) return hook;
  }
  const fn = t.isFunctionDeclaration(node) || t.isArrowFunctionExpression(node) || t.isFunctionExpression(node) ? node : null;
  if (!fn) return null;
  if (t.isBlockStatement(fn.body)) {
    const [first, last] = [fn.body.body[0], fn.body.body.at(-1)];
    const declarator = t.isVariableDeclaration(first) && first.declarations.length === 1 ? first.declarations[0]! : null;
    const store = declarator && t.isIdentifier(declarator.id) && t.isCallExpression(declarator.init) && t.isIdentifier(declarator.init.callee) ? /^use([A-Z]\w*)Store$/.exec(declarator.init.callee.name)?.[1] : undefined;
    const local = store && t.isIdentifier(declarator?.id) ? declarator.id.name : null;
    if (local && t.isReturnStatement(last) && t.isObjectExpression(last.argument) && last.argument.properties.some((p) => t.isSpreadElement(p) && t.isIdentifier(p.argument, { name: local }))) return `use${store}`;
  }
  const body = t.isBlockStatement(fn.body) ? (fn.body.body.length === 1 && t.isReturnStatement(fn.body.body[0]) ? fn.body.body[0].argument : null) : fn.body;
  if (!t.isCallExpression(body) || !t.isIdentifier(body.callee)) return null;
  const params = fn.params.map((p) => (t.isIdentifier(p) ? p.name : t.isAssignmentPattern(p) && t.isIdentifier(p.left) ? p.left.name : null));
  if (params.includes(null) || !params.every((p, i) => t.isIdentifier(body.arguments[i], { name: p! }))) return null;
  const inner = /^(?:do|_+)([A-Z]?[a-z]\w*)$|^(\w+?)Impl$/.exec(body.callee.name);
  const base = inner?.[1] ?? inner?.[2];
  return base ? base[0]!.toLowerCase() + base.slice(1) : null;
}

function shapeNames(sources: Map<string, Source>, blocked: Set<string>): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [path, source] of sources) {
    if (blocked.has(path) || path.endsWith(".vue")) continue;
    const body = source.ast.program.body;
    const program = programPath(source.ast);
    const exported = exportedNames(body);
    const table = new Map<string, string>();
    const candidates: Array<[string, string]> = [];
    for (const stmt of body) {
      if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
      for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported) && ((mangledIn(path, spec.exported.name) && mangledIn(path, spec.local.name)) || (spec.exported.name === spec.local.name && threeLetter(path, spec.local.name)))) candidates.push([spec.exported.name, spec.local.name]);
      if ((t.isFunctionDeclaration(stmt.declaration) || t.isClassDeclaration(stmt.declaration)) && stmt.declaration.id && (mangledIn(path, stmt.declaration.id.name) || threeLetter(path, stmt.declaration.id.name))) candidates.push([stmt.declaration.id.name, stmt.declaration.id.name]);
      if (t.isVariableDeclaration(stmt.declaration)) for (const d of stmt.declaration.declarations) if (t.isIdentifier(d.id) && (mangledIn(path, d.id.name) || (threeLetter(path, d.id.name) && t.isFunction(d.init)))) candidates.push([d.id.name, d.id.name]);
    }
    for (const [name, local] of candidates) {
      const node = program.scope.getBinding(local)?.path.node;
      const target = t.isVariableDeclarator(node) ? node.init : node;
      if (!mangledIn(path, local)) {
        const semantic = t.isFunction(target) ? semanticFunctionName(target, stringBinding(program)) : null;
        const binding = program.scope.getBinding(local);
        if (!semantic || !binding || !isReadable(semantic) || program.scope.hasBinding(semantic) || exported.has(semantic) || name !== local) continue;
        if ([...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(semantic))) continue;
        program.scope.rename(local, semantic);
        for (const stmt of body) if (t.isExportNamedDeclaration(stmt) && !stmt.source) for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported, { name }) && spec.local.name === semantic) spec.exported = t.identifier(semantic);
        exported.delete(name);
        exported.add(semantic);
        table.set(name, semantic);
        continue;
      }
      let next = shapeName(target);
      if (!next && !/(^|\/)(node_modules|vendor)\//.test(path) && (t.isFunctionDeclaration(target) || t.isArrowFunctionExpression(target) || t.isFunctionExpression(target))) {
        const base = bodyName(target) ?? semanticFunctionName(target, stringBinding(program));
        next = base;
        for (let n = 2; base && (exported.has(next!) || program.scope.hasBinding(next!)); n++) next = `${base}${n}`;
      }
      if (next && isReadable(next) && renameExport(body, exported, name, next)) table.set(name, next);
    }
    if (table.size) out.set(path, table);
  }
  return out;
}

function consensusNames(sources: Map<string, Source>, blocked: Set<string>): Map<string, Map<string, string>> {
  const votes = new Map<string, Map<string, Map<string, number>>>();
  for (const [path, source] of sources) {
    for (const stmt of source.ast.program.body) {
      if (!t.isImportDeclaration(stmt)) continue;
      const target = resolve(path, stmt.source.value);
      if (!target || blocked.has(target) || !sources.has(target) || target.endsWith(".vue")) continue;
      for (const spec of stmt.specifiers) {
        if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported) || !isMangled(spec.imported.name) || !isReadable(spec.local.name)) continue;
        const byExport = votes.get(target) ?? new Map<string, Map<string, number>>();
        const names = byExport.get(spec.imported.name) ?? new Map<string, number>();
        const name = spec.local.name.replace(/\d+$/, "");
        names.set(name, (names.get(name) ?? 0) + 1);
        byExport.set(spec.imported.name, names);
        votes.set(target, byExport);
      }
    }
  }
  const out = new Map<string, Map<string, string>>();
  for (const [target, byExport] of votes) {
    const source = sources.get(target)!;
    const body = source.ast.program.body;
    const exported = exportedNames(body);
    const table = new Map<string, string>();
    for (const [name, names] of byExport) {
      const total = [...names.values()].reduce((a, b) => a + b, 0);
      const [best, count] = [...names].sort((a, b) => b[1] - a[1])[0]!;
      if (total < 2 || count * 3 < total * 2 || !isReadable(best)) continue;
      if (renameExport(body, exported, name, best)) table.set(name, best);
    }
    if (table.size) out.set(target, table);
  }
  return out;
}

function ivyClassName(node: t.Node | null | undefined): string | null {
  let cls: t.Class | null = t.isClassExpression(node) ? node : null;
  if (!cls && t.isCallExpression(node) && (t.isArrowFunctionExpression(node.callee) || t.isFunctionExpression(node.callee)) && t.isBlockStatement(node.callee.body)) {
    cls = node.callee.body.body.find((s): s is t.ClassDeclaration => t.isClassDeclaration(s)) ?? null;
  }
  if (!cls) return null;
  for (const member of cls.body.body) {
    if (!t.isClassProperty(member) || !member.static || !t.isIdentifier(member.key) || !/^ɵ(cmp|dir)$/.test(member.key.name) || !t.isCallExpression(member.value)) continue;
    const options = member.value.arguments[0];
    const selectors = t.isObjectExpression(options) ? options.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: "selectors" }))?.value : null;
    const first = t.isArrayExpression(selectors) && t.isArrayExpression(selectors.elements[0]) ? selectors.elements[0].elements : [];
    const selector = t.isStringLiteral(first[0]) && first[0].value ? first[0].value : t.isStringLiteral(first[1]) ? first[1].value : null;
    if (!selector || /^ng-component$/.test(selector)) return null;
    const words = selector.split(/[-_]/).filter(Boolean);
    return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  }
  return null;
}

function componentName(node: t.Node | null | undefined, depth = 0, lookup?: (name: string) => t.Node | null | undefined): string | null {
  if (depth > 2) return null;
  if (t.isCallExpression(node)) {
    for (const arg of node.arguments) {
      const found = componentName(arg, depth + 1, lookup);
      if (found) return found;
    }
    return null;
  }
  if (!t.isObjectExpression(node)) return null;
  for (const prop of node.properties) {
    if (!t.isObjectProperty(prop) || prop.computed || !t.isIdentifier(prop.key) || !/^(__name|name)$/.test(prop.key.name) || !t.isStringLiteral(prop.value)) continue;
    if (/^[A-Z][A-Za-z0-9]+$/.test(prop.value.value)) return prop.value.value;
  }
  for (const prop of node.properties) {
    if (!t.isSpreadElement(prop) || !t.isIdentifier(prop.argument) || !lookup) continue;
    const found = componentName(lookup(prop.argument.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function stateName(init: t.Node | null | undefined): string | null {
  return t.isCallExpression(init) && t.isIdentifier(init.callee, { name: "reactive" }) && t.isObjectExpression(init.arguments[0]) ? "state" : null;
}

function nameComponents(path: string, source: Source): Map<string, string> {
  const program = programPath(source.ast);
  const declared = new Map<string, string>();
  const rename = (local: string, declaration: boolean) => {
    const binding = program.scope.getBinding(local);
    const node = binding?.path.node;
    const wrapped = t.isVariableDeclarator(node) && t.isCallExpression(node.init) && t.isIdentifier(node.init.arguments[0]) ? program.scope.getBinding(node.init.arguments[0].name)?.path.node : null;
    const lookup = (name: string) => {
      const bound = program.scope.getBinding(name)?.path.node;
      return t.isVariableDeclarator(bound) ? bound.init : null;
    };
    const name = t.isVariableDeclarator(node) ? (componentName(node.init, 0, lookup) ?? ivyClassName(node.init) ?? stateName(node.init) ?? (t.isVariableDeclarator(wrapped) && t.isCallExpression(node.init) && node.init.arguments.length === 2 && t.isArrayExpression(node.init.arguments[1]) ? componentName(wrapped.init) : null)) : null;
    if (!binding || !name || program.scope.hasBinding(name)) return;
    if ([...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(name))) return;
    program.scope.rename(local, name);
    if (declaration) declared.set(local, name);
  };
  for (const stmt of source.ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
    const short = (name: string) => mangledIn(path, name) || (/(^|\/)(node_modules|vendor)\//.test(path) && name.length <= 3);
    if (t.isVariableDeclaration(stmt.declaration)) for (const d of stmt.declaration.declarations) if (t.isIdentifier(d.id) && short(d.id.name)) rename(d.id.name, true);
    for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec) && short(spec.local.name)) rename(spec.local.name, false);
  }
  return declared;
}

const ROUTE_WRAPPERS = /^(UNSAFE_)?(withComponentProps|withHydrateFallbackProps|withErrorBoundaryProps)$/;

function unwrapRouteComponents(source: Source, program: NodePath<t.Program>): boolean {
  let changed = false;
  const body = source.ast.program.body;
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i]!;
    if (!t.isVariableDeclaration(stmt) || stmt.declarations.length !== 1) continue;
    const d = stmt.declarations[0]!;
    if (!t.isIdentifier(d.id) || !t.isCallExpression(d.init) || !t.isIdentifier(d.init.callee) || d.init.arguments.length !== 1) continue;
    const callee = d.init.callee.name;
    const binding = program.scope.getBinding(callee);
    const spec = binding?.path.node;
    const imported = t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) ? spec.imported.name : null;
    if (!imported || !ROUTE_WRAPPERS.test(imported)) continue;
    const fn = d.init.arguments[0];
    if (!t.isFunctionExpression(fn) && !t.isArrowFunctionExpression(fn)) continue;
    const block = t.isBlockStatement(fn.body) ? fn.body : t.blockStatement([t.returnStatement(fn.body)]);
    body[i] = t.functionDeclaration(t.identifier(d.id.name), fn.params, block, fn.generator, fn.async);
    changed = true;
  }
  if (!changed) return false;
  program.scope.crawl();
  const emptied = new Set<t.Statement>();
  for (const stmt of body) {
    if (!t.isImportDeclaration(stmt) || !stmt.specifiers.length) continue;
    stmt.specifiers = stmt.specifiers.filter((spec) => !(t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && ROUTE_WRAPPERS.test(spec.imported.name) && !program.scope.getBinding(spec.local.name)?.referenced));
    if (!stmt.specifiers.length) emptied.add(stmt);
  }
  source.ast.program.body = body.filter((stmt) => !emptied.has(stmt));
  return true;
}

function destructuredNames(source: Source, program: NodePath<t.Program>): boolean {
  let changed = false;
  traverse(source.ast, {
    ObjectProperty(path) {
      if (!path.parentPath.isObjectPattern() || path.node.computed) return;
      const key = literalKey(path.node.key);
      const value = path.node.value;
      if (!key || !t.isIdentifier(value) || key === value.name || !isMangled(value.name) || !/^[A-Za-z_$][\w$]*$/.test(key) || RESERVED.has(key)) return;
      const binding = path.scope.getBinding(value.name);
      if (!binding || binding.identifier !== value || binding.scope.hasBinding(key)) return;
      const shadows = [...binding.referencePaths, ...binding.constantViolations].map((ref) => ref.scope.getBinding(key)).filter((b): b is NonNullable<typeof b> => !!b && b.scope !== binding.scope);
      if (shadows.length && key.length <= 2) {
        for (const shadow of new Set(shadows)) {
          let next = `${key}2`;
          for (let n = 3; shadow.scope.hasBinding(next) || program.scope.hasBinding(next); n++) next = `${key}${n}`;
          shadow.scope.rename(key, next);
        }
      }
      if ([...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(key) && ref.scope.getBinding(key) !== binding)) return;
      const top = binding.scope.block === program.node;
      if (top && !templateSafe(source, value.name, key)) return;
      const from = value.name;
      const used = top && inTemplate(source, from);
      binding.scope.rename(from, key);
      path.node.shorthand = t.isIdentifier(path.node.value, { name: key });
      if (used) source.templateRenames.set(from, key);
      changed = true;
    },
  });
  return changed;
}

export type PackageExport = (packageName: string, name: string) => string | null;

function importFromPackages(path: string, source: Source, packageExport: PackageExport, componentPackage?: (name: string) => string | null): boolean {
  let changed = false;
  const body = source.ast.program.body;
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i]!;
    if (!t.isImportDeclaration(stmt)) continue;
    const bare = !stmt.source.value.startsWith(".");
    const target = bare ? null : resolve(path, stmt.source.value);
    const pkg = bare ? /^(?:@[^/]+\/)?[^/]+/.exec(stmt.source.value)?.[0] : target ? /(?:^|\/)(?:node_modules|vendor)\/((?:@[^/]+\/)?[^/]+)\//.exec(target)?.[1] : undefined;
    if (!pkg) continue;
    const moved = new Map<string, t.ImportSpecifier[]>();
    stmt.specifiers = stmt.specifiers.filter((spec) => {
      if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported)) return true;
      const specifier = (bare ? null : packageExport(pkg, spec.imported.name)) ?? (bare && packageExport(pkg, spec.imported.name) ? null : (componentPackage?.(spec.imported.name) ?? null));
      if (!specifier || specifier === stmt.source.value) return true;
      moved.set(specifier, [...(moved.get(specifier) ?? []), spec]);
      return false;
    });
    if (!moved.size) continue;
    const added = [...moved].map(([specifier, specs]) => t.importDeclaration(specs, t.stringLiteral(specifier)));
    body.splice(i, stmt.specifiers.length ? 0 : 1, ...added);
    i += added.length - (stmt.specifiers.length ? 0 : 1);
    changed = true;
  }
  return changed;
}

export function publishReadableExports(tree: OutputTree, packageExport?: PackageExport, hints: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(), componentPackage?: (name: string) => string | null): number {
  const sources = new Map<string, Source>();
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || !CODE.test(file.path)) continue;
    try {
      const source = load(file);
      if (source) sources.set(file.path, source);
    } catch {
      continue;
    }
  }
  const blocked = new Set<string>();
  for (const file of tree.all()) {
    if (sources.has(file.path) || !CODE.test(file.path)) continue;
    for (const match of file.content.matchAll(/["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(file.path, match[1]!);
      if (target) blocked.add(target);
    }
  }
  for (const [path, source] of sources) {
    traverse(source.ast, {
      ImportDeclaration(p) {
        if (p.node.specifiers.some((s) => t.isImportNamespaceSpecifier(s))) blocked.add(resolve(path, p.node.source.value) ?? "");
      },
      ExportAllDeclaration(p) {
        blocked.add(resolve(path, p.node.source.value) ?? "");
      },
      CallExpression(p) {
        const arg = p.node.arguments[0];
        if ((t.isImport(p.node.callee) || t.isIdentifier(p.node.callee, { name: "require" })) && t.isStringLiteral(arg)) blocked.add(resolve(path, arg.value) ?? "");
      },
    });
  }

  const renames = new Map<string, Map<string, string>>();
  for (const [path, table] of usageNames(sources, blocked)) renames.set(path, table);
  for (const [path, table] of shapeNames(sources, blocked)) renames.set(path, new Map([...(renames.get(path) ?? []), ...table]));
  for (const [path, table] of consensusNames(sources, blocked)) renames.set(path, new Map([...(renames.get(path) ?? []), ...table]));
  for (const [path, table] of resultNames(sources, blocked)) renames.set(path, new Map([...(renames.get(path) ?? []), ...table]));
  for (const [path, table] of hints) {
    const source = sources.get(path);
    if (!source || blocked.has(path)) continue;
    const body = source.ast.program.body;
    const exported = exportedNames(body);
    const current = renames.get(path) ?? new Map<string, string>();
    for (const [from, to] of table) if (!current.has(from) && renameExport(body, exported, from, to)) current.set(from, to);
    if (current.size) renames.set(path, current);
  }
  for (const [path, source] of sources) {
    if (blocked.has(path) || path.endsWith(".vue")) continue;
    const declared = nameComponents(path, source);
    if (declared.size) renames.set(path, new Map([...(renames.get(path) ?? []), ...declared]));
  }
  for (const [path, source] of sources) {
    if (blocked.has(path) || path.endsWith(".vue")) continue;
    const body = source.ast.program.body;
    const exported = new Map<string, string | null>();
    for (const stmt of body) {
      if (t.isExportDefaultDeclaration(stmt)) exported.set("default", null);
      if (!t.isExportNamedDeclaration(stmt)) continue;
      for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec)) exported.set(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value, stmt.source ? null : spec.local.name);
      if (stmt.declaration) for (const name of Object.keys(t.getBindingIdentifiers(stmt.declaration))) exported.set(name, name);
    }
    const own = renames.get(path) ?? new Map<string, string>();
    for (const stmt of body) {
      if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
      stmt.specifiers = stmt.specifiers.filter((spec) => {
        if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported)) return true;
        const from = spec.exported.name;
        const to = spec.local.name;
        if (!(mangledIn(path, from) || (from.length <= 3 && /^[A-Z][a-z]+[A-Z]\w{2,}$/.test(to))) || !isReadable(to)) return true;
        if (exported.has(to)) {
          if (exported.get(to) !== to) return true;
          own.set(from, to);
          return false;
        }
        exported.set(to, to);
        own.set(from, to);
        spec.exported = t.identifier(to);
        return true;
      });
    }
    source.ast.program.body = body.filter((stmt) => !t.isExportNamedDeclaration(stmt) || stmt.declaration || stmt.specifiers.length > 0);
    if (/(^|\/)(node_modules|vendor)\//.test(path)) {
      const names = exportedNames(source.ast.program.body);
      for (const stmt of source.ast.program.body) {
        if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
        for (const spec of stmt.specifiers) {
          if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported)) continue;
          const alias = spec.exported.name;
          const local = spec.local.name;
          if (alias !== local && names.has(local) && (mangledIn(path, local) || local.length <= 3) && isReadable(alias) && !own.has(local)) own.set(local, alias);
        }
      }
    }
    if (own.size) renames.set(path, own);
  }
  if (!renames.size && !packageExport) return 0;

  let count = 0;
  for (const [path, source] of sources) {
    let changed = renames.has(path);
    const program = programPath(source.ast);
    const locals = new Map<string, string>();
    for (const stmt of source.ast.program.body) {
      const isImport = t.isImportDeclaration(stmt);
      if (!isImport && !(t.isExportNamedDeclaration(stmt) && stmt.source)) continue;
      const spec = (stmt as t.ImportDeclaration).source.value;
      const target = resolve(path, spec) ?? (spec.startsWith(".") ? null : [`js/node_modules/${spec}/index.js`, `js/node_modules/${spec}.js`].find((candidate) => sources.has(candidate)) ?? null);
      const table = target ? renames.get(target) : undefined;
      if (!table) continue;
      for (const spec of (stmt as t.ImportDeclaration | t.ExportNamedDeclaration).specifiers) {
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && table.has(spec.imported.name)) {
          const before = spec.imported.name;
          const to = table.get(before)!;
          spec.imported = t.identifier(to);
          if (isMangled(spec.local.name) || spec.local.name === before) locals.set(spec.local.name, to);
          changed = true;
          count++;
        } else if (t.isExportSpecifier(spec) && table.has(spec.local.name)) {
          spec.local = t.identifier(table.get(spec.local.name)!);
          changed = true;
          count++;
        }
      }
    }
    for (const stmt of source.ast.program.body) {
      if (!t.isImportDeclaration(stmt)) continue;
      for (const spec of stmt.specifiers) {
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && isReadable(spec.imported.name) && (isMangled(spec.local.name) || (spec.local.name.length <= 3 && /^[A-Z][a-z]+[A-Z]\w{2,}$/.test(spec.imported.name))) && !locals.has(spec.local.name)) locals.set(spec.local.name, spec.imported.name);
        if (t.isImportDefaultSpecifier(spec) && isMangled(spec.local.name) && /\.vue$/.test(stmt.source.value)) {
          const name = /([A-Z][A-Za-z0-9]*)\.vue$/.exec(stmt.source.value)?.[1];
          if (name && !locals.has(spec.local.name)) locals.set(spec.local.name, name);
        }
      }
    }
    for (const [from, to] of locals) {
      const binding = program.scope.getBinding(from);
      if (!binding || program.scope.hasBinding(to) || !templateSafe(source, from, to)) continue;
      if ([...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(to))) continue;
      program.scope.rename(from, to);
      if (inTemplate(source, from)) source.templateRenames.set(from, to);
      changed = true;
    }
    for (const stmt of source.ast.program.body) {
      if (!t.isVariableDeclaration(stmt)) continue;
      for (const d of stmt.declarations) {
        if (!t.isIdentifier(d.id) || !isMangled(d.id.name) || !t.isCallExpression(d.init) || !t.isIdentifier(d.init.callee)) continue;
        const hook = /^use([A-Z][A-Za-z0-9]*)$/.exec(d.init.callee.name)?.[1];
        const name = hook ? hook[0]!.toLowerCase() + hook.slice(1) : null;
        if (!name || !isReadable(name) || program.scope.hasBinding(name) || !templateSafe(source, d.id.name, name)) continue;
        const binding = program.scope.getBinding(d.id.name);
        if (!binding || [...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(name))) continue;
        const from = d.id.name;
        program.scope.rename(from, name);
        if (inTemplate(source, from)) source.templateRenames.set(from, name);
        changed = true;
      }
    }
    if (!/(^|\/)(node_modules|vendor)\//.test(path)) {
      const topLevel = new Set(source.ast.program.body.flatMap((stmt) => (t.isFunctionDeclaration(stmt) && stmt.id ? [stmt.id.name] : t.isVariableDeclaration(stmt) ? stmt.declarations.flatMap((d) => (t.isIdentifier(d.id) && (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init)) ? [d.id.name] : [])) : [])).filter(isMangled));
      const resultVotesLocal = new Map<string, Set<string>>();
      resultVotes(source.ast.program, (name) => (topLevel.has(name) ? name : null), resultVotesLocal);
      const localResults = new Map([...resultVotesLocal].filter(([, names]) => names.size === 1 && [...names][0]).map(([name, names]) => [name, [...names][0]!] as const));
      for (const stmt of source.ast.program.body) {
        if (t.isExportNamedDeclaration(stmt)) continue;
        const decl = stmt;
        const fn = t.isFunctionDeclaration(decl) ? decl : t.isVariableDeclaration(decl) && decl.declarations.length === 1 && (t.isArrowFunctionExpression(decl.declarations[0]!.init) || t.isFunctionExpression(decl.declarations[0]!.init)) ? (decl.declarations[0]!.init as t.Function) : null;
        const id = t.isFunctionDeclaration(decl) ? decl.id : t.isVariableDeclaration(decl) ? decl.declarations[0]!.id : null;
        if (!fn || !t.isIdentifier(id) || !(isPlaceholder(id.name) || (threeLetter(path, id.name) && !exportedNames(source.ast.program.body).has(id.name)))) continue;
        const base = isMangled(id.name) ? (bodyName(fn) ?? localResults.get(id.name) ?? null) : isPlaceholder(id.name) ? bodyName(fn) : semanticFunctionName(fn, stringBinding(program));
        if (!base) continue;
        let name = base;
        for (let n = 2; program.scope.hasBinding(name); n++) name = `${base}${n}`;
        if (!templateSafe(source, id.name, name)) continue;
        const binding = program.scope.getBinding(id.name);
        if (!binding || [...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(name))) continue;
        const from = id.name;
        program.scope.rename(from, name);
        if (inTemplate(source, from)) source.templateRenames.set(from, name);
        changed = true;
      }
    }
    if (unwrapRouteComponents(source, program)) changed = true;
    if (packageExport && importFromPackages(path, source, packageExport, componentPackage)) changed = true;
    if (destructuredNames(source, program)) changed = true;
    if (changed) save(source);
  }
  return count;
}

export function adoptPackageAliases(tree: OutputTree, roles: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>, packageFile: (specifier: string) => string | null, packageExport: PackageExport): number {
  const importers: Source[] = [];
  const votes = new Map<string, Map<string, Set<string>>>();
  const specifiers = new Set<string>();
  for (const [specifier, table] of roles) {
    specifiers.add(specifier);
    const bySource = votes.get(specifier) ?? new Map<string, Set<string>>();
    for (const [from, names] of table) for (const name of names) if (packageExport(specifier, name)) bySource.set(from, (bySource.get(from) ?? new Set()).add(name));
    votes.set(specifier, bySource);
  }
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || !CODE.test(file.path) || /(^|\/)(node_modules|vendor)\//.test(file.path)) continue;
    let source: Source | null;
    try {
      source = load(file);
    } catch {
      continue;
    }
    if (!source) continue;
    let relevant = false;
    for (const stmt of source.ast.program.body) {
      if (!t.isImportDeclaration(stmt) || /^[./]/.test(stmt.source.value)) continue;
      for (const spec of stmt.specifiers) {
        if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported) || !isMangled(spec.imported.name)) continue;
        relevant = true;
        specifiers.add(stmt.source.value);
        if (!isReadable(spec.local.name) || !packageExport(stmt.source.value, spec.local.name)) continue;
        const bySource = votes.get(stmt.source.value) ?? new Map<string, Set<string>>();
        bySource.set(spec.imported.name, (bySource.get(spec.imported.name) ?? new Set()).add(spec.local.name));
        votes.set(stmt.source.value, bySource);
      }
    }
    if (relevant) importers.push(source);
  }
  const published = new Map<string, { exported: Set<string>; as: Map<string, string> }>();
  for (const specifier of specifiers) {
    const path = packageFile(specifier);
    const file = path ? tree.all().find((f) => f.path === path) : undefined;
    const vendor = file ? load(file) : null;
    if (!vendor) continue;
    const body = vendor.ast.program.body;
    const exported = exportedNames(body);
    let changed = false;
    const as = new Map<string, string>();
    for (const [from, names] of votes.get(specifier) ?? []) {
      if (names.size !== 1 || !exported.has(from)) continue;
      const to = [...names][0]!;
      if (renameExport(body, exported, from, to)) {
        changed = true;
        as.set(from, to);
      }
    }
    if (changed) save(vendor);
    for (const stmt of body) {
      if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
      for (const spec of stmt.specifiers) {
        if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported)) continue;
        if (isReadable(spec.exported.name) && !as.has(spec.local.name)) as.set(spec.local.name, spec.exported.name);
      }
    }
    published.set(specifier, { exported: exportedNames(body), as });
  }
  let count = 0;
  for (const source of importers) {
    let changed = false;
    const program = programPath(source.ast);
    const locals = new Map<string, string>();
    for (const stmt of source.ast.program.body) {
      if (!t.isImportDeclaration(stmt)) continue;
      const vendor = published.get(stmt.source.value);
      if (!vendor) continue;
      for (const spec of stmt.specifiers) {
        if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported) || vendor.exported.has(spec.imported.name)) continue;
        const to = vendor.as.get(spec.imported.name);
        if (!to || !vendor.exported.has(to)) continue;
        if (isMangled(spec.local.name)) locals.set(spec.local.name, to);
        spec.imported = t.identifier(to);
        changed = true;
        count++;
      }
      for (const spec of stmt.specifiers) if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && isReadable(spec.imported.name) && isMangled(spec.local.name) && !locals.has(spec.local.name)) locals.set(spec.local.name, spec.imported.name);
    }
    for (const [from, to] of locals) {
      const binding = program.scope.getBinding(from);
      if (!binding || program.scope.hasBinding(to) || !templateSafe(source, from, to)) continue;
      if ([...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(to))) continue;
      program.scope.rename(from, to);
      if (inTemplate(source, from)) source.templateRenames.set(from, to);
      changed = true;
    }
    if (changed) save(source);
  }
  return count;
}

function exportAliases(content: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const match of content.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of match[1]!.split(",")) {
      const [local, exported = local] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (local && exported) out.set(local, [...(out.get(local) ?? []), exported]);
    }
  }
  return out;
}

function declaredExports(content: string): Set<string> {
  const out = new Set<string>();
  for (const match of content.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.add(name);
    }
  }
  for (const match of content.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(match[1]!);
  if (/export\s+default\b/.test(content)) out.add("default");
  return out;
}

export function localizeUnknownPackageImports(tree: OutputTree, packageFile: (specifier: string) => string | null, packageExport: PackageExport): number {
  let count = 0;
  const exportCache = new Map<string, Set<string>>();
  const aliasCache = new Map<string, Map<string, string[]>>();
  const exportsOfTarget = (path: string) => {
    if (!exportCache.has(path)) exportCache.set(path, declaredExports(tree.all().find((f) => f.path === path)?.content ?? ""));
    return exportCache.get(path)!;
  };
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || !CODE.test(file.path)) continue;
    const vendor = file.library || /(^|\/)(node_modules|vendor)\//.test(file.path);
    const shape = file.path.endsWith(".vue") ? null : outline(file);
    if (shape && !shape.imports.some((entry) => !/^[./]/.test(entry.source))) continue;
    let source: Source | null;
    try {
      source = load(file);
    } catch {
      continue;
    }
    if (!source) continue;
    let changed = false;
    const body = source.ast.program.body;
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i]!;
      if (!t.isImportDeclaration(stmt) || /^[./]/.test(stmt.source.value) || stmt.importKind === "type") continue;
      if (!vendor && /^@vue\/(runtime-dom|runtime-core|reactivity|shared)$/.test(stmt.source.value)) {
        const facade = stmt.specifiers.filter((spec) => t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && packageExport("vue", spec.imported.name) === "vue");
        if (facade.length) {
          stmt.specifiers = stmt.specifiers.filter((spec) => !facade.includes(spec));
          const existing = body.find((other): other is t.ImportDeclaration => t.isImportDeclaration(other) && other.source.value === "vue" && other.importKind !== "type" && !other.specifiers.some((sp) => !t.isImportSpecifier(sp)));
          if (existing) existing.specifiers.push(...facade);
          else body.splice(i + 1, 0, t.importDeclaration(facade, t.stringLiteral("vue")));
          changed = true;
          if (!stmt.specifiers.length) {
            body.splice(i, 1);
            i--;
            continue;
          }
        }
      }
      const main = packageFile(stmt.source.value);
      if (!main) continue;
      const root = main.replace(/\/(index|chunk)(~\d+)?\.m?js$|\.m?js$/, "");
      const candidates = [main, ...tree.all().map((f) => f.path).filter((path) => path !== main && path.startsWith(`${root}/`) && /\.m?js$/.test(path))].filter((path) => path !== file.path);
      const unknown = stmt.specifiers.filter((spec) => t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && ((!vendor && !stmt.source.value.replace(/^@[^/]+\//, "").includes("/")) || isMangled(spec.imported.name) || /^(merged|module|constants|utils)\d*$|^[A-Za-z]{1,3}\d*$/.test(spec.imported.name) || /^@vue\//.test(stmt.source.value)) && !packageExport(stmt.source.value, spec.imported.name) && candidates.some((path) => exportsOfTarget(path).has((spec.imported as t.Identifier).name)));
      const readable = new Map<t.ImportSpecifier, { name: string; source: string }>();
      for (const spec of stmt.specifiers) {
        if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported) || unknown.includes(spec) || packageExport(stmt.source.value, spec.imported.name) || candidates.some((path) => exportsOfTarget(path).has((spec.imported as t.Identifier).name))) continue;
        const name = spec.imported.name;
        for (const path of candidates) {
          const alias = (aliasCache.get(path) ?? aliasCache.set(path, exportAliases(tree.all().find((f) => f.path === path)?.content ?? "")).get(path)!).get(name)?.find((exported) => packageExport(stmt.source.value, exported));
          if (alias) {
            readable.set(spec, { name: alias, source: packageExport(stmt.source.value, alias)! });
            break;
          }
        }
      }
      for (const [spec, { name, source: target }] of readable) {
        stmt.specifiers = stmt.specifiers.filter((other) => other !== spec);
        const next = t.importSpecifier(t.identifier(spec.local.name), t.identifier(name));
        const existing = body.find((other): other is t.ImportDeclaration => t.isImportDeclaration(other) && other.source.value === target && other.importKind !== "type" && !other.specifiers.some((sp) => !t.isImportSpecifier(sp)));
        if (existing) existing.specifiers.push(next);
        else body.splice(i + 1, 0, t.importDeclaration([next], t.stringLiteral(target)));
        count++;
        changed = true;
      }
      if (readable.size && !stmt.specifiers.length) {
        body.splice(i, 1);
        i--;
        continue;
      }
      if (!unknown.length) continue;
      stmt.specifiers = stmt.specifiers.filter((spec) => !unknown.includes(spec));
      const bySource = new Map<string, t.ImportSpecifier[]>();
      for (const spec of unknown as t.ImportSpecifier[]) {
        const target = candidates.find((path) => exportsOfTarget(path).has((spec.imported as t.Identifier).name))!;
        bySource.set(target, [...(bySource.get(target) ?? []), spec]);
      }
      const locals = [...bySource].map(([target, specs]) => {
        const relative = posix.relative(posix.dirname(file.path), target);
        return t.importDeclaration(specs, t.stringLiteral(relative.startsWith(".") ? relative : `./${relative}`));
      });
      if (stmt.specifiers.length) body.splice(i + 1, 0, ...locals);
      else body.splice(i, 1, ...locals);
      i += locals.length - (stmt.specifiers.length ? 0 : 1);
      count += unknown.length;
      changed = true;
    }
    if (changed) save(source);
  }
  return count;
}

export function collapseReexportShims(tree: OutputTree): number {
  const files = tree.all().filter((f) => (f.kind === "module" || f.kind === "script") && CODE.test(f.path) && !f.library && !/(^|\/)(node_modules|vendor)\//.test(f.path));
  const shims = new Map<string, Map<string, { source: string; name: string }>>();
  for (const file of files) {
    if (file.path.endsWith(".vue")) continue;
    let source: Source | null;
    try {
      source = load(file);
    } catch {
      continue;
    }
    if (!source) continue;
    const body = source.ast.program.body;
    const facades = new Map<string, string>();
    for (const st of body) {
      const decl = t.isExportNamedDeclaration(st) ? st.declaration : st;
      if (!t.isVariableDeclaration(decl) || decl.declarations.length !== 1) continue;
      const d = decl.declarations[0]!;
      const target = namespaceFacade(d.init);
      if (t.isIdentifier(d.id) && target) facades.set(d.id.name, target);
    }
    const isFacade = (st: t.Statement) => {
      const decl = t.isExportNamedDeclaration(st) ? st.declaration : st;
      return t.isVariableDeclaration(decl) && decl.declarations.length === 1 && t.isIdentifier(decl.declarations[0]!.id) && facades.has(decl.declarations[0]!.id.name);
    };
    if (!body.length || !body.every((st) => t.isImportDeclaration(st) || isFacade(st) || (t.isExportNamedDeclaration(st) && !st.declaration) || (t.isExportDefaultDeclaration(st) && t.isIdentifier(st.declaration)))) continue;
    const imported = new Map<string, { source: string; name: string }>();
    let plain = true;
    const defaults = new Map<string, { source: string; name: string }>();
    for (const st of body) {
      if (!t.isImportDeclaration(st)) continue;
      for (const spec of st.specifiers) {
        if (t.isImportDefaultSpecifier(spec)) defaults.set(spec.local.name, { source: st.source.value, name: "default" });
        else if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported)) plain = false;
        else imported.set(spec.local.name, { source: st.source.value, name: spec.imported.name });
      }
    }
    const table = new Map<string, { source: string; name: string }>();
    for (const [name, local] of facades) {
      const origin = imported.get(local) ?? defaults.get(local);
      if (origin) table.set(name, { ...origin, name: "*" });
      else plain = false;
    }
    for (const st of body) {
      if (!t.isExportDefaultDeclaration(st) || !t.isIdentifier(st.declaration)) continue;
      const origin = imported.get(st.declaration.name) ?? defaults.get(st.declaration.name);
      if (origin) table.set("default", { ...origin, name: `default:${origin.name}` });
      else plain = false;
    }
    for (const st of body) {
      if (!t.isExportNamedDeclaration(st)) continue;
      for (const spec of st.specifiers) {
        if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported)) {
          plain = false;
          continue;
        }
        const origin = st.source ? { source: st.source.value, name: spec.local.name } : (imported.get(spec.local.name) ?? (facades.has(spec.local.name) ? table.get(spec.local.name) : undefined));
        if (!origin) plain = false;
        else table.set(spec.exported.name, origin);
      }
    }
    if (plain && table.size) shims.set(file.path, table);
  }
  if (!shims.size) return 0;
  const blocked = new Set<string>();
  for (const file of tree.all()) {
    if (!CODE.test(file.path)) continue;
    for (const match of file.content.matchAll(/(?:import\s*\(\s*(?=["'][^"']+["']\s*\)(?!\s*\.then\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.\w+(?:\s*\|\|\s*\w+(?:\.\w+)?)*\s*\)))|import\s*\*\s*as\s+\w+\s+from\s*|export\s*\*\s*from\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(file.path, match[1]!);
      for (const shim of shims.keys()) if (target && (shim === target || shim.replace(/\.[^./]+$/, "") === target.replace(/\.[^./]+$/, ""))) blocked.add(shim);
    }
  }
  const shimOf = (from: string, specifier: string) => {
    const target = resolve(from, specifier);
    if (!target) return null;
    for (const shim of shims.keys()) if (!blocked.has(shim) && (shim === target || shim.replace(/\.[^./]+$/, "") === target.replace(/\.[^./]+$/, ""))) return shim;
    return null;
  };
  let count = 0;
  const consumers = tree.all().filter((f) => (f.kind === "module" || f.kind === "script") && CODE.test(f.path));
  for (const file of consumers) {
    if (shims.has(file.path)) continue;
    let source: Source | null;
    try {
      source = load(file);
    } catch {
      continue;
    }
    if (!source) continue;
    const body = source.ast.program.body;
    let changed = false;
    traverse(source.ast, {
      CallExpression(path) {
        const { callee, arguments: args } = path.node;
        if (!t.isMemberExpression(callee) || literalKey(callee.property) !== "then" || !t.isCallExpression(callee.object) || !t.isImport(callee.object.callee)) return;
        const spec = callee.object.arguments[0];
        const fn = args[0];
        if (!t.isStringLiteral(spec) || args.length !== 1 || !(t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return;
        const shim = shimOf(file.path, spec.value);
        const param = fn.params[0].name;
        let accessed: t.Node = fn.body;
        while (t.isLogicalExpression(accessed, { operator: "||" })) accessed = accessed.left;
        const member = t.isMemberExpression(accessed) && t.isIdentifier(accessed.object, { name: param }) ? literalKey(accessed.property) : null;
        const origin = shim && member ? shims.get(shim)!.get(member) : undefined;
        if (!shim || !origin || (origin.name !== "*" && !origin.name.startsWith("default:"))) return;
        const next = origin.source.startsWith(".") ? posix.relative(posix.dirname(file.path), posix.normalize(posix.join(posix.dirname(shim), origin.source))) : origin.source;
        const loaded = t.callExpression(t.import(), [t.stringLiteral(origin.source.startsWith(".") && !next.startsWith(".") ? `./${next}` : next)]);
        const exported = origin.name.startsWith("default:") ? origin.name.slice("default:".length) : null;
        path.replaceWith(exported && exported !== "default" ? t.callExpression(t.memberExpression(loaded, t.identifier("then")), [t.arrowFunctionExpression([t.identifier("m")], t.memberExpression(t.identifier("m"), t.identifier(exported)))]) : loaded);
        changed = true;
      },
    });
    for (let i = 0; i < body.length; i++) {
      const st = body[i]!;
      if (!t.isImportDeclaration(st)) continue;
      const shim = shimOf(file.path, st.source.value);
      if (!shim) continue;
      if (!st.specifiers.length) {
        body.splice(i, 1);
        i--;
        changed = true;
        continue;
      }
      const table = shims.get(shim)!;
      if (st.specifiers.length === 1 && t.isImportDefaultSpecifier(st.specifiers[0]) && table.get("default")?.name.startsWith("default:")) {
        const origin = table.get("default")!;
        const next = origin.source.startsWith(".") ? posix.relative(posix.dirname(file.path), posix.normalize(posix.join(posix.dirname(shim), origin.source))) : origin.source;
        const name = origin.name.slice("default:".length);
        const local = st.specifiers[0].local;
        body.splice(i, 1, t.importDeclaration([name === "default" ? t.importDefaultSpecifier(local) : t.importSpecifier(local, t.identifier(name))], t.stringLiteral(origin.source.startsWith(".") && !next.startsWith(".") ? `./${next}` : next)));
        changed = true;
        count++;
        continue;
      }
      if (!st.specifiers.every((spec) => t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && table.has(spec.imported.name) && table.get(spec.imported.name)!.name !== "*" && !table.get(spec.imported.name)!.name.startsWith("default:"))) continue;
      const groups = new Map<string, t.ImportSpecifier[]>();
      for (const spec of st.specifiers as t.ImportSpecifier[]) {
        const origin = table.get((spec.imported as t.Identifier).name)!;
        const next = origin.source.startsWith(".") ? posix.relative(posix.dirname(file.path), posix.normalize(posix.join(posix.dirname(shim), origin.source))) : origin.source;
        const specifier = origin.source.startsWith(".") && !next.startsWith(".") ? `./${next}` : next;
        groups.set(specifier, [...(groups.get(specifier) ?? []), t.importSpecifier(spec.local, t.identifier(origin.name))]);
      }
      body.splice(i, 1, ...[...groups].map(([specifier, specs]) => t.importDeclaration(specs, t.stringLiteral(specifier))));
      changed = true;
      count++;
    }
    if (changed) save(source);
  }
  for (const file of tree.all()) {
    if (!CODE.test(file.path) || !(file.library || /(^|\/)(node_modules|vendor)\//.test(file.path))) continue;
    const next = file.content.replace(/^[ \t]*import\s*["'](\.{1,2}\/[^"']+)["'];?[ \t]*\n?/gm, (line, specifier: string) => (shimOf(file.path, specifier) ? "" : line));
    if (next !== file.content) file.content = next;
  }
  const referenced = new Set<string>();
  for (const file of tree.all()) {
    if (!CODE.test(file.path) && !/\.(astro|html)$/.test(file.path)) continue;
    for (const match of file.content.matchAll(/["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(file.path, match[1]!);
      if (target) referenced.add(target.replace(/\.[^./]+$/, ""));
    }
  }
  for (const shim of shims.keys()) if (!referenced.has(shim.replace(/\.[^./]+$/, ""))) tree.remove(shim);
  return count;
}

function namespaceFacade(node: t.Node | null | undefined): string | null {
  let current = node;
  if (t.isCallExpression(current) && t.isMemberExpression(current.callee) && t.isIdentifier(current.callee.object, { name: "Object" }) && literalKey(current.callee.property) === "freeze") current = current.arguments[0];
  if (t.isCallExpression(current) && t.isMemberExpression(current.callee) && t.isIdentifier(current.callee.object, { name: "Object" }) && literalKey(current.callee.property) === "defineProperty") current = current.arguments[0];
  if (!t.isObjectExpression(current)) return null;
  let target: string | null = null;
  for (const prop of current.properties) {
    if (!t.isObjectProperty(prop)) return null;
    const key = literalKey(prop.key);
    if (key === "__proto__" && t.isNullLiteral(prop.value)) continue;
    if (key === "default" && t.isIdentifier(prop.value)) target = prop.value.name;
    else return null;
  }
  return target;
}

export function forwardReexports(tree: OutputTree): number {
  const files = tree.all().filter((f) => (f.kind === "module" || f.kind === "script") && CODE.test(f.path) && !f.library && !/(^|\/)(node_modules|vendor)\//.test(f.path));
  const paths = new Set(tree.all().map((f) => f.path));
  const resolveFile = (from: string, specifier: string) => {
    if (!specifier.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier.replace(/[?#].*$/, "")));
    for (const suffix of ["", ".js", ".ts", ".jsx", ".tsx", ".vue", "/index.js", "/index.ts"]) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
  const blocked = new Set<string>();
  for (const file of tree.all()) {
    if (!CODE.test(file.path)) continue;
    for (const match of file.content.matchAll(/(?:import\s*\(\s*|import\s*\*\s*as\s+\w+\s+from\s*|export\s*\*\s*from\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolveFile(file.path, match[1]!);
      if (target) blocked.add(target);
    }
  }
  const forwards = new Map<string, Map<string, { source: string; name: string; bare: boolean }>>();
  const vendorFiles = tree.all().filter((f) => (f.kind === "module" || f.kind === "script") && CODE.test(f.path) && /(^|\/)(node_modules|vendor)\//.test(f.path));
  const fileSet = new Set(files);
  for (const file of [...files, ...vendorFiles]) {
    const vendor = !fileSet.has(file);
    if (file.path.endsWith(".vue") || blocked.has(file.path)) continue;
    const shape = outline(file);
    if (!shape) continue;
    const imported = new Map<string, { source: string; name: string; bare: boolean }>();
    for (const entry of shape.imports) {
      const bare = !entry.source.startsWith(".");
      const target = bare ? entry.source : resolveFile(file.path, entry.source);
      if (!target) continue;
      for (const spec of entry.specifiers) if (spec.kind !== "namespace") imported.set(spec.local, { source: target, name: spec.imported, bare });
    }
    const table = new Map<string, { source: string; name: string; bare: boolean }>();
    for (const spec of shape.exports) {
      const origin = imported.get(spec.local);
      if (origin && (!vendor || origin.bare || !isMangled(origin.name))) table.set(spec.exported, origin);
    }
    if (table.size) forwards.set(file.path, table);
  }
  if (!forwards.size) return 0;
  let count = 0;
  for (const file of tree.all().filter((f) => (f.kind === "module" || f.kind === "script") && CODE.test(f.path))) {
    const shape = file.path.endsWith(".vue") ? null : outline(file);
    if (shape && !shape.imports.some((entry) => forwards.has(resolveFile(file.path, entry.source) ?? ""))) continue;
    let source: Source | null;
    try {
      source = load(file);
    } catch {
      continue;
    }
    if (!source) continue;
    const body = source.ast.program.body;
    let changed = false;
    for (let i = 0; i < body.length; i++) {
      const st = body[i]!;
      if (!t.isImportDeclaration(st) || st.importKind === "type") continue;
      const target = resolveFile(file.path, st.source.value);
      const table = target ? forwards.get(target) : undefined;
      if (!table || target === file.path) continue;
      const moved = st.specifiers.filter((spec): spec is t.ImportSpecifier => t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && table.has(spec.imported.name) && table.get(spec.imported.name)!.source !== file.path);
      if (!moved.length) continue;
      st.specifiers = st.specifiers.filter((spec) => !moved.includes(spec as t.ImportSpecifier));
      const bySource = new Map<string, t.ImportDeclaration["specifiers"]>();
      for (const spec of moved) {
        const origin = table.get((spec.imported as t.Identifier).name)!;
        const specifier = origin.bare ? origin.source : (() => {
          const rel = posix.relative(posix.dirname(file.path), origin.source);
          return rel.startsWith(".") ? rel : `./${rel}`;
        })();
        const next = origin.name === "default" ? t.importDefaultSpecifier(spec.local) : t.importSpecifier(spec.local, t.identifier(origin.name));
        bySource.set(specifier, [...(bySource.get(specifier) ?? []), next]);
      }
      const added = [...bySource].map(([specifier, specs]) => t.importDeclaration(specs, t.stringLiteral(specifier)));
      if (st.specifiers.length) body.splice(i + 1, 0, ...added);
      else body.splice(i, 1, ...added);
      i += added.length - (st.specifiers.length ? 0 : 1);
      count += moved.length;
      changed = true;
    }
    if (changed) save(source);
  }
  const stillImported = new Map<string, Set<string>>();
  for (const file of tree.all()) {
    if (!CODE.test(file.path)) continue;
    let source: Source | null;
    try {
      source = file.path.endsWith(".vue") || /\.m?[jt]sx?$/.test(file.path) ? load(file) : null;
    } catch {
      source = null;
    }
    if (!source) {
      for (const match of file.content.matchAll(/\b(import|export)\s*(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
        const target = resolveFile(file.path, match[4]!);
        if (!target || !forwards.has(target)) continue;
        const names = stillImported.get(target) ?? new Set<string>();
        if (match[1] === "import" && match[2]) names.add("default");
        for (const part of (match[3] ?? "").split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, "");
          if (name) names.add(name);
        }
        stillImported.set(target, names);
      }
      continue;
    }
    for (const st of source.ast.program.body) {
      if (!t.isImportDeclaration(st) && !(t.isExportNamedDeclaration(st) && st.source)) continue;
      const target = resolveFile(file.path, (st as t.ImportDeclaration).source.value);
      if (!target || !forwards.has(target)) continue;
      const names = stillImported.get(target) ?? new Set<string>();
      for (const spec of (st as t.ImportDeclaration | t.ExportNamedDeclaration).specifiers as t.Node[]) {
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported)) names.add(spec.imported.name);
        else if (t.isImportDefaultSpecifier(spec)) names.add("default");
        else if (t.isExportSpecifier(spec)) names.add(spec.local.name);
      }
      stillImported.set(target, names);
    }
  }
  for (const [path, table] of forwards) {
    const file = tree.all().find((f) => f.path === path);
    if (!file) continue;
    let source: Source | null;
    try {
      source = load(file);
    } catch {
      continue;
    }
    if (!source) continue;
    const used = stillImported.get(path) ?? new Set<string>();
    const body = source.ast.program.body;
    for (const st of body) {
      if (!t.isExportNamedDeclaration(st) || st.declaration || st.source) continue;
      st.specifiers = st.specifiers.filter((spec) => !(t.isExportSpecifier(spec) && t.isIdentifier(spec.exported) && table.has(spec.exported.name) && !used.has(spec.exported.name)));
    }
    source.ast.program.body = body.filter((st) => !(t.isExportNamedDeclaration(st) && !st.declaration && !st.source && !st.specifiers.length));
    const exportLists = (st: t.Statement): st is t.ExportNamedDeclaration => t.isExportNamedDeclaration(st) && !st.declaration && !st.source;
    const printed = print(t.file(t.program(source.ast.program.body.filter((st) => !t.isImportDeclaration(st) && !exportLists(st)))));
    const words = new Map<string, number>();
    for (const match of printed.matchAll(/[A-Za-z_$][\w$]*/g)) words.set(match[0], (words.get(match[0]) ?? 0) + 1);
    for (const st of source.ast.program.body) if (exportLists(st)) for (const spec of st.specifiers) if (t.isExportSpecifier(spec)) words.set(spec.local.name, (words.get(spec.local.name) ?? 0) + 1);
    const emptied = new Set<t.Statement>();
    for (const st of source.ast.program.body) {
      if (!t.isImportDeclaration(st) || !st.specifiers.length) continue;
      st.specifiers = st.specifiers.filter((spec) => (words.get(spec.local.name) ?? 0) > 0);
      if (!st.specifiers.length) emptied.add(st);
    }
    source.ast.program.body = source.ast.program.body.filter((st) => !emptied.has(st));
    save(source);
  }
  return count;
}

export function rebindImportedNames(tree: OutputTree): number {
  let count = 0;
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || !CODE.test(file.path) || file.library || /(^|\/)(node_modules|vendor)\//.test(file.path)) continue;
    let source: Source | null;
    try {
      source = load(file);
    } catch {
      continue;
    }
    if (!source) continue;
    const aliases = new Map<string, string>();
    for (const st of source.ast.program.body) {
      if (!t.isImportDeclaration(st)) continue;
      for (const spec of st.specifiers) if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && spec.imported.name !== spec.local.name) aliases.set(spec.imported.name, spec.local.name);
    }
    if (!aliases.size) continue;
    const program = programPath(source.ast);
    let changed = false;
    program.traverse({
      ReferencedIdentifier(path) {
        const name = (path.node as t.Identifier).name;
        const local = aliases.get(name);
        if (!local || path.scope.hasBinding(name, true)) return;
        if (path.parentPath?.isExportSpecifier()) {
          const spec = path.parentPath.node;
          if (spec.local === path.node && t.isIdentifier(spec.exported) && spec.exported.name === name) spec.exported = t.identifier(name);
        }
        (path.node as t.Identifier).name = local;
        changed = true;
        count++;
      },
    });
    if (changed) save(source);
  }
  return count;
}

function patternNames(code: string, start: number): string[] {
  let depth = 0;
  let end = start;
  for (; end < code.length; end++) {
    const char = code[end];
    if (char === "{" || char === "[" || char === "(") depth++;
    else if (char === "}" || char === "]" || char === ")") depth--;
    if (depth === 0) break;
  }
  const pattern = code.slice(start + 1, end);
  const names: string[] = [];
  for (const part of pattern.split(",")) {
    const target = part.split(":").pop()!.split("=")[0]!.replace(/^\s*\.\.\./, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(target)) names.push(target);
  }
  return names;
}

export function dedupeExports(tree: OutputTree): number {
  let count = 0;
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || !/\.m?[jt]sx?$/.test(file.path) || !/export/.test(file.content)) continue;
    const seen = new Set<string>();
    for (const match of file.content.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) seen.add(match[1]!);
    for (const match of file.content.matchAll(/export\s+(?:const|let|var)\s*([{[])/g)) for (const name of patternNames(file.content, match.index! + match[0].length - 1)) seen.add(name);
    if (/export\s+default\b/.test(file.content)) seen.add("default");
    let changed = false;
    const next = file.content.replace(/export\s*\{([^}]*)\}(\s*from\s*["'][^"']+["'])?\s*;?/g, (whole, list: string, from: string | undefined) => {
      if (from) return whole;
      const parts = list.split(",").map((p) => p.trim()).filter(Boolean);
      const kept = parts.filter((part) => {
        const name = part.split(/\s+as\s+/).pop()!.trim();
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      });
      if (kept.length === parts.length) return whole;
      changed = true;
      count += parts.length - kept.length;
      return kept.length ? `export { ${kept.join(", ")} };` : "";
    });
    if (changed) file.content = next;
  }
  return count;
}

export function unaliasExports(tree: OutputTree): number {
  const code = tree.all().filter((f) => (f.kind === "module" || f.kind === "script") && /\.(m?[jt]sx?|vue)$/.test(f.path));
  const paths = new Set(tree.all().map((f) => f.path));
  const locate = (from: string, specifier: string) => {
    const base = resolve(from, specifier.replace(/[?#].*$/, ""));
    if (!base) return null;
    for (const suffix of ["", ".ts", ".js", ".tsx", ".jsx", ".vue", "/index.ts", "/index.js"]) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
  const sources = new Map<string, Source>();
  const blocked = new Set<string>();
  const deferred: OutputFile[] = [];
  for (const file of code) {
    let source: Source | null = null;
    if (vendorFile(file) && outline(file)) {
      deferred.push(file);
      continue;
    }
    try {
      source = load(file);
    } catch {
      source = null;
    }
    if (source) {
      sources.set(file.path, source);
      continue;
    }
    for (const match of file.content.matchAll(/["'](\.{1,2}\/[^"']+)["']/g)) blocked.add(locate(file.path, match[1]!) ?? "");
  }
  for (const file of tree.all()) {
    if (!/\.(m?[jt]sx?|vue|html)$/.test(file.path)) continue;
    for (const match of file.content.matchAll(/(?:import\s*\(\s*|import\s*\*\s*as\s+[\w$]+\s+from\s*|export\s*\*\s*from\s*)["'](\.{1,2}\/[^"']+)["']/g)) blocked.add(locate(file.path, match[1]!) ?? "");
  }
  const aliases = new Map<string, Map<string, string>>();
  for (const [path, source] of sources) {
    if (blocked.has(path) || path.endsWith(".vue") || source.file.library || /(^|\/)(node_modules|vendor)\//.test(path)) continue;
    const exported = exportedNames(source.ast.program.body);
    const table = new Map<string, string>();
    for (const stmt of source.ast.program.body) {
      if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
      for (const spec of stmt.specifiers) {
        if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported)) continue;
        const alias = spec.exported.name;
        const local = spec.local.name;
        if (alias === local || !isReadable(local) || !(isMangled(alias) || alias.length <= 3)) continue;
        table.set(alias, local);
      }
    }
    if (table.size) aliases.set(path, table);
  }
  if (!aliases.size) return 0;
  for (const file of deferred) {
    const shape = outline(file)!;
    if (![...shape.imports.map((entry) => entry.source), ...shape.reexports.map((entry) => entry.source)].some((specifier) => aliases.has(locate(file.path, specifier) ?? ""))) continue;
    try {
      const source = load(file);
      if (source) sources.set(file.path, source);
    } catch {
      continue;
    }
  }
  let count = 0;
  for (const [path, source] of sources) {
    const program = programPath(source.ast);
    const locals = new Map<string, string>();
    let changed = false;
    for (const stmt of source.ast.program.body) {
      if (!(t.isImportDeclaration(stmt) || (t.isExportNamedDeclaration(stmt) && stmt.source))) continue;
      const target = locate(path, stmt.source!.value);
      const table = target ? aliases.get(target) : undefined;
      if (!table) continue;
      for (const spec of stmt.specifiers) {
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && table.has(spec.imported.name)) {
          const before = spec.imported.name;
          const to = table.get(before)!;
          spec.imported = t.identifier(to);
          if (spec.local.name === before || isMangled(spec.local.name)) locals.set(spec.local.name, to);
          changed = true;
          count++;
        } else if (t.isExportSpecifier(spec) && table.has(spec.local.name)) {
          spec.local = t.identifier(table.get(spec.local.name)!);
          changed = true;
          count++;
        }
      }
    }
    for (const [from, to] of locals) {
      const binding = program.scope.getBinding(from);
      if (!binding || program.scope.hasBinding(to) || !templateSafe(source, from, to)) continue;
      if ([...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(to))) continue;
      program.scope.rename(from, to);
      if (inTemplate(source, from)) source.templateRenames.set(from, to);
    }
    if (changed) {
      for (const stmt of source.ast.program.body) {
        if (!t.isImportDeclaration(stmt)) continue;
        const seen = new Set<string>();
        stmt.specifiers = stmt.specifiers.filter((spec) => {
          const key = t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) ? `${spec.imported.name} ${spec.local.name}` : spec.local.name;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      save(source);
    }
  }
  for (const [path, table] of aliases) {
    const source = sources.get(path)!;
    const body = source.ast.program.body;
    const exported = exportedNames(body);
    for (const stmt of body) {
      if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
      stmt.specifiers = stmt.specifiers.filter((spec) => {
        if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported) || !table.has(spec.exported.name)) return true;
        const local = spec.local.name;
        if (exported.has(local)) return false;
        exported.add(local);
        spec.exported = t.identifier(local);
        return true;
      });
    }
    source.ast.program.body = body.filter((stmt) => !t.isExportNamedDeclaration(stmt) || stmt.declaration || stmt.source || stmt.specifiers.length > 0);
    save(source);
  }
  return count;
}

function unifyImportAliases(source: Source): boolean {
  const program = programPath(source.ast);
  const first = new Map<string, string>();
  const emptied = new Set<t.Statement>();
  let changed = false;
  for (const stmt of source.ast.program.body) {
    if (!t.isImportDeclaration(stmt) || stmt.importKind === "type" || !stmt.specifiers.length) continue;
    stmt.specifiers = stmt.specifiers.filter((spec) => {
      if (!t.isImportSpecifier(spec)) return true;
      const key = `${stmt.source.value}\u0000${t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value}`;
      const kept = first.get(key);
      if (!kept) {
        first.set(key, spec.local.name);
        return true;
      }
      const binding = program.scope.getBinding(spec.local.name);
      const target = program.scope.getBinding(kept);
      if (!binding || !target || binding.constantViolations.length || binding.referencePaths.some((ref) => ref.scope.getBinding(kept) !== target)) return true;
      if (inTemplate(source, spec.local.name) && (templateDeclares(source, kept) || !templateSafe(source, spec.local.name, kept))) return true;
      for (const ref of binding.referencePaths) if (t.isIdentifier(ref.node)) ref.node.name = kept;
      if (inTemplate(source, spec.local.name)) source.templateRenames.set(spec.local.name, kept);
      changed = true;
      return false;
    });
    if (!stmt.specifiers.length) emptied.add(stmt);
  }
  if (changed) {
    source.ast.program.body = source.ast.program.body.filter((stmt) => !emptied.has(stmt));
    program.scope.crawl();
  }
  return changed;
}

export function tidyExports(tree: OutputTree): number {
  const code = tree.all().filter((f) => (f.kind === "module" || f.kind === "script") && /\.(m?[jt]sx?|vue)$/.test(f.path));
  const paths = new Set(tree.all().map((f) => f.path));
  const codeSet = new Set(code);
  const locate = (from: string, specifier: string) => {
    const base = resolve(from, specifier.replace(/[?#].*$/, ""));
    if (!base) return null;
    for (const suffix of ["", ".ts", ".js", ".tsx", ".jsx", ".vue", "/index.ts", "/index.js"]) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
  const sources = new Map<string, Source>();
  const blocked = new Set<string>();
  const wanted = new Map<string, Set<string>>();
  for (const file of tree.all()) {
    if (!/\.(m?[jt]sx?|vue|html|astro|svelte)$/.test(file.path)) continue;
    let source: Source | null = null;
    const vendored = codeSet.has(file) && vendorFile(file) ? outline(file) : null;
    if (vendored) {
      for (const target of [...vendored.exportAll, ...vendored.dynamic]) blocked.add(locate(file.path, target) ?? "");
      for (const entry of vendored.imports) {
        const target = locate(file.path, entry.source);
        if (!target) continue;
        const names = wanted.get(target) ?? new Set<string>();
        for (const spec of entry.specifiers) {
          if (spec.kind === "namespace") blocked.add(target);
          else names.add(spec.imported);
        }
        wanted.set(target, names);
      }
      for (const entry of vendored.reexports) {
        const target = locate(file.path, entry.source);
        if (!target) continue;
        wanted.set(target, new Set([...(wanted.get(target) ?? []), ...entry.locals]));
      }
      continue;
    }
    if (codeSet.has(file)) {
      try {
        source = load(file);
      } catch {
        source = null;
      }
    }
    if (!source) {
      const imported = new Set<string>();
      if (/\.(astro|svelte)$/.test(file.path)) {
        for (const match of file.content.matchAll(/\bimport\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
          const target = locate(file.path, match[3]!);
          if (!target) continue;
          imported.add(match[3]!);
          const names = wanted.get(target) ?? new Set<string>();
          if (match[1]) names.add("default");
          for (const part of (match[2] ?? "").split(",")) {
            const name = part.trim().split(/\s+as\s+/)[0]?.trim();
            if (name) names.add(name);
          }
          wanted.set(target, names);
        }
      }
      for (const match of file.content.matchAll(/["'](\.{1,2}\/[^"']+)["']/g)) if (!imported.has(match[1]!)) blocked.add(locate(file.path, match[1]!) ?? "");
      continue;
    }
    sources.set(file.path, source);
    for (const stmt of source.ast.program.body) {
      if (t.isExportAllDeclaration(stmt)) blocked.add(locate(file.path, stmt.source.value) ?? "");
      if (!t.isImportDeclaration(stmt) && !(t.isExportNamedDeclaration(stmt) && stmt.source)) continue;
      const target = locate(file.path, stmt.source!.value);
      if (!target) continue;
      const names = wanted.get(target) ?? new Set<string>();
      for (const spec of stmt.specifiers) {
        if (t.isImportNamespaceSpecifier(spec)) blocked.add(target);
        else if (t.isImportDefaultSpecifier(spec)) names.add("default");
        else if (t.isImportSpecifier(spec)) names.add(t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value);
        else if (t.isExportSpecifier(spec)) names.add(spec.local.name);
      }
      wanted.set(target, names);
    }
    traverse(source.ast, {
      CallExpression(p) {
        const arg = p.node.arguments[0];
        if (t.isImport(p.node.callee) && t.isStringLiteral(arg)) blocked.add(locate(file.path, arg.value) ?? "");
      },
    });
  }
  let count = 0;
  for (const [path, source] of sources) {
    if (source.file.library || /(^|\/)(node_modules|vendor)\//.test(path)) continue;
    const program = programPath(source.ast);
    let renamed = false;
    for (const stmt of source.ast.program.body) {
      if (!t.isImportDeclaration(stmt)) continue;
      for (const spec of stmt.specifiers) {
        if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported)) continue;
        const from = spec.local.name;
        const to = spec.imported.name;
        if (from === to || !isMangled(from) || !isReadable(to) || program.scope.hasBinding(to) || !templateSafe(source, from, to)) continue;
        const binding = program.scope.getBinding(from);
        if (!binding || [...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(to))) continue;
        program.scope.rename(from, to);
        if (inTemplate(source, from)) source.templateRenames.set(from, to);
        renamed = true;
      }
    }
    const firstBySource = new Map<string, t.ImportDeclaration>();
    const merged = new Set<t.Statement>();
    for (const stmt of source.ast.program.body) {
      if (!t.isImportDeclaration(stmt) || stmt.importKind === "type" || !stmt.specifiers.length || !stmt.specifiers.every((spec) => t.isImportSpecifier(spec))) continue;
      const first = firstBySource.get(stmt.source.value);
      if (!first) {
        firstBySource.set(stmt.source.value, stmt);
        continue;
      }
      for (const spec of stmt.specifiers) if (!first.specifiers.some((other) => other.local.name === spec.local.name)) first.specifiers.push(spec);
      merged.add(stmt);
    }
    if (merged.size) {
      source.ast.program.body = source.ast.program.body.filter((stmt) => !merged.has(stmt));
      renamed = true;
    }
    if (unifyImportAliases(source)) renamed = true;
    if (renamed) save(source);
  }
  for (const [path, source] of sources) {
    if (path.endsWith(".vue") || blocked.has(path) || source.file.library || /(^|\/)(node_modules|vendor)\//.test(path)) continue;
    const body = source.ast.program.body;
    const used = wanted.get(path) ?? new Set<string>();
    const exported = exportedNames(body);
    let changed = false;
    for (const stmt of body) {
      if (!t.isExportNamedDeclaration(stmt) || stmt.source || stmt.declaration) continue;
      stmt.specifiers = stmt.specifiers.filter((spec) => {
        if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported)) return true;
        const alias = spec.exported.name;
        if (alias === spec.local.name || used.has(alias) || !exported.has(spec.local.name)) return true;
        changed = true;
        count++;
        return false;
      });
    }
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i]!;
      if (!t.isExportNamedDeclaration(stmt) || stmt.source || !stmt.declaration) continue;
      const names = Object.keys(t.getBindingIdentifiers(stmt.declaration));
      if (names.length !== 1 || used.has(names[0]!) || !isMangled(names[0]!)) continue;
      const aliased = body.some((other) => t.isExportNamedDeclaration(other) && !other.source && other.specifiers.some((spec) => t.isExportSpecifier(spec) && spec.local.name === names[0] && t.isIdentifier(spec.exported) && spec.exported.name !== names[0] && used.has(spec.exported.name)));
      if (!aliased) continue;
      body[i] = stmt.declaration;
      exported.delete(names[0]!);
      changed = true;
    }
    const program = programPath(source.ast);
    for (let i = body.length - 1; i >= 0; i--) {
      const stmt = body[i]!;
      if (!t.isExportNamedDeclaration(stmt) || stmt.source || !stmt.declaration) continue;
      const names = Object.keys(t.getBindingIdentifiers(stmt.declaration));
      if (names.length !== 1 || !isMangled(names[0]!) || used.has(names[0]!)) continue;
      const binding = program.scope.getBinding(names[0]!);
      if (!binding || binding.constantViolations.length || binding.referencePaths.some((ref) => !ref.isExportNamedDeclaration() && !ref.parentPath?.isExportNamedDeclaration() && !ref.parentPath?.isExportSpecifier())) continue;
      body.splice(i, 1);
      exported.delete(names[0]!);
      changed = true;
      count++;
    }
    for (const stmt of body) {
      if (!t.isExportNamedDeclaration(stmt) || stmt.source || stmt.declaration) continue;
      for (const spec of stmt.specifiers) {
        if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported)) continue;
        const local = spec.local.name;
        const alias = spec.exported.name;
        if (local === alias || !isMangled(local) || !isReadable(alias) || program.scope.hasBinding(alias) || exported.has(local)) continue;
        const binding = program.scope.getBinding(local);
        if (!binding || [...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(alias))) continue;
        program.scope.rename(local, alias);
        spec.local = t.identifier(alias);
        spec.exported = t.identifier(alias);
        changed = true;
      }
    }
    const listed = new Map<string, t.ExportNamedDeclaration>();
    for (const stmt of body) {
      if (!t.isExportNamedDeclaration(stmt) || stmt.source || stmt.declaration) continue;
      for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported) && spec.exported.name === spec.local.name) listed.set(spec.local.name, stmt);
    }
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i]!;
      const names = t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt) ? (stmt.id ? [stmt.id.name] : []) : t.isVariableDeclaration(stmt) && stmt.declarations.length === 1 && t.isIdentifier(stmt.declarations[0]!.id) ? [stmt.declarations[0]!.id.name] : [];
      const name = names[0];
      if (!name || !listed.has(name)) continue;
      const holder = listed.get(name)!;
      holder.specifiers = holder.specifiers.filter((spec) => !(t.isExportSpecifier(spec) && t.isIdentifier(spec.exported, { name }) && spec.local.name === name));
      body[i] = t.exportNamedDeclaration(stmt as t.Declaration, []);
      changed = true;
    }
    if (!changed) continue;
    source.ast.program.body = body.filter((stmt) => !t.isExportNamedDeclaration(stmt) || stmt.declaration || stmt.source || stmt.specifiers.length > 0);
    save(source);
  }
  return count;
}

function singular(word: string): string {
  return word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("ses") ? word.slice(0, -2) : word.endsWith("s") ? word.slice(0, -1) : word;
}

function i18nNamespace(node: t.Node): string | null {
  const found = new Set<string>();
  t.traverseFast(node, (n) => {
    if (!t.isCallExpression(n) || !t.isIdentifier(n.callee) || !/^(t|tm|rt|\$t)$/.test(n.callee.name)) return;
    const arg = n.arguments[0];
    const head = t.isTemplateLiteral(arg) ? arg.quasis[0]?.value.cooked : null;
    const ns = head ? /^([a-z][A-Za-z0-9]*)(?:\.[a-z][A-Za-z0-9]*)*\.$/.exec(head)?.[1] : null;
    if (ns) found.add(ns);
  });
  return found.size === 1 ? [...found][0]! : null;
}

function setupBindingName(init: t.Node | null | undefined, uses: (name: string) => Set<string>, local: string): string | null {
  const getter = t.isCallExpression(init) && t.isIdentifier(init.callee, { name: "computed" }) && (t.isArrowFunctionExpression(init.arguments[0]) || t.isFunctionExpression(init.arguments[0])) ? (init.arguments[0] as t.ArrowFunctionExpression) : null;
  const body = getter ? (t.isBlockStatement(getter.body) ? (getter.body.body.length === 1 && t.isReturnStatement(getter.body.body[0]) ? getter.body.body[0].argument : null) : getter.body) : null;
  if (body) {
    const unwrapped = t.isLogicalExpression(body) ? body.left : body;
    const member = t.isOptionalMemberExpression(unwrapped) || t.isMemberExpression(unwrapped) ? unwrapped : null;
    const find = member ? member.object : unwrapped;
    if ((t.isCallExpression(find) || t.isOptionalCallExpression(find)) && t.isMemberExpression(find.callee) && t.isIdentifier(find.callee.property, { name: "find" }) && t.isIdentifier(find.callee.object)) {
      let literal: string | null = null;
      t.traverseFast(find.arguments[0] ?? t.nullLiteral(), (n) => {
        if (!literal && t.isBinaryExpression(n) && /^===?$/.test(n.operator) && t.isStringLiteral(n.right) && /^[a-z][a-z0-9]*$/i.test(n.right.value)) literal = n.right.value;
      });
      const prop = member && !member.computed && t.isIdentifier(member.property) ? member.property.name : null;
      if (literal && prop) return `${literal}${prop[0]!.toUpperCase()}${prop.slice(1)}`;
      const list = find.callee.object.name;
      if (!prop && /s$/.test(list)) return `current${singular(list)[0]!.toUpperCase()}${singular(list).slice(1)}`;
    }
    if (t.isConditionalExpression(body) && t.isStringLiteral(body.consequent) && t.isStringLiteral(body.alternate) && /\blocale\b/.test(JSON.stringify(body.test))) return "nextLocale";
    if (t.isArrayExpression(body) && body.elements.length && body.elements.every((e) => t.isObjectExpression(e) && e.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "href") && e.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "label"))) return "links";
  }
  const namespace = init ? i18nNamespace(init) : null;
  if (namespace) return namespace;
  const members = uses(local);
  if (t.isCallExpression(init) && !init.arguments.length && members.has("htmlAttrs") && members.has("link")) return "localeHead";
  return null;
}

function setupFunctionName(fn: t.Function, calledAs: Set<string>): string | null {
  let calls = "";
  t.traverseFast(fn.body, (n) => {
    if (t.isCallExpression(n) && t.isIdentifier(n.callee)) calls += ` ${n.callee.name}`;
  });
  if (/\btm\b/.test(calls) && /\brt\b/.test(calls)) return "translateList";
  const returned = t.isBlockStatement(fn.body) ? fn.body.body.find((s): s is t.ReturnStatement => t.isReturnStatement(s))?.argument : fn.body;
  if (!fn.params.length && t.isObjectExpression(returned) && returned.properties.length >= 2 && calledAs.has("destructured")) return "getContent";
  return null;
}

function unwrapNormalizers(file: OutputFile): void {
  const script = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/.exec(file.content);
  const before = script ? file.content.slice(0, script.index) : file.content;
  const after = script ? file.content.slice(script.index + script[0].length) : "";
  const fix = (html: string) => html.replace(/(\s:(class|style)=")(normalizeClass|normalizeStyle)\(([^"]*)\)"/g, (whole, lead: string, attr: string, fn: string, inner: string) => ((attr === "class") === (fn === "normalizeClass") ? `${lead}${inner}"` : whole));
  const nextBefore = fix(before);
  const nextAfter = fix(after);
  if (nextBefore === before && nextAfter === after) return;
  let code = script ? script[2]! : "";
  for (const name of ["normalizeClass", "normalizeStyle"]) {
    const usedOutside = new RegExp(`\\b${name}\\b`).test(nextBefore + nextAfter);
    const usedInside = new RegExp(`\\b${name}\\b`).test(code.replace(/^import[^;]*;?$/gm, ""));
    if (usedOutside || usedInside) continue;
    code = code.replace(new RegExp(`^(import\\s*\\{)([^}]*)(\\}\\s*from\\s*["']vue["'];?)$`, "gm"), (whole, open: string, list: string, close: string) => {
      const parts = list.split(",").map((x) => x.trim());
      if (!parts.includes(name)) return whole;
      const kept = parts.filter((x) => x && x !== name);
      return kept.length ? `${open} ${kept.join(", ")} ${close}` : "";
    });
  }
  file.content = script ? `${nextBefore}${script[1]}${code}${script[3]}${nextAfter}` : nextBefore;
}

export function nameSetupBindings(tree: OutputTree): number {
  let count = 0;
  for (const file of tree.all()) {
    if (!file.path.endsWith(".vue") || /(^|\/)(node_modules|vendor)\//.test(file.path)) continue;
    unwrapNormalizers(file);
    let source: Source | null;
    try {
      source = load(file);
    } catch {
      continue;
    }
    if (!source) continue;
    const program = programPath(source.ast);
    const template = source.outside;
    const renames = new Map<string, string>();
    const uses = (name: string) => {
      const out = new Set<string>();
      for (const ref of program.scope.getBinding(name)?.referencePaths ?? []) {
        let parent = ref.parentPath;
        if (parent?.isMemberExpression() && t.isIdentifier(parent.node.property, { name: "value" })) parent = parent.parentPath;
        if (parent?.isMemberExpression() && !parent.node.computed) out.add(literalKey(parent.node.property) ?? "");
      }
      return out;
    };
    for (const stmt of source.ast.program.body) {
      if (t.isVariableDeclaration(stmt)) {
        for (const d of stmt.declarations) {
          const store = t.isIdentifier(d.id) && t.isCallExpression(d.init) && !d.init.arguments.length && t.isIdentifier(d.init.callee) ? /^use([A-Z]\w*?)Store$/.exec(d.init.callee.name)?.[1] : undefined;
          if (store && t.isIdentifier(d.id)) {
            const wanted = store[0]!.toLowerCase() + store.slice(1);
            if (!d.id.name.toLowerCase().startsWith(wanted.toLowerCase()) && !renames.has(d.id.name)) renames.set(d.id.name, wanted);
            continue;
          }
          if (!t.isIdentifier(d.id) || !isMangled(d.id.name) || renames.has(d.id.name)) continue;
          const name = setupBindingName(d.init, uses, d.id.name);
          if (name) renames.set(d.id.name, name);
          if (name === "localeHead" && t.isCallExpression(d.init) && t.isIdentifier(d.init.callee) && isMangled(d.init.callee.name)) renames.set(d.init.callee.name, "useLocaleHead");
        }
      } else if (t.isFunctionDeclaration(stmt) && stmt.id && isMangled(stmt.id.name)) {
        const calledAs = new Set<string>();
        for (const ref of program.scope.getBinding(stmt.id.name)?.referencePaths ?? []) if (ref.parentPath?.isCallExpression() && ref.parentPath.parentPath?.isVariableDeclarator() && t.isObjectPattern(ref.parentPath.parentPath.node.id)) calledAs.add("destructured");
        const name = setupFunctionName(stmt, calledAs);
        if (name) renames.set(stmt.id.name, name);
      }
    }
    for (const match of template.matchAll(/v-for="\(?([A-Za-z_$][\w$]*)[^"]*?\s(?:in|of)\s+([A-Za-z_$][\w$]*)"/g)) {
      const [, item, list] = match;
      if (!isMangled(list!) || renames.has(list!)) continue;
      const span = elementSpan(template, match.index!);
      const ns = new RegExp(`\\bt\\(\\s*\`([a-z][A-Za-z0-9]*)(?:\\.[a-z][A-Za-z0-9]*)*\\.\\$\\{${item!.replace(/\$/g, "\\$")}\\.`).exec(template.slice(match.index!, span))?.[1];
      if (ns) renames.set(list!, ns);
    }
    let changed = false;
    for (const [from, base] of renames) {
      let to = base;
      for (let n = 2; program.scope.hasBinding(to) || RESERVED.has(to); n++) to = `${base}${n}`;
      const binding = program.scope.getBinding(from);
      if (!binding || !templateSafe(source, from, to) || [...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(to))) continue;
      program.scope.rename(from, to);
      if (inTemplate(source, from)) source.templateRenames.set(from, to);
      changed = true;
      count++;
    }
    if (changed) save(source);
  }
  return count;
}

export function adoptVendorAliases(tree: OutputTree, packageExport: PackageExport): number {
  const paths = new Set(tree.all().map((f) => f.path));
  const locate = (from: string, specifier: string) => {
    const base = resolve(from, specifier.replace(/[?#].*$/, ""));
    if (!base) return null;
    for (const suffix of ["", ".ts", ".js", ".tsx", ".jsx", ".vue", "/index.ts", "/index.js"]) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
  const vendorPackage = (path: string) => /(?:^|\/)(?:node_modules|vendor)\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1] ?? null;
  const sources = new Map<string, Source>();
  const blocked = new Set<string>();
  const deferred = new Map<string, OutputFile>();
  const sourceOf = (path: string): Source | null => {
    const known = sources.get(path);
    if (known) return known;
    const file = deferred.get(path);
    if (!file) return null;
    try {
      const loaded = load(file);
      if (loaded) sources.set(path, loaded);
      return loaded;
    } catch {
      return null;
    }
  };
  const votes = new Map<string, Map<string, Map<string, number>>>();
  for (const file of tree.all()) {
    if (!/\.(m?[jt]sx?|vue|html|astro|svelte)$/.test(file.path)) continue;
    let source: Source | null = null;
    const code = (file.kind === "module" || file.kind === "script") && /\.(m?[jt]sx?|vue)$/.test(file.path);
    const shape = code && vendorPackage(file.path) ? outline(file) : null;
    if (shape) {
      deferred.set(file.path, file);
      for (const target of [...shape.exportAll, ...shape.dynamic]) blocked.add(locate(file.path, target) ?? "");
      for (const entry of shape.imports) if (entry.specifiers.some((spec) => spec.kind === "namespace")) blocked.add(locate(file.path, entry.source) ?? "");
      continue;
    }
    if (code) {
      try {
        source = load(file);
      } catch {
        source = null;
      }
    }
    if (!source) {
      for (const match of file.content.matchAll(/["'](\.{1,2}\/[^"']+)["']/g)) blocked.add(locate(file.path, match[1]!) ?? "");
      continue;
    }
    sources.set(file.path, source);
    const own = !vendorPackage(file.path);
    for (const stmt of source.ast.program.body) {
      if (t.isExportAllDeclaration(stmt)) blocked.add(locate(file.path, stmt.source.value) ?? "");
      if (!t.isImportDeclaration(stmt)) continue;
      const target = locate(file.path, stmt.source.value);
      if (!target || !vendorPackage(target)) continue;
      for (const spec of stmt.specifiers) {
        if (t.isImportNamespaceSpecifier(spec)) blocked.add(target);
        if (!own || !t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported) || !isMangled(spec.imported.name)) continue;
        const name = spec.local.name.replace(/\d+$/, "");
        if (!isReadable(name)) continue;
        const byExport = votes.get(target) ?? new Map<string, Map<string, number>>();
        const names = byExport.get(spec.imported.name) ?? new Map<string, number>();
        names.set(name, (names.get(name) ?? 0) + 1);
        byExport.set(spec.imported.name, names);
        votes.set(target, byExport);
      }
    }
    traverse(source.ast, {
      CallExpression(p) {
        const arg = p.node.arguments[0];
        if (t.isImport(p.node.callee) && t.isStringLiteral(arg)) blocked.add(locate(file.path, arg.value) ?? "");
      },
    });
  }
  const renames = new Map<string, Map<string, string>>();
  for (const [target, byExport] of votes) {
    const pkg = vendorPackage(target);
    const vendor = pkg && !blocked.has(target) ? sourceOf(target) : null;
    if (!vendor || !pkg || blocked.has(target)) continue;
    const body = vendor.ast.program.body;
    const exported = exportedNames(body);
    const table = new Map<string, string>();
    for (const [name, names] of byExport) {
      const total = [...names.values()].reduce((a, b) => a + b, 0);
      const [best, count] = [...names].sort((a, b) => b[1] - a[1])[0]!;
      if (count * 3 < total * 2 || !packageExport(pkg, best) || [...table.values()].includes(best)) continue;
      if (renameExport(body, exported, name, best)) table.set(name, best);
    }
    if (!table.size) continue;
    renames.set(target, table);
    save(vendor);
  }
  if (!renames.size) return 0;
  for (const [path, file] of deferred) {
    const shape = outline(file);
    if (shape && [...shape.imports.map((entry) => entry.source), ...shape.reexports.map((entry) => entry.source)].some((specifier) => renames.has(locate(path, specifier) ?? ""))) sourceOf(path);
  }
  let count = 0;
  for (const [path, source] of sources) {
    const program = programPath(source.ast);
    let changed = false;
    const locals = new Map<string, string>();
    for (const stmt of source.ast.program.body) {
      if (!t.isImportDeclaration(stmt) && !(t.isExportNamedDeclaration(stmt) && stmt.source)) continue;
      const target = locate(path, (stmt as t.ImportDeclaration).source.value);
      const table = target ? renames.get(target) : undefined;
      if (!table) continue;
      for (const spec of (stmt as t.ImportDeclaration | t.ExportNamedDeclaration).specifiers) {
        if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported) && table.has(spec.imported.name)) {
          const to = table.get(spec.imported.name)!;
          if (isMangled(spec.local.name) || spec.local.name === spec.imported.name) locals.set(spec.local.name, to);
          spec.imported = t.identifier(to);
          changed = true;
          count++;
        } else if (t.isExportSpecifier(spec) && table.has(spec.local.name)) {
          spec.local = t.identifier(table.get(spec.local.name)!);
          changed = true;
          count++;
        }
      }
    }
    for (const [from, to] of locals) {
      const binding = program.scope.getBinding(from);
      if (!binding || program.scope.hasBinding(to) || !templateSafe(source, from, to)) continue;
      if ([...binding.referencePaths, ...binding.constantViolations].some((ref) => ref.scope.hasBinding(to))) continue;
      program.scope.rename(from, to);
      if (inTemplate(source, from)) source.templateRenames.set(from, to);
    }
    if (changed && !vendorPackage(path)) importFromPackages(path, source, packageExport);
    if (changed) save(source);
  }
  return count;
}
