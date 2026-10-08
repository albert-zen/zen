import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("trusted Room composer switches rooms, sends once, and treats post error as unknown until reconciled", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const rooms = [
    {
      id: "one",
      name: "团队",
      members: [{ name: "Bot", threadId: "bot" }],
      messages: [] as Array<{
        id: string;
        roomId: string;
        author: string;
        text: string;
        kind: "human";
        createdAt: number;
        originThreadId: null;
        originTurnId: null;
      }>,
      createdAt: 0,
    },
    { id: "two", name: "Second", members: [], messages: [], createdAt: 0 },
  ];
  const posts: Array<{ roomId: string; text: string }> = [];
  let rejectAfterSave = false;
  let resolvePost: (() => void) | undefined;
  const operations = new Map<
    string,
    { text: string; messageId: string | null }
  >();
  const sdk = {
    commands: {
      execute: async (
        id: string,
        input?: { roomId: string; text: string; operationId: string },
      ) => {
        if (id === "list") return { rooms: structuredClone(rooms) };
        if (id === "prepare-message" && input) {
          operations.set(input.operationId, {
            text: input.text,
            messageId: null,
          });
          return { id: input.operationId };
        }
        if (id === "operation" && input) {
          const operation = operations.get(input.operationId);
          return {
            state: operation?.messageId ? "saved" : "prepared",
            messageId: operation?.messageId,
            mentions: [],
          };
        }
        if (id === "ack-operation") return { acknowledged: true };
        if (id === "delivery")
          return { state: "unknown", messageId: null, mentions: [] };
        if (id === "post-message" && input) {
          posts.push(input);
          if (rejectAfterSave) {
            rooms[0]!.messages.push({
              id: "saved",
              roomId: input.roomId,
              author: "You",
              text: input.text,
              kind: "human",
              createdAt: Date.now(),
              originThreadId: null,
              originTurnId: null,
            });
            operations.get(input.operationId)!.messageId = "saved";
            throw new Error("wake failed");
          }
          await new Promise<void>((resolve) => {
            resolvePost = resolve;
          });
          operations.get(input.operationId)!.messageId = "success";
          return { posted: true, messageId: "success" };
        }
        throw new Error(`Unexpected command ${id}`);
      },
    },
  } as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  const click = async (label: string) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) =>
          entry.getAttribute("aria-label") === label ||
          entry.textContent?.trim() === label ||
          (entry.getAttribute("role") === "option" &&
            entry.querySelector("strong")?.textContent === label),
      );
      assert.ok(button, `Missing button ${label}`);
      button.click();
    });
  const fill = async (value: string) =>
    act(async () => {
      const input =
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    assert.ok(document.querySelector('[aria-label="团队 messages"]'));
    await fill("草稿");
    await click("#SecondNo messages yet");
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")?.value,
      "",
    );
    await click("#团队No messages yet");
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")?.value,
      "草稿",
    );
    await click("Mention a room member");
    await click("@Bot");
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")?.value,
      "草稿 @Bot ",
    );
    let send: Promise<void> | undefined;
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(".rooms-chat-compose .action-orb")!
        .click();
      // React event starts async command without completing it.
      send = Promise.resolve();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.roomId, "one");
    assert.equal(posts[0]?.text, "草稿 @Bot ");
    assert.ok(
      document.querySelector<HTMLButtonElement>(
        ".rooms-chat-compose .action-orb",
      )?.disabled,
    );
    await act(async () => {
      resolvePost?.();
      await send;
    });
    rejectAfterSave = true;
    await fill("@Bot 中文长消息");
    await click("Send");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(posts.length, 2);
    assert.equal(rooms[0]!.messages[0]?.author, "You");
    assert.match(
      document.querySelector(".rooms-chat-feed")!.textContent!,
      /中文长消息/u,
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")?.value,
      "",
    );
    assert.equal(
      document.querySelector('.rooms-chat-status [role="status"]'),
      null,
      "confirmed technical receipt leaves the chat rail",
    );
    assert.equal(document.querySelector(".room-message-details"), null);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".room-message-action-more")!
        .click(),
    );
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".room-message-action-popover button",
        ),
      ]
        .find((button) => button.textContent?.includes("Technical details"))!
        .click(),
    );
    assert.match(
      document.querySelector(".room-message-technical-fields")!.textContent!,
      /Message ID:saved/u,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
