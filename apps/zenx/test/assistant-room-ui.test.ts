import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("assistant view reads without starting work, pauses future replies explicitly, and does not insert mentions", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  let enabled = true;
  const calls: Array<{ id: string; input: any }> = [];
  const sdk = {
    commands: {
      execute: async (id: string, input: any) => {
        calls.push({ id, input });
        if (id === "list")
          return {
            rooms: [
              {
                id: "room",
                name: "My assistant",
                members: [{ name: "Chief", threadId: "chief" }],
                assistant: { threadId: "chief", triggerId: "trigger" },
                assistantRepliesEnabled: enabled,
                messages: [],
                createdAt: 0,
              },
            ],
          };
        if (id === "assistant-replies") {
          enabled = input.enabled;
          return { updated: true };
        }
        throw new Error(`Unexpected ${id}`);
      },
    },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    assert.ok(calls.every((x) => x.id === "list"));
    assert.match(document.body.textContent ?? "", /No @mention needed/);
    assert.match(
      document.body.textContent ?? "",
      /Messages use the linked conversation’s model quota/,
    );
    assert.equal(
      [...document.querySelectorAll("button")].some(
        (x) => x.textContent === "@Chief",
      ),
      false,
    );
    const pause = [...document.querySelectorAll("button")].find(
      (x) => x.textContent === "Pause assistant",
    );
    assert.ok(pause);
    await act(async () => pause.click());
    assert.deepEqual(
      calls.filter((x) => x.id === "assistant-replies"),
      [{ id: "assistant-replies", input: { roomId: "room", enabled: false } }],
    );
    assert.match(document.body.textContent ?? "", /Messages are saved only/);
    assert.match(document.body.textContent ?? "", /does not replay them/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
