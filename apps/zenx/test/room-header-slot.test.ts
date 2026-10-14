import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import {
  RoomHeaderActions,
  RoomHeaderContext,
} from "../src/renderer/src/room-header.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

type Slot = React.ContextType<typeof RoomHeaderContext>;

async function mountSlot() {
  const dom = new JSDOM(
    '<header class="workspace-header"><h1>Room title</h1><div class="room-title-actions-host"></div></header><main id="root"></main>',
    { url: "http://localhost" },
  );
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  await i18n.changeLanguage("en");
  const host = document.querySelector<HTMLElement>(".room-title-actions-host")!;
  const root = createRoot(document.getElementById("root")!);
  return {
    dom,
    root,
    host,
    render: async (child: React.ReactNode, slot: Slot) =>
      act(async () =>
        root.render(
          React.createElement(
            RoomHeaderContext.Provider,
            { value: slot },
            child,
          ),
        ),
      ),
    close: async () => {
      await act(async () => root.unmount());
      assert.equal(
        host.childElementCount,
        0,
        "unmount removes portaled actions",
      );
      Object.assign(globalThis, previous);
      dom.window.close();
    },
  };
}

function actions(roomId: string, primary = true) {
  return React.createElement(RoomHeaderActions, {
    roomId,
    primary,
    children: React.createElement(
      "button",
      { "data-room-id": roomId },
      `Actions ${roomId}`,
    ),
    fallback: React.createElement(
      "header",
      { className: "fallback-header" },
      `Fallback ${roomId}`,
    ),
  });
}

test("Room actions share the shell title host, fence exact room identity, and clean up on switch/unmount", async () => {
  const h = await mountSlot();
  try {
    await h.render(actions("room-a"), { roomId: "room-a", element: h.host });
    assert.equal(h.host.querySelector("button")!.textContent, "Actions room-a");
    assert.equal(
      h.host.closest("header")!.querySelector("h1")!.textContent,
      "Room title",
    );
    assert.equal(document.querySelector("#root header"), null);
    assert.equal(document.querySelectorAll(".room-title-actions").length, 1);

    await h.render(actions("room-a"), { roomId: "room-b", element: h.host });
    assert.equal(
      h.host.childElementCount,
      0,
      "old Room actions cannot occupy the new title",
    );
    assert.equal(document.querySelector(".fallback-header"), null);
    await h.render(actions("room-b"), { roomId: "room-b", element: h.host });
    assert.equal(h.host.querySelector("button")!.dataset.roomId, "room-b");
    assert.doesNotMatch(h.host.textContent!, /room-a/);

    await h.render(actions("room-b"), { roomId: "room-b", element: null });
    assert.equal(
      h.host.childElementCount,
      0,
      "no detached actions when the host disappears",
    );
    assert.equal(document.querySelector(".fallback-header"), null);
    await h.render(actions("room-b"), { roomId: "room-b", element: h.host });
  } finally {
    await h.close();
  }
});

test("a route with no selected Room cannot publish actions into a stale shell host", async () => {
  const h = await mountSlot();
  try {
    await h.render(actions("room-a"), { roomId: "room-a", element: h.host });
    await h.render(actions("room-a"), { roomId: null, element: h.host });
    assert.equal(h.host.childElementCount, 0);
    assert.equal(document.querySelector(".fallback-header"), null);
  } finally {
    await h.close();
  }
});

test("Room header fallback remains available without App context and for non-primary surfaces", async () => {
  const h = await mountSlot();
  try {
    await h.render(actions("room-a"), null);
    assert.equal(
      document.querySelector(".fallback-header")!.textContent,
      "Fallback room-a",
    );
    assert.equal(h.host.childElementCount, 0);
    await h.render(actions("room-b", false), {
      roomId: "room-b",
      element: h.host,
    });
    assert.equal(
      document.querySelector(".fallback-header")!.textContent,
      "Fallback room-b",
    );
    assert.equal(h.host.childElementCount, 0);
  } finally {
    await h.close();
  }
});

