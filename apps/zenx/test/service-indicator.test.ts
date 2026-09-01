import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { AppServerHostStatus } from "../src/main/app-server-manager.js";

const { act, createElement } = React;
Object.assign(globalThis, { React });
const { Sidebar, serviceStatusPresentation } =
  await import("../src/renderer/src/Sidebar.js");
const { Icon } = await import("../src/renderer/src/icons.js");

test("the selected radial Settings glyph stays legible at the real 14/16/18px sizes", () => {
  for (const size of [14, 16, 18]) {
    const html = renderToStaticMarkup(
      createElement(Icon, { name: "settings", size }),
    );
    const dom = new JSDOM(html);
    const icon = dom.window.document.querySelector("svg[data-icon='settings']");
    assert.ok(icon);
    assert.equal(icon.getAttribute("width"), String(size));
    assert.equal(icon.getAttribute("height"), String(size));
    assert.equal(icon.getAttribute("viewBox"), "0 0 16 16");
    assert.ok(
      Array.from(icon.querySelectorAll("path")).some(
        (path) =>
          path.getAttribute("d") ===
          "M8 1.8v1.3M8 12.9v1.3M1.8 8h1.3M12.9 8h1.3M3.6 3.6l.9.9M11.5 11.5l.9.9M12.4 3.6l-.9.9M4.5 11.5l-.9.9",
      ),
      "Settings must reuse the simpler radial candidate from the existing ZenX icon family",
    );
    dom.window.close();
  }
});

test("Settings glyph surfaces keep distinct default, hover, and active states", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.settings-nav-row\s*\{[^}]*color:\s*var\(--color-text-muted\)[^}]*\}/su,
  );
  assert.match(
    styles,
    /\.settings-nav-row:hover,\s*\.settings-nav-row\[aria-current="page"\]\s*\{[^}]*color:\s*var\(--color-text-primary\)[^}]*background:\s*var\(--color-surface-hover\)/su,
  );
  assert.match(
    styles,
    /\.settings-nav button:hover,\s*\.settings-nav button\[aria-selected="true"\]\s*\{[^}]*color:\s*var\(--text\)[^}]*background:\s*var\(--surface-2\)/su,
  );
});

test("maps every App Server host state to an explicit status", () => {
  const cases: Array<[AppServerHostStatus, string, string]> = [
    [{ type: "starting" }, "starting", "Local service starting"],
    [{ type: "ready", reconnected: false }, "ready", "Local service ready"],
    [
      { type: "reconnecting", attempt: 2, delayMs: 100 },
      "reconnecting",
      "Local service reconnecting",
    ],
    [{ type: "error", message: "socket closed" }, "error", "socket closed"],
    [{ type: "stopped" }, "stopped", "Local service stopped"],
  ];
  for (const [status, className, label] of cases) {
    const presentation = serviceStatusPresentation(status);
    assert.equal(presentation.className, className);
    assert.match(presentation.label, new RegExp(label, "u"));
  }
});

test("service status is part of the Settings row, not a separate footer line", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(createElement(TestSidebar)));
    assert.equal(document.querySelector(".service-status"), null);
    const dot = document.querySelector(".service-status-dot");
    assert.ok(dot);
    assert.equal(dot.tagName, "SPAN");
    assert.equal(dot.getAttribute("role"), null);
    assert.equal(dot.getAttribute("tabindex"), null);
    const settings =
      document.querySelector<HTMLButtonElement>(".settings-nav-row");
    assert.ok(settings);
    assert.match(settings.getAttribute("aria-label") ?? "", /ready/i);
    assert.equal(settings.getAttribute("title"), "Local service ready");
    assert.ok(settings.querySelector("svg[data-icon='settings']"));
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previousGlobals, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

test("starting and reconnecting status dots stop animating for reduced motion", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
  assert.match(
    css,
    /\.service-status-dot\.starting,\s*\.service-status-dot\.reconnecting\s*\{\s*animation:\s*none;/su,
  );
});

function TestSidebar() {
  const threads: NativeThreadSummary[] = [];
  return createElement(Sidebar, {
    liveThread: null,
    mode: "projects",
    open: true,
    onClose: () => undefined,
    onNewThread: () => undefined,
    onAddProject: () => undefined,
    onRemoveProject: () => undefined,
    onSetDefaultProject: () => undefined,
    onOpenContribution: () => undefined,
    onOpenSettings: () => undefined,
    onChangeThreadLifecycle: async () => undefined,
    onChangeThreadPinned: async () => undefined,
    onRenameThread: async () => undefined,
    onRetryThreads: () => undefined,
    onSelectThread: () => undefined,
    pendingApprovalThreadIds: new Set<string>(),
    pluginContributions: [],
    projects: {
      projects: [],
      unavailableThreadIds: [],
      lastUsedWorkspace: null,
    },
    selectedPage: "agent",
    selectedThreadId: null,
    serverStatus: { type: "ready", reconnected: false },
    threadError: null,
    threadLoading: false,
    pinnedThreads: [],
    threads,
  });
}
