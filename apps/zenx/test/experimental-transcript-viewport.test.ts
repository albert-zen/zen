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

// Deterministic geometry exercises the actual npm web component and native listeners.
// This is not browser layout, a native Send measurement, or selection acceptance.
test("real Legend viewport bounds mounted rows and cancels a reveal when unmounted", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const rect = (height: number) => ({
    top: 0,
    bottom: height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: 0,
    toJSON() {},
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rect(this.classList.contains("messages") ? 600 : 280);
  };
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ? 600 : 280;
      },
    },
    clientWidth: {
      configurable: true,
      get() {
        return 800;
      },
    },
    offsetHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ? 600 : 280;
      },
    },
    offsetWidth: {
      configurable: true,
      get() {
        return 800;
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ? 280000 : 280;
      },
    },
    scrollWidth: {
      configurable: true,
      get() {
        return 800;
      },
    },
  });
  dom.window.HTMLElement.prototype.scrollTo = function (options) {
    if (typeof options === "object")
      this.scrollTop = options.top ?? this.scrollTop;
    this.dispatchEvent(new dom.window.Event("scroll"));
  };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const viewport = { current: null as HTMLDivElement | null };
  const controller = { current: null as VirtualTranscriptHandle | null };
  const position = {
    scroll: { top: 0, following: false },
    virtualAnchor: null,
  };
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    key: `turn-${index}`,
    content: React.createElement(
      "div",
      null,
      `Answer ${index}`,
      React.createElement("button", null, `Control ${index}`),
    ),
  }));
  const root = createRoot(document.getElementById("root")!);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values) => {
    errors.push(values.map(String).join(" "));
  };
  let mounted = true;
  try {
    await act(async () =>
      root.render(
        React.createElement(ExperimentalTranscriptViewport, {
          rows,
          header: null,
          footer: React.createElement(
            "p",
            { "data-pending": "true" },
            "Sending",
          ),
          viewport,
          controller,
          position,
          className: "messages",
          onViewportScroll() {},
          onContentSettled() {},
        }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    assert.equal(
      document.querySelectorAll(".messages").length,
      1,
      "one scroll owner",
    );
    assert.ok(
      viewport.current?.contains(document.querySelector("[data-pending]")),
    );
    const count = document.querySelectorAll("[data-transcript-row-key]").length;
    assert.ok(count > 0 && count < 60, `mounted ${count} of ${rows.length}`);
    const node = viewport.current!;
    const firstRow = node.querySelector<HTMLElement>(
      "[data-transcript-row-key]",
    )!;
    const button = firstRow.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.focus());
    await act(async () => {
      const pointer = new dom.window.MouseEvent("pointerdown", {
        button: 0,
        bubbles: true,
      });
      firstRow.dispatchEvent(pointer);
      node.dispatchEvent(new dom.window.Event("scroll"));
      document.dispatchEvent(
        new dom.window.MouseEvent("pointerup", { bubbles: true }),
      );
    });
    assert.equal(
      document.activeElement,
      button,
      "focus survives actual pin update",
    );
    const range = document.createRange();
    range.selectNodeContents(firstRow);
    const selection = document.getSelection()!;
    selection.addRange(range);
    const selected = selection.toString();
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("selectionchange"));
      node.dispatchEvent(new dom.window.Event("scroll"));
    });
    assert.equal(
      selection.toString(),
      selected,
      "selection survives actual pin update",
    );
    let reveal: Promise<boolean>;
    await act(async () => {
      reveal = controller.current!.reveal("turn-999");
    });
    await act(async () => root.unmount());
    mounted = false;
    assert.equal(
      await reveal!,
      false,
      "pending reveal resolves cancelled after cleanup",
    );
    assert.equal(controller.current, null);
    assert.equal(
      errors.filter((error) =>
        /flushSync|nested update|maximum update|not wrapped in act/i.test(
          error,
        ),
      ).length,
      0,
      errors.join("\n"),
    );
  } finally {
    if (mounted) await act(async () => root.unmount());
    console.error = originalError;
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});
