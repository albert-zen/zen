import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

async function withRooms(
  run: (context: {
    dom: JSDOM;
    calls: Array<{ id: string; input: any }>;
    input(text: string, caret?: number): Promise<void>;
    key(key: string, extra?: KeyboardEventInit): Promise<KeyboardEvent>;
    click(label: string): Promise<void>;
    textarea(): HTMLTextAreaElement;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
  });
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => {},
    detachEvent: () => {},
    scrollIntoView: () => {},
  });
  const calls: Array<{ id: string; input: any }> = [];
  const rooms = [
    {
      id: "one",
      name: "团队",
      members: [
        { name: "Bot", threadId: "bot" },
        { name: "设计师", threadId: "designer" },
      ],
      messages: [],
      createdAt: 0,
    },
    {
      id: "two",
      name: "Second",
      members: [{ name: "Other", threadId: "other" }],
      messages: [],
      createdAt: 0,
    },
  ];
  const sdk = {
    commands: {
      execute: async (id: string, input: any) => {
        calls.push({ id, input });
        if (id === "list") return { rooms: structuredClone(rooms) };
        if (id === "prepare-message") return {};
        if (id === "post-message") return { messageId: "saved" };
        if (id === "operation")
          return { state: "saved", messageId: "saved", mentions: [] };
        if (id === "ack-operation") return {};
        throw Error(`Unexpected ${id}`);
      },
    },
    navigation: { navigate: () => {} },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  const textarea = () =>
    document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
  const click = async (label: string) =>
    act(async () => {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find(
        (x) =>
          x.getAttribute("aria-label") === label ||
          x.textContent?.trim() === label,
      );
      assert(button, `Missing button ${label}`);
      button.click();
    });
  const input = async (text: string, caret = text.length) =>
    act(async () => {
      const element = textarea();
      element.focus();
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(element, text);
      element.setSelectionRange(caret, caret);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  const key = async (value: string, extra: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    await act(async () => {
      textarea().dispatchEvent(event);
    });
    return event;
  };
  try {
    await act(async () => root.render(React.createElement(RoomsPage, { sdk })));
    await run({ dom, calls, textarea, click, input, key });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}

test("Room reuses the autogrowing composer and selects literal members without sending", async () => {
  await withRooms(async ({ input, key, textarea, calls }) => {
    assert(textarea().closest(".composer"));
    assert.equal(textarea().dataset.autogrow, "true");
    await input("Ask @Bo after", 7);
    const list = document.querySelector(
      '[role="listbox"][aria-label="Room members"]',
    );
    assert(list);
    assert.ok(
      list.closest(".rooms-chat-compose") === null,
      "suggestions escape clipped composer containers",
    );
    assert.match(list.textContent ?? "", /@Bot/);
    assert.equal((await key("Enter")).defaultPrevented, true);
    assert.equal(textarea().value, "Ask @Bot after");
    assert.equal(textarea().selectionStart, 9);
    assert.ok(document.activeElement === textarea(), "composer keeps focus");
    assert.ok(
      document.querySelector('[role="listbox"]') === null,
      "suggestions are closed",
    );
    assert(calls.every((x) => x.id === "list"));
    await key("Enter");
    assert.equal(calls.filter((x) => x.id === "post-message").length, 1);
    assert.equal(
      calls.find((x) => x.id === "post-message")?.input.text,
      "Ask @Bot after",
    );
  });
});

test("Room member tool creates a valid boundary after Chinese text and pointer selection preserves focus", async () => {
  await withRooms(async ({ input, click, textarea, calls }) => {
    await input("草稿");
    await click("Mention a room member");
    assert.equal(textarea().value, "草稿 @");
    const option = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ].find((x) => x.textContent?.includes("@Bot"));
    assert(option);
    await act(async () => {
      option.dispatchEvent(
        new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      option.click();
    });
    assert.equal(textarea().value, "草稿 @Bot ");
    assert.ok(document.activeElement === textarea(), "composer keeps focus");
    assert.match(textarea().value, /(^|\s)@Bot(?=\s|$|[,.!?])/u);
    assert(calls.every((x) => x.id === "list"));
  });
});

test("Room suggestions honor IME, empty results, Escape, repeated Enter and room draft isolation", async () => {
  await withRooms(async ({ input, key, click, textarea, calls }) => {
    await input("@not-a-member");
    await key("Enter");
    assert(calls.every((x) => x.id === "list"));
    await key("Escape");
    assert.ok(
      document.querySelector('[role="listbox"]') === null,
      "suggestions are closed",
    );
    await input("@Bo");
    await key("Enter", { isComposing: true });
    await key("Enter", { repeat: true });
    assert.equal(textarea().value, "@Bo");
    await click("#SecondNo messages yet");
    assert.equal(textarea().value, "");
    assert.ok(
      document.querySelector('[role="listbox"]') === null,
      "suggestions are closed",
    );
    await input("@Ot");
    await key("Tab");
    assert.equal(textarea().value, "@Other ");
    await click("#团队No messages yet");
    assert.equal(textarea().value, "@Bo");
    assert.doesNotMatch(
      document.querySelector('[role="listbox"]')?.textContent ?? "",
      /@Other/,
    );
    assert(calls.every((x) => x.id === "list"));
  });
});

test("Room suggestions close on outside focus or pointer and never send", async () => {
  await withRooms(async ({ input, calls }) => {
    const outside = document.createElement("button");
    document.body.append(outside);
    await input("@Bo");
    assert(document.querySelector('[role="listbox"]'));
    await act(async () => outside.focus());
    assert.ok(document.querySelector('[role="listbox"]') === null);
    await input("@B");
    assert(document.querySelector('[role="listbox"]'));
    await act(async () =>
      outside.dispatchEvent(new window.Event("pointerdown", { bubbles: true })),
    );
    assert.ok(document.querySelector('[role="listbox"]') === null);
    assert(calls.every((x) => x.id === "list"));
    outside.remove();
  });
});

test("Room keyboard navigation selects Unicode member names as literal addressing tokens", async () => {
  await withRooms(async ({ input, key, textarea, calls }) => {
    await input("@");
    await key("ArrowDown");
    const activeId = textarea().getAttribute("aria-activedescendant");
    assert(activeId);
    assert.match(
      document.getElementById(activeId)?.textContent ?? "",
      /设计师/u,
    );
    await key("Enter");
    assert.equal(textarea().value, "@设计师 ");
    assert(calls.every((x) => x.id === "list"));
    await input("Contact me@example.com");
    assert.ok(document.querySelector('[role="listbox"]') === null);
  });
});
