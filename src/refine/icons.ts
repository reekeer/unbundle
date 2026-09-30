import type { NodePath } from "@babel/traverse";
import { load, type Database } from "@reekeer/sigdb";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { literalKey, parseProgram, print, t, traverse } from "../unpack/ast.ts";
import { capitalize, moduleIdFromSpecifier, splitExports, tidyAst } from "./rename.ts";

export type Framework = "react" | "vue" | "svelte" | "vanilla";

export interface IconImport {
  source: string;
  name: string;
}

export interface IconFactory {
  id: string;
  name: string;
  package: string;
  file: string;
}

export interface IconAnalysis {
  icons: number;
  onlyIcons: boolean;
  exported: Map<string, string>;
  sources: Set<string>;
  factories: IconFactory[];
}

interface IconDef {
  local: string;
  statements: t.Statement[];
  target: IconImport;
  factory?: { node: t.Expression; package: string; file: string };
}

export const ICONS_PATH = fileURLToPath(new URL("../../icons.sigdb", import.meta.url));
export const ICON_GROUP = "shapes";

const SHAPE_TAGS = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
const SVG_TAGS = new Set([...SHAPE_TAGS, "g"]);
const GEOMETRY = ["d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points"];
const WEIGHTS = ["bold", "duotone", "fill", "light", "regular", "thin"];

const LUCIDE: Record<Framework, string> = { react: "lucide-react", vue: "lucide-vue-next", svelte: "lucide-svelte", vanilla: "lucide" };
const LUCIDE_FACTORY: Record<Framework, string> = { react: "dist/esm/createLucideIcon.mjs", vue: "dist/esm/createLucideIcon.js", svelte: "dist/Icon.svelte", vanilla: "dist/esm/createElement.mjs" };
const TABLER: Record<Framework, string> = { react: "@tabler/icons-react", vue: "@tabler/icons-vue", svelte: "@tabler/icons-svelte", vanilla: "@tabler/icons" };
const HEROICONS: Record<Framework, string> = { react: "@heroicons/react", vue: "@heroicons/vue", svelte: "@heroicons/react", vanilla: "@heroicons/react" };

export const LUCIDE_REACT = LUCIDE.react;

export function iconName(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(capitalize)
    .join("");
}

