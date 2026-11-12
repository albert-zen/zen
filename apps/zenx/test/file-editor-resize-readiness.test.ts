import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
const { fileEditorResizeState, fileEditorResizeEvents } = createRequire(
  import.meta.url,
)("../scripts/file-editor-resize-readiness.cjs");

test("native resize sends no input until measured bounds and exposed split maximum agree", () => {
  const dom = new JSDOM(
    '<aside class="auxiliary-panel"><div class="auxiliary-body" style="display:flex;flex-direction:row"><div class="workspace-file-resizer" aria-orientation="vertical" aria-valuemax="279" aria-valuenow="192"></div></div></aside>',
  );
  const document = dom.window.document;
  const panel = document.querySelector(".auxiliary-panel")!;
  const body = document.querySelector(".auxiliary-body")!;
  const separator = document.querySelector(".workspace-file-resizer")!;
  panel.getBoundingClientRect = () => ({ width: 600 }) as DOMRect;
  body.getBoundingClientRect = () =>
    ({ x: 801, y: 44, width: 599, height: 856 }) as DOMRect;
  const sent: unknown[] = [];
  const drag = () => {
    const state = fileEditorResizeState(document);
    for (const event of fileEditorResizeEvents(
      state,
      { x: 993, y: 472 },
      407,
      256,
    ))
      sent.push(event);
  };
  try {
    const stale = fileEditorResizeState(document);
    assert.equal(stale.ready, false);
    assert.equal(stale.maximum, 279);
    assert.equal(stale.expectedMaximum, 359);
    assert.throws(drag, /not ready/);
    assert.equal(
      sent.length,
      0,
      "Not even mouseDown is sent with the old ResizeObserver limit",
    );
    // An animated pane can agree with ResizeObserver before reaching its target.
    panel.getBoundingClientRect = () => ({ width: 599.9375 }) as DOMRect;
    body.getBoundingClientRect = () =>
      ({ x: 801.0625, y: 44, width: 598.9375, height: 856 }) as DOMRect;
    separator.setAttribute("aria-valuemax", "358.9375");
    const moving = fileEditorResizeState(document);
    assert.equal(moving.maximum, moving.expectedMaximum);
    assert.equal(moving.ready, false, "The last animated pixel is not settled");
    assert.throws(drag, /not ready/);
    assert.equal(sent.length, 0, "No native input while outer width is moving");
    panel.getBoundingClientRect = () => ({ width: 600 }) as DOMRect;
    body.getBoundingClientRect = () =>
      ({ x: 801, y: 44, width: 599, height: 856 }) as DOMRect;
    separator.setAttribute("aria-valuemax", "359");
    assert.equal(fileEditorResizeState(document).ready, true);
    drag();
    assert.deepEqual(sent, [
      { type: "mouseMove", x: 993, y: 472 },
      { type: "mouseDown", button: "left", clickCount: 1, x: 993, y: 472 },
      {
        type: "mouseMove",
        button: "left",
        modifiers: ["leftButtonDown"],
        x: 1144,
        y: 472,
      },
      { type: "mouseUp", button: "left", clickCount: 1, x: 1144, y: 472 },
    ]);
    separator.setAttribute("aria-orientation", "horizontal");
    assert.equal(fileEditorResizeState(document).ready, false);
    assert.throws(drag, /not ready/);
    assert.equal(sent.length, 4);
    panel.getBoundingClientRect = () => ({ width: 520 }) as DOMRect;
    separator.setAttribute("aria-orientation", "vertical");
    assert.equal(fileEditorResizeState(document).ready, false);
    assert.throws(drag, /not ready/);
    assert.equal(sent.length, 4);
  } finally {
    dom.window.close();
  }
});
