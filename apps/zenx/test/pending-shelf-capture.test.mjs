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

async function queueFixtureItems(many) {
  const [source, data] = await Promise.all(
    ["queue-steer-visual.tsx", "agent-queue-data.ts"].map((name) =>
      readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
    ),
  );
  const ast = ts.createSourceFile(
    "fixture.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const dataAst = ts.createSourceFile(
    "data.ts",
    data,
    ts.ScriptTarget.Latest,
    true,
  );
  const queueItem = dataAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "queueItem",
  );
  assert.ok(queueItem);
  // Execute the fixture's real queue declarations without mounting its UI.
  const declarations = ast.statements.filter(
    (node) =>
      (ts.isExpressionStatement(node) &&
        node.getText(ast).startsWith("initial = applyQueueItem(")) ||
      (ts.isIfStatement(node) &&
        node.expression.getText(ast) === 'params.has("many")'),
  );
  const items = [];
  runInNewContext(
    ts.transpileModule(
      `${queueItem.getText(dataAst).replace(/^export /u, "")}\n${declarations.map((node) => node.getText(ast)).join("\n")}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      initial: { id: "runtime-thread" },
      zh: true,
      params: new URLSearchParams(many ? "many=1" : ""),
      applyQueueItem: (thread, item) => {
        items.push(item);
        return thread;
      },
    },
  );
  return JSON.parse(JSON.stringify(items));
}

for (const many of [false, true]) {
  test(`native shelf fixture has exact editable Queue targets (many=${many})`, async () => {
    const items = await queueFixtureItems(many);
    const queue = items.filter((item) => item.deliveryMode !== "steer");
    assert.equal(queue[0].id, "synthetic-thread-message");
    assert.equal(queue[0].type, "thread_message_queued");
    assert.equal(
      items.filter((item) => item.deliveryMode === "steer").length,
      2,
    );
    assert.deepEqual(
      queue
        .filter((item) => item.type === "user_message_queued")
        .map((item) => [item.id, item.clientId]),
      many
        ? [1, 2, 3, 4, 5].map((index) => [
            `queue-${index}`,
            `queue-client-${index}`,
          ])
        : [],
    );
  });
}

test("native shelf editor asserts the selected many-fixture message, not another row", async () => {
  const source = await readFile(
    new URL("../scripts/capture-pending-shelf.cjs", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "capture.cjs",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let textAssertion;
  let identityAssertion;
  let selector;
  let loadOptions;
  let clicksExactTarget = false;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "assert.equal" &&
      node.arguments[0]?.getText(ast) === "editor.text"
    )
      textAssertion = node;
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "assert.equal" &&
      node.arguments[0]?.getText(ast) === "editor.identity"
    )
      identityAssertion = node;
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === "queueEditSelector"
    )
      selector = runInNewContext(node.initializer.getText(ast));
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "window.loadFile" &&
      node.arguments[1]?.getText(ast).includes('many: "1"')
    )
      loadOptions = runInNewContext(`(${node.arguments[1].getText(ast)})`);
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "click" &&
      node.arguments[0]?.getText(ast) === "queueEditSelector"
    )
      clicksExactTarget = true;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(textAssertion, "Keep the exact native editor text assertion");
  assert.ok(
    identityAssertion,
    "Keep the exact native editor identity assertion",
  );
  assert.equal(loadOptions?.query.many, "1");
  assert.equal(loadOptions.query.lang, "zh");
  assert.equal(clicksExactTarget, true);
  const items = await queueFixtureItems(loadOptions.query.many === "1");
  const selected = items.find((item) => item.id === "queue-1");
  assert.ok(selected);
  assert.equal(selector, `[data-queue-id="${selected.id}"] .queue-row-edit`);
  const check = (text) =>
    runInNewContext(textAssertion.getText(ast), { assert, editor: { text } });
  check(selected.input[0].text);
  const checkIdentity = (id, clientId) =>
    runInNewContext(identityAssertion.getText(ast), {
      assert,
      editor: {
        identity: JSON.stringify([
          JSON.stringify([selected.threadId, id, clientId]),
          0,
        ]),
      },
    });
  checkIdentity(selected.id, selected.clientId);
  const other = items.find((item) => item.id === "queue-2");
  assert.ok(other);
  assert.throws(() => check(other.input[0].text), /Expected values/u);
  assert.throws(
    () => checkIdentity(other.id, other.clientId),
    /Expected values/u,
  );
  assert.throws(
    () => checkIdentity(selected.id, other.clientId),
    /Expected values/u,
  );
});
