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

for (const primaryNavigation of [true, false]) {
  test(`healthy empty Rooms offers explicit creation and restores focus (primary=${primaryNavigation})`, async () => {
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
    const calls: string[] = [];
    const sdk = {
      context: { route: "/plugins/zenx-rooms/rooms", primaryNavigation },
      navigation: {
        navigate: () => assert.fail("opening a local form must not navigate"),
      },
      commands: {
        execute: async (command: string) => {
          calls.push(command);
          if (command === "list") return { rooms: [] };
          throw Error(command);
        },
      },
    } as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk })),
      );
      const entry = document.querySelector<HTMLButtonElement>(
        ".rooms-chat-empty button",
      )!;
      assert.ok(entry, "empty Rooms needs a visible creation entry");
      assert.equal(entry.textContent?.trim(), "New Room");
      assert.equal(entry.tabIndex, 0);
      assert.equal(entry.disabled, false);
      assert.equal(
        Boolean(document.querySelector(".rooms-chat-list")),
        !primaryNavigation,
      );
      for (const dismissal of ["Escape", "Close"]) {
        entry.focus();
        await act(async () => {
          entry.click();
          entry.click();
        });
        assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
        assert.match(
          document.querySelector('[role="dialog"]')!.textContent!,
          /Room name/,
        );
        assert.doesNotMatch(
          document.querySelector('[role="dialog"]')!.textContent!,
          /Create and say hello/,
        );
        assert.ok(calls.every((command) => command === "list"));
        const close = [
          ...document.querySelectorAll<HTMLButtonElement>("button"),
        ].find(
          (button) =>
            button.textContent === dismissal ||
            button.getAttribute("aria-label") === dismissal,
        )!;
        if (dismissal === "Escape") {
          await act(async () =>
            document.querySelector('[role="dialog"]')!.dispatchEvent(
              new dom.window.KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
              }),
            ),
          );
        } else {
          assert.ok(close);
          await act(async () => close.click());
        }
        await new Promise((resolve) =>
          dom.window.requestAnimationFrame(resolve),
        );
        assert.equal(document.querySelector('[role="dialog"]'), null);
        assert.equal(document.activeElement, entry);
      }
      if (!primaryNavigation) {
        const headerNew = [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".rooms-chat-list-head button",
          ),
        ].find((button) => button.textContent?.trim() === "New")!;
        await act(async () => headerNew.click());
        assert.match(
          document.querySelector('[role="dialog"]')!.textContent!,
          /Room name/,
        );
      }
      assert.ok(
        calls.every((command) => command === "list"),
        "no create, Turn or message before explicit submission",
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}

