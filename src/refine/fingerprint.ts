import type { NodePath } from "@babel/traverse";
import { load, type Database } from "@reekeer/sigdb";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { literalKey, parseProgram, t, traverse } from "../unpack/ast.ts";

export interface FunctionPrint {
  name: string;
  features: string[];
  links?: string[];
}

export interface ModulePrint {
  features: string[];
  exports: FunctionPrint[];
  locals: FunctionPrint[];
  known: string[];
  singleUse?: string[];
  calls?: Record<string, string[]>;
  shortLocals?: FunctionPrint[];
}

export interface LibraryFile {
  package: string;
  version: string;
  file: string;
  entry: boolean;
  specifier?: string;
  features: string[];
  exports: FunctionPrint[];
  names?: string[];
  locals?: FunctionPrint[];
}

export interface FingerprintDb {
  version: number;
  files: LibraryFile[];
  shared?: (tokens: readonly string[]) => Map<LibraryFile, number>;
  components?: Map<string, LibraryComponent>;
}

export const FINGERPRINTS_PATH = fileURLToPath(new URL("../../fingerprints.sigdb", import.meta.url));
export const FINGERPRINT_SCHEMA = 1;
export const FUNCTION_INDEX = "functions";
export const COMPONENT_INDEX = "components";
export const COMPONENT_GROUP = "names";

export interface LibraryComponent {
  package: string;
  name: string;
  export: string;
  global: boolean;
}
export const FILE_GROUPS = { features: {} };
export const FUNCTION_GROUPS = { features: {}, links: {} };

export function fileKey(file: Pick<LibraryFile, "package" | "version" | "file">): string {
  return `${file.package}@${file.version}/${file.file}`;
}

interface FileData {
  package: string;
  version: string;
  file: string;
  entry: boolean;
  specifier?: string;
  names?: string[];
}

interface FunctionData {
  name: string;
  file: string;
  kind: "export" | "local";
}

function patternsByItem(index: ReturnType<Database["index"]>): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  for (const group of index.groups.keys()) out.set(group, index.items.map(() => []));
  for (let id = 0; id < index.patternTotal; id++) {
    const pattern = index.pattern(id);
    const lists = out.get(pattern.group)!;
    for (const item of pattern.itemIds) lists[item]!.push(pattern.text);
  }
  return out;
}

export function fingerprintsFromSigdb(sigdb: Database): FingerprintDb {
  const main = sigdb.index();
  const fileFeatures = patternsByItem(main).get("features")!;
  const files: LibraryFile[] = main.items.map((item, i) => {
    const data = item.data as FileData;
    return {
      package: data.package,
      version: data.version,
      file: data.file,
      entry: data.entry,
      ...(data.specifier ? { specifier: data.specifier } : {}),
      features: fileFeatures[i]!.sort(),
      exports: [],
      ...(data.names ? { names: data.names } : {}),
      locals: [],
    };
  });
  const byKey = new Map(files.map((f) => [fileKey(f), f]));
  if (sigdb.indexNames.includes(FUNCTION_INDEX)) {
    const functions = sigdb.index(FUNCTION_INDEX);
    const patterns = patternsByItem(functions);
    const features = patterns.get("features")!;
    const links = patterns.get("links")!;
    functions.items.forEach((item, i) => {
      const data = item.data as FunctionData;
      const owner = byKey.get(data.file);
      if (!owner) return;
      const print: FunctionPrint = links[i]!.length ? { name: data.name, features: features[i]!.sort(), links: links[i]!.sort() } : { name: data.name, features: features[i]!.sort() };
      (data.kind === "export" ? owner.exports : owner.locals!).push(print);
    });
  }
  const components = new Map<string, LibraryComponent>();
  if (sigdb.indexNames.includes(COMPONENT_INDEX)) {
    for (const item of sigdb.index(COMPONENT_INDEX).items) {
      const data = item.data as LibraryComponent;
      if (!components.has(data.name)) components.set(data.name, data);
    }
  }
  return {
    version: Number(sigdb.metadata.schema ?? FINGERPRINT_SCHEMA),
    files,
    components,
    shared: (tokens) => {
      const out = new Map<LibraryFile, number>();
      for (const [itemId, hits] of main.matchTokens("features", tokens)) out.set(files[itemId]!, hits);
      return out;
    },
  };
}

export interface Identification {
  package: string;
  file: string;
  entry: boolean;
  specifier?: string;
  confidence: number;
}

const TRIVIAL_NUMBERS = new Set(["0", "1", "-1", "2"]);
const MAX_STRING = 60;
const MIN_MODULE_FEATURES = 8;
const MODULE_THRESHOLD = 0.6;
const MIN_FUNCTION_FEATURES = 3;
const FUNCTION_THRESHOLD = 0.8;

