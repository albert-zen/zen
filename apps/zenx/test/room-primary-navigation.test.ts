import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
test("primary Room navigation switches conversations without a duplicate rail or starting a turn", async () => {
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
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const calls: string[] = [];
  const routes: string[] = [];
  const rooms = ["a", "b"].map((id) => ({
    id,
    name: `Room ${id}`,
    members: [],
    messages: [],
    createdAt: 0,
  }));
  const sdk = (id: string) =>
    ({
      context: {
        route: `/plugins/zenx-rooms/rooms?roomId=${id}`,
        primaryNavigation: true,
      },
      navigation: { navigate: (route: string) => routes.push(route) },
      commands: {
        execute: async (command: string) => {
          calls.push(command);
          if (command === "list") return { rooms };
          throw Error(command);
        },
      },
    }) as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk("a") })),
    );
    assert.equal(
      document.querySelector('nav[aria-label="Rooms"]') === null,
      true,
    );
    assert.equal(document.querySelector(".rooms-chat-header h2"), null);
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk("b") })),
    );
    assert.equal(document.querySelector(".rooms-chat-header h2"), null);
    const panel = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open conversation workspace"]',
    );
    assert.ok(panel);
    await act(async () => panel.click());
    assert.match(routes.at(-1)!, /roomId=b.*panel=open/);
    assert.ok(calls.every((x) => x === "list"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("sidebar rename routes target the PAW identity, survive polling, and close without reopening", async () => {
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
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const calls: string[] = [],
    routes: string[] = [];
  const rooms = [
    {
      id: "paw",
      name: "My PAW",
      assistant: { threadId: "working", triggerId: "reply" },
      members: [{ name: "My PAW", threadId: "working" }],
      messages: [],
      createdAt: 0,
    },
  ];
  const sdk = (manage = "rename") =>
    ({
      context: {
        route: `/plugins/zenx-rooms/rooms?roomId=paw${manage ? `&manage=${manage}` : ""}`,
        primaryNavigation: true,
      },
      navigation: { navigate: (route: string) => routes.push(route) },
      commands: {
        execute: async (command: string) => {
          calls.push(command);
          if (command === "list") return { rooms };
          throw Error(command);
        },
      },
    }) as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk() })),
    );
    assert.equal(
      document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value,
      "My PAW",
    );
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk() })),
    );
    await act(async () =>
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk() })),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(routes.at(-1), "/plugins/zenx-rooms/rooms?roomId=paw");
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk("") })),
    );
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk("settings") })),
    );
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: sdk("") })),
    );
    assert.equal(
      document.querySelector('[role="dialog"]'),
      null,
      "opening the same conversation normally retires management",
    );
    assert.ok(calls.every((call) => call === "list"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

for (const source of ["rename", "settings"]) {
  test(`PAW sidebar ${source} cannot turn ordinary Room header settings into PAW setup`, async () => {
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
    Object.assign(window, {
      zenx: {
        threads: {
          list: async () => [
            {
              threadId: "working",
              name: "Working",
              preview: "",
              status: "idle",
              archived: false,
              currentMetadata: { cwd: "/actual-paw-directory" },
            },
            {
              threadId: "member-thread",
              name: "Reviewer",
              preview: "",
              status: "idle",
              archived: false,
              currentMetadata: { cwd: "/project" },
            },
          ],
        },
      },
    });
    dom.window.HTMLElement.prototype.scrollTo = () => {};
    const calls: { command: string; input: any }[] = [];
    const rooms = [
      {
        id: "paw",
        name: "My PAW",
        assistant: { threadId: "working", triggerId: "reply" },
        members: [{ name: "My PAW", threadId: "working" }],
        messages: [],
        createdAt: 0,
      },
      {
        id: "shared",
        name: "Shared room",
        members: [],
        messages: [],
        createdAt: 0,
      },
    ];
    const sdk = (roomId: string, manage?: string) =>
      ({
        context: {
          route: `/plugins/zenx-rooms/rooms?roomId=${roomId}${manage ? `&manage=${manage}` : ""}`,
          primaryNavigation: true,
        },
        navigation: { navigate: () => {} },
        commands: {
          execute: async (command: string, input: any) => {
            calls.push({ command, input });
            if (command === "list") return { rooms };
            if (command === "add-member") return { updated: true };
            throw Error(command);
          },
        },
      }) as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(
          React.createElement(RoomsPage, { sdk: sdk("paw", source) }),
        ),
      );
      if (source === "settings") {
        assert.equal(
          document.querySelector(".paw-work-directory")?.textContent,
          "/actual-paw-directory",
        );
        assert.equal(
          [...document.querySelectorAll("button")].some(
            (button) => button.textContent === "Open workspace AGENTS.md",
          ),
          true,
        );
      }
      await act(async () =>
        document.querySelector('[role="dialog"]')!.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        ),
      );
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk: sdk("shared") })),
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Conversation settings"]',
          )!
          .click(),
      );
      const dialog = document.querySelector('[role="dialog"]')!;
      assert.equal(
        dialog.querySelector('[aria-label="Working conversation"]') !== null,
        false,
      );
      assert.equal(dialog.querySelector('[aria-label="Project"]'), null);
      const member = [...dialog.querySelectorAll("label")]
        .find((label) => label.textContent === "Member name")
        ?.querySelector("input");
      assert.ok(member, "ordinary Room keeps its member-name field");
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(member, "Reviewer");
        member.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await act(async () =>
        dialog
          .querySelector<HTMLButtonElement>(
            '[aria-label="Member conversation"]',
          )!
          .click(),
      );
      await act(async () =>
        document
          .querySelector<HTMLElement>(
            '[role="option"][data-value="member-thread"]',
          )!
          .click(),
      );
      const add = [
        ...dialog.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent === "Add member")!;
      assert.equal(add.disabled, false);
      await act(async () => add.click());
      assert.deepEqual(
        calls.find((call) => call.command === "add-member")?.input,
        { roomId: "shared", name: "Reviewer", threadId: "member-thread" },
      );
      assert.equal(
        calls.some((call) => call.command === "create-assistant"),
        false,
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
