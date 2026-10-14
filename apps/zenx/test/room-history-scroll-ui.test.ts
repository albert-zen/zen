import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type { ZenXRoom } from "../src/main/trigger-types.js";
import type { RoomHistoryPage } from "../src/renderer/src/room-history.js";

const message = (
  id: number,
  roomId = "first",
): ZenXRoom["messages"][number] => ({
  id: `${roomId}-${id}`,
  roomId,
  kind: "agent",
  author: "Bot",
  text: `Message ${id}`,
  createdAt: 1000 + id,
  originThreadId: null,
  originTurnId: null,
});

async function setup(count = 40, viewportHeight = 300) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const rooms = [
    {
      id: "first",
      name: "First",
      messages: Array.from({ length: count }, (_, i) => message(i)),
    },
    {
      id: "second",
      name: "Second",
      messages: Array.from({ length: 8 }, (_, i) => message(i, "second")),
    },
  ];
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get() {
        return this.classList.contains("rooms-chat-feed") ? viewportHeight : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return this.classList.contains("rooms-chat-feed")
          ? this.querySelectorAll(".room-message").length * 100 + 40
          : 0;
      },
    },
    scrollTop: {
      configurable: true,
      get() {
        return positions.get(this) ?? 0;
      },
      set(value: number) {
        positions.set(
          this,
          Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)),
        );
      },
    },
  });
  const rect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("rooms-chat-feed"))
      return {
        top: 100,
        bottom: 100 + viewportHeight,
        height: viewportHeight,
      } as DOMRect;
    if (this.hasAttribute("data-room-message-id")) {
      const feed = this.closest<HTMLElement>(".rooms-chat-feed")!;
      const index = Array.from(feed.querySelectorAll(".room-message")).indexOf(
        this,
      );
      const top = 100 + 40 + index * 100 - feed.scrollTop;
      return { top, bottom: top + 100, height: 100 } as DOMRect;
    }
    return rect.call(this);
  };
  const calls: { roomId: string; cursor: number }[] = [];
  let intercept:
    | ((
        roomId: string,
        cursor: number,
        page: RoomHistoryPage,
      ) => Promise<RoomHistoryPage>)
    | undefined;
  let tick: () => void = () => {};
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void) => {
    tick = fn;
    return 1;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  const sdk = {
    context: { route: "/plugins/zenx-rooms/rooms?roomId=first" },
    navigation: { navigate: () => {} },
    commands: {
      execute: async (
        id: string,
        input?: { roomId?: string; cursor?: number },
      ) => {
        if (id === "list")
          return {
            rooms: rooms.map((room) => ({
              ...room,
              members: [],
              createdAt: 0,
              messageCount: room.messages.length,
              messages: room.messages.slice(-1),
              operations: [],
              pendingCount: 0,
            })),
          };
        if (id === "messages") {
          const roomId = input!.roomId!;
          const cursor = input?.cursor ?? 0;
          calls.push({ roomId, cursor });
          const all = rooms.find((room) => room.id === roomId)!.messages;
          const end = Math.max(0, all.length - cursor);
          const start = Math.max(0, end - 4);
          const page = {
            messages: structuredClone(all.slice(start, end)),
            nextCursor: start > 0 ? cursor + end - start : null,
          };
          return intercept ? intercept(roomId, cursor, page) : page;
        }
        throw Error(id);
      },
    },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
  calls.length = 0;
  return {
    rooms,
    calls,
    dom,
    feed: () => document.querySelector<HTMLElement>(".rooms-chat-feed")!,
    ids: () =>
      Array.from(document.querySelectorAll<HTMLElement>(".room-message")).map(
        (element) => element.dataset.roomMessageId,
      ),
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
    tick: async () => act(async () => tick()),
    scroll: async (top: number) =>
      act(async () => {
        const feed = document.querySelector<HTMLElement>(".rooms-chat-feed")!;
        feed.scrollTop = top;
        feed.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      }),
    wheel: async () =>
      act(async () =>
        document
          .querySelector<HTMLElement>(".rooms-chat-feed")!
          .dispatchEvent(
            new dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
          ),
      ),
    switch: async (name: string) =>
      act(async () =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            ".rooms-chat-list > button",
          ),
        )
          .find((button) => button.textContent?.includes(`#${name}`))!
          .click(),
      ),
    close: async () => {
      await act(async () => root.unmount());
      globalThis.setInterval = originalInterval;
      globalThis.clearInterval = originalClear;
      dom.window.close();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("upward history loads once per gesture, preserves visible message and stops at retained edge", async () => {
  const s = await setup();
  try {
    assert.equal(s.ids().length, 4);
    assert.equal(
      s.calls.length,
      0,
      "initial layout does not auto-fill the viewport",
    );
    const gate = deferred();
    s.intercept(async (_room, cursor, page) => {
      if (cursor === 0) await gate.promise;
      return page;
    });
    const anchor = document.querySelector<HTMLElement>(
      '[data-room-message-id="first-36"]',
    )!;
    await s.scroll(80);
    const offset = anchor.getBoundingClientRect().top;
    await s.scroll(60);
    await s.scroll(40);
    assert.equal(
      s.calls.length,
      1,
      "same in-flight load cannot be entered twice",
    );
    const movedOffset = anchor.getBoundingClientRect().top;
    await act(async () => gate.resolve());
    assert.equal(s.ids().length, 20);
    assert.equal(
      anchor.getBoundingClientRect().top,
      movedOffset,
      "anchor follows user scrolling during the request",
    );
    assert.notEqual(offset, movedOffset);
    const requests = s.calls.length;
    await s.scroll(s.feed().scrollTop);
    assert.equal(
      s.calls.length,
      requests,
      "restored scroll event cannot auto-load another batch",
    );
    await s.scroll(60);
    assert.equal(s.ids().length, 36);
    await s.scroll(40);
    assert.equal(s.ids().length, 40);
    assert.equal(document.querySelector(".room-load-earlier"), null);
    assert.match(
      document.querySelector(".room-history-edge")!.textContent!,
      /retained/i,
    );
    const endRequests = s.calls.length;
    await s.scroll(0);
    await s.wheel();
    assert.equal(s.calls.length, endRequests);
  } finally {
    await s.close();
  }
});

test("short viewport content waits for upward wheel or keyboard intent, without an auto-fill loop", async () => {
  const s = await setup(40, 5000);
  try {
    assert.equal(s.ids().length, 4);
    assert.equal(s.calls.length, 0);
    await s.wheel();
    assert.equal(s.ids().length, 20);
    const requests = s.calls.length;
    await s.scroll(0);
    assert.equal(s.calls.length, requests);
    await act(async () =>
      s.feed().dispatchEvent(
        new s.dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "PageUp",
        }),
      ),
    );
    assert.equal(s.ids().length, 36);
  } finally {
    await s.close();
  }
});