export function detectFramework(codes: Iterable<string>): Framework {
  const score: Record<Framework, number> = { react: 0, vue: 0, svelte: 0, vanilla: 0 };
  for (const code of codes) {
    if (/react\.(transitional\.)?element|__SECRET_INTERNALS|__CLIENT_INTERNALS_DO_NOT_USE|\bjsxs?\(|useState\(/.test(code)) score.react++;
    if (/__vccOpts|__scopeId|\b__name\s*:|createElementVNode|openBlock\(|defineStore\(/.test(code)) score.vue++;
    if (/svelte-[a-z0-9]{6}|\$\$props|\$\.template\(|append_styles|svelte\/internal/.test(code)) score.svelte++;
  }
  const best = (Object.keys(score) as Framework[]).filter((k) => k !== "vanilla").sort((a, b) => score[b] - score[a])[0]!;
  return score[best] ? best : "vanilla";
}

function geometry(tag: string, attrs: Array<[string, unknown]>): string | null {
  if (!SHAPE_TAGS.has(tag)) return null;
  const values = new Map(attrs.filter(([k, v]) => GEOMETRY.includes(k) && (typeof v === "string" || typeof v === "number")).map(([k, v]) => [k, String(v)]));
  if (!values.size) return null;
  return `${tag}:${GEOMETRY.filter((k) => values.has(k)).map((k) => `${k}=${values.get(k)}`).join(",")}`;
}

function literalValue(node: t.Node | null | undefined): unknown {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && !node.expressions.length) return node.quasis[0]?.value.cooked;
  if (t.isJSXExpressionContainer(node)) return literalValue(node.expression);
  return undefined;
}

function objectAttrs(node: t.Node | null | undefined): Array<[string, unknown]> | null {
  if (!t.isObjectExpression(node)) return null;
  const out: Array<[string, unknown]> = [];
  for (const prop of node.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) continue;
    const key = literalKey(prop.key);
    if (key) out.push([key, literalValue(prop.value)]);
  }
  return out;
}

export function shapeSignature(root: t.Node): string | null {
  const shapes: string[] = [];
  const push = (tag: unknown, attrs: Array<[string, unknown]> | null) => {
    if (typeof tag !== "string" || !attrs) return;
    const shape = geometry(tag, attrs);
    if (shape) shapes.push(shape);
  };
  t.traverseFast(root, (node) => {
    if (t.isArrayExpression(node) && node.elements.length === 2) push(literalValue(node.elements[0]), objectAttrs(node.elements[1]));
    else if (t.isCallExpression(node) && node.arguments.length >= 2) push(literalValue(node.arguments[0]), objectAttrs(node.arguments[1]));
    else if (t.isObjectExpression(node)) {
      const attrs = objectAttrs(node);
      const tag = attrs?.find(([k]) => k === "tag")?.[1];
      const attr = node.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "attr");
      if (tag && attr) push(tag, objectAttrs(attr.value));
    } else if (t.isJSXElement(node) && t.isJSXIdentifier(node.openingElement.name)) {
      const attrs: Array<[string, unknown]> = [];
      for (const a of node.openingElement.attributes) if (t.isJSXAttribute(a) && t.isJSXIdentifier(a.name)) attrs.push([a.name.name, literalValue(a.value)]);
      push(node.openingElement.name.name, attrs);
    }
  });
  return shapes.length ? shapes.join("|") : null;
}

export function shapeToken(signature: string): string {
  return Bun.hash(signature).toString(36);
}

interface IconRecord {
  family: string;
  variant: string;
  name: string;
}

let iconDb: { db: Database } | null | undefined;

function loadIconDb(): Database | null {
  if (iconDb === undefined) iconDb = existsSync(ICONS_PATH) ? { db: load(ICONS_PATH) } : null;
  return iconDb?.db ?? null;
}

export function lookupIcon(signature: string, prefer: (record: IconRecord) => boolean = () => true): IconRecord | null {
  const db = loadIconDb();
  if (!db) return null;
  const index = db.index();
  const all = [...index.matchTokens(ICON_GROUP, [shapeToken(signature)]).keys()].map((id) => index.items[id]!.data as IconRecord);
  const preferred = all.filter(prefer);
  const hits = preferred.length ? preferred : all;
  if (!hits.length) return null;
  return hits.sort((a, b) => `${a.family}/${a.variant}/${a.name}`.localeCompare(`${b.family}/${b.variant}/${b.name}`))[0]!;
}

function recordImport(record: IconRecord, framework: Framework): IconImport {
  if (record.family === "lucide") return { source: LUCIDE[framework], name: record.name };
  if (record.family === "heroicons") return { source: `${HEROICONS[framework]}/${record.variant}`, name: record.name };
  return { source: record.variant ? `${record.family}/${record.variant}` : record.family, name: record.name };
}

const FONTAWESOME: Record<string, string> = { fas: "@fortawesome/free-solid-svg-icons", far: "@fortawesome/free-regular-svg-icons", fab: "@fortawesome/free-brands-svg-icons" };

function namedIconData(node: t.Node | null | undefined): IconImport | null {
  if (!t.isObjectExpression(node)) return null;
  const attrs = new Map((objectAttrs(node) ?? []).map(([k, v]) => [k, v]));
  const prop = (key: string) => node.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === key)?.value;
  const prefix = attrs.get("prefix");
  const faName = attrs.get("iconName");
  if (typeof prefix === "string" && typeof faName === "string" && FONTAWESOME[prefix] && t.isArrayExpression(prop("icon"))) return { source: FONTAWESOME[prefix], name: `fa${iconName(faName)}` };
  const name = attrs.get("name");
  const theme = attrs.get("theme");
  if (typeof name === "string" && typeof theme === "string" && /^(outlined|filled|twotone)$/.test(theme) && t.isObjectExpression(prop("icon"))) return { source: "@ant-design/icons", name: `${iconName(name)}${theme === "twotone" ? "TwoTone" : capitalize(theme)}` };
  const slug = attrs.get("slug");
  if (typeof slug === "string" && typeof attrs.get("title") === "string" && typeof attrs.get("path") === "string" && typeof attrs.get("hex") === "string") return { source: "simple-icons", name: `si${capitalize(slug)}` };
  return null;
}

function svgPathString(node: t.Node | null | undefined): string | null {
  return t.isStringLiteral(node) && node.value.length > 20 && /^[Mm][\d\s.,MLHVCSQTAZmlhvcsqtaz-]+$/.test(node.value) ? `path:d=${node.value}` : null;
}

function isIconNode(node: t.Node | null | undefined, keyed = true): boolean {
  if (!t.isArrayExpression(node) || !node.elements.length) return false;
  return node.elements.every((item) => {
    if (!t.isArrayExpression(item) || item.elements.length !== 2) return false;
    const [tag, attrs] = item.elements;
    if (!t.isStringLiteral(tag) || !SVG_TAGS.has(tag.value) || !t.isObjectExpression(attrs)) return false;
    return !keyed || attrs.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "key");
  });
}