test("real portaled Room controls rename the exact Room, open its workspace, and reveal reply settings without side effects", async () => {
  const h = await mountSlot();
  const room = {
    id: "room /?中",
    name: "Team",
    members: [{ name: "Ops|Bot", threadId: "thread /?中" }],
    responders: [{ name: "Ops|Bot", configured: false }],
    messages: [],
    createdAt: 0,
  };
  const calls: Array<{ id: string; input: unknown }> = [];
  const routes: string[] = [];
  const sdk = {
    context: {
      primaryNavigation: true,
      route: `/plugins/zenx-rooms/rooms?${new URLSearchParams({ roomId: room.id })}`,
    },
    navigation: { navigate: (route: string) => routes.push(route) },
    commands: {
      execute: async (id: string, input: unknown) => {
        calls.push({ id, input });
        if (id === "list") return { rooms: [room] };
        if (id === "rename") {
          room.name = (input as { name: string }).name;
          return { renamed: true };
        }
        throw Error(`Unexpected ${id}`);
      },
    },
  } as unknown as PluginUiSdkV1;
  const click = async (label: string) => {
    const button = h.host.querySelector<HTMLButtonElement>(
      `[aria-label="${label}"]`,
    );
    assert.ok(button, label);
    await act(async () => button.click());
  };
  try {
    await h.render(React.createElement(RoomsPage, { sdk }), {
      roomId: room.id,
      element: h.host,
    });
    assert.equal(h.host.querySelectorAll("button").length, 3);
    assert.equal(document.querySelector(".rooms-chat-header"), null);
    assert.equal(document.querySelector(".rooms-chat-list"), null);
    assert.equal(document.querySelector(".rooms-chat-status"), null);
    assert.equal(document.querySelector(".room-setup-note"), null);
    assert.ok(
      h.host.querySelector(
        '[aria-label="Conversation settings"] .room-header-status-dot',
      ),
    );

    await click("Rename conversation");
    const renameDialog = document.querySelector(
      '[role="dialog"][aria-label="Rename conversation"]',
    )!;
    assert.ok(renameDialog);
    const input = renameDialog.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.value, "Team");
    assert.equal(document.activeElement, input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        h.dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Renamed team");
      input.dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
    });
    const save = [...renameDialog.querySelectorAll("button")].find(
      (button) => button.textContent === "Save name",
    )!;
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.deepEqual(
      calls.filter((call) => call.id !== "list"),
      [{ id: "rename", input: { roomId: room.id, name: "Renamed team" } }],
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(room.members, [
      { name: "Ops|Bot", threadId: "thread /?中" },
    ]);

    await click("Open conversation workspace");
    const workspace = new URL(routes.pop()!, "https://zenx.local");
    assert.equal(workspace.pathname, "/plugins/zenx-rooms/rooms");
    assert.equal(workspace.searchParams.get("roomId"), room.id);
    assert.equal(workspace.searchParams.get("panel"), "open");
    const writes = calls.filter((call) => call.id !== "list");
    await click("Conversation settings");
    const settings = document.querySelector(
      '[role="dialog"][aria-label="Conversation settings"]',
    )!;
    assert.equal(
      settings.querySelector<HTMLInputElement>("input")!.value,
      "Renamed team",
    );
    const details =
      settings.querySelector<HTMLDetailsElement>(".room-setup-note")!;
    assert.equal(details.open, false);
    await act(async () => details.querySelector("summary")!.click());
    assert.equal(details.open, true);
    assert.match(details.textContent!, /unconfigured, paused, or disabled/);
    await act(async () => details.querySelector("button")!.click());
    const setup = new URL(routes.pop()!, "https://zenx.local");
    assert.equal(setup.pathname, "/plugins/zenx-triggers/triggers");
    assert.equal(setup.searchParams.get("roomId"), room.id);
    assert.equal(setup.searchParams.get("member"), "Ops|Bot");
    assert.equal(setup.searchParams.get("threadId"), "thread /?中");
    await act(async () =>
      settings.dispatchEvent(
        new h.dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.querySelector(".room-setup-note"), null);
    assert.deepEqual(
      calls.filter((call) => call.id !== "list"),
      writes,
    );
  } finally {
    await h.close();
  }
});

test("Room failures remain outside on-demand settings after the header actions move", async () => {
  const h = await mountSlot();
  const calls: string[] = [];
  Object.assign(window, {
    zenx: {
      threads: {
        list: async () => {
          throw Error("Member conversations unavailable");
        },
      },
    },
  });
  const sdk = {
    context: {
      primaryNavigation: true,
      route: "/plugins/zenx-rooms/rooms?roomId=room",
    },
    navigation: { navigate: () => {} },
    commands: {
      execute: async (id: string) => {
        calls.push(id);
        if (id === "list")
          return {
            rooms: [
              {
                id: "room",
                name: "Room",
                createdAt: 0,
                members: [{ name: "Helper", threadId: "thread" }],
                responders: [{ name: "Helper", configured: false }],
                messages: [],
              },
            ],
          };
        throw Error(`Unexpected ${id}`);
      },
    },
  } as unknown as PluginUiSdkV1;
  try {
    await h.render(React.createElement(RoomsPage, { sdk }), {
      roomId: "room",
      element: h.host,
    });
    const error = document.querySelector('.rooms-chat-status [role="alert"]')!;
    assert.match(error.textContent!, /Member conversations unavailable/);
    assert.equal(document.querySelector(".room-setup-note"), null);
    await act(async () =>
      h.host
        .querySelector<HTMLButtonElement>(
          '[aria-label="Conversation settings"]',
        )!
        .click(),
    );
    assert.ok(document.querySelector('[role="dialog"] .room-setup-note'));
    assert.equal(error.closest('[role="dialog"]'), null);
    assert.match(error.textContent!, /Member conversations unavailable/);
    assert.ok(calls.length > 0 && calls.every((id) => id === "list"));
  } finally {
    await h.close();
  }
});
