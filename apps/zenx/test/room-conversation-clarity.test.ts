import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  RoomMessageSource,
  roomSenderName,
} from "../src/renderer/src/RoomMessageSource.js";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { RoomMessage } from "../src/main/trigger-types.js";

const message: RoomMessage = {
  id: "message",
  roomId: "room",
  author: "Agent",
  kind: "agent",
  text: "@Recipient this is not the author",
  createdAt: 1,
  originThreadId: null,
  originTurnId: null,
};

async function domTest(
  run: (root: ReturnType<typeof createRoot>) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  await i18n.changeLanguage("en");
  const root = createRoot(document.getElementById("root")!);
  try {
    await run(root);
  } finally {
    await act(async () => root.unmount());
    await i18n.changeLanguage("en");
    dom.window.close();
  }
}

test("sender header is one meaningful name and source navigation appears only on demand", async () => {
  await domTest(async (root) => {
    const routes: string[] = [];
    const source = { ...message, originThreadId: "source /中" };
    const rooms = [
      {
        id: "paw ?中",
        name: "Research PAW",
        assistant: { threadId: "source /中", triggerId: "wake" },
      },
    ];
    const render = async (value: RoomMessage, paws = rooms) => {
      await act(async () =>
        root.render(
          React.createElement(RoomMessageSource, {
            message: value,
            members: [{ name: "Researcher", threadId: "source /中" }],
            rooms: paws,
            threads: [],
            navigate: (route) => routes.push(route),
          }),
        ),
      );
    };
    await render(source);
    assert.equal(document.body.textContent, "Researcher");
    assert.equal(document.querySelectorAll("button").length, 1);
    const name =
      document.querySelector<HTMLButtonElement>(".room-sender-name")!;
    await act(async () => name.click());
    assert.equal(name.getAttribute("aria-expanded"), "true");
    const popup = document.querySelector<HTMLElement>(".room-sender-profile")!;
    assert.doesNotMatch(popup.textContent!, /source \/中/);
    assert.match(popup.textContent!, /Linked PAW · Research PAW/);
    await act(async () =>
      popup.querySelector<HTMLButtonElement>(".room-source-link")!.click(),
    );
    assert.equal(routes[0], "/threads/source%20%2F%E4%B8%AD");
    await act(async () => name.click());
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".room-sender-profile button",
        ),
      ]
        .find((button) => button.textContent?.includes("Linked PAW"))!
        .click(),
    );
    assert.equal(
      new URL(routes[1]!, "https://zenx.local").searchParams.get("roomId"),
      "paw ?中",
    );
    await render(source, [
      ...rooms,
      { ...rooms[0]!, id: "other", name: "Other PAW" },
    ]);
    assert.equal(
      document.body.textContent,
      "Researcher",
      "current PAW associations do not replace the actual sender",
    );
    await render(message);
    assert.equal(document.body.textContent, "Unknown member");
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".room-sender-name")!.click(),
    );
    assert.match(
      document.querySelector(".room-sender-profile")!.textContent!,
      /source conversation was not saved/,
    );
    assert.equal(
      document.querySelectorAll(".room-sender-profile button").length,
      0,
    );
  });
});

test("sender name resolution never guesses from mentions or unrelated PAW bindings", async () => {
  await i18n.changeLanguage("en");
  const members = [{ name: "Member name", threadId: "source" }];
  await i18n.changeLanguage("zh-CN");
  assert.equal(
    roomSenderName({ ...message, author: "You", kind: "human" }, [], []),
    "你",
  );
  assert.equal(
    roomSenderName({ ...message, author: "You", kind: "agent" }, [], []),
    "You",
  );
  await i18n.changeLanguage("en");
  const threads: any[] = [{ threadId: "source", name: "Working conversation" }];
  assert.equal(roomSenderName(message, members, threads), "Unknown member");
  assert.equal(
    roomSenderName({ ...message, author: "Recorded author" }, members, threads),
    "Recorded author",
  );
  assert.equal(
    roomSenderName({ ...message, originThreadId: "source" }, members, threads),
    "Member name",
  );
  assert.equal(
    roomSenderName({ ...message, originThreadId: "source" }, [], threads),
    "Working conversation",
  );
  assert.equal(
    roomSenderName({ ...message, originThreadId: "missing" }, members, threads),
    "Unnamed conversation",
  );
  assert.equal(
    roomSenderName(
      { ...message, originThreadId: "source" },
      [],
      [{ threadId: "source", preview: "@Recipient", name: "" } as any],
    ),
    "Unnamed conversation",
  );
});

test("64-member reply details are on demand in settings, accurate for disabled replies, and keep legacy identity honest", async () => {
  await domTest(async (root) => {
    const calls: string[] = [];
    const room = {
      id: "room",
      name: "Team",
      createdAt: 0,
      messages: [message],
      members: Array.from({ length: 64 }, (_, index) => ({
        name: `Member ${index}`,
        threadId: `thread-${index}`,
      })),
      responders: Array.from({ length: 64 }, (_, index) => ({
        name: `Member ${index}`,
        configured: index === 63,
      })),
    };
    const sdk: any = {
      context: {},
      navigation: { navigate: (route: string) => calls.push(route) },
      commands: {
        execute: async (id: string) => {
          calls.push(id);
          if (id === "list") return { rooms: [room] };
          throw Error(id);
        },
      },
    };
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    assert.equal(document.querySelector(".room-setup-note"), null);
    assert.equal(document.querySelector(".rooms-chat-status"), null);
    const settings = document.querySelector<HTMLButtonElement>(
      '[aria-label="Conversation settings"]',
    )!;
    assert.match(settings.title, /63 members/);
    assert.ok(settings.querySelector(".room-header-status-dot"));
    assert.doesNotMatch(
      document.querySelector(".rooms-chat-header")!.textContent!,
      /63 members|Member 0/,
    );
    assert.match(
      document.querySelector(".room-composer-note")!.textContent!,
      /choose a room member/,
    );
    assert.equal(
      document.querySelector(".room-message header strong")!.textContent,
      "Unknown member",
    );
    assert.equal(document.querySelector(".room-message-source"), null);
    await act(async () => settings.click());
    const notice = document.querySelector<HTMLDetailsElement>(
      '[role="dialog"][aria-label="Conversation settings"] .room-setup-note',
    )!;
    assert.ok(notice);
    assert.equal(notice.open, false);
    assert.match(notice.querySelector("summary")!.textContent!, /63 members/);
    await act(async () => notice.querySelector("summary")!.click());
    assert.equal(notice.open, true);
    const details = notice.querySelector<HTMLElement>(
      ".room-setup-settings-content",
    )!;
    assert.match(details.textContent!, /unconfigured, paused, or disabled/);
    assert.equal(details.querySelectorAll("li").length, 63);
    assert.equal(
      document.querySelector(".rooms-chat-main .room-setup-note"),
      null,
    );
    assert.equal(document.querySelector(".rooms-chat-status"), null);
    await act(async () => details.querySelector("button")!.click());
    const route = calls.find((entry) => entry.startsWith("/plugins/"))!;
    assert.equal(
      new URL(route, "https://zenx.local").searchParams.get("threadId"),
      "thread-0",
    );
    assert(
      calls.every((entry) => entry === "list" || entry.startsWith("/plugins/")),
      "viewing the notice cannot enable replies",
    );
    await act(async () => i18n.changeLanguage("zh-CN"));
    assert.match(
      notice.querySelector("summary")!.textContent!,
      /63 位成员的自动回复未启用/,
    );
    assert.equal(
      document.querySelector(".room-message header strong")!.textContent,
      "未知成员",
    );
  });
});