function iconData(node: t.Node | null | undefined): string | null {
  if (!t.isObjectExpression(node)) return null;
  let name: string | null = null;
  let hasNode = false;
  for (const prop of node.properties) {
    if (!t.isObjectProperty(prop)) return null;
    const key = literalKey(prop.key);
    if (key === "name" && t.isStringLiteral(prop.value)) name = prop.value.value;
    if (key === "node") hasNode = isIconNode(prop.value);
  }
  return name && hasNode ? name : null;
}

function calleeOf(call: t.CallExpression): t.Expression | null {
  const callee = call.callee;
  if (t.isSequenceExpression(callee) && callee.expressions.length === 2 && t.isNumericLiteral(callee.expressions[0])) return callee.expressions[1]!;
  return t.isExpression(callee) ? callee : null;
}

function programPath(ast: t.File): NodePath<t.Program> {
  let program: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    },
  });
  return program!;
}

function declared(stmt: t.Statement): string[] {
  if ((t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt)) && stmt.id) return [stmt.id.name];
  if (t.isVariableDeclaration(stmt)) return stmt.declarations.flatMap((d) => Object.keys(t.getBindingIdentifiers(d.id)));
  return [];
}

function exclusiveHelpers(program: NodePath<t.Program>, roots: t.Statement[], taken: Set<t.Statement>): t.Statement[] {
  const owned = new Set(roots);
  const body = program.node.body;
  for (let grew = true; grew; ) {
    grew = false;
    for (const stmt of body) {
      if (owned.has(stmt) || taken.has(stmt) || !t.isVariableDeclaration(stmt)) continue;
      const names = declared(stmt);
      if (!names.length) continue;
      const refs = names.flatMap((n) => program.scope.getBinding(n)?.referencePaths ?? []);
      if (!refs.length || names.some((n) => program.scope.getBinding(n)?.constantViolations.length)) continue;
      const inside = refs.every((ref) => {
        const top = ref.find((p) => p.parentPath?.isProgram() === true);
        return !!top && owned.has(top.node as t.Statement);
      });
      if (!inside) continue;
      owned.add(stmt);
      grew = true;
    }
  }
  return body.filter((s) => owned.has(s));
}

function memberStatements(program: NodePath<t.Program>, local: string): { statements: t.Statement[]; displayName: string | null } | null {
  const binding = program.scope.getBinding(local);
  if (!binding) return null;
  const statements: t.Statement[] = [];
  let displayName: string | null = null;
  for (const ref of binding.referencePaths) {
    const member = ref.parentPath;
    const assign = member?.parentPath;
    const stmt = assign?.parentPath;
    if (member?.isMemberExpression() && member.node.object === ref.node && assign?.isAssignmentExpression() && assign.node.left === member.node && stmt?.isExpressionStatement() && stmt.parentPath?.isProgram()) {
      if (literalKey(member.node.property) === "displayName" && t.isStringLiteral(assign.node.right)) displayName = assign.node.right.value;
      statements.push(stmt.node);
    }
  }
  return { statements, displayName };
}

