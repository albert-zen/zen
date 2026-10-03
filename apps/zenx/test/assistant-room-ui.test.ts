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
      (x) => x.textContent === "Pause PAW",
    );
    assert.ok(pause);
    await act(async () => pause.click());
    assert.deepEqual(
      calls.filter((x) => x.id === "assistant-replies"),
      [{ id: "assistant-replies", input: { roomId: "room", enabled: false } }],
    );
    assert.match(document.body.textContent ?? "", /Messages are saved only/);
    assert.match(document.body.textContent ?? "", /does not replay them/);
    assert.match(document.body.textContent ?? "", /My assistant/);
    assert.match(document.body.textContent ?? "", /Chief/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

for (const entry of ["primary route", "plugin button"] as const) {
  test(`PAW creation keeps the existing command and custom identity: ${entry}`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.assign(window, {
      zenx: {
        threads: {
          list: async () => [
            {
              threadId: "existing-thread",
              name: "Working conversation",
              preview: "Working conversation",
              status: "idle",
              archived: false,
              currentMetadata: { cwd: "/work" },
            },
          ],
        },
      },
    });
    dom.window.HTMLElement.prototype.scrollTo = () => {};
    const calls: Array<{ id: string; input: unknown }> = [];
    const sdk = {
      ...(entry === "primary route"
        ? {
            context: {
              route: "/plugins/zenx-rooms/rooms?create=companion",
              primaryNavigation: true,
            },
          }
        : {}),
      navigation: { navigate: () => {} },
      commands: {
        execute: async (id: string, input: unknown) => {
          calls.push({ id, input });
          if (id === "list") return { rooms: [] };
          if (id === "create-assistant") return { id: "created" };
          throw Error(id);
        },
      },
    } as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    const input = (label: string) =>
      [...document.querySelectorAll("label")]
        .find((node) => node.querySelector("span")?.textContent === label)!
        .querySelector("input")!;
    const fill = async (label: string, value: string) =>
      act(async () => {
        const field = input(label);
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(field, value);
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    try {
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk })),
      );
      if (entry === "plugin button") {
        const preset = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "PAW",
        );
        assert.ok(preset);
        await act(async () => preset.click());
      }
      assert.ok(
        document.querySelector('[role="dialog"][aria-label="Create PAW"]'),
      );
      assert.equal(input("Room name").value, "PAW");
      assert.match(document.body.textContent ?? "", /New PAW conversation/);
      assert.match(document.body.textContent ?? "", /for the PAW preset/);
      assert.ok(calls.every((call) => call.id === "list"));
      await fill("Room name", "Daily Companion");
      await fill("Member name", "Chief");
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
            '[role="option"][data-value="existing-thread"]',
          )!
          .click(),
      );
      const create = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Create PAW",
      );
      assert.ok(create);
      assert.equal(create.disabled, false);
      await act(async () => create.click());
      assert.deepEqual(
        calls.filter((call) => call.id === "create-assistant"),
        [
          {
            id: "create-assistant",
            input: {
              name: "Daily Companion",
              members: [{ name: "Chief", threadId: "existing-thread" }],
            },
          },
        ],
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
