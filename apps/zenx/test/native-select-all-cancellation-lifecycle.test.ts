import "./dom-primitives.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createNativeEditingApi } from "../src/preload/native-editing.js";
import {
  TranscriptViewport,
  type VirtualTranscriptHandle,
} from "../src/renderer/src/ExperimentalTranscriptViewport.js";

// Synthetic product lifecycle only. JSDOM does not execute native Select All.
for (const scenario of [
  "prevented outside",
  "repeated page",
  "preexisting page",
  "editor",
] as const)
  test(`actual preload/viewport lifecycle: ${scenario} selection`, async (t) => {
    const dom = new JSDOM(
      '<body tabindex="0"><aside>Outside selection</aside><main class="thread-view"><div id="root"></div><textarea></textarea></main></body>',
      { url: "https://synthetic.invalid" },
    );
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
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      return new dom.window.DOMRect(0, 0, 800, 280);
    };
    dom.window.HTMLElement.prototype.getClientRects = function () {
      return [this.getBoundingClientRect()] as unknown as DOMRectList;
    };
    for (const [key, size] of Object.entries({
      clientHeight: 600,
      clientWidth: 800,
      offsetHeight: 280,
      offsetWidth: 800,
      scrollHeight: 140000,
      scrollWidth: 800,
    }))
      Object.defineProperty(dom.window.HTMLElement.prototype, key, {
        configurable: true,
        get: () => size,
      });
    dom.window.HTMLElement.prototype.scrollTo = function (options) {
      if (typeof options === "object")
        this.scrollTop = options.top ?? this.scrollTop;
    };
    const native = createNativeEditingApi(
      Object.assign(new EventEmitter(), { send() {} }),
      () => "synthetic-document",
      dom.window.document,
      "linux",
    );
    Object.assign(dom.window, { zenx: { nativeEditing: native } });
    let cancelled = 0;
    const offCancel = native.onSelectAllCancelled(() => cancelled++);
    const viewport = { current: null as HTMLDivElement | null };
    const controller = { current: null as VirtualTranscriptHandle | null };
    const position = {
      scroll: { top: 0, following: false },
      virtualAnchor: null,
    };
    const rows = Array.from({ length: 500 }, (_, i) => ({
      key: `row-${i}`,
      content: React.createElement("p", null, `Canonical ${i}`),
    }));
    const root = createRoot(document.getElementById("root")!);
    const fullDOM = () =>
      document.querySelector('[data-native-transcript-selection="complete"]');
    const tick = async (milliseconds: number) => {
      await act(async () => t.mock.timers.tick(milliseconds));
      await act(async () => t.mock.timers.tick(0));
    };
    const key = () => {
      const event = new dom.window.KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement!.dispatchEvent(event);
      return event;
    };
    const selection = document.getSelection()!;
    const select = (node: Node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new dom.window.Event("selectionchange"));
    };
    try {
      await act(async () => {
        root.render(
          React.createElement(TranscriptViewport, {
            experimental: true,
            rows,
            header: null,
            footer: null,
            viewport,
            controller,
            position,
            onViewportScroll() {},
            onContentSettled() {},
            className: "messages",
            children: null,
          }),
        );
      });
      assert.equal(Boolean(fullDOM()), false);
      document.body.focus();
      if (scenario === "prevented outside") {
        await act(async () => select(document.querySelector("aside")!));
        document.body.addEventListener("keydown", (event) =>
          event.preventDefault(),
        );
        await act(async () => assert.equal(key().defaultPrevented, true));
        assert.ok(
          fullDOM(),
          "document capture prepared before the later preventDefault",
        );
        assert.equal(selection.toString(), "Outside selection");
        await tick(1500);
        assert.equal(
          Boolean(fullDOM()),
          false,
          "unselected prepared transcript must return to virtualization",
        );
        assert.equal(
          selection.toString(),
          "Outside selection",
          "cleanup preserves the unrelated Selection",
        );
      } else if (
        scenario === "repeated page" ||
        scenario === "preexisting page"
      ) {
        let selectionChanges = 0;
        document.addEventListener("selectionchange", () => selectionChanges++);
        if (scenario === "preexisting page") {
          await act(async () => select(document.body));
          await tick(0);
        }
        const changesBeforePreparation = selectionChanges;
        await act(async () => assert.equal(key().defaultPrevented, false));
        assert.ok(fullDOM());
        if (scenario === "repeated page") {
          await act(async () => select(document.body));
          await tick(0);
        }
        await act(async () => assert.equal(key().defaultPrevented, false));
        await tick(1500);
        assert.ok(
          fullDOM(),
          "existing page-wide Selection retains the canonical DOM",
        );
        assert.ok(selection.toString().includes("Canonical 499"));
        if (scenario === "preexisting page")
          assert.equal(
            selectionChanges,
            changesBeforePreparation,
            "an unchanged page-wide Selection emits no new event during preparation",
          );
        await act(async () => {
          selection.removeAllRanges();
          document.dispatchEvent(new dom.window.Event("selectionchange"));
        });
        await tick(0);
        assert.equal(
          Boolean(fullDOM()),
          false,
          "clearing the page Selection releases full DOM",
        );
      } else {
        document.querySelector("textarea")!.focus();
        await act(async () => assert.equal(key().defaultPrevented, false));
        await tick(1500);
        assert.equal(
          Boolean(fullDOM()),
          false,
          "editor focus never prepares the page transcript",
        );
        assert.equal(cancelled, 0);
      }
    } finally {
      await act(async () => root.unmount());
      offCancel();
      dom.window.close();
      t.mock.timers.reset();
      Object.assign(globalThis, previous);
    }
  });
