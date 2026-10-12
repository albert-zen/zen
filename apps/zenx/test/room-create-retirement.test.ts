import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

for (const interruption of [
  "unmount",
  "new Room route",
  "unmount during refresh",
] as const) {
  test(`late Room creation keeps the newer navigation: ${interruption}`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "http://localhost",
      pretendToBeVisual: true,
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      React,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.assign(window, {
      zenx: {
        threads: {
          list: async () => [
            {
              threadId: "member-thread",
              name: "Member conversation",
              preview: "Member conversation",
              status: "idle",
              archived: false,
              currentMetadata: { cwd: "/work" },
            },
          ],
        },
      },
    });
    let releaseCreate!: (value: unknown) => void;
    const creation = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshed = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let creates = 0;
    let created = false;
    let waitingForRefresh = false;
    const routes: string[] = [];
    const sdk = (route: string) =>
      ({
        context: { route, primaryNavigation: true },
        navigation: { navigate: (route: string) => routes.push(route) },
        commands: {
          execute: async (id: string) => {
            if (id === "list") {
              if (created && interruption === "unmount during refresh") {
                waitingForRefresh = true;
                await refreshed;
              }
              return { rooms: [] };
            }
            if (id === "create") {
              creates++;
              if (interruption !== "unmount during refresh") await creation;
              created = true;
              return { id: "late-room" };
            }
            throw Error(id);
          },
        },
      }) as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    const fill = async (label: string, text: string) =>
      act(async () => {
        const input = [...document.querySelectorAll("label")]
          .find((node) => node.querySelector("span")?.textContent === label)!
          .querySelector("input")!;
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, text);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    try {
      await act(async () =>
        root.render(
          React.createElement(RoomsPage, {
            sdk: sdk("/plugins/zenx-rooms/rooms?create=room"),
          }),
        ),
      );
      await fill("Room name", "Late Room");
      await fill("Member name", "Member");
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            '[aria-label="Member conversation"]',
          )!
          .click(),
      );
      await act(async () =>
        document
          .querySelector<HTMLElement>(
            '[role=option][data-value="member-thread"]',
          )!
          .click(),
      );
      const create = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent === "Create Room")!;
      assert.equal(create.disabled, false);
      await act(async () => create.click());
      assert.equal(creates, 1);
      if (interruption === "unmount during refresh") assert(waitingForRefresh);
      await act(async () =>
        root.render(
          interruption === "new Room route"
            ? React.createElement(RoomsPage, {
                sdk: sdk("/plugins/zenx-rooms/rooms?roomId=newer-choice"),
              })
            : React.createElement("p", null, "User chose a different Thread"),
        ),
      );
      await act(async () => {
        releaseCreate({ id: "late-room" });
        releaseRefresh();
      });
      assert(created, "the already accepted Host Room is preserved");
      assert.deepEqual(
        routes,
        [],
        "a retired form must not replace the user's newer navigation",
      );
      assert.equal(
        creates,
        1,
        "retirement must not retry or undo Room creation",
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