function isImportBinding(path: NodePath, name: string): string | null {
  const binding = path.scope.getBinding(name);
  if (!binding) return null;
  const node = binding.path.node;
  if (t.isImportSpecifier(node)) return t.isIdentifier(node.imported) ? node.imported.name : node.imported.value;
  if (t.isImportDefaultSpecifier(node)) return "default";
  if (t.isImportNamespaceSpecifier(node)) return "*";
  if (t.isVariableDeclarator(node) && t.isCallExpression(node.init) && !node.init.arguments.length && t.isIdentifier(node.init.callee) && (/^require[A-Z]/.test(node.init.callee.name) || (t.isIdentifier(node.id) && /^(React|ReactDOM\w*|jsxRuntime|Scheduler)$/.test(node.id.name))) && !binding.constantViolations.length) return "*";
  return null;
}

function collect(root: NodePath, into: Set<string>, skipIifes = false): void {
  const add = (feature: string) => into.add(feature);
  root.traverse({
    Function(path) {
      if (skipIifes && path.parentPath.isCallExpression() && path.parentPath.node.callee === path.node) path.skip();
    },
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      const name = path.node.name;
      const binding = path.scope.getBinding(name);
      if (binding) {
        const value = binding.path.isVariableDeclarator() && binding.scope.path.isProgram() && !binding.constantViolations.length ? binding.path.node.init : null;
        if (t.isNumericLiteral(value) && !TRIVIAL_NUMBERS.has(String(value.value))) add(`N:${value.value}`);
        return;
      }
      if (!isImportBinding(path, name) && !path.scope.hasBinding(name, true) && name !== "undefined") add(`G:${name}`);
    },
    MemberExpression(path) {
      if (t.isIdentifier(path.node.object) && isImportBinding(path, path.node.object.name) === "*") return;
      const prop = path.node.computed ? (t.isStringLiteral(path.node.property) ? path.node.property.value : null) : literalKey(path.node.property);
      if (prop) add(`P:${prop}`);
    },
    OptionalMemberExpression(path) {
      const prop = path.node.computed ? null : literalKey(path.node.property);
      if (prop) add(`P:${prop}`);
    },
    StringLiteral(path) {
      if (path.parentPath.isImportDeclaration() || path.parentPath.isExportAllDeclaration() || path.parentPath.isExportNamedDeclaration()) return;
      if (path.node.value.length >= 2) add(`S:${path.node.value.slice(0, MAX_STRING)}`);
    },
    TemplateElement(path) {
      const value = path.node.value.cooked ?? "";
      if (value.trim().length >= 2) add(`S:${value.slice(0, MAX_STRING)}`);
    },
    NumericLiteral(path) {
      const value = String(path.node.value);
      if (!TRIVIAL_NUMBERS.has(value)) add(`N:${value}`);
    },
    ObjectProperty(path) {
      const key = path.node.computed ? null : literalKey(path.node.key);
      if (key && !path.parentPath.isObjectPattern()) add(`K:${key}`);
    },
    JSXElement(path) {
      const { openingElement, children } = path.node;
      const name = openingElement.name;
      if (t.isJSXIdentifier(name) && /^[a-z]/.test(name.name)) add(`S:${name.name}`);
      else if (t.isJSXMemberExpression(name)) add(`P:${name.property.name}`);
      const content = children.filter((c) => !(t.isJSXText(c) && !c.value.trim()));
      add(content.length > 1 ? "P:jsxs" : "P:jsx");
      if (content.length) add("K:children");
      for (const attr of openingElement.attributes) {
        if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name !== "key") add(`K:${attr.name.name}`);
        if (t.isJSXAttribute(attr) && t.isStringLiteral(attr.value) && attr.value.value.length >= 2) add(`S:${attr.value.value.slice(0, MAX_STRING)}`);
      }
      for (const child of content) if (t.isJSXText(child) && child.value.trim().length >= 2) add(`S:${child.value.trim().slice(0, MAX_STRING)}`);
    },
    JSXFragment(path) {
      add(path.node.children.filter((c) => !(t.isJSXText(c) && !c.value.trim())).length > 1 ? "P:jsxs" : "P:jsx");
      add("P:Fragment");
      add("K:children");
    },
  });
}

type Printable = NodePath<t.Function> | NodePath<t.ObjectExpression> | NodePath<t.CallExpression>;

function isMarkerValue(path: NodePath): boolean {
  if (path.isObjectExpression()) return path.node.properties.some((p) => t.isObjectMethod(p) || (t.isObjectProperty(p) && (t.isFunctionExpression(p.value) || t.isArrowFunctionExpression(p.value))));
  if (path.isCallExpression()) {
    const callee = path.node.callee;
    return t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: "Symbol" }) && literalKey(callee.property) === "for" && t.isStringLiteral(path.node.arguments[0]);
  }
  return false;
}

