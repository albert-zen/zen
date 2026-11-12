import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  CONVERSATION_READ_KEY,
  createConversationReadStore,
  conversationReadStore,
  messageTailIsVisible,
  unreadThreadIds,
  useReadVisibleMessage,
} from "../src/renderer/src/conversation-read-state.js";
import type { ThreadSummary } from "../../../src/thread-summary.js";
import {
  roomMessageReadProjection,
  type RoomMessage,
} from "../../../packages/zenx-rooms-plugin/src/runtime.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const message = (id: string, createdAt: number, position?: number) => ({
  id,
  createdAt,
  ...(position === undefined ? {} : { position }),
});
function summary(id: string, createdAt: number): ThreadSummary {
  return {
    threadId: "thread",
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(9999).toISOString(),
    archived: false,
    status: "idle",
    preview: "unrelated preview",
    currentMetadata: {
      model: "test",
      provider: "test",
      cwd: "/work",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    lastTurnEnd: {
      id,
      turnId: "turn",
      position: createdAt,
      createdAt: new Date(createdAt).toISOString(),
    },
  };
}
test("first install establishes an old-history baseline; canonical new execution ends survive restart", () => {
  const disk = storage();
  const store = createConversationReadStore(disk, 100);
  assert.equal(
    unreadThreadIds([summary("old", 50)], store.getSnapshot()).size,
    0,
  );
  assert.equal(
    unreadThreadIds([summary("new", 150)], store.getSnapshot()).size,
    1,
  );
  const restarted = createConversationReadStore(disk, 1000);
  assert.equal(restarted.getSnapshot().baseline, 100);
  assert.equal(
    unreadThreadIds([summary("new", 150)], restarted.getSnapshot()).size,
    1,
  );
  restarted.advance("threads", "thread", message("new", 150, 150));
  assert.equal(
    unreadThreadIds([summary("new", 150)], restarted.getSnapshot()).size,
    0,
  );
  restarted.advance("threads", "thread", message("old", 50, 50));
  assert.equal(
    restarted.getSnapshot().threads.thread?.id,
    "new",
    "old history never regresses cursor",
  );
  assert.equal(
    unreadThreadIds(
      [summary("newer", 151)],
      createConversationReadStore(disk, 2000).getSnapshot(),
    ).size,
    1,
  );
  assert.ok(disk.getItem(CONVERSATION_READ_KEY));
});
test("updatedAt, user sends, missing legacy projections and streaming state do not invent an unseen execution end", () => {
  const store = createConversationReadStore(storage(), 100);
  const thread = summary("agent", 101);
  thread.lastMessage = {
    id: "user",
    createdAt: new Date(102).toISOString(),
    kind: "user",
  };
  assert.equal(
    unreadThreadIds([thread], store.getSnapshot()).size,
    1,
    "a queued user send cannot acknowledge an execution end",
  );
  delete thread.lastTurnEnd;
  thread.status = "active";
  assert.equal(
    unreadThreadIds([thread], store.getSnapshot()).size,
    0,
    "streaming is not a canonical message",
  );
});
test("canonical intermediate messages and legacy summaries are not execution-end evidence", () => {
  const store = createConversationReadStore(storage(), 100);
  const intermediate = summary("pre-tool-commentary", 101);
  intermediate.lastAgentMessage = {
    id: "pre-tool-commentary",
    createdAt: new Date(101).toISOString(),
  };
  delete intermediate.lastTurnEnd;
  intermediate.status = "active";
  assert.equal(unreadThreadIds([intermediate], store.getSnapshot()).size, 0);
  intermediate.status = "idle";
  assert.equal(unreadThreadIds([intermediate], store.getSnapshot()).size, 0);
});

test("running suppresses an old unseen end without reading it; every newer end can notify", () => {
  const disk = storage();
  const store = createConversationReadStore(disk, 100);
  const thread = summary("ended-first", 101);
  assert.equal(unreadThreadIds([thread], store.getSnapshot()).size, 1);
  thread.status = "active";
  assert.equal(unreadThreadIds([thread], store.getSnapshot()).size, 0);
  assert.equal(store.getSnapshot().threads.thread, undefined);
  thread.status = "idle";
  assert.equal(unreadThreadIds([thread], store.getSnapshot()).size, 1);
  store.advance("threads", "thread", message("ended-first", 101, 101));
  assert.equal(unreadThreadIds([thread], store.getSnapshot()).size, 0);
  thread.lastTurnEnd = {
    id: "ended-next",
    turnId: "next",
    position: 102,
    createdAt: new Date(101).toISOString(),
  };
  assert.equal(
    unreadThreadIds([thread], store.getSnapshot()).size,
    1,
    "same-millisecond ends have distinct canonical IDs",
  );
  store.advance("threads", "thread", message("ended-next", 101, 102), [
    "ended-first",
    "ended-next",
  ]);
  const reloaded = createConversationReadStore(disk, 1000);
  assert.equal(unreadThreadIds([thread], reloaded.getSnapshot()).size, 0);
});

test("old Agent-message cursors migrate once without reviving history or changing Room reads", () => {
  const disk = storage();
  disk.setItem(
    CONVERSATION_READ_KEY,
    JSON.stringify({
      baseline: 10,
      threads: { thread: message("old-agent", 50) },
      rooms: { room: message("room-read", 30) },
    }),
  );
  const store = createConversationReadStore(disk, 100);
  assert.equal(store.getSnapshot().baseline, 10);
  assert.equal(store.getSnapshot().threadEndBaseline, 100);
  assert.deepEqual(store.getSnapshot().rooms, {
    room: message("room-read", 30),
  });
  assert.deepEqual(store.getSnapshot().threads, {});
  assert.equal(
    unreadThreadIds([summary("old-end", 50)], store.getSnapshot()).size,
    0,
  );
  assert.equal(
    unreadThreadIds([summary("ended-during-upgrade", 100)], store.getSnapshot())
      .size,
    1,
    "an end in the installation millisecond is not lost",
  );
  store.advance("threads", "thread", message("ended-during-upgrade", 100, 100));
  const restarted = createConversationReadStore(disk, 1000);
  assert.equal(restarted.getSnapshot().threadEndBaseline, 100);
  assert.equal(
    restarted.getSnapshot().threads.thread?.id,
    "ended-during-upgrade",
  );
  assert.equal(
    unreadThreadIds([summary("new-empty-end", 101)], restarted.getSnapshot())
      .size,
    1,
  );
  assert.equal(
    roomMessageReadProjection(
      [roomMessage("room-read", 30), roomMessage("room-new", 50)],
      restarted.getSnapshot().rooms.room,
      restarted.getSnapshot().baseline,
    ).unreadCount,
    1,
  );
});
function roomMessage(
  id: string,
  createdAt: number,
  kind = "agent",
): RoomMessage {
  return {
    id,
    createdAt,
    kind,
    roomId: "room",
    author: kind,
    text: id,
    originThreadId: null,
    originTurnId: null,
  };
}
test("Room counts canonical Agent messages, excluding own sends/system and respecting exact order, retention, initial baseline", () => {
  const messages = [
    roomMessage("old", 50),
    roomMessage("first", 101),
    roomMessage("own", 102, "human"),
    roomMessage("status", 103, "system"),
    roomMessage("second", 104),
    roomMessage("same-time", 104),
  ];
  assert.equal(
    roomMessageReadProjection(messages, undefined, 100).unreadCount,
    3,
  );
  assert.equal(
    roomMessageReadProjection(messages, message("second", 104), 100)
      .unreadCount,
    1,
    "IDs disambiguate equal timestamps",
  );
  assert.equal(
    roomMessageReadProjection(messages, message("same-time", 104), 100)
      .unreadCount,
    0,
  );
  assert.equal(
    roomMessageReadProjection(messages.slice(1), message("trimmed", 90), 100)
      .unreadCount,
    3,
  );
  assert.equal(
    roomMessageReadProjection(messages, undefined, undefined).unreadCount,
    undefined,
    "unknown stays unknown",
  );
  assert.equal(
    roomMessageReadProjection(messages, undefined, 1000).unreadCount,
    0,
  );
  assert.equal(
    roomMessageReadProjection(messages, undefined, 100).lastMessage?.id,
    "same-time",
  );
});
function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 200,
    width: 200,
    height: bottom - top,
    toJSON: () => ({}),
  };
}
test("read range needs an actual visible message tail and excludes the composer overlay", () => {
  assert.equal(messageTailIsVisible(rect(0, 500), rect(450, 550), true), false);
  assert.equal(
    messageTailIsVisible(rect(0, 500), rect(-300, -20), true),
    false,
  );
  assert.equal(
    messageTailIsVisible(rect(0, 500), rect(100, 400), false),
    false,
  );
  assert.equal(
    messageTailIsVisible(rect(0, 500), rect(100, 450), true, rect(400, 500)),
    false,
  );
  assert.equal(
    messageTailIsVisible(rect(0, 500), rect(100, 350), true, rect(400, 500)),
    true,
  );
  assert.equal(messageTailIsVisible(rect(0, 0), rect(0, 0), true), false);
});
test("selection, hover, hidden tabs and unfocused windows never mark read; visible focused reading does", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let focused = false;
  let hidden = false;
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: () => focused,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  let tail = 700;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.dataset.readMessageId ? rect(tail - 100, tail) : rect(0, 500);
  };
  const root = createRoot(document.getElementById("root")!);
  function Reader({
    canonical = true,
    id = "reply",
  }: {
    canonical?: boolean;
    id?: string;
  }) {
    const viewport = useRef<HTMLDivElement>(null);
    useReadVisibleMessage({
      scope: "threads",
      conversationId: "thread",
      message: canonical
        ? message(id, Date.now(), id === "reply" ? 0 : 1)
        : undefined,
      viewport,
    });
    return React.createElement(
      "div",
      { ref: viewport, id: "viewport" },
      React.createElement("article", { "data-read-message-id": id }, "Reply"),
    );
  }
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  const read = () => conversationReadStore().getSnapshot().threads.thread;
  try {
    await act(async () => root.render(React.createElement(Reader)));
    await flush();
    assert.equal(read(), undefined, "opening while unfocused does not read");
    document
      .getElementById("viewport")!
      .dispatchEvent(new dom.window.MouseEvent("mouseover"));
    document.dispatchEvent(new dom.window.Event("selectionchange"));
    await flush();
    assert.equal(read(), undefined);
    focused = true;
    hidden = true;
    tail = 400;
    window.dispatchEvent(new dom.window.Event("focus"));
    await flush();
    assert.equal(read(), undefined, "background tab stays unread");
    hidden = false;
    tail = 700;
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await flush();
    assert.equal(
      read(),
      undefined,
      "scrolling older history cannot acknowledge the latest reply",
    );
    tail = 400;
    document
      .getElementById("viewport")!
      .dispatchEvent(new dom.window.Event("scroll"));
    await flush();
    assert.equal(read()?.id, "reply");
    await act(async () =>
      root.render(
        React.createElement(Reader, { canonical: false, id: "final" }),
      ),
    );
    await flush();
    assert.equal(
      read()?.id,
      "reply",
      "visible streaming text is not an acknowledgment",
    );
    await act(async () =>
      root.render(
        React.createElement(Reader, { canonical: true, id: "final" }),
      ),
    );
    await flush();
    assert.equal(
      read()?.id,
      "final",
      "the canonical final reply advances only after rendering visibly",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("same-millisecond cursors require canonical order, reject stale snapshots, and advance after restart", () => {
  const disk = storage();
  const current = createConversationReadStore(disk, 0);
  current.advance("threads", "thread", message("newer", 100));
  current.advance("threads", "thread", message("older", 100), ["older"]);
  assert.equal(
    current.getSnapshot().threads.thread?.id,
    "newer",
    "an older viewport cannot regress equal-time read state",
  );
  const restarted = createConversationReadStore(disk, 0);
  restarted.advance("threads", "thread", message("latest", 100), [
    "older",
    "newer",
    "latest",
  ]);
  assert.equal(
    restarted.getSnapshot().threads.thread?.id,
    "latest",
    "real same-time later messages remain readable",
  );
  restarted.advance("threads", "thread", message("paged-later", 100), [
    "paged-later",
  ]);
  assert.equal(
    restarted.getSnapshot().threads.thread?.id,
    "latest",
    "truncated history without the prior ID cannot invent order",
  );
  restarted.advance("threads", "thread", message("paged-later", 100), [
    "latest",
    "paged-later",
  ]);
  assert.equal(
    restarted.getSnapshot().threads.thread?.id,
    "paged-later",
    "loading enough canonical history permits progress",
  );
  current.advance("threads", "thread", message("newer", 100), [
    "older",
    "newer",
  ]);
  assert.equal(
    createConversationReadStore(disk, 0).getSnapshot().threads.thread?.id,
    "paged-later",
    "old-window callbacks compare against the latest stored cursor",
  );
});

test("a retained Room boundary with an unknown same-time cursor reports unknown, not zero", () => {
  const messages = [roomMessage("kept-later", 100), roomMessage("next", 101)];
  assert.equal(
    roomMessageReadProjection(messages, message("trimmed-or-stale", 100), 0)
      .unreadCount,
    undefined,
  );
});

test("retired viewport observers cannot acknowledge from an older render", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(document, "hasFocus", {
    value: () => true,
    configurable: true,
  });
  const frames: Array<FrameRequestCallback> = [];
  window.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  window.cancelAnimationFrame = () => {}; // Deliberately deliver a callback already queued before cancellation.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.dataset.readMessageId ? rect(100, 200) : rect(0, 500);
  };
  function Reader({ id }: { id: string }) {
    const viewport = useRef<HTMLDivElement>(null);
    useReadVisibleMessage({
      scope: "threads",
      conversationId: "thread",
      message: message(id, 100),
      messageOrder: id === "older" ? ["older"] : ["older", "newer"],
      viewport,
    });
    return React.createElement(
      "div",
      { ref: viewport },
      ["older", "newer"].map((id) =>
        React.createElement(
          "article",
          { key: id, "data-read-message-id": id },
          id,
        ),
      ),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(React.createElement(Reader, { id: "older" })),
    );
    const retired = frames.at(-1)!;
    await act(async () =>
      root.render(React.createElement(Reader, { id: "newer" })),
    );
    const current = frames.at(-1)!;
    await act(async () => retired(0));
    assert.equal(
      conversationReadStore().getSnapshot().threads.thread,
      undefined,
      "retired callback must not mark old content",
    );
    await act(async () => current(0));
    assert.equal(
      conversationReadStore().getSnapshot().threads.thread?.id,
      "newer",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

function visibleReadFixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const state = {
    focused: true,
    hidden: false,
    tail: 300,
    occluderTop: 400,
    queries: 0,
    geometryReads: 0,
    duringGeometry: undefined as (() => void) | undefined,
  };
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: () => state.focused,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (state.hidden ? "hidden" : "visible"),
  });
  const query = dom.window.Element.prototype.querySelectorAll;
  dom.window.Element.prototype.querySelectorAll = function (
    this: Element,
    selector: string,
  ) {
    if (selector === "[data-read-message-id]") state.queries++;
    return query.call(this, selector);
  } as typeof query;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    state.geometryReads++;
    state.duringGeometry?.();
    return this.id === "occluder"
      ? rect(state.occluderTop, 500)
      : this.dataset.readMessageId
        ? rect(state.tail - 100, state.tail)
        : rect(0, 500);
  };
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  const observers = new Set<() => void>();
  const previousResizeObserver = globalThis.ResizeObserver;
  Object.assign(globalThis, {
    ResizeObserver: class {
      constructor(private readonly callback: () => void) {}
      observe() {
        observers.add(this.callback);
      }
      disconnect() {
        observers.delete(this.callback);
      }
    },
  });
  type ReaderProps = {
    scope?: "threads" | "rooms";
    owner?: string;
    id?: string;
    position?: number;
    present?: boolean;
    enabled?: boolean;
  };
  function Reader({
    scope = "threads",
    owner = "owner",
    id = "target",
    position = 39,
    present = true,
    enabled = true,
  }: ReaderProps) {
    const viewport = useRef<HTMLDivElement>(null);
    const occluder = useRef<HTMLDivElement>(null);
    useReadVisibleMessage({
      scope,
      conversationId: owner,
      message: message(id, 100, position),
      viewport,
      occluder,
      enabled,
    });
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        { ref: viewport, id: "viewport" },
        React.createElement(
          "div",
          null,
          Array.from({ length: 39 }, (_, i) =>
            React.createElement("article", {
              key: i,
              "data-read-message-id": `history-${i}`,
            }),
          ),
          present &&
            React.createElement("article", { "data-read-message-id": id }),
        ),
      ),
      React.createElement("div", { ref: occluder, id: "occluder" }),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  const store = conversationReadStore();
  return {
    dom,
    state,
    store,
    frames,
    async render(props: ReaderProps = {}) {
      await act(async () => root.render(React.createElement(Reader, props)));
    },
    async flush() {
      const pending = [...frames.values()];
      frames.clear();
      await act(async () => pending.forEach((callback) => callback(0)));
    },
    schedule(
      event: "scroll" | "resize" | "focus" | "visibilitychange" | "observer",
    ) {
      if (event === "observer") observers.forEach((callback) => callback());
      else {
        const target =
          event === "scroll"
            ? document.getElementById("viewport")!
            : event === "visibilitychange"
              ? document
              : window;
        target.dispatchEvent(new dom.window.Event(event));
      }
    },
    resetCounts() {
      state.queries = state.geometryReads = 0;
    },
    async close() {
      await act(async () => root.unmount());
      Object.assign(globalThis, { ResizeObserver: previousResizeObserver });
      dom.window.close();
    },
  };
}

