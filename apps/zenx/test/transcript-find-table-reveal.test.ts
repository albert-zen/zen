import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { VirtualTranscriptFind } from "../src/renderer/src/VirtualTranscriptFind.js";
import type { VirtualTranscriptHandle } from "../src/renderer/src/ExperimentalTranscriptViewport.js";
import { Markdown } from "../src/renderer/src/Markdown.js";
import { createThreadReadingState } from "../src/renderer/src/thread-reading-state.js";
import type { Turn } from "../src/protocol-client/index.js";

test("Find reveals a Chinese match inside the wide Markdown table without moving its sibling", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://example.invalid",
    pretendToBeVisual: true,
  });
  const before = {
    window: globalThis.window,
    document: globalThis.document,
    actFlag: (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const view = { current: null as HTMLDivElement | null },
    viewport = { current: null as HTMLDivElement | null };
  const controller = {
    current: {
      reveal: async (_key: string, callback: () => void) => {
        callback();
        return true;
      },
      captureReveal: () => ({ isCurrent: () => true, cancel: () => {} }),
    } as unknown as VirtualTranscriptHandle,
  };
  const table =
    "| " +
    Array.from({ length: 12 }, (_, i) => "字段" + i).join(" | ") +
    " |\n| " +
    Array(12).fill("---").join(" | ") +
    " |\n| ";
  const row = (last: string) =>
    table + [...Array(11).fill("数值"), last].join(" | ") + " |";
  const source = row("仅此命中") + "\n\n" + row("旁边的表");
  const turns = [
    {
      id: "turn",
      status: "completed",
      items: [{ type: "agentMessage", id: "item", text: source }],
    },
  ] as unknown as Turn[];
  const root = createRoot(document.querySelector("#root")!);
  const rect = (left: number, right: number, top = 0, bottom = 300) => ({
    left,
    right,
    top,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON() {},
  });
  const key = (el: Element, k: string, more: KeyboardEventInit = {}) =>
    el.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: k,
        bubbles: true,
        cancelable: true,
        ...more,
      }),
    );
  const highlights = new Map();
  Object.defineProperty(dom.window, "CSS", { value: { highlights } });
  Object.defineProperty(dom.window, "Highlight", {
    value: class extends Set<Range> {
      constructor(...r: Range[]) {
        super(r);
      }
    },
  });
  try {
    await act(async () =>
      root.render(
        h(
          "div",
          { className: "thread-view", ref: view },
          h("button", { id: "origin" }, "origin"),
          h(VirtualTranscriptFind, {
            threadId: "thread",
            turns,
            canonical: new Map(),
            view,
            viewport,
            controller,
            reading: createThreadReadingState(),
            wakeups: [],
            pauseFollowing() {},
          }),
          h(
            "div",
            { ref: viewport },
            h(
              "div",
              { "data-thread-find-item-id": "item" },
              h(Markdown, { text: source }),
            ),
          ),
        ),
      ),
    );
    const [active, sibling] = [
      ...document.querySelectorAll<HTMLDivElement>(".markdown-table-wrap"),
    ];
    assert.ok(active && sibling);
    const cell = active.querySelector("td:last-child")!;
    assert.equal(cell.textContent, "仅此命中");
    active.getBoundingClientRect = () => rect(24, 424);
    sibling.getBoundingClientRect = () => rect(24, 424);
    viewport.current!.getBoundingClientRect = () => rect(0, 700, 0, 600);
    Object.defineProperties(active, {
      clientWidth: { value: 400 },
      scrollWidth: { value: 820 },
    });
    sibling.scrollLeft = 80;
    dom.window.Range.prototype.getBoundingClientRect = function () {
      assert.equal(this.startContainer.parentElement, cell);
      return rect(580 - active.scrollLeft, 642 - active.scrollLeft, 120, 139);
    };
    const origin = document.querySelector<HTMLButtonElement>("#origin")!;
    origin.focus();
    await act(async () => {
      key(origin, "f", { ctrlKey: true });
    });
    const input = document.querySelector<HTMLInputElement>(
      "[role=search] input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "仅此命中");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(
      document.querySelector("[role=status]")!.textContent,
      "1 of 1",
    );
    const selected = [...highlights.values()].flatMap((x) => [...x]) as Range[];
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.toString(), "仅此命中");
    assert.equal(document.activeElement, input);
    assert.equal(sibling.scrollLeft, 80);
    assert.ok(
      selected[0]!.getBoundingClientRect().right <= 424,
      "active range remains behind horizontal clipping",
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: before.window,
      document: before.document,
      IS_REACT_ACT_ENVIRONMENT: before.actFlag,
    });
    dom.window.close();
  }
});
