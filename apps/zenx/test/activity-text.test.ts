import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ActivityText } from "../src/renderer/src/ActivityText.js";

async function withActivityDom(
  run: (h: {
    render(active: boolean): Promise<void>;
    intersect(visible: boolean): Promise<void>;
    visibility(state: DocumentVisibilityState): Promise<void>;
    animating(): boolean;
    observerCount(): number;
  }) => Promise<void>,
) {
  const dom = new JSDOM("<div id='activity-root'></div>", {
    url: "http://localhost",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IntersectionObserver: globalThis.IntersectionObserver,
  };
  const observers: Observed[] = [];
  let disconnects = 0;
  class Observed {
    target: Element | null = null;
    constructor(readonly callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.target = target;
    }
    disconnect() {
      disconnects += 1;
    }
    notify(visible: boolean) {
      this.callback(
        [
          {
            target: this.target,
            isIntersecting: visible,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      );
    }
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IntersectionObserver: Observed,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const root = createRoot(document.getElementById("activity-root")!);
  try {
    await run({
      render: async (active) => {
        await act(async () =>
          root.render(
            React.createElement(ActivityText, {
              active,
              children: "Reading source files",
            }),
          ),
        );
        assert.equal(
          document.querySelector(".activity-text")?.textContent,
          "Reading source files",
        );
        assert.equal(
          document.querySelector(".activity-text")?.getAttribute("role"),
          null,
        );
      },
      intersect: async (visible) => {
        await act(async () =>
          observers.forEach((observer) => observer.notify(visible)),
        );
      },
      visibility: async (state) => {
        await act(async () => {
          visibility = state;
          document.dispatchEvent(new window.Event("visibilitychange"));
        });
      },
      animating: () =>
        document
          .querySelector(".activity-text")
          ?.getAttribute("data-animating") === "true",
      observerCount: () => observers.length,
    });
  } finally {
    await act(async () => root.unmount());
    assert.equal(
      disconnects,
      observers.length,
      "all offscreen observers are disconnected on unmount",
    );
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

test("activity text runs only for actually active, intersecting content and never duplicates its accessible text", async () => {
  await withActivityDom(async (h) => {
    await h.render(true);
    assert.equal(h.animating(), false, "unobserved text begins paused");
    await h.intersect(true);
    assert.equal(h.animating(), true);
    await h.intersect(false);
    assert.equal(h.animating(), false, "scrolled-out text pauses");
    await h.render(false);
    await h.intersect(true);
    assert.equal(
      h.animating(),
      false,
      "visibility cannot animate an inactive state",
    );
    assert.equal(
      document.querySelector(".activity-text")?.getAttribute("data-active"),
      "false",
    );
  });
});

test("document hide and show pause activity without overriding its offscreen state", async () => {
  await withActivityDom(async (h) => {
    await h.render(true);
    await h.intersect(true);
    assert.equal(h.animating(), true);
    await h.visibility("hidden");
    assert.equal(h.animating(), false);
    await h.visibility("visible");
    assert.equal(h.animating(), true);
    await h.visibility("hidden");
    await h.intersect(false);
    await h.visibility("visible");
    assert.equal(
      h.animating(),
      false,
      "showing the document does not animate offscreen text",
    );
  });
});

test("repeated active changes reuse the observer and cannot resurrect stale visibility", async () => {
  await withActivityDom(async (h) => {
    await h.render(true);
    await h.intersect(true);
    await h.render(false);
    await h.intersect(false);
    await h.render(true);
    assert.equal(h.animating(), false);
    assert.equal(h.observerCount(), 1);
    await h.intersect(true);
    assert.equal(h.animating(), true);
    await h.visibility("hidden");
    await h.render(false);
    await h.render(true);
    assert.equal(h.animating(), false);
    assert.equal(h.observerCount(), 1);
  });
});
