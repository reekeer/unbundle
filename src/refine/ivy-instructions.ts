import { literalKey, t } from "../unpack/ast.ts";

function declaration(statement: t.Statement | undefined) {
  return t.isVariableDeclaration(statement) && statement.declarations.length === 1 ? statement.declarations[0] : undefined;
}

function onlyStatement(statement: t.Statement): t.Statement | undefined {
  return t.isBlockStatement(statement) ? (statement.body.length === 1 ? statement.body[0] : undefined) : statement;
}

function equivalent(left: t.Node | undefined, right: t.Node | undefined): boolean {
  return !!left && !!right && t.isNodesEquivalent(left, right);
}

function returnsSelf(fn: t.FunctionDeclaration): boolean {
  const last = fn.body.body.at(-1);
  return t.isReturnStatement(last) && t.isIdentifier(last.argument, { name: fn.id?.name });
}

function interpolation(fn: t.FunctionDeclaration): string | undefined {
  const [view, result, changed] = fn.body.body;
  const viewDecl = declaration(view);
  const resultDecl = declaration(result);
  if (fn.params.length < 3 || fn.params.length > 17 || fn.params.length % 2 === 0 || fn.body.body.length !== 4 || !returnsSelf(fn)) return;
  if (!t.isIdentifier(viewDecl?.id) || !t.isCallExpression(viewDecl.init) || viewDecl.init.arguments.length !== 0) return;
  if (!t.isIdentifier(resultDecl?.id) || !t.isCallExpression(resultDecl.init)) return;
  const [lView, ...forwarded] = resultDecl.init.arguments;
  if (!t.isIdentifier(lView, { name: viewDecl.id.name }) || forwarded.length !== fn.params.length || !forwarded.every((arg, index) => equivalent(arg, fn.params[index]))) return;
  if (!t.isIfStatement(changed) || changed.alternate || !t.isBinaryExpression(changed.test, { operator: "!==" }) || !t.isIdentifier(changed.test.left, { name: resultDecl.id.name })) return;
  const body = onlyStatement(changed.consequent);
  const call = t.isExpressionStatement(body) ? body.expression : undefined;
  if (t.isCallExpression(call) && call.arguments.length === 3 && equivalent(call.arguments[0], lView) && t.isCallExpression(call.arguments[1]) && call.arguments[1].arguments.length === 0 && t.isIdentifier(call.arguments[2], { name: resultDecl.id.name })) {
    return `ɵɵtextInterpolate${(fn.params.length - 1) / 2}`;
  }
}

export function ivyInstruction(name: string, functions: ReadonlyMap<string, t.FunctionDeclaration>): string | undefined {
  const fn = functions.get(name);
  if (!fn) return;
  const [first] = fn.body.body;
  const [index, value] = fn.params;
  if (fn.body.body.length === 1 && t.isReturnStatement(first) && t.isCallExpression(first.argument) && t.isIdentifier(first.argument.callee)) {
    const [view, root, ...forwarded] = first.argument.arguments;
    if (fn.params.length >= 3 && fn.params.length <= 6 && t.isCallExpression(view) && view.arguments.length === 0 && t.isCallExpression(root) && t.isIdentifier(root.callee, { name: "getBindingRoot" }) && root.arguments.length === 0 && forwarded.length === fn.params.length && forwarded.every((arg, position) => equivalent(arg, fn.params[position]))) {
      const implementation = functions.get(first.argument.callee.name);
      if (implementation?.params.length === fn.params.length + 3) return `ɵɵpureFunction${fn.params.length - 2}`;
    }
    if (fn.params.length === 1 && t.isAssignmentPattern(index) && t.isNumericLiteral(index.right, { value: 1 }) && first.argument.arguments.length === 1 && equivalent(view, index.left)) {
      const helper = functions.get(first.argument.callee.name);
      const result = helper?.body.body[0];
      if (helper?.body.body.length === 1 && t.isReturnStatement(result) && t.isMemberExpression(result.argument, { computed: true }) && t.isAssignmentExpression(result.argument.object, { operator: "=" }) && t.isMemberExpression(result.argument.object.left) && literalKey(result.argument.object.left.property) === "contextLView") return "ɵɵnextContext";
    }
  }
  if (!returnsSelf(fn)) return;
  if (fn.params.length === 1 && fn.body.body.length === 2 && t.isExpressionStatement(first) && t.isCallExpression(first.expression) && t.isIdentifier(first.expression.callee)) {
    const [prefix, arg] = first.expression.arguments;
    const helper = functions.get(first.expression.callee.name);
    if (first.expression.arguments.length === 2 && t.isStringLiteral(prefix, { value: "" }) && equivalent(arg, index) && helper && interpolation(helper) === "ɵɵtextInterpolate1") return "ɵɵtextInterpolate";
  }
  if (fn.params.length === 3 && t.isIdentifier(value)) {
    const offset = t.isIfStatement(first) ? 1 : 0;
    const update = fn.body.body[offset + 2];
    if (fn.body.body.length === offset + 4 && t.isIfStatement(update) && t.isBlockStatement(update.consequent)) {
      const write = update.consequent.body.at(-1);
      const call = t.isExpressionStatement(write) ? write.expression : undefined;
      if (t.isCallExpression(call) && t.isIdentifier(call.callee, { name: "setPropertyAndInputs" }) && equivalent(call.arguments[2], index) && equivalent(call.arguments[3], value)) {
        if (offset === 0) return "ɵɵproperty";
        if (!t.isIfStatement(first) || first.alternate || !t.isCallExpression(first.test) || first.test.arguments.length !== 1 || !equivalent(first.test.arguments[0], value)) return;
        const unwrap = onlyStatement(first.consequent);
        const expression = t.isExpressionStatement(unwrap) ? unwrap.expression : undefined;
        if (t.isAssignmentExpression(expression, { operator: "=" }) && equivalent(expression.left, value) && t.isCallExpression(expression.right) && equivalent(expression.right.callee, value) && expression.right.arguments.length === 0) return "ɵɵtwoWayProperty";
      }
    }
  }
  return interpolation(fn);
}
