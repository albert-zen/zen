import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("Room A unknown does not block B; same text from another sender cannot confirm A; reload shows durable operation", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const rooms = [
    {
      id: "A",
      name: "Alpha",
      members: [{ name: "Bot", threadId: "bot" }],
      messages: [] as any[],
      createdAt: 1,
      operations: [] as any[],
    },
    {
      id: "B",
      name: "Beta",
      members: [],
      messages: [] as any[],
      createdAt: 2,
      operations: [] as any[],
    },
  ];
  const calls: string[] = [];
  const sdk = {
    commands: {
      execute: async (id: string, input?: any) => {
        if (id === "list") return { rooms: structuredClone(rooms) };
        if (id === "prepare-message") {
          const r = rooms.find((r) => r.id === input.roomId)!;
          r.operations.push({
            id: input.operationId,
            text: input.text,
            messageId: null,
            createdAt: Date.now(),
          });
          return { id: input.operationId };
        }
        if (id === "post-message") {
          calls.push(input.roomId);
          if (input.roomId === "A") {
            rooms[0]!.messages.push({
              id: "other-sender",
              text: input.text,
              kind: "human",
              author: "You",
              createdAt: Date.now(),
            });
            throw Error("response lost");
          }
          const op = rooms[1]!.operations.find(
            (x) => x.id === input.operationId,
          );
          op.messageId = "b-message";
          return { messageId: "b-message" };
        }
        if (id === "operation") {
          const r = rooms.find((r) => r.id === input.roomId)!;
          const op = r.operations.find((x) => x.id === input.operationId)!;
          return {
            state: op.messageId ? "saved" : "prepared",
            messageId: op.messageId,
            mentions: [],
          };
        }
        if (id === "ack-operation") {
          const r = rooms.find((r) => r.id === input.roomId)!;
          r.operations = r.operations.filter((x) => x.id !== input.operationId);
          return { acknowledged: true };
        }
        if (id === "delivery")
          return { state: "unknown", messageId: input.messageId, mentions: [] };
        throw Error(`unexpected ${id}`);
      },
    },
    navigation: { navigate: () => {} },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  const click = async (label: string) =>
    act(async () => {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((b) => b.textContent?.includes(label));
      assert(button);
      button.click();
    });
  const fill = async (text: string) =>
    act(async () => {
      const el =
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(el, text);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    await fill("@Bot 同文");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .primary-button",
        )!
        .click(),
    );
    await act(async () => new Promise((r) => setTimeout(r, 25)));
    assert.deepEqual(calls, ["A"]);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
      "@Bot 同文",
    );
    assert.match(
      document.querySelector(".room-send-pending")!.textContent!,
      /awaiting confirmation/u,
    );
    assert.doesNotMatch(
      document.querySelector(".rooms-chat-status")!.textContent!,
      /Message saved/u,
    );
    await click("#Beta");
    await fill("另一房间可以发送");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .primary-button",
        )!
        .click(),
    );
    await act(async () => new Promise((r) => setTimeout(r, 25)));
    assert.deepEqual(calls, ["A", "B"]);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
      "",
    );
    assert.doesNotMatch(
      document.querySelector(".rooms-chat-status")?.textContent ?? "",
      /response lost/u,
    );
    await act(async () => root.unmount());
    const reopened = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        reopened.render(React.createElement(RoomsPage, { sdk })),
      );
      assert.match(
        document.querySelector(".room-send-pending")!.textContent!,
        /awaiting confirmation/u,
      );
      assert.equal(
        document.querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .primary-button",
        )?.disabled,
        true,
      );
      await click("#Beta");
      assert.equal(
        document.querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .primary-button",
        )?.disabled,
        true,
      ); // empty draft, not blocked by A
      await fill("B 新消息");
      assert.equal(
        document.querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .primary-button",
        )?.disabled,
        false,
      );
    } finally {
      await act(async () => reopened.unmount());
    }
  } finally {
    dom.window.close();
  }
});

test("new identical draft is never cleared by a late response to the previous operation", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const room = {
    id: "A",
    name: "Alpha",
    members: [{ name: "Bot", threadId: "bot" }],
    messages: [] as any[],
    createdAt: 1,
    operations: [] as any[],
  };
  let resolvePost: ((result: unknown) => void) | undefined;
  const sdk = {
    commands: {
      execute: async (id: string, input?: any) => {
        if (id === "list") return { rooms: [structuredClone(room)] };
        if (id === "prepare-message") {
          room.operations.push({
            id: input.operationId,
            text: input.text,
            messageId: null,
            createdAt: 1,
          });
          return { id: input.operationId };
        }
        if (id === "post-message")
          return await new Promise((resolve) => {
            resolvePost = (result) => {
              room.operations[0]!.messageId = "saved";
              resolve(result);
            };
          });
        if (id === "operation")
          return {
            state: room.operations[0]!.messageId ? "saved" : "prepared",
            messageId: room.operations[0]!.messageId,
            mentions: [],
          };
        if (id === "ack-operation") {
          room.operations = [];
          return { acknowledged: true };
        }
        if (id === "delivery")
          return { state: "saved", messageId: input.messageId, mentions: [] };
        throw Error(id);
      },
    },
    navigation: { navigate: () => {} },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  const fill = async (text: string) =>
    act(async () => {
      const el =
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(el, text);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    await fill("@Bot 相同正文");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .primary-button",
        )!
        .click(),
    );
    for (let i = 0; i < 30 && !resolvePost; i++)
      await act(async () => new Promise((r) => setTimeout(r, 5)));
    assert(resolvePost);
    await fill("新草稿");
    await fill("@Bot 相同正文"); // same bytes, different user edit revision
    await act(async () => resolvePost?.({ messageId: "saved" }));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
      "@Bot 相同正文",
    );
    assert.match(
      document.querySelector(".rooms-chat-status")!.textContent!,
      /Message saved/u,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("a stale Room list response cannot overwrite a newer page generation", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  let oldResolve: ((value: unknown) => void) | undefined;
  const oldSdk = {
    commands: {
      execute: async (id: string) =>
        id === "list"
          ? await new Promise((resolve) => {
              oldResolve = resolve;
            })
          : null,
    },
  } as unknown as PluginUiSdkV1;
  const recent = {
    rooms: [
      { id: "new", name: "Current", members: [], messages: [], createdAt: 1 },
    ],
  };
  const newSdk = {
    commands: {
      execute: async (id: string) => (id === "list" ? recent : null),
    },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: oldSdk })),
    );
    assert(oldResolve);
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: newSdk })),
    );
    assert.equal(
      document.querySelector(".rooms-chat-header h2")?.textContent,
      "#Current",
    );
    await act(async () =>
      oldResolve?.({
        rooms: [
          {
            id: "stale",
            name: "Stale",
            members: [],
            messages: [],
            createdAt: 1,
          },
        ],
      }),
    );
    assert.equal(
      document.querySelector(".rooms-chat-header h2")?.textContent,
      "#Current",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
