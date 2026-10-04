import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  AuxiliaryPanel,
  type AuxiliaryConversationContext,
} from "../src/renderer/src/auxiliary-panel.js";
import { pluginUiRegistry } from "../src/renderer/src/PluginProductPage.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

const snapshot = {
  plugins: [
    { id: "browser", enabled: true, available: true },
    { id: "computer", enabled: true, available: true },
  ],
  panels: [
    {
      key: "fixture:panel",
      pluginId: "fixture",
      id: "panel",
      title: "Thread plugin",
      surfaceId: "panel",
    },
  ],
  surfaces: [
    {
      key: "fixture:panel",
      pluginId: "fixture",
      id: "panel",
      bundleId: "ui",
      exportName: "panel",
    },
  ],
  bundles: [
    {
      key: "fixture:ui",
      pluginId: "fixture",
      id: "ui",
      apiVersion: 1,
      kind: "trusted",
      entry: "fixture/room-resource-panel",
    },
  ],
  pages: [],
  sidebar: [],
  subroutes: [],
  settings: [],
  commands: [],
  menus: [],
} as unknown as ZenXPluginSnapshot;

async function mount(
  context: AuxiliaryConversationContext,
  options: {
    gateBrowserList?: Promise<unknown[]>;
    gateBrowserNew?: Promise<unknown[]>;
  } = {},
) {
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
  const calls: Array<{ id: string; threadId?: string }> = [];
  const contexts: unknown[] = [];
  let creations = 0;
  const dispose = pluginUiRegistry.registerTrusted(
    "fixture/room-resource-panel",
    {
      panel: ({ sdk }) => {
        contexts.push(sdk.context);
        return React.createElement(
          "p",
          null,
          `Plugin target ${sdk.context.threadId}`,
        );
      },
    },
  );
  (window as any).zenx = {
    workspaceBrowser: {
      onChanged: () => {
        calls.push({ id: "browser-listener" });
        return () => {};
      },
      onFocusAddress: () => () => {},
      mount: async ({ threadId }: { threadId: string }) => {
        calls.push({ id: "browser-mount", threadId });
      },
      command: async (threadId: string, command: string) => {
        calls.push({ id: `browser-${command}`, threadId });
        if (command === "list") return (await options.gateBrowserList) ?? [];
        if (command === "new" && ++creations === 1 && options.gateBrowserNew)
          return await options.gateBrowserNew;
        return [
          {
            id: "page",
            threadId,
            title: "Resource page",
            url: "https://example.com",
            loading: false,
            canGoBack: false,
            canGoForward: false,
            sharedWithAgent: true,
          },
        ];
      },
    },
    browserObservation: {
      subscribe: ({ threadId }: { threadId: string }) => {
        calls.push({ id: "attached", threadId });
        return () => {};
      },
    },
    computerObservation: {
      subscribe: ({ threadId }: { threadId: string }) => {
        calls.push({ id: "computer", threadId });
        return () => {};
      },
    },
    workspaceFiles: {
      list: async (threadId: string) => {
        calls.push({ id: "file-list", threadId });
        return { path: ".", entries: [], truncated: false };
      },
      read: async (threadId: string) => {
        calls.push({ id: "file-read", threadId });
        throw Error("not used");
      },
    },
    plugins: { executeCommand: async () => null, readHandle: async () => null },
  };
  const root = createRoot(document.getElementById("root")!);
  let hostSelect: (value: string) => void = () => {};
  function Harness({ context }: { context: AuxiliaryConversationContext }) {
    const [selectedTab, onSelectTab] = useState("custom:overview");
    hostSelect = onSelectTab;
    const [openedTabs, onTabsChange] = useState(["custom:overview"]);
    return React.createElement(AuxiliaryPanel, {
      conversationContext: context,
      title: "Room title",
      open: true,
      onOpenChange: () => {},
      snapshot,
      selectedTab,
      onSelectTab,
      openedTabs,
      onTabsChange,
      contextControl: React.createElement(
        "label",
        null,
        "Resources from",
        React.createElement(
          "select",
          { "aria-label": "Resources from" },
          React.createElement(
            "option",
            null,
            context.kind === "room"
              ? (context.resourceThread?.title ?? "Choose member")
              : context.threadId,
          ),
        ),
      ),
      customTabs: [
        {
          id: "overview",
          title: "Overview",
          icon: "layers",
          render: () => React.createElement("p", null, "Room overview content"),
        },
        {
          id: "memory",
          title: "Memory",
          icon: "file",
          render: () => React.createElement("p", null, "Room memory content"),
        },
      ],
    });
  }
  const render = async (context: AuxiliaryConversationContext) =>
    act(async () => root.render(React.createElement(Harness, { context })));
  const click = async (name: string) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) =>
          entry.getAttribute("aria-label") === name ||
          entry.querySelector("strong")?.textContent === name ||
          (entry.getAttribute("role") === "tab" && entry.textContent === name),
      );
      assert(button, name);
      button.click();
    });
  await render(context);
  return {
    dom,
    calls,
    contexts,
    render,
    click,
    selectFromHost: async (value: string) => act(async () => hostSelect(value)),
    unmount: async () => {
      await act(async () => root.unmount());
      dispose();
      dom.window.close();
    },
  };
}

