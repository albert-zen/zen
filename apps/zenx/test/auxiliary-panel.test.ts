import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { EditorView } from "@codemirror/view";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

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
      list: async () => ({
        path: ".",
        entries: [{ name: "README.md", path: "README.md", kind: "file" }],
        truncated: false,
      }),
      read: async () => ({
        path: "README.md",
        text: "# Workspace guide\n\n<script>alert(1)</script>",
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
    assert.equal(requests.at(-1)?.frames, true);
    const tab = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (e) => e.textContent === name,
      )!;
    await act(async () => tab("Files").click());
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
    await act(async () =>
      tab("Files").dispatchEvent(
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
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close side panel"]')!
        .click(),
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
