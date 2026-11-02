import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  captureReadingAnchor,
  findReadingAnchor,
} from "../src/renderer/src/thread-reading-state.js";
import { revealAndPositionReadingTarget } from "../src/renderer/src/message-target-navigation.js";

function rect(top: number, height: number, left = 0, width = 600): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON() {},
  };
}
async function withLayout(
  run: (h: {
    viewport: HTMLElement;
    turn: HTMLElement;
    item: HTMLElement;
    frame(): void;
    frames: Map<number, FrameRequestCallback>;
    changeTop(top: number): void;
    reads(): number;
    resetReads(): void;
  }) => void | Promise<void>,
) {
  const dom = new JSDOM(
    '<div class="thread-view"><div class="messages"><section data-turn-id="turn-a"><article data-quote-thread-id="thread-a" data-quote-item-id="item-a" tabindex="-1">source</article></section></div><div class="bottom-zone"></div></div>',
    { pretendToBeVisual: true },
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  const viewport = document.querySelector<HTMLElement>(".messages")!;
  const turn = document.querySelector<HTMLElement>("section")!;
  const item = document.querySelector<HTMLElement>("article")!;
  let itemTop = 350,
    reads = 0,
    sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  Object.defineProperties(viewport, {
    clientHeight: { value: 500 },
    scrollHeight: { value: 5000 },
  });
  viewport.getBoundingClientRect = () => {
    reads++;
    return rect(40, 500);
  };
  document.querySelector<HTMLElement>(".bottom-zone")!.getBoundingClientRect =
    () => {
      reads++;
      return rect(440, 100);
    };
  item.getBoundingClientRect = turn.getBoundingClientRect = () => {
    reads++;
    return rect(itemTop - viewport.scrollTop, 200);
  };
  document.elementFromPoint = () => item;
  document.hasFocus = () => true;
  const h = {
    viewport,
    turn,
    item,
    frames,
    frame() {
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback(0);
    },
    changeTop(top: number) {
      itemTop = top;
    },
    reads: () => reads,
    resetReads() {
      reads = 0;
    },
  };
  try {
    await run(h);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

test("reading anchor capture is identity-based and bounded, never walks historical rectangles", async () => {
  await withLayout(({ viewport, item, changeTop, reads }) => {
    changeTop(20);
    viewport.querySelectorAll = () => {
      throw Error("must not scan all rows");
    };
    const anchor = captureReadingAnchor(viewport);
    assert.deepEqual(anchor, {
      turnId: "turn-a",
      itemId: "item-a",
      offset: 20,
    });
    assert.ok(
      findReadingAnchor(viewport, anchor!) === item,
      "Resolved anchor is the exact expected DOM item",
    );
    assert.ok(reads() <= 12, `bounded geometry reads: ${reads()}`);
  });
});

test("cold anchor restore reveals before geometry, corrects once after layout and retains intra-item offset", async () => {
  await withLayout(
    ({ viewport, turn, item, frame, changeTop, frames, reads }) => {
      let completed = 0;
      revealAndPositionReadingTarget({
        viewport,
        turnId: "turn-a",
        target: () => item,
        offset: 30,
        isCurrent: () => true,
        onComplete: () => completed++,
      });
      assert.equal(turn.dataset.readingReveal, "true");
      assert.equal(viewport.scrollTop, 0);
      frame();
      assert.equal(viewport.scrollTop, 340);
      changeTop(750); // forgotten intrinsic sizes/width settle before the final check
      frame();
      assert.equal(viewport.scrollTop, 740);
      frame();
      assert.equal(completed, 1);
      assert.equal(turn.dataset.readingReveal, undefined);
      assert.equal(frames.size, 0);
      assert.ok(reads() <= 12, `bounded restore geometry reads: ${reads()}`);
    },
  );
});

for (const intent of [
  "wheel",
  "keydown",
  "pointerdown",
  "selectionchange",
] as const) {
  test(`new ${intent} cancels an old reading correction without touching selection`, async () => {
    await withLayout(({ viewport, turn, item, frame, frames }) => {
      let completed = 0;
      revealAndPositionReadingTarget({
        viewport,
        turnId: "turn-a",
        target: () => item,
        offset: 0,
        isCurrent: () => true,
        onComplete: () => completed++,
      });
      frame();
      const before = viewport.scrollTop;
      if (intent === "selectionchange") {
        const range = document.createRange();
        range.selectNodeContents(item);
        document.getSelection()!.addRange(range);
        document.dispatchEvent(new window.Event(intent));
      } else
        viewport.dispatchEvent(new window.Event(intent, { bubbles: true }));
      frame();
      frame();
      assert.equal(viewport.scrollTop, before);
      assert.equal(completed, 0);
      assert.equal(frames.size, 0);
      assert.equal(turn.dataset.readingReveal, undefined);
      if (intent === "selectionchange")
        assert.equal(document.getSelection()!.toString(), "source");
    });
  });
}

test("stale owners and missing targets never focus, consume or endlessly retry", async () => {
  await withLayout(({ viewport, item, frame, frames }) => {
    let current = true,
      completed = 0;
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      isCurrent: () => current,
      onComplete: () => completed++,
    });
    current = false;
    frame();
    frame();
    assert.equal(viewport.scrollTop, 0);
    assert.ok(document.activeElement !== item, "Exact expected focus identity");
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => null,
      isCurrent: () => true,
      onComplete: () => completed++,
    });
    frame();
    frame();
    frame();
    assert.equal(completed, 0);
    assert.equal(frames.size, 0);
  });
});