function functionOf(path: NodePath | null | undefined): Printable | null {
  if (!path) return null;
  if (path.isFunctionDeclaration() || path.isFunctionExpression() || path.isArrowFunctionExpression()) return path as NodePath<t.Function>;
  if (path.isVariableDeclarator()) return functionOf(path.get("init") as NodePath);
  if (isMarkerValue(path)) return path as NodePath<t.ObjectExpression> | NodePath<t.CallExpression>;
  if (path.isCallExpression() && path.node.arguments.length >= 1) {
    const callee = path.node.callee;
    const name = t.isMemberExpression(callee) && !callee.computed ? literalKey(callee.property) : t.isIdentifier(callee) ? callee.name : null;
    if (name && /^(forwardRef|memo)$/.test(name)) {
      const inner = path.get("arguments.0") as NodePath;
      if (inner.isFunctionExpression() || inner.isArrowFunctionExpression()) return inner as NodePath<t.Function>;
    }
  }
  return null;
}

function referenceName(path: NodePath<t.Identifier>): string | null {
  const name = path.node.name;
  const imported = isImportBinding(path, name);
  if (imported === "*") {
    const parent = path.parentPath;
    return parent?.isMemberExpression() && parent.node.object === path.node && !parent.node.computed ? literalKey(parent.node.property) : null;
  }
  if (imported) return imported === "default" ? null : imported;
  const binding = path.scope.getBinding(name);
  return binding?.scope.path.isProgram() && name.length > 2 ? name : null;
}

function functionLinks(fn: Printable, own: string): string[] {
  const links = new Set<string>();
  fn.traverse({
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      const name = referenceName(path);
      if (name && name !== own) links.add(name);
    },
  });
  return [...links].sort();
}

function functionFeatures(fn: Printable): string[] {
  const set = new Set<string>([fn.isFunction() ? `A:${fn.node.params.length}` : "A:value"]);
  if (fn.isCallExpression()) {
    set.add("G:Symbol");
    set.add("P:for");
    set.add(`S:${(fn.node.arguments[0] as t.StringLiteral).value}`);
  } else collect(fn, set);
  return [...set].sort();
}

function valuePrint(path: NodePath | null | undefined): string[] | null {
  const init = path?.isVariableDeclarator() ? path.node.init : null;
  if (!(t.isCallExpression(init) || t.isNewExpression(init))) return null;
  const strings = init.arguments.filter((a): a is t.StringLiteral => t.isStringLiteral(a) && a.value.length >= 2).map((a) => `S:${a.value.slice(0, MAX_STRING)}`);
  if (strings.length) return ["A:call", ...strings].sort();
  const fnIndex = init.arguments.findIndex((a) => t.isFunctionExpression(a) || t.isArrowFunctionExpression(a));
  if (fnIndex < 0) return null;
  const set = new Set<string>(["A:call"]);
  collect((path as NodePath<t.VariableDeclarator>).get("init").get(`arguments.${fnIndex}`) as NodePath, set);
  return set.size >= 4 ? [...set].sort() : null;
}

const PRINTS = new Map<string, ModulePrint>();
const MAX_PRINTED_CHARS = 64 * 1024 * 1024;
let printedChars = 0;

export function printModule(code: string): ModulePrint {
  const cached = PRINTS.get(code);
  if (cached) return cached;
  const print = computePrint(code);
  PRINTS.set(code, print);
  printedChars += code.length;
  for (const key of PRINTS.keys()) {
    if (printedChars <= MAX_PRINTED_CHARS) break;
    PRINTS.delete(key);
    printedChars -= key.length;
  }
  return print;
}

