import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { blobHash, patchedBlob } from "../scripts/prepare-legend-list.mjs";

// Execute the exact prepared web ESM hook in a real React component. This is
// deterministic DOM/selection semantics, not native macOS input acceptance.
const modulePath = fileURLToPath(import.meta.resolve("@legendapp/list/react"));
const bytes = readFileSync(modulePath);
assert.equal(basename(modulePath), "react.mjs");
assert.equal(blobHash(bytes), patchedBlob);
const source = bytes.toString();
const start = source.indexOf("// src/utils/reordering.ts");
const end = source.indexOf("function useFreshDataTransitionVisibility", start);
assert.ok(start > 0 && end > start);
const hookSource = source.slice(start, end);

async function fixture(t, run) {
  const dom = new JSDOM(
    "<p id='before'>outside before</p><div id='root'></div><p id='after'>outside after</p>",
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const ctx = { state: {}, epoch: 0, viewRefs: new Map(), values: new Map() };
  const parent = React.createRef();
  const refs = Array.from({ length: 6 }, (_, i) => {
    const ref = React.createRef();
    ctx.viewRefs.set(i, ref);
    ctx.values.set(`containerItemIndex${i}`, i);
    return ref;
  });
  const useDOMOrder = new Function(
    "useStateContext",
    "useArr$",
    "useRef",
    "useLayoutEffect",
    "useEffect",
    "peek$",
    `${hookSource}\nreturn useDOMOrder;`,
  )(
    () => ctx,
    () => [ctx.epoch],
    React.useRef,
    React.useLayoutEffect,
    React.useEffect,
    (context, key) => context.values.get(key),
  );
  function Component() {
    useDOMOrder(parent);
    return React.createElement(
      "div",
      { ref: parent },
      refs.map((ref, i) =>
        React.createElement(
          "section",
          { key: i, ref, "data-slot": i },
          React.createElement("article", null, `synthetic row ${i} text`),
        ),
      ),
    );
  }
  const root = createRoot(document.getElementById("root"));
  const activeListeners = new Set();
  const addListener = document.addEventListener.bind(document);
  const removeListener = document.removeEventListener.bind(document);
  document.addEventListener = (type, listener, options) => {
    if (type === "selectionchange") activeListeners.add(listener);
    return addListener(type, listener, options);
  };
  document.removeEventListener = (type, listener, options) => {
    if (type === "selectionchange") activeListeners.delete(listener);
    return removeListener(type, listener, options);
  };
  const render = async () => {
    await act(async () => root.render(React.createElement(Component)));
  };
  await render();
  const selection = document.getSelection();
  const text = (i) => refs[i].current.firstChild.firstChild;
  const select = (anchor, a, focus = anchor, f = 8) => {
    selection.setBaseAndExtent(anchor, a, focus, f);
    return { anchor, a, focus, f, text: selection.toString() };
  };
  const assertSelection = (saved) => {
    assert.equal(
      selection.anchorNode === saved.anchor,
      true,
      "anchor node retained",
    );
    assert.equal(
      selection.focusNode === saved.focus,
      true,
      "focus node retained",
    );
    assert.equal(selection.anchorOffset, saved.a);
    assert.equal(selection.focusOffset, saved.f);
    assert.equal(selection.toString(), saved.text);
  };
  const reorder = async (indices = [5, 0, 1, 2, 3, 4]) => {
    indices.forEach((value, i) =>
      ctx.values.set(`containerItemIndex${i}`, value),
    );
    ctx.epoch++;
    await render();
  };
  const order = () =>
    [...parent.current.children].map((node) => Number(node.dataset.slot));
  const selectionChange = async () => {
    await act(async () =>
      document.dispatchEvent(new dom.window.Event("selectionchange")),
    );
  };
  const clear = async () => {
    selection.removeAllRanges();
    await selectionChange();
    await act(async () => t.mock.timers.tick(150));
  };
  let unmounted = false;
  const unmount = async () => {
    await act(async () => root.unmount());
    unmounted = true;
  };
  try {
    await run({
      ctx,
      parent,
      refs,
      selection,
      text,
      select,
      assertSelection,
      reorder,
      order,
      clear,
      selectionChange,
      unmount,
      activeListeners,
      addRow: async (index) => {
        const i = refs.length,
          ref = React.createRef();
        refs.push(ref);
        ctx.viewRefs.set(i, ref);
        ctx.values.set(`containerItemIndex${i}`, index);
        ctx.epoch++;
        await render();
      },
      tick: async (ms) => {
        await act(async () => t.mock.timers.tick(ms));
      },
    });
  } finally {
    if (!unmounted) await unmount();
    t.mock.timers.reset();
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

for (const direction of ["forward", "backward"]) {
  test(`owned ${direction} selection defers actual ESM sorting until release`, async (t) =>
    fixture(t, async (f) => {
      const saved = f.select(
        f.text(0),
        direction === "forward" ? 2 : 8,
        f.text(0),
        direction === "forward" ? 8 : 2,
      );
      await f.reorder();
      f.assertSelection(saved);
      assert.deepEqual(f.order(), [0, 1, 2, 3, 4, 5]);
      await f.clear();
      assert.deepEqual(f.order(), [1, 2, 3, 4, 5, 0]);
    }));
}
test("multi-row and cross-boundary ranges defer sorting even with an outside anchor", async (t) =>
  fixture(t, async (f) => {
    for (const [anchor, focus] of [
      [f.text(0), f.text(2)],
      [document.getElementById("before").firstChild, f.text(1)],
      [
        document.getElementById("before").firstChild,
        document.getElementById("after").firstChild,
      ],
    ]) {
      const saved = f.select(anchor, 1, focus, 8);
      await f.reorder();
      f.assertSelection(saved);
      assert.deepEqual(f.order(), [0, 1, 2, 3, 4, 5]);
    }
    await f.clear();
    assert.deepEqual(f.order(), [1, 2, 3, 4, 5, 0]);
  }));
test("external selection and a collapsed caret do not block DOM order", async (t) =>
  fixture(t, async (f) => {
    const saved = f.select(document.getElementById("before").firstChild, 1);
    await f.reorder();
    f.assertSelection(saved);
    assert.deepEqual(f.order(), [1, 2, 3, 4, 5, 0]);
    f.select(f.text(1), 1, f.text(1), 1);
    await f.reorder([0, 1, 2, 3, 4, 5]);
    assert.deepEqual(f.order(), [0, 1, 2, 3, 4, 5]);
  }));
test("deferred work uses the latest indices and selection release respects active scrolling", async (t) =>
  fixture(t, async (f) => {
    const saved = f.select(f.text(0), 1);
    await f.reorder();
    await f.reorder([4, 5, 0, 1, 2, 3]);
    f.assertSelection(saved);
    f.ctx.state.userScrollPrevTime = 950;
    f.ctx.state.userScrollTime = 1000;
    f.selection.removeAllRanges();
    await f.selectionChange();
    assert.deepEqual(f.order(), [0, 1, 2, 3, 4, 5]);
    await f.tick(149);
    assert.deepEqual(f.order(), [0, 1, 2, 3, 4, 5]);
    await f.tick(1);
    assert.deepEqual(f.order(), [2, 3, 4, 5, 0, 1]);
  }));
test("a selection created during a pending scroll timer is protected", async (t) =>
  fixture(t, async (f) => {
    f.ctx.state.userScrollPrevTime = 950;
    f.ctx.state.userScrollTime = 1000;
    await f.reorder();
    const saved = f.select(f.text(0), 1);
    await f.tick(150);
    f.assertSelection(saved);
    assert.deepEqual(f.order(), [0, 1, 2, 3, 4, 5]);
    await f.clear();
    assert.deepEqual(f.order(), [1, 2, 3, 4, 5, 0]);
  }));
test("unmount clears pending timers and document selection listeners", async (t) =>
  fixture(t, async (f) => {
    f.ctx.state.userScrollPrevTime = 950;
    f.ctx.state.userScrollTime = 1000;
    await f.reorder();
    const old = f.parent.current;
    let moves = 0;
    old.insertBefore = () => {
      moves++;
      throw new Error("sort after unmount");
    };
    old.appendChild = () => {
      moves++;
      throw new Error("sort after unmount");
    };
    assert.equal(f.activeListeners.size, 1);
    await f.unmount();
    assert.equal(f.activeListeners.size, 0);
    await f.tick(1000);
    await f.selectionChange();
    assert.equal(moves, 0);
  }));

test("new mounted rows remain ordered after selection release without losing ownership", async (t) =>
  fixture(t, async (f) => {
    const saved = f.select(f.text(0), 1);
    await f.reorder();
    await f.addRow(-1);
    f.assertSelection(saved);
    assert.deepEqual(f.order(), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(
      f.activeListeners.size,
      1,
      "superseded layout listeners removed",
    );
    await f.clear();
    assert.deepEqual(f.order(), [6, 1, 2, 3, 4, 5, 0]);
  }));
