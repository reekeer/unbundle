import { parseProgram, print, t, traverse, type NodePath, type Visitor } from "../unpack/ast.ts";

const FLIPPABLE: Record<string, t.BinaryExpression["operator"]> = {
  "==": "==",
  "===": "===",
  "!=": "!=",
  "!==": "!==",
  "<": ">",
  ">": "<",
  "<=": ">=",
  ">=": "<=",
};

function isStatementList(path: NodePath): boolean {
  return path.parentPath?.isBlockStatement() === true || path.parentPath?.isProgram() === true;
}

function block(node: t.Statement): t.BlockStatement {
  return t.isBlockStatement(node) ? node : t.blockStatement([node]);
}

function toStatement(expr: t.Expression): t.Statement {
  return t.expressionStatement(expr);
}

function isSimpleLiteral(node: t.Node): boolean {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    (t.isIdentifier(node) && node.name === "undefined") ||
    (t.isUnaryExpression(node) && node.operator === "void")
  );
}

function isModuleObject(path: NodePath, name: string): boolean {
  const binding = path.scope.getBinding(name);
  if (!binding) return false;
  if (binding.path.isImportNamespaceSpecifier() || binding.path.isImportDefaultSpecifier()) return true;
  if (!binding.path.isVariableDeclarator() || !binding.constant) return false;
  const init = binding.path.node.init;
  return t.isCallExpression(init) && init.arguments.length === 1 && (t.isNumericLiteral(init.arguments[0]) || t.isStringLiteral(init.arguments[0]));
}

function importOf(node: t.Node | null | undefined): t.CallExpression | null {
  let current = node;
  if (t.isAwaitExpression(current)) current = current.argument;
  return t.isCallExpression(current) && t.isImport(current.callee) ? current : null;
}

function preloadedImport(call: t.CallExpression): t.Expression | null {
  const [loader, deps] = call.arguments;
  if (call.arguments.length < 2 || !(t.isArrowFunctionExpression(loader) || t.isFunctionExpression(loader)) || loader.params.length) return null;
  if (!(t.isArrayExpression(deps) || t.isCallExpression(deps) || t.isIdentifier(deps) || t.isConditionalExpression(deps))) return null;
  const direct = t.isExpression(loader.body) ? importOf(loader.body) : null;
  if (direct) return direct;
  if (!t.isBlockStatement(loader.body)) return null;
  const body = loader.body.body;
  if (body.length === 1 && t.isReturnStatement(body[0])) return importOf(body[0].argument);
  if (body.length !== 2 || !t.isVariableDeclaration(body[0]) || !t.isReturnStatement(body[1])) return null;
  const decl = body[0].declarations[0];
  const loaded = decl && body[0].declarations.length === 1 ? importOf(decl.init) : null;
  const returned = body[1].argument;
  if (!loaded || !t.isObjectPattern(decl!.id) || !t.isObjectExpression(returned)) return null;
  const pattern = new Map(decl!.id.properties.map((p) => (t.isObjectProperty(p) && t.isIdentifier(p.key) && t.isIdentifier(p.value) ? [p.key.name, p.value.name] : ["?", "?"])));
  const same = returned.properties.length === pattern.size && returned.properties.every((p) => t.isObjectProperty(p) && t.isIdentifier(p.key) && t.isIdentifier(p.value) && pattern.get(p.key.name) === p.value.name);
  return same && !pattern.has("?") ? loaded : null;
}

function isUndefinedValue(node: t.Node): boolean {
  return t.isIdentifier(node, { name: "undefined" }) || (t.isUnaryExpression(node, { operator: "void" }) && t.isNumericLiteral(node.argument));
}

