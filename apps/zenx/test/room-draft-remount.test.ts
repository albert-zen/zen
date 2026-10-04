import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { RoomDraftContext } from "../src/renderer/src/room-drafts.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

for (const newer of ["different", "same bytes", "unchanged"] as const) {
  test(`App-owned Room draft survives remount and its old send receipt: ${newer}`, async () => {
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
    Object.assign(window, { zenx: { threads: { list: async () => [] } } });
    const room = {
      id: "A",
      name: "Alpha",
      members: [],
      messages: [],
      createdAt: 1,
      operations: [] as Array<{
        id: string;
        text: string;
        messageId: string | null;
        createdAt: number;
      }>,
    };
    let resolvePost: ((value: unknown) => void) | undefined;
    const calls: string[] = [];
    const sdk = {
      context: {
        route: "/plugins/zenx-rooms/rooms?roomId=A",
        primaryNavigation: true,
      },
      navigation: { navigate: () => {} },
      commands: {
        execute: async (id: string, input: any) => {
          calls.push(id);
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
              resolvePost = (value) => {
                room.operations[0]!.messageId = "saved";
                resolve(value);
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
          throw Error(id);
        },
      },
    } as unknown as PluginUiSdkV1;
    function Harness() {
      const [drafts, setDrafts] = useState<Record<string, string>>({});
      const revisions = useRef<Record<string, number>>({});
      const [show, setShow] = useState(true);
      return React.createElement(
        RoomDraftContext.Provider,
        { value: { drafts, setDrafts, revisions } },
        React.createElement(
          "button",
          { id: "toggle", onClick: () => setShow((value) => !value) },
          "Navigate",
        ),
        React.createElement("output", null, JSON.stringify(drafts)),
        show
          ? React.createElement(RoomsPage, { sdk })
          : React.createElement("p", null, "A Thread is selected"),
      );
    }
    const root = createRoot(document.getElementById("root")!);
    const fill = async (text: string) =>
      act(async () => {
        const editor =
          document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(editor, text);
        editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    try {
      await act(async () => root.render(React.createElement(Harness)));
      const original = "Original sent draft";
      await fill(original);
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(".rooms-chat-compose .action-orb")!
          .click(),
      );
      assert(resolvePost);
      await act(async () => document.getElementById("toggle")!.click());
      assert.equal(document.querySelector("#room-chat-input"), null);
      await act(async () => document.getElementById("toggle")!.click());
      assert.equal(
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
        original,
      );
      if (newer !== "unchanged") {
        await fill("Intermediate new edit after returning");
        await fill(
          newer === "same bytes" ? original : "Newer draft after returning",
        );
      }
      await act(async () => resolvePost!({ messageId: "saved" }));
      const expected =
        newer === "unchanged"
          ? ""
          : newer === "same bytes"
            ? original
            : "Newer draft after returning";
      assert.equal(
        document.querySelector<HTMLTextAreaElement>("#room-chat-input")!.value,
        expected,
      );
      assert.deepEqual(
        JSON.parse(document.querySelector("output")!.textContent!),
        { A: expected },
      );
      assert.equal(
        calls.filter((id) => id === "post-message").length,
        1,
        "returning must not repeat the already admitted post",
      );
      assert.equal(calls.filter((id) => id === "ack-operation").length, 1);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
