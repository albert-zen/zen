import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("Rooms disambiguate same-title conversations and submit the exact searched identity", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const ids = ["thread-alpha-long-identity", "thread-beta-long-identity"];
  Object.assign(window, {
    zenx: {
      threads: {
        list: async () =>
          ids.map((threadId, index) => ({
            threadId,
            name: "Same title",
            preview: "",
            currentMetadata: { cwd: `/work/${index}` },
          })),
      },
    },
  });
  const calls: Array<{ id: string; input: any }> = [];
  const sdk = {
    commands: {
      execute: async (id: string, input: any) => {
        if (id === "list")
          return {
            rooms: [
              { id: "room", name: "Existing", members: [], messages: [] },
            ],
          };
        calls.push({ id, input });
        return null;
      },
    },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  const fill = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    const choose = async (index: number, id: string) => {
      const trigger = document.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Member conversation"]',
      )[index]!;
      await act(async () => trigger.click());
      const labels = [...document.querySelectorAll('[role="option"]')].map(
        (option) => option.textContent,
      );
      assert.equal(
        new Set(labels).size,
        2,
        "same-title choices must be distinguishable",
      );
      assert.ok(labels.every((label) => label?.includes("/work/")));
      await fill(
        document.querySelector<HTMLInputElement>('[role="combobox"]')!,
        id,
      );
      assert.equal(document.querySelectorAll('[role="option"]').length, 1);
      await act(async () =>
        document.querySelector<HTMLElement>('[role="option"]')!.click(),
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      assert.ok(trigger.textContent?.includes(id.slice(0, 12)));
    };
    await choose(0, ids[1]!);
    const inputs = document.querySelectorAll<HTMLInputElement>(
      ".room-create-card input",
    );
    await fill(inputs[0]!, "New");
    await fill(inputs[1]!, "member");
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Create Room")!
        .click(),
    );
    assert.equal(
      calls.find((call) => call.id === "create")?.input.members[0].threadId,
      ids[1],
    );
    await choose(1, ids[0]!);
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Add member")!
        .click(),
    );
    assert.equal(
      calls.find((call) => call.id === "add-member")?.input.threadId,
      ids[0],
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