function nullishTest(test: t.Expression): { temp: string; source: t.Expression } | null {
  const head = (node: t.Expression): { temp: string; source: t.Expression } | null => {
    if (t.isAssignmentExpression(node, { operator: "=" }) && t.isIdentifier(node.left)) return { temp: node.left.name, source: node.right };
    if (t.isIdentifier(node)) return { temp: node.name, source: node };
    return null;
  };
  if (t.isBinaryExpression(test, { operator: "==" }) && t.isNullLiteral(test.right) && t.isExpression(test.left)) return head(test.left);
  if (t.isLogicalExpression(test, { operator: "||" }) && t.isBinaryExpression(test.left, { operator: "===" }) && t.isNullLiteral(test.left.right) && t.isExpression(test.left.left) && t.isBinaryExpression(test.right, { operator: "===" }) && isUndefinedValue(test.right.right)) {
    const found = head(test.left.left);
    return found && t.isIdentifier(test.right.left, { name: found.temp }) ? found : null;
  }
  return null;
}

function optionalChain(node: t.Node, temp: string, source: t.Expression): t.Expression | null {
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (t.isIdentifier(node.object, { name: temp })) return t.optionalMemberExpression(source, node.property as t.Expression, node.computed, true);
    const inner = optionalChain(node.object, temp, source);
    return inner ? t.optionalMemberExpression(inner, node.property as t.Expression, node.computed, false) : null;
  }
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    if (t.isMemberExpression(node.callee) && literalKeyName(node.callee.property) === "call" && t.isIdentifier(node.callee.object, { name: temp }) && node.arguments.length >= 1) {
      return t.optionalCallExpression(source, node.arguments.slice(1), true);
    }
    const inner = optionalChain(node.callee, temp, source);
    return inner ? t.optionalCallExpression(inner, node.arguments, false) : null;
  }
  return null;
}

function literalKeyName(node: t.Node): string | null {
  return t.isIdentifier(node) ? node.name : t.isStringLiteral(node) ? node.value : null;
}

function countName(node: t.Node, name: string): number {
  let count = 0;
  t.traverseFast(node, (n) => {
    if (t.isIdentifier(n, { name })) count++;
  });
  return count;
}

const optionalTemps = new WeakSet<t.Node>();

