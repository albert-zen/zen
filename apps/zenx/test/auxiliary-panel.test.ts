import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { EditorView } from "@codemirror/view";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

test("opening the panel transfers keyboard focus to its close control and restores it on close", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window as any).zenx = {};
  function Harness() {
    const [open, setOpen] = useState(false);
    const [selectedTab, setSelectedTab] = useState("");
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "button",
        {
          id: "thread-browser-toggle",
          onClick: () => setOpen(true),
        },
        "Open panel",
      ),
      React.createElement(AuxiliaryPanel, {
        threadId: "thread-a",
        title: "Task A",
        open,
        onOpenChange: setOpen,
        snapshot: null,
        selectedTab,
        onSelectTab: setSelectedTab,
      }),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const toggle = document.getElementById("thread-browser-toggle")!;
    toggle.focus();
    await act(async () => toggle.click());
    const close = document.querySelector<HTMLButtonElement>(
      ".auxiliary-close-button",
    )!;
    assert.equal(document.activeElement, close);
    await act(async () => close.click());
    assert.equal(document.activeElement, toggle);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("side tabs suspend Browser frames, render Markdown and escaped source, and isolate plugin surfaces", async () => {
  const dom = new JSDOM(
    '<button id="thread-browser-toggle">Panel</button><div id="root"></div>',
    { url: "https://zenx.local/", pretendToBeVisual: true },
  );
  Object.assign(globalThis, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // React's legacy input polyfill probes these IE hooks in jsdom when the
  // block editor focuses its textarea.
  (dom.window.HTMLElement.prototype as any).attachEvent = () => {};
  (dom.window.HTMLElement.prototype as any).detachEvent = () => {};
  const requests: { threadId: string; frames: boolean }[] = [];
  let stopped = 0;
  let finishSave: ((value: any) => void) | undefined;
  let savingText = "";
  (dom.window as any).zenx = {
    browserObservation: {
      subscribe(request: any) {
        requests.push(request);
        return () => {
          stopped++;
        };
      },
    },
    plugins: { executeCommand: async () => null, readHandle: async () => null },
    workspaceFiles: {
      save: async (_threadId: string, _path: string, text: string) => {
        savingText = text;
        return await new Promise((resolve) => {
          finishSave = resolve;
        });
      },
      list: async () => ({
        path: ".",
        entries: [{ name: "README.md", path: "README.md", kind: "file" }],
        truncated: false,
      }),
      read: async () => ({
        path: "README.md",
        text: "# Workspace guide\n\n<script>alert(1)</script>",
        revision: "r1",
        editable: true,
      }),
    },
  };
  const snapshot: ZenXPluginSnapshot = {
    plugins: [{ id: "browser", enabled: true, available: true } as any],
    panels: [
      {
        key: "notes:preview",
        pluginId: "notes",
        id: "preview",
        title: "Notes",
        surfaceId: "note",
      },
    ],
    surfaces: [
      {
        key: "notes:note",
        pluginId: "notes",
        id: "note",
        bundleId: "ui",
        exportName: "main",
      },
    ],
    bundles: [
      {
        key: "notes:ui",
        pluginId: "notes",
        id: "ui",
        apiVersion: 1,
        kind: "isolated",
        entry: "<p>Notes preview</p>",
      },
    ],
    sidebar: [],
    pages: [],
    subroutes: [],
    settings: [],
    commands: [],
    menus: [],
  };
  function Harness() {
    const [selectedTab, onSelectTab] = useState("browser");
    const [open, onOpenChange] = useState(true);
    return React.createElement(AuxiliaryPanel, {
      threadId: "thread-a",
      title: "Task A",
      snapshot,
      open,
      onOpenChange,
      selectedTab,
      onSelectTab,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const choose = (name: string) =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".workspace-tab-types > button",
        ),
      ].find((e) => e.querySelector("strong")?.textContent === name)!;
    await act(async () => choose("Attached browser").click());
    assert.equal(requests.at(-1)?.frames, true);
    const tab = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (e) => e.querySelector("span")?.textContent === name,
      )!;
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
        .click(),
    );
    await act(async () => choose("File").click());
    assert.equal(requests.at(-1)?.frames, false);
    assert.ok(stopped > 0);
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(".file-list button"),
      ][0]!.click(),
    );
    assert.equal(
      document
        .querySelector(".file-content .cm-live-heading-1")
        ?.textContent?.trim(),
      "Workspace guide",
    );
    assert.equal(document.querySelector(".file-content script"), null);
    assert.ok(
      EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)
        ?.state.doc.toString()
        .includes("<script>"),
    );
    assert.equal(document.querySelectorAll('[role="tablist"]').length, 1);
    assert.equal(
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      "README.md",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
        .click(),
    );
    await act(async () => choose("Notes").click());
    await act(async () => tab("README.md").click());
    await act(async () =>
      tab("README.md").dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }),
      ),
    );
    assert.equal(document.activeElement, tab("Notes"));
    const frame = document.querySelector("iframe")!;
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
    let html = "";
    frame.contentWindow!.postMessage = (value) => {
      html = value.html;
    };
    await act(async () => {
      frame.dispatchEvent(new dom.window.Event("load"));
    });
    assert.ok(html.includes('"threadId":"thread-a"'));
    await act(async () => tab("README.md").click());
    const editor = EditorView.findFromDOM(
      document.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    await act(async () =>
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert: "\nA final edit" },
      }),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close tab README.md"]')!
        .click(),
    );
    assert.ok(tab("README.md"), "closing must wait for the current autosave");
    assert.match(savingText, /A final edit/u);
    await act(async () =>
      finishSave!({
        status: "saved",
        file: {
          path: "README.md",
          text: savingText,
          revision: "r2",
          editable: true,
        },
      }),
    );
    assert.equal(
      tab("README.md"),
      undefined,
      "successful autosave completes the close without another action",
    );

    await act(async () =>
      document.querySelector<HTMLElement>(".auxiliary-panel")!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      document.querySelector(".auxiliary-panel")?.getAttribute("data-open"),
      "false",
    );
    assert.equal(document.activeElement?.id, "thread-browser-toggle");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

