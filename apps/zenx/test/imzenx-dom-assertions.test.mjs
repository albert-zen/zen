import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("./imzenx-ui.test.ts", import.meta.url),
  "utf8",
);
const file = ts.createSourceFile(
  "imzenx-ui.test.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const assertions = [];
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const values = declarations.get(node.name.text) ?? [];
    values.push(node.initializer);
    declarations.set(node.name.text, values);
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(file).startsWith("assert.")
  ) {
    assertions.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(file);

function isDomOperand(node, seen = new Set()) {
  if (!node) return false;
  if (
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node)
  ) {
    return isDomOperand(node.expression, seen);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return ["activeElement", "body", "documentElement"].includes(
      node.name.text,
    );
  }
  if (ts.isCallExpression(node)) {
    return ts.isPropertyAccessExpression(node.expression)
      ? [
          "querySelector",
          "getElementById",
          "closest",
          "createElement",
        ].includes(node.expression.name.text)
      : ["button", "selector"].includes(node.expression.getText(file));
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const next = new Set(seen).add(node.text);
    return (declarations.get(node.text) ?? []).some((value) =>
      isDomOperand(value, next),
    );
  }
  return false;
}
const domGuards = assertions.filter((call) => {
  const condition = call.arguments[0];
  return (
    call.expression.getText(file) === "assert.ok" &&
    condition &&
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    (isDomOperand(condition.left) || isDomOperand(condition.right))
  );
});

test("IM DOM assertions compare booleans rather than format DOM/Fiber graphs", () => {
  for (const call of assertions) {
    if (
      /^assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)$/.test(
        call.expression.getText(file),
      )
    ) {
      assert.ok(
        !call.arguments.slice(0, 2).some((arg) => isDomOperand(arg)),
        `DOM operand passed to equality assertion at line ${file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1}`,
      );
    }
  }
  assert.equal(
    domGuards.length,
    18,
    "Keep all 16 null checks and two focus identity checks bounded",
  );
  for (const call of domGuards) {
    assert.ok(
      ts.isStringLiteral(call.arguments[1]) &&
        call.arguments[1].text.length > 0,
      "Each DOM guard needs an explicit fixed failure message",
    );
  }
});

test("every production DOM guard still fails with ERR_ASSERTION without inspecting its operands", () => {
  let inspected = 0;
  const hostile = Object.defineProperty({}, "mustNotInspect", {
    enumerable: true,
    get() {
      inspected++;
      throw new Error("DOM graph must not be inspected");
    },
  });
  for (const call of domGuards) {
    // Execute only the production assertion, with bounded mocks instead of a DOM.
    const evaluate = new Function(
      "assert",
      "document",
      "trigger",
      "selector",
      call.getText(file),
    );
    const isNullCheck =
      call.arguments[0].right.kind === ts.SyntaxKind.NullKeyword;
    for (const shouldPass of [false, true]) {
      const expected = {};
      const actual = shouldPass ? (isNullCheck ? null : expected) : hostile;
      const reads = [];
      const document = {
        get activeElement() {
          reads.push("actual");
          return actual;
        },
        querySelector() {
          reads.push("actual");
          return actual;
        },
      };
      const selector = () => {
        reads.push("expected");
        return expected;
      };
      if (shouldPass) evaluate(assert, document, expected, selector);
      else
        assert.throws(
          () => evaluate(assert, document, expected, selector),
          (error) => {
            assert.equal(error.code, "ERR_ASSERTION");
            assert.equal(error.actual, false);
            assert.equal(error.expected, true);
            assert.equal(error.message, call.arguments[1].text);
            return true;
          },
        );
      assert.deepEqual(
        reads,
        call.arguments[0].right.getText(file) === "selector()"
          ? ["actual", "expected"]
          : ["actual"],
        "Evaluate each original operand once, in order",
      );
    }
  }
  assert.equal(inspected, 0);
});
