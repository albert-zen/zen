import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  TranscriptViewport,
  type VirtualTranscriptHandle,
} from "../src/renderer/src/ExperimentalTranscriptViewport.js";
import {
  ownsNativeTranscriptSelection,
  transcriptSelectionIntersects,
  alignTranscriptSelectionAnchor,
} from "../src/renderer/src/native-transcript-selection.js";

function rectList(...rects: DOMRect[]): DOMRectList {
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  });
}

test("native page selection defers to editors and covers visible transcripts only", () => {
  const dom = new JSDOM(
    "<main class='thread-view'><div class='messages'><p>History</p></div><textarea></textarea><div contenteditable='true' tabindex='0'></div></main><main class='thread-view' hidden><div class='messages'></div></main>",
  );
  dom.window.HTMLElement.prototype.getClientRects = () =>
    rectList(new dom.window.DOMRect());
  try {
    const [primary, hidden] =
      dom.window.document.querySelectorAll<HTMLElement>(".messages");
    assert.equal(ownsNativeTranscriptSelection(primary!), true);
    assert.equal(ownsNativeTranscriptSelection(hidden!), false);
    const view = primary!.closest<HTMLElement>(".thread-view")!;
    view.getClientRects = () => rectList();
    assert.equal(
      ownsNativeTranscriptSelection(primary!),
      false,
      "a CSS-hidden or detached cached viewport cannot claim native page selection",
    );
    view.getClientRects = () => rectList(new dom.window.DOMRect());

    const other = dom.window.document.createElement("main");
    other.className = "thread-view";
    other.innerHTML = '<div class="messages">Other visible conversation</div>';
    dom.window.document.body.append(other);
    assert.equal(
      ownsNativeTranscriptSelection(other.firstElementChild as HTMLElement),
      true,
      "page-wide native Select All cannot silently omit a second visible conversation",
    );
    const outside = dom.window.document.createElement("button");
    dom.window.document.body.append(outside);
    outside.focus();
    assert.equal(
      ownsNativeTranscriptSelection(primary!),
      true,
      "sidebar/non-editor focus retains original page-wide native selection scope",
    );
    dom.window.document.querySelector("textarea")!.focus();
    assert.equal(ownsNativeTranscriptSelection(primary!), false);
    (
      dom.window.document.querySelector("[contenteditable]") as HTMLElement
    ).focus();
    assert.equal(ownsNativeTranscriptSelection(primary!), false);
    dom.window.document.body.focus();
    const range = dom.window.document.createRange();
    range.selectNodeContents(dom.window.document.body);
    dom.window.document.getSelection()!.removeAllRanges();
    dom.window.document.getSelection()!.addRange(range);
    assert.equal(
      transcriptSelectionIntersects(primary!),
      true,
      "body-owned native range still includes transcript even when neither endpoint is inside it",
    );
    dom.window.document.getSelection()!.removeAllRanges();
    assert.equal(transcriptSelectionIntersects(primary!), false);
  } finally {
    dom.window.close();
  }
});