export const deminifyVisitor: Visitor = {
  ConditionalExpression: {
    exit(path) {
      const { test, consequent, alternate } = path.node;
      if (!isUndefinedValue(consequent)) return;
      const found = nullishTest(test);
      if (!found || countName(alternate, found.temp) !== 1) return;
      const chained = optionalChain(alternate, found.temp, found.source);
      if (!chained) return;
      const binding = path.scope.getBinding(found.temp);
      const temp = binding?.path.isVariableDeclarator() && !binding.path.node.init && found.source !== undefined && !t.isIdentifier(found.source, { name: found.temp }) ? binding.path.node : null;
      path.replaceWith(chained);
      if (temp) optionalTemps.add(temp);
    },
  },
  LogicalExpression: {
    exit(path) {
      const { left, right, operator } = path.node;
      if (operator !== "&&" || !t.isBinaryExpression(left) || !/^!==?$/.test(left.operator) || !t.isNullLiteral(left.right) || !t.isExpression(left.left)) return;
      const parent = path.parentPath;
      const boolean = (parent?.isConditionalExpression() && parent.node.test === path.node) || (parent?.isIfStatement() && parent.node.test === path.node) || parent?.isLogicalExpression() || (parent?.isUnaryExpression() && parent.node.operator === "!");
      if (!boolean) return;
      const head = t.isAssignmentExpression(left.left, { operator: "=" }) && t.isIdentifier(left.left.left) ? { temp: left.left.left.name, source: left.left.right } : t.isIdentifier(left.left) ? { temp: left.left.name, source: left.left as t.Expression } : null;
      if (!head || countName(right, head.temp) !== 1) return;
      const chained = optionalChain(right, head.temp, head.source);
      if (!chained) return;
      const binding = path.scope.getBinding(head.temp);
      const temp = binding?.path.isVariableDeclarator() && !binding.path.node.init && !t.isIdentifier(head.source, { name: head.temp }) ? binding.path.node : null;
      path.replaceWith(chained);
      if (temp) optionalTemps.add(temp);
    },
  },
  Program: {
    exit(path) {
      path.scope.crawl();
      path.traverse({
        VariableDeclarator(declarator) {
          if (!optionalTemps.has(declarator.node) || !t.isIdentifier(declarator.node.id)) return;
          const binding = declarator.scope.getBinding(declarator.node.id.name);
          if (binding && !binding.referenced && !binding.constantViolations.length) declarator.remove();
        },
      });
    },
  },
  IfStatement: {
    enter(path) {
      const { node } = path;
      node.consequent = block(node.consequent);
      if (node.alternate && !t.isIfStatement(node.alternate)) node.alternate = block(node.alternate);
      if (t.isSequenceExpression(node.test) && isStatementList(path)) {
        const exprs = node.test.expressions;
        node.test = exprs.at(-1)!;
        path.insertBefore(exprs.slice(0, -1).map(toStatement));
      }
    },
    exit(path) {
      const alt = path.node.alternate;
      if (t.isBlockStatement(alt) && alt.body.length === 1 && t.isIfStatement(alt.body[0]) && !alt.directives.length) {
        path.node.alternate = alt.body[0];
      }
    },
  },
  "ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement"(path) {
    const node = path.node as t.Loop;
    node.body = block(node.body);
  },

  TemplateLiteral(path) {
    const { node } = path;
    if (node.expressions.length || path.parentPath.isTaggedTemplateExpression()) return;
    const cooked = node.quasis[0]?.value.cooked;
    if (typeof cooked === "string") path.replaceWith(t.stringLiteral(cooked));
  },

  UnaryExpression(path) {
    const { node } = path;
    if (node.operator === "!" && t.isNumericLiteral(node.argument) && (node.argument.value === 0 || node.argument.value === 1)) {
      path.replaceWith(t.booleanLiteral(node.argument.value === 0));
      return;
    }
    if (node.operator === "void" && t.isNumericLiteral(node.argument) && !path.scope.hasBinding("undefined", true)) {
      path.replaceWith(t.identifier("undefined"));
    }
  },

  BinaryExpression(path) {
    const { node } = path;
    if (
      (node.operator === ">" || node.operator === "<") &&
      t.isUnaryExpression(node.operator === ">" ? node.left : node.right, { operator: "typeof" }) &&
      t.isStringLiteral(node.operator === ">" ? node.right : node.left, { value: "u" })
    ) {
      const typeofExpr = (node.operator === ">" ? node.left : node.right) as t.UnaryExpression;
      path.replaceWith(t.binaryExpression("===", typeofExpr, t.stringLiteral("undefined")));
      return;
    }
    const flipped = FLIPPABLE[node.operator];
    if (flipped && t.isExpression(node.left) && isSimpleLiteral(node.left) && !isSimpleLiteral(node.right)) {
      path.replaceWith(t.binaryExpression(flipped, node.right, node.left));
    }
  },

  CallExpression(path) {
    const lazy = preloadedImport(path.node);
    if (lazy) {
      path.replaceWith(lazy);
      return;
    }
    const callee = path.node.callee;
    if (!t.isSequenceExpression(callee) || callee.expressions.length !== 2 || !t.isNumericLiteral(callee.expressions[0])) return;
    const target = callee.expressions[1]!;
    if (t.isIdentifier(target)) {
      path.node.callee = target;
      return;
    }
    if (t.isMemberExpression(target) && t.isIdentifier(target.object) && isModuleObject(path, target.object.name)) {
      path.node.callee = target;
    }
  },

  ExpressionStatement(path) {
    const expr = path.node.expression;
    if (!isStatementList(path)) return;

    if (t.isSequenceExpression(expr)) {
      path.replaceWithMultiple(expr.expressions.map(toStatement));
      return;
    }
    if (t.isLogicalExpression(expr) && (expr.operator === "&&" || expr.operator === "||")) {
      const test = expr.operator === "&&" ? expr.left : t.unaryExpression("!", expr.left);
      path.replaceWith(t.ifStatement(test, t.blockStatement([toStatement(expr.right)])));
      return;
    }
    if (t.isConditionalExpression(expr)) {
      path.replaceWith(
        t.ifStatement(expr.test, t.blockStatement([toStatement(expr.consequent)]), t.blockStatement([toStatement(expr.alternate)])),
      );
    }
  },

  ReturnStatement(path) {
    if (!isStatementList(path)) return;
    let arg = path.node.argument;
    if (t.isSequenceExpression(arg)) {
      path.insertBefore(arg.expressions.slice(0, -1).map(toStatement));
      arg = path.node.argument = arg.expressions.at(-1)!;
    }
    if (t.isConditionalExpression(arg) && (t.isSequenceExpression(arg.consequent) || t.isSequenceExpression(arg.alternate))) {
      path.replaceWith(
        t.ifStatement(
          arg.test,
          t.blockStatement([t.returnStatement(arg.consequent)]),
          t.blockStatement([t.returnStatement(arg.alternate)]),
        ),
      );
    }
  },

  ThrowStatement(path) {
    const arg = path.node.argument;
    if (t.isSequenceExpression(arg) && isStatementList(path)) {
      path.insertBefore(arg.expressions.slice(0, -1).map(toStatement));
      path.node.argument = arg.expressions.at(-1)!;
    }
  },

  VariableDeclaration(path) {
    const { node } = path;
    if (node.declarations.length > 1 && isStatementList(path)) {
      path.replaceWithMultiple(node.declarations.map((d) => t.variableDeclaration(node.kind, [d])));
    }
  },
};

