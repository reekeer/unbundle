import { literalKey, parseProgram, t, traverse, type NodePath } from "../unpack/ast.ts";

type Kind = "worker" | "script" | "other";
type Dependency = { href: string; base: string; kind: Kind; source: string };

const FILE = /\.(?:wasm|json|avif|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf|mp3|mp4|ogg|webm)(?:[?#]|$)/i;

function stringValue(node: t.Node | null | undefined, path: NodePath): string | undefined {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && !node.expressions.length) return node.quasis[0]?.value.cooked ?? undefined;
  if (!t.isIdentifier(node)) return;
  const binding = path.scope.getBinding(node.name);
  if (binding?.constant && binding.path.isVariableDeclarator() && t.isStringLiteral(binding.path.node.init)) return binding.path.node.init.value;
}

function isMember(node: t.Node | null | undefined, object: string, property: string): boolean {
  return t.isMemberExpression(node) && t.isIdentifier(node.object, { name: object }) && literalKey(node.property) === property;
}

function workerArgument(node: t.Node, scriptUrl: string, pageBase: string): { href: t.Node | undefined; base: string } {
  if (t.isNewExpression(node) && t.isIdentifier(node.callee, { name: "URL" })) {
    const base = node.arguments[1];
    if (t.isMemberExpression(base) && t.isMetaProperty(base.object) && base.object.meta.name === "import" && literalKey(base.property) === "url") return { href: node.arguments[0], base: scriptUrl };
    if (isMember(base, "location", "href")) return { href: node.arguments[0], base: pageBase };
    if (t.isStringLiteral(base) && /^https?:\/\//i.test(base.value)) return { href: node.arguments[0], base: base.value };
    return { href: undefined, base: pageBase };
  }
  return { href: node, base: pageBase };
}

export function runtimeDependencies(code: string, scriptUrl: string, pageBase: string): Dependency[] {
  if (!/\b(?:Worker|SharedWorker|importScripts|fetch|define)\s*\(|\bserviceWorker\b|\.wasm\b/.test(code)) return [];
  let ast: t.File;
  try {
    const parsed = parseProgram(code) as t.File & { errors?: Error[] };
    if (parsed.errors?.length) return [];
    ast = parsed;
  } catch {
    return [];
  }
  const out: Dependency[] = [];
  const add = (href: string | undefined, base: string, kind: Kind, source: string) => {
    if (href) out.push({ href, base, kind, source });
  };

  const workerClasses = new Map<t.Class, Set<number>>();
  const definitions: Array<NodePath<t.CallExpression>> = [];
  let moduleUrl = scriptUrl;
  traverse(ast, {
    AssignmentExpression(path) {
      const { left, right } = path.node;
      if (!isMember(left, "self", "nextDefineUri") || !t.isBinaryExpression(right, { operator: "+" }) || !isMember(right.left, "location", "origin") || !t.isStringLiteral(right.right)) return;
      if (right.right.value.startsWith("/") && !right.right.value.startsWith("//")) moduleUrl = new URL(right.right.value, scriptUrl).href;
    },
    NewExpression(path) {
      const { callee, arguments: [arg] } = path.node;
      if (!arg) return;
      if (t.isIdentifier(callee) && /^(Shared)?Worker$/.test(callee.name) && !path.scope.getBinding(callee.name)) {
        const { href, base } = workerArgument(arg, scriptUrl, pageBase);
        add(stringValue(href, path), base, "worker", "worker");
        if (!t.isMemberExpression(arg) || !t.isThisExpression(arg.object) || arg.computed) return;
        const owner = path.findParent((parent) => parent.isClass());
        if (!owner?.isClass()) return;
        const ctor = owner.node.body.body.find((method): method is t.ClassMethod => t.isClassMethod(method, { kind: "constructor" }));
        if (!ctor) return;
        const property = literalKey(arg.property);
        t.traverseFast(ctor.body, (node) => {
          if (!t.isAssignmentExpression(node, { operator: "=" }) || !t.isMemberExpression(node.left) || !t.isThisExpression(node.left.object) || node.left.computed || literalKey(node.left.property) !== property || !t.isIdentifier(node.right)) return;
          const index = ctor.params.findIndex((param) => t.isIdentifier(param, { name: (node.right as t.Identifier).name }));
          if (index === -1) return;
          const indices = workerClasses.get(owner.node) ?? new Set<number>();
          indices.add(index);
          workerClasses.set(owner.node, indices);
        });
      } else if (t.isIdentifier(callee, { name: "URL" })) {
        const { href, base } = workerArgument(path.node, scriptUrl, pageBase);
        const value = stringValue(href, path);
        if (value && /\.wasm(?:[?#]|$)/i.test(value)) add(value, base, "other", "wasm");
        const [arg, module] = path.node.arguments;
        if (!href && t.isMemberExpression(module) && literalKey(module.property) === "uri") {
          const absolute = stringValue(arg, path);
          if (absolute?.startsWith("/") && !absolute.startsWith("//") && /\.wasm(?:[?#]|$)/i.test(absolute)) add(absolute, scriptUrl, "other", "wasm");
        }
      }
    },
    ObjectProperty(path) {
      if (literalKey(path.node.key) !== "url" || !t.isStringLiteral(path.node.value)) return;
      const { value } = path.node.value;
      if (value.startsWith("/") && FILE.test(value)) add(value, pageBase, "other", "asset-url");
    },
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (t.isIdentifier(callee, { name: "define" }) && t.isArrayExpression(args[0]) && (t.isFunctionExpression(args[1]) || t.isArrowFunctionExpression(args[1]))) {
        definitions.push(path);
      } else if (t.isMemberExpression(callee) && literalKey(callee.property) === "register" && isMember(callee.object, "navigator", "serviceWorker")) {
        add(stringValue(args[0], path), pageBase, "worker", "service-worker");
      } else if (t.isIdentifier(callee, { name: "importScripts" }) && !path.scope.getBinding("importScripts")) {
        for (const arg of args) add(stringValue(arg, path), scriptUrl, "script", "import-scripts");
      } else if (t.isIdentifier(callee, { name: "fetch" }) && args.length === 1 && !path.scope.getBinding("fetch")) {
        const value = stringValue(args[0], path);
        if (value && FILE.test(value)) add(value, pageBase, "other", "fetch");
      }
    },
  });

  if (workerClasses.size) traverse(ast, {
    CallExpression(path) {
      if (!t.isSuper(path.node.callee)) return;
      const owner = path.findParent((parent) => parent.isClass());
      if (!owner?.isClass() || !t.isIdentifier(owner.node.superClass)) return;
      const parent = path.scope.getBinding(owner.node.superClass.name)?.path;
      const node = parent?.isClassDeclaration() ? parent.node : parent?.isVariableDeclarator() && t.isClassExpression(parent.node.init) ? parent.node.init : null;
      for (const index of node ? workerClasses.get(node) ?? [] : []) add(stringValue(path.node.arguments[index], path), pageBase, "worker", "worker");
    },
  });

  for (const definition of definitions) {
    const [deps, factory] = definition.node.arguments;
    if (!t.isArrayExpression(deps) || (!t.isFunctionExpression(factory) && !t.isArrowFunctionExpression(factory))) continue;
    const addModule = (value: string | undefined) => {
      if (!value || !/^(?:\.{1,2}\/|\/)/.test(value)) return;
      const target = URL.parse(value, moduleUrl);
      if (!target) return;
      if (!target.pathname.endsWith(".js")) target.pathname += ".js";
      if (target.href !== moduleUrl) add(target.href, moduleUrl, "script", "amd");
    };
    for (const item of deps.elements) if (t.isStringLiteral(item)) addModule(item.value);
    const requireIndex = deps.elements.findIndex((item) => t.isStringLiteral(item, { value: "require" }));
    const name = factory.params[requireIndex];
    if (!t.isIdentifier(name)) continue;
    const factoryPath = definition.get("arguments")[1];
    const binding = factoryPath?.scope.getBinding(name.name);
    for (const ref of binding?.referencePaths ?? []) {
      const call = ref.parentPath;
      if (call?.isCallExpression() && call.node.callee === ref.node) addModule(stringValue(call.node.arguments[0], call));
    }
  }
  return out;
}
