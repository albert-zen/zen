import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { waitForFocus } from "./wait-for-focus.js";

function harness(t: TestContext) {
  const dom = new JSDOM("<button>Target</button>");
  const target = dom.window.document.querySelector("button")!;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const add = t.mock.method(target, "addEventListener");
  const remove = t.mock.method(target, "removeEventListener");
  const clear = t.mock.method(globalThis, "clearTimeout");
  t.after(() => {
    t.mock.restoreAll();
    t.mock.timers.reset();
    dom.window.close();
  });
  const assertCleaned = () => {
    assert.equal(add.mock.callCount(), 1);
    assert.equal(remove.mock.callCount(), 1);
    assert.ok(
      add.mock.calls[0]?.arguments[1] === remove.mock.calls[0]?.arguments[1],
      "The registered focus listener is removed",
    );
    assert.equal(clear.mock.callCount(), 1);
  };
  return { dom, target, add, remove, clear, assertCleaned };
}

test("focus wait resolves immediately when the target is already focused", async (t) => {
  const { target, add, remove, clear } = harness(t);
  target.focus();
  await waitForFocus(target);
  assert.equal(add.mock.callCount(), 0);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(clear.mock.callCount(), 0);
});

test("focus wait resolves on actual focus and cleans up listener and timer", async (t) => {
  const { target, assertCleaned } = harness(t);
  const waiting = waitForFocus(target, 100);
  target.focus();
  await waiting;
  assertCleaned();
  t.mock.timers.tick(100);
});

test("focus wait rejects missing restoration and cleans up listener and timer", async (t) => {
  const { dom, target, assertCleaned } = harness(t);
  const waiting = waitForFocus(target, 100);
  const rejected = assert.rejects(waiting, {
    message: "Focus was not restored within 100 ms",
  });
  // A synthetic event without actual focus must not satisfy the condition.
  target.dispatchEvent(new dom.window.FocusEvent("focus"));
  t.mock.timers.tick(100);
  await rejected;
  assertCleaned();
});