test("read-visible same-ID cursor skips DOM scans and geometry on scroll, resize and focus", async () => {
  const fixture = visibleReadFixture();
  try {
    fixture.store.advance("threads", "owner", message("target", 50, 39));
    await fixture.render();
    await fixture.flush();
    assert.equal(
      fixture.state.queries,
      0,
      "already-read ID needs no DOM lookup",
    );
    assert.equal(fixture.state.geometryReads, 0);
    // A pending row can change the observed content size without changing the
    // last canonical end. Exercise the real hook's ResizeObserver/scroll paths.
    document
      .querySelector("#viewport > div")!
      .append(document.createElement("article"));
    for (const event of [
      "scroll",
      "observer",
      "resize",
      "focus",
      "visibilitychange",
    ] as const) {
      fixture.schedule(event);
      await fixture.flush();
    }
    assert.equal(fixture.state.queries, 0);
    assert.equal(fixture.state.geometryReads, 0);
    assert.equal(fixture.store.getSnapshot().threads.owner?.createdAt, 50);
  } finally {
    await fixture.close();
  }
});

test("read-visible foreground precheck avoids scans but retains final visibility and occluder guards", async () => {
  const fixture = visibleReadFixture();
  try {
    fixture.state.hidden = true;
    await fixture.render();
    await fixture.flush();
    assert.equal(
      fixture.state.queries,
      0,
      "hidden document needs no DOM lookup",
    );
    fixture.state.hidden = false;
    fixture.state.focused = false;
    fixture.schedule("visibilitychange");
    await fixture.flush();
    assert.equal(
      fixture.state.queries,
      0,
      "unfocused document needs no DOM lookup",
    );
    assert.equal(fixture.state.geometryReads, 0);
    fixture.state.focused = true;
    fixture.state.tail = 450;
    fixture.schedule("focus");
    await fixture.flush();
    assert.equal(fixture.state.queries, 1);
    assert.ok(fixture.state.geometryReads > 0);
    assert.equal(
      fixture.store.getSnapshot().threads.owner,
      undefined,
      "composer covers tail",
    );
    fixture.state.tail = 300;
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    fixture.schedule("observer");
    await fixture.flush();
    assert.equal(
      fixture.store.getSnapshot().threads.owner,
      undefined,
      "modal blocks reading",
    );
    dialog.remove();
    fixture.state.duringGeometry = () => {
      fixture.state.focused = false;
    };
    fixture.schedule("scroll");
    await fixture.flush();
    assert.equal(
      fixture.store.getSnapshot().threads.owner,
      undefined,
      "foreground is rechecked after geometry",
    );
    fixture.state.duringGeometry = undefined;
    fixture.state.focused = true;
    fixture.schedule("focus");
    await fixture.flush();
    assert.equal(fixture.store.getSnapshot().threads.owner?.id, "target");
  } finally {
    await fixture.close();
  }
});

