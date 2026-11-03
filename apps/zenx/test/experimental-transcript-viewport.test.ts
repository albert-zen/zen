import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
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
  const listRef = { current: null as LegendListRef | null };
  const scrollKinds: boolean[] = [];
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
          listRef,
          position,
          className: "messages",
          onViewportScroll(_node, correction) {
            scrollKinds.push(correction);
          },
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
    const originalKeys = [
      ...node.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
    ].map((row) => row.dataset.transcriptRowKey);
    await act(async () => {
      node.dispatchEvent(
        new dom.window.WheelEvent("wheel", { deltaY: 140000, bubbles: true }),
      );
      node.scrollTop = 140000;
      node.dispatchEvent(new dom.window.Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    const farKeys = [
      ...node.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
    ].map((row) => row.dataset.transcriptRowKey);
    assert.ok(
      farKeys.some((key) => !originalKeys.includes(key)),
      "far offset materializes different rows",
    );
    assert.ok(
      farKeys.some((key) => Number(key?.split("-")[1]) > 450),
      "visible buffer reaches the distant history region",
    );
    assert.equal(
      firstRow.isConnected,
      true,
      "selected/focused old row stays mounted beyond the buffer",
    );
    assert.equal(
      document.activeElement,
      button,
      "focus survives far scroll and DOM-order settlement",
    );
    assert.equal(
      selection.toString(),
      selected,
      "selected text survives far scroll and DOM-order settlement",
    );
    await act(async () => {
      selection.removeAllRanges();
      button.blur();
      document.dispatchEvent(new dom.window.Event("selectionchange"));
      node.scrollTop = 145000;
      node.dispatchEvent(new dom.window.Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    assert.equal(
      firstRow.isConnected,
      false,
      "released pins allow the historical row to unmount",
    );
    assert.ok(
      scrollKinds.includes(false),
      "real reader scroll is not hidden as layout correction",
    );
    const actualScrollToIndex = listRef.current!.scrollToIndex;
    listRef.current!.scrollToIndex = () => new Promise<void>(() => {});
    let reveal: Promise<boolean>;
    let committed = 0;
    await act(async () => {
      reveal = controller.current!.reveal("turn-999", () => committed++);
      node.dispatchEvent(
        new dom.window.WheelEvent("wheel", { deltaY: -10, bubbles: true }),
      );
    });
    assert.equal(
      await reveal!,
      false,
      "reader input cancels even an unresolved library scroll promise",
    );
    assert.equal(committed, 0);
    listRef.current!.scrollToIndex = async () => {
      throw new Error("controlled rejected scroll");
    };
    await act(async () => {
      reveal = controller.current!.reveal("turn-999", () => committed++);
    });
    assert.equal(
      await reveal!,
      false,
      "rejected library scroll settles as failure without consuming target",
    );
    listRef.current!.scrollToIndex = () => new Promise<void>(() => {});
    await act(async () => {
      reveal = controller.current!.reveal("turn-998", () => committed++);
    });
    listRef.current!.scrollToIndex = actualScrollToIndex;
    let newer: Promise<boolean>;
    await act(async () => {
      newer = controller.current!.reveal("turn-510", () => committed++);
    });
    await act(async () => {
      assert.equal(await newer!, true);
    });
    assert.equal(
      await reveal!,
      false,
      "new request supersedes unresolved previous request",
    );
    assert.equal(
      committed,
      1,
      "only current materialized request commits target focus",
    );
    listRef.current!.scrollToIndex = () => new Promise<void>(() => {});
    await act(async () => {
      reveal = controller.current!.reveal("turn-999", () => committed++);
    });
    await act(async () => root.unmount());
    mounted = false;
    assert.equal(
      await reveal!,
      false,
      "pending unresolved library scroll resolves cancelled after cleanup",
    );
    assert.equal(committed, 1);
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