test("navigation validates the real uncovered geometry before focus or consume", async () => {
  await withLayout(({ viewport, item, frame }) => {
    let completed = 0;
    // A layout that cannot scroll the target clear of the Composer must fail closed.
    item.getBoundingClientRect = () => rect(460, 40);
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      isCurrent: () => true,
      focus: true,
      onComplete: () => completed++,
    });
    frame();
    frame();
    frame();
    assert.equal(completed, 0);
    assert.ok(document.activeElement !== item, "Exact expected focus identity");
  });
});

test("navigation into an available viewport focuses only after positioning and validation", async () => {
  await withLayout(({ viewport, item, frame }) => {
    let completed = 0;
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      isCurrent: () => true,
      focus: true,
      onComplete: () => completed++,
    });
    assert.ok(document.activeElement !== item, "Exact expected focus identity");
    frame();
    assert.equal(completed, 0);
    frame();
    frame();
    assert.equal(completed, 1);
    assert.ok(document.activeElement === item, "Exact expected focus identity");
    assert.equal(item.dataset.messageTarget, "true");
  });
});

import { act, withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeMessage,
  runtimeThread,
} from "./fixtures/agent-runtime-data.js";

function installThreadGeometry() {
  const tops = new WeakMap<HTMLElement, number>();
  let sourceTop = 350,
    width = 600;
  const frames = new Map<number, FrameRequestCallback>();
  const observers = new Set<() => void>();
  let nextFrame = 0;
  const previous = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
  };
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
      private targets = new Set<Element>();
      constructor(private callback: ResizeObserverCallback) {}
      private deliver = () =>
        this.callback(
          [...this.targets].map((target) => ({
            target,
            contentRect: target.getBoundingClientRect(),
          })) as ResizeObserverEntry[],
          this as unknown as ResizeObserver,
        );
      observe(target: Element) {
        this.targets.add(target);
        observers.add(this.deliver);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        observers.delete(this.deliver);
      }
    },
  });
  Object.defineProperties(window.HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ? 500 : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return this.classList.contains("messages") ? 4000 : 0;
      },
    },
    scrollTop: {
      configurable: true,
      get() {
        return tops.get(this) ?? 0;
      },
      set(value: number) {
        tops.set(this, Math.max(0, Math.min(3500, value)));
      },
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("messages")) return rect(40, 500, 0, width);
    if (this.classList.contains("bottom-zone")) return rect(440, 100, 0, width);
    if (
      this.dataset.quoteItemId ||
      this.dataset.turnId ||
      this.dataset.sentMessageId
    )
      return rect(
        sourceTop - (this.closest(".messages")?.scrollTop ?? 0),
        200,
        0,
        width,
      );
    return rect(0, 0, 0, 0);
  };
  document.elementFromPoint = () =>
    document.querySelector('[data-quote-item-id="source-a"]');
  document.hasFocus = () => true;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  return {
    scroll: () => document.querySelector<HTMLElement>(".messages")!,
    changeLayout(top: number, nextWidth = width) {
      sourceTop = top;
      width = nextWidth;
    },
    async frame() {
      await act(async () => {
        const batch = [...frames.values()];
        frames.clear();
        for (const callback of batch) callback(0);
      });
    },
    async settle() {
      for (let i = 0; i < 3; i++) await this.frame();
    },
    async resize() {
      await act(async () => {
        for (const callback of observers) callback();
      });
    },
    restore() {
      Object.assign(globalThis, previous);
    },
  };
}
function anchoredThread(id = "thread-a") {
  const thread = runtimeThread(
    [runtimeMessage("source-a", "Source")],
    "completed",
    id,
  );
  return {
    ...thread,
    canonicalItems: [
      {
        type: "agent_message" as const,
        id: "source-a",
        threadId: id,
        turnId: thread.turns[0]!.id,
        createdAt: "2026-11-02T00:00:00Z",
        text: "Source",
      },
    ],
  };
}