test("loading and failed Rooms reads do not masquerade as healthy empty Rooms", async () => {
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
  let reject!: (reason: Error) => void;
  const reading = new Promise((_, fail) => {
    reject = fail;
  });
  const sdk = {
    context: { route: "/plugins/zenx-rooms/rooms", primaryNavigation: true },
    commands: {
      execute: async (command: string) => {
        assert.equal(command, "list");
        return reading;
      },
    },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    assert.match(
      document.querySelector('[role="status"]')!.textContent!,
      /Loading rooms/,
    );
    assert.equal(document.querySelector(".rooms-chat-empty button"), null);
    await act(async () => reject(Error("Room source unavailable")));
    assert.equal(document.querySelector(".rooms-chat-empty button"), null);
    assert.doesNotMatch(
      document.querySelector("main")!.textContent!,
      /Create a room/,
    );
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Room source unavailable/,
    );
    const recoveredSdk = {
      ...sdk,
      commands: {
        ...sdk.commands,
        execute: async (command: string) => {
          assert.equal(command, "list");
          return { rooms: [] };
        },
      },
    } as unknown as PluginUiSdkV1;
    await act(async () =>
      root.render(React.createElement(RoomsPage, { sdk: recoveredSdk })),
    );
    assert.ok(document.querySelector('[role="alert"]') === null);
    assert.equal(
      document.querySelector(".rooms-chat-empty button")?.textContent,
      "New Room",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

for (const scenario of [
  "missing requested Room",
  "existing Rooms without selection",
] as const) {
  test(`${scenario} is not an empty creation state`, async () => {
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
    const sdk = {
      context: {
        route: `/plugins/zenx-rooms/rooms${scenario === "missing requested Room" ? "?roomId=missing" : ""}`,
        primaryNavigation: true,
      },
      commands: {
        execute: async (command: string) => {
          assert.equal(command, "list");
          return {
            rooms:
              scenario === "missing requested Room"
                ? []
                : [
                    {
                      id: "existing",
                      name: "Existing Room",
                      members: [],
                      messages: [],
                      createdAt: 0,
                    },
                  ],
          };
        },
      },
    } as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk })),
      );
      assert.equal(document.querySelector(".rooms-chat-empty button"), null);
      assert.doesNotMatch(
        document.querySelector("main")!.textContent!,
        /Create a room/,
      );
      assert.match(
        document.querySelector("main")!.textContent!,
        scenario === "missing requested Room"
          ? /Rooms are unavailable/
          : /Select a room/,
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}

for (const dismissal of ["Close", "Escape"]) {
  test(`unknown Room creation preserves empty entry, warning and focus after ${dismissal}`, async () => {
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
    let creates = 0;
    const sdk = {
      context: { route: "/plugins/zenx-rooms/rooms", primaryNavigation: true },
      commands: {
        execute: async (command: string) => {
          if (command === "list") return { rooms: [] };
          if (command === "create") {
            creates++;
            throw Error("Creation response lost");
          }
          throw Error(command);
        },
      },
    } as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk })),
      );
      const entry = document.querySelector<HTMLButtonElement>(
        ".rooms-chat-empty button",
      )!;
      entry.focus();
      await act(async () => entry.click());
      for (const [label, value] of [
        ["Room name", "New room"],
        ["Member name", "Member"],
      ]) {
        await act(async () => {
          const input = [...document.querySelectorAll("label")]
            .find((node) => node.querySelector("span")?.textContent === label)!
            .querySelector("input")!;
          Object.getOwnPropertyDescriptor(
            dom.window.HTMLInputElement.prototype,
            "value",
          )!.set!.call(input, value);
          input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
      }
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
      const submit = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent === "Create Room")!;
      assert.equal(submit.disabled, false);
      await act(async () => submit.click());
      assert.equal(creates, 1);
      assert.match(
        document.querySelector('[role="dialog"]')!.textContent!,
        /Result unknown; refresh before repeating/,
      );
      if (dismissal === "Close") {
        await act(async () =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              '[role="dialog"] button',
            ),
          ]
            .find((button) => button.textContent === "Close")!
            .click(),
        );
      } else {
        await act(async () =>
          document.querySelector('[role="dialog"]')!.dispatchEvent(
            new dom.window.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
            }),
          ),
        );
      }
      await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
      assert.ok(
        document.querySelector(".rooms-chat-empty button") === entry,
        "mutation failure must not retire the healthy empty entry",
      );
      assert.equal(document.activeElement, entry);
      assert.doesNotMatch(
        document.querySelector("main")!.textContent!,
        /Rooms are unavailable/,
      );
      assert.match(
        document.querySelector('main [role="alert"]')!.textContent!,
        /Result unknown; refresh before repeating/,
      );
      await act(async () => entry.click());
      assert.equal(
        creates,
        1,
        "opening the form never retries unknown creation",
      );
      assert.match(
        document.querySelector('[role="dialog"]')!.textContent!,
        /Result unknown; refresh before repeating/,
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}

for (const latestState of ["loaded", "loading"] as const) {
  test(`retired Rooms read rejection cannot replace newer ${latestState} state`, async () => {
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
    let rejectOld!: (reason: Error) => void;
    let resolveNew!: (result: unknown) => void;
    const oldRead = new Promise((_, reject) => {
      rejectOld = reject;
    });
    const newRead = new Promise((resolve) => {
      resolveNew = resolve;
    });
    const sdk = (read: Promise<unknown>) =>
      ({
        context: {
          route: "/plugins/zenx-rooms/rooms",
          primaryNavigation: true,
        },
        commands: {
          execute: async (command: string) => {
            assert.equal(command, "list");
            return read;
          },
        },
      }) as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk: sdk(oldRead) })),
      );
      await act(async () =>
        root.render(React.createElement(RoomsPage, { sdk: sdk(newRead) })),
      );
      if (latestState === "loaded")
        await act(async () => resolveNew({ rooms: [] }));
      await act(async () => rejectOld(Error("Stale source failure")));
      assert.ok(document.querySelector('[role="alert"]') === null);
      if (latestState === "loading") {
        assert.match(
          document.querySelector('[role="status"]')!.textContent!,
          /Loading rooms/,
        );
        assert.equal(document.querySelector(".rooms-chat-empty button"), null);
        await act(async () => resolveNew({ rooms: [] }));
      }
      assert.equal(
        document.querySelector(".rooms-chat-empty button")?.textContent,
        "New Room",
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}