test("Room-owned custom tabs remain usable without any execution Thread requests or actions", async () => {
  const h = await mount({ kind: "room", roomId: "room-only" });
  try {
    assert.deepEqual(h.calls, []);
    assert.equal(
      document.querySelector("[role=tab][aria-selected=true]")?.textContent,
      "Overview",
    );
    assert.equal(
      document.querySelectorAll(".auxiliary-context-control").length,
      1,
    );
    assert.match(
      document.querySelector("[role=tabpanel]:not([hidden])")!.textContent!,
      /Room overview content/,
    );
    await h.click("New workspace tab");
    assert.deepEqual(
      [...document.querySelectorAll(".workspace-tab-types button strong")].map(
        (node) => node.textContent,
      ),
      ["Overview", "Memory"],
    );
    await h.click("Memory");
    assert.equal(
      document.querySelector("[role=tab][aria-selected=true]")?.textContent,
      "Memory",
    );
    assert.match(
      document.querySelector("[role=tabpanel]:not([hidden])")!.textContent!,
      /Room memory content/,
    );
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.contexts, []);
  } finally {
    await h.unmount();
  }
});

test("choosing a Room tab restores keyboard focus to that tab when its chooser button unmounts", async () => {
  const h = await mount({ kind: "room", roomId: "room-only" });
  try {
    await h.click("New workspace tab");
    const memoryChoice = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".workspace-tab-types button",
      ),
    ].find((button) => button.textContent === "Memory")!;
    memoryChoice.focus();
    assert.equal(document.activeElement, memoryChoice);
    await h.click("Memory");
    const memoryTab = [
      ...document.querySelectorAll<HTMLButtonElement>("[role=tab]"),
    ].find((button) => button.textContent === "Memory")!;
    assert(
      document.activeElement === memoryTab,
      `Expected Memory tab focus, received ${document.activeElement?.tagName}`,
    );
  } finally {
    await h.unmount();
  }
});

test("an external Room tab selection preserves outside focus and fences a pending chooser result", async () => {
  let release!: (value: unknown[]) => void;
  const gateBrowserNew = new Promise<unknown[]>((resolve) => {
    release = resolve;
  });
  const h = await mount(
    {
      kind: "room",
      roomId: "room-owner",
      resourceThread: { threadId: "execution", title: "Member" },
    },
    { gateBrowserNew },
  );
  try {
    await h.click("New workspace tab");
    await h.click("Browser");
    const outside = document.createElement("button");
    outside.textContent = "Outside focus";
    document.body.append(outside);
    outside.focus();
    await h.selectFromHost("custom:memory");
    assert(document.activeElement === outside);
    await act(async () =>
      release([
        {
          id: "late-page",
          threadId: "execution",
          title: "Late page",
          url: "https://example.com",
        },
      ]),
    );
    assert.equal(
      document.querySelector("[role=tab][aria-selected=true]")?.textContent,
      "Memory",
    );
    assert(
      document.activeElement === outside,
      "late chooser completion must not reclaim keyboard focus",
    );
  } finally {
    await h.unmount();
  }
});

test("external active Room tabs scroll only their bounded rail into view and preserve keyboard focus", async () => {
  const h = await mount({ kind: "room", roomId: "room-owner" });
  const prototype = h.dom.window.HTMLElement.prototype;
  const originalRect = prototype.getBoundingClientRect;
  const originalScrollIntoView = prototype.scrollIntoView;
  let otherScrolls = 0;
  try {
    const rail = document.querySelector<HTMLDivElement>('[role="tablist"]')!;
    Object.defineProperties(rail, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 500 },
    });
    prototype.getBoundingClientRect = function () {
      const left =
        this === rail
          ? 100
          : this.classList.contains("workspace-content-tab")
            ? 100 +
              (this.textContent?.includes("Memory") ? 350 : 0) -
              rail.scrollLeft
            : 0;
      const width = this === rail ? 200 : 100;
      return {
        x: left,
        y: 0,
        left,
        right: left + width,
        top: 0,
        bottom: 32,
        width,
        height: 32,
        toJSON() {},
      };
    };
    prototype.scrollIntoView = () => {
      otherScrolls++;
    };
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    document.body.scrollTop = 37;
    document.documentElement.scrollTop = 41;
    await h.selectFromHost("custom:memory");
    assert.equal(
      rail.scrollLeft,
      250,
      "the clipped active tab must become visible inside its rail",
    );
    assert(
      document.activeElement === outside,
      "revealing a selected tab must not steal focus",
    );
    await h.selectFromHost("custom:overview");
    assert.equal(
      rail.scrollLeft,
      0,
      "selecting an earlier tab must reveal its leading edge",
    );
    assert(document.activeElement === outside);
    assert.equal(
      otherScrolls,
      0,
      "scrollIntoView must not scroll outer surfaces",
    );
    assert.equal(document.body.scrollTop, 37);
    assert.equal(document.documentElement.scrollTop, 41);
  } finally {
    prototype.getBoundingClientRect = originalRect;
    prototype.scrollIntoView = originalScrollIntoView;
    await h.unmount();
  }
});

