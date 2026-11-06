import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { LegendListRef } from "@legendapp/list/react";
import {
  ExperimentalTranscriptViewport,
  type VirtualTranscriptHandle,
} from "../src/renderer/src/ExperimentalTranscriptViewport.js";

// Deterministic geometry and event ordering exercise the actual pinned Legend
// component, not trusted browser input or native Send acceptance.
for (const dataChange of [false, true] as const)
  for (const mode of ["upward", "downward", "nested", "untouched"] as const)
    test(`initial Legend scroll yields only to transcript reader input: ${mode}, dataChange=${dataChange}`, async () => {
      const dom = new JSDOM("<div id='root'></div>", {
        url: "http://localhost",
      });
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
      const position = {
        scroll: { top: 0, following: true },
        virtualAnchor: null,
      };
      let rows = Array.from({ length: 1000 }, (_, index) => ({
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
      const renderWithFooter = (footer: React.ReactNode) =>
        React.createElement(ExperimentalTranscriptViewport, {
          rows,
          header: null,
          footer,
          viewport,
          controller,
          listRef,
          position,
          className: "messages",
          onViewportScroll() {},
          onContentSettled() {},
        });
      const pendingFooter = React.createElement(
        "p",
        { "data-pending": "true" },
        "Sending",
      );
      try {
        await act(async () => root.render(renderWithFooter(pendingFooter)));
        const node = viewport.current!;
        await act(async () => {
          if (dataChange) {
            rows = [
              ...rows,
              {
                key: "new-tail",
                content: React.createElement("div", null, "New tail"),
              },
            ];
            flushSync(() => root.render(renderWithFooter(pendingFooter)));
          }
          node.scrollTop = 585;
          if (mode === "nested") {
            const nested = document.createElement("div");
            nested.style.overflowY = "auto";
            Object.defineProperties(nested, {
              scrollHeight: { value: 1000 },
              clientHeight: { value: 100 },
            });
            node.append(nested);
            nested.dispatchEvent(
              new dom.window.WheelEvent("wheel", {
                deltaY: -660,
                bubbles: true,
              }),
            );
            nested.remove();
          } else if (mode !== "untouched") {
            node.dispatchEvent(
              new dom.window.WheelEvent("wheel", {
                deltaY: mode === "upward" ? -660 : 100,
                bubbles: true,
              }),
            );
            node.scrollTop = mode === "upward" ? 0 : 685;
            node.dispatchEvent(new dom.window.Event("scroll"));
          }
          await new Promise((resolve) => setTimeout(resolve, 950));
        });
        assert.equal(
          node.scrollTop,
          mode === "upward" ? 0 : mode === "downward" ? 685 : 279400,
          "initial correction must yield to transcript input, without consuming nested input or changing untouched initial following",
        );
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
        await act(async () => root.unmount());
        console.error = originalError;
        Object.assign(globalThis, previous, {
          IS_REACT_ACT_ENVIRONMENT: undefined,
        });
        dom.window.close();
      }
    });