function genIconData(fn: t.Node | null | undefined): t.ObjectExpression | null {
  if (!t.isFunction(fn) || fn.params.length > 1) return null;
  let body: t.Node | null | undefined = fn.body;
  if (t.isBlockStatement(body)) body = body.body.length === 1 && t.isReturnStatement(body.body[0]) ? body.body[0].argument : null;
  if (!t.isCallExpression(body) || !t.isCallExpression(body.callee)) return null;
  const data = body.callee.arguments[0];
  if (!t.isObjectExpression(data)) return null;
  const attrs = objectAttrs(data);
  const tag = attrs?.find(([k]) => k === "tag")?.[1];
  const child = data.properties.some((p) => t.isObjectProperty(p) && literalKey(p.key) === "child" && t.isArrayExpression(p.value));
  return tag === "svg" && child ? data : null;
}

function weightsMap(node: t.Node | null | undefined): boolean {
  if (!t.isNewExpression(node) || !t.isIdentifier(node.callee, { name: "Map" }) || !t.isArrayExpression(node.arguments[0])) return false;
  const keys = node.arguments[0].elements.map((e) => (t.isArrayExpression(e) ? literalValue(e.elements[0]) : null));
  return WEIGHTS.every((w) => keys.includes(w));
}

function phosphorVueName(node: t.Node | null | undefined, program: NodePath<t.Program>): string | null {
  const call = t.isCallExpression(node) ? node : null;
  const options = call ? call.arguments[0] : node;
  if (!t.isObjectExpression(options)) return null;
  let name: string | null = null;
  for (const prop of options.properties) {
    if (t.isObjectProperty(prop) && literalKey(prop.key) === "name" && t.isStringLiteral(prop.value)) name = prop.value.value;
    if (t.isSpreadElement(prop) && t.isIdentifier(prop.argument)) {
      const init = program.scope.getBinding(prop.argument.name)?.path.node;
      if (t.isVariableDeclarator(init) && t.isObjectExpression(init.init)) {
        const found = init.init.properties.find((p): p is t.ObjectProperty => t.isObjectProperty(p) && literalKey(p.key) === "name" && t.isStringLiteral(p.value));
        if (found) name = (found.value as t.StringLiteral).value;
      }
    }
  }
  if (!name || !/^Ph[A-Z]\w*$/.test(name)) return null;
  const strings = new Set<string>();
  t.traverseFast(options, (n) => {
    if (t.isStringLiteral(n)) strings.add(n.value);
  });
  return WEIGHTS.every((w) => strings.has(w)) ? name : null;
}

function isWrapper(stmt: t.Statement, local: string): boolean {
  const init = t.isVariableDeclaration(stmt) && stmt.declarations.length === 1 ? stmt.declarations[0]!.init : t.isFunctionDeclaration(stmt) ? stmt : null;
  if (t.isCallExpression(init)) return init.arguments.some((a) => t.isIdentifier(a, { name: local }) || t.isFunction(a));
  if (!t.isFunction(init) || init.params.length !== 2) return false;
  const body = t.isBlockStatement(init.body) ? init.body.body : [t.returnStatement(init.body as t.Expression)];
  return body.length === 1 && t.isReturnStatement(body[0]);
}

function chainOf(program: NodePath<t.Program>, stmt: t.Statement, taken: Set<t.Statement>): { statements: t.Statement[]; local: string } | null {
  const first = declared(stmt);
  if (first.length !== 1) return null;
  let local = first[0]!;
  const statements = [stmt];
  for (let hop = 0; hop < 4; hop++) {
    const members = memberStatements(program, local);
    if (members) statements.push(...members.statements.filter((m) => !statements.includes(m)));
    const binding = program.scope.getBinding(local);
    if (!binding) break;
    const tops = new Set<t.Statement>();
    for (const ref of binding.referencePaths) {
      const top = ref.find((p) => p.parentPath?.isProgram() === true);
      if (top && !statements.includes(top.node as t.Statement)) tops.add(top.node as t.Statement);
    }
    if (tops.size !== 1) break;
    const next = [...tops][0]!;
    if (taken.has(next) || t.isExportNamedDeclaration(next) || t.isExportDefaultDeclaration(next) || !isWrapper(next, local)) break;
    const names = declared(next);
    if (names.length !== 1) break;
    statements.push(next);
    local = names[0]!;
  }
  return { statements: exclusiveHelpers(program, statements, taken), local };
}