test("Room resource A→B→A rejects the first A's late Browser creation and clears its busy state", async () => {
  let release!: (value: unknown[]) => void;
  const gateBrowserNew = new Promise<unknown[]>((resolve) => {
    release = resolve;
  });
  const context = (threadId: string): AuxiliaryConversationContext => ({
    kind: "room",
    roomId: "room-owner",
    resourceThread: { threadId, title: threadId },
  });
  const h = await mount(context("A"), { gateBrowserNew });
  try {
    await h.click("New workspace tab");
    await h.click("Browser");
    await h.render(context("B"));
    const browser = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".workspace-tab-types button",
      ),
    ].find((node) => node.querySelector("strong")?.textContent === "Browser")!;
    assert.equal(browser.disabled, false);
    await h.click("Overview");
    await h.render(context("A"));
    await act(async () =>
      release([
        {
          id: "retired-page",
          threadId: "A",
          title: "Retired page",
          url: "https://example.com",
        },
      ]),
    );
    assert.equal(
      document.querySelector("[role=tab][aria-selected=true]")?.textContent,
      "Overview",
    );
    assert(!document.body.textContent?.includes("Retired page"));
    assert.deepEqual(
      h.calls.filter((call) => call.id === "browser-new"),
      [{ id: "browser-new", threadId: "A" }],
    );
  } finally {
    await h.unmount();
  }
});

test("typed Thread context preserves real execution routing and does not add Room plugin context", async () => {
  const h = await mount({ kind: "thread", threadId: "typed-thread" });
  try {
    assert.deepEqual(
      h.calls.filter((call) => call.id === "browser-list"),
      [{ id: "browser-list", threadId: "typed-thread" }],
    );
    await h.click("New workspace tab");
    await h.click("Thread plugin");
    const context = h.contexts.at(-1) as Record<string, unknown>;
    assert.equal(context.threadId, "typed-thread");
    assert.equal(context.route, "agent");
    assert.equal("roomId" in context, false);
  } finally {
    await h.unmount();
  }
});

test("Room resource actions target the explicitly selected real Thread and carry Room context to plugins", async () => {
  const h = await mount({
    kind: "room",
    roomId: "room-owner",
    resourceThread: {
      threadId: "execution-thread",
      title: "Chosen member",
      workspacePath: "/work",
    },
  });
  try {
    assert.deepEqual(
      h.calls.filter((call) => call.id === "browser-list"),
      [{ id: "browser-list", threadId: "execution-thread" }],
    );
    await h.click("New workspace tab");
    await h.click("Thread plugin");
    assert.equal((h.contexts.at(-1) as any).threadId, "execution-thread");
    assert.equal((h.contexts.at(-1) as any).roomId, "room-owner");
    await h.click("New workspace tab");
    await h.click("File");
    assert(
      h.calls.some(
        (call) =>
          call.id === "file-list" && call.threadId === "execution-thread",
      ),
    );
    await h.click("New workspace tab");
    await h.click("Computer");
    assert(
      h.calls.some(
        (call) =>
          call.id === "computer" && call.threadId === "execution-thread",
      ),
    );
    await h.click("New workspace tab");
    await h.click("Browser");
    assert(
      h.calls.some(
        (call) =>
          call.id === "browser-new" && call.threadId === "execution-thread",
      ),
    );
    assert(
      h.calls.every(
        (call) =>
          call.threadId === undefined || call.threadId === "execution-thread",
      ),
    );
    assert.equal(
      document.querySelectorAll('[aria-label="Resources from"]').length,
      1,
    );
  } finally {
    await h.unmount();
  }
});

test("removing a Room resource Thread retains its selected custom tab and rejects a late Browser list", async () => {
  let release!: (value: unknown[]) => void;
  const gateBrowserList = new Promise<unknown[]>((resolve) => {
    release = resolve;
  });
  const h = await mount(
    {
      kind: "room",
      roomId: "room-owner",
      resourceThread: { threadId: "old-execution", title: "Old member" },
    },
    { gateBrowserList },
  );
  try {
    await h.render({ kind: "room", roomId: "room-owner" });
    await act(async () =>
      release([
        {
          id: "old-page",
          threadId: "old-execution",
          title: "Old page",
          url: "https://example.com",
        },
      ]),
    );
    assert.equal(
      document.querySelector("[role=tab][aria-selected=true]")?.textContent,
      "Overview",
    );
    assert(!document.body.textContent?.includes("Old page"));
    await h.click("New workspace tab");
    assert.deepEqual(
      [...document.querySelectorAll(".workspace-tab-types button strong")].map(
        (node) => node.textContent,
      ),
      ["Overview", "Memory"],
    );
    assert.deepEqual(
      h.calls.filter((call) => call.threadId),
      [{ id: "browser-list", threadId: "old-execution" }],
    );
  } finally {
    await h.unmount();
  }
});
