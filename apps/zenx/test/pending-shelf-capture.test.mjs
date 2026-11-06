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
