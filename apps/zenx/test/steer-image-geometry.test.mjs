import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSteerGeometry,
  assertSteerWheelReceipt,
} from "../scripts/steer-image-geometry.mjs";

// Pure guard tests only. These numbers are NOT browser evidence.
const geometry = () => ({
  desktop: false,
  overflow: false,
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

// This is a measured-frame contract, not a fixed platform scrollbar allowance.
function desktopGeometry(scrollbar = 15) {
  const g = geometry();
  g.desktop = true;
  g.tray = {
    rect: { left: 150, right: 950, width: 800 },
    clientLeft: 1,
    clientWidth: 798 - scrollbar,
    offsetWidth: 800,
  };
  g.composer = { left: 150, right: 950, width: 800 };
  g.normal.bubble.right = g.normal.images[0].right = 950;
  g.pending.bubble.right = g.pending.images[0].right = 949 - scrollbar;
  return g;
}
for (const scrollbar of [0, 6, 10, 15, 20]) {
  test(`desktop measured inner rail with ${scrollbar}px scrollbar`, () => {
    assertSteerGeometry(desktopGeometry(scrollbar), 1, "desktop rail");
  });
}
for (const [name, change] of [
  [
    "body shifted",
    (g) => {
      g.pending.bubble.right -= 3;
    },
  ],
  [
    "image shifted",
    (g) => {
      g.pending.images[0].right += 3;
    },
  ],
  [
    "outer left shifted",
    (g) => {
      g.tray.rect.left += 3;
    },
  ],
  [
    "outer right shifted",
    (g) => {
      g.tray.rect.right += 3;
    },
  ],
  [
    "missing tray",
    (g) => {
      g.tray = null;
    },
  ],
  [
    "unobserved media",
    (g) => {
      g.desktop = null;
    },
  ],
  [
    "fabricated client width",
    (g) => {
      g.tray.clientWidth = 900;
    },
  ],
  [
    "old canonical edge inside desktop",
    (g) => {
      g.pending.bubble.right = 950;
    },
  ],
])
  test(`desktop rail rejects ${name}`, () => {
    const g = desktopGeometry();
    change(g);
    assert.throws(() => assertSteerGeometry(g, 1, name));
  });
test("narrow layout still requires canonical alignment rather than an inner rail allowance", () => {
  const g = desktopGeometry();
  g.desktop = false;
  assert.throws(() => assertSteerGeometry(g, 1, "narrow"));
});
test("DOM measurement reads actual tray client metrics and desktop media", () => {
  const dom = new JSDOM(
    `<div class="bottom-zone"><div class="pending-tray"><section class="pending-steer-panel"><ol><li></li></ol></section></div><form class="composer"></form></div>`,
  );
  const doc = dom.window.document;
  let mediaQuery;
  dom.window.matchMedia = (query) => {
    mediaQuery = query;
    return { matches: true };
  };
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
    height: 200,
  });
  doc.querySelector(".composer").getBoundingClientRect =
    tray.getBoundingClientRect;
  const g = measureSteerComparison(doc);
  assert.equal(mediaQuery, "(min-width: 961px)");
  assert.equal(g.desktop, true);
  assert.deepEqual(g.tray, {
    rect: { left: 150, right: 950, width: 800, height: 200 },
    clientLeft: 1,
    clientWidth: 783,
    offsetWidth: 800,
  });
  assert.deepEqual(g.composer, g.tray.rect);
  dom.window.close();
});