test("actual ThreadView cold remount restores canonical anchor after intrinsic heights and width change", async () => {
  await withRuntimeDom(
    async (h) => {
      const layout = installThreadGeometry();
      try {
        const a = anchoredThread();
        await h.render(a);
        await act(async () => {
          layout.scroll().scrollTop = 330;
          layout.scroll().dispatchEvent(new window.Event("scroll"));
        });
        assert.equal(
          document
            .querySelector<HTMLElement>('[data-quote-item-id="source-a"]')!
            .getBoundingClientRect().top,
          20,
        );
        await h.hide();
        layout.changeLayout(1750);
        await h.render(a);
        await layout.settle();
        assert.equal(
          layout.scroll().scrollTop,
          1730,
          "not the stale numeric top 330",
        );
        layout.changeLayout(2050, 360);
        await layout.resize();
        await layout.settle();
        assert.equal(
          layout.scroll().scrollTop,
          2030,
          "width reflow preserves the same 20px internal offset",
        );
        assert.ok(document.querySelector(".back-live"));
      } finally {
        layout.restore();
      }
    },
    { keyByThread: true },
  );
});

test("actual ThreadView cancels cold correction on new scrolling and thread switches", async () => {
  await withRuntimeDom(async (h) => {
    const layout = installThreadGeometry();
    try {
      const a = anchoredThread();
      await h.render(a);
      await act(async () => {
        layout.scroll().scrollTop = 330;
        layout.scroll().dispatchEvent(new window.Event("scroll"));
      });
      await h.hide();
      layout.changeLayout(1750);
      await h.render(a);
      await layout.frame();
      await act(async () => {
        layout
          .scroll()
          .dispatchEvent(
            new window.WheelEvent("wheel", { deltaY: -50, bubbles: true }),
          );
        layout.scroll().scrollTop = 1000;
        layout.scroll().dispatchEvent(new window.Event("scroll"));
      });
      await layout.settle();
      assert.equal(layout.scroll().scrollTop, 1000);
      await h.hide();
      await h.render(a);
      await h.render(anchoredThread("thread-b"));
      await layout.settle();
      assert.equal(
        layout.scroll().scrollTop,
        3500,
        "another exact Thread starts live, never inherits A's pending restore",
      );
      assert.ok(
        document.querySelector(".back-live") === null,
        "Expected DOM presence or absence",
      );
    } finally {
      layout.restore();
    }
  });
});

import React from "react";
import { createRoot } from "react-dom/client";
import {
  ThreadView,
  ThreadViewActionsProvider,
} from "../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../src/renderer/src/thread-reading-state.js";
import type { MessageTargetRequest } from "../src/renderer/src/message-target-navigation.js";
import {
  editComposer,
  emptyComposerState,
} from "../src/renderer/src/composer-state.js";
import { withReferenceDraft } from "../src/renderer/src/reference-draft.js";
import type { Thread } from "../src/protocol-client/index.js";

