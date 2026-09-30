import { posix } from "node:path";
import { relativeImport, type OutputTree } from "../output.ts";
import { t } from "../unpack/ast.ts";
import { load, programPath, save, type Source } from "./exports.ts";

export interface Token {
  kind: "attr" | "text" | "string";
  start: number;
  end: number;
  value: string;
}

export function tokens(text: string, code: boolean): { skeleton: string; list: Token[] } {
  if (!code) return markupTokens(text);
  const list: Token[] = [];
  let skeleton = "";
  let last = 0;
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const at = match.index!;
    list.push({ kind: "string", start: at + 1, end: at + match[0].length - 1, value: JSON.parse(match[0]) });
    skeleton += `${text.slice(last, at)}"\u0000"`;
    last = at + match[0].length;
  }
  skeleton += text.slice(last);
  return { skeleton: skeleton.replace(/\s+/g, " ").replace(/\s*(\/?>)/g, "$1").replace(/<\s+/g, "<"), list };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function markupTokens(text: string): { skeleton: string; list: Token[] } {
  const list: Token[] = [];
  let skeleton = "";
  const tag = /<(\/?)([A-Za-z!][\w:.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let raw: string | null = null;
  const text2 = text;
  const pushText = (from: number, to: number) => {
    const chunk = text2.slice(from, to);
    if (!chunk.trim() || raw || /[{}]/.test(chunk)) {
      skeleton += chunk;
      return;
    }
    const lead = chunk.length - chunk.trimStart().length;
    const tail = chunk.length - chunk.trimEnd().length;
    list.push({ kind: "text", start: from + lead, end: to - tail, value: chunk.trim().replace(/\s+/g, " ") });
    skeleton += "\u0000";
  };
  for (const match of text2.matchAll(tag)) {
    const at = match.index!;
    pushText(last, at);
    const [whole, closing, name, attrs] = match;
    if (raw && !(closing && name!.toLowerCase() === raw)) {
      skeleton += whole;
      last = at + whole.length;
      continue;
    }
    if (closing) raw = null;
    else if (/^(script|style)$/i.test(name!)) raw = name!.toLowerCase();
    let cursor = at + 1 + closing!.length + name!.length;
    skeleton += `<${closing}${name}`;
    for (const attr of attrs!.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const start = at + 1 + closing!.length + name!.length + attr.index! + 1;
      skeleton += text2.slice(cursor, start - 1) + '"\u0000"';
      list.push({ kind: "attr", start, end: start + attr[1]!.length, value: attr[1]! });
      cursor = start + attr[1]!.length + 1;
    }
    skeleton += text2.slice(cursor, at + whole.length);
    last = at + whole.length;
  }
  pushText(last, text2.length);
  return { skeleton: skeleton.replace(/\s+/g, " ").replace(/\s*(\/?>)/g, "$1").replace(/<\s+/g, "<"), list };
}

export function withPrefix(value: string, lang: string): string | null {
  const url = /^(https?:\/\/[^/]+)?(\/.*)?$/.exec(value);
  if (!url || (!url[1] && !url[2])) return null;
  const path = url[2] ?? "/";
  return `${url[1] ?? ""}/${lang}${path === "/" ? "/" : path}`;
}

export function camelWords(text: string, limit: number): string {
  const all = text.normalize("NFKD").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const first = all.findIndex((word) => /^[A-Za-z]/.test(word));
  const words = (first < 0 ? [] : all.slice(first)).slice(0, limit);
  return words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("");
}

export function hintBefore(text: string, start: number, kind: Token["kind"]): string {
  if (kind === "string") return /"([A-Za-z@][\w@]*)"\s*:\s*"$/.exec(text.slice(Math.max(0, start - 64), start))?.[1]?.replace(/^@/, "") ?? "";
  if (kind === "text") return "";
  const tagStart = text.lastIndexOf("<", start);
  const tag = text.slice(tagStart, start);
  const tagEnd = text.indexOf(">", start);
  const whole = text.slice(tagStart, tagEnd < 0 ? text.length : tagEnd);
  const named = /\s(?:property|name|itemprop)="([^"]+)"/.exec(whole)?.[1];
  const attr = /\s([\w:-]+)=\s*"$/.exec(tag)?.[1] ?? "";
  if (named && /^(content|value)$/.test(attr)) return named;
  const tagName = /^<([\w-]+)/.exec(tag)?.[1] ?? "";
  return /^(title|description|alt|aria-label|placeholder|label)$/.test(attr) ? (/^[A-Z]/.test(tagName) ? attr : `${tagName} ${attr}`) : attr;
}


