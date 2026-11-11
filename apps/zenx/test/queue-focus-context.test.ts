import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { revealQueueFocusContext } from "../src/renderer/src/queue-focus-context.js";

function fixture(rowTop: number, rowHeight: number, focusTop: number) {
  const dom = new JSDOM(
    `<main><div class="pending-tray" style="scroll-padding-block-start:64px"><section class="queue-shelf"><header class="queue-shelf-header"></header><div class="queue-row"><button>Send now</button></div></section></div><button id="outside">Outside</button></main>`,
  );
  const doc = dom.window.document;
  const tray = doc.querySelector<HTMLElement>(".pending-tray")!;
  const row = doc.querySelector<HTMLElement>(".queue-row")!;
  const target = doc.querySelector<HTMLButtonElement>(".queue-row button")!;
  const rectangle = (top: number, height: number) =>
    ({ top, bottom: top + height, height }) as DOMRect;
  tray.getBoundingClientRect = () => rectangle(100, 240);
  row.getBoundingClientRect = () => rectangle(rowTop, rowHeight);
  target.getBoundingClientRect = () => rectangle(focusTop, 28);
  doc.querySelector<HTMLElement>("header")!.getBoundingClientRect = () =>
    rectangle(100, 32);
  Object.defineProperties(tray, {
    clientHeight: { value: 240 },
    scrollHeight: { value: 1000 },
  });
  tray.scrollTop = 100;
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  return {
    tray,
    target,
    doc,
    close() {
      globalThis.getComputedStyle = previous;
      dom.window.close();
    },
  };
}

for (const [label, rowTop, rowHeight, focusTop, expected] of [
  ["message above sticky clearance", 150, 60, 180, 84],
  ["message clipped below tray", 300, 60, 305, 122],
  ["fully visible row unchanged", 180, 60, 185, 100],
  ["oversized row keeps visible action stable", 120, 400, 200, 100],
  ["oversized row reveals hidden action", 120, 400, 350, 140],
] as const) {
  test(label, () => {
    const f = fixture(rowTop, rowHeight, focusTop);
    try {
      f.target.focus();
      revealQueueFocusContext(f.target);
      assert.equal(f.tray.scrollTop, expected);
      assert.equal(f.doc.activeElement, f.target);
      assert.equal(f.doc.querySelector("main")!.scrollTop, 0);
    } finally {
      f.close();
    }
  });
}

test("unrelated focus does not scroll a queue", () => {
  const f = fixture(150, 60, 180);
  try {
    revealQueueFocusContext(f.doc.getElementById("outside")!);
    assert.equal(f.tray.scrollTop, 100);
  } finally {
    f.close();
  }
});
