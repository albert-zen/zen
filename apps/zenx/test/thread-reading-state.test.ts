import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeThread,
  runtimeCommand,
} from "./fixtures/agent-runtime-data.js";

const expanded = (selector: string) =>
  document.querySelector(selector)?.getAttribute("aria-expanded");

test("explicit turn, trace and tool choices survive a thread round trip", async () => {
  await withRuntimeDom(async (h) => {
    const a = runtimeThread(
      [runtimeCommand("one"), runtimeCommand("two")],
      "completed",
    );
    const b = {
      ...a,
      id: "thread-b",
      turns: [{ ...a.turns[0]!, id: "turn-b" }],
    };
    await h.render(a);
    await h.click(".turn-toggle");
    await h.click(".trace-toggle");
    await h.click(".trace-item-toggle");
    await h.render(b);
    assert.equal(expanded(".turn-toggle"), "false");
    await h.render(a);
    assert.equal(expanded(".turn-toggle"), "true");
    assert.equal(expanded(".trace-toggle"), "true");
    assert.equal(expanded(".trace-item-toggle"), "true");
  });
});

test("same Turn and Item IDs in another thread cannot inherit explicit choices", async () => {
  await withRuntimeDom(async (h) => {
    const a = runtimeThread(
      [runtimeCommand("one"), runtimeCommand("two")],
      "completed",
    );
    const b = { ...a, id: "thread-b" };
    await h.render(a);
    await h.click(".turn-toggle");
    await h.click(".trace-toggle");
    await h.click(".trace-item-toggle");
    await h.render(b);
    assert.equal(expanded(".turn-toggle"), "false");
    await h.click(".turn-toggle");
    assert.equal(expanded(".trace-toggle"), "false");
    await h.click(".trace-toggle");
    assert.equal(expanded(".trace-item-toggle"), "false");
    await h.render(a);
    assert.equal(expanded(".trace-item-toggle"), "true");
    await h.click(".trace-item-toggle");
    await h.click(".trace-toggle");
    await h.hide();
    await h.render(a);
    assert.equal(expanded(".turn-toggle"), "true");
    assert.equal(expanded(".trace-toggle"), "false");
    await h.click(".trace-toggle");
    assert.equal(expanded(".trace-item-toggle"), "false");
    await h.click(".turn-toggle");
    await h.hide();
    await h.render(a);
    assert.equal(expanded(".turn-toggle"), "false");
  });
});

test("repeated item IDs in different turns retain independent choices and promotion survives remount", async () => {
  await withRuntimeDom(async (h) => {
    const first = runtimeCommand("shared");
    const a = runtimeThread([first]);
    await h.render(a);
    await h.click(".trace-item-toggle");
    await h.hide();
    await h.render(runtimeThread([first, runtimeCommand("second")]));
    assert.equal(expanded(".trace-toggle"), "true");
    assert.equal(expanded(".trace-item-toggle"), "true");
    const later = { ...a, turns: [{ ...a.turns[0]!, id: "another-turn" }] };
    await h.render(later);
    assert.equal(expanded(".trace-item-toggle"), "false");
    await h.render(a);
    assert.equal(expanded(".trace-item-toggle"), "true");
  });
});
