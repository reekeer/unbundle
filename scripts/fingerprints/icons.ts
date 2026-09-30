import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { build } from "@reekeer/sigdb";
import { ICON_GROUP, ICONS_PATH, shapeSignature, shapeToken } from "../../src/refine/icons.ts";
import { parseProgram, t } from "../../src/unpack/ast.ts";

const HEROICON_VARIANTS = ["16/solid", "20/solid", "24/outline", "24/solid"];

interface Entry {
  family: string;
  variant: string;
  name: string;
  signature: string;
}

function exportedShapes(file: string): Array<{ name: string; node: t.Node }> {
  const out: Array<{ name: string; node: t.Node }> = [];
  let ast: t.File;
  try {
    ast = parseProgram(readFileSync(file, "utf8"));
  } catch {
    return out;
  }
  const aliases = new Map<string, string>();
  for (const stmt of ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
    for (const spec of stmt.specifiers) if (t.isExportSpecifier(spec)) aliases.set(spec.local.name, t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value);
  }
  const named = (local: string) => aliases.get(local) ?? local;
  for (const stmt of ast.program.body) {
    const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
    if (t.isFunctionDeclaration(decl) && decl.id) out.push({ name: named(decl.id.name), node: decl });
    if (t.isVariableDeclaration(decl)) for (const d of decl.declarations) if (t.isIdentifier(d.id) && d.init) out.push({ name: named(d.id.name), node: d.init });
  }
  return out;
}

function stringSignature(node: t.Node): string | null {
  return t.isStringLiteral(node) && /^[Mm]/.test(node.value) ? `path:d=${node.value}` : null;
}

function packageIcons(modules: string, family: string, files: (root: string) => string[], pick: (name: string, node: t.Node, file: string) => { name: string; signature: string | null } | null): Entry[] {
  const root = join(modules, family);
  if (!existsSync(root)) return [];
  const out: Entry[] = [];
  for (const file of files(root)) {
    for (const { name, node } of exportedShapes(file)) {
      const found = pick(name, node, file);
      if (found?.signature) out.push({ family, variant: "", name: found.name, signature: found.signature });
    }
  }
  return out;
}

function dirFiles(dir: string, pattern: RegExp): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => pattern.test(f)).map((f) => join(dir, f)) : [];
}

function otherPackages(modules: string): Entry[] {
  const pascal = (file: string) => basename(file).replace(/\.m?js$/, "").split(/[-_]/).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return [
    ...packageIcons(modules, "@radix-ui/react-icons", (root) => [join(root, "dist/react-icons.esm.js")], (name, node) => (/^[A-Z]\w*Icon$/.test(name) ? { name, signature: shapeSignature(node) } : null)),
    ...packageIcons(modules, "@remixicon/react", (root) => [join(root, "index.mjs")], (name, node) => (/^Ri[A-Z]/.test(name) ? { name, signature: shapeSignature(node) } : null)),
    ...packageIcons(modules, "react-feather", (root) => dirFiles(join(root, "dist/icons"), /\.js$/), (name, node) => (/^[A-Z]/.test(name) ? { name, signature: shapeSignature(node) } : null)),
    ...packageIcons(modules, "react-bootstrap-icons", (root) => dirFiles(join(root, "dist/icons"), /\.js$/), (name, node) => (/^[A-Z]/.test(name) ? { name, signature: shapeSignature(node) } : null)),
    ...packageIcons(modules, "@primer/octicons-react", (root) => dirFiles(join(root, "dist/icons"), /\.mjs$/), (name, node, file) => (name === "svgDataByHeight" ? { name: pascal(file), signature: shapeSignature(node) } : null)),
    ...packageIcons(modules, "@mdi/js", (root) => [join(root, "mdi.js")], (name, node) => (/^mdi[A-Z]/.test(name) ? { name, signature: stringSignature(node) } : null)),
  ];
}

function lucide(modules: string): Entry[] {
  const dir = join(modules, "lucide/dist/esm/icons");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .flatMap((f) => exportedShapes(join(dir, f)).filter((s) => t.isArrayExpression(s.node)))
    .flatMap(({ name, node }) => {
      const signature = shapeSignature(node);
      return signature ? [{ family: "lucide", variant: "", name, signature }] : [];
    });
}

function heroicons(modules: string): Entry[] {
  const out: Entry[] = [];
  for (const variant of HEROICON_VARIANTS) {
    const dir = join(modules, "@heroicons/react", variant, "esm");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /^[A-Z]\w*\.js$/.test(f))) {
      const fn = exportedShapes(join(dir, file)).find((s) => t.isFunctionDeclaration(s.node));
      const signature = fn ? shapeSignature(fn.node) : null;
      if (signature) out.push({ family: "heroicons", variant, name: basename(file, ".js"), signature });
    }
  }
  return out;
}

function reactIcons(modules: string): Entry[] {
  const root = join(modules, "react-icons");
  if (!existsSync(root)) return [];
  const out: Entry[] = [];
  for (const set of readdirSync(root).filter((d) => existsSync(join(root, d, "index.mjs")) && d !== "lib")) {
    for (const { name, node } of exportedShapes(join(root, set, "index.mjs"))) {
      const signature = shapeSignature(node);
      if (signature) out.push({ family: "react-icons", variant: set, name, signature });
    }
  }
  return out;
}

export function buildIcons(modules: string): { icons: number; size: number } {
  const entries = [...lucide(modules), ...heroicons(modules), ...reactIcons(modules), ...otherPackages(modules)];
  const rules: Record<string, { data: Omit<Entry, "signature">; [ICON_GROUP]: string[] }> = {};
  for (const entry of entries) {
    const key = `${entry.family}/${entry.variant ? `${entry.variant}/` : ""}${entry.name}`;
    rules[key] = { data: { family: entry.family, variant: entry.variant, name: entry.name }, [ICON_GROUP]: [shapeToken(entry.signature)] };
  }
  const families = [...new Set(entries.map((e) => (e.variant && e.family === "react-icons" ? `react-icons/${e.variant}` : e.family)))].sort();
  const result = build(rules, ICONS_PATH, { groups: { [ICON_GROUP]: {} }, metadata: { dataset: "unbundle icon shapes", families } });
  return { icons: entries.length, size: result.size };
}