function computePrint(code: string): ModulePrint {
  const ast = parseProgram(code);
  const features = new Set<string>();
  const exports: FunctionPrint[] = [];
  const locals: FunctionPrint[] = [];
  const known = new Set<string>();
  const singleUse: string[] = [];
  const calls: Record<string, string[]> = {};
  const shortLocals: FunctionPrint[] = [];
  traverse(ast, {
    Program(program) {
      program.traverse({
        Identifier(path) {
          if (!path.isReferencedIdentifier()) return;
          const name = referenceName(path);
          if (!name) return;
          known.add(name);
          if (isImportBinding(path, path.node.name)) features.add(`P:${name}`);
        },
      });
      for (const name of Object.keys(program.scope.bindings)) if (name.length > 2) known.add(name);
      const withLinks = (name: string, fn: Printable, local: string): FunctionPrint => {
        const links = functionLinks(fn, local);
        return links.length ? { name, features: functionFeatures(fn), links } : { name, features: functionFeatures(fn) };
      };
      collect(program, features);
      for (const [name, binding] of Object.entries(program.scope.bindings)) {
        const printable = functionOf(binding.path);
        const external = binding.referencePaths.filter((ref) => !printable || !ref.findParent((p) => p.node === printable.node)).length;
        if (external === 1 && printable) singleUse.push(name);
        if (printable?.isFunction()) {
          const callees = new Set<string>();
          printable.traverse({
            Identifier(path) {
              if (!path.isReferencedIdentifier() || path.node.name === name) return;
              const target = path.scope.getBinding(path.node.name);
              if (target?.scope.path.isProgram() && functionOf(target.path)) callees.add(path.node.name);
            },
          });
          if (callees.size) calls[name] = [...callees];
          if (name.length <= 2) shortLocals.push({ name, features: functionFeatures(printable) });
        }
        const fn = functionOf(binding.path);
        if (fn && !binding.path.parentPath?.isExportNamedDeclaration() && !binding.path.parentPath?.parentPath?.isExportNamedDeclaration()) {
          locals.push(withLinks(name, fn, name));
        }
      }
      const exported = (name: string, local: string) => {
        const path = program.scope.getBinding(local)?.path;
        const fn = functionOf(path);
        if (fn) exports.push(withLinks(name, fn, local));
        else {
          const value = valuePrint(path);
          if (value) exports.push({ name, features: value });
        }
      };
      for (const stmt of program.get("body")) {
        if (stmt.isExportNamedDeclaration()) {
          const decl = stmt.get("declaration");
          if (decl.isFunctionDeclaration() && decl.node.id) exported(decl.node.id.name, decl.node.id.name);
          else if (decl.isVariableDeclaration()) {
            for (const d of decl.get("declarations")) if (t.isIdentifier(d.node.id)) exported(d.node.id.name, d.node.id.name);
          }
          for (const spec of stmt.node.specifiers) {
            if (t.isExportSpecifier(spec) && !stmt.node.source) exported(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value, spec.local.name);
          }
        } else if (stmt.isExportDefaultDeclaration()) {
          const decl = stmt.get("declaration");
          const fn = functionOf(decl as NodePath);
          if (fn) exports.push(withLinks("default", fn, "default"));
          else if (decl.isIdentifier()) exported("default", decl.node.name);
        }
      }
      program.stop();
    },
  });
  return { features: [...features].sort(), exports, locals, known: [...known], singleUse, calls, shortLocals };
}

const CONCAT_MIN_FEATURES = 30;
const CONCAT_CONTAINMENT = 0.8;
const CONCAT_COVERAGE = 0.6;

export function identifyConcatenated(print: ModulePrint, db: FingerprintDb): Identification | null {
  const own = distinctive(print.features);
  if (own.length < CONCAT_MIN_FEATURES * 2) return null;
  const mine = new Set(own);
  const parts = [...candidates(print, db)].filter((file) => {
    const theirs = fileDistinctive(file).list;
    return theirs.length >= CONCAT_MIN_FEATURES && containment(theirs, mine) >= CONCAT_CONTAINMENT;
  });
  if (parts.length < 2) return null;
  const covered = new Set<string>();
  for (const file of parts) for (const f of fileDistinctive(file).list) if (mine.has(f)) covered.add(f);
  const coverage = covered.size / own.length;
  if (coverage < CONCAT_COVERAGE) return null;
  const entry = parts.filter((f) => f.specifier).sort((a, b) => b.features.length - a.features.length)[0] ?? parts.sort((a, b) => b.features.length - a.features.length)[0]!;
  return { package: entry.package, file: entry.file, entry: entry.entry, ...(entry.specifier ? { specifier: entry.specifier } : {}), confidence: Number(coverage.toFixed(3)) };
}

const GENERIC_EXPORT = /^(default|__esModule|[\w$]{1,2})$/;

export function exportNames(code: string): string[] {
  const names = new Set<string>();
  for (const stmt of parseProgram(code).program.body) {
    if (t.isExportDefaultDeclaration(stmt)) names.add("default");
    if (!t.isExportNamedDeclaration(stmt)) continue;
    const decl = stmt.declaration;
    if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) names.add(decl.id.name);
    if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) if (t.isIdentifier(d.id)) names.add(d.id.name);
    for (const spec of stmt.specifiers) {
      if (t.isExportSpecifier(spec)) names.add(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value);
    }
  }
  return [...names].sort();
}

export function exportValueFeatures(code: string, skipIifes = false): Map<string, string[]> {
  const out = new Map<string, string[]>();
  traverse(parseProgram(code), {
    Program(program) {
      const record = (name: string, local: string) => {
        const binding = program.scope.getBinding(local);
        const target = binding?.path.isVariableDeclarator() ? binding.path.get("init") : binding?.path;
        if (!target?.node) return;
        const set = new Set<string>();
        collect(target as NodePath, set, skipIifes);
        out.set(name, [...set]);
      };
      for (const stmt of program.get("body")) {
        if (stmt.isExportNamedDeclaration()) {
          const decl = stmt.node.declaration;
          if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) record(decl.id.name, decl.id.name);
          if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) if (t.isIdentifier(d.id)) record(d.id.name, d.id.name);
          if (!stmt.node.source) for (const spec of stmt.node.specifiers) if (t.isExportSpecifier(spec)) record(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value, spec.local.name);
        } else if (stmt.isExportDefaultDeclaration()) {
          const decl = stmt.get("declaration");
          if ((decl.isFunctionDeclaration() || decl.isClassDeclaration()) && decl.node.id) record("default", decl.node.id.name);
          else if (decl.isIdentifier()) record("default", decl.node.name);
          else if (decl.isFunctionDeclaration() || decl.isClassDeclaration() || decl.isExpression()) {
            const set = new Set<string>();
            collect(decl as NodePath, set, skipIifes);
            out.set("default", [...set]);
          }
        }
      }
      program.stop();
    },
  });
  return out;
}

