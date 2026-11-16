import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSteerGeometry,
  assertSteerWheelReceipt,
} from "../scripts/steer-image-geometry.mjs";

// Pure guard tests only. These numbers are NOT browser evidence.
const geometry = () => ({
  overflow: false,
  rails: { desktop: false },
  normal: {
    bubble: { right: 350 },
    text: "Question?",
    images: [{ width: 96, height: 72, right: 350 }],
  },
  pending: {
    bubble: { right: 350 },
    text: "Question?",
    separate: true,
    images: [{ width: 96, height: 72, right: 350 }],
  },
});
test("geometry guards accept aligned bounded canonical and steer measurements", () => {
  assertSteerGeometry(geometry(), 1, "synthetic guard input");
});
for (const [name, change] of [
  [
    "oversized thumbnail",
    (g) => {
      g.pending.images[0].width = 600;
    },
  ],
  [
    "body misalignment",
    (g) => {
      g.pending.bubble.right -= 20;
    },
  ],
  [
    "image misalignment",
    (g) => {
      g.pending.images[0].right -= 20;
    },
  ],
  [
    "missing question bubble",
    (g) => {
      g.pending.bubble = null;
    },
  ],
  [
    "images inside body bubble",
    (g) => {
      g.pending.separate = false;
    },
  ],
  [
    "truncated body",
    (g) => {
      g.pending.text = "Question";
    },
  ],
  [
    "horizontal overflow",
    (g) => {
      g.overflow = true;
    },
  ],
])
  test(`geometry guards reject ${name}`, () => {
    const g = geometry();
    change(g);
    assert.throws(() => assertSteerGeometry(g, 1, "synthetic guard input"));
  });

import { JSDOM } from "jsdom";
import {
  measureSteerComparison,
  assertSteerDisclosure,
} from "../scripts/steer-image-geometry.mjs";
import { measureBubbleVisibility } from "../scripts/steer-image-visibility.mjs";

test("DOM probe compares complete long body, excluding its disclosure summary", () => {
  const dom = new JSDOM(
    `<article data-sent-message-id="synthetic-normal"><div class="user-bubble"></div></article><section class="pending-steer-panel"><ol><li><div class="user-bubble"><details class="pending-steer-message"><summary></summary><div class="pending-steer-text"></div></details></div></li></ol></section>`,
  );
  const doc = dom.window.document;
  const text = "Synthetic question?\n".repeat(20);
  doc.querySelector("article .user-bubble").textContent = text;
  doc.querySelector(".pending-steer-text").textContent = text;
  doc.querySelector("summary").textContent = text.slice(0, 240) + "…";
  let g = measureSteerComparison(doc);
  assert.equal(g.normal.text, g.pending.text);
  assert.notEqual(
    doc.querySelector("li .user-bubble").textContent,
    g.pending.text,
  );
  assert.throws(() => assertSteerDisclosure(g, true, "collapsed"));
  doc.querySelector("details").open = true;
  g = measureSteerComparison(doc);
  assertSteerDisclosure(g, true, "opened");
  g.pending.disclosure.summary = text;
  assert.throws(() => assertSteerDisclosure(g, true, "bad summary"));
  dom.window.close();
});

test("short body contract requires no unnecessary disclosure", () => {
  const g = geometry();
  g.pending.disclosure = null;
  assertSteerDisclosure(g, false, "short");
  g.pending.disclosure = { open: true, summary: "Question?" };
  assert.throws(() => assertSteerDisclosure(g, false, "short"));
});