test("late history responses cannot change another Room or a reopened Room", async () => {
  const s = await setup();
  try {
    const gate = deferred();
    let held = false;
    s.intercept(async (room, _cursor, page) => {
      if (room === "first" && !held) {
        held = true;
        await gate.promise;
      }
      return page;
    });
    await s.scroll(60);
    await s.switch("Second");
    assert(s.ids().every((id) => id?.startsWith("second-")));
    await s.switch("First");
    assert.equal(s.ids().length, 4);
    const top = s.feed().scrollTop;
    await act(async () => gate.resolve());
    assert.equal(s.ids().length, 4);
    assert.equal(s.feed().scrollTop, top);
    assert.equal(
      document.querySelector<HTMLButtonElement>(".room-load-earlier")!.disabled,
      false,
    );
    await s.scroll(60);
    assert.equal(s.ids().length, 20);
  } finally {
    await s.close();
  }
});

test("history failure has an explicit retry and scroll cannot cause an error retry loop", async () => {
  const s = await setup();
  try {
    s.intercept(async () => {
      throw Error("History offline");
    });
    await s.scroll(60);
    assert.equal(s.ids().length, 4);
    assert.match(
      document.querySelector(".room-history-error")!.textContent!,
      /History offline/,
    );
    const failedRequests = s.calls.length;
    await s.scroll(0);
    await s.wheel();
    assert.equal(s.calls.length, failedRequests);
    s.intercept(undefined);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".room-load-earlier")!.click(),
    );
    assert.equal(s.ids().length, 20);
    assert.equal(document.querySelector(".room-history-error"), null);
  } finally {
    await s.close();
  }
});

for (const count of [40, 256])
  test(`poll and concurrent arrivals preserve the history anchor at count ${count}`, async () => {
    const s = await setup(count);
    try {
      const gate = deferred();
      let held = false;
      s.intercept(async (_room, _cursor, page) => {
        if (!held) {
          held = true;
          await gate.promise;
        }
        return page;
      });
      await s.scroll(60);
      const anchor = document.querySelector<HTMLElement>(
        `[data-room-message-id="first-${count - 4}"]`,
      )!;
      const top = anchor.getBoundingClientRect().top;
      s.rooms[0]!.messages = [
        ...s.rooms[0]!.messages,
        message(count),
        message(count + 1),
      ].slice(-256);
      await s.tick();
      assert.equal(s.calls.length, 1, "poll waits behind history expansion");
      await act(async () => gate.resolve());
      assert.deepEqual(
        s.ids(),
        Array.from({ length: 24 }, (_, i) => `first-${count - 22 + i}`),
      );
      assert.equal(
        anchor.getBoundingClientRect().top,
        top,
        "new bottom content must not add to the prepend offset",
      );
      await s.tick();
      assert.equal(anchor.getBoundingClientRect().top, top);
      assert.equal(s.ids().length, 24);
    } finally {
      await s.close();
    }
  });

test("a poll already in flight cannot shrink newly expanded history", async () => {
  const s = await setup();
  try {
    const gate = deferred();
    let held = false;
    s.intercept(async (_room, _cursor, page) => {
      if (!held) {
        held = true;
        await gate.promise;
      }
      return page;
    });
    await s.tick();
    assert.equal(s.calls.length, 1);
    await s.scroll(60);
    assert.equal(s.ids().length, 20);
    const top = s.feed().scrollTop;
    await act(async () => gate.resolve());
    assert.equal(s.ids().length, 20);
    assert.equal(s.feed().scrollTop, top);
  } finally {
    await s.close();
  }
});

test("a history error arriving after Room navigation is discarded", async () => {
  const s = await setup();
  try {
    const gate = deferred();
    let held = false;
    s.intercept(async (_room, _cursor, page) => {
      if (!held) {
        held = true;
        await gate.promise;
        throw Error("Old Room unavailable");
      }
      return page;
    });
    await s.scroll(60);
    await s.switch("Second");
    const top = s.feed().scrollTop;
    await act(async () => gate.resolve());
    assert(s.ids().every((id) => id?.startsWith("second-")));
    assert.equal(s.feed().scrollTop, top);
    assert.equal(document.querySelector(".room-history-error"), null);
    await s.switch("First");
    assert.equal(document.querySelector(".room-history-error"), null);
  } finally {
    await s.close();
  }
});