export function packageFeatureSet(db: FingerprintDb, packages: Set<string>): Set<string> {
  return new Set(db.files.filter((f) => packages.has(f.package)).flatMap((f) => f.features));
}

export function hasForeignExport(code: string, known: Set<string>): boolean {
  for (const features of exportValueFeatures(code, true).values()) {
    const specific = features.filter((f) => f.startsWith("K:") || f.startsWith("S:"));
    const foreign = specific.filter((f) => !known.has(f));
    if ((foreign.length >= 2 && foreign.length * 2 >= specific.length) || (foreign.length >= 4 && foreign.length * 3 >= specific.length)) return true;
  }
  return false;
}

export function inlinedVariants(print: ModulePrint): FunctionPrint[] {
  const single = new Set(print.singleUse ?? []);
  const byName = new Map([...(print.shortLocals ?? []), ...print.locals, ...print.exports].map((fn) => [fn.name, fn]));
  const out: FunctionPrint[] = [];
  const exported = new Set(print.exports.map((e) => e.name));
  for (const fn of print.exports) {
    const inlined = (print.calls?.[fn.name] ?? fn.links ?? []).filter((l) => single.has(l) && !exported.has(l) && byName.get(l) && byName.get(l) !== fn);
    if (!inlined.length) continue;
    const features = new Set(fn.features);
    const links = new Set((fn.links ?? []).filter((l) => !inlined.includes(l)));
    for (const name of inlined) {
      const callee = byName.get(name)!;
      for (const f of callee.features) if (!f.startsWith("A:")) features.add(f);
      for (const l of callee.links ?? []) if (l !== fn.name) links.add(l);
    }
    out.push(links.size ? { name: fn.name, features: [...features].sort(), links: [...links].sort() } : { name: fn.name, features: [...features].sort() });
  }
  return out;
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  let shared = 0;
  for (const x of b) if (set.has(x)) shared++;
  return shared / (a.length + b.length - shared);
}

function containment(of: readonly string[], within: Set<string>): number {
  if (!of.length) return 0;
  let shared = 0;
  for (const x of of) if (within.has(x)) shared++;
  return shared / of.length;
}

function distinctive(features: readonly string[]): string[] {
  return features.filter((f) => !f.startsWith("A:") && !/^P:(length|call|apply|prototype|push|then|default|exports)$/.test(f));
}

const DISTINCTIVE = new WeakMap<LibraryFile, { list: string[]; set: Set<string> }>();

function fileDistinctive(file: LibraryFile): { list: string[]; set: Set<string> } {
  let found = DISTINCTIVE.get(file);
  if (!found) {
    const list = distinctive(file.features);
    DISTINCTIVE.set(file, (found = { list, set: new Set(list) }));
  }
  return found;
}

function candidates(print: ModulePrint, db: FingerprintDb): Iterable<LibraryFile> {
  return db.shared ? db.shared(distinctive(print.features)).keys() : db.files;
}

export function identifyModule(print: ModulePrint, db: FingerprintDb, names: string[] = []): Identification | null {
  const mine = new Set(print.features);
  const own = names.filter((n) => !GENERIC_EXPORT.test(n));
  const ownDistinct = distinctive(print.features);
  let best: Identification | null = null;
  for (const file of candidates(print, db)) {
    if (own.length && file.names?.length && !file.names.some((n) => own.includes(n))) continue;
    const theirs = fileDistinctive(file);
    if (theirs.list.length < MIN_MODULE_FEATURES) continue;
    const score = containment(theirs.list, mine) * Math.min(1, containment(ownDistinct, theirs.set) * 2);
    if (score >= MODULE_THRESHOLD && (!best || score > best.confidence)) {
      best = { package: file.package, file: file.file, entry: file.entry, ...(file.specifier ? { specifier: file.specifier } : {}), confidence: Number(score.toFixed(3)) };
    }
  }
  return best;
}

const NAME_SUPPORT = 0.3;