for (const dismissal of ["Close", "Escape"]) {
  for (const target of [
    "primary rail",
    "local rail",
    "main",
    "recovered entry",
    "disabled primary rail",
    "hidden primary rail",
  ] as const) {
    test(`Rooms read failure restores focus to ${target} after ${dismissal}`, async () => {
      const rail = target.includes("primary rail")
        ? `<section class="room-conversation-group" ${target === "hidden primary rail" ? "hidden" : ""}><button class="room-conversation-create" ${target === "disabled primary rail" ? "disabled" : ""}>New room</button><div id="sidebar-room-conversations"></div></section>`
        : "";
      const dom = new JSDOM(`${rail}<div id="root"></div>`, {
        url: "http://localhost",
        pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        React,
        IS_REACT_ACT_ENVIRONMENT: true,
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(
          dom.window,
        ),
      });
      Object.assign(window, { zenx: { threads: { list: async () => [] } } });
      const sdk = (fail = false) =>
        ({
          context: {
            route: "/plugins/zenx-rooms/rooms",
            primaryNavigation: target !== "local rail",
          },
          commands: {
            execute: async (command: string) => {
              assert.equal(command, "list", "opening/dismissing never creates");
              if (fail) throw Error("Current Room read failed");
              return { rooms: [] };
            },
          },
        }) as unknown as PluginUiSdkV1;
      const root = createRoot(document.getElementById("root")!);
      try {
        await act(async () =>
          root.render(React.createElement(RoomsPage, { sdk: sdk() })),
        );
        const entry = document.querySelector<HTMLButtonElement>(
          ".rooms-chat-empty button",
        )!;
        entry.focus();
        await act(async () => entry.click());
        await act(async () =>
          root.render(React.createElement(RoomsPage, { sdk: sdk(true) })),
        );
        assert.equal(entry.isConnected, false);
        assert.match(
          document.querySelector("main")!.textContent!,
          /Rooms are unavailable.*Current Room read failed/,
        );
        if (target === "recovered entry")
          await act(async () =>
            root.render(React.createElement(RoomsPage, { sdk: sdk() })),
          );
        if (dismissal === "Close") {
          await act(async () =>
            [
              ...document.querySelectorAll<HTMLButtonElement>(
                '[role="dialog"] button',
              ),
            ]
              .find((button) => button.textContent === "Close")!
              .click(),
          );
        } else {
          await act(async () =>
            document.querySelector('[role="dialog"]')!.dispatchEvent(
              new dom.window.KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
              }),
            ),
          );
        }
        await new Promise((resolve) =>
          dom.window.requestAnimationFrame(resolve),
        );
        const expected = document.querySelector(
          target === "primary rail"
            ? ".room-conversation-create"
            : target === "local rail"
              ? ".rooms-chat-list-head button"
              : target === "recovered entry"
                ? ".rooms-chat-empty button"
                : "main",
        );
        assert.ok(
          expected && document.activeElement === expected,
          `focus should return to live ${target}`,
        );
        if (expected?.tagName === "MAIN") {
          assert.equal(expected.getAttribute("tabindex"), "-1");
          assert.equal(expected.getAttribute("aria-label"), "Rooms");
        }
        if (target !== "recovered entry") {
          assert.match(
            document.querySelector("main")!.textContent!,
            /Rooms are unavailable.*Current Room read failed/,
          );
          assert.equal(
            document.querySelector(".rooms-chat-empty button"),
            null,
          );
        }
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    });
  }
}
