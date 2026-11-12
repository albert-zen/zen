import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
Object.assign(globalThis, { React });
const { ComposerEditor } = await import("../src/renderer/src/Composer.js");
const { act, createElement } = React;

test(
  "empty composer clears without geometry reads and keeps one live width observer",
  { timeout: 10000 },
  async () => {
    const dom = new JSDOM(
      "<!doctype html><html><body><div id=root></div></body></html>",
      { url: "http://localhost" },
    );
    const previous = {
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      Node: globalThis.Node,
      window: globalThis.window,
      ResizeObserver: globalThis.ResizeObserver,
    };
    let observerCount = 0;
    let disconnectCount = 0;
    let observed: Element | undefined;
    let notify: ResizeObserverCallback = () => undefined;
    class Observer {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
        observerCount++;
      }
      observe(target: Element) {
        observed = target;
      }
      unobserve() {}
      disconnect() {
        disconnectCount++;
      }
    }
    Object.assign(globalThis, {
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      window: dom.window,
      ResizeObserver: Observer,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    let scrollReads = 0;
    let geometryReads = 0;
    let styleReads = 0;
    let contentHeight = 200;
    Object.defineProperty(
      dom.window.HTMLTextAreaElement.prototype,
      "scrollHeight",
      {
        configurable: true,
        get() {
          scrollReads++;
          return contentHeight;
        },
      },
    );
    dom.window.HTMLTextAreaElement.prototype.getBoundingClientRect = () => {
      geometryReads++;
      return { width: 400 } as DOMRect;
    };
    const realStyle = dom.window.getComputedStyle.bind(dom.window);
    dom.window.getComputedStyle = (element) => {
      styleReads++;
      return realStyle(element);
    };
    const root = createRoot(document.getElementById("root")!);
    const render = (
      value: string,
      minHeight = "36px",
      maxHeight = "136px",
      rows = 1,
    ) =>
      root.render(
        createElement(ComposerEditor, {
          value,
          onChange: () => undefined,
          rows,
          style: { minHeight, maxHeight },
        }),
      );
    const resize = (width: number) =>
      notify(
        [{ target: observed!, contentRect: { width } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    try {
      await act(async () => render(""));
      const textarea = document.querySelector("textarea")!;
      assert.equal(textarea.style.height, "auto");
      assert.equal(scrollReads + styleReads + geometryReads, 0);
      await act(async () => resize(400));
      assert.equal(scrollReads + styleReads + geometryReads, 0);
      await act(async () => render("multiple\nlines"));
      assert.equal(textarea.style.height, "136px");
      assert.equal(textarea.style.overflowY, "auto");
      assert.equal(observerCount, 1);
      const beforeClear = [scrollReads, styleReads, geometryReads];
      await act(async () => render(""));
      assert.deepEqual([scrollReads, styleReads, geometryReads], beforeClear);
      assert.equal(textarea.style.height, "auto");
      assert.equal(textarea.style.overflowY, "hidden");
      assert.equal(observerCount, 1);
      assert.equal(disconnectCount, 0);
      await act(async () => resize(240));
      assert.deepEqual([scrollReads, styleReads, geometryReads], beforeClear);
      contentHeight = 20;
      await act(async () => render("short", "48px", "72px"));
      assert.equal(textarea.style.height, "48px");
      contentHeight = 90;
      await act(async () => resize(160));
      assert.equal(textarea.style.height, "72px");
      assert.equal(textarea.style.overflowY, "auto");
      // A window/font/viewport resize uses the current content and CSS, not a
      // captured old draft or a cached single-line pixel height.
      contentHeight = 50;
      await act(async () =>
        window.dispatchEvent(new dom.window.Event("resize")),
      );
      assert.equal(textarea.style.height, "50px");
      await act(async () => render("", "64px", "96px", 2));
      assert.equal(textarea.rows, 2);
      assert.equal(textarea.style.height, "auto");
      assert.equal(textarea.style.minHeight, "64px");
      assert.equal(geometryReads, 0);
      await act(async () => root.render(null));
      assert.equal(disconnectCount, 1);
      const unmounted = scrollReads;
      await act(async () =>
        window.dispatchEvent(new dom.window.Event("resize")),
      );
      assert.equal(scrollReads, unmounted);
    } finally {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous, {
        IS_REACT_ACT_ENVIRONMENT: undefined,
      });
      dom.window.close();
    }
  },
);
