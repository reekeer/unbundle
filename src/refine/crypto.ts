import type { NodePath } from "@babel/traverse";
import { literalKey, parseProgram, print, t, traverse } from "../unpack/ast.ts";

export interface CryptoFinding {
  kind: "crypto" | "proof-of-work" | "webcrypto";
  name: string;
  file: string;
  line: number;
  detail: string;
}

interface Algorithm {
  name: string;
  label: string;
  init: number[];
  table: number[];
  strings?: string[];
  minHits: number;
}

const ALGORITHMS: Algorithm[] = [
  { name: "sha256", label: "SHA-256", init: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f], table: [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b], minHits: 2 },
  { name: "sha224", label: "SHA-224", init: [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939], table: [], minHits: 2 },
  { name: "sha512", label: "SHA-512", init: [0xf3bcc908, 0x84caa73b, 0xfe94f82b, 0x5f1d36f1], table: [0xd728ae22, 0x23ef65cd, 0xec4d3b2f, 0x8189dbbc], minHits: 2 },
  { name: "md5", label: "MD5", init: [], table: [0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf], minHits: 2 },
  { name: "sha1", label: "SHA-1", init: [0xc3d2e1f0], table: [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6], minHits: 2 },
  { name: "crc32", label: "CRC-32", init: [], table: [0xedb88320, 0x77073096, 0xee0e612c], minHits: 1 },
  { name: "murmurhash3", label: "MurmurHash3", init: [], table: [0xcc9e2d51, 0x1b873593, 0xe6546b64, 0x85ebca6b, 0xc2b2ae35], minHits: 2 },
  { name: "fnv1a", label: "FNV-1a", init: [0x811c9dc5], table: [0x01000193], minHits: 2 },
  { name: "xxhash32", label: "xxHash32", init: [], table: [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f, 0x165667b1], minHits: 2 },
  { name: "chacha20", label: "ChaCha20", init: [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574], table: [], strings: ["expand 32-byte k"], minHits: 2 },
  { name: "aes", label: "AES S-box", init: [], table: [], minHits: 1 },
  { name: "base64", label: "Base64 alphabet", init: [], table: [], strings: ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"], minHits: 1 },
];
const AES_SBOX = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5];

const QR_TABLES = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22],
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4],
];

export function algorithmTopic(nodes: t.Node[]): string | null {
  let qr = 0;
  const hits: Hits = new Map();
  for (const node of nodes) {
    t.traverseFast(node, (n) => {
      if (!t.isArrayExpression(n)) return;
      const values = n.elements.map((e) => (t.isNumericLiteral(e) ? e.value : -1));
      if (QR_TABLES.some((table) => table.every((v, i) => values[i] === v))) qr++;
    });
    for (const [algorithm, entry] of count(node)) {
      const total = hits.get(algorithm) ?? { init: 0, table: 0, strings: 0 };
      hits.set(algorithm, { init: total.init + entry.init, table: total.table + entry.table, strings: total.strings + entry.strings });
    }
  }
  if (qr >= 2) return "qr";
  const best = [...hits].filter(([algorithm, entry]) => entry.init + entry.table + entry.strings >= algorithm.minHits).sort((a, b) => b[1].init + b[1].table - (a[1].init + a[1].table))[0];
  return best ? best[0].name : null;
}

type Hits = Map<Algorithm, { init: number; table: number; strings: number }>;

function count(node: t.Node): Hits {
  const hits: Hits = new Map();
  const bump = (algorithm: Algorithm, key: "init" | "table" | "strings") => {
    const entry = hits.get(algorithm) ?? { init: 0, table: 0, strings: 0 };
    entry[key]++;
    hits.set(algorithm, entry);
  };
  t.traverseFast(node, (n) => {
    if (t.isNumericLiteral(n)) {
      for (const algorithm of ALGORITHMS) {
        if (algorithm.init.includes(n.value >>> 0) && Number.isInteger(n.value)) bump(algorithm, "init");
        if (algorithm.table.includes(n.value >>> 0) && Number.isInteger(n.value)) bump(algorithm, "table");
      }
    } else if (t.isStringLiteral(n)) {
      for (const algorithm of ALGORITHMS) if (algorithm.strings?.includes(n.value)) bump(algorithm, "strings");
    } else if (t.isArrayExpression(n) && n.elements.length >= AES_SBOX.length) {
      const values = n.elements.slice(0, AES_SBOX.length).map((e) => (t.isNumericLiteral(e) ? e.value : -1));
      if (values.every((v, i) => v === AES_SBOX[i])) bump(ALGORITHMS.find((a) => a.name === "aes")!, "table");
    }
  });
  return hits;
}

function detected(hits: Hits): Array<{ algorithm: Algorithm; role: "function" | "table" }> {
  const out: Array<{ algorithm: Algorithm; role: "function" | "table" }> = [];
  for (const [algorithm, entry] of hits) {
    const total = entry.init + entry.table + entry.strings;
    if (total < algorithm.minHits) continue;
    out.push({ algorithm, role: entry.init > 0 || entry.strings > 0 ? "function" : "table" });
  }
  const names = new Set(out.map((o) => o.algorithm.name));
  return out.filter((o) => !(o.algorithm.name === "sha1" && names.has("md5")) && !(o.algorithm.name === "sha224" && names.has("sha256")));
}

