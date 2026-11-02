import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import type { WorkspaceBrowserTab } from "../src/main/workspace-browser.js";
import {
  applySidebarPatch,
  emptySidebarState,
} from "../src/thread-sidebar-state.js";
import type { BrowserThreadEvent } from "../src/main/capabilities/browser-thread-observation.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

test("Chrome operations automatically present one exact preview; discovery and dismissal never create a native page", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const commands: string[] = [];
  const target = {
    id: "connected:chrome-page",
    sessionId: "chrome",
    tabId: "1",
    title: "Chrome reference",
    url: "https://example.test",
    backendId: "connected",
    mode: "live",
    loading: false,
  } as const;
  const listeners = new Set<(event: BrowserThreadEvent) => void>();
  (window as any).zenx = {
    workspaceBrowser: {
      onChanged: () => () => {},
      command: async (_owner: string, command: string) => {
        commands.push(command);
        return [];
      },
    },
    browserObservation: {
      subscribe(
        _request: unknown,
        listener: (event: BrowserThreadEvent) => void,
      ) {
        listeners.add(listener);
        listener({ type: "targets", targets: [target] });
        return () => listeners.delete(listener);
      },
    },
  };
  const snapshot = {
    plugins: [{ id: "browser", enabled: true, available: true }],
    panels: [],
  } as unknown as ZenXPluginSnapshot;
  function Harness() {
    const [selectedTab, onSelectTab] = useState("");
    return React.createElement(AuxiliaryPanel, {
      threadId: "a",
      title: "Task",
      open: true,
      onOpenChange() {},
      snapshot,
      presentationState: emptySidebarState("a"),
      onTabsChange(ids) {
        assert.deepEqual(
          ids,
          [],
          "temporary previews never enter durable tab order",
        );
      },
      selectedTab,
      onSelectTab,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(
      document.querySelectorAll('[role="tab"]').length,
      0,
      "catalog discovery must not open a preview",
    );
    assert.equal(
      document.querySelectorAll(".workspace-tab-types button").length,
      3,
      "the launcher has one Browser type alongside files and terminal; it does not expose Chrome as another type",
    );
    let sequence = 0;
    const operate = async () => {
      sequence++;
      await act(async () => {
        for (const listener of [...listeners])
          listener({
            type: "targets",
            targets: [
              {
                ...target,
                previewActive: true,
                previewSequence: sequence,
                activityCount: 1,
              },
            ],
          });
      });
    };
    await operate();
    assert.equal(document.querySelectorAll('[role="tab"]').length, 1);
    assert.match(
      document.querySelector('[role="tab"]')?.textContent ?? "",
      /Chrome reference/,
    );
    assert.equal(
      document.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
      "true",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label^="Close tab"]')!
        .click(),
    );
    await act(async () => {
      for (const listener of [...listeners])
        listener({
          type: "targets",
          targets: [
            { ...target, previewActive: true, previewSequence: sequence },
          ],
        });
    });
    assert.equal(
      document.querySelectorAll('[role="tab"]').length,
      0,
      "the same operation cannot reopen a dismissed preview",
    );
    await operate();
    assert.equal(document.querySelectorAll('[role="tab"]').length, 1);
    await act(async () => {
      for (const listener of [...listeners])
        listener({
          type: "turn-ended",
          threadId: "a",
          throughSequence: sequence,
          failed: false,
        });
      for (const listener of [...listeners])
        listener({ type: "targets", targets: [] });
    });
    assert.equal(
      document
        .querySelector("[data-browser-outcome]")
        ?.getAttribute("data-browser-outcome"),
      "completed",
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1250)));
    assert.equal(
      document.querySelectorAll('[role="tab"]').length,
      0,
      "the temporary presentation retires after completion",
    );
    assert.deepEqual(
      commands,
      ["list"],
      "preview selection and dismissal never create or close native pages",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("a restored missing Browser descriptor explains its state and can be dismissed without closing a native page", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const commands: string[] = [];
  (window as any).zenx = {
    workspaceBrowser: {
      onChanged: () => () => {},
      command: async (_owner: string, command: string) => {
        commands.push(command);
        if (command !== "list")
          throw Error("Browser tab is not in this Thread");
        return [];
      },
    },
  };
  let saved = applySidebarPatch(emptySidebarState("a"), {
    open: true,
    tabs: [{ kind: "browser", id: "expired-native-page" }],
    selectedTab: "browser:expired-native-page",
  });
  function Harness() {
    const [state, setState] = useState(saved);
    return React.createElement(AuxiliaryPanel, {
      threadId: "a",
      title: "Task",
      open: true,
      onOpenChange() {},
      snapshot: null,
      presentationState: state,
      selectedTab: state.selectedTab ?? "",
      onSelectTab() {},
      onRemoveTab(id) {
        saved = applySidebarPatch(saved, {
          tabs: saved.tabs.filter(
            (tab) => `browser:${"id" in tab ? tab.id : ""}` !== id,
          ),
          selectedTab: null,
        });
        setState(saved);
      },
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.match(
      document.querySelector('[role="status"]')?.textContent ?? "",
      /page.*unavailable/i,
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label^="Close tab"]')!
        .click(),
    );
    assert.equal(saved.tabs.length, 0);
    assert.equal(document.querySelectorAll('[role="tab"]').length, 0);
    assert.deepEqual(
      commands,
      ["list"],
      "dismissal must not address a dead native resource",
    );
    await act(async () =>
      root.render(React.createElement(Harness, { key: "restart" })),
    );
    assert.equal(document.querySelectorAll('[role="tab"]').length, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

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
    control: "agent",
    agentActionsInFlight: 0,
    agentActionOutcomeUnknown: false,
    requiresFreshObservation: false,
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
    assert.equal(
      mounts.length,
      0,
      "discovered tabs remain unselected until a human chooses",
    );
    assert.equal(tabs()[0]!.tabIndex, 0);
    assert.equal(tabs()[0]!.getAttribute("aria-selected"), "false");
    await act(async () => tabs()[0]!.click());
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
