import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  ExperimentalTranscriptViewport,
  type VirtualTranscriptHandle,
} from "../src/renderer/src/ExperimentalTranscriptViewport.js";

// Execute the real prepared Legend web component. Geometry and observer delivery
// are controlled here: this is not browser/Electron layout acceptance.
test("transcript follows its parent after zero-width fullscreen resource layouts without remounting", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let parentWidth = 960;
  const viewport = { current: null as HTMLDivElement | null };
  const controller = { current: null as VirtualTranscriptHandle | null };
  const widthOf = (node: HTMLElement): number => {
    if (node.classList.contains("messages")) {
      return node.style.width.endsWith("px")
        ? parseFloat(node.style.width)
        : parentWidth;
    }
    // A minimum intrinsic row fragment can still measure positive while the
    // hidden main surface is collapsed by an expanded resource workspace.
    return Math.max(
      1,
      viewport.current ? widthOf(viewport.current) : parentWidth,
    );
  };
  const heightOf = (node: HTMLElement) =>
    node.classList.contains("messages") ? 600 : 280;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const width = widthOf(this),
      height = heightOf(this);
    return {
      width,
      height,
      top: 0,
      left: 0,
      bottom: height,
      right: width,
      x: 0,
      y: 0,
      toJSON() {},
    };
  };
  for (const key of ["clientWidth", "offsetWidth", "scrollWidth"] as const)
    Object.defineProperty(dom.window.HTMLElement.prototype, key, {
      configurable: true,
      get() {
        return widthOf(this);
      },
    });
  for (const key of ["clientHeight", "offsetHeight"] as const)
    Object.defineProperty(dom.window.HTMLElement.prototype, key, {
      configurable: true,
      get() {
        return heightOf(this);
      },
    });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return 2800;
    },
  });
  dom.window.HTMLElement.prototype.scrollTo = function (options) {
    if (typeof options === "object")
      this.scrollTop = options.top ?? this.scrollTop;
    this.dispatchEvent(new dom.window.Event("scroll"));
  };
  const observers: Observer[] = [];
  class Observer {
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  const notify = async (scroller: boolean) => {
    await act(async () => {
      for (const observer of observers) {
        const entries = [...observer.targets]
          .filter((target) => (target === viewport.current) === scroller)
          .map(
            (target) =>
              ({
                target,
                contentRect: target.getBoundingClientRect(),
              }) as ResizeObserverEntry,
          );
        if (entries.length)
          observer.callback(entries, observer as unknown as ResizeObserver);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const root = createRoot(document.getElementById("root")!);
  const position = { scroll: { following: false }, virtualAnchor: null };
  try {
    await act(async () => {
      root.render(
        React.createElement(ExperimentalTranscriptViewport, {
          rows: Array.from({ length: 10 }, (_, index) => ({
            key: `row-${index}`,
            content: React.createElement(
              "p",
              null,
              `Synthetic answer ${index}`,
            ),
          })),
          header: null,
          footer: null,
          viewport,
          controller,
          position,
          className: "messages",
          onViewportScroll() {},
          onContentSettled() {},
        }),
      );
    });
    const originalNode = viewport.current!;
    const originalController = controller.current;
    assert.equal(widthOf(originalNode), parentWidth);
    for (const restoredWidth of [960, 640, 360, 1280, 720, 960]) {
      parentWidth = 0;
      await notify(true);
      await notify(false);
      parentWidth = restoredWidth;
      await notify(true);
      await notify(false);
      assert.equal(
        widthOf(originalNode),
        restoredWidth,
        `restoring parent to ${restoredWidth}px must not retain an intrinsic inline width (${originalNode.style.width})`,
      );
      assert.equal(originalNode.style.width, "100%");
      assert.equal(viewport.current, originalNode, "same scroll node");
      assert.equal(
        controller.current,
        originalController,
        "same viewport controller",
      );
      assert.equal(
        position.scroll.following,
        false,
        "reading intent is retained",
      );
    }
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
