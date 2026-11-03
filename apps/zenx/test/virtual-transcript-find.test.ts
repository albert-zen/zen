import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import type { Turn } from "../src/protocol-client/index.js";
import {
  ExperimentalTranscriptViewport,
  type VirtualTranscriptHandle,
} from "../src/renderer/src/ExperimentalTranscriptViewport.js";
import { VirtualTranscriptFind } from "../src/renderer/src/VirtualTranscriptFind.js";
import { createThreadReadingState } from "../src/renderer/src/thread-reading-state.js";
import { i18n } from "../src/renderer/src/i18n.js";

// Actual Find + actual npm Legend web component. Deterministic JSDOM geometry is not native layout acceptance.
test("virtual Find reveals unmounted data, wraps, respects editor shortcuts, preserves Selection and cancels newer intent", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "http://localhost",
    pretendToBeVisual: true,
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
  for (const name of [
    "clientHeight",
    "offsetHeight",
    "clientWidth",
    "offsetWidth",
    "scrollHeight",
    "scrollWidth",
  ])
    Object.defineProperty(dom.window.HTMLElement.prototype, name, {
      configurable: true,
      get() {
        return name === "scrollHeight" && this.classList.contains("messages")
          ? 280000
          : name.endsWith("Width")
            ? 800
            : this.classList.contains("messages")
              ? 600
              : 280;
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
  const highlights = new Map();
  Object.defineProperty(dom.window, "CSS", { value: { highlights } });
  Object.defineProperty(dom.window, "Highlight", {
    value: class extends Set {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  });
  const view = { current: null as HTMLDivElement | null },
    viewport = { current: null as HTMLDivElement | null },
    controller = { current: null as VirtualTranscriptHandle | null },
    listRef = { current: null as LegendListRef | null };
  const reading = createThreadReadingState();
  reading.scroll = { top: 0, following: false };
  const canonical = new Map();
  let textReads = 0;
  let turns = Array.from(
    { length: 1000 },
    (_, index) =>
      ({
        id: `turn-${index}`,
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: `item-${index}`,
            get text() {
              textReads++;
              return `Answer ${index} needle`;
            },
          },
        ],
      }) as Turn,
  );
  let rows = turns.map((turn, index) => ({
    key: JSON.stringify(["thread", "turn", turn.id]),
    content: React.createElement(
      "div",
      { "data-thread-find-item-id": turn.items[0]!.id },
      React.createElement("p", null, `Answer ${index} needle`),
    ),
  }));
  const root = createRoot(document.getElementById("root")!);
  const key = (
    target: HTMLElement,
    value: string,
    options: KeyboardEventInit = {},
  ) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    target.dispatchEvent(event);
    return event;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 550));
  const type = (value: string) => {
    const input = document.querySelector<HTMLInputElement>(
      "[role='search'] input",
    )!;
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values) => {
    errors.push(values.map(String).join(" "));
  };
  let pauses = 0;
  const pauseFollowing = () => {
    pauses++;
  };
  const render = () =>
    root.render(
      React.createElement(
        "div",
        { ref: view },
        React.createElement("button", { id: "origin" }, "Origin"),
        React.createElement(
          "div",
          { className: "cm-editor" },
          React.createElement("input", { id: "editor" }),
        ),
        React.createElement(VirtualTranscriptFind, {
          threadId: "thread",
          turns,
          canonical,
          view,
          viewport,
          controller,
          reading,
          pauseFollowing,
        }),
        React.createElement(ExperimentalTranscriptViewport, {
          rows,
          header: null,
          footer: null,
          viewport,
          controller,
          listRef,
          position: reading,
          className: "messages",
          onViewportScroll() {},
          onContentSettled() {},
        }),
      ),
    );
  try {
    await i18n.changeLanguage("en");
    await act(async () => {
      render();
      await settle();
    });
    const origin = document.getElementById("origin")!;
    assert.equal(document.querySelector("[role='search']"), null);
    assert.equal(
      textReads,
      0,
      "closed Find reads/parses no loaded message text",
    );
    origin.addEventListener("keydown", (event) => event.preventDefault(), {
      once: true,
    });
    await act(async () => {
      key(origin, "f", { ctrlKey: true });
    });
    assert.equal(
      document.querySelector("[role='search']"),
      null,
      "already handled shortcut remains handled",
    );
    const editor = document.getElementById("editor")!;
    await act(async () => {
      assert.equal(key(editor, "f", { ctrlKey: true }).defaultPrevented, false);
    });
    assert.equal(
      document.querySelector("[role='search']"),
      null,
      "editor retains its own Find precedence",
    );
    await act(async () => {
      origin.focus();
      assert.equal(key(origin, "f", { ctrlKey: true }).defaultPrevented, true);
    });
    const input = document.querySelector<HTMLInputElement>(
      "[role='search'] input",
    )!;
    assert.equal(document.activeElement, input);
    const selectedNode = viewport.current!.querySelector(
      "[data-thread-find-item-id]",
    )!.firstChild!.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(selectedNode, 0);
    range.setEnd(selectedNode, 6);
    selection.removeAllRanges(); // Simulate a new user text drag replacing the input's prior selection.
    selection.addRange(range);
    assert.equal(
      selection.toString(),
      "Answer",
      "the user's selected transcript text is established before Find",
    );
    assert.equal(
      viewport.current!.querySelector("[data-thread-find-item-id='item-999']"),
      null,
      "target starts unmounted",
    );
    await act(async () => {
      type("Answer 999");
      await settle();
    });
    await act(async () => {
      await settle();
    });
    assert.equal(input.value, "Answer 999");
    assert.equal(
      textReads,
      2000,
      "query changes reuse the once-parsed immutable loaded items",
    );
    assert.ok(
      viewport.current!.querySelector("[data-thread-find-item-id='item-999']"),
      "data match materializes the distant row",
    );
    const painted = [
      ...(highlights.get("zenx-thread-find-active") ?? []),
    ] as Range[];
    assert.equal(painted[0]?.toString(), "Answer 999");
    const beforeRepaintTop = viewport.current!.scrollTop;
    await act(async () => {
      const body = viewport.current!.querySelector(
        "[data-thread-find-item-id='item-999']",
      )!;
      body.innerHTML = "<p>Answer 999 refreshed needle</p>";
      await settle();
    });
    const repainted = [...highlights.get("zenx-thread-find-active")] as Range[];
    assert.equal(repainted[0]?.toString(), "Answer 999");
    assert.equal(
      repainted[0]?.startContainer.isConnected,
      true,
      "streamed DOM replacements resolve a fresh connected range",
    );
    assert.equal(
      viewport.current!.scrollTop,
      beforeRepaintTop,
      "highlight refresh never starts a new navigation",
    );
    assert.equal(
      document.activeElement,
      input,
      "reveal never takes focus from the search input",
    );
    assert.equal(
      selection.toString(),
      "Answer",
      "Find does not replace the user's native Selection",
    );
    assert.ok(
      viewport.current!.querySelectorAll("[data-transcript-row-key]").length <
        60,
      "no hidden all-history DOM",
    );
    await act(async () => {
      type("needle");
      await settle();
    });
    await act(async () => {
      key(input, "Enter", { shiftKey: true });
      await settle();
    });
    await act(async () => {
      await settle();
    });
    assert.match(
      document.querySelector("[role='search'] [role='status']")!.textContent!,
      /1000 of 1000/,
    );
    assert.equal(
      reading.snapshot().get(JSON.stringify(["turn", "turn-999"])),
      true,
    );
    const beforeRefreshReveal = controller.current!.reveal;
    let refreshReveals = 0;
    controller.current!.reveal = (...args) => {
      refreshReveals++;
      return beforeRefreshReveal(...args);
    };
    await act(async () => {
      const prepended = {
        id: "backfill",
        status: "completed",
        items: [
          { type: "agentMessage", id: "backfill-item", text: "Earlier needle" },
        ],
      } as Turn;
      turns = [prepended, ...turns];
      rows = [
        {
          key: JSON.stringify(["thread", "turn", "backfill"]),
          content: React.createElement(
            "div",
            { "data-thread-find-item-id": "backfill-item" },
            React.createElement("p", null, "Earlier needle"),
          ),
        },
        ...rows,
      ];
      render();
      await settle();
    });
    assert.match(
      document.querySelector("[role='search'] [role='status']")!.textContent!,
      /1001 of 1001/,
    );
    assert.equal(
      refreshReveals,
      0,
      "new earlier matches rebase the active identity without unsolicited navigation",
    );
    controller.current!.reveal = beforeRefreshReveal;
    await act(async () => {
      key(input, "Escape");
    });
    assert.equal(document.querySelector("[role='search']"), null);
    assert.equal(
      document.activeElement,
      origin,
      "Escape restores the connected opening control",
    );
    assert.equal(highlights.has("zenx-thread-find-active"), false);
    const actual = listRef.current!.scrollToIndex;
    listRef.current!.scrollToIndex = () => new Promise<void>(() => {});
    await act(async () => {
      key(origin, "f", { ctrlKey: true });
    });
    await act(async () => {
      type("Answer 888");
    });
    const owned = controller.current!.captureReveal();
    await act(async () => {
      type("Answer 777");
    });
    assert.equal(
      owned.isCurrent(),
      false,
      "new query cancels the older reveal generation",
    );
    const current = controller.current!.captureReveal();
    await act(async () => {
      origin.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", { bubbles: true }),
      );
      origin.focus();
    });
    assert.equal(
      current.isCurrent(),
      false,
      "new reader intent cancels pending reveal",
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>("[aria-label='Close thread search']")!
        .click();
    });
    assert.equal(
      document.activeElement,
      origin,
      "close never steals focus after newer navigation",
    );
    listRef.current!.scrollToIndex = actual;
    assert.ok(pauses > 0);
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
    console.error = originalError;
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});
