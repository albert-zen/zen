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

async function actualHelpers(names, globals) {
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
  const helpers = names.map((name) => {
    const helper = ast.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.ok(helper, name);
    return helper.getText(ast);
  });
  return runInNewContext(
    helpers.join("\n") + `;({${names.join(",")}});`,
    globals,
  );
}

async function clickFixture({ trusted = true, disabled = false } = {}) {
  const events = [];
  const browser = {};
  let listener;
  let delivery;
  let finishWrite;
  let busy = false;
  const target = {
    disabled,
    scrollIntoView() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
    contains: (element) => element === target,
    addEventListener(type, callback, options) {
      assert.equal(type, "click");
      assert.equal(options.capture, true);
      assert.equal(options.once, true);
      listener = callback;
    },
  };
  const refresh = {
    get disabled() {
      return busy;
    },
  };
  const document = {
    querySelector: (selector) =>
      selector.includes("Refresh information") ? refresh : target,
    elementFromPoint: () => target,
    elementsFromPoint: () => [target],
  };
  const result = { steps: [] };
  const helpers = await actualHelpers(["click", "settledLayout"], {
    query: (selector) => `document.querySelector(${JSON.stringify(selector)})`,
    clickSequence: 0,
    evaluate: async (expression) =>
      runInNewContext(expression, { document, window: browser }),
    until: async (check, label) => {
      if (await check()) return;
      if (delivery) {
        const dispatch = delivery;
        delivery = null;
        dispatch();
      } else if (finishWrite) {
        finishWrite();
        finishWrite = null;
      }
      assert.equal(await check(), true, label);
    },
    window: {
      show() {},
      focus() {},
      isFocused: () => true,
      webContents: {
        focus() {},
        isFocused: () => true,
        sendInputEvent(event) {
          events.push(event.type);
          if (event.type === "mouseUp")
            delivery = () => {
              events.push("DOM click delivered");
              listener({ isTrusted: trusted });
              busy = true;
              finishWrite = () => {
                busy = false;
                events.push("layout write settled");
              };
            };
        },
      },
    },
    result,
  });
  return { ...helpers, events, result };
}

test("native click waits for actual trusted delivery before layout idle can be observed", async () => {
  const f = await clickFixture();
  await f.click("button", "Hide one widget");
  assert.deepEqual(f.events, ["mouseDown", "mouseUp", "DOM click delivered"]);
  await f.settledLayout();
  assert.equal(f.events.at(-1), "layout write settled");
  assert.deepEqual(f.result.steps, ["Hide one widget"]);
});

test("synthetic click cannot acknowledge native delivery or trigger an input retry", async () => {
  const f = await clickFixture({ trusted: false });
  await assert.rejects(
    f.click("button", "Hide one widget"),
    /trusted native click delivered/,
  );
  assert.deepEqual(f.events, ["mouseDown", "mouseUp", "DOM click delivered"]);
  assert.deepEqual(f.result.steps, []);
});

test("disabled target still refuses native input rather than waiting or force clicking", async () => {
  const f = await clickFixture({ disabled: true });
  await assert.rejects(
    f.click("button", "Hide one widget"),
    /Obscured\/disabled/,
  );
  assert.deepEqual(f.events, []);
});

async function selectFixture(options = {}) {
  const events = [];
  class HTMLSelectElement {
    disabled = options.disabled ?? false;
    value = "";
    options = options.missing
      ? []
      : [{ value: "member", disabled: options.optionDisabled ?? false }];
    scrollIntoView() {}
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 20, height: 20 };
    }
    contains(element) {
      return element === this;
    }
    focus() {
      events.push("focus");
    }
    dispatchEvent(event) {
      events.push(event.type);
      if (event.type === "change" && options.rejected) this.value = "";
    }
  }
  const target = new HTMLSelectElement();
  const document = {
    querySelector: () => target,
    elementFromPoint: () => (options.obscured ? {} : target),
  };
  const result = { steps: [] };
  const helpers = await actualHelpers(["selectValue"], {
    query: (selector) => `document.querySelector(${JSON.stringify(selector)})`,
    evaluate: async (expression) =>
      runInNewContext(expression, {
        document,
        HTMLSelectElement,
        Event: class {
          constructor(type) {
            this.type = type;
          }
        },
      }),
    until: async (check, label) => assert.equal(await check(), true, label),
    settledLayout: async () => events.push("settled"),
    result,
  });
  return { ...helpers, events, target, result };
}

test("real select change path records its DOM-only boundary and observes the accepted control value", async () => {
  const f = await selectFixture();
  await f.selectValue("select", "member", "Source member");
  assert.deepEqual(f.events, ["focus", "input", "change", "settled"]);
  assert.equal(f.target.value, "member");
  assert.match(f.result.controlSelections[0].input, /not native OS popup/);
});

for (const options of [
  { disabled: true },
  { missing: true },
  { optionDisabled: true },
  { obscured: true },
]) {
  test(`select change retains availability and visibility guards: ${JSON.stringify(options)}`, async () => {
    const f = await selectFixture(options);
    await assert.rejects(
      f.selectValue("select", "member", "Source member"),
      /Unavailable|Obscured/,
    );
    assert.deepEqual(f.events, []);
    assert.equal(f.target.value, "");
  });
}

test("rejected controlled selection fails readback without retrying or bypassing the change handler", async () => {
  const f = await selectFixture({ rejected: true });
  await assert.rejects(
    f.selectValue("select", "member", "Source member"),
    /selection committed/,
  );
  assert.deepEqual(f.events, ["focus", "input", "change"]);
  assert.deepEqual(f.result.steps, []);
});
