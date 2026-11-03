import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function fixture(options = {}) {
  const source = await readFile(
    new URL("../scripts/capture-information-board.cjs", import.meta.url),
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
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "replaceNativeFieldText",
  );
  assert.ok(helper);
  const state = {
    value: "second saved value",
    start: 18,
    end: 18,
    selections: 0,
    inserts: 0,
  };
  const input = Object.defineProperties(
    {},
    {
      value: { get: () => state.value },
      selectionStart: { get: () => state.start },
      selectionEnd: { get: () => state.end },
    },
  );
  const document = {
    activeElement: null,
    querySelector: () => input,
  };
  const events = [];
  const replace = runInNewContext(
    helper.getText(ast) + ";replaceNativeFieldText;",
    {
      query: (selector) =>
        `document.querySelector(${JSON.stringify(selector)})`,
      click: async () => {
        events.push("click");
        document.activeElement = options.noFocus ? {} : input;
      },
      evaluate: async (expression) => runInNewContext(expression, { document }),
      until: async (check, label) => {
        assert.equal(await check(), true, label);
      },
      window: {
        webContents: {
          selectAll() {
            events.push("native-select-all");
            state.selections++;
            if (!options.noSelection) {
              state.start = 0;
              state.end = state.value.length;
            }
          },
          async insertText(text) {
            events.push("native-insert");
            state.inserts++;
            state.value =
              state.value.slice(0, state.start) +
              text +
              state.value.slice(state.end) +
              (options.wrongInsertion ? "unexpected" : "");
          },
        },
      },
    },
  );
  return { replace, state, events };
}

test("actual native driver replaces through editing commands without assigning DOM state", async () => {
  const f = await fixture();
  await f.replace(".second-board input", "second native draft only");
  assert.equal(f.state.value, "second native draft only");
  assert.deepEqual(f.events, ["click", "native-select-all", "native-insert"]);
  assert.equal(f.state.inserts, 1);
});

test("native replacement refuses insertion without observed owned field focus", async () => {
  const f = await fixture({ noFocus: true });
  await assert.rejects(f.replace("input", "replacement"), /native focus/);
  assert.equal(f.state.selections, 0);
  assert.equal(f.state.inserts, 0);
});

test("native replacement refuses insertion until the complete native selection is observed", async () => {
  const f = await fixture({ noSelection: true });
  await assert.rejects(
    f.replace("input", "replacement"),
    /complete owned field/,
  );
  assert.equal(f.state.selections, 1);
  assert.equal(f.state.inserts, 0);
});

test("a wrong native insertion fails exact UI readback without another insert", async () => {
  const f = await fixture({ wrongInsertion: true });
  await assert.rejects(f.replace("input", "replacement"), /exact field value/);
  assert.equal(f.state.inserts, 1);
});
