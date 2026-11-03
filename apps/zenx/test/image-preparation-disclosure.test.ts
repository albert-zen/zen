import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { ContextItem } from "../../../src/item-list.js";
import {
  captureImagePreparationDisclosure,
  imagePreparationDisclosureKey,
  ImagePreparationNotice,
} from "../src/renderer/src/ImagePreparationNotice.js";
import {
  TranscriptViewport,
  type VirtualTranscriptHandle,
} from "../src/renderer/src/ExperimentalTranscriptViewport.js";
import { createThreadReadingState } from "../src/renderer/src/thread-reading-state.js";
import "../src/renderer/src/i18n.js";

function imageItems(sampleId = "sample"): ContextItem[] {
  const original = {
    type: "attachment",
    sha256: "original",
    mediaType: "image/png",
    byteLength: 100,
    width: 4000,
    height: 3000,
  };
  return [
    {
      id: "input",
      threadId: "thread",
      createdAt: "2026-11-03T00:00:00Z",
      kind: "message",
      role: "user",
      source: { kind: "user_message", sequence: 0 },
      content: { text: "image", parts: [] },
    },
    {
      id: "notice",
      threadId: "thread",
      createdAt: "2026-11-03T00:00:00Z",
      kind: "message",
      role: "user",
      source: {
        kind: "image_preparation",
        sequence: 1,
        metadata: {
          onlySampleId: sampleId,
          imagePreparation: {
            profile: "codex-high-v1",
            outcome: "prepared",
            occurrence: {
              itemId: "input",
              field: "parts",
              partIndex: 0,
              sha256: original.sha256,
            },
            originalAttachment: original,
          },
        },
      },
      content: {
        text: "model notice",
        parts: [
          { type: "text", text: "model notice" },
          {
            type: "image",
            attachment: {
              ...original,
              sha256: "prepared",
              width: 1600,
              height: 1200,
            },
          },
        ],
      },
    },
  ] as ContextItem[];
}

function setup() {
  const dom = new JSDOM(
    "<main class='thread-view'><div id='root'></div></main>",
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
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
  for (const name of [
    "clientHeight",
    "offsetHeight",
    "scrollHeight",
    "clientWidth",
    "offsetWidth",
    "scrollWidth",
  ]) {
    Object.defineProperty(dom.window.HTMLElement.prototype, name, {
      configurable: true,
      get() {
        return name.includes("Width")
          ? 800
          : name === "scrollHeight"
            ? 280000
            : this.classList.contains("messages")
              ? 600
              : 280;
      },
    });
  }
  dom.window.HTMLElement.prototype.scrollTo = function (options) {
    if (typeof options === "object")
      this.scrollTop = options.top ?? this.scrollTop;
  };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const root = createRoot(document.getElementById("root")!);
  return {
    dom,
    root,
    async close() {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
      dom.window.close();
    },
  };
}
const details = (scope: ParentNode = document) =>
  scope.querySelector<HTMLDetailsElement>(".image-preparation-notice details")!;
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

test("image disclosure preserves native uncontrolled behavior by default", async () => {
  const env = setup();
  try {
    const render = () =>
      env.root.render(
        React.createElement(ImagePreparationNotice, { items: imageItems() }),
      );
    await act(async () => render());
    assert.equal(details().open, false);
    assert.equal(details().dataset.imagePreparationSampleId, undefined);
    await act(async () => {
      details().open = true;
      details().dispatchEvent(new env.dom.window.Event("toggle"));
    });
    await act(async () => render());
    assert.equal(
      details().open,
      true,
      "uncontrolled DOM remains native on ordinary rerender",
    );
    const reading = createThreadReadingState();
    captureImagePreparationDisclosure(
      document.getElementById("root")!,
      reading,
    );
    assert.equal(
      reading.snapshot().size,
      0,
      "default disclosure does not enter reading state",
    );
  } finally {
    await env.close();
  }
});

test("image disclosures isolate identical sample IDs across Threads and different samples within one Thread", async () => {
  const env = setup();
  const a = createThreadReadingState();
  const b = createThreadReadingState();
  const render = (sample = "sample") =>
    env.root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "section",
          { id: "a" },
          React.createElement(ImagePreparationNotice, {
            items: imageItems(sample),
            reading: a,
          }),
        ),
        React.createElement(
          "section",
          { id: "b" },
          React.createElement(ImagePreparationNotice, {
            items: imageItems(),
            reading: b,
          }),
        ),
      ),
    );
  try {
    await act(async () => render());
    const first = () => details(document.getElementById("a")!);
    const second = () => details(document.getElementById("b")!);
    assert.equal(first().open, false);
    assert.equal(second().open, false);
    await act(async () => {
      first().open = true;
      first().dispatchEvent(new env.dom.window.Event("toggle"));
    });
    assert.equal(
      a.snapshot().get(imagePreparationDisclosureKey("sample")),
      true,
    );
    assert.notEqual(
      b.snapshot().get(imagePreparationDisclosureKey("sample")),
      true,
    );
    assert.equal(second().open, false);
    await act(async () => {
      captureImagePreparationDisclosure(document.getElementById("b")!, b);
    });
    assert.equal(first().open, true);
    await act(async () => render("next-sample"));
    assert.equal(
      first().open,
      false,
      "new sample is not expanded by the previous sample",
    );
    await act(async () => render());
    assert.equal(
      first().open,
      true,
      "returning to the same sample restores only that Thread's choice",
    );
    assert.equal(second().open, false);
  } finally {
    await env.close();
  }
});

