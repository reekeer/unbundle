import { posix } from "node:path";
import type { OutputTree } from "../output.ts";
import type { OutputFile } from "../types.ts";
import { parseProgram, print, t, traverse, type NodePath } from "../unpack/ast.ts";

const SUFFIXES = ["", ".js", ".ts", ".jsx", ".tsx", ".mjs", "/index.js", "/index.ts"];
const CODE = /\.(m?[jt]sx?|vue)$/;

interface Parsed {
  file: OutputFile;
  ast: t.File;
  program: NodePath<t.Program>;
}

function programOf(ast: t.File): NodePath<t.Program> {
  let found: NodePath<t.Program> | null = null;
  traverse(ast, {
    Program(path) {
      found = path;
      path.stop();
    },
  });
  return found!;
}

function resolver(tree: OutputTree): (from: string, specifier: string) => string | null {
  const paths = new Set(tree.all().map((f) => f.path));
  return (from, specifier) => {
    if (!specifier.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier.replace(/[?#].*$/, "")));
    for (const suffix of SUFFIXES) if (paths.has(base + suffix)) return base + suffix;
    return null;
  };
}

function relative(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(from), to);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function localOfExport(body: t.Statement[], name: string): string | null {
  for (const st of body) {
    if (!t.isExportNamedDeclaration(st)) continue;
    for (const spec of st.specifiers) if (t.isExportSpecifier(spec) && (t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value) === name) return spec.local.name;
    if (st.declaration && topLevelNames([st.declaration]).has(name)) return name;
  }
  return null;
}

function topLevelNames(body: t.Statement[]): Set<string> {
  const names = new Set<string>();
  for (const st of body) {
    const decl = t.isExportNamedDeclaration(st) || t.isExportDefaultDeclaration(st) ? st.declaration : st;
    if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) names.add(decl.id.name);
    if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) for (const name of Object.keys(t.getBindingIdentifiers(d.id))) names.add(name);
  }
  return names;
}

export function mergeModules(tree: OutputTree, groups: Map<string, string[]>): Map<string, string> {
  const resolve = resolver(tree);
  const moved = new Map<string, string>();
  for (const [target, members] of groups) for (const member of members) moved.set(member, target);
  const byPath = new Map(tree.all().map((f) => [f.path, f]));
  const exportRenames = new Map<string, Map<string, string>>();
  for (const [target, members] of groups) {
    const parsed: Parsed[] = [];
    for (const path of members) {
      const file = byPath.get(path);
      if (!file) continue;
      try {
        const ast = parseProgram(file.content);
        parsed.push({ file, ast, program: programOf(ast) });
      } catch {
        continue;
      }
    }
    if (parsed.length < 2 || parsed.filter((p) => p.ast.program.body.some((st) => t.isExportDefaultDeclaration(st))).length > 1) continue;
    const deps = new Map<Parsed, Set<Parsed>>();
    for (const item of parsed) {
      const set = new Set<Parsed>();
      for (const st of item.ast.program.body) {
        if (!t.isImportDeclaration(st)) continue;
        const found = resolve(item.file.path, st.source.value);
        const other = parsed.find((p) => p.file.path === found);
        if (other && other !== item) set.add(other);
      }
      deps.set(item, set);
    }
    const ordered: Parsed[] = [];
    const visiting = new Set<Parsed>();
    const visit = (item: Parsed) => {
      if (ordered.includes(item) || visiting.has(item)) return;
      visiting.add(item);
      for (const dep of deps.get(item)!) visit(dep);
      visiting.delete(item);
      ordered.push(item);
    };
    for (const item of parsed) visit(item);
    const taken = new Map<string, string>();
    const imports = new Map<string, Map<string, string>>();
    const sideEffects = new Set<string>();
    const bodies: t.Statement[] = [];
    const signatureOf = (item: Parsed, st: t.ImportDeclaration, spec: t.ImportDeclaration["specifiers"][number]) => {
      const found = resolve(item.file.path, st.source.value);
      const source = found ?? st.source.value;
      const imported = t.isImportDefaultSpecifier(spec) ? "default" : t.isImportNamespaceSpecifier(spec) ? "*" : t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
      return found && members.includes(found) ? `local:${found}:${imported}` : `import:${source}:${imported}`;
    };
    const exportedNames = (body: t.Statement[]) => {
      const names = new Set<string>();
      for (const st of body) {
        if (!t.isExportNamedDeclaration(st)) continue;
        if (st.declaration) for (const name of topLevelNames([st.declaration])) names.add(name);
        for (const spec of st.specifiers) if (t.isExportSpecifier(spec)) names.add(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value);
      }
      return names;
    };
    const exportCount = new Map<string, number>();
    for (const item of ordered) for (const name of exportedNames(item.ast.program.body)) exportCount.set(name, (exportCount.get(name) ?? 0) + 1);
    const exportTaken = new Set<string>();
    for (const item of ordered) {
      const body = item.ast.program.body;
      for (const name of exportedNames(body)) {
        if (!exportTaken.has(name) || (exportCount.get(name) ?? 0) < 2) {
          exportTaken.add(name);
          continue;
        }
        let next = `${name}2`;
        for (let n = 3; exportTaken.has(next) || (exportCount.get(next) ?? 0) > 0; n++) next = `${name}${n}`;
        for (const st of body) {
          if (!t.isExportNamedDeclaration(st)) continue;
          for (const spec of st.specifiers) if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported, { name })) spec.exported = t.identifier(next);
          if (st.declaration && topLevelNames([st.declaration]).has(name)) st.specifiers = [];
        }
        const declared = body.find((st) => t.isExportNamedDeclaration(st) && st.declaration && topLevelNames([st.declaration]).has(name)) as t.ExportNamedDeclaration | undefined;
        if (declared) {
          body.splice(body.indexOf(declared), 1, declared.declaration!, t.exportNamedDeclaration(null, [t.exportSpecifier(t.identifier(name), t.identifier(next))]));
        }
        exportTaken.add(next);
        exportRenames.set(item.file.path, new Map([...(exportRenames.get(item.file.path) ?? []), [name, next]]));
      }
      item.program.scope.crawl();
    }
    for (const item of ordered) {
      const body = item.ast.program.body;
      const wanted = new Map<string, string>();
      for (const name of topLevelNames(body)) wanted.set(name, `decl:${item.file.path}:${name}`);
      for (const st of body) if (t.isImportDeclaration(st)) for (const spec of st.specifiers) if (!signatureOf(item, st, spec).startsWith("local:")) wanted.set(spec.local.name, signatureOf(item, st, spec));
      for (const [name, signature] of wanted) {
        if (!taken.has(name) || taken.get(name) === signature) {
          taken.set(name, signature);
          continue;
        }
        let next = `${name}2`;
        for (let n = 3; taken.has(next) || item.program.scope.hasBinding(next); n++) next = `${name}${n}`;
        item.program.scope.rename(name, next);
        taken.set(next, signature);
      }
      for (const st of body) {
        if (!t.isImportDeclaration(st)) {
          bodies.push(st);
          continue;
        }
        const found = resolve(item.file.path, st.source.value);
        const local = found ? members.includes(found) : false;
        if (local) {
          const owner = parsed.find((p) => p.file.path === found);
          for (const spec of st.specifiers) {
            if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported) || !owner) continue;
            const renamed = localOfExport(owner.ast.program.body, spec.imported.name) ?? spec.imported.name;
            if (renamed !== spec.local.name) item.program.scope.rename(spec.local.name, renamed);
          }
          continue;
        }
        const source = found ? relative(target, moved.get(found) ?? found) : st.source.value;
        if (!st.specifiers.length) {
          sideEffects.add(source);
          continue;
        }
        const table = imports.get(source) ?? new Map<string, string>();
        for (const spec of st.specifiers) {
          const imported = t.isImportDefaultSpecifier(spec) ? "default" : t.isImportNamespaceSpecifier(spec) ? "*" : t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
          table.set(spec.local.name, imported);
        }
        imports.set(source, table);
      }
    }
    const header: t.Statement[] = [];
    for (const source of sideEffects) if (!imports.has(source)) header.push(t.importDeclaration([], t.stringLiteral(source)));
    for (const [source, table] of imports) {
      const specifiers = [...table].map(([local, imported]) => (imported === "default" ? t.importDefaultSpecifier(t.identifier(local)) : imported === "*" ? t.importNamespaceSpecifier(t.identifier(local)) : t.importSpecifier(t.identifier(local), t.identifier(imported))));
      const namespace = specifiers.filter((s) => t.isImportNamespaceSpecifier(s));
      const rest = specifiers.filter((s) => !t.isImportNamespaceSpecifier(s));
      if (rest.length) header.push(t.importDeclaration(rest.sort((a, b) => Number(t.isImportSpecifier(a)) - Number(t.isImportSpecifier(b))), t.stringLiteral(source)));
      for (const ns of namespace) header.push(t.importDeclaration([ns], t.stringLiteral(source)));
    }
    const first = parsed[0]!.file;
    const content = print(t.file(t.program([...header, ...bodies])));
    try {
      traverse(parseProgram(content), {
        Program(path) {
          path.scope.crawl();
          path.stop();
        },
      });
    } catch {
      for (const member of members) moved.delete(member);
      continue;
    }
    for (const item of parsed) tree.remove(item.file.path);
    tree.add({ ...first, path: target, content });
  }
  const final = resolver(tree);
  for (const file of tree.all()) {
    if (!CODE.test(file.path)) continue;
    const script = file.path.endsWith(".vue") ? /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/.exec(file.content) : null;
    const code = script ? script[2]! : file.content;
    const next = code.replace(/((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'])(\.{1,2}\/[^"']+)(["'])/g, (match, lead: string, specifier: string, quote: string) => {
      const base = posix.normalize(posix.join(posix.dirname(file.path), specifier.replace(/[?#].*$/, "")));
      const old = SUFFIXES.map((suffix) => base + suffix).find((candidate) => moved.has(candidate));
      if (!old || final(file.path, specifier)) return match;
      return `${lead}${relative(file.path, moved.get(old)!)}${quote}`;
    });
    if (next === code) continue;
    file.content = script ? `${file.content.slice(0, script.index)}${script[1]}${next}${script[3]}${file.content.slice(script.index + script[0].length)}` : next;
  }
  const renamedTargets = new Map<string, Map<string, string>>();
  for (const [oldPath, renames] of exportRenames) {
    const target = moved.get(oldPath);
    if (target) renamedTargets.set(target, new Map([...(renamedTargets.get(target) ?? []), ...renames]));
  }
  if (renamedTargets.size) {
    const after = resolver(tree);
    for (const file of tree.all()) {
      if (!CODE.test(file.path)) continue;
      const script = file.path.endsWith(".vue") ? /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/.exec(file.content) : null;
      const code = script ? script[2]! : file.content;
      let ast: t.File;
      try {
        ast = parseProgram(code);
      } catch {
        continue;
      }
      let changed = false;
      for (const st of ast.program.body) {
        if (!t.isImportDeclaration(st)) continue;
        const target = after(file.path, st.source.value);
        const renames = target ? renamedTargets.get(target) : undefined;
        if (!renames) continue;
        for (const spec of st.specifiers) {
          if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported) || !renames.has(spec.imported.name)) continue;
          spec.imported = t.identifier(renames.get(spec.imported.name)!);
          changed = true;
        }
      }
      if (!changed) continue;
      const next = print(ast);
      file.content = script ? `${file.content.slice(0, script.index)}${script[1]}\n${next.trim()}\n${script[3]}${file.content.slice(script.index + script[0].length)}` : next;
    }
  }
  return moved;
}

function classInfo(file: OutputFile): { classes: Array<{ name: string; superClass: string | null; creates: string[] }>; functions: string[] } {
  const classes: Array<{ name: string; superClass: string | null; creates: string[] }> = [];
  const functions: string[] = [];
  try {
    for (const st of parseProgram(file.content).program.body) {
      const decl = t.isExportNamedDeclaration(st) || t.isExportDefaultDeclaration(st) ? st.declaration : st;
      if (t.isClassDeclaration(decl) && decl.id) {
        const creates: string[] = [];
        t.traverseFast(decl, (node) => {
          if (t.isNewExpression(node) && t.isIdentifier(node.callee)) creates.push(node.callee.name);
        });
        classes.push({ name: decl.id.name, superClass: t.isIdentifier(decl.superClass) ? decl.superClass.name : null, creates });
      } else if (t.isFunctionDeclaration(decl) && decl.id) functions.push(decl.id.name);
    }
  } catch {
    return { classes, functions };
  }
  return { classes, functions };
}

export function apiGroups(tree: OutputTree, dir: string): Map<string, string[]> {
  const files = tree.all().filter((f) => posix.dirname(f.path) === dir && /\.m?[jt]s$/.test(f.path) && !f.library);
  if (files.length < 8) return new Map();
  const ext = posix.extname(files[0]!.path);
  const info = new Map(files.map((f) => [f, classInfo(f)]));
  const classFile = new Map<string, OutputFile>();
  for (const [file, { classes }] of info) for (const c of classes) classFile.set(c.name, file);
  const superOf = new Map<string, string | null>();
  for (const { classes } of info.values()) for (const c of classes) superOf.set(c.name, c.superClass);
  const isError = (name: string | null, depth = 0): boolean => !!name && depth < 8 && (/^(Error|TypeError|RangeError)$/.test(name) || isError(superOf.get(name) ?? null, depth + 1));
  const isModel = (name: string | null, depth = 0): boolean => !!name && depth < 8 && (name === "Model" || /Model$/.test(name) || isModel(superOf.get(name) ?? null, depth + 1));
  const apiClass = (name: string) => /Api$/.test(name);
  const creates = new Map<string, string[]>();
  for (const { classes } of info.values()) for (const c of classes) creates.set(c.name, c.creates.filter((n) => apiClass(n) && classFile.has(n)));
  const root = [...creates].sort((a, b) => b[1].length - a[1].length)[0];
  const namespaces = root && root[1].length >= 3 ? root[1] : [];
  const owner = new Map<string, string>();
  for (const namespace of namespaces) {
    const queue = [namespace];
    while (queue.length) {
      const name = queue.shift()!;
      if (owner.has(name) && owner.get(name) !== namespace) {
        owner.set(name, "resources");
        continue;
      }
      if (owner.has(name)) continue;
      owner.set(name, namespace);
      for (const child of creates.get(name) ?? []) queue.push(child);
    }
  }
  const size = new Map<string, number>();
  for (const value of owner.values()) size.set(value, (size.get(value) ?? 0) + 1);
  const groups = new Map<string, string[]>();
  const add = (group: string, file: OutputFile) => {
    const path = posix.join(dir, `${group}${ext}`);
    groups.set(path, [...new Set([...(groups.get(path) ?? []), file.path])]);
  };
  for (const [file, { classes }] of info) {
    const main = classes[0];
    if (!main) {
      add("client", file);
      continue;
    }
    if (isError(main.name)) add("errors", file);
    else if (isModel(main.name) && !apiClass(main.name)) add("models", file);
    else if (apiClass(main.name) && main.name !== root?.[0]) {
      const ns = owner.get(main.name);
      const group = ns && ns !== "resources" && (size.get(ns) ?? 0) >= 2 ? ns.replace(/Api$/, "").replace(/^[A-Z]/, (c) => c.toLowerCase()) : "resources";
      add(group, file);
    } else add("client", file);
  }
  for (const [path, members] of groups) if (members.length < 2 && members[0] && posix.basename(members[0]).replace(/\.[^.]+$/, "") !== posix.basename(path).replace(/\.[^.]+$/, "")) groups.delete(path);
  return groups;
}

const MAX_MERGED_LINES = 1000;

export function functionGroups(tree: OutputTree, dir: string): Map<string, string[]> {
  const files = tree.all().filter((f) => posix.dirname(f.path) === dir && /\.m?[jt]s$/.test(f.path) && !f.library && !/^(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^\n]*\);?[ \t]*$/m.test(f.content));
  if (files.length < 2) return new Map();
  const resolve = resolver(tree);
  const paths = new Set(files.map((f) => f.path));
  const links = new Map<string, Set<string>>(files.map((f) => [f.path, new Set<string>()]));
  for (const file of files) {
    for (const match of file.content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(file.path, match[1]!);
      if (!target || !paths.has(target) || target === file.path) continue;
      links.get(file.path)!.add(target);
      links.get(target)!.add(file.path);
    }
  }
  const seen = new Set<string>();
  const groups = new Map<string, string[]>();
  const taken = new Set(tree.all().map((f) => f.path));
  for (const file of files) {
    if (seen.has(file.path)) continue;
    const component: string[] = [];
    const queue = [file.path];
    while (queue.length) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      component.push(path);
      for (const next of links.get(path)!) queue.push(next);
    }
    if (component.length < 2) continue;
    const contents = component.map((path) => tree.all().find((f) => f.path === path)!.content).join("\n");
    if (contents.split("\n").length > MAX_MERGED_LINES) continue;
    const inbound = (path: string) => component.filter((other) => links.get(other)!.has(path)).length;
    const hub = [...component].sort((a, b) => inbound(b) - inbound(a))[0]!;
    const topic = /["'`]\/api\//.test(contents) || /\bfetch\(/.test(contents) ? "api" : /localStorage|sessionStorage/.test(contents) ? "storage" : /document\.cookie/.test(contents) ? "cookies" : posix.basename(hub).replace(/\.[^.]+$/, "");
    const ext = posix.extname(hub);
    let target = posix.join(dir, `${topic}${ext}`);
    for (let n = 2; taken.has(target) && !component.includes(target); n++) target = posix.join(dir, `${topic}${n}${ext}`);
    taken.add(target);
    groups.set(target, component);
  }
  return groups;
}