test("bubble visibility probe rejects hidden or obscured bodies, allows clipped long body region", () => {
  const prior = Object.fromEntries(
    ["innerWidth", "innerHeight", "getComputedStyle", "document"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  const box = {
    left: 10,
    right: 110,
    top: 10,
    bottom: 1010,
    width: 100,
    height: 1000,
  };
  const element = {
    getBoundingClientRect: () => box,
    parentElement: null,
    contains: () => false,
  };
  let hidden = false,
    blocked = false;
  Object.assign(globalThis, {
    innerWidth: 390,
    innerHeight: 600,
    getComputedStyle: () => ({
      display: hidden ? "none" : "block",
      visibility: "visible",
      opacity: "1",
      overflowX: "visible",
      overflowY: "visible",
    }),
    document: { elementFromPoint: () => (blocked ? {} : element) },
  });
  try {
    assert.equal(measureBubbleVisibility(element).visible, true);
    hidden = true;
    assert.equal(measureBubbleVisibility(element).visible, false);
    hidden = false;
    blocked = true;
    assert.equal(measureBubbleVisibility(element).visible, false);
  } finally {
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("reader scrolling requires trusted delivery and observed progress before another input", () => {
  const valid = {
    pointerCommandAcknowledged: true,
    pointerEvent: { trusted: true, inTranscript: true },
    settled: true,
    commandAcknowledged: true,
    before: 500,
    after: 100,
    event: { trusted: true, inTranscript: true, deltaY: -400 },
  };
  assert.doesNotThrow(() => assertSteerWheelReceipt(valid));
  assert.throws(
    () =>
      assertSteerWheelReceipt({ ...valid, pointerCommandAcknowledged: false }),
    /pointer command outcome unknown/,
  );
  assert.throws(
    () => assertSteerWheelReceipt({ ...valid, pointerEvent: null }),
    /pointer movement not observed/,
  );
  assert.throws(
    () => assertSteerWheelReceipt({ ...valid, settled: false }),
    /did not settle/,
  );
  assert.throws(
    () => assertSteerWheelReceipt({ ...valid, commandAcknowledged: false }),
    /unknown/,
  );
  assert.throws(
    () => assertSteerWheelReceipt({ ...valid, event: null }),
    /trusted/,
  );
  assert.throws(
    () =>
      assertSteerWheelReceipt({
        ...valid,
        event: { ...valid.event, inTranscript: false },
      }),
    /another surface/,
  );
  assert.throws(
    () => assertSteerWheelReceipt({ ...valid, after: 500 }),
    /no observed/,
  );
  assert.throws(
    () => assertSteerWheelReceipt({ ...valid, after: 700 }),
    /no observed/,
  );
});

test("image acceptance remains visibility-based when layout shifts an idle offset", async () => {
  const { measureImageVisibility } =
    await import("../scripts/steer-image-visibility.mjs");
  const keys = ["innerWidth", "innerHeight", "getComputedStyle", "document"];
  const prior = Object.fromEntries(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  let top = 34;
  const viewport = {
    parentElement: null,
    getBoundingClientRect: () => ({
      left: 0,
      right: 390,
      top: 40,
      bottom: 700,
    }),
  };
  const image = {
    complete: true,
    naturalWidth: 480,
    parentElement: viewport,
    contains: () => false,
    getBoundingClientRect: () => ({
      left: 269,
      right: 363,
      top,
      bottom: top + 70,
      width: 94,
      height: 70,
    }),
  };
  Object.assign(globalThis, {
    innerWidth: 390,
    innerHeight: 700,
    document: { elementFromPoint: () => image },
    getComputedStyle: (node) => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      overflowX: "visible",
      overflowY: node === viewport ? "auto" : "visible",
    }),
  });
  try {
    const shifted = measureImageVisibility(image);
    assert.equal(shifted.visible, true);
    assert.equal(shifted.coverage, 64 / 70);
    top = 32;
    assert.equal(
      measureImageVisibility(image).visible,
      false,
      "below 90% remains a failure",
    );
  } finally {
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

for (const className of ["bottom-zone", "pending-tray"]) {
  test(`DOM probe detects horizontal overflow inside ${className}`, () => {
    const dom = new JSDOM(`<div class="${className}"></div>`);
    const element = dom.window.document.querySelector("div");
    Object.defineProperties(element, {
      clientWidth: { value: 390 },
      scrollWidth: { value: 402, configurable: true },
    });
    assert.equal(measureSteerComparison(dom.window.document).overflow, true);
    Object.defineProperty(element, "scrollWidth", { value: 390 });
    assert.equal(measureSteerComparison(dom.window.document).overflow, false);
    dom.window.close();
  });
}

// Synthetic guard values exercise independent rails, not rendered acceptance.
const desktopGeometry = (gutter = 15) => {
  const right = 350 - 1 - gutter;
  return {
    overflow: false,
    rails: {
      desktop: true,
      tray: { left: 0, right: 350, width: 350 },
      composer: { left: 0, right: 350 },
      canonicalColumn: { left: 0, right: 350 },
      clientLeft: 1,
      clientWidth: 348 - gutter,
      offsetWidth: 350,
      borderLeft: 1,
      borderRight: 1,
      paddingLeft: 0,
      paddingRight: 0,
    },
    normal: {
      row: { left: 0, right: 350 },
      bubble: { right: 350 },
      text: "Question?",
      images: [{ width: 96, height: 72, right: 350 }],
    },
    pending: {
      row: { left: 1, right },
      bubble: { left: right - 130, right },
      text: "Question?",
      separate: true,
      images: [{ left: right - 96, right, width: 96, height: 72 }],
    },
  };
};
for (const gutter of [0, 6, 15, 19])
  test(`desktop retains equal outer frames and measured safe rail with ${gutter}px native gutter`, () => {
    assertSteerGeometry(desktopGeometry(gutter), 1, "synthetic desktop guards");
  });
for (const [name, mutate] of [
  [
    "old widened outer tray",
    (g) => {
      g.rails.tray.right += 17;
      g.rails.tray.width += 17;
      g.rails.offsetWidth += 17;
    },
  ],
  [
    "shifted outer tray",
    (g) => {
      g.rails.tray.left += 8;
      g.rails.tray.right += 8;
    },
  ],
  [
    "canonical column moved to hide mismatch",
    (g) => {
      g.normal.row.right -= 16;
      g.normal.bubble.right -= 16;
      g.normal.images[0].right -= 16;
    },
  ],
  [
    "body pushed over gutter to canonical edge",
    (g) => (g.pending.bubble.right = 350),
  ],
  ["image pushed over gutter", (g) => (g.pending.images[0].right = 350)],
  [
    "whole pending rail shifted",
    (g) => {
      g.pending.row.right -= 8;
      g.pending.bubble.right -= 8;
      g.pending.images[0].right -= 8;
    },
  ],
  ["body locally detached", (g) => (g.pending.bubble.right -= 8)],
  ["image locally detached", (g) => (g.pending.images[0].right -= 8)],
  ["image left overflow", (g) => (g.pending.images[0].left = -8)],
  ["missing native measurements", (g) => delete g.rails.clientWidth],
  ["missing canonical column", (g) => (g.rails.canonicalColumn = null)],
])
  test(`desktop rail contract rejects ${name}`, () => {
    const g = desktopGeometry();
    mutate(g);
    assert.throws(() => assertSteerGeometry(g, 1, name));
  });
test("narrow layout retains original absolute canonical alignment contract", () => {
  const g = geometry();
  g.pending.bubble.right -= 16;
  assert.throws(() => assertSteerGeometry(g, 1, "narrow mismatch"));
});

test("DOM rail probe records native boxes rather than inferring a scrollbar constant", () => {
  const dom = new JSDOM(
    `<div class="thread-view"><div class="virtual-transcript-header"></div><article data-sent-message-id="synthetic-normal"><div class="user-bubble">Q</div></article><div class="bottom-zone"><div class="pending-tray" style="border:1px solid; padding:0"><section class="pending-steer-panel"><ol><li><div class="user-bubble"><div class="pending-steer-text">Q</div></div></li></ol></section></div><form class="composer"></form></div></div>`,
  );
  try {
    const doc = dom.window.document;
    Object.defineProperty(dom.window, "innerWidth", {
      value: 1100,
      configurable: true,
    });
    const tray = doc.querySelector(".pending-tray");
    Object.defineProperties(tray, {
      clientLeft: { value: 1 },
      clientWidth: { value: 783 },
      offsetWidth: { value: 800 },
    });
    tray.getBoundingClientRect = () => ({
      left: 150,
      right: 950,
      width: 800,
      height: 170,
    });
    for (const selector of [".composer", ".virtual-transcript-header"])
      doc.querySelector(selector).getBoundingClientRect = () => ({
        left: 150,
        right: 950,
        width: 800,
        height: 100,
      });
    const rail = measureSteerComparison(doc).rails;
    assert.equal(rail.desktop, true);
    assert.equal(rail.clientLeft, 1);
    assert.equal(rail.clientWidth, 783);
    assert.equal(rail.offsetWidth, 800);
    assert.equal(rail.borderRight, 1);
    assert.equal(rail.paddingRight, 0);
    assert.deepEqual(rail.tray, {
      left: 150,
      right: 950,
      width: 800,
      height: 170,
    });
    assert.equal(rail.composer.right, 950);
    assert.equal(rail.canonicalColumn.right, 950);
    Object.defineProperty(dom.window, "innerWidth", { value: 390 });
    assert.equal(measureSteerComparison(doc).rails.desktop, false);
  } finally {
    dom.window.close();
  }
});
