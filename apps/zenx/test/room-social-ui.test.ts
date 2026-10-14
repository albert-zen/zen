import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";

test("Room reply selection binds exact target, sends text separately, and reaction uses exact message", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const message: any = {
    id: "source",
    roomId: "room",
    author: "Worker",
    text: "Quoted message",
    kind: "agent",
    createdAt: 0,
    originThreadId: null,
    originTurnId: null,
  };
  const room: any = {
    id: "room",
    name: "Room",
    members: [{ name: "Worker", threadId: "worker" }],
    messages: [message],
    createdAt: 0,
    operationEpoch: "epoch",
  };
  const calls: Array<{ id: string; input: any }> = [];
  const sdk: any = {
    commands: {
      execute: async (id: string, input: any) => {
        calls.push({ id, input });
        if (id === "list") return { rooms: [structuredClone(room)] };
        if (id === "react") {
          message.reactions = input.emoji
            ? [{ actorId: "user", label: "You", emoji: input.emoji }]
            : [];
          return { updated: true, message: structuredClone(message) };
        }
        if (id === "prepare-message") return { id: input.operationId };
        if (id === "post-message") return { messageId: "posted" };
        if (id === "operation")
          return { state: "saved", messageId: "posted", mentions: [] };
        if (id === "ack-operation") return {};
        throw Error(id);
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => b.getAttribute("aria-label") === "Reply")!
        .click();
    });
    assert.match(
      document.querySelector(".room-reply-draft")!.textContent!,
      /Replying to Worker: Quoted message/,
    );
    await act(async () => {
      const editor =
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor, "My reply");
      editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".rooms-chat-compose .action-orb")!
        .click(),
    );
    const prepared = calls.find((c) => c.id === "prepare-message")!;
    assert.equal(prepared.input.replyToMessageId, "source");
    assert.equal(prepared.input.text, "My reply");
    assert.equal(document.querySelector(".room-reply-draft"), null);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '.room-message-action-toolbar [aria-label="React"]',
        )!
        .click(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "React 👍")!
        .click(),
    );
    assert.deepEqual(calls.find((c) => c.id === "react")!.input, {
      roomId: "room",
      messageId: "source",
      emoji: "👍",
    });
    assert.equal(
      document
        .querySelector(".room-message-reaction-chip")!
        .getAttribute("aria-pressed"),
      "true",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".room-message-reaction-chip")!
        .click(),
    );
    assert.equal(
      calls.filter((c) => c.id === "react").at(-1)!.input.emoji,
      null,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
