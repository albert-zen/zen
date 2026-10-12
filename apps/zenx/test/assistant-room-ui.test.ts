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
  let roomName = "My assistant";
  let releaseRename: (() => void) | undefined;
  let deferRename = false;
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
                name: roomName,
                members: [{ name: "Chief", threadId: "chief" }],
                assistant: { threadId: "chief", triggerId: "trigger" },
                assistantRepliesEnabled: enabled,
                messages: [],
                createdAt: 0,
              },
            ],
          };
        if (id === "rename") {
          if (deferRename)
            await new Promise<void>((resolve) => {
              releaseRename = resolve;
            });
          roomName = input.name;
          return { renamed: true };
        }
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
    assert.equal(
      document.querySelector(".room-composer-note"),
      null,
      "active PAW composer has no implementation-jargon footer",
    );
    assert.match(document.body.textContent ?? "", /No @mention needed/);
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /model quota|next model cycle|PAW active/,
    );
    assert.equal(
      [...document.querySelectorAll("button")].some(
        (x) => x.textContent === "@Chief",
      ),
      false,
    );
    const rename = document.querySelector(
      '[aria-label="Rename conversation"]',
    ) as HTMLButtonElement;
    await act(async () => rename.click());
    const nameInput = document.querySelector(
      '[role="dialog"] input',
    ) as HTMLInputElement;
    assert.equal(document.activeElement, nameInput);
    await act(async () =>
      document.querySelector('[role="dialog"]')!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(
      calls.filter((x) => x.id === "rename").length,
      0,
      "Escape does not rename",
    );
    await act(async () => rename.click());
    const editName = document.querySelector(
      '[role="dialog"] input',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(editName, "Milo");
      editName.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    // Use the normal React change handler in this JSDOM harness.
    const reactProps = Object.keys(editName).find((key) =>
      key.startsWith("__reactProps"),
    )!;
    await act(async () =>
      (editName as any)[reactProps].onChange({ target: { value: "Milo" } }),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((x) => x.textContent === "Save name")!
        .click(),
    );
    assert.deepEqual(
      calls.filter((x) => x.id === "rename"),
      [{ id: "rename", input: { roomId: "room", name: "Milo" } }],
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    deferRename = true;
    await act(async () => rename.click());
    const pendingName = document.querySelector(
      '[role="dialog"] input',
    ) as HTMLInputElement;
    const propsKey = Object.keys(pendingName).find((key) =>
      key.startsWith("__reactProps"),
    )!;
    await act(async () =>
      (pendingName as any)[propsKey].onChange({
        target: { value: "First saved name" },
      }),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((x) => x.textContent === "Save name")!
        .click(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((x) => x.textContent === "Cancel")!
        .click(),
    );
    await act(async () =>
      (
        document.querySelector(
          '[aria-label="Conversation settings"]',
        ) as HTMLButtonElement
      ).click(),
    );
    const nextName = document.querySelector(
      '[role="dialog"] input',
    ) as HTMLInputElement;
    const nextProps = Object.keys(nextName).find((key) =>
      key.startsWith("__reactProps"),
    )!;
    await act(async () =>
      (nextName as any)[nextProps].onChange({
        target: { value: "New unsaved name" },
      }),
    );
    await act(async () => releaseRename!());
    assert.ok(
      document.querySelector(
        '[role="dialog"][aria-label="Conversation settings"]',
      ),
      "old completion leaves newer dialog open",
    );
    assert.equal(
      (document.querySelector('[role="dialog"] input') as HTMLInputElement)
        .value,
      "New unsaved name",
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((x) => x.textContent === "Close")!
        .click(),
    );

    await act(async () =>
      (
        document.querySelector(
          '[aria-label="Conversation settings"]',
        ) as HTMLButtonElement
      ).click(),
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
    assert.match(document.body.textContent ?? "", /First saved name/);
    assert.match(document.body.textContent ?? "", /Chief/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

for (const entry of ["primary route", "plugin button"] as const) {
  test(`PAW explicit existing binding keeps the command and custom identity: ${entry}`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.assign(window, {
      zenx: {
        plugins: {
          get: async () => ({
            plugins: [
              "zenx-rooms",
              "zenx-triggers",
              "zenx-self-control",
              "zenx-subagents",
            ].map((id) => ({
              id,
              displayName: id,
              lifecycle: "enabled",
              enabled: true,
              available: true,
            })),
          }),
          onChange: () => () => {},
        },
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
          if (id === "workspaces") return [];
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
      assert.equal(input("Name").value, "PAW");
      assert.match(document.body.textContent ?? "", /New PAW conversation/);
      assert.match(
        document.body.textContent ?? "",
        /creates its own working conversation/,
      );
      assert.match(document.body.textContent ?? "", /Chat and memory: Ready/);
      assert.ok(
        calls.every((call) => ["list", "workspaces"].includes(call.id)),
      );
      await fill("Name", "Daily Companion");
      assert.equal(
        [...document.querySelectorAll("label")].some(
          (node) => node.textContent === "Member name",
        ),
        false,
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            '[aria-label="Working conversation"]',
          )!
          .click(),
      );
      await act(async () =>
        document
          .querySelector<HTMLElement>('[role="option"][data-value="existing"]')!
          .click(),
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            '[aria-label="Existing conversation"]',
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
      const creations = calls.filter((call) => call.id === "create-assistant");
      assert.equal(creations.length, 1);
      const submitted = creations[0]!.input as {
        name: string;
        memberName: string;
        operationId: string;
        target: unknown;
      };
      assert.equal(submitted.name, "Daily Companion");
      assert.equal(submitted.memberName, "Daily Companion");
      assert.equal(typeof submitted.operationId, "string");
      assert.deepEqual(submitted.target, {
        kind: "existing",
        threadId: "existing-thread",
      });
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
