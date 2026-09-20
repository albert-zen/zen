import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import type { WorkspaceBrowserTab } from "../src/main/workspace-browser.js";

test("shared browser pages are peer workspace tabs and the type picker unmounts the native view", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  const mounts: { tabId?: string }[] = [];
  const page = (id: string): WorkspaceBrowserTab => ({
    id,
    threadId: "a",
    title: `Page ${id}`,
    url: `https://example.com/${id}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sharedWithAgent: true,
  });
  let pages = [page("1")];
  let changed: (value: {
    threadId: string;
    tabs: WorkspaceBrowserTab[];
  }) => void = () => undefined;
  (dom.window as any).zenx = {
    workspaceBrowser: {
      onChanged: (listener: typeof changed) => {
        changed = listener;
        return () => {
          changed = () => undefined;
        };
      },
      onFocusAddress: () => () => undefined,
      mount: async (request: { tabId?: string }) => {
        mounts.push(request);
      },
      command: async (_threadId: string, command: string, id?: string) => {
        if (command === "new") pages = [...pages, page("2")];
        if (command === "close") pages = pages.filter((tab) => tab.id !== id);
        if (command !== "list") changed({ threadId: "a", tabs: pages });
        return pages;
      },
    },
    plugins: {},
  };
  function Harness() {
    const [selectedTab, onSelectTab] = useState("");
    return React.createElement(AuxiliaryPanel, {
      threadId: "a",
      title: "Task",
      open: true,
      onOpenChange: () => undefined,
      snapshot: null,
      selectedTab,
      onSelectTab,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const button = (name: string) =>
    document.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;
  const tabs = () => [
    ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.deepEqual(
      tabs().map((tab) => tab.textContent),
      ["Page 1"],
    );
    assert.equal(document.querySelectorAll('[role="tablist"]').length, 1);
    assert.equal(document.querySelector(".workspace-browser-tabs"), null);
    assert.equal(mounts.at(-1)?.tabId, "1");
    await act(async () => button("New workspace tab").click());
    assert.equal(mounts.at(-1)?.tabId, undefined);
    const browser = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".workspace-tab-types button",
      ),
    ].find((e) => e.querySelector("strong")?.textContent === "Browser")!;
    await act(async () => browser.click());
    assert.deepEqual(
      tabs().map((tab) => tab.textContent),
      ["Page 1", "Page 2"],
    );
    assert.equal(mounts.at(-1)?.tabId, "2");
    await act(async () => {
      pages = [...pages, page("3")];
      changed({ threadId: "a", tabs: pages });
    });
    assert.equal(
      tabs().find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.textContent,
      "Page 2",
    );
    await act(async () => tabs()[0]!.click());
    assert.equal(mounts.at(-1)?.tabId, "1");
    await act(async () => button("Close tab Page 1").click());
    assert.deepEqual(
      tabs().map((tab) => tab.textContent),
      ["Page 2", "Page 3"],
    );
    assert.equal(mounts.at(-1)?.tabId, "2");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    delete (globalThis as any).ResizeObserver;
  }
});