function shapeLookup(stmt: t.Statement): IconRecord | null {
  const init = t.isVariableDeclaration(stmt) && stmt.declarations.length === 1 ? stmt.declarations[0]!.init : null;
  const path = svgPathString(init);
  if (path) return lookupIcon(path, (r) => r.family === "@mdi/js");
  let shaped = false;
  t.traverseFast(stmt, (n) => {
    if (!shaped && t.isStringLiteral(n) && SHAPE_TAGS.has(n.value)) shaped = true;
    if (!shaped && t.isJSXIdentifier(n) && SHAPE_TAGS.has(n.name)) shaped = true;
  });
  if (!shaped) return null;
  const signature = shapeSignature(stmt);
  return signature ? lookupIcon(signature, (r) => r.family !== "react-icons") : null;
}

function findIcons(program: NodePath<t.Program>, framework: Framework): IconDef[] {
  const body = program.node.body;
  const defs: IconDef[] = [];
  const taken = new Set<t.Statement>();
  const add = (def: IconDef) => {
    defs.push(def);
    for (const s of def.statements) taken.add(s);
  };
  const lucideFactory = (node: t.Expression): IconDef["factory"] => ({ node, package: LUCIDE[framework], file: LUCIDE_FACTORY[framework] });

  for (const stmt of body) {
    if (taken.has(stmt)) continue;
    const decl = t.isVariableDeclaration(stmt) && stmt.declarations.length === 1 && t.isIdentifier(stmt.declarations[0]!.id) ? stmt.declarations[0]! : null;
    if (!decl) continue;
    const local = (decl.id as t.Identifier).name;
    const init = decl.init ?? null;

    if (t.isCallExpression(init)) {
      const factory = calleeOf(init);
      const [first, second, third, fourth] = init.arguments;
      if (factory && t.isStringLiteral(first) && isIconNode(second)) {
        add({ local, statements: [stmt], target: { source: LUCIDE[framework], name: iconName(first.value) }, factory: lucideFactory(factory) });
        continue;
      }
      if (factory && t.isStringLiteral(first) && /^(outline|filled)$/.test(first.value) && t.isStringLiteral(second) && t.isStringLiteral(third) && (isIconNode(fourth) || t.isIdentifier(fourth))) {
        const statements = exclusiveHelpers(program, [stmt], taken);
        const file = framework === "vue" ? "dist/esm/createVueComponent.mjs" : "dist/esm/createReactComponent.mjs";
        add({ local, statements, target: { source: TABLER[framework], name: `Icon${third.value}${first.value === "filled" ? "Filled" : ""}` }, factory: { node: factory, package: TABLER[framework], file } });
        continue;
      }
      if (init.arguments.length === 2 && t.isStringLiteral(second) && /^[A-Z][A-Za-z0-9]*$/.test(second.value) && first && shapeSignature(first)) {
        add({ local, statements: exclusiveHelpers(program, [stmt], taken), target: { source: "@mui/icons-material", name: second.value } });
        continue;
      }
      const inline = iconData(first);
      if (factory && inline) {
        add({ local, statements: [stmt], target: { source: LUCIDE[framework], name: iconName(inline) }, factory: lucideFactory(factory) });
        continue;
      }
      if (factory && t.isIdentifier(first) && init.arguments.length === 1) {
        const binding = program.scope.getBinding(first.name);
        const name = binding?.path.isVariableDeclarator() && binding.scope === program.scope && !binding.constantViolations.length ? iconData(binding.path.node.init) : null;
        const dataStmt = binding?.path.parentPath?.node;
        if (name && t.isVariableDeclaration(dataStmt) && dataStmt.declarations.length === 1) {
          const leftovers: t.Statement[] = [];
          const clean = binding!.referencePaths.every((ref) => {
            if (ref.node === first) return true;
            const member = ref.parentPath;
            const statement = member?.parentPath;
            if (member?.isMemberExpression() && member.node.object === ref.node && statement?.isExpressionStatement() && statement.parentPath?.isProgram()) {
              leftovers.push(statement.node);
              return true;
            }
            return false;
          });
          if (clean) {
            add({ local, statements: [dataStmt, ...leftovers, stmt], target: { source: LUCIDE[framework], name: iconName(name) }, factory: lucideFactory(factory) });
            continue;
          }
        }
      }
      const phosphorVue = phosphorVueName(init, program);
      if (phosphorVue) {
        add({ local, statements: exclusiveHelpers(program, [stmt], taken), target: { source: "@phosphor-icons/vue", name: phosphorVue } });
        continue;
      }
      const referencesWeights = init.arguments.some((a) => {
        let found = false;
        t.traverseFast(a, (n) => {
          if (t.isIdentifier(n) && weightsMap((program.scope.getBinding(n.name)?.path.node as t.VariableDeclarator | undefined)?.init)) found = true;
        });
        return found;
      });
      if (referencesWeights) {
        const members = memberStatements(program, local);
        if (members?.displayName) {
          add({ local, statements: exclusiveHelpers(program, [stmt, ...members.statements], taken), target: { source: "@phosphor-icons/react", name: members.displayName } });
          continue;
        }
      }
    }

    const phosphorVue = t.isObjectExpression(init) ? phosphorVueName(init, program) : null;
    if (phosphorVue) {
      add({ local, statements: exclusiveHelpers(program, [stmt], taken), target: { source: "@phosphor-icons/vue", name: phosphorVue } });
      continue;
    }
    const named = namedIconData(init);
    if (named) {
      const chain = chainOf(program, stmt, taken);
      if (chain) add({ local: chain.local, statements: chain.statements, target: named });
      continue;
    }
    const gen = framework === "react" ? genIconData(t.isFunction(init) ? init : null) : null;
    if (gen) {
      const signature = shapeSignature(gen);
      const record = signature ? lookupIcon(signature, (r) => r.family === "react-icons") : null;
      if (record) add({ local, statements: exclusiveHelpers(program, [stmt], taken), target: recordImport(record, framework) });
    }
  }

  for (const stmt of body) {
    if (taken.has(stmt) || !(t.isVariableDeclaration(stmt) || t.isFunctionDeclaration(stmt))) continue;
    if (t.isFunctionDeclaration(stmt) && stmt.params.length >= 4) continue;
    const gen = t.isFunctionDeclaration(stmt) ? genIconData(stmt) : null;
    const record = gen ? (framework === "react" ? lookupIcon(shapeSignature(gen) ?? "", (r) => r.family === "react-icons") : null) : shapeLookup(stmt);
    if (!record || (framework !== "react" && /^(react-|@radix-ui\/react-|@remixicon\/react|@primer\/octicons-react|@heroicons\/react)/.test(record.family === "heroicons" ? "" : record.family))) continue;
    const chain = chainOf(program, stmt, taken);
    if (chain) add({ local: chain.local, statements: chain.statements, target: recordImport(record, framework) });
  }
  return defs;
}