test("read-visible rereads current watermarks after reload and never borrows another scope or owner", async () => {
  const fixture = visibleReadFixture();
  try {
    await fixture.render();
    await fixture.flush();
    assert.equal(fixture.state.queries, 1);
    assert.equal(fixture.store.getSnapshot().threads.owner?.id, "target");
    const reset = { ...fixture.store.getSnapshot(), threads: {} };
    window.localStorage.setItem(CONVERSATION_READ_KEY, JSON.stringify(reset));
    window.dispatchEvent(
      new fixture.dom.window.StorageEvent("storage", {
        key: CONVERSATION_READ_KEY,
      }),
    );
    assert.equal(fixture.store.getSnapshot().threads.owner, undefined);
    fixture.resetCounts();
    fixture.schedule("scroll");
    await fixture.flush();
    assert.equal(
      fixture.state.queries,
      1,
      "same ID is checked again after preference reset",
    );
    assert.equal(fixture.store.getSnapshot().threads.owner?.id, "target");
    fixture.resetCounts();
    await fixture.render({ owner: "other-owner" });
    await fixture.flush();
    assert.equal(fixture.state.queries, 1);
    assert.equal(
      fixture.store.getSnapshot().threads["other-owner"]?.id,
      "target",
    );
    fixture.resetCounts();
    await fixture.render({ scope: "rooms" });
    await fixture.flush();
    assert.equal(fixture.state.queries, 1);
    assert.equal(fixture.store.getSnapshot().rooms.owner?.id, "target");
    fixture.resetCounts();
    await fixture.render({ id: "different-ID-same-position" });
    await fixture.flush();
    assert.equal(
      fixture.state.queries,
      1,
      "fast path must not widen to position or timestamp",
    );
    assert.equal(
      fixture.store.getSnapshot().threads.owner?.id,
      "target",
      "existing watermark order still refuses equal-position progress",
    );
  } finally {
    await fixture.close();
  }
});