test("native viewport entry, cancellation and Selection exit capture image disclosure before queued toggle delivery", async () => {
  const env = setup();
  let prepare: (() => boolean) | undefined;
  let cancelled: (() => void) | undefined;
  Object.assign(env.dom.window, {
    zenx: {
      nativeEditing: {
        onPrepareSelectAll(listener: () => boolean) {
          prepare = listener;
          return () => {
            prepare = undefined;
          };
        },
        onSelectAllCancelled(listener: () => void) {
          cancelled = listener;
          return () => {
            cancelled = undefined;
          };
        },
      },
    },
  });
  const reading = createThreadReadingState();
  const viewport = { current: null as HTMLDivElement | null };
  const controller = { current: null as VirtualTranscriptHandle | null };
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    key: `row-${i}`,
    content: React.createElement("p", null, `Canonical ${i}`),
  }));
  const header = React.createElement(ImagePreparationNotice, {
    items: imageItems(),
    reading,
  });
  const suppressToggle = (event: Event) => event.stopPropagation();
  // Withhold React's asynchronous native toggle observation. The transition must
  // read the actual departing DOM, not rely on a timer or manufacture a Selection.
  document.addEventListener("toggle", suppressToggle, true);
  try {
    await act(async () =>
      env.root.render(
        React.createElement(TranscriptViewport, {
          experimental: true,
          rows,
          header,
          footer: null,
          viewport,
          controller,
          position: reading,
          className: "messages",
          children: null,
          onViewportScroll() {},
          onContentSettled() {},
          onBeforeViewportChange: (node) =>
            captureImagePreparationDisclosure(node, reading),
        }),
      ),
    );
    assert.equal(details().open, false);
    await act(async () => assert.equal(prepare!(), true));
    assert.equal(details().open, false, "initially closed notice stays closed");
    await act(async () => {
      cancelled!();
      await tick();
    });
    assert.equal(details().open, false);
    await act(async () => {
      details().open = true;
      assert.equal(prepare!(), true);
    });
    assert.equal(
      details().open,
      true,
      "open image details survive synchronous Select All preparation",
    );
    assert.equal(
      document.querySelectorAll(".image-preparation-notice").length,
      1,
    );
    await act(async () => {
      details().open = false;
      cancelled!();
      await tick();
    });
    assert.equal(
      details().open,
      false,
      "cancellation captures a close whose toggle was not delivered",
    );
    await act(async () => {
      details().open = true;
      assert.equal(prepare!(), true);
    });
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(document.body);
    selection.addRange(range);
    await act(async () => {
      document.dispatchEvent(new env.dom.window.Event("selectionchange"));
      await tick();
    });
    assert.equal(
      document.querySelectorAll("[data-transcript-row-key]").length,
      1000,
    );
    await act(async () => {
      details().open = false;
      selection.removeAllRanges();
      document.dispatchEvent(new env.dom.window.Event("selectionchange"));
      await tick();
    });
    assert.ok(
      document.querySelectorAll("[data-transcript-row-key]").length < 200,
    );
    assert.equal(
      details().open,
      false,
      "actual Selection exit captures the departing disclosure",
    );
    assert.equal(
      document.querySelectorAll(".image-preparation-notice").length,
      1,
    );
  } finally {
    document.removeEventListener("toggle", suppressToggle, true);
    await env.close();
  }
});
