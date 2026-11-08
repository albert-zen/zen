import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function fixture({ failPaint = false } = {}) {
  const source = await readFile(
    new URL("../scripts/capture-pending-shelf.cjs", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "capture.cjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const helper = ast.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "screenshot",
  );
  assert.ok(helper);
  const events = [];
  const screenshot = runInNewContext(helper.getText(ast) + ";screenshot;", {
    evaluate: async (expression) => {
      assert.equal(
        (expression.match(/requestAnimationFrame/g) ?? []).length,
        2,
      );
      assert.doesNotMatch(expression, /click\(|dispatchEvent|focus\(/);
      events.push("two-rendered-frames");
      if (failPaint) throw Error("Synthetic frame did not settle");
    },
    pause: async (duration) => {
      assert.equal(duration, 100);
      events.push("compositor-settlement");
    },
    window: {
      webContents: {
        capturePage: async () => {
          events.push("capture");
          return { toPNG: () => "synthetic-png-bytes" };
        },
      },
    },
    fs: {
      writeFile: async (path, bytes) => {
        assert.equal(path, "/synthetic/queue-source-opened.png");
        assert.equal(bytes, "synthetic-png-bytes");
        events.push("write");
      },
    },
    path: { join: (...parts) => parts.join("/") },
    directory: "/synthetic",
  });
  return { screenshot, events };
}

test("pending shelf screenshot waits for the asserted source state to paint", async () => {
  const f = await fixture();
  await f.screenshot("queue-source-opened");
  assert.deepEqual(f.events, [
    "two-rendered-frames",
    "compositor-settlement",
    "capture",
    "write",
  ]);
});

test("an unsettled frame cannot produce accepted shelf image evidence", async () => {
  const f = await fixture({ failPaint: true });
  await assert.rejects(f.screenshot("queue-source-opened"), /did not settle/);
  assert.deepEqual(f.events, ["two-rendered-frames"]);
});

for (const lang of ["zh", "en"]) {
  test(`native shelf capture asserts Steer before Queue (${lang})`, async () => {
    const source = await readFile(
      new URL("../scripts/capture-pending-shelf.cjs", import.meta.url),
      "utf8",
    );
    const ast = ts.createSourceFile(
      "capture.cjs",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    let assertion;
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === "assert.deepEqual" &&
        node.arguments[0]?.getText(ast) === "countLabels"
      )
        assertion = node;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(assertion, "Keep the exact native count/order assertion");
    const countLabels =
      lang === "zh"
        ? ["等待进入模型 · 2 条", "等待当前轮次结束 · 1 条"]
        : ["Waiting for the model · 2 messages", "After this turn · 1 message"];
    // Run the native capture's actual expression, including its localized counts.
    runInNewContext(assertion.getText(ast), {
      lang,
      countLabels,
      assert: {
        deepEqual: (actual, expected) =>
          assert.deepEqual([...actual], [...expected]),
      },
    });
    assert.throws(
      () =>
        runInNewContext(assertion.getText(ast), {
          lang,
          countLabels: [...countLabels].reverse(),
          assert: {
            deepEqual: (actual, expected) =>
              assert.deepEqual([...actual], [...expected]),
          },
        }),
      /Expected values/,
    );
  });
}