export function identifyByNames(names: string[], print: ModulePrint, db: FingerprintDb, packages: Set<string>): Identification | null {
  const distinct = names.filter((n) => !GENERIC_EXPORT.test(n));
  if (!distinct.length || distinct.join("").length < 5) return null;
  const mine = new Set(print.features);
  const candidates = db.files.filter((f) => packages.has(f.package) && f.names && names.every((n) => f.names!.includes(n)));
  if (!candidates.length || new Set(candidates.map((c) => c.package)).size > 1) return null;
  const scored = candidates
    .map((file) => {
      const theirs = fileDistinctive(file).list;
      const support = theirs.length ? containment(theirs, mine) : 1;
      const own = distinctive(print.features);
      const covered = own.length ? containment(own, new Set(theirs)) : 1;
      return { file, support: Math.max(support, covered >= 0.8 ? covered : 0), score: support + distinct.length / file.names!.length };
    })
    .sort((a, b) => b.score - a.score || a.file.file.length - b.file.file.length);
  const best = scored[0];
  if (!best) return null;
  if (best.support < NAME_SUPPORT && distinctive(best.file.features).length >= 4) return null;
  const file = best.file;
  return { package: file.package, file: file.file, entry: file.entry, ...(file.specifier ? { specifier: file.specifier } : {}), confidence: Number(Math.max(0.5, best.support).toFixed(3)) };
}

const MIN_SMALL_FEATURES = 4;
const SMALL_THRESHOLD = 0.75;

export function identifySmall(print: ModulePrint, db: FingerprintDb, packages: Set<string>): Identification | null {
  const own = distinctive(print.features);
  if (own.length < MIN_SMALL_FEATURES) return null;
  const mine = new Set(own);
  let best: Identification | null = null;
  let tie = false;
  for (const file of candidates(print, db)) {
    if (!packages.has(file.package)) continue;
    const theirs = fileDistinctive(file).list;
    if (theirs.length < MIN_SMALL_FEATURES || theirs.length >= MIN_MODULE_FEATURES * 2) continue;
    const score = Math.min(containment(theirs, mine), containment(own, new Set(theirs)));
    if (score < SMALL_THRESHOLD) continue;
    if (best && Math.abs(score - best.confidence) < 1e-3) tie = true;
    if (!best || score > best.confidence + 1e-3) {
      best = { package: file.package, file: file.file, entry: file.entry, ...(file.specifier ? { specifier: file.specifier } : {}), confidence: Number(score.toFixed(3)) };
      tie = false;
    }
  }
  return tie ? null : best;
}

export function matchFunctions(mine: FunctionPrint[], candidates: FunctionPrint[]): Map<string, { name: string; confidence: number }> {
  const out = new Map<string, { name: string; confidence: number }>();
  for (const fn of mine) {
    if (fn.features.length < MIN_FUNCTION_FEATURES && !fn.features.includes("A:call")) continue;
    const byName = new Map<string, number>();
    for (const candidate of candidates) {
      if (candidate.name === fn.name) continue;
      const score = jaccard(fn.features, candidate.features);
      if (score > (byName.get(candidate.name) ?? 0)) byName.set(candidate.name, score);
    }
    let ranked = [...byName].sort((a, b) => b[1] - a[1]);
    const tied = ranked.filter((r) => r[1] === ranked[0]?.[1]);
    const named = tied.filter((r) => fn.features.includes(`S:${r[0]}`));
    if (tied.length > 1 && named.length === 1) ranked = [named[0]!, ...ranked.filter((r) => r !== named[0] && r[1] < named[0]![1])];
    const best = { name: ranked[0]?.[0] ?? "", score: ranked[0]?.[1] ?? 0 };
    const second = ranked[1]?.[1] ?? 0;
    if (best.score >= FUNCTION_THRESHOLD && best.score - second >= 0.1) out.set(fn.name, { name: best.name, confidence: Number(best.score.toFixed(3)) });
  }
  return out;
}

const IDIOM_SOURCES = [
  "export function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }",
  "export function clamp2(value, min, max) { return Math.max(min, Math.min(value, max)); }",
  "export function debounce(fn, wait) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; }",
  "export function throttle(fn, wait) { let last = 0; return (...args) => { const now = Date.now(); if (now - last >= wait) { last = now; fn(...args); } }; }",
  "export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }",
  "export function noop() {}",
  "export function uuid() { return crypto.randomUUID(); }",
  "export function capitalize(text) { return text.charAt(0).toUpperCase() + text.slice(1); }",
  "export function formatBytes(bytes) { const units = [\"B\", \"KB\", \"MB\", \"GB\"]; let i = 0; while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; } return `${bytes.toFixed(1)} ${units[i]}`; }",
  "export function range(start, end) { return Array.from({ length: end - start }, (_, i) => start + i); }",
  "export function chunk(items, size) { const out = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }",
  "export function isObject(value) { return value !== null && typeof value === \"object\"; }",
  "export function truncate(text, max) { return text.length > max ? text.slice(0, max - 1) + \"…\" : text; }",
  "export function truncate2(text, max) { return text.length > max ? text.slice(0, max) + \"...\" : text; }",
];

let idioms: FunctionPrint[] | null = null;

