import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { RoomMessage } from "../src/main/trigger-types.js";
async function boundedGate(
  name: string,
  setRelease: (release: () => void) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      setRelease(resolve);
      timer = setTimeout(
        () => reject(Error(`Timed out waiting for ${name}`)),
        3000,
      );
    });
  } finally {
    clearTimeout(timer);
  }
}
test("confirmed reaction survives a pinned older response while refresh waits", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const messages: RoomMessage[] = Array.from({ length: 24 }, (_, i) => ({
    id: `m${i}`,
    roomId: "room",
    kind: "agent",
    author: "Synthetic",
    text: `Message ${i}`,
    createdAt: i,
    originThreadId: null,
    originTurnId: null,
  }));
  let holdOlder = false,
    holdRefresh = false,
    revision = 30;
  let releaseOlder: (() => void) | undefined,
    releaseRefresh: (() => void) | undefined;
  const original = structuredClone(messages);
  const sdk: any = {
    commands: {
      execute: async (command: string, input: any) => {
        if (command === "list") {
          if (holdRefresh)
            await boundedGate(
              "queued refresh",
              (release) => (releaseRefresh = release),
            );
          return {
            rooms: [
              {
                id: "room",
                name: "Synthetic",
                members: [],
                messages: structuredClone(messages.slice(-1)),
                createdAt: 0,
                messageCount: 24,
                pendingCount: 0,
                operations: [],
              },
            ],
          };
        }
        if (command === "messages") {
          const selected = input.snapshot ?? {
            generation: "11111111-1111-4111-8111-111111111111",
            revision,
            hash: "a".repeat(64),
            roomId: "room",
            messageCount: 24,
          };
          const end = 24 - (input.cursor ?? 0),
            start = Math.max(0, end - 4);
          const page = {
            messages: structuredClone(
              (selected.revision === 30 ? original : messages).slice(
                start,
                end,
              ),
            ),
            nextCursor: start ? (input.cursor ?? 0) + end - start : null,
            snapshot: selected,
            reactionRevisions: Object.fromEntries(
              messages
                .slice(start, end)
                .map((message) => [message.id, selected.revision]),
            ),
          };
          if (holdOlder) {
            holdOlder = false;
            await boundedGate(
              "older page",
              (release) => (releaseOlder = release),
            );
          }
          return page;
        }
        if (command === "react") {
          const message = messages.find(
            (message) => message.id === input.messageId,
          )!;
          message.reactions = [
            { actorId: "user", label: "You", emoji: input.emoji },
          ];
          revision++;
          holdRefresh = true;
          return { updated: true, message: structuredClone(message) };
        }
        throw Error(command);
      },
    },
  };
  const root = createRoot(document.getElementById("root")!);
  const chip = () =>
    document.querySelector(
      '[data-room-message-id="m23"] .room-message-reaction-chip',
    );
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    assert.equal(document.querySelectorAll(".room-message").length, 4);
    holdOlder = true;
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".room-history-edge button")!
        .click(),
    );
    assert(releaseOlder);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-room-message-id="m23"] [aria-label="React"]',
        )!
        .click(),
    );
    await act(async () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.getAttribute("aria-label") === "React 👍")!
        .click(),
    );
    assert(chip());
    await act(async () => releaseOlder!());
    assert(releaseRefresh, "post-reaction refresh stays queued behind history");
    const visible = Array.from(
      document.querySelectorAll<HTMLElement>(".room-message"),
      (message) => message.dataset.roomMessageId,
    );
    assert.equal(visible.length, 20);
    assert.equal(new Set(visible).size, 20);
    assert(
      chip(),
      "confirmed reaction cannot be replaced by older pinned snapshot",
    );
    assert.match(chip()!.textContent!, /👍/);
    holdRefresh = false;
    await act(async () => releaseRefresh!());
    assert(chip());
  } finally {
    holdRefresh = false;
    releaseOlder?.();
    releaseRefresh?.();
    await act(async () => root.unmount());
    dom.window.close();
  }
});