export function deminifyPath(path: NodePath): void {
  path.traverse(deminifyVisitor);
}

function declarationOf(binding: NonNullable<ReturnType<NodePath["scope"]["getBinding"]>>): NodePath | null {
  const path = binding.path;
  if (path.isFunctionDeclaration()) return path;
  if (path.isVariableDeclarator()) return path.parentPath?.isVariableDeclaration() && path.parentPath.node.declarations.length === 1 ? path.parentPath : path;
  return null;
}

function unwrapVitePreload(ast: t.File): void {
  traverse(ast, {
    Program(program) {
      for (const [name, binding] of Object.entries(program.scope.bindings)) {
        const decl = declarationOf(binding);
        if (!decl || !JSON.stringify(decl.node).includes("vite:preloadError")) continue;
        const inner = new Set<string>();
        decl.traverse({
          Identifier(id) {
            if (id.isReferencedIdentifier() && program.scope.getBinding(id.node.name) && id.scope.getBinding(id.node.name) === program.scope.getBinding(id.node.name)) inner.add(id.node.name);
          },
        });
        let unwrapped = true;
        for (const ref of binding.referencePaths) {
          const call = ref.parentPath;
          const loader = call?.isCallExpression() && call.node.callee === ref.node ? call.node.arguments[0] : null;
          if (!call || !(t.isArrowFunctionExpression(loader) || t.isFunctionExpression(loader)) || loader.params.length) {
            unwrapped = false;
            continue;
          }
          call.replaceWith(t.isArrowFunctionExpression(loader) && t.isExpression(loader.body) ? loader.body : t.callExpression(loader, []));
        }
        if (!unwrapped) continue;
        decl.remove();
        program.scope.crawl();
        for (let removed = true; removed; ) {
          removed = false;
          for (const dep of inner) {
            if (dep === name) continue;
            const other = program.scope.getBinding(dep);
            const otherDecl = other && !other.referenced ? declarationOf(other) : null;
            if (!otherDecl || otherDecl.removed || !(otherDecl.parentPath?.isProgram() || (otherDecl.isVariableDeclarator() && otherDecl.parentPath?.parentPath?.isProgram()))) continue;
            otherDecl.traverse({
              Identifier(id) {
                if (id.isReferencedIdentifier() && program.scope.getBinding(id.node.name)) inner.add(id.node.name);
              },
            });
            otherDecl.remove();
            program.scope.crawl();
            removed = true;
          }
        }
      }
      program.stop();
    },
  });
}

