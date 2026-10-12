import "./dom-primitives.js";
import assert from "node:assert/strict";
import React, { act } from "react";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";

async function setup(messages: any[], handlers: any = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const room: any = {
    id: "room",
    name: "Room",
    members: [{ name: "Worker", threadId: "worker" }],
    messages,
    createdAt: 0,
    operationEpoch: "epoch",
  };
  const calls: any[] = [];
  let refreshTick: Function | undefined;
  const oldInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: any) => {
    refreshTick = fn;
    return 1;
  }) as any;
  const sdk: any = {
    commands: {
      execute: async (id: string, input: any) => {
        calls.push({ id, input });
        if (handlers[id]) return handlers[id](input, room);
        if (id === "list") return { rooms: [structuredClone(room)] };
        if (id === "delivery")
          return {
            state: "saved",
            receipt: "delivered",
            messageId: input.messageId,
            mentions: [],
            readers: [{ threadId: "worker", name: "Worker", state: "read" }],
          };
        throw Error(id);
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
  return {
    dom,
    root,
    room,
    calls,
    tick: async () => act(async () => refreshTick!()),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      globalThis.setInterval = oldInterval;
    },
  };
}
const m = (id: string, kind = "human") => ({
  id,
  roomId: "room",
  author: "Worker",
  text: "Message " + id,
  kind,
  createdAt: 0,
  originThreadId: null,
  originTurnId: null,
});
test("successful Room receipts stay out of message footers after load and refresh", async () => {
  for (const state of ["saved", "unknown"]) {
    const s = await setup([m("m1")], {
      delivery: async () => ({
        state,
        receipt: "delivered",
        messageId: "m1",
        mentions: [],
        readers: [{ threadId: "worker", name: "Worker", state: "read" }],
      }),
    });
    try {
      assert.ok(s.calls.some((call) => call.id === "delivery"));
      assert.ok(
        !document.querySelector(".room-delivery"),
        "successful receipt must not create a footer",
      );
      assert.doesNotMatch(
        document.querySelector(".room-message")!.textContent!,
        /Delivered|Read|Message details/,
      );
      await s.tick();
      assert.ok(
        !document.querySelector(".room-delivery"),
        "successful receipt must not create a footer",
      );
      assert.equal(document.querySelector(".rooms-chat-status"), null);
    } finally {
      await s.close();
    }
  }
});

test("a newly posted message settles without receipt footer while failed prepare stays visible and retryable", async () => {
  let failPrepare = false;
  const s = await setup([], {
    "prepare-message": async (input: any) => {
      if (failPrepare) throw Error("Synthetic preparation failure");
      return { id: input.operationId };
    },
    "post-message": async (input: any, room: any) => {
      room.messages.push({ ...m("posted"), text: input.text });
      return { messageId: "posted" };
    },
    operation: async () => ({
      state: "saved",
      receipt: "delivered",
      messageId: "posted",
      mentions: [],
    }),
    "ack-operation": async () => ({}),
  });
  const send = async (text: string) => {
    await act(async () => {
      const editor =
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
      Object.getOwnPropertyDescriptor(
        s.dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor, text);
      editor.dispatchEvent(new s.dom.window.Event("input", { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".rooms-chat-compose .action-orb")!
        .click(),
    );
  };
  try {
    await send("Newly posted message");
    assert.match(
      document.querySelector('[data-room-message-id="posted"]')!.textContent!,
      /Newly posted message/,
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
      "",
    );
    assert.ok(
      !document.querySelector(".room-delivery"),
      "successful receipt must not create a footer",
    );
    assert.equal(document.querySelector(".rooms-chat-status"), null);
    await s.tick();
    assert.ok(
      !document.querySelector(".room-delivery"),
      "successful receipt must not create a footer",
    );
    failPrepare = true;
    await send("Preserve this failed draft");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /preparation failed.*Synthetic preparation failure/,
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
      "Preserve this failed draft",
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        ".rooms-chat-compose .action-orb",
      )!.disabled,
      false,
    );
    assert.equal(
      s.calls.filter((call) => call.id === "post-message").length,
      1,
    );
  } finally {
    await s.close();
  }
});

test("Room social review regressions: receipts, refreshed reactions, and failed quote prepare", async () => {
  {
    const messages = Array.from({ length: 8 }, (_, i) => m("m" + i, "agent"));
    const s = await setup(messages, {
      list: async (_: any, r: any) => ({
        rooms: [
          {
            ...structuredClone(r),
            messages: structuredClone(r.messages.slice(-1)),
            messageCount: 8,
            pendingCount: 0,
            operations: [],
          },
        ],
      }),
      messages: async (input: any, r: any) => {
        const end = Math.max(0, 8 - (input.cursor ?? 0));
        const start = Math.max(0, end - 4);
        return {
          messages: structuredClone(r.messages.slice(start, end)),
          nextCursor: start > 0 ? (input.cursor ?? 0) + (end - start) : null,
        };
      },
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".room-load-earlier")!.click(),
    );
    assert.equal(document.querySelectorAll(".room-message").length, 8);
    s.room.messages[0].reactions = [
      { actorId: "thread:worker", label: "Worker", emoji: "👀" },
    ];
    await s.tick();
    assert(
      [...document.querySelectorAll(".room-message [aria-label]")].some(
        (element) =>
          element.getAttribute("aria-label")?.includes("👀 · 1 · Worker"),
      ),
    );
    await s.close();
  }
  {
    const s = await setup([m("source", "agent")], {
      "prepare-message": async () => {
        throw Error("Reply target is not retained in this Room");
      },
      operation: async () => ({
        state: "unknown",
        messageId: null,
        mentions: [],
      }),
    });
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.getAttribute("aria-label") === "Reply")!
        .click(),
    );
    await act(async () => {
      const t =
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
      Object.getOwnPropertyDescriptor(
        s.dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(t, "My reply");
      t.dispatchEvent(new s.dom.window.Event("input", { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".rooms-chat-compose .action-orb")!
        .click(),
    );
    const cancel = document.querySelector<HTMLButtonElement>(
      '[aria-label="Cancel reply"]',
    )!;
    assert.equal(cancel.disabled, false);
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        ".rooms-chat-compose .action-orb",
      )!.disabled,
      false,
    );
    const cancelPending = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel unsent message",
    );
    if (cancelPending) await act(async () => cancelPending.click());
    assert.equal(document.querySelector(".room-send-pending"), null);
    await s.close();
  }
});
