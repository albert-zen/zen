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
    pointer("pointermove", 70);
    t.mock.timers.tick(2000);
    assert.equal(active(), true, "drag out of gutter must not disappear");
    pointer("pointerup", 70);
    t.mock.timers.tick(1001);
    assert.equal(active(), false);
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