async function withNavigationView(
  run: (h: {
    layout: ReturnType<typeof installThreadGeometry>;
    consumed: number[];
    render(
      thread: Thread,
      request?: MessageTargetRequest | null,
      references?: string[],
    ): Promise<void>;
    quote(index: number): Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
  });
  const layout = installThreadGeometry();
  const root = createRoot(document.getElementById("root")!);
  const consumed: number[] = [];
  const source = async () => {};
  try {
    await run({
      layout,
      consumed,
      async render(thread, request = null, references = []) {
        await act(async () =>
          root.render(
            React.createElement(ThreadReadingStateProvider, {
              children: React.createElement(ThreadViewActionsProvider, {
                source,
                fork: async () => {},
                messageTarget: request,
                onMessageTargetConsumed: (id) => consumed.push(id),
                children: React.createElement(ThreadView, {
                  thread,
                  composer: editComposer(
                    emptyComposerState(),
                    withReferenceDraft(
                      "question",
                      references.map((id) => ({
                        kind: "message",
                        id,
                        threadId: thread.id,
                        name: "source",
                        cwd: thread.cwd,
                        excerpt: "Source",
                      })),
                    ),
                  ),
                  approvals: [],
                  onDraftChange() {},
                  onInterrupt: async () => {},
                  onRespondToApproval: async () => {},
                  onSubmit: async () => {},
                }),
              }),
            }),
          ),
        );
      },
      async quote(index) {
        await act(async () =>
          document
            .querySelectorAll<HTMLElement>(
              ".inline-composer-editor .reference-token-details",
            )
            [index]!.click(),
        );
        await act(async () =>
          document
            .querySelector<HTMLElement>(".reference-open-source")!
            .click(),
        );
      },
    });
  } finally {
    await act(async () => root.unmount());
    layout.restore();
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}
function twoSourceThread(): Thread {
  const a = anchoredThread();
  const first = a.turns[0]!;
  return {
    ...a,
    turns: [
      {
        ...first,
        items: [
          {
            type: "userMessage",
            id: "runtime-user",
            clientId: null,
            content: [{ type: "text", text: "First", text_elements: [] }],
          },
          runtimeMessage("source-a", "Source A"),
          runtimeMessage("final-a", "Final A"),
        ],
      },
      {
        ...first,
        id: "turn-b",
        items: [
          {
            type: "userMessage",
            id: "user-b",
            clientId: null,
            content: [{ type: "text", text: "Second", text_elements: [] }],
          },
          runtimeMessage("source-b", "Source B"),
        ],
      },
    ],
    canonicalItems: [
      ...a.canonicalItems,
      {
        ...a.canonicalItems[0]!,
        id: "source-b",
        turnId: "turn-b",
        text: "Source B",
      },
    ],
  };
}

test("actual target navigation expands then validates; a newer request alone is consumed", async () => {
  await withNavigationView(async ({ render, layout, consumed }) => {
    const thread = twoSourceThread();
    await render(thread, {
      threadId: thread.id,
      itemId: "runtime-user",
      requestId: 1,
    });
    await layout.frame();
    await render(thread, {
      threadId: thread.id,
      itemId: "user-b",
      requestId: 2,
    });
    document.elementFromPoint = () =>
      document.querySelector('[data-sent-message-id="user-b"]');
    await layout.settle();
    assert.deepEqual(consumed, [2]);
    assert.equal(
      document.activeElement?.getAttribute("data-sent-message-id"),
      "user-b",
    );
    assert.equal(
      document
        .querySelector('[data-turn-id="turn-b"] .turn-toggle')!
        .getAttribute("aria-expanded"),
      "true",
    );
  });
});

test("actual quote navigation reveals a collapsed intermediate source, and newer quote wins", async () => {
  await withNavigationView(async ({ render, layout }) => {
    const thread = twoSourceThread();
    await render(thread, null, ["source-a", "source-b"]);
    assert.ok(
      document.querySelector('[data-quote-item-id="source-a"]') === null,
      "Expected DOM presence or absence",
    );
    await act(async () => {
      document.querySelector<HTMLElement>(".messages")!.scrollTop = 0;
    });
    await (async () => {
      const buttons = document.querySelectorAll<HTMLElement>(
        ".inline-composer-editor .reference-token-details",
      );
      await act(async () => buttons[0]!.click());
      await act(async () =>
        document.querySelector<HTMLElement>(".reference-open-source")!.click(),
      );
    })();
    assert.ok(
      document.querySelector('[data-quote-item-id="source-a"]'),
      "existing Turn disclosure commits before positioning",
    );
    assert.ok(
      document.querySelector(
        '[data-turn-id="runtime-turn"][data-reading-reveal]',
      ),
      "Popover close must transfer source focus to the pending navigation, not return to its trigger",
    );
    await layout.frame();
    const second = document.querySelectorAll<HTMLElement>(
      ".inline-composer-editor .reference-token-details",
    )[1]!;
    await act(async () => second.click());
    await act(async () =>
      document.querySelector<HTMLElement>(".reference-open-source")!.click(),
    );
    document.elementFromPoint = () =>
      document.querySelector('[data-quote-item-id="source-b"]');
    await layout.settle();
    assert.equal(
      document.activeElement?.getAttribute("data-quote-item-id"),
      "source-b",
    );
    assert.equal(
      document
        .querySelector('[data-quote-item-id="source-a"]')!
        .hasAttribute("data-message-target"),
      false,
    );
  });
});

for (const intent of ["thread", "selection", "covered", "hidden"] as const) {
  test(`actual target ${intent} invalidation never consumes or focuses`, async () => {
    await withNavigationView(async ({ render, layout, consumed }) => {
      const thread = twoSourceThread();
      await render(thread, {
        threadId: thread.id,
        itemId: "runtime-user",
        requestId: 1,
      });
      if (intent === "thread") await render({ ...thread, id: "other" });
      else if (intent === "selection") {
        await act(async () => {
          const range = document.createRange();
          range.selectNodeContents(
            document.querySelector('[data-sent-message-id="user-b"]')!,
          );
          document.getSelection()!.addRange(range);
          document.dispatchEvent(new window.Event("selectionchange"));
        });
      } else if (intent === "covered")
        document.elementFromPoint = () =>
          document.querySelector(".bottom-zone");
      else document.querySelector<HTMLElement>(".thread-view")!.hidden = true;
      await layout.settle();
      assert.deepEqual(consumed, []);
      assert.notEqual(
        document.activeElement?.getAttribute("data-sent-message-id"),
        "runtime-user",
      );
      if (intent === "selection")
        assert.ok(document.getSelection()!.toString().includes("Second"));
    });
  });
}

test("a header covering the target's leading edge prevents consume even if its center is exposed", async () => {
  await withLayout(({ viewport, item, frame }) => {
    let completed = 0;
    const header = document.createElement("header");
    document.body.append(header);
    document.elementFromPoint = (_x, y) => (y < 160 ? header : item);
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      focus: true,
      isCurrent: () => true,
      onComplete: () => completed++,
    });
    frame();
    frame();
    frame();
    assert.equal(completed, 0);
    assert.ok(document.activeElement !== item, "Exact expected focus identity");
  });
});

