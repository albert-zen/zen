import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CollapsedWorkspaceTabsPreview } from "../src/renderer/src/CollapsedWorkspaceTabsPreview.js";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";

function setup() {
  const dom = new JSDOM(
    '<button id="thread-browser-toggle" data-workspace-owner="owner-a" aria-describedby="existing">Workspace</button><span id="existing">Existing help</span><div id="root"></div>',
    { url: "https://zenx.local/", pretendToBeVisual: true },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (window as any).zenx = {};
  return {
    dom,
    root: createRoot(document.getElementById("root")!),
    trigger: document.getElementById("thread-browser-toggle")!,
  };
}
const tabs = [
  { id: "custom:first", title: "First opened tab", icon: "file" as const },
  { id: "custom:second", title: "Second opened tab", icon: "browser" as const },
];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("focus, arrows and Escape preview exact existing tabs without changing toggle semantics", async () => {
  const { dom, root, trigger } = setup();
  const selected: string[] = [];
  try {
    await act(async () =>
      root.render(
        React.createElement(CollapsedWorkspaceTabsPreview, {
          tabs,
          ownerId: "owner-a",
          activate: (id) => selected.push(id),
          label: "Open tabs",
        }),
      ),
    );
    assert.equal(document.querySelector('[role="region"]'), null);
    await act(async () => trigger.focus());
    assert.equal(trigger.getAttribute("aria-describedby"), "existing");
    assert.deepEqual(
      [
        ...document.querySelectorAll(
          ".collapsed-workspace-tabs-preview button",
        ),
      ].map((x) => x.textContent),
      tabs.map((x) => x.title),
    );
    await act(async () =>
      trigger.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(document.activeElement?.textContent, tabs[0]!.title);
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(document.activeElement?.textContent, tabs[1]!.title);
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(document.querySelector('[role="region"]'), null);
    assert.equal(document.activeElement, trigger);
    assert.deepEqual(selected, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("pointer can cross the gap, leave dismisses and removed tabs never survive in the preview", async () => {
  const { dom, root, trigger } = setup();
  const selected: string[] = [];
  const render = (items = tabs) =>
    root.render(
      React.createElement(CollapsedWorkspaceTabsPreview, {
        tabs: items,
        ownerId: "owner-a",
        activate: (id) => selected.push(id),
        label: "Open tabs",
      }),
    );
  try {
    await act(async () => render());
    await act(async () => {
      trigger.dispatchEvent(new window.Event("pointerenter"));
      await pause(220);
    });
    const popup = document.querySelector<HTMLElement>(
      ".collapsed-workspace-tabs-preview",
    )!;
    assert.ok(popup);
    await act(async () => {
      trigger.dispatchEvent(new window.Event("pointerleave"));
      popup.dispatchEvent(new window.Event("pointerover", { bubbles: true }));
      await pause(200);
    });
    assert.ok(document.querySelector(".collapsed-workspace-tabs-preview"));
    await act(async () => render(tabs.slice(1)));
    assert.equal(
      document.querySelectorAll(".collapsed-workspace-tabs-preview button")
        .length,
      1,
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".collapsed-workspace-tabs-preview button",
        )!
        .click(),
    );
    assert.deepEqual(selected, ["custom:second"]);
    await act(async () => {
      trigger.dispatchEvent(new window.Event("pointerenter"));
      await pause(220);
    });
    await act(async () => {
      document
        .querySelector(".collapsed-workspace-tabs-preview")!
        .dispatchEvent(new window.Event("pointerout", { bubbles: true }));
      await pause(200);
    });
    assert.equal(
      document.querySelector(".collapsed-workspace-tabs-preview"),
      null,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("AuxiliaryPanel preview activates an existing tab, opens and focuses it without changing the tab list", async () => {
  const { dom, root, trigger } = setup();
  const selections: string[] = [];
  const orders: string[][] = [];
  function Harness() {
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState("custom:first");
    return React.createElement(AuxiliaryPanel, {
      threadId: "owner-a",
      title: "Synthetic owner",
      open,
      onOpenChange: setOpen,
      snapshot: null,
      openedTabs: tabs.map((x) => x.id),
      onTabsChange: (ids) => orders.push(ids),
      selectedTab: selected,
      customTabs: tabs.map((x) => ({
        id: x.id.slice(7),
        title: x.title,
        icon: x.icon,
        render: () => React.createElement("div", null, x.title),
      })),
      onSelectTab: (id) => {
        selections.push(id);
        setSelected(id);
      },
      renderCollapsedTabPreview: (items, activate) =>
        React.createElement(CollapsedWorkspaceTabsPreview, {
          tabs: items,
          ownerId: "owner-a",
          activate,
          label: "Open tabs",
        }),
    });
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => trigger.focus());
    assert.equal(
      document.querySelectorAll(".collapsed-workspace-tabs-preview button")
        .length,
      2,
    );
    await act(async () =>
      document
        .querySelectorAll<HTMLButtonElement>(
          ".collapsed-workspace-tabs-preview button",
        )[1]!
        .click(),
    );
    assert.deepEqual(selections, ["custom:second"]);
    assert.equal(
      document.getElementById("thread-workspace-panel")!.dataset.open,
      "true",
    );
    assert.equal(document.activeElement?.id, "aux-tab-custom:second");
    assert.equal(
      document.querySelector(".collapsed-workspace-tabs-preview"),
      null,
    );
    assert.deepEqual(orders, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
