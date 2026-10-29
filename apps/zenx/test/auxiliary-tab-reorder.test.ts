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

test("workspace tab keyboard moves preserve selection, mounted drafts and resource descriptors without a reorder menu", async () => {
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
    assert.ok(
      document.activeElement === tab("custom:a"),
      "reordered tab keeps keyboard focus",
    );
    assert.ok(
      document.querySelector('[aria-label="Draft a"]') === draft,
      "draft input stays mounted",
    );
    assert.equal(draft.value, "unsaved local text");
    assert.equal(
      state.tabs[2],
      resource,
      "reorder keeps the original resource descriptor",
    );
    assert.ok(
      document.querySelector(".workspace-tab-reorder-menu") === null,
      "reorder-only menu is absent",
    );
    assert.ok(
      document.querySelector('[aria-label="Reorder A"]') === null,
      "reorder-only trigger is absent",
    );
    assert.equal(
      tab("custom:a").getAttribute("aria-description"),
      "Drag to reorder, or use Alt+Left/Right.",
    );
    await act(async () =>
      tab("custom:a").dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          altKey: true,
          bubbles: true,
        }),
      ),
    );
    assert.deepEqual(state.tabs.map(sidebarTabId), [
      "custom:a",
      "custom:b",
      "file:@member-original:notes.md",
    ]);
    assert.ok(
      document.activeElement === tab("custom:a"),
      "reordered tab keeps keyboard focus",
    );
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

