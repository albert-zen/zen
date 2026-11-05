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
import {
  MessageTargetNavigationContext,
  useMessageTargetNavigation,
  type MessageTargetRequest,
} from "../src/renderer/src/message-target-navigation.js";
import {
  createThreadReadingState,
  ThreadReadingContext,
} from "../src/renderer/src/thread-reading-state.js";
import { runtimeIntro, runtimeThread } from "./fixtures/agent-runtime-data.js";
import type { Thread } from "../src/protocol-client/index.js";

// Real hook + actual patched Legend, with bounded controlled layout and public APIs.
test("cancelled virtual targets retire locally across snapshots, but new IDs and live snapshot replacements still reveal", async () => {
  const dom = new JSDOM(
    "<button id='reader'>Reader</button><div id='root'></div>",
    { url: "http://localhost" },
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
  const tops = new WeakMap<HTMLElement, number>();
  let scrolls = 0;
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
        return this.classList.contains("messages") ? 280560 : 280;
      },
    },
    scrollWidth: {
      configurable: true,
      get() {
        return 800;
      },
    },
    scrollTop: {
      configurable: true,
      get() {
        return tops.get(this) ?? 0;
      },
      set(value: number) {
        assert.ok(
          ++scrolls < 1000,
          "controlled target layout exceeded scroll budget",
        );
        tops.set(
          this,
          Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value)),
        );
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
  const reading = createThreadReadingState();
  reading.scroll = { top: 0, following: false };
  const template = runtimeThread([runtimeIntro[0]!], "completed", "thread-a");
  let thread: Thread = {
    ...template,
    turns: Array.from({ length: 1000 }, (_, index) => ({
      ...template.turns[0]!,
      id: `turn-${index}`,
      items: [{ ...runtimeIntro[0]!, id: `user-${index}` }],
    })),
  };
  const consumed: string[] = [];
  const calls: number[] = [];
  const held: Array<() => void> = [];
  let hold = false;
  const materialize = (turnId: string, onRevealed: () => void) =>
    controller.current?.reveal(turnId, onRevealed) ?? Promise.resolve(false);
  function Harness({ thread }: { thread: Thread }) {
    useMessageTargetNavigation(thread, viewport, () => {}, materialize);
    return React.createElement(ExperimentalTranscriptViewport, {
      rows: thread.turns.map((turn) => ({
        key: turn.id,
        content: React.createElement(
          "article",
          { "data-sent-message-id": turn.items[0]!.id, tabIndex: -1 },
          turn.id,
        ),
      })),
      header: null,
      footer: null,
      viewport,
      controller,
      listRef,
      position: reading,
      className: "messages",
      onViewportScroll() {},
      onContentSettled() {},
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const render = async (request: MessageTargetRequest | null) =>
    act(async () =>
      root.render(
        React.createElement(
          ThreadReadingContext.Provider,
          { value: reading },
          React.createElement(
            MessageTargetNavigationContext.Provider,
            {
              value: {
                request,
                consumed: (id: number) =>
                  consumed.push(`${request?.threadId}:${id}`),
              },
            },
            React.createElement(Harness, { thread }),
          ),
        ),
      ),
    );
  const request = (id: number): MessageTargetRequest => ({
    threadId: thread.id,
    itemId: "user-999",
    requestId: id,
  });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
  const snapshot = () => {
    thread = { ...thread, turns: [...thread.turns] };
  };
  const reader = document.getElementById("reader")!;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values.map(String).join(" "));
  try {
    await render(null);
    await settle();
    const original = listRef.current!.scrollToIndex;
    listRef.current!.scrollToIndex = (params) => {
      calls.push(params.index);
      const actual = original(params);
      return hold ? new Promise<void>((resolve) => held.push(resolve)) : actual;
    };
    hold = true;
    const first = request(1);
    await render(first);
    assert.equal(calls.length, 1);
    await act(async () => {
      reader.focus();
      viewport.current!.dispatchEvent(
        new dom.window.WheelEvent("wheel", { deltaY: -10, bubbles: true }),
      );
      viewport.current!.scrollTop = 140000;
      viewport.current!.dispatchEvent(new dom.window.Event("scroll"));
    });
    await settle();
    const pausedTop = viewport.current!.scrollTop;
    snapshot();
    await render(first);
    await settle();
    assert.equal(
      calls.length,
      1,
      "later canonical data cannot restart a reader-cancelled request",
    );
    assert.equal(viewport.current!.scrollTop, pausedTop);
    assert.equal(document.activeElement, reader);
    assert.deepEqual(consumed, []);
    hold = false;
    await render(request(2));
    await settle();
    assert.deepEqual(consumed, ["thread-a:2"]);
    assert.equal(
      (document.activeElement as HTMLElement).dataset.sentMessageId,
      "user-999",
    );
    hold = true;
    const third = request(3);
    await render(third);
    assert.equal(calls.length, 3);
    hold = false;
    await act(async () => {
      const source = controller.current!.materialize("turn-300", () => {});
      assert.ok(source);
      source.element
        .querySelector<HTMLElement>("article")!
        .focus({ preventScroll: true });
    });
    await settle();
    const sourceTop = viewport.current!.scrollTop;
    snapshot();
    await render(third);
    await settle();
    assert.equal(
      calls.length,
      4,
      "new inline source retires the older target across a later snapshot",
    );
    assert.equal(viewport.current!.scrollTop, sourceTop);
    assert.equal(
      (document.activeElement as HTMLElement).dataset.sentMessageId,
      "user-300",
    );
    assert.deepEqual(consumed, ["thread-a:2"]);
    await render(request(4));
    await settle();
    assert.deepEqual(consumed, ["thread-a:2", "thread-a:4"]);
    hold = true;
    const fifth = request(5);
    await render(fifth);
    const before = calls.length;
    snapshot();
    await render(fifth);
    await settle();
    assert.equal(
      calls.length,
      before + 1,
      "snapshot replacement starts a live attempt without retiring its request",
    );
    hold = false;
    await act(async () => held.at(-1)!());
    await settle();
    assert.deepEqual(
      consumed,
      ["thread-a:2", "thread-a:4", "thread-a:5"],
      "the current replacement still reveals and consumes exactly once",
    );
    thread = { ...thread, id: "thread-b" };
    await render(request(5));
    await settle();
    assert.deepEqual(
      consumed,
      ["thread-a:2", "thread-a:4", "thread-a:5", "thread-b:5"],
      "request IDs are scoped by exact thread, including completed IDs",
    );
    await render(request(1));
    await settle();
    assert.equal(
      consumed.at(-1),
      "thread-b:1",
      "retiring thread-a/request-1 cannot retire another thread's request-1",
    );
    assert.equal(
      errors.filter((value) =>
        /flushSync|nested update|maximum update|not wrapped in act/i.test(
          value,
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

test("cross-thread excerpts reveal outside the layout commit, fence old owners and allow a repeated new request", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const thread = runtimeThread(runtimeIntro, "completed");
  const calls: unknown[] = [];
  const done: number[] = [];
  let layoutCommitted = false;
  function View({ request }: { request: MessageTargetRequest }) {
    const viewport = React.useRef<HTMLElement>(null);
    useMessageTargetNavigation(
      thread,
      viewport,
      () => {},
      undefined,
      (quote) => {
        assert.equal(layoutCommitted, true);
        calls.push(quote);
        return true;
      },
    );
    React.useLayoutEffect(() => {
      layoutCommitted = true;
    }, [request]);
    return null;
  }
  const request = {
    threadId: thread.id,
    itemId: "exact-source",
    requestId: 1,
    excerpt: "完整原句。",
  };
  const render = async (next: MessageTargetRequest) => {
    layoutCommitted = false;
    // The hook's own microtask runs after the synchronous layout phase.
    await act(async () =>
      root.render(
        React.createElement(MessageTargetNavigationContext.Provider, {
          value: { request: next, consumed: (id) => done.push(id) },
          children: React.createElement(View, { request: next }),
        }),
      ),
    );
  };
  try {
    await render({ ...request, threadId: "other-owner" });
    assert.equal(calls.length, 0);
    await render(request);
    assert.deepEqual(calls, [
      { threadId: thread.id, id: "exact-source", excerpt: "完整原句。" },
    ]);
    await render(request);
    assert.equal(calls.length, 1);
    await render({ ...request, requestId: 2 });
    assert.equal(calls.length, 2);
    assert.deepEqual(done, [1, 2]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});
