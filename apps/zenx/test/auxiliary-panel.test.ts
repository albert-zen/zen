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
          ".workspace-tab-types button",
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
        ...document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'),
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
            ".workspace-tab-types button",
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
        document.querySelector<HTMLButtonElement>('[role="treeitem"]')!.click(),
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

test("file navigation remains mounted across file tabs and hide/show while dirty drafts stay authoritative", async () => {
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
  (dom.window.HTMLElement.prototype as any).attachEvent = () => {};
  (dom.window.HTMLElement.prototype as any).detachEvent = () => {};
  const { WorkspaceFileDrafts, fileDraftKey } =
    await import("../src/renderer/src/workspace-file-drafts.js");
  const drafts = new WorkspaceFileDrafts(60_000);
  drafts.set(fileDraftKey("a", "src/a.ts"), {
    base: { path: "src/a.ts", text: "disk", revision: "r" },
    text: "unsaved draft",
  });
  (window as any).zenx = {
    workspaceFiles: {
      list: async (_id: string, path: string) => ({
        path,
        entries:
          path === "."
            ? [{ name: "src", path: "src", kind: "directory" }]
            : [
                { name: "a.ts", path: "src/a.ts", kind: "file" },
                { name: "b.ts", path: "src/b.ts", kind: "file" },
              ],
        truncated: false,
      }),
      read: async (_id: string, path: string) => ({
        path,
        text: "disk",
        revision: "r",
      }),
      search: async () => ({
        cwd: "/workspace",
        entries: [],
        scanned: 3,
        truncated: false,
      }),
    },
  };
  function Harness() {
    const [selected, select] = useState("file:src/a.ts");
    return React.createElement(AuxiliaryPanel, {
      threadId: "a",
      title: "Files",
      open: true,
      onOpenChange: () => {},
      snapshot: null,
      selectedTab: selected,
      onSelectTab: select,
      fileDrafts: drafts,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const navigation = document.getElementById("workspace-file-navigation")!;
    const search = navigation.querySelector('input[type="search"]')!;
    const separator = document.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize file navigation"]',
    );
    assert.ok(
      separator,
      "file navigation can be resized independently of the outer panel",
    );
    assert.equal(separator.getAttribute("aria-orientation"), "vertical");
    assert.equal(separator.getAttribute("aria-valuenow"), "192");
    await act(async () =>
      separator.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(separator.getAttribute("aria-valuenow"), "212");
    await act(async () =>
      separator.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Home",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      separator.getAttribute("aria-valuenow"),
      separator.getAttribute("aria-valuemin"),
    );
    await act(async () =>
      separator.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "End",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(
      separator.getAttribute("aria-valuenow"),
      separator.getAttribute("aria-valuemax"),
    );
    assert.ok(
      navigation.querySelector('[data-file-path="src/b.ts"]'),
      "selected file ancestors open automatically",
    );
    await act(async () =>
      (
        navigation.querySelector('[data-file-path="src/b.ts"]') as HTMLElement
      ).click(),
    );
    assert.equal(
      document.getElementById("workspace-file-navigation"),
      navigation,
    );
    assert.equal(navigation.querySelector('input[type="search"]'), search);
    assert.equal(
      document
        .querySelector('[data-file-path="src/b.ts"]')
        ?.getAttribute("data-current"),
      "true",
    );
    await act(async () =>
      (
        document.querySelector(
          '[aria-label="Hide file navigation"]',
        ) as HTMLElement
      ).click(),
    );
    assert.equal(navigation.hidden, true);
    assert.equal(separator.hidden, true);
    await act(async () =>
      (
        document.querySelector(
          '[aria-label="Show file navigation"]',
        ) as HTMLElement
      ).click(),
    );
    assert.equal(navigation.hidden, false);
    assert.equal(separator.hidden, false);
    assert.equal(navigation.querySelector('input[type="search"]'), search);
    await act(async () =>
      (
        navigation.querySelector(
          '[aria-label="Refresh file list"]',
        ) as HTMLElement
      ).click(),
    );
    assert.ok(
      navigation.querySelector('[data-file-path="src/b.ts"]'),
      "refresh reloads expanded selected ancestors",
    );
    await act(async () =>
      (
        document.querySelector(
          '[aria-label="Hide file navigation"]',
        ) as HTMLElement
      ).click(),
    );
    await act(async () => {
      document
        .querySelector('[role="tabpanel"]:not([hidden]) .cm-content')!
        .dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "p",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(navigation.hidden, false);
    assert.equal(
      document.activeElement,
      search,
      "Ctrl+P restores navigation and search focus from the editor",
    );
    await act(async () =>
      (
        navigation.querySelector('[data-file-path="src/a.ts"]') as HTMLElement
      ).click(),
    );
    assert.equal(
      drafts.snapshot().get(fileDraftKey("a", "src/a.ts"))?.text,
      "unsaved draft",
    );
    assert.match(
      document.querySelector('[role="tabpanel"]:not([hidden])')!.textContent!,
      /unsaved draft/,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

import {
  WorkspaceFileDrafts,
  fileDraftKey,
} from "../src/renderer/src/workspace-file-drafts.js";
function r4Fixture(api: any) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  (dom.window.Range.prototype as any).getClientRects = () => [];
  (dom.window.Range.prototype as any).getBoundingClientRect = () => ({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
  });
  (window as any).zenx = { workspaceFiles: api };
  const root = createRoot(document.getElementById("root")!);
  return {
    dom,
    root,
    render: async (node: any) => act(async () => root.render(node)),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}
async function r4Click(selector: string) {
  await act(async () => document.querySelector<HTMLElement>(selector)!.click());
}
async function r4ChooseFile() {
  await r4Click(".workspace-add-tab");
  await act(async () =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".workspace-tab-types button",
      ),
    ]
      .find((b) => b.querySelector("strong")?.textContent === "File")!
      .click(),
  );
}

test("back during a pending file read resets the persistent navigator without admitting the stale file", async () => {
  let resolveRead!: (v: any) => void;
  let readB = 0;
  const f = r4Fixture({
    list: async () => ({
      path: ".",
      entries: [
        { name: "a.ts", path: "a.ts", kind: "file" },
        { name: "b.ts", path: "b.ts", kind: "file" },
      ],
      truncated: false,
    }),
    read: async (_t: string, p: string) =>
      p === "a.ts"
        ? { path: p, text: "a", revision: "r" }
        : (readB++, new Promise((r) => (resolveRead = r))),
  });
  const drafts = new WorkspaceFileDrafts();
  drafts.set(fileDraftKey("t", "a.ts"), {
    base: { path: "a.ts", text: "a", revision: "r" },
    text: "a",
  });
  function Harness() {
    const [selectedTab, onSelectTab] = useState("file:a.ts");
    return React.createElement(AuxiliaryPanel, {
      threadId: "t",
      title: "T",
      open: true,
      onOpenChange: () => {},
      snapshot: null,
      selectedTab,
      onSelectTab,
      fileDrafts: drafts,
    });
  }
  try {
    await f.render(React.createElement(Harness));
    await r4ChooseFile();
    await r4Click('[data-file-path="b.ts"]');
    assert.equal(readB, 1);
    await r4Click('[aria-label="Back to tab types"]');
    await act(async () =>
      resolveRead({ path: "b.ts", text: "b", revision: "r" }),
    );
    assert.equal(
      drafts.snapshot().has(fileDraftKey("t", "b.ts")),
      false,
      "the cancelled read remains fenced",
    );
    await act(async () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".workspace-tab-types button",
        ),
      ]
        .find((b) => b.querySelector("strong")?.textContent === "File")!
        .click(),
    );
    await r4Click('[data-file-path="b.ts"]');
    assert.equal(
      readB,
      2,
      "new reads must remain possible after backing out of a cancelled read",
    );
  } finally {
    await f.close();
  }
});