test("direct pointer drag scrolls narrow overflow, preserves selected content, and safely repeats after cancellation", async () => {
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
  const selections: string[] = [];
  const closed: string[] = [];
  let changeOwner!: (id: string) => void;
  let changeRevision!: (revision: number) => void;
  const writeRevisions: number[] = [];
  function Harness() {
    const [ids, update] = useState([
      "custom:a",
      "custom:b",
      "custom:c",
      "custom:d",
    ]);
    const [owner, setOwner] = useState("thread-a");
    const [revision, setRevision] = useState(1);
    changeOwner = setOwner;
    changeRevision = setRevision;
    return React.createElement(AuxiliaryPanel, {
      threadId: owner,
      title: "Synthetic",
      open: true,
      onOpenChange() {},
      snapshot: null,
      selectedTab: "custom:b",
      onSelectTab(id) {
        selections.push(id);
      },
      onRemoveTab(id) {
        closed.push(id);
      },
      openedTabs: ids,
      onTabsChange: (next: string[]) => {
        writes.push(next);
        writeRevisions.push(revision);
        update(next);
      },
      customTabs: ["a", "b", "c", "d"].map((id) => ({
        id,
        title: id,
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
  const tab = (id: string) => document.getElementById(`aux-tab-custom:${id}`)!;
  const row = (id: string) =>
    tab(id).closest<HTMLElement>(".workspace-content-tab")!;
  const rows = () => [
    ...document.querySelectorAll<HTMLElement>(".workspace-content-tab"),
  ];
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  async function tick() {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  }
  let scroll = 0;
  const proto = dom.window.HTMLElement.prototype;
  const originalRect = proto.getBoundingClientRect;
  Object.defineProperties(proto, {
    clientWidth: {
      configurable: true,
      get() {
        return this.getAttribute("role") === "tablist" ? 200 : 0;
      },
    },
    scrollWidth: {
      configurable: true,
      get() {
        return this.getAttribute("role") === "tablist"
          ? 376 +
              parseFloat(
                this.style.getPropertyValue("--workspace-tab-end-gap") || "0",
              )
          : 0;
      },
    },
    scrollLeft: {
      configurable: true,
      get() {
        return this.getAttribute("role") === "tablist" ? scroll : 0;
      },
      set(value) {
        if (this.getAttribute("role") === "tablist")
          scroll = Math.max(0, Math.min(value, this.scrollWidth - 200));
      },
    },
  });
  proto.getBoundingClientRect = function () {
    if (this.getAttribute("role") === "tablist")
      return {
        left: 100,
        right: 300,
        top: 0,
        bottom: 34,
        width: 200,
        height: 34,
      } as DOMRect;
    if (this.classList.contains("workspace-content-tab")) {
      const left = 102 + rows().indexOf(this) * 94 - scroll;
      return {
        left,
        right: left + 90,
        top: 2,
        bottom: 32,
        width: 90,
        height: 30,
      } as DOMRect;
    }
    return originalRect.call(this);
  };
  async function pointer(
    target: EventTarget,
    type: string,
    x = 130,
    y = 15,
    pointerId = 1,
  ) {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.assign(event, { pointerId, pointerType: "mouse" });
    await act(async () => target.dispatchEvent(event));
  }
  const clean = () => {
    assert.ok(
      document.querySelector("[data-drop-placement]") === null,
      "drop feedback is cleared",
    );
    assert.ok(
      document.querySelector("[data-dragging]") === null,
      "drag feedback is cleared",
    );
    assert.equal(
      frames.size,
      0,
      "no edge-scroll animation survives completion/cancellation",
    );
  };
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const draft = document.querySelector<HTMLInputElement>(
      '[aria-label="Draft b"]',
    )!;
    draft.value = "keep my unsent input";
    await pointer(window, "pointermove", 280);
    await pointer(window, "pointerup", 280);
    assert.equal(
      writes.length,
      0,
      "external pointer operations never reorder tabs",
    );

    await pointer(tab("a"), "pointerdown");
    await pointer(window, "pointermove", 133);
    assert.ok(
      document.querySelector("[data-dragging]") === null,
      "small clicks are not drags",
    );
    await pointer(window, "pointercancel");
    clean();

    for (const cancellation of [
      "pointercancel",
      "lostpointercapture",
      "Escape",
      "blur",
      "outside",
      "owner",
    ]) {
      await pointer(tab("a"), "pointerdown");
      await pointer(window, "pointermove", 280);
      assert.equal(row("b").dataset.dropPlacement, "after");
      assert.equal(writes.length, 0, "order stays fixed until release");
      if (cancellation === "Escape") {
        await act(async () =>
          window.dispatchEvent(
            new window.KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
            }),
          ),
        );
      } else if (cancellation === "blur") {
        await act(async () => window.dispatchEvent(new window.Event("blur")));
      } else if (cancellation === "outside") {
        await pointer(window, "pointerup", 280, 90);
      } else if (cancellation === "owner") {
        await act(async () => changeOwner("thread-other"));
      } else {
        await pointer(
          cancellation === "lostpointercapture" ? tab("a") : window,
          cancellation,
        );
      }
      await pointer(window, "pointerup", 280);
      clean();
      assert.equal(writes.length, 0, `${cancellation} never commits a reorder`);
    }

    await pointer(
      row("a").querySelector(".workspace-tab-close")!,
      "pointerdown",
    );
    await pointer(window, "pointermove", 280);
    await pointer(window, "pointerup", 280);
    clean();
    assert.equal(writes.length, 0, "close controls do not start a drag");

    await pointer(tab("a"), "pointerdown");
    await pointer(window, "pointermove", 299);
    for (let i = 0; i < 30; i += 1) await tick();
    assert.ok(
      scroll >= 176,
      "holding at the narrow rail edge reveals previously hidden tabs",
    );
    assert.equal(row("d").dataset.dropPlacement, "after");
    await act(async () => changeRevision(2));
    await pointer(window, "pointerup", 299);
    assert.deepEqual(
      writeRevisions,
      [2],
      "drop uses the latest owner callback, not a stale presentation revision",
    );
    assert.deepEqual(writes, [
      ["custom:b", "custom:c", "custom:d", "custom:a"],
    ]);
    clean();
    await act(async () =>
      tab("a").dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, detail: 1 }),
      ),
    );
    assert.deepEqual(
      selections,
      [],
      "release click never activates the dragged inactive tab",
    );
    assert.deepEqual(closed, []);
    assert.equal(tab("b").getAttribute("aria-selected"), "true");
    assert.ok(
      document.querySelector('[aria-label="Draft b"]') === draft,
      "selected draft input stays mounted",
    );
    assert.equal(draft.value, "keep my unsent input");

    // A second direct move uses the newly committed order, including the active tab.
    await pointer(tab("b"), "pointerdown");
    await pointer(window, "pointermove", 280);
    await pointer(window, "pointerup", 280);
    assert.deepEqual(writes[1], [
      "custom:c",
      "custom:b",
      "custom:d",
      "custom:a",
    ]);
    clean();
    assert.equal(tab("b").getAttribute("aria-selected"), "true");
    assert.ok(
      document.querySelector('[aria-label="Draft b"]') === draft,
      "selected draft input stays mounted",
    );
    assert.equal(draft.value, "keep my unsent input");

    // Normal clicks after a drag remain ordinary selection rather than stale suppression.
    await pointer(tab("c"), "pointerdown");
    await pointer(window, "pointerup");
    await act(async () =>
      tab("c").dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, detail: 1 }),
      ),
    );
    assert.deepEqual(selections, ["custom:c"]);
    assert.equal(writes.length, 2);

    await pointer(tab("b"), "pointerdown", 225);
    await pointer(window, "pointermove", 299);
    await act(async () => root.unmount());
    assert.equal(frames.size, 0, "unmount cancels edge scrolling");
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
