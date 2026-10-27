import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import {
  sidebarTabId,
  type ThreadSidebarState,
} from "../src/thread-sidebar-state.js";

test("workspace tab moves preserve selection, mounted drafts and resource descriptors; keyboard and click alternatives persist the same order", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (window as any).zenx = {};
  let state: ThreadSidebarState = {
    owner: { kind: "room", id: "room-a" },
    revision: 1,
    open: true,
    fullscreen: false,
    selectedTab: "custom:a",
    resourceThreadId: null,
    tabs: [
      { kind: "custom", id: "a" },
      { kind: "custom", id: "b" },
      { kind: "file", path: "notes.md", resourceThreadId: "member-original" },
    ],
  };
  const writes: string[][] = [];
  function Harness() {
    const [current, update] = useState(state);
    return React.createElement(AuxiliaryPanel, {
      conversationContext: { kind: "room", roomId: "room-a" },
      title: "Synthetic Room",
      open: true,
      onOpenChange() {},
      snapshot: null,
      presentationState: current,
      selectedTab: current.selectedTab!,
      onSelectTab: (selectedTab: string) => update({ ...current, selectedTab }),
      onTabsChange: (ids: string[]) => {
        writes.push(ids);
        state = {
          ...current,
          tabs: ids.map((id) =>
            current.tabs.find((tab) => sidebarTabId(tab) === id)!,
          ),
        };
        update(state);
      },
      customTabs: ["a", "b"].map((id) => ({
        id,
        title: id.toUpperCase(),
        icon: "file" as const,
        render: () =>
          React.createElement("input", {
            "aria-label": `Draft ${id}`,
            defaultValue: `draft-${id}`,
          }),
      })),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const tab = (id: string) => document.getElementById(`aux-tab-${id}`)!;
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const draft = document.querySelector<HTMLInputElement>(
      '[aria-label="Draft a"]',
    )!;
    draft.value = "unsaved local text";
    const resource = state.tabs[2];
    tab("custom:a").focus();
    await act(async () =>
      tab("custom:a").dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          altKey: true,
          bubbles: true,
        }),
      ),
    );
    assert.deepEqual(writes, [
      ["custom:b", "custom:a", "file:@member-original:notes.md"],
    ]);
    assert.equal(tab("custom:a").getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, tab("custom:a"));
    assert.equal(document.querySelector('[aria-label="Draft a"]'), draft);
    assert.equal(draft.value, "unsaved local text");
    assert.equal(
      state.tabs[2],
      resource,
      "reorder keeps the original resource descriptor",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Reorder A"]')!
        .click(),
    );
    const left = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes("Move left"))!;
    await act(async () => left.click());
    assert.deepEqual(state.tabs.map(sidebarTabId), [
      "custom:a",
      "custom:b",
      "file:@member-original:notes.md",
    ]);
    assert.equal(document.activeElement, tab("custom:a"));
    await act(async () =>
      tab("custom:a").dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          altKey: true,
          bubbles: true,
        }),
      ),
    );
    assert.equal(writes.length, 2, "moving beyond the first tab is a no-op");
    await act(async () =>
      tab("custom:a").dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }),
      ),
    );
    assert.equal(
      tab("custom:b").getAttribute("aria-selected"),
      "true",
      "ordinary arrows still select",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("drag insertion is bounded to this workspace and cancellation clears its feedback", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (window as any).zenx = {};
  const writes: string[][] = [];
  function Harness() {
    const [ids, update] = useState(["custom:a", "custom:b", "custom:c"]);
    return React.createElement(AuxiliaryPanel, {
      threadId: "thread-a",
      title: "Synthetic",
      open: true,
      onOpenChange() {},
      snapshot: null,
      selectedTab: "custom:b",
      onSelectTab() {},
      openedTabs: ids,
      onTabsChange: (next: string[]) => {
        writes.push(next);
        update(next);
      },
      customTabs: ["a", "b", "c"].map((id) => ({
        id,
        title: id,
        icon: "file" as const,
        render: () => null,
      })),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const row = (id: string) =>
    document
      .getElementById(`aux-tab-custom:${id}`)!
      .closest<HTMLElement>(".workspace-content-tab")!;
  const transfer = {
    effectAllowed: "",
    dropEffect: "",
    setData() {},
    getData() {
      return "";
    },
  };
  async function drag(id: string, type: string, x = 80) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer: transfer, clientX: x });
    await act(async () => row(id).dispatchEvent(event));
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    for (const id of ["a", "b", "c"])
      row(id).getBoundingClientRect = () =>
        ({ left: 0, width: 100 }) as DOMRect;
    await drag("c", "dragover");
    await drag("c", "drop");
    assert.equal(writes.length, 0, "external drags never reorder tabs");
    await drag("a", "dragstart");
    await drag("c", "dragover");
    assert.equal(row("c").dataset.dropPlacement, "after");
    await act(async () =>
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(document.querySelector("[data-drop-placement]"), null);
    await drag("c", "drop");
    assert.equal(writes.length, 0);
    await drag("a", "dragstart");
    await drag("c", "dragover");
    await drag("c", "drop");
    assert.deepEqual(writes, [["custom:b", "custom:c", "custom:a"]]);
    assert.equal(document.querySelector("[data-drop-placement]"), null);
    assert.equal(document.querySelector("[data-dragging]"), null);
    assert.equal(
      document
        .getElementById("aux-tab-custom:b")!
        .getAttribute("aria-selected"),
      "true",
    );
    await drag("a", "dragstart");
    await drag("b", "dragover", 10);
    await drag("a", "dragend");
    assert.equal(document.querySelector("[data-drop-placement]"), null);
    assert.equal(writes.length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("ephemeral side-chat tabs use the renderer order without becoming durable descriptors", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (window as any).zenx = {};
  let saved: string[] = [];
  let close: string | undefined;
  const presentation: ThreadSidebarState = {
    owner: { kind: "thread", id: "thread-a" },
    revision: 1,
    open: true,
    fullscreen: false,
    selectedTab: "custom:a",
    resourceThreadId: null,
    tabs: [
      { kind: "custom", id: "a" },
      { kind: "custom", id: "b" },
    ],
  };
  function Harness() {
    const [order, update] = useState([
      "custom:a",
      "custom:side-chat-draft-1",
      "custom:b",
    ]);
    return React.createElement(AuxiliaryPanel, {
      threadId: "thread-a",
      title: "Synthetic",
      open: true,
      onOpenChange() {},
      snapshot: null,
      presentationState: presentation,
      openedTabs: order,
      selectedTab: "custom:side-chat-draft-1",
      onSelectTab() {},
      onTabsChange: (next: string[]) => {
        update(next);
        saved = next.filter((id) => id !== "custom:side-chat-draft-1");
      },
      onRemoveTab: (id) => {
        close = id;
      },
      customTabs: ["a", "b", "side-chat-draft-1"].map((id) => ({
        id,
        title: id,
        icon: "file" as const,
        render: () => null,
      })),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const tab = document.getElementById("aux-tab-custom:side-chat-draft-1")!;
    assert.equal(tab.getAttribute("aria-selected"), "true");
    await act(async () =>
      tab.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          altKey: true,
          bubbles: true,
        }),
      ),
    );
    assert.deepEqual(
      [...document.querySelectorAll('[role="tab"]')].map((el) => el.id),
      [
        "aux-tab-custom:side-chat-draft-1",
        "aux-tab-custom:a",
        "aux-tab-custom:b",
      ],
    );
    assert.deepEqual(saved, ["custom:a", "custom:b"]);
    assert.equal(presentation.tabs.length, 2);
    await act(async () =>
      tab
        .closest(".workspace-content-tab")!
        .querySelector<HTMLButtonElement>(".workspace-tab-close")!
        .click(),
    );
    assert.equal(close, "custom:side-chat-draft-1");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("selecting an ephemeral draft does not materialize the first saved webpage", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // There is intentionally no Browser API: displaying an unsent draft must not use it.
  (window as any).zenx = {};
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        React.createElement(AuxiliaryPanel, {
          threadId: "thread-a",
          title: "Synthetic",
          open: true,
          onOpenChange() {},
          snapshot: null,
          selectedTab: "custom:side-chat-draft-1",
          onSelectTab() {},
          onReplaceTab() {},
          presentationState: {
            owner: { kind: "thread", id: "thread-a" },
            revision: 1,
            open: true,
            fullscreen: false,
            selectedTab: "webpage:saved",
            resourceThreadId: null,
            tabs: [
              { kind: "webpage", id: "saved", url: "https://example.invalid" },
            ],
          },
          customTabs: [
            {
              id: "side-chat-draft-1",
              title: "Draft",
              icon: "file",
              render: () => React.createElement("p", null, "Unsent"),
            },
          ],
        }),
      ),
    );
    assert.equal(
      document.querySelector('[aria-selected="true"]')?.textContent,
      "Draft",
    );
    assert.ok(
      document
        .querySelector('[role="tabpanel"]:not([hidden])')
        ?.textContent?.includes("Unsent"),
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