test("equivalent target-request objects do not cancel the same owned request", async () => {
  await withNavigationView(async ({ render, layout, consumed }) => {
    const thread = twoSourceThread();
    await render(thread, {
      threadId: thread.id,
      itemId: "user-b",
      requestId: 4,
    });
    await layout.frame();
    await render(
      { ...thread },
      { threadId: thread.id, itemId: "user-b", requestId: 4 },
    );
    document.elementFromPoint = () =>
      document.querySelector('[data-sent-message-id="user-b"]');
    await layout.settle();
    assert.deepEqual(consumed, [4]);
  });
});

test("empty view stays empty through resize", async () => {
  await withRuntimeDom(async (h) => {
    const layout = installThreadGeometry();
    try {
      await h.render(anchoredThread(), { thread: null });
      assert.ok(document.querySelector(".thread-empty"));
      assert.ok(
        document.querySelector("[data-turn-id]") === null,
        "Expected DOM presence or absence",
      );
      await layout.resize();
      await layout.settle();
      assert.ok(
        document.querySelector("[data-reading-reveal]") === null,
        "Expected DOM presence or absence",
      );
      assert.ok(
        document.querySelector(".back-live") === null,
        "Expected DOM presence or absence",
      );
    } finally {
      layout.restore();
    }
  });
});

test("navigation may land at a clamped start if the entire short target is genuinely visible", async () => {
  await withLayout(({ viewport, item, frame, changeTop }) => {
    let top = 0,
      completed = 0;
    changeTop(50);
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => top,
      set(value: number) {
        top = Math.max(0, value);
      },
    });
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      focus: true,
      isCurrent: () => true,
      onComplete: () => completed++,
    });
    frame();
    frame();
    frame();
    assert.equal(completed, 1);
    assert.ok(document.activeElement === item, "Exact expected focus identity");
    assert.equal(viewport.scrollTop, 0);
  });
});

test("a newer focus outside the ThreadView cancels a pending navigation", async () => {
  await withLayout(({ viewport, item, frame }) => {
    const outside = document.createElement("button");
    outside.textContent = "Sidebar";
    document.body.append(outside);
    let completed = 0;
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      focus: true,
      isCurrent: () => true,
      onComplete: () => completed++,
    });
    frame();
    outside.focus();
    frame();
    frame();
    assert.equal(completed, 0);
    assert.ok(
      document.activeElement === outside,
      "Exact expected focus identity",
    );
  });
});

test("navigation to a tall target validates its leading visible region without requiring its whole height", async () => {
  await withLayout(({ viewport, item, frame }) => {
    let completed = 0;
    item.getBoundingClientRect = () => rect(350 - viewport.scrollTop, 900);
    const hits: number[] = [];
    document.elementFromPoint = (_x, y) => {
      hits.push(y);
      return y < 440 ? item : document.querySelector(".bottom-zone");
    };
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      focus: true,
      isCurrent: () => true,
      onComplete: () => completed++,
    });
    frame();
    frame();
    frame();
    assert.equal(completed, 1);
    assert.ok(document.activeElement === item, "Exact expected focus identity");
    assert.equal(item.getBoundingClientRect().top, 48);
    assert.ok(item.getBoundingClientRect().bottom > 440);
    assert.deepEqual(hits, [50, 438]);
  });
});

test("source closure starts bounded positioning only after that exact signal", async () => {
  await withLayout(async ({ viewport, turn, item, frame, frames, reads }) => {
    let close = () => {};
    const afterClose = new Promise<void>((resolve) => {
      close = resolve;
    });
    let completed = 0;
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      afterClose,
      focus: true,
      isCurrent: () => true,
      onComplete: () => completed++,
    });
    frame();
    frame();
    frame();
    assert.equal(frames.size, 0);
    assert.equal(viewport.scrollTop, 0);
    assert.equal(reads(), 0);
    assert.equal(turn.dataset.readingReveal, undefined);
    close();
    await Promise.resolve();
    assert.equal(turn.dataset.readingReveal, "true");
    frame();
    frame();
    frame();
    assert.equal(completed, 1);
    assert.equal(frames.size, 0);
  });
});

