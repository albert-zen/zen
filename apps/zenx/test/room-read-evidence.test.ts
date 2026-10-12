import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { RoomReadContext } from "../src/renderer/src/room-read-context.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("Room read evidence waits for message load and belongs to the rendered route", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const message = {
    id: "answer",
    roomId: "a",
    author: "Bot",
    kind: "agent",
    text: "Fully loaded answer",
    createdAt: 1234,
  };
  let resolveMessages!: (value: unknown) => void;
  let rejectMessages!: (error: Error) => void;
  let pending = new Promise((resolve, reject) => {
    resolveMessages = resolve;
    rejectMessages = reject;
  });
  const marks: Array<[string, string | null]> = [];
  const acknowledge = (id: string, position: string | null) =>
    marks.push([id, position]);
  const sdk = (id: string) =>
    ({
      context: {
        route: `/plugins/zenx-rooms/rooms?roomId=${id}`,
        primaryNavigation: true,
      },
      navigation: { navigate: () => {} },
      commands: {
        execute: async (command: string) => {
          if (command === "list")
            return {
              rooms: [
                {
                  id: "a",
                  name: "Room a",
                  members: [],
                  messages: [{ ...message, text: "Truncated" }],
                  messageCount: 1,
                  createdAt: 0,
                },
                {
                  id: "b",
                  name: "Room b",
                  members: [],
                  messages: [
                    {
                      ...message,
                      id: "b-answer",
                      roomId: "b",
                      createdAt: 2000,
                      text: "Other preview",
                    },
                  ],
                  messageCount: 1,
                  createdAt: 0,
                },
              ],
            };
          if (command === "messages") return pending;
          throw Error(command);
        },
      },
    }) as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  const render = (id: string) =>
    root.render(
      React.createElement(
        RoomReadContext.Provider,
        { value: acknowledge },
        React.createElement(RoomsPage, { sdk: sdk(id) }),
      ),
    );
  try {
    await act(async () => render("a"));
    assert.deepEqual(
      marks,
      [],
      "navigation preview is not message-load evidence",
    );
    await act(async () => rejectMessages(Error("Cannot load messages")));
    assert.deepEqual(marks, [], "failed history cannot consume unread");
    pending = new Promise((resolve) => {
      resolveMessages = resolve;
    });
    await act(async () => root.render(null));
    await act(async () => render("a"));
    await act(async () =>
      resolveMessages({ messages: [message], nextCursor: null }),
    );
    assert.match(
      document.querySelector(".rooms-chat-feed")!.textContent!,
      /Fully loaded answer/,
    );
    assert.deepEqual(marks.at(-1), ["a", "answer"]);
    marks.length = 0;
    pending = new Promise((resolve) => {
      resolveMessages = resolve;
    });
    await act(async () => render("b"));
    assert.deepEqual(
      marks,
      [],
      "route change cannot acknowledge old Room a as Room b",
    );
    await act(async () =>
      resolveMessages({
        messages: [
          {
            ...message,
            id: "b-answer",
            roomId: "b",
            createdAt: 2000,
            text: "Other full answer",
          },
        ],
        nextCursor: null,
      }),
    );
    assert.deepEqual(marks.at(-1), ["b", "b-answer"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