export class Dictionary {
  private readonly bySignature = new Map<string, string>();
  private readonly taken = new Set<string>();
  readonly entries = new Map<string, Record<string, string>>();

  constructor(private readonly fallback: string) {}

  key(values: Map<string, string>, hint: string, decode: boolean): string {
    const signature = JSON.stringify([...values].sort());
    const known = this.bySignature.get(signature);
    if (known) return known;
    const words = camelWords(decodeEntities(values.get(this.fallback) ?? [...values.values()][0] ?? "").replace(/'/g, ""), 3);
    const named = camelWords(hint, 3);
    const stem = (named && !/^(text|name|value|content)$/.test(named) ? named : "") || words || named || "text";
    let key = stem;
    for (let n = 2; this.taken.has(key); n++) key = `${stem}${n}`;
    this.taken.add(key);
    this.bySignature.set(signature, key);
    for (const [lang, value] of values) {
      const table = this.entries.get(lang) ?? {};
      table[key] = decode ? decodeEntities(value) : value;
      this.entries.set(lang, table);
    }
    return key;
  }

  scope(used: Map<string, Set<string>>): Map<string, Map<string, string>> {
    const renames = new Map<string, Map<string, string>>();
    const scoped = new Map<string, Record<string, Record<string, string>>>();
    for (const [namespace, keys] of used) {
      const local = new Map<string, string>();
      const taken = new Set<string>();
      for (const key of [...keys].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
        const stem = key.replace(/\d+$/, "") || key;
        let next = stem;
        for (let n = 2; taken.has(next); n++) next = `${stem}${n}`;
        taken.add(next);
        local.set(key, next);
        for (const [lang, table] of this.entries) {
          if (!(key in table)) continue;
          const target = scoped.get(lang) ?? {};
          (target[namespace] ??= {})[next] = table[key]!;
          scoped.set(lang, target);
        }
      }
      renames.set(namespace, local);
    }
    this.scoped = scoped;
    return renames;
  }

  private scoped: Map<string, Record<string, Record<string, string>>> | null = null;

  write(tree: OutputTree, root: string): Set<string> {
    const langs = new Set<string>([...(this.scoped ?? this.entries).keys()]);
    const islandFile = (lang: string) => tree.all().find((f) => f.path === posix.join(root, "i18n", `${lang}.json`));
    for (const file of tree.all()) {
      const lang = new RegExp(`^${root}/i18n/([a-z]{2}(?:-[A-Za-z]{2,4})?)\\.json$`).exec(file.path)?.[1];
      if (lang) langs.add(lang);
    }
    if (!langs.size) return new Set();
    const merged = new Set<string>();
    for (const lang of [...langs].sort()) {
      const island = islandFile(lang);
      const ui = island ? JSON.parse(island.content) : undefined;
      const pages = (this.scoped ?? this.entries).get(lang) ?? {};
      const content = { ...(ui !== undefined ? { ui } : {}), ...pages };
      if (island) tree.remove(island.path);
      tree.add({ path: posix.join(root, "i18n", `${lang}.json`), content: `${JSON.stringify(content, null, 2)}\n`, kind: "data", renamable: false });
      if (ui !== undefined) merged.add(lang);
    }
    const names = [...langs].sort();
    const id = (lang: string) => (/^[A-Za-z_$][\w$]*$/.test(lang) ? lang : lang.replace(/[^A-Za-z0-9_$]/g, "_"));
    const helper = [...names.map((lang) => `import ${id(lang)} from "./${lang}.json";`), "", `export const messages = { ${names.map((lang) => (id(lang) === lang ? lang : `${JSON.stringify(lang)}: ${id(lang)}`)).join(", ")} };`, ""].join("\n");
    tree.add({ path: posix.join(root, "i18n", "index.ts"), content: helper, kind: "source", renamable: false });
    return merged;
  }
}

const PLACEHOLDER_EXPR = "(t\\.[A-Za-z_$][\\w$]*|lang|`[^`\"]*`)";

export function markupPlaceholders(markup: string): string {
  return markup.replace(new RegExp(`=\\s*"\\{${PLACEHOLDER_EXPR}\\}"`, "g"), "={$1}");
}

export function codePlaceholders(code: string): string {
  return code.replace(new RegExp(`"\\{${PLACEHOLDER_EXPR}\\}"`, "g"), "$1");
}

export function placeholderUses(text: string): { t: boolean; prefix: boolean } {
  return { t: /[{"]t\.[A-Za-z_$]/.test(text), prefix: /\$\{prefix\}/.test(text) };
}

const LOCALE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;

function materialize(node: t.Node | null | undefined, resolve: (name: string) => t.Node | null, used: Set<string>, depth = 0): unknown {
  if (!node || depth > 12) throw new Error("not data");
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isTemplateLiteral(node) && !node.expressions.length) return node.quasis.map((q) => q.value.cooked ?? "").join("");
  if (t.isArrayExpression(node)) return node.elements.map((element) => materialize(element, resolve, used, depth + 1));
  if (t.isIdentifier(node)) {
    used.add(node.name);
    return materialize(resolve(node.name), resolve, used, depth + 1);
  }
  if (!t.isObjectExpression(node)) throw new Error("not data");
  const out: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (t.isSpreadElement(prop)) {
      const value = materialize(prop.argument, resolve, used, depth + 1);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not data");
      Object.assign(out, value);
      continue;
    }
    if (!t.isObjectProperty(prop) || prop.computed) throw new Error("not data");
    const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) || t.isNumericLiteral(prop.key) ? String(prop.key.value) : null;
    if (key === null) throw new Error("not data");
    out[key] = materialize(prop.value, resolve, used, depth + 1);
  }
  return out;
}

export function extractLocaleDictionaries(tree: OutputTree, root: string): number {
  let count = 0;
  const written = new Map<string, string>();
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || !file.path.startsWith(`${root}/`) || !/\.(m?[jt]sx?|vue)$/.test(file.path) || file.path.startsWith(`${root}/i18n/`)) continue;
    let source: Source | null;
    try {
      source = load(file);
    } catch {
      continue;
    }
    if (!source) continue;
    const program = programPath(source.ast);
    const body = source.ast.program.body;
    const resolve = (name: string) => {
      const binding = program.scope.getBinding(name);
      return binding?.path.isVariableDeclarator() && binding.scope === program.scope && binding.constantViolations.length === 0 ? binding.path.node.init ?? null : null;
    };
    let changed = false;
    for (const stmt of body) {
      if (!t.isVariableDeclaration(stmt)) continue;
      for (const declarator of stmt.declarations) {
        const init = declarator.init;
        if (!t.isIdentifier(declarator.id) || !t.isObjectExpression(init) || init.properties.length < 2) continue;
        const entries = init.properties.map((prop) => (t.isObjectProperty(prop) && !prop.computed ? { key: t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : "", value: prop.value } : null));
        if (entries.some((entry) => !entry || !LOCALE.test(entry.key) || !(t.isIdentifier(entry.value) || t.isObjectExpression(entry.value)))) continue;
        const used = new Set<string>();
        let data: Array<[string, unknown]>;
        try {
          data = entries.map((entry) => [entry!.key, materialize(entry!.value, resolve, used)] as [string, unknown]);
        } catch {
          continue;
        }
        if (JSON.stringify(data).length < 400 || !data.every(([, value]) => value && typeof value === "object" && !Array.isArray(value))) continue;
        const specifiers: t.ObjectProperty[] = [];
        const imports: t.ImportDeclaration[] = [];
        for (const [lang, value] of data) {
          let content = `${JSON.stringify(value, null, 2)}\n`;
          let path = posix.join(root, "i18n", `${lang}.json`);
          const existing = written.get(path) ?? tree.all().find((f) => f.path === path)?.content;
          if (existing !== undefined && existing !== content) {
            let current: Record<string, unknown> | null = null;
            try {
              current = JSON.parse(existing) as Record<string, unknown>;
            } catch {
              current = null;
            }
            const incoming = value as Record<string, unknown>;
            const clash = !current || typeof current !== "object" || Object.keys(incoming).some((key) => key in current! && JSON.stringify(current![key]) !== JSON.stringify(incoming[key]));
            if (!clash) content = `${JSON.stringify({ ...current, ...incoming }, null, 2)}\n`;
            else for (let n = 2; (written.get(path) ?? tree.all().find((f) => f.path === path)?.content) !== undefined; n++) path = posix.join(root, "i18n", `${lang}-${n}.json`);
          }
          if (written.get(path) !== content) {
            tree.remove(path);
            tree.add({ path, content, kind: "data", renamable: false });
            written.set(path, content);
          }
          let local = lang.replace(/[^A-Za-z0-9_$]/g, "_");
          for (let n = 2; program.scope.hasBinding(local) || specifiers.some((s) => t.isIdentifier(s.value, { name: local })); n++) local = `${lang.replace(/[^A-Za-z0-9_$]/g, "_")}${n}`;
          imports.push(t.importDeclaration([t.importDefaultSpecifier(t.identifier(local))], t.stringLiteral(relativeImport(file.path, path))));
          specifiers.push(t.objectProperty(/^[A-Za-z_$][\w$]*$/.test(lang) ? t.identifier(lang) : t.stringLiteral(lang), t.identifier(local), false, local === lang));
        }
        const index = posix.join(root, "i18n", "index.ts");
        const shared = tree.all().some((f) => f.path === index) && imports.every((decl) => /\/i18n\/[a-z]{2}(?:-[A-Za-z]{2,4})?\.json$/.test(decl.source.value)) && (declarator.id.name === "messages" || !program.scope.hasBinding("messages"));
        const lastImport = body.reduce((at, st, i) => (t.isImportDeclaration(st) ? i : at), -1);
        if (shared) {
          const local = declarator.id.name;
          if (local !== "messages") program.scope.rename(local, "messages");
          const holder = body.find((st): st is t.VariableDeclaration => t.isVariableDeclaration(st) && st.declarations.includes(declarator));
          if (holder && holder.declarations.length === 1) body.splice(body.indexOf(holder), 1);
          else if (holder) holder.declarations = holder.declarations.filter((d) => d !== declarator);
          body.splice(lastImport + 1, 0, t.importDeclaration([t.importSpecifier(t.identifier("messages"), t.identifier("messages"))], t.stringLiteral(relativeImport(file.path, index).replace(/\/index\.ts$/, ""))));
        } else {
          declarator.init = t.objectExpression(specifiers);
          body.splice(lastImport + 1, 0, ...imports);
        }
        program.scope.crawl();
        for (let pruned = true; pruned; ) {
          pruned = false;
          for (const name of used) {
            const binding = program.scope.getBinding(name);
            if (!binding || binding.referenced || !binding.path.isVariableDeclarator()) continue;
            const holder = binding.path.parentPath;
            if (holder?.isVariableDeclaration() && holder.node.declarations.length === 1) holder.remove();
            else binding.path.remove();
            program.scope.crawl();
            pruned = true;
          }
        }
        if (!shared && /^([A-Za-z]{1,2}|[a-z]\d+)$/.test(declarator.id.name) && !program.scope.hasBinding("messages")) program.scope.rename(declarator.id.name, "messages");
        changed = true;
        count++;
      }
    }
    if (changed) save(source);
  }
  return count;
}
