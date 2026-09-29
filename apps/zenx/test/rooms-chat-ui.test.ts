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
  const sdk = {
    commands: {
      execute: async (id: string, input?: { roomId: string; text: string }) => {
        if (id === "list") return { rooms: structuredClone(rooms) };
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
            throw new Error("wake failed");
          }
          await new Promise<void>((resolve) => {
            resolvePost = resolve;
          });
          return { posted: true };
        }
        throw new Error(`Unexpected command ${id}`);
      },
    },
  } as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  const click = async (label: string) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === label,
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
    await click("@Bot");
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")?.value,
      "草稿@Bot ",
    );
    let send: Promise<void> | undefined;
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .primary-button",
        )!
        .click();
      // React event starts async command without completing it.
      send = Promise.resolve();
    });
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.roomId, "one");
    assert.equal(posts[0]?.text, "草稿@Bot ");
    assert.ok(
      document.querySelector<HTMLButtonElement>(
        ".rooms-chat-compose .primary-button",
      )?.disabled,
    );
    await act(async () => {
      resolvePost?.();
      await send;
    });
    rejectAfterSave = true;
    await fill("@Bot 中文长消息");
    await click("Send");
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
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Message saved/u,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