export function idiomPrints(): FunctionPrint[] {
  idioms ??= IDIOM_SOURCES.flatMap((source) => printModule(source).exports).map((fn) => ({ ...fn, name: fn.name.replace(/\d+$/, "") }));
  return idioms;
}

let database: Promise<FingerprintDb> | null = null;

export function loadFingerprints(path = FINGERPRINTS_PATH): Promise<FingerprintDb> {
  database ??= Promise.resolve().then(() => (existsSync(path) ? fingerprintsFromSigdb(load(path)) : { version: 0, files: [] }));
  return database;
}

export function libraryExports(db: FingerprintDb, id: Identification): FunctionPrint[] {
  return db.files.find((f) => f.package === id.package && f.file === id.file)?.exports ?? [];
}

const RARE_FEATURE = 40;

export interface FunctionIndex {
  functions: Array<FunctionPrint & { package: string }>;
  byFeature: Map<string, number[]>;
}

export function packageFamily(pkg: string): (candidate: string) => boolean {
  const scope = pkg === "vue" ? "@vue/" : `@${pkg}/`;
  return (candidate) => candidate === pkg || candidate.startsWith(`${pkg}/`) || candidate.startsWith(scope);
}

const FUNCTION_INDEXES = new WeakMap<FingerprintDb, FunctionIndex>();

export function buildFunctionIndex(db: FingerprintDb, accept?: (pkg: string) => boolean): FunctionIndex {
  if (!accept) {
    const cached = FUNCTION_INDEXES.get(db);
    if (cached) return cached;
    const index = buildIndex(db, () => true);
    FUNCTION_INDEXES.set(db, index);
    return index;
  }
  return buildIndex(db, accept);
}

function buildIndex(db: FingerprintDb, accept: (pkg: string) => boolean): FunctionIndex {
  const functions = db.files.filter((file) => accept(file.package)).flatMap((file) =>
    [...file.exports, ...(file.locals ?? []).filter((fn) => fn.name.length > 2)]
      .filter((fn) => fn.name !== "default" && fn.features.length + (fn.links?.length ?? 0) >= MIN_FUNCTION_FEATURES)
      .map((fn) => ({ ...fn, package: file.package })),
  );
  const byFeature = new Map<string, number[]>();
  functions.forEach((fn, index) => {
    const keys = [...fn.features.filter((f) => !f.startsWith("A:")), ...(fn.links ?? []).map((l) => `L:${l}`)];
    for (const feature of keys) {
      const list = byFeature.get(feature);
      if (list) list.push(index);
      else byFeature.set(feature, [index]);
    }
  });
  return { functions, byFeature };
}

const READABLE_LINKS = { has: (name: string) => name.length > 2 && !/^_?(Component|Context)\d+$/.test(name) };

function withLinkFeatures(fn: FunctionPrint, known: { has(name: string): boolean } | null): string[] {
  const links = (fn.links ?? []).filter((l) => !known || known.has(l)).map((l) => `L:${l}`);
  return links.length ? [...fn.features, ...links] : fn.features;
}

export function matchLocals(
  locals: FunctionPrint[],
  index: FunctionIndex,
  known: Set<string> = new Set(),
): Map<string, { name: string; package: string; confidence: number }> {
  const out = new Map<string, { name: string; package: string; confidence: number }>();
  for (const fn of locals) {
    const mine = withLinkFeatures(fn, READABLE_LINKS);
    const linked = (fn.links?.length ?? 0) > 0;
    const specific = mine.filter((f) => {
      const posting = /^(P|K|S):/.test(f) ? index.byFeature.get(f) : undefined;
      return !!posting?.length && posting.length <= 12;
    });
    if (mine.length < (linked ? MIN_FUNCTION_FEATURES : MIN_FUNCTION_FEATURES + 1) && !(mine.length >= 2 && specific.length)) continue;
    const shortlist = new Set<number>();
    const lists = mine.map((f) => index.byFeature.get(f) ?? []).filter((l) => l.length).sort((a, b) => a.length - b.length);
    lists.forEach((list, i) => {
      if (list.length <= RARE_FEATURE || i < 2) for (const n of list) shortlist.add(n);
    });
    const byName = new Map<string, { score: number; contained: number; package: string }>();
    for (const i of shortlist) {
      const candidate = index.functions[i]!;
      const theirs = withLinkFeatures(candidate, known);
      const score = jaccard(mine, theirs);
      const set = new Set(theirs);
      const contained = mine.filter((f) => set.has(f)).length / mine.length;
      if (score > (byName.get(candidate.name)?.score ?? 0)) byName.set(candidate.name, { score, contained, package: candidate.package });
    }
    const ranked = [...byName].sort((a, b) => b[1].score - a[1].score);
    const [best, second] = ranked;
    if (!best) continue;
    const margin = best[1].score - (second?.[1].score ?? 0);
    const small = mine.length < MIN_FUNCTION_FEATURES + (linked ? 0 : 1);
    const exact = best[1].score >= FUNCTION_THRESHOLD && (small ? best[1].score === 1 && margin >= 0.3 : margin >= 0.1);
    const shaken = mine.length >= 12 && best[1].contained >= 0.85 && best[1].score >= 0.45 && margin >= 0.3;
    const close = !small && best[1].score >= 0.9 && mine.length >= 10 && margin >= 0.03;
    if (exact || shaken || close) {
      out.set(fn.name, { name: best[0], package: best[1].package, confidence: Number(best[1].score.toFixed(3)) });
    }
  }
  return out;
}

