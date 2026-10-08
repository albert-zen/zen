import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { RoomDraftContext } from "../src/renderer/src/room-drafts.js";

const source = {
  id: "source",
  roomId: "room",
  author: "Agent",
  text: "Quoted original",
  kind: "agent",
  createdAt: 0,
  originThreadId: null,
  originTurnId: null,
};
async function setup(
  execute: (id: string, input: any) => Promise<any>,
  shared = false,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const interval = globalThis.setInterval;
  let tick: () => any = () => {};
  globalThis.setInterval = ((fn: any) => {
    tick = fn;
    return 1;
  }) as any;
  const sdk: any = { commands: { execute } };
  const root = createRoot(document.getElementById("root")!);
  let remount: () => void = () => {};
  let savedIntents: any;
  function Shared() {
    const [key, setKey] = useState(0),
      [drafts, setDrafts] = useState<Record<string, string>>({}),
      [replies, setReplies] = useState<Record<string, any>>({});
    const revisions = useRef({}),
      intentRevisions = useRef({});
    savedIntents = intentRevisions;
    remount = () => setKey((x) => x + 1);
    return React.createElement(
      RoomDraftContext.Provider,
      {
        value: {
          drafts,
          setDrafts,
          replies,
          setReplies,
          revisions,
          intentRevisions,
        },
      },
      React.createElement(RoomsPage, { key, sdk }),
    );
  }
  await act(async () =>
    root.render(
      shared
        ? React.createElement(Shared)
        : React.createElement(RoomsPage, { sdk }),
    ),
  );
  return {
    dom,
    tick: async () =>
      act(async () => {
        tick();
      }),
    remount: async () => act(async () => remount()),
    intents: () => savedIntents.current,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      globalThis.setInterval = interval;
    },
  };
}
async function edit(dom: any, value: string) {
  await act(async () => {
    const editor =
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(editor, value);
    editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function clickText(label: string, index = 0) {
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .filter(
        (b) =>
          b.textContent === label || b.getAttribute("aria-label") === label,
      )
      [index]!.click(),
  );
}
async function send() {
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(".rooms-chat-compose .action-orb")!
      .click(),
  );
}
const baseRoom = {
  id: "room",
  name: "Room",
  members: [{ name: "Worker", threadId: "worker" }],
  messages: [source],
  createdAt: 0,
  operationEpoch: "epoch",
};
async function multiplePrepareRecovery(newer = false) {
  const operations: any[] = [];
  const posts: any[] = [];
  const messages: any[] = [source];
  let failList = false;
  const s = await setup(async (id, input) => {
    if (id === "list") {
      if (failList) throw Error("refresh temporarily unavailable");
      return {
        rooms: [
          {
            ...structuredClone(baseRoom),
            messages: structuredClone(messages),
            pendingCount: operations.filter((o) => !o.acknowledged).length,
            operations: [],
          },
        ],
      };
    }
    if (id === "operations")
      return {
        operations: operations
          .filter((o) => !o.acknowledged)
          .map((o) => ({
            id: o.id,
            text: o.text,
            messageId: o.messageId,
            createdAt: 0,
          })),
        nextCursor: null,
      };
    if (id === "prepare-message") {
      operations.push({
        id: input.operationId,
        text: input.text,
        messageId: null,
        acknowledged: false,
        replyToMessageId: input.replyToMessageId,
      });
      if (operations.length === 1) failList = true;
      throw Error("prepare response lost");
    }
    const op = operations.find((o) => o.id === input.operationId);
    if (id === "operation")
      return op
        ? {
            state: op.cancelled
              ? "cancelled"
              : op.messageId
                ? "saved"
                : "prepared",
            messageId: op.messageId,
            text: op.text,
            mentions: [],
          }
        : { state: "unknown", messageId: null, mentions: [] };
    if (id === "post-message") {
      posts.push(input);
      op.messageId = "posted-" + operations.indexOf(op);
      messages.push({
        ...source,
        id: op.messageId,
        author: "You",
        kind: "human",
        text: op.text,
      });
      return { messageId: op.messageId };
    }
    if (id === "ack-operation") {
      op.acknowledged = true;
      return {};
    }
    if (id === "cancel-prepared") {
      op.cancelled = true;
      op.acknowledged = true;
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
  }, true);
  try {
    assert.equal(
      document.querySelector(".room-message header strong")!.textContent,
      "Unknown member",
    );
    assert.equal(
      document.querySelector(".room-message header .room-role"),
      null,
    );
    await clickText("Reply");
    await edit(s.dom, "First draft");
    await send();
    assert.equal(operations.length, 1);
    assert.equal(document.querySelector(".room-send-pending"), null);
    await edit(s.dom, "Second quoted draft");
    failList = false;
    await send();
    assert.equal(operations.length, 2);
    assert.equal(Object.keys(s.intents()).length, 2);
    assert.equal(document.querySelectorAll(".room-send-pending").length, 2);
    if (newer) {
      await edit(s.dom, "temporary newer revision");
      await edit(s.dom, "Second quoted draft");
    }
    await clickText("Send pending message", 1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].operationId, operations[1].id);
    assert.equal(operations[1].acknowledged, true);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
      newer ? "Second quoted draft" : "",
    );
    assert.equal(Boolean(document.querySelector(".room-reply-draft")), newer);
    assert.equal(s.intents()[operations[1].id], undefined);
    await clickText("Cancel unsent message");
    assert.equal(document.querySelectorAll(".room-send-pending").length, 0);
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        ".rooms-chat-compose .action-orb",
      )!.disabled,
      !newer,
    );
    if (!newer) {
      await send();
      assert.equal(operations.length, 2);
    }
  } finally {
    await s.close();
  }
}
async function unsettledRemount() {
  let operation: any = null;
  let rejectPrepare: (reason: Error) => void;
  let refreshFails = false;
  const pendingPrepare = new Promise((_, reject) => (rejectPrepare = reject));
  const s = await setup(async (id, input) => {
    if (id === "list") {
      if (refreshFails) throw Error("refresh failed");
      return {
        rooms: [
          {
            ...structuredClone(baseRoom),
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
      };
      let hidden = operation;
      operation = null;
      await pendingPrepare;
      operation = hidden;
      return {};
    }
    if (id === "operation")
      return operation
        ? {
            state: operation.messageId ? "saved" : "prepared",
            text: operation.text,
            messageId: operation.messageId,
            mentions: [],
          }
        : { state: "unknown", messageId: null, mentions: [] };
    if (id === "post-message") {
      operation.messageId = "posted";
      return { messageId: "posted" };
    }
    if (id === "ack-operation") {
      operation.acknowledged = true;
      return {};
    }
    throw Error(id);
  }, true);
  try {
    await clickText("Reply");
    await edit(s.dom, "Original quoted draft");
    await send();
    const originalId = Object.keys(s.intents())[0]!;
    assert.equal(s.intents()[originalId].settled, false);
    await s.remount();
    assert.equal(s.intents()[originalId].settled, false);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
      "Original quoted draft",
    );
    // The prepare operation becomes durable before its error is delivered.
    operation = {
      id: originalId,
      text: "Original quoted draft",
      messageId: null,
      acknowledged: false,
    };
    refreshFails = true;
    await act(async () => {
      rejectPrepare!(Error("prepare response lost"));
    });
    assert.equal(s.intents()[originalId].settled, true);
    refreshFails = false;
    await s.tick();
    await clickText("Send pending message");
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
      "",
    );
    assert.equal(document.querySelector(".room-reply-draft"), null);
  } finally {
    await s.close();
  }
}
test("Secondary recovery keeps exact draft identity and unsettled remount does not discard it", async () => {
  await multiplePrepareRecovery();
  await multiplePrepareRecovery(true);
  await unsettledRemount();
});
