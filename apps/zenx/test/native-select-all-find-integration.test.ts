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
import { VirtualTranscriptFind } from "../src/renderer/src/VirtualTranscriptFind.js";
import { createThreadReadingState } from "../src/renderer/src/thread-reading-state.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { Turn } from "../src/protocol-client/index.js";
import { EventEmitter } from "node:events";
import { createNativeEditingApi } from "../src/preload/native-editing.js";
import { ipcChannels } from "../src/preload/ipc.js";
test("actual preload and Find retain connected highlight across full DOM Selection and virtual restoration", async () => {
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
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const ipc = new EventEmitter();
  let token = "";
  let request = 0;
  let nextToken = 0;
  const acknowledgements: { id: number; ready: boolean }[] = [];
  const native = createNativeEditingApi(
    Object.assign(ipc, {
      send(
        channel: string,
        receivedToken: string,
        idOrEnabled: number | boolean,
        ready?: boolean,
      ) {
        if (
          channel === ipcChannels.nativeEditingRegister &&
          idOrEnabled === true
        )
          token = receivedToken;
        if (channel === ipcChannels.nativeEditingPrepared)
          acknowledgements.push({
            id: idOrEnabled as number,
            ready: ready === true,
          });
      },
    }),
    () => `component-${++nextToken}`,
    dom.window.document,
  );
  Object.assign(dom.window, {
    zenx: {
      nativeEditing: {
        onSelectAllCancelled(listener: () => void) {
          return native.onSelectAllCancelled(listener);
        },
        onPrepareSelectAll(listener: () => boolean) {
          const off = native.onPrepareSelectAll(listener);
          prepare = () => {
            const id = ++request;
            acknowledgements.length = 0;
            ipc.emit(ipcChannels.nativeEditingPrepare, {}, token, id);
            const ack = acknowledgements.at(-1);
            return ack?.id === id && ack.ready;
          };
          return () => {
            prepare = undefined;
            off();
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
    if (this.classList.contains("messages")) return rect(0, 600);
    const row = this.closest<HTMLElement>("[data-transcript-row-key]");
    const list = this.closest<HTMLElement>(".messages");
    if (row && list) {
      const key = JSON.parse(row.dataset.transcriptRowKey!)[2] as string;
      const index = Number(key.slice("turn-".length));
      return rect(index * 280 - list.scrollTop, 280);
    }
    return rect(0, 280);
  };
  dom.window.Range.prototype.getBoundingClientRect = function () {
    const element =
      this.startContainer.nodeType === 1
        ? (this.startContainer as Element)
        : this.startContainer.parentElement;
    const box = element?.getBoundingClientRect();
    return rect(box?.top ?? 0, 20);
  };
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
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
  };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const viewport = { current: null as HTMLDivElement | null };
  let revealCalls = 0;
  let currentController: VirtualTranscriptHandle | null = null;
  const controller = {
    get current() {
      return currentController;
    },
    set current(value: VirtualTranscriptHandle | null) {
      if (value && value !== currentController) {
        const reveal = value.reveal;
        value.reveal = (...args) => {
          revealCalls++;
          return reveal(...args);
        };
      }
      currentController = value;
    },
  };
  const position = createThreadReadingState();
  position.scroll = { top: 0, following: false };
  const highlights = new Map();
  Object.defineProperty(dom.window, "CSS", { value: { highlights } });
  Object.defineProperty(dom.window, "Highlight", {
    value: class extends Set {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  });
  const turns = Array.from({ length: 1000 }, (_, i) => ({
    id: `turn-${i}`,
    status: "completed",
    items: [
      { type: "agentMessage", id: `item-${i}`, text: `Canonical ${i} needle` },
    ],
  })) as Turn[];
  const rows = turns.map((turn, i) => ({
    key: JSON.stringify(["thread", "turn", turn.id]),
    content: React.createElement(
      "div",
      { "data-thread-find-item-id": `item-${i}` },
      React.createElement("p", null, `Canonical ${i} needle`),
    ),
  }));
  const view = { current: document.querySelector<HTMLElement>("main") };
  const canonical = new Map();
  const pauseFollowing = () => {};
  const root = createRoot(document.getElementById("root")!);
  const wait = () => new Promise((r) => setTimeout(r, 560));
  const key = (target: HTMLElement, value: string) =>
    target.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: value,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  const paint = () =>
    [...(highlights.get("zenx-thread-find-active") ?? [])] as Range[];
  function Scene() {
    const [viewportRevision, setRevision] = React.useState(0);
    const onViewportChanged = React.useCallback(
      () => setRevision((v) => v + 1),
      [],
    );
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(VirtualTranscriptFind, {
        threadId: "thread",
        turns,
        canonical,
        view,
        viewport,
        viewportRevision,
        controller,
        reading: position,
        pauseFollowing,
      }),
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
        onViewportChanged,
        className: "messages",
        children: null,
      }),
    );
  }
  try {
    await i18n.changeLanguage("en");
    await act(async () => {
      root.render(React.createElement(Scene));
      await wait();
    });
    assert.ok(
      document.querySelectorAll("[data-transcript-row-key]").length < 200,
    );
    await act(async () => {
      key(document.body, "f");
    });
    const input = document.querySelector<HTMLInputElement>(
      "[role='search'] input",
    )!;
    assert.ok(input, "actual Find opens on the virtual viewport");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Canonical 999");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await wait();
    });
    await act(async () => {
      await wait();
    });
    assert.equal(paint()[0]?.toString(), "Canonical 999");
    assert.equal(
      paint()[0]?.startContainer.isConnected,
      true,
      "baseline Find resolves a connected canonical target",
    );
    const revealsBeforeReplacement = revealCalls;
    document.body.tabIndex = -1;
    document.body.focus();
    await act(async () => assert.equal(prepare!(), true));
    assert.equal(
      document.querySelectorAll("[data-transcript-row-key]").length,
      1000,
    );
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(viewport.current!);
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      document.dispatchEvent(new dom.window.Event("selectionchange"));
      await new Promise((r) => setTimeout(r, 30));
    });
    const held = selection.toString();
    assert.ok(held.includes("Canonical 999"));
    assert.equal(
      paint()[0]?.startContainer.isConnected,
      true,
      "unchanged open Find must repaint onto the complete replacement viewport",
    );
    assert.equal(paint()[0]?.toString(), "Canonical 999");
    assert.ok(
      viewport.current!.contains(paint()[0]!.startContainer),
      "highlight belongs to exact complete viewport",
    );
    assert.equal(
      revealCalls,
      revealsBeforeReplacement,
      "same Find query cannot initiate another reveal on complete replacement",
    );
    assert.equal(
      selection.toString(),
      held,
      "Find repaint cannot replace native selected transcript content",
    );
    assert.ok(
      controller.current,
      "full DOM keeps the existing reveal contract",
    );
    await act(async () => {
      selection.removeAllRanges();
      document.dispatchEvent(new dom.window.Event("selectionchange"));
      await wait();
    });
    assert.ok(
      document.querySelectorAll("[data-transcript-row-key]").length < 200,
      "Selection clear returns to bounded DOM",
    );
    assert.equal(
      input.value,
      "Canonical 999",
      "Find query is retained across viewport replacement",
    );
    assert.equal(
      paint()[0]?.startContainer.isConnected,
      true,
      "unchanged open Find must repaint onto the replacement virtual viewport",
    );
    assert.equal(paint()[0]?.toString(), "Canonical 999");
    assert.ok(
      viewport.current!.contains(paint()[0]!.startContainer),
      "highlight belongs to exact virtual replacement viewport",
    );
    assert.equal(
      revealCalls,
      revealsBeforeReplacement,
      "same Find query cannot initiate another reveal on virtual restoration",
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
