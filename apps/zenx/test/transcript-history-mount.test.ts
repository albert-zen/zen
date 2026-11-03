import assert from "node:assert/strict";
import test from "node:test";
import { act, withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeThread,
  runtimeMessage,
} from "./fixtures/agent-runtime-data.js";
import { editComposer } from "../src/renderer/src/composer-state.js";
import { draft } from "./agent-runtime-dom.js";

function history(count: number, id = "history-thread") {
  const base = runtimeThread([], "completed", id);
  return {
    ...base,
    turns: Array.from({ length: count }, (_, index) => ({
      ...base.turns[0]!,
      id: `history-${index}`,
      items: [runtimeMessage(`answer-${index}`, `Synthetic answer ${index}`)],
    })),
  };
}

test("experimental initial mount retains full data and expands older DOM without replacing mounted rows", async () => {
  await withRuntimeDom(async (h) => {
    const thread = history(310);
    await h.render(thread);
    assert.equal(thread.turns.length, 310);
    assert.equal(document.querySelectorAll(".turn").length, 100);
    assert.match(
      document.querySelector(".turn")?.textContent ?? "",
      /Synthetic answer 210/u,
    );
    const retained = document.querySelector(".turn")!;
    const scroll = document.querySelector<HTMLElement>(".messages")!;
    scroll.scrollTop = 77;
    retained.getBoundingClientRect = () =>
      ({ top: document.querySelectorAll(".turn").length * 20 }) as DOMRect;
    const range = document.createRange();
    range.selectNodeContents(retained.querySelector(".agent-copy")!);
    await act(async () => document.getSelection()!.addRange(range));
    const selected = document.getSelection()!.anchorNode;
    await h.click(".load-earlier-transcript");
    assert.equal(document.querySelectorAll(".turn").length, 200);
    assert.ok(retained.isConnected);
    assert.equal(
      scroll.scrollTop,
      2077,
      "prepend corrects the measured anchor delta",
    );
    assert.equal(document.getSelection()!.anchorNode, selected);
    assert.equal(document.getSelection()!.isCollapsed, false);
    await h.render(thread, {
      composer: editComposer(draft, "New unsent draft"),
    });
    assert.ok(retained.isConnected);
    assert.equal(document.querySelectorAll(".turn").length, 200);
    assert.equal(thread.turns.length, 310);
  });
});

test("experimental mount also supports a read-only context preview without a target provider", async () => {
  await withRuntimeDom(async (h) => {
    const thread = history(310);
    await h.render(thread, { thread: null, contextPreview: thread });
    assert.equal(document.querySelectorAll(".turn").length, 100);
  });
});

test("experimental initial extent applies when authoritative history arrives after an empty viewport", async () => {
  await withRuntimeDom(async (h) => {
    await h.render(history(0));
    assert.equal(document.querySelectorAll(".turn").length, 0);
    await h.render(history(310));
    assert.equal(document.querySelectorAll(".turn").length, 100);
    assert.match(
      document.querySelector(".turn")?.textContent ?? "",
      /Synthetic answer 210/u,
    );
  });
});

test("experimental mount extent follows exact thread identity through navigation", async () => {
  await withRuntimeDom(async (h) => {
    const a = history(310);
    await h.render(a);
    await h.click(".load-earlier-transcript");
    await h.render(history(2, "other-thread"));
    assert.equal(document.querySelectorAll(".turn").length, 2);
    assert.equal(document.querySelector(".load-earlier-transcript"), null);
    await h.render(a);
    assert.equal(document.querySelectorAll(".turn").length, 200);
    await h.click(".load-earlier-transcript");
    await h.click(".load-earlier-transcript");
    assert.equal(document.querySelectorAll(".turn").length, 310);
    assert.equal(document.querySelector(".load-earlier-transcript"), null);
  });
});
