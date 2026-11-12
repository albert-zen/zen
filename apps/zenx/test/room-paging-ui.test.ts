import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("Rooms pages long Chinese and code transcript without truncating the full message or losing composer", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const all = Array.from({ length: 20 }, (_, i) => ({
    id: `id-${i}`,
    roomId: "first",
    author: i % 2 ? "Bot" : "You",
    text:
      i === 0
        ? "中文".repeat(1200) + '\n\n```ts\nconst code = "完整代码";\n```'
        : `msg-${i}`,
    kind: i % 2 ? "agent" : "human",
    createdAt: 1000 + i,
  }));
  const sdk = {
    commands: {
      execute: async (
        id: string,
        input?: { cursor?: number; roomId?: string },
      ) => {
        if (id === "list") {
          const index = input?.cursor ?? 0;
          const room =
            index === 0
              ? {
                  id: "first",
                  name: "First",
                  members: [{ name: "Bot", threadId: "bot" }],
                  messages: all
                    .slice(-1)
                    .map((m) => ({ ...m, text: m.text.slice(0, 120) })),
                  messageCount: 20,
                  operations: [],
                  pendingCount: 0,
                  createdAt: 1,
                }
              : {
                  id: "second",
                  name: "Second",
                  members: [],
                  messages: [],
                  messageCount: 0,
                  operations: [],
                  pendingCount: 0,
                  createdAt: 2,
                };
          return { rooms: [room], nextCursor: index === 0 ? 1 : null };
        }
        if (id === "messages") {
          const cursor = input?.cursor ?? 0;
          const end = Math.max(0, 20 - cursor);
          const start = Math.max(0, end - 4);
          return {
            messages: input?.roomId === "second" ? [] : all.slice(start, end),
            nextCursor: start > 0 ? cursor + (end - start) : null,
          };
        }
        if (id === "delivery")
          return { state: "unknown", messageId: null, mentions: [] };
        throw Error(id);
      },
    },
    navigation: { navigate: () => {} },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    assert.equal(document.querySelectorAll(".room-message").length, 4);
    assert(document.querySelector<HTMLTextAreaElement>("#room-chat-input"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".room-load-earlier")!.click(),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.equal(document.querySelectorAll(".room-message").length, 20);
    const timeline = document.querySelector(".rooms-chat-feed")!.textContent!;
    assert.match(timeline, /完整代码/u);
    assert.match(timeline, /中文中文中文/u);
    assert.equal(document.querySelector(".room-load-earlier"), null);
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".rooms-chat-list > button",
        ),
      ]
        .find((b) => b.textContent?.includes("#Second"))!
        .click(),
    );
    assert.equal(document.querySelectorAll(".room-message").length, 0);
    assert(document.querySelector<HTMLTextAreaElement>("#room-chat-input"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