for (const intent of [
  "wheel",
  "outside focus",
  "owner",
  "retired close",
] as const) {
  test(`waiting source closure is cancelled by ${intent} before geometry work`, async () => {
    await withLayout(async ({ viewport, turn, item, frame, frames, reads }) => {
      let close = () => {},
        retire = () => {};
      const afterClose = new Promise<void>((resolve, reject) => {
        close = resolve;
        retire = () => reject();
      });
      let completed = 0,
        finished = 0;
      const cancel = revealAndPositionReadingTarget({
        viewport,
        turnId: "turn-a",
        target: () => item,
        afterClose,
        focus: true,
        isCurrent: () => true,
        onComplete: () => completed++,
        onFinish: () => finished++,
      });
      if (intent === "wheel") document.dispatchEvent(new window.Event("wheel"));
      else if (intent === "outside focus") {
        const button = document.createElement("button");
        document.body.append(button);
        button.focus();
      } else if (intent === "owner") cancel();
      else retire();
      await Promise.resolve();
      close();
      await Promise.resolve();
      frame();
      frame();
      frame();
      assert.equal(completed, 0);
      assert.equal(finished, 1);
      assert.equal(frames.size, 0);
      assert.equal(reads(), 0);
      assert.equal(viewport.scrollTop, 0);
      assert.equal(turn.dataset.readingReveal, undefined);
    });
  });
}

test("a tall target with its visible trailing region covered is not consumed", async () => {
  await withLayout(({ viewport, item, frame }) => {
    let completed = 0;
    item.getBoundingClientRect = () => rect(350 - viewport.scrollTop, 900);
    document.elementFromPoint = (_x, y) =>
      y > 435 ? document.querySelector(".bottom-zone") : item;
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      focus: true,
      isCurrent: () => true,
      onComplete: () => completed++,
    });
    frame();
    frame();
    frame();
    assert.equal(completed, 0);
    assert.ok(document.activeElement !== item, "Exact expected focus identity");
  });
});

test("a tall target that cannot move beyond a one-pixel viewport sliver is not a completed navigation", async () => {
  await withLayout(({ viewport, item, frame }) => {
    let completed = 0;
    item.getBoundingClientRect = () => rect(439, 900);
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      focus: true,
      isCurrent: () => true,
      onComplete: () => completed++,
    });
    frame();
    frame();
    frame();
    assert.equal(completed, 0);
    assert.ok(document.activeElement !== item, "Exact expected focus identity");
  });
});

test("unchanged ResizeObserver delivery does not restart an already aligned reading correction", async () => {
  await withRuntimeDom(async (h) => {
    const layout = installThreadGeometry();
    try {
      const thread = anchoredThread();
      await h.render(thread);
      await act(async () => {
        layout.scroll().scrollTop = 330;
        layout.scroll().dispatchEvent(new window.Event("scroll"));
      });
      layout.changeLayout(1750);
      await layout.resize();
      await layout.settle();
      assert.equal(layout.scroll().scrollTop, 1730);
      const focused = document.activeElement;
      for (let i = 0; i < 4; i++) {
        await layout.resize();
        assert.ok(
          document.querySelector("[data-reading-reveal]") === null,
          "Expected DOM presence or absence",
        );
        await layout.settle();
        assert.equal(layout.scroll().scrollTop, 1730);
        assert.ok(
          document.activeElement === focused,
          "Exact expected focus identity",
        );
      }
    } finally {
      layout.restore();
    }
  });
});