for (const throughHostSdk of [false, true]) {
  test(`delayed opens preserve ${throughHostSdk ? "Host SDK" : "user"} selection`, async () => {
    const dom = new JSDOM(
      '<button id="thread-browser-toggle">Panel</button><div id="root"></div>',
      { url: "https://zenx.local/", pretendToBeVisual: true },
    );
    Object.assign(globalThis, {
      window: dom.window,
      Window: dom.window.Window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      MutationObserver: dom.window.MutationObserver,
      Node: dom.window.Node,
      getComputedStyle: dom.window.getComputedStyle,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      React,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    (dom.window.HTMLElement.prototype as any).attachEvent = () => {};
    (dom.window.HTMLElement.prototype as any).detachEvent = () => {};
    let resolveBrowser!: (value: any[]) => void;
    let resolveList!: (value: any[]) => void;
    let resolveRead!: (value: any) => void;
    const browserList = new Promise<any[]>((resolve) => {
      resolveList = resolve;
    });
    const browserNew = new Promise<any[]>((resolve) => {
      resolveBrowser = resolve;
    });
    const fileRead = new Promise<any>((resolve) => {
      resolveRead = resolve;
    });
    (dom.window as any).zenx = {
      workspaceBrowser: {
        onChanged: () => () => {},
        command: async (_threadId: string, action: string) => {
          if (action === "list") return await browserList;
          if (action === "new") return await browserNew;
          return [];
        },
      },
      workspaceFiles: {
        list: async () => ({
          path: ".",
          entries: [{ name: "README.md", path: "README.md", kind: "file" }],
          truncated: false,
        }),
        read: async () => await fileRead,
        save: async () => ({ status: "saved", file: {} }),
      },
      plugins: {
        executeCommand: async () => null,
        readHandle: async () => null,
      },
    };
    const snapshot: ZenXPluginSnapshot = {
      plugins: [],
      panels: [
        {
          key: "notes:preview",
          pluginId: "notes",
          id: "preview",
          title: "Notes",
          surfaceId: "note",
        },
      ],
      surfaces: [
        {
          key: "notes:note",
          pluginId: "notes",
          id: "note",
          bundleId: "ui",
          exportName: "main",
        },
      ],
      bundles: [
        {
          key: "notes:ui",
          pluginId: "notes",
          id: "ui",
          apiVersion: 1,
          kind: "isolated",
          entry: "<p>Notes preview</p>",
        },
      ],
      sidebar: [],
      pages: [],
      subroutes: [],
      settings: [],
      commands: [],
      menus: [],
    };
    snapshot.panels.push({
      ...snapshot.panels[0]!,
      key: "notes:external",
      id: "external",
      title: "External Notes",
    });
    let externalSelect!: (tab: string) => void;
    function Harness() {
      const [selectedTab, onSelectTab] = useState("plugin:notes:preview");
      externalSelect = onSelectTab;
      const [open, onOpenChange] = useState(true);
      const [openedTabs, onTabsChange] = useState([
        "browser:browser-1",
        "plugin:notes:preview",
      ]);
      return React.createElement(AuxiliaryPanel, {
        threadId: "thread-a",
        title: "Task A",
        snapshot,
        open,
        onOpenChange,
        selectedTab,
        onSelectTab,
        openedTabs,
        onTabsChange,
      });
    }
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(React.createElement(Harness)));
      assert.deepEqual(
        [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map(
          (element) => element.textContent,
        ),
        ["Notes"],
        "the unresolved Browser list must not rewrite the persisted order",
      );
      resolveList([
        { id: "browser-1", title: "Existing browser", url: "about:blank" },
      ]);
      await act(async () => await Promise.resolve());
      const choose = (name: string) =>
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".workspace-tab-types > button",
          ),
        ].find(
          (element) => element.querySelector("strong")?.textContent === name,
        )!;
      const selectedTab = () =>
        document.querySelector<HTMLButtonElement>(
          '[role="tab"][aria-selected="true"]',
        );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
          .click(),
      );
      await act(async () => choose("Browser").click());
      await act(async () => {
        if (throughHostSdk) externalSelect("plugin:notes:external");
        else choose("Notes").click();
      });
      resolveBrowser([
        { id: "browser-1", title: "Existing browser", url: "about:blank" },
        { id: "browser-2", title: "Delayed browser", url: "about:blank" },
      ]);
      await act(async () => await Promise.resolve());
      assert.equal(
        selectedTab()?.textContent,
        throughHostSdk ? "External Notes" : "Notes",
      );
      assert.ok(
        [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].some(
          (element) => element.textContent === "Delayed browser",
        ),
      );

      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
          .click(),
      );
      await act(async () => choose("File").click());
      await act(async () =>
        document.querySelector<HTMLButtonElement>(".file-list button")!.click(),
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
          .click(),
      );
      await act(async () => choose("Notes").click());
      resolveRead({
        path: "README.md",
        text: "# delayed",
        revision: "r1",
        editable: true,
      });
      await act(async () => await Promise.resolve());
      assert.equal(selectedTab()?.textContent, "Notes");
      assert.equal(
        [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].some(
          (element) => element.textContent === "README.md",
        ),
        false,
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