function isPublicFieldHelper(node: t.Node | null | undefined, resolve: (name: string) => t.Node | null | undefined): string | null {
  if (!t.isArrowFunctionExpression(node) && !t.isFunctionExpression(node)) return null;
  if (node.params.length !== 3 || !node.params.every((p) => t.isIdentifier(p))) return null;
  const body = t.isBlockStatement(node.body) ? (node.body.body.length === 1 && t.isReturnStatement(node.body.body[0]) ? node.body.body[0].argument : null) : node.body;
  if (!t.isCallExpression(body) || !t.isIdentifier(body.callee) || body.arguments.length !== 3) return null;
  const text = JSON.stringify(resolve(body.callee.name) ?? null);
  return t.isConditionalExpression(body.arguments[1]) && /"symbol"/.test(JSON.stringify(body.arguments[1])) && /"enumerable"/.test(text) && /"writable"/.test(text) ? body.callee.name : null;
}

function unfoldPublicFields(ast: t.File): void {
  traverse(ast, {
    Program(program) {
      const init = (name: string) => {
        const binding = program.scope.getBinding(name);
        return binding?.path.isVariableDeclarator() ? binding.path.node.init : null;
      };
      const helpers = new Set<string>();
      const related = new Set<string>();
      for (const name of Object.keys(program.scope.bindings)) {
        const inner = isPublicFieldHelper(init(name), init);
        if (!inner) continue;
        helpers.add(name);
        related.add(name);
        related.add(inner);
      }
      if (!helpers.size) return;
      for (const name of Object.keys(program.scope.bindings)) {
        const value = init(name);
        if (t.isMemberExpression(value) && t.isIdentifier(value.object, { name: "Object" }) && t.isIdentifier(value.property, { name: "defineProperty" })) related.add(name);
      }
      program.traverse({
        Class(path) {
          const ctor = path.node.body.body.find((m): m is t.ClassMethod => t.isClassMethod(m) && m.kind === "constructor");
          if (!ctor) return;
          const fields: t.ClassProperty[] = [];
          ctor.body.body = ctor.body.body.filter((stmt) => {
            const call = t.isExpressionStatement(stmt) ? stmt.expression : null;
            if (!t.isCallExpression(call) || !t.isIdentifier(call.callee) || !helpers.has(call.callee.name) || !t.isThisExpression(call.arguments[0]) || !t.isStringLiteral(call.arguments[1]) || !/^[A-Za-z_$][\w$]*$/.test(call.arguments[1].value) || call.arguments.length > 2) return true;
            fields.push(t.classProperty(t.identifier(call.arguments[1].value)));
            return false;
          });
          if (fields.length) path.node.body.body.unshift(...fields);
        },
      });
      program.scope.crawl();
      for (let removed = true; removed; ) {
        removed = false;
        for (const name of related) {
          const binding = program.scope.getBinding(name);
          if (!binding || binding.referenced || !binding.path.isVariableDeclarator()) continue;
          const holder = binding.path.parentPath;
          if (holder?.isVariableDeclaration() && holder.node.declarations.length === 1) holder.remove();
          else binding.path.remove();
          program.scope.crawl();
          removed = true;
        }
      }
      program.stop();
    },
  });
}

export function deminifyAst(ast: t.File): void {
  traverse(ast, deminifyVisitor);
  unfoldPublicFields(ast);
}

export function deminifyCode(code: string): string {
  const ast = parseProgram(code);
  if (code.includes("vite:preloadError")) unwrapVitePreload(ast);
  deminifyAst(ast);
  return print(ast);
}