test("read-visible late DOM remains unread until visible and retired or disabled owners cannot acknowledge", async () => {
  const fixture = visibleReadFixture();
  try {
    await fixture.render({ present: false });
    await fixture.flush();
    assert.equal(fixture.state.queries, 1);
    assert.equal(fixture.state.geometryReads, 0);
    assert.equal(fixture.store.getSnapshot().threads.owner, undefined);
    await fixture.render();
    fixture.state.tail = 700;
    fixture.schedule("observer");
    await fixture.flush();
    assert.equal(
      fixture.store.getSnapshot().threads.owner,
      undefined,
      "late but offscreen is not read",
    );
    fixture.state.tail = 300;
    fixture.schedule("scroll");
    const retired = [...fixture.frames.values()];
    await fixture.render({ owner: "new-owner", enabled: false });
    fixture.resetCounts();
    await act(async () => retired.forEach((callback) => callback(0)));
    fixture.schedule("focus");
    fixture.schedule("observer");
    await fixture.flush();
    assert.equal(fixture.state.queries, 0);
    assert.equal(fixture.store.getSnapshot().threads.owner, undefined);
    assert.equal(fixture.store.getSnapshot().threads["new-owner"], undefined);
    await fixture.render({ owner: "new-owner" });
    await fixture.flush();
    assert.equal(
      fixture.store.getSnapshot().threads["new-owner"]?.id,
      "target",
    );
  } finally {
    await fixture.close();
  }
});