const entries = new Map<string, Set<string>>();
const REEXPORTS: Record<string, string[]> = { vue: ["@vue/runtime-dom"], "@vue/runtime-dom": ["@vue/runtime-core"], "@vue/runtime-core": ["@vue/reactivity"] };

export function packageVersions(db: FingerprintDb): Map<string, string> {
  const versions = new Map<string, string>();
  for (const file of db.files) if (file.version && !versions.has(file.package)) versions.set(file.package, file.version);
  return versions;
}

export function entryExports(db: FingerprintDb, pkg: string, withDefault = false): Set<string> {
  const key = `${pkg}\u0000${withDefault}`;
  let names = entries.get(key);
  if (!names) {
    names = new Set(db.files.filter((f) => f.package === pkg && f.specifier === pkg).flatMap((f) => [...(f.names ?? []), ...f.exports.map((e) => e.name)]));
    for (const inner of REEXPORTS[pkg] ?? []) for (const name of entryExports(db, inner)) names.add(name);
    if (!withDefault) names.delete("default");
    entries.set(key, names);
  }
  return names;
}

export function rankLocal(fn: FunctionPrint, index: FunctionIndex, known: Set<string>): Array<{ name: string; package: string; score: number }> {
  const mine = withLinkFeatures(fn, READABLE_LINKS);
  const shortlist = new Set<number>();
  const lists = mine.map((f) => index.byFeature.get(f) ?? []).filter((l) => l.length).sort((a, b) => a.length - b.length);
  lists.forEach((list, i) => {
    if (list.length <= RARE_FEATURE || i < 2) for (const n of list) shortlist.add(n);
  });
  const byName = new Map<string, { score: number; package: string }>();
  for (const i of shortlist) {
    const candidate = index.functions[i]!;
    const score = jaccard(mine, withLinkFeatures(candidate, known));
    if (score > (byName.get(candidate.name)?.score ?? 0)) byName.set(candidate.name, { score, package: candidate.package });
  }
  return [...byName].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.score - a.score);
}

let strings: Set<string> | null = null;

let stringOwners: Map<string, string> | undefined;

export function stringPackages(db: FingerprintDb): Map<string, string> {
  if (stringOwners) return stringOwners;
  const owners = new Map<string, Set<string>>();
  for (const file of db.files) {
    for (const feature of file.features) {
      if (!feature.startsWith("S:") || feature.length < 8) continue;
      const value = feature.slice(2);
      owners.set(value, (owners.get(value) ?? new Set()).add(file.package.startsWith("@vue/") ? "vue" : file.package));
    }
  }
  stringOwners = new Map([...owners].filter(([, pkgs]) => pkgs.size === 1).map(([value, pkgs]) => [value, [...pkgs][0]!]));
  return stringOwners;
}

export function libraryStrings(db: FingerprintDb): Set<string> {
  if (strings) return strings;
  strings = new Set();
  for (const file of db.files) for (const feature of file.features) if (feature.startsWith("S:") && feature.length >= 10) strings.add(feature.slice(2));
  return strings;
}

export function vendorExportNames(code: string, index: FunctionIndex, present: ReadonlySet<string>, exported: (pkg: string, name: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  let print: ModulePrint;
  try {
    print = printModule(code);
  } catch {
    return out;
  }
  const locals = new Map([...print.locals, ...print.exports].map((f) => [f.name, f]));
  const known = new Set([...print.known, ...[...locals.keys()].filter((n) => n.length > 2)]);
  const taken = new Set(locals.keys());
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1]!.split(",")) {
      const [local, alias] = part.trim().split(/\s+as\s+/);
      const name = (alias ?? local)?.trim();
      if (name) taken.add(name);
    }
  }
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1]!.split(",")) {
      const [local, alias] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
      const name = alias ?? local;
      if (!local || !name || name.length > 2) continue;
      const fn = locals.get(local!);
      if (!fn || fn.features.length < 2) continue;
      const ranked = rankLocal(fn, index, known).filter((c) => present.has(c.package) && exported(c.package, c.name));
      const [best, second] = ranked;
      if (!best || best.score < 0.75 || best.score - (second && second.name !== best.name ? second.score : 0) < 0.25 || taken.has(best.name)) continue;
      out.set(name, best.name);
      taken.add(best.name);
    }
  }
  return out;
}
