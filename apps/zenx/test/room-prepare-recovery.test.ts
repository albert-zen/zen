import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";

async function scenario(
  losePrepareReply: boolean,
  cancel: boolean,
  newer = false,
  loseFirstRefresh = false,
  loseCancelReply = false,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const oldInterval = globalThis.setInterval;
  let refreshTick: (() => Promise<void>) | undefined;
  globalThis.setInterval = ((fn: () => Promise<void>) => {
    refreshTick = fn;
    return 1;
  }) as any;
  let refreshFailed = false;
  let operation: any = null;
  const posts: any[] = [];
  const source = {
    id: "source",
    roomId: "room",
    author: "Worker",
    text: "Quoted original",
    kind: "agent",
    createdAt: 0,
    originThreadId: null,
    originTurnId: null,
  };
  const messages: any[] = [source];
  const room = {
    id: "room",
    name: "Room",
    members: [{ name: "Worker", threadId: "worker" }],
    messages,
    createdAt: 0,
    operationEpoch: "epoch",
  };
  const sdk: any = {
    commands: {
      execute: async (id: string, input: any) => {
        if (id === "list") {
          if (operation && loseFirstRefresh && !refreshFailed) {
            refreshFailed = true;
            throw Error("refresh temporarily unavailable");
          }
          return {
            rooms: [
              {
                ...structuredClone(room),
                pendingCount: operation && !operation.acknowledged ? 1 : 0,
                operations: [],
              },
            ],
          };
        }
        if (id === "operations")
          return {
            operations:
              operation && !operation.acknowledged
                ? [
                    {
                      id: operation.id,
                      text: operation.text,
                      messageId: operation.messageId,
                      createdAt: 0,
                    },
                  ]
                : [],
            nextCursor: null,
          };
        if (id === "prepare-message") {
          operation = {
            id: input.operationId,
            text: input.text,
            messageId: null,
            acknowledged: false,
            replyToMessageId: input.replyToMessageId,
          };
          if (losePrepareReply) throw Error("prepare reply lost");
          return structuredClone(operation);
        }
        if (id === "post-message") {
          // For cancel scenario emulate a post call rejected before committing.
          if (cancel) throw Error("post failed before commit");
          posts.push(structuredClone(input));
          operation.messageId = "posted";
          messages.push({
            ...source,
            id: "posted",
            author: "You",
            kind: "human",
            text: input.text,
            replyTo: {
              messageId: source.id,
              author: source.author,
              text: source.text,
            },
          });
          return { messageId: "posted" };
        }
        if (id === "operation")
          return operation
            ? {
                state: operation.cancelled
                  ? "cancelled"
                  : operation.messageId
                    ? "saved"
                    : "prepared",
                messageId: operation.messageId,
                text: operation.text,
                mentions: [],
              }
            : { state: "unknown", messageId: null, mentions: [] };
        if (id === "ack-operation") {
          operation.acknowledged = true;
          return {};
        }
        if (id === "cancel-prepared") {
          operation.cancelled = true;
          operation.acknowledged = true;
          if (loseCancelReply) throw Error("cancel reply lost");
          return {};
        }
        if (id === "delivery")
          return {
            state: "saved",
            receipt: "delivered",
            messageId: input.messageId,
            mentions: [],
            readers: [],
          };
        throw Error(id);
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Reply")!
        .click(),
    );
    await act(async () => {
      const editor =
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor, "My quoted reply");
      editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".rooms-chat-compose .action-orb")!
        .click(),
    );
    if (loseFirstRefresh)
      await act(async () => {
        await refreshTick!();
      });
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
      "My quoted reply",
    );
    assert(document.querySelector(".room-reply-draft"));
    assert(document.querySelector(".room-send-pending"));
    if (newer)
      for (const value of ["temporary newer edit", "My quoted reply"])
        await act(async () => {
          const editor =
            document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
          Object.getOwnPropertyDescriptor(
            dom.window.HTMLTextAreaElement.prototype,
            "value",
          )!.set!.call(editor, value);
          editor.dispatchEvent(
            new dom.window.Event("input", { bubbles: true }),
          );
        });
    if (cancel) {
      await act(async () =>
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent === "Cancel unsent message")!
          .click(),
      );
      assert.equal(
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
        newer ? "My quoted reply" : "",
      );
      assert.equal(document.querySelector(".room-send-pending"), null);
      assert.equal(Boolean(document.querySelector(".room-reply-draft")), newer);
    } else {
      assert.equal(posts.length, 0);
      await act(async () =>
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent === "Send pending message")!
          .click(),
      );
      assert.equal(posts.length, 1);
      assert.equal(operation.acknowledged, true);
      assert.equal(document.querySelector(".room-send-pending"), null);
      assert.equal(
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
        newer ? "My quoted reply" : "",
      );
      assert.equal(Boolean(document.querySelector(".room-reply-draft")), newer);
      assert.equal(
        document.querySelector<HTMLButtonElement>(
          ".rooms-chat-compose .action-orb",
        )!.disabled,
        !newer,
      );
      if (!newer) {
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              ".rooms-chat-compose .action-orb",
            )!
            .click(),
        );
        assert.equal(posts.length, 1);
      }
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globalThis.setInterval = oldInterval;
  }
}
test("Lost prepare responses and explicit cancellation settle only the original draft revision", async () => {
  await scenario(true, false);
  await scenario(false, true);
  await scenario(true, false, true);
  await scenario(false, true, true);
  await scenario(true, false, false, true);
  await scenario(false, true, false, false, true);
});