function isMangled(name: string): boolean {
  return name.length <= 2 || /^_?[a-z]\d*$/i.test(name);
}

function isGeneric(name: string): boolean {
  return isMangled(name) || /^(u?int(8|16|32)(Clamped)?Array|float(32|64)Array|array|list|items|table|values?|result|data|fn|func|callback|handler|process\w*|compute\w*|format\w*|get\w*)\d*$/i.test(name);
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

function capturesOuter(fn: NodePath<t.Function>, program: NodePath<t.Program>): boolean {
  let captured = false;
  fn.traverse({
    Identifier(path) {
      if (captured || !path.isReferencedIdentifier()) return;
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || binding.scope === program.scope) return;
      if (!binding.path.findParent((p) => p === fn) && binding.path !== fn) captured = true;
    },
    ThisExpression() {
      captured = true;
    },
  });
  return captured;
}

function freeName(program: NodePath<t.Program>, base: string): string {
  if (!program.scope.hasBinding(base)) return base;
  for (let n = 2; ; n++) if (!program.scope.hasBinding(`${base}${n}`)) return `${base}${n}`;
}

function isHashCall(node: t.Node, hashes: Set<string>): boolean {
  if (!t.isCallExpression(node)) return false;
  if (t.isIdentifier(node.callee) && hashes.has(node.callee.name)) return true;
  return t.isMemberExpression(node.callee) && literalKey(node.callee.property) === "digest";
}

function looksLikeProofOfWork(fn: t.Node, hashes: Set<string>): boolean {
  let hash = false;
  let zeros = false;
  let loop = false;
  t.traverseFast(fn, (n) => {
    if (isHashCall(n, hashes)) hash = true;
    if (t.isWhileStatement(n) || t.isForStatement(n) || t.isDoWhileStatement(n)) loop = true;
    if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && literalKey(n.callee.property) === "startsWith") {
      const arg = n.arguments[0];
      if (t.isStringLiteral(arg) && /^0+$/.test(arg.value)) zeros = true;
      if (t.isCallExpression(arg) && t.isMemberExpression(arg.callee) && literalKey(arg.callee.property) === "repeat" && t.isStringLiteral(arg.callee.object, { value: "0" })) zeros = true;
    }
    if (t.isRegExpLiteral(n) && /^\^0/.test(n.pattern)) zeros = true;
  });
  return hash && zeros && loop;
}

function rotationOf(fn: t.Function): "rotr" | "rotl" | null {
  if (fn.params.length !== 2 || !fn.params.every((p) => t.isIdentifier(p))) return null;
  const [value, bits] = fn.params as t.Identifier[];
  const body = t.isBlockStatement(fn.body) ? (fn.body.body.length === 1 && t.isReturnStatement(fn.body.body[0]) ? fn.body.body[0].argument : null) : fn.body;
  if (!t.isBinaryExpression(body, { operator: "|" })) return null;
  const shift = (node: t.Node, op: ">>>" | "<<", byBits: boolean) =>
    t.isBinaryExpression(node, { operator: op }) &&
    t.isIdentifier(node.left, { name: value!.name }) &&
    (byBits ? t.isIdentifier(node.right, { name: bits!.name }) : t.isBinaryExpression(node.right, { operator: "-" }) && t.isNumericLiteral(node.right.left, { value: 32 }) && t.isIdentifier(node.right.right, { name: bits!.name }));
  const pair = (a: t.Node, b: t.Node) => {
    if (shift(a, ">>>", true) && shift(b, "<<", false)) return "rotr" as const;
    if (shift(a, "<<", true) && shift(b, ">>>", false)) return "rotl" as const;
    return null;
  };
  return pair(body.left, body.right) ?? pair(body.right, body.left);
}

