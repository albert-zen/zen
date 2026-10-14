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
const message = (id: string, createdAt: number) => ({ id, createdAt });
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
    lastAgentMessage: { id, createdAt: new Date(createdAt).toISOString() },
  };
}
test("first install establishes an old-history baseline; canonical new replies survive restart", () => {
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
  restarted.advance("threads", "thread", message("new", 150));
  assert.equal(
    unreadThreadIds([summary("new", 150)], restarted.getSnapshot()).size,
    0,
  );
  restarted.advance("threads", "thread", message("old", 50));
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
test("updatedAt, user sends, missing legacy projections and streaming state do not invent Agent unread", () => {
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
    "a user send cannot clear an unread reply",
  );
  delete thread.lastAgentMessage;
  thread.status = "active";
  assert.equal(
    unreadThreadIds([thread], store.getSnapshot()).size,
    0,
    "streaming is not a canonical message",
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
      message: canonical ? message(id, Date.now()) : undefined,
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