test("ordinary reference Escape close still restores its trigger after a prior source handoff", async () => {
  await withNavigationView(async ({ render, layout, quote }) => {
    await render(twoSourceThread(), null, ["source-a"]);
    await quote(0);
    await layout.settle();
    assert.equal(
      document.activeElement?.getAttribute("data-quote-item-id"),
      "source-a",
    );
    const trigger = document.querySelector<HTMLElement>(
      ".inline-composer-editor .reference-token-details",
    )!;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    assert.ok(document.querySelector(".reference-details-popover"));
    await act(async () =>
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.ok(
      document.querySelector(".reference-details-popover") === null,
      "Expected DOM presence or absence",
    );
    assert.ok(
      document.activeElement === trigger,
      "Exact expected focus identity",
    );
    assert.ok(
      document.querySelector("[data-reading-reveal]") === null,
      "Expected DOM presence or absence",
    );
  });
});

test("a quote source handoff survives the actual Radix outgoing-popover lifecycle", async () => {
  await withNavigationView(async ({ render, layout, quote }) => {
    const computedStyle = globalThis.getComputedStyle;
    const css = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: {
        escape(value: string) {
          assert.match(value, /^ui-(enter|exit)$/u);
          return value; // These fixture animation names need no CSS escaping.
        },
      },
    });
    // JSDOM does not run stylesheet animations. Expose the production open/exit
    // animation names to actual Radix Presence and explicitly end that lifecycle.
    globalThis.getComputedStyle = (element, pseudoElement) => {
      const style = computedStyle(element, pseudoElement);
      if (!element.matches(".reference-details-popover")) return style;
      return new Proxy(style, {
        get(target, key) {
          if (key === "animationName")
            return element.getAttribute("data-state") === "closed"
              ? "ui-exit"
              : "ui-enter";
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    try {
      await render(twoSourceThread(), null, ["source-a"]);
      await quote(0);
      const outgoing = document.querySelector<HTMLElement>(
        '.reference-details-popover[data-state="closed"]',
      );
      assert.ok(outgoing, "actual Radix Presence retains the outgoing popup");
      const source = document.querySelector<HTMLElement>(
        '[data-quote-item-id="source-a"]',
      )!;
      document.elementFromPoint = () =>
        outgoing.isConnected ? outgoing : source;
      await layout.settle();
      assert.ok(
        document.activeElement !== source,
        "Exact expected focus identity",
      );
      await act(async () => {
        const ended = new window.Event("animationend", { bubbles: true });
        Object.defineProperty(ended, "animationName", { value: "ui-exit" });
        outgoing.dispatchEvent(ended);
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      assert.equal(outgoing.isConnected, false);
      await layout.settle();
      assert.equal(document.activeElement === source, true);
    } finally {
      globalThis.getComputedStyle = computedStyle;
      if (css) Object.defineProperty(globalThis, "CSS", css);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
  });
});

for (const intent of ["owner", "outside focus"] as const) {
  test(`a quote popup handoff never defeats newer ${intent}`, async () => {
    await withNavigationView(async ({ render, layout, quote }) => {
      const thread = twoSourceThread();
      await render(thread, null, ["source-a"]);
      await quote(0);
      // Radix FocusScope releases the exact close callback in its unmount timer.
      // Exercise newer intent after that signal, not act() scheduler timing.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      assert.ok(document.querySelector("[data-reading-reveal]"));
      const outside = document.createElement("button");
      outside.textContent = "Other pane";
      document.body.append(outside);
      if (intent === "owner") await render({ ...thread, id: "other-thread" });
      await act(async () => outside.focus());
      await layout.settle();
      assert.ok(
        document.activeElement === outside,
        "Exact expected focus identity",
      );
      assert.ok(
        document.querySelector("[data-message-target]") === null,
        "Expected DOM presence or absence",
      );
      assert.ok(
        document.querySelector("[data-reading-reveal]") === null,
        "Expected DOM presence or absence",
      );
    });
  });
}

for (const retirement of ["reopen", "identity"] as const) {
  test(`a source-close ticket is retired on ${retirement} and cannot release a newer popup`, async () => {
    await withNavigationView(async () => {
      const { ReferenceToken } =
        await import("../src/renderer/src/ReferenceToken.js");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const computedStyle = globalThis.getComputedStyle;
      const css = Object.getOwnPropertyDescriptor(globalThis, "CSS");
      Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        value: {
          escape: (v: string) => {
            assert.match(v, /^ui-(enter|exit)$/u);
            return v;
          },
        },
      });
      globalThis.getComputedStyle = (element, pseudo) => {
        const style = computedStyle(element, pseudo);
        if (!element.matches(".reference-details-popover")) return style;
        return new Proxy(style, {
          get(target, key) {
            if (key === "animationName")
              return element.getAttribute("data-state") === "closed"
                ? "ui-exit"
                : "ui-enter";
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      const outcomes: string[] = [];
      let id = "source-a";
      const render = async () =>
        act(async () =>
          root.render(
            React.createElement(ReferenceToken, {
              reference: {
                kind: "message",
                id,
                threadId: "thread-a",
                name: "Source",
                excerpt: "Exact",
                cwd: "",
              },
              onSource: (closed) => {
                assert.ok(closed);
                void closed.then(
                  () => outcomes.push("closed"),
                  () => outcomes.push("retired"),
                );
                return true;
              },
            }),
          ),
        );
      const click = async (selector: string) =>
        act(async () => document.querySelector<HTMLElement>(selector)!.click());
      const end = async () => {
        const outgoing = document.querySelector(
          '.reference-details-popover[data-state="closed"]',
        );
        if (outgoing)
          await act(async () => {
            const event = new window.Event("animationend", { bubbles: true });
            Object.defineProperty(event, "animationName", { value: "ui-exit" });
            outgoing.dispatchEvent(event);
          });
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      };
      try {
        await render();
        await click(".reference-token-details");
        await click(".reference-open-source");
        assert.deepEqual(outcomes, []);
        if (retirement === "reopen") await click(".reference-token-details");
        else {
          id = "source-b";
          await render();
        }
        await act(async () => {});
        assert.deepEqual(outcomes, ["retired"]);
        if (retirement === "identity") {
          await end();
          await click(".reference-token-details");
        }
        await click(".reference-open-source");
        assert.deepEqual(
          outcomes,
          ["retired"],
          "a fresh handoff still waits for its own close",
        );
        await end();
        assert.deepEqual(outcomes, ["retired", "closed"]);
      } finally {
        await act(async () => root.unmount());
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        globalThis.getComputedStyle = computedStyle;
        if (css) Object.defineProperty(globalThis, "CSS", css);
        else Reflect.deleteProperty(globalThis, "CSS");
        host.remove();
      }
    });
  });
}

test("waiting source close absorbs only passive scroll and rebases before positioning", async () => {
  await withLayout(async ({ viewport, turn, item, frame, frames, reads }) => {
    let close = () => {};
    const afterClose = new Promise<void>((resolve) => {
      close = resolve;
    });
    let completed = 0;
    revealAndPositionReadingTarget({
      viewport,
      turnId: "turn-a",
      target: () => item,
      afterClose,
      focus: true,
      isCurrent: () => true,
      onComplete: () => completed++,
    });
    for (const top of [1000, 945, 910]) {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new window.Event("scroll"));
    }
    assert.equal(frames.size, 0);
    assert.equal(reads(), 0);
    assert.equal(turn.dataset.readingReveal, undefined);
    close();
    await Promise.resolve();
    // A delayed delivery of that same offset is not a new movement.
    viewport.dispatchEvent(new window.Event("scroll"));
    assert.equal(turn.dataset.readingReveal, "true");
    frame();
    frame();
    frame();
    assert.equal(completed, 1);
    assert.equal(frames.size, 0);
    assert.ok(
      document.activeElement === item,
      "Exact source receives focus after close and validation",
    );
  });
});

for (const intent of [
  "wheel",
  "pointerdown",
  "keydown",
  "selectionchange",
  "focusin",
  "blur",
  "visibilitychange",
  "owner",
  "retired close",
  "cancel",
] as const) {
  test(`passive scroll during source-close waiting does not weaken newer ${intent}`, async () => {
    await withLayout(async ({ viewport, turn, item, frame, frames, reads }) => {
      let close = () => {},
        retire = () => {};
      const afterClose = new Promise<void>((resolve, reject) => {
        close = resolve;
        retire = () => reject();
      });
      let current = true,
        finished = 0,
        completed = 0;
      const cancel = revealAndPositionReadingTarget({
        viewport,
        turnId: "turn-a",
        target: () => item,
        afterClose,
        focus: true,
        isCurrent: () => current,
        onComplete: () => completed++,
        onFinish: () => finished++,
      });
      viewport.scrollTop = 945;
      viewport.dispatchEvent(new window.Event("scroll"));
      if (intent === "owner") current = false;
      else if (intent === "retired close") retire();
      else if (intent === "cancel") cancel();
      else if (intent === "selectionchange") {
        const range = document.createRange();
        range.selectNodeContents(item);
        document.getSelection()!.addRange(range);
        document.dispatchEvent(new window.Event("selectionchange"));
      } else if (intent === "focusin") {
        const button = document.createElement("button");
        document.body.append(button);
        button.focus();
      } else if (intent === "blur")
        window.dispatchEvent(new window.Event("blur"));
      else document.dispatchEvent(new window.Event(intent));
      // Cancellation must survive another passive delivery and late exact close.
      viewport.scrollTop = 900;
      viewport.dispatchEvent(new window.Event("scroll"));
      await Promise.resolve();
      close();
      await Promise.resolve();
      frame();
      frame();
      frame();
      assert.equal(completed, 0);
      assert.equal(finished, 1);
      assert.equal(frames.size, 0);
      assert.equal(reads(), 0);
      assert.equal(viewport.scrollTop, 900);
      assert.equal(turn.dataset.readingReveal, undefined);
      assert.ok(
        document.activeElement !== item,
        "Cancelled source cannot regain focus",
      );
      if (intent === "selectionchange")
        assert.equal(document.getSelection()!.toString(), "source");
    });
  });
}

for (const afterClose of [false, true]) {
  test(`scalar scroll before first positioning frame still cancels (close signal ${afterClose})`, async () => {
    await withLayout(async ({ viewport, turn, item, frame, frames, reads }) => {
      let close = () => {};
      const signal = new Promise<void>((resolve) => {
        close = resolve;
      });
      let completed = 0,
        finished = 0;
      revealAndPositionReadingTarget({
        viewport,
        turnId: "turn-a",
        target: () => item,
        ...(afterClose ? { afterClose: signal } : {}),
        focus: true,
        isCurrent: () => true,
        onComplete: () => completed++,
        onFinish: () => finished++,
      });
      if (afterClose) {
        close();
        await Promise.resolve();
      }
      assert.equal(turn.dataset.readingReveal, "true");
      assert.equal(frames.size, 1);
      viewport.scrollTop = 55;
      viewport.dispatchEvent(new window.Event("scroll"));
      frame();
      frame();
      frame();
      assert.equal(completed, 0);
      assert.equal(finished, 1);
      assert.equal(reads(), 0);
      assert.equal(frames.size, 0);
      assert.equal(viewport.scrollTop, 55);
      assert.equal(turn.dataset.readingReveal, undefined);
      assert.ok(
        document.activeElement !== item,
        "Unexpected positioning scroll cannot focus",
      );
    });
  });
}