test("explicit native Select All mounts canonical order only until actual Selection clears", async () => {
  const dom = new JSDOM(
    "<main class='thread-view'><div id='root'></div><textarea id='editor'></textarea></main>",
    { url: "https://synthetic.invalid" },
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver,
  };
  let prepare: (() => boolean) | undefined;
  let cancelled: (() => void) | undefined;
  let subscriptions = 0;
  let pauses = 0;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(dom.window, {
    zenx: {
      nativeEditing: {
        onSelectAllCancelled(listener: () => void) {
          cancelled = listener;
          return () => {
            cancelled = undefined;
          };
        },
        onPrepareSelectAll(listener: () => boolean) {
          prepare = listener;
          subscriptions++;
          return () => {
            prepare = undefined;
            subscriptions--;
          };
        },
      },
    },
  });
  const rect = (top = 0, height = 280) => ({
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: top,
    toJSON() {},
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return rect(0, this.classList.contains("messages") ? 600 : 280);
  };
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return rectList(this.getBoundingClientRect());
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
        return this.classList.contains("messages") ? 1400000 : 280;
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
  const rows = Array.from({ length: 5000 }, (_, i) => ({
    key: `row-${i}`,
    content: React.createElement("p", null, `Canonical ${i}`),
  }));
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
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
          onNativeSelectionStart() {
            pauses++;
          },
          className: "messages",
          children: null,
        }),
      ),
    );
    assert.equal(subscriptions, 1);
    assert.ok(
      document.querySelectorAll("[data-transcript-row-key]").length < 200,
    );
    document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
    assert.equal(prepare!(), false);
    assert.ok(
      document.querySelectorAll("[data-transcript-row-key]").length < 200,
      "editor selection never mounts all history",
    );
    document.querySelector<HTMLTextAreaElement>("textarea")!.blur();
    await act(async () => assert.equal(prepare!(), true));
    const all = Array.from(
      document.querySelectorAll<HTMLElement>("[data-transcript-row-key]"),
    );
    assert.deepEqual(
      all.map((row) => row.dataset.transcriptRowKey),
      rows.map((row) => row.key),
    );
    assert.equal(pauses, 1);
    assert.equal(
      subscriptions,
      1,
      "synchronous preparation must not unregister the pending native request",
    );
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("selectionchange"));
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(
      document.querySelectorAll("[data-transcript-row-key]").length,
      5000,
      "transient collapsed state before native selection must not undo preparation",
    );
    await act(async () => {
      cancelled!();
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.ok(
      document.querySelectorAll("[data-transcript-row-key]").length < 200,
      "native request cancellation releases prepared DOM when no Selection was ever established",
    );
    await act(async () => assert.equal(prepare!(), true));
    await act(async () => {
      cancelled!();
      assert.equal(prepare!(), true);
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(
      document.querySelectorAll("[data-transcript-row-key]").length,
      5000,
      "a new explicit request supersedes old cancellation before it can destroy the new prepared DOM",
    );
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(document.body);
    selection.addRange(range);
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("selectionchange"));
      await new Promise((r) => setTimeout(r, 30));
    });
    await act(async () => {
      cancelled!();
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(
      document.querySelectorAll("[data-transcript-row-key]").length,
      5000,
      "a cancellation cannot discard an already established native Selection",
    );
    assert.ok(
      controller.current,
      "full DOM retains target/Find materialization handle",
    );
    let revealed = 0;
    const oldOwner = controller.current!.captureReveal();
    await act(async () =>
      assert.equal(
        await controller.current!.reveal("row-4200", () => {
          revealed++;
        }),
        true,
      ),
    );
    assert.equal(revealed, 1);
    assert.equal(
      oldOwner.isCurrent(),
      false,
      "new explicit navigation retires previous ownership",
    );
    let prepared = false;
    const materialized = controller.current!.materialize("row-42", () => {
      prepared = true;
    });
    assert.equal(prepared, true);
    assert.equal(materialized?.element.dataset.transcriptRowKey, "row-42");
    document.dispatchEvent(new dom.window.WheelEvent("wheel"));
    assert.equal(
      materialized?.isCurrent(),
      false,
      "reader wheel cancels queued full-DOM target navigation",
    );
    assert.equal(selection.toString().includes("Canonical 0"), true);
    assert.ok(
      selection.toString().indexOf("Canonical 0") <
        selection.toString().indexOf("Canonical 4999"),
    );
    await act(async () => {
      selection.removeAllRanges();
      document.dispatchEvent(new dom.window.Event("selectionchange"));
      await new Promise((r) => setTimeout(r, 60));
    });
    assert.ok(
      document.querySelectorAll("[data-transcript-row-key]").length < 200,
      "cleared native selection releases full DOM",
    );
    assert.equal(position.scroll.following, false);
    const stalePrepare = prepare!;
    await act(async () =>
      root.render(
        React.createElement(TranscriptViewport, {
          experimental: false,
          rows,
          header: null,
          footer: null,
          viewport,
          controller,
          position,
          onViewportScroll() {},
          onContentSettled() {},
          onNativeSelectionStart() {
            pauses++;
          },
          className: "messages",
          children: React.createElement("p", null, "Normal full transcript"),
        }),
      ),
    );
    assert.equal(
      subscriptions,
      0,
      "default/full-DOM path never registers a preparation bridge",
    );
    const pausesBeforeLateRequest = pauses;
    assert.equal(
      stalePrepare(),
      false,
      "late callback cannot claim or mutate a replacement viewport",
    );
    assert.equal(pauses, pausesBeforeLateRequest);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("selection transition restores canonical visible row pixel offset rather than old estimated scrollTop", () => {
  const dom = new JSDOM(
    '<div id="v"><div data-transcript-row-key="row-a">A</div><div data-transcript-row-key="row-b">B</div></div>',
  );
  try {
    const viewport = dom.window.document.getElementById("v")!;
    const row = viewport.lastElementChild as HTMLElement;
    viewport.scrollTop = 8000;
    viewport.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    row.getBoundingClientRect = () => ({ top: 445 }) as DOMRect;
    alignTranscriptSelectionAnchor(viewport, { key: "row-b", offset: -23 });
    assert.equal(viewport.scrollTop, 8368);
    alignTranscriptSelectionAnchor(viewport, { key: "missing", offset: 10 });
    assert.equal(
      viewport.scrollTop,
      8368,
      "a removed row cannot restore an unrelated target",
    );
  } finally {
    dom.window.close();
  }
});
