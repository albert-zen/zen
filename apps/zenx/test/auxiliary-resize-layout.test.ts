import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";

test("interactive pane width reports clamped layout before passive observation, and every capture exit clears resizing", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window as any).zenx = {};
  let cap = 558.8;
  const prototype = dom.window.HTMLElement.prototype;
  const originalRect = prototype.getBoundingClientRect;
  // JSDOM has no layout: this models a CSS maximum, not native visual evidence.
  prototype.getBoundingClientRect = function () {
    if (!this.classList.contains("auxiliary-panel"))
      return originalRect.call(this);
    const width = Math.min(
      cap,
      Number.parseFloat(this.style.getPropertyValue("--auxiliary-width")),
    );
    return {
      x: 1280 - width,
      y: 0,
      left: 1280 - width,
      right: 1280,
      top: 0,
      bottom: 677,
      width,
      height: 677,
      toJSON() {},
    };
  };
  const captures = new Set<number>();
  prototype.setPointerCapture = (id) => {
    captures.add(id);
  };
  prototype.hasPointerCapture = (id) => captures.has(id);
  prototype.releasePointerCapture = (id) => {
    captures.delete(id);
  };
  const observers: {
    target?: Element;
    callback: () => void;
    disconnects: number;
  }[] = [];
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    state: (typeof observers)[number];
    constructor(callback: () => void) {
      this.state = { callback, disconnects: 0 };
      observers.push(this.state);
    }
    observe(target: Element) {
      this.state.target = target;
    }
    unobserve() {}
    disconnect() {
      this.state.disconnects++;
    }
  } as unknown as typeof ResizeObserver;
  const reports: number[] = [];
  const report = (width: number) => {
    reports.push(width);
  };
  const root = createRoot(document.getElementById("root")!);
  let mounted = true;
  const pointer = async (
    type: string,
    clientX = 640,
    button = 0,
    pointerId = 7,
  ) => {
    const event = new dom.window.MouseEvent(type, {
      bubbles: true,
      clientX,
      button,
    });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    await act(async () =>
      document.querySelector(".browser-panel-resizer")!.dispatchEvent(event),
    );
  };
  const render = async (open = true, fullscreen = false) => {
    await act(async () =>
      root.render(
        React.createElement(AuxiliaryPanel, {
          threadId: "resize-test",
          title: "Resize test",
          open,
          onOpenChange() {},
          snapshot: null,
          selectedTab: "",
          onSelectTab() {},
          onWidthChange: report,
          presentationState: {
            owner: { kind: "thread", id: "resize-test" },
            revision: 0,
            open,
            fullscreen,
            tabs: [],
            selectedTab: null,
            resourceThreadId: "resize-test",
          },
        }),
      ),
    );
  };
  try {
    await render();
    const panel = document.querySelector<HTMLElement>(".auxiliary-panel")!;
    const separator = document.querySelector(".browser-panel-resizer")!;
    const observer = observers.find((item) => item.target === panel)!;
    reports.length = 0;
    await pointer("pointerdown");
    assert.equal(panel.dataset.resizing, "true");
    await pointer("pointerup", 640, 0, 99);
    assert.equal(
      panel.dataset.resizing,
      "true",
      "unrelated pointer cannot finish the active resize",
    );
    captures.add(99); // A second touch may receive implicit native capture.
    await pointer("pointermove", 500, 0, 99);
    assert.equal(
      separator.getAttribute("aria-valuenow"),
      "520",
      "foreign captured pointer cannot resize the active gesture",
    );
    captures.delete(99);
    await pointer("pointermove");
    assert.equal(separator.getAttribute("aria-valuenow"), "640");
    assert.equal(
      reports.at(-1),
      558.8,
      "layout effect reports actual clamped width, without an observer delivery",
    );
    assert.equal(
      reports.includes(0),
      false,
      "width changes do not clean up the passive observer",
    );
    assert.equal(observer.disconnects, 0);
    await pointer("pointerup");
    assert.equal(panel.dataset.resizing, "false");
    assert.equal(captures.size, 0);
    for (const exit of ["pointercancel", "lostpointercapture", "blur"]) {
      await pointer("pointerdown");
      assert.equal(panel.dataset.resizing, "true");
      if (exit === "blur")
        await act(async () =>
          dom.window.dispatchEvent(new dom.window.Event("blur")),
        );
      else await pointer(exit);
      assert.equal(panel.dataset.resizing, "false", exit);
      assert.equal(captures.size, 0, exit);
    }
    await pointer("pointerdown", 640, 2);
    assert.equal(
      panel.dataset.resizing,
      "false",
      "non-primary button is not a resize gesture",
    );
    cap = 420;
    await act(async () =>
      separator.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }),
      ),
    );
    assert.equal(separator.getAttribute("aria-valuenow"), "620");
    assert.equal(
      reports.at(-1),
      420,
      "keyboard resizing also measures actual narrower CSS layout",
    );
    cap = 390;
    await act(async () => observer.callback());
    assert.equal(
      reports.at(-1),
      390,
      "passive container changes retain ResizeObserver reporting",
    );
    for (const [open, fullscreen] of [
      [false, false],
      [true, true],
    ]) {
      await pointer("pointerdown");
      assert.equal(panel.dataset.resizing, "true");
      await render(open, fullscreen);
      assert.equal(
        panel.dataset.resizing,
        "false",
        "closing or maximizing clears active resize",
      );
      assert.equal(captures.size, 0);
      await render();
    }
    await pointer("pointerdown");
    await act(async () => root.unmount());
    mounted = false;
    assert.equal(captures.size, 0, "unmount releases owned pointer capture");
    assert.equal(observer.disconnects, 1);
    assert.equal(reports.at(-1), 0, "actual unmount still clears parent width");
  } finally {
    if (mounted) await act(async () => root.unmount());
    globalThis.ResizeObserver = originalObserver;
    prototype.getBoundingClientRect = originalRect;
    dom.window.close();
  }
});

test("only active resize geometry skips its tween; the macOS following titlebar has no second width tween", () => {
  const css = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.auxiliary-panel\[data-resizing="true"\]\s*\{[^}]*transition-property:\s*border-color, opacity, translate;/,
  );
  assert.match(
    css,
    /:root\[data-platform="darwin"\]\s*\.app-shell:has\(\.auxiliary-panel\[data-open="true"\]\)\s*> \.window-titlebar\s*\{[^}]*transition: none;/,
  );
  assert.match(
    css,
    /\.auxiliary-panel\s*\{\s*transition:\s*flex-basis var\(--motion-layout\)/,
    "passive panel/open motion is retained",
  );
});