function factoryImport(program: NodePath<t.Program>, factory: t.Expression): { id: string; name: string } | null {
  const target = t.isIdentifier(factory) ? factory : t.isMemberExpression(factory) && t.isIdentifier(factory.object) ? factory.object : null;
  if (!target) return null;
  const binding = program.scope.getBinding(target.name);
  const spec = binding?.path.node;
  const decl = binding?.path.parentPath?.node;
  if (!t.isImportDeclaration(decl)) return null;
  const id = moduleIdFromSpecifier(decl.source.value);
  if (!id) return null;
  if (t.isImportSpecifier(spec)) return { id, name: t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value };
  if (t.isImportDefaultSpecifier(spec)) return { id, name: "default" };
  if (t.isImportNamespaceSpecifier(spec) && t.isMemberExpression(factory)) {
    const name = literalKey(factory.property);
    return name ? { id, name } : null;
  }
  return null;
}

function isIconExport(stmt: t.Statement, locals: Set<string>): boolean {
  return t.isExportNamedDeclaration(stmt) && !stmt.source && !stmt.declaration && stmt.specifiers.every((s) => t.isExportSpecifier(s) && locals.has(s.local.name));
}

function mayHaveIcons(code: string): boolean {
  return /key|"?tag"?\s*:|data-slot|displayName|\bPh[A-Z]|"(outline|filled)"|\[\s*\[\s*"(path|circle|rect)"/.test(code);
}

export function analyzeIcons(code: string, framework: Framework): IconAnalysis | null {
  if (!mayHaveIcons(code)) return null;
  const ast = parseProgram(code);
  splitExports(ast);
  const program = programPath(ast);
  const defs = findIcons(program, framework);
  if (!defs.length) return null;
  const locals = new Map(defs.map((d) => [d.local, d.target.name]));
  const removed = new Set(defs.flatMap((d) => d.statements));
  const exported = new Map<string, string>();
  for (const stmt of program.node.body) {
    if (t.isExportNamedDeclaration(stmt) && !stmt.source) {
      for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec) && locals.has(spec.local.name)) exported.set(t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value, locals.get(spec.local.name)!);
    }
    if (t.isExportDefaultDeclaration(stmt) && t.isIdentifier(stmt.declaration) && locals.has(stmt.declaration.name)) exported.set("default", locals.get(stmt.declaration.name)!);
  }
  const usedByIcons = (name: string) => {
    const refs = program.scope.getBinding(name)?.referencePaths ?? [];
    return refs.every((ref) => {
      const top = ref.find((p) => p.parentPath?.isProgram() === true);
      return !!top && removed.has(top.node as t.Statement);
    });
  };
  const onlyIcons = program.node.body.every(
    (stmt) =>
      removed.has(stmt) ||
      (t.isImportDeclaration(stmt) && stmt.specifiers.every((s) => usedByIcons(s.local.name))) ||
      isIconExport(stmt, new Set(locals.keys())) ||
      (t.isExportDefaultDeclaration(stmt) && t.isIdentifier(stmt.declaration) && locals.has(stmt.declaration.name)),
  );
  const factories = new Map<string, IconFactory>();
  for (const def of defs) {
    if (!def.factory) continue;
    const found = factoryImport(program, def.factory.node);
    if (found) factories.set(`${found.id}\u0000${found.name}`, { ...found, package: def.factory.package, file: def.factory.file });
  }
  return { icons: defs.length, onlyIcons, exported, sources: new Set(defs.map((d) => d.target.source)), factories: [...factories.values()] };
}