export function nameCryptoCode(code: string): string {
  if (!/\d{8,}|0x[0-9a-f]{6,}|ABCDEFGHIJKLMNOP|digest|expand 32-byte k|>>>/i.test(code)) return code;
  const ast = parseProgram(code);
  const program = programPath(ast);
  let changed = false;
  const hashes = new Set<string>();

  program.traverse({
    Function: {
      exit(path) {
        const found = detected(count(path.node)).filter((d) => d.role === "function");
        if (found.length !== 1) return;
        const algorithm = found[0]!.algorithm;
        if (path.parentPath.isCallExpression() && path.parentPath.node.callee === path.node && path.isFunctionExpression() && !capturesOuter(path, program)) {
          const call = path.parentPath;
          let top: NodePath = call;
          while (top.parentPath && !top.parentPath.isProgram()) top = top.parentPath;
          const name = freeName(program, algorithm.name);
          const fn = path.node;
          top.insertBefore(t.functionDeclaration(t.identifier(name), fn.params, fn.body, fn.generator, fn.async));
          call.replaceWith(t.callExpression(t.identifier(name), call.node.arguments));
          program.scope.crawl();
          hashes.add(name);
          changed = true;
          return;
        }
        const id = path.isFunctionDeclaration() ? path.node.id : path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id) ? path.parentPath.node.id : null;
        if (id && path.scope.parent === program.scope && isGeneric(id.name) && !program.scope.hasBinding(algorithm.name)) {
          program.scope.rename(id.name, algorithm.name);
          hashes.add(algorithm.name);
          changed = true;
        } else if (id) hashes.add(id.name);
      },
    },
  });

  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    const fn = binding.path.isFunctionDeclaration() ? binding.path.node : binding.path.isVariableDeclarator() && t.isFunction(binding.path.node.init) ? binding.path.node.init : null;
    const rotation = fn && isGeneric(name) ? rotationOf(fn) : null;
    if (!rotation) continue;
    program.scope.rename(name, freeName(program, rotation));
    changed = true;
  }

  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    if (!isGeneric(name) || !binding.path.isVariableDeclarator()) continue;
    const init = binding.path.node.init;
    const tableOf = init ? detected(count(init)).find((d) => d.role === "table" && !t.isFunction(init)) : undefined;
    if (!tableOf) continue;
    const target = freeName(program, `${tableOf.algorithm.name.toUpperCase()}_TABLE`.replace(/^SHA(\d+)_TABLE$/, "SHA$1_K"));
    program.scope.rename(name, target);
    changed = true;
  }

  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    if (!isGeneric(name)) continue;
    const fn = binding.path.isFunctionDeclaration() ? binding.path.node : binding.path.isVariableDeclarator() && t.isFunction(binding.path.node.init) ? binding.path.node.init : null;
    if (!fn || !looksLikeProofOfWork(fn, hashes)) continue;
    program.scope.rename(name, freeName(program, "solveProofOfWork"));
    changed = true;
  }
  return changed ? print(ast) : code;
}

export function scanCrypto(file: string, code: string): CryptoFinding[] {
  if (!/\d{8,}|0x[0-9a-f]{6,}|ABCDEFGHIJKLMNOP|subtle|digest|expand 32-byte k/i.test(code)) return [];
  let ast: t.File;
  try {
    ast = parseProgram(code);
  } catch {
    return [];
  }
  const findings: CryptoFinding[] = [];
  const seen = new Set<string>();
  const add = (finding: CryptoFinding) => {
    const key = `${finding.kind}:${finding.name}:${finding.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  const hashes = new Set<string>();
  for (const stmt of ast.program.body) {
    const node = t.isExportNamedDeclaration(stmt) || t.isExportDefaultDeclaration(stmt) ? (stmt.declaration ?? stmt) : stmt;
    for (const { algorithm, role } of detected(count(node))) {
      const name = t.isFunctionDeclaration(node) && node.id ? node.id.name : t.isVariableDeclaration(node) && t.isIdentifier(node.declarations[0]?.id) ? node.declarations[0]!.id.name : "";
      if (role === "function" && name) hashes.add(name);
      add({ kind: "crypto", name: algorithm.label, file, line: node.loc?.start.line ?? 0, detail: `${role === "table" ? "constant table" : "implementation"}${name ? ` \`${name}\`` : ""} recognized by its constants` });
    }
  }
  t.traverseFast(ast.program, (n) => {
    if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && t.isMemberExpression(n.callee.object) && literalKey(n.callee.object.property) === "subtle") {
      const method = literalKey(n.callee.property) ?? "call";
      const algorithm = t.isStringLiteral(n.arguments[0]) ? n.arguments[0].value : t.isObjectExpression(n.arguments[0]) ? (n.arguments[0].properties.map((p) => (t.isObjectProperty(p) && literalKey(p.key) === "name" && t.isStringLiteral(p.value) ? p.value.value : null)).find(Boolean) ?? "") : "";
      add({ kind: "webcrypto", name: `crypto.subtle.${method}`, file, line: n.loc?.start.line ?? 0, detail: algorithm ? `algorithm ${algorithm}` : "Web Crypto API" });
    }
  });
  for (const stmt of ast.program.body) {
    const node = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
    const fn = t.isFunctionDeclaration(node) ? node : t.isVariableDeclaration(node) && t.isFunction(node.declarations[0]?.init) ? node.declarations[0]!.init : null;
    if (!fn || !node || !looksLikeProofOfWork(fn, hashes)) continue;
    const name = t.isFunctionDeclaration(node) && node.id ? node.id.name : t.isVariableDeclaration(node) && t.isIdentifier(node.declarations[0]!.id) ? node.declarations[0]!.id.name : "";
    add({ kind: "proof-of-work", name: name || "anonymous", file, line: node.loc?.start.line ?? 0, detail: "loops over nonces until a hash starts with zeros: a proof-of-work challenge (anti-bot / captcha)" });
  }
  return findings;
}
