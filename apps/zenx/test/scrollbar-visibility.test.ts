import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installScrollbarVisibility } from "../src/renderer/src/scrollbar-visibility.js";

test("native scrollbar reveals on activity, stays draggable, and hides at rest", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM(
    '<div id="outer"><div id="scroll"><button>Child</button></div></div>',
  );
  const { document, Event, MouseEvent, KeyboardEvent } = dom.window;
  const area = document.getElementById("scroll")!;
  const child = area.firstElementChild!;
  area.setAttribute("style", "overflow-y: auto; overflow-x: auto");
  Object.defineProperties(area, {
    scrollHeight: { value: 500 },
    clientHeight: { value: 100 },
    scrollWidth: { value: 500 },
    clientWidth: { value: 200 },
  });
  area.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    x: 0,
    y: 0,
    toJSON() {},
  });
  const dispose = installScrollbarVisibility(document);
  const active = () => area.hasAttribute("data-scrollbar-active");
  const pointer = (type: string, x: number, y = 40) =>
    area.dispatchEvent(
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }),
    );
  try {
    assert.equal(active(), false);
    pointer("pointermove", 80);
    assert.equal(
      active(),
      false,
      "hover in panel center never reveals scrollbar",
    );
    area.dispatchEvent(new Event("scroll"));
    assert.equal(active(), true);
    t.mock.timers.tick(1001);
    assert.equal(active(), false);
    child.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }),
    );
    assert.equal(
      active(),
      true,
      "keyboard activity reveals containing scroll region",
    );
    t.mock.timers.tick(1001);
    pointer("pointermove", 195);
    t.mock.timers.tick(2000);
    assert.equal(active(), true, "stationary edge remains discoverable");
    pointer("pointerdown", 195);
    // Chromium consumes moves during native thumb dragging. Only release tells
    // the page that the pointer is now in the center rather than at the edge.
    t.mock.timers.tick(2000);
    assert.equal(active(), true, "drag out of gutter must not disappear");
    pointer("pointerup", 70);
    t.mock.timers.tick(1001);
    assert.equal(
      active(),
      false,
      "release in center clears stale native-drag edge",
    );
    pointer("pointerdown", 195);
    pointer("pointerup", 195);
    t.mock.timers.tick(1001);
    assert.equal(active(), true, "release at edge remains discoverable");
    pointer("pointercancel", 195);
    t.mock.timers.tick(1001);
    assert.equal(active(), false, "cancel clears both drag and edge state");
    pointer("pointerdown", 195);
    pointer("pointerup", 230);
    t.mock.timers.tick(1001);
    assert.equal(
      active(),
      false,
      "captured release outside bounds is not an edge",
    );
    pointer("pointermove", 50, 96);
    assert.equal(active(), true, "horizontal code scrollbar edge works");
    dom.window.dispatchEvent(new Event("blur"));
    t.mock.timers.tick(1001);
    assert.equal(active(), false);
    area.style.direction = "rtl";
    pointer("pointermove", 3);
    assert.equal(active(), true, "RTL scrollbar edge is on left");
    dispose();
    assert.equal(active(), false);
    area.dispatchEvent(new Event("scroll"));
    assert.equal(active(), false, "cleanup removes listeners");
    assert.equal(
      document.documentElement.hasAttribute("data-scrollbar-autohide"),
      false,
    );
  } finally {
    dispose();
    dom.window.close();
  }
});

test("focused descendants keep scrollbars visible until focus leaves, including internal and nested moves", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM(
    '<div id="outer"><div id="inner"><button id="one">One</button><button id="two">Two</button></div><button id="sibling">Sibling</button></div><button id="outside">Outside</button>',
  );
  const { document } = dom.window;
  const outer = document.getElementById("outer")!;
  const inner = document.getElementById("inner")!;
  for (const area of [outer, inner]) {
    area.style.overflowY = "auto";
    Object.defineProperties(area, {
      scrollHeight: { value: 500 },
      clientHeight: { value: 100 },
    });
  }
  const focus = (id: string) => document.getElementById(id)!.focus();
  const active = (area: Element) => area.hasAttribute("data-scrollbar-active");
  const dispose = installScrollbarVisibility(document);
  try {
    focus("one");
    t.mock.timers.tick(1001);
    assert.ok(
      active(inner),
      "focused child retains its scrollbar past idle delay",
    );
    assert.ok(
      active(outer),
      "nested focused child retains ancestor scrollbars",
    );
    focus("two");
    t.mock.timers.tick(1001);
    assert.ok(
      active(inner),
      "moving between children does not fade their common scrollbar",
    );
    focus("sibling");
    assert.ok(
      active(inner),
      "exiting keeps the ordinary one-second fade delay",
    );
    t.mock.timers.tick(1001);
    assert.equal(
      active(inner),
      false,
      "leaving inner region schedules fade even after its old timer expired",
    );
    assert.ok(active(outer), "outer region still contains focus");
    focus("outside");
    t.mock.timers.tick(1001);
    assert.equal(
      active(outer),
      false,
      "leaving all scroll regions releases the last focus hold",
    );
    focus("one");
    t.mock.timers.tick(1001);
    dispose();
    assert.equal(active(inner), false, "cleanup clears a focus-held scrollbar");
    assert.equal(active(outer), false);
    focus("two");
    focus("outside");
    t.mock.timers.tick(1001);
    assert.equal(
      active(inner),
      false,
      "cleanup removes focus listeners as well as timers",
    );
    assert.equal(active(outer), false);
  } finally {
    dispose();
    dom.window.close();
  }
});