export function replaceIcons(code: string, framework: Framework): string {
  if (!mayHaveIcons(code)) return code;
  const ast = parseProgram(code);
  splitExports(ast);
  const program = programPath(ast);
  const defs = findIcons(program, framework);
  if (!defs.length) return code;
  const removed = new Set(defs.flatMap((d) => d.statements));
  const bySource = new Map<string, t.ImportSpecifier[]>();
  const imported = new Set<string>();
  for (const def of defs) {
    const binding = program.scope.getBinding(def.local);
    const wanted = def.target.name;
    const free = def.local === wanted || (!program.scope.hasBinding(wanted) && !imported.has(wanted) && [...(binding?.referencePaths ?? []), ...(binding?.constantViolations ?? [])].every((ref) => !ref.scope.hasBinding(wanted)));
    if (free && def.local !== wanted) program.scope.rename(def.local, wanted);
    const local = free ? wanted : def.local;
    imported.add(local);
    bySource.set(def.target.source, [...(bySource.get(def.target.source) ?? []), t.importSpecifier(t.identifier(local), t.identifier(wanted))]);
  }
  const body = program.node.body.filter((stmt) => !removed.has(stmt));
  const firstNonImport = body.findIndex((s) => !t.isImportDeclaration(s));
  const at = firstNonImport < 0 ? body.length : firstNonImport;
  body.splice(at, 0, ...[...bySource].map(([source, specifiers]) => t.importDeclaration(specifiers, t.stringLiteral(source))));
  program.node.body = body;
  program.scope.crawl();
  const sources = new Set(bySource.keys());
  for (const stmt of [...program.node.body]) {
    if (!t.isImportDeclaration(stmt) || sources.has(stmt.source.value) || !stmt.specifiers.length) continue;
    stmt.specifiers = stmt.specifiers.filter((spec) => program.scope.getBinding(spec.local.name)?.referenced !== false);
    if (!stmt.specifiers.length) program.node.body.splice(program.node.body.indexOf(stmt), 1);
  }
  tidyAst(ast);
  return print(ast);
}
