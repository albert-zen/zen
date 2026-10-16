import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// These helpers return elements, whereas getAttribute/textContent/value/length
// projections are scalars and must remain valid equality assertion operands.
function isDomOperand(node) {
  if (!node) return false;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node)
  )
    return isDomOperand(node.expression);
  if (ts.isPropertyAccessExpression(node))
    return ["activeElement", "body", "documentElement"].includes(
      node.name.text,
    );
  if (!ts.isCallExpression(node)) return false;
  return ts.isPropertyAccessExpression(node.expression)
    ? ["querySelector", "getElementById", "closest", "createElement"].includes(
        node.expression.name.text,
      )
    : ts.isIdentifier(node.expression) &&
        ["dot", "failure"].includes(node.expression.text);
}
function inspect(source) {
  const file = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const direct = [],
    guards = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === "assert"
    ) {
      const method = node.expression.name.text;
      if (
        ["equal", "strictEqual", "deepEqual", "deepStrictEqual"].includes(
          method,
        ) &&
        node.arguments.slice(0, 2).some(isDomOperand)
      )
        direct.push(node);
      const condition = node.arguments[0];
      if (
        method === "ok" &&
        condition &&
        ts.isBinaryExpression(condition) &&
        condition.operatorToken.kind ===
          ts.SyntaxKind.EqualsEqualsEqualsToken &&
        [condition.left, condition.right].some(isDomOperand)
      )
        guards.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { file, direct, guards };
}
for (const [name, count] of [
  ["sidebar-information-interaction", 25],
  ["thread-end-unread", 2],
]) {
  const source = readFileSync(
    new URL(`./${name}.test.ts`, import.meta.url),
    "utf8",
  );
  test(`${name} keeps every DOM identity/null failure bounded`, () => {
    const { file, direct, guards } = inspect(source);
    assert.deepEqual(
      direct.map(
        (node) =>
          file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      ),
      [],
      "DOM objects must not enter equality failure formatting",
    );
    assert.equal(guards.length, count);
    for (const call of guards) {
      assert.ok(
        ts.isStringLiteral(call.arguments[1]) &&
          call.arguments[1].text.length > 0,
        "DOM guards need fixed readable failure messages",
      );
      const condition = call.arguments[0];
      // Safe source-only mutation: restoring each old direct assertion must be
      // detected without constructing a real DOM or invoking its formatter.
      const mutant = `assert.equal(${condition.left.getText(file)}, ${condition.right.getText(file)})`;
      assert.equal(inspect(mutant).direct.length, 1);
    }
  });
}
test("DOM contract permits scalar projections and detects selector helpers", () => {
  const scalar = `assert.equal(document.querySelector('input')?.value, 'draft'); assert.equal(document.querySelectorAll('span').length, 1); assert.equal(failure()?.getAttribute('aria-label'), 'Failed'); assert.equal(document.activeElement === row, true);`;
  assert.equal(inspect(scalar).direct.length, 0);
  for (const operand of [
    "dot('b')",
    "failure()",
    "document.querySelector('span')",
    "document.activeElement",
  ])
    assert.equal(inspect(`assert.equal(${operand}, null)`).direct.length, 1);
});
test("boolean failures preserve ERR_ASSERTION without inspecting element graphs", () => {
  let inspected = 0;
  const element = Object.defineProperty({}, "fiber", {
    enumerable: true,
    get() {
      inspected++;
      throw new Error("Unexpected DOM inspection");
    },
  });
  for (const expected of [null, {}])
    assert.throws(
      () =>
        assert.ok(element === expected, "Expected element identity or absence"),
      (error) =>
        error.code === "ERR_ASSERTION" &&
        error.actual === false &&
        error.expected === true,
    );
  assert.equal(inspected, 0);
});
