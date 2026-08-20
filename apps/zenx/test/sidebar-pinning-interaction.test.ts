import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";

const { act, createElement, useState } = React;
Object.assign(globalThis, { React });
const { Sidebar } = await import("../src/renderer/src/Sidebar.js");
const noop = () => undefined;

test("Pin and Unpin move one Thread through the independent Pinned section", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previous = {
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
    await act(async () => root.render(createElement(PinSidebar)));
    await act(async () => requiredButton(".thread-menu-trigger").click());
    await act(async () => exactMenuButton("Pin").click());

    assert.match(document.body.textContent ?? "", /Pinned/u);
    assert.equal(document.querySelectorAll(".thread-row-shell").length, 1);
    assert.equal(
      document.activeElement,
      document.getElementById("sidebar-pinned-heading"),
    );

    const projectsToggle = requiredButton(".projects-section-toggle");
    await act(async () => projectsToggle.click());
    assert.equal(document.querySelectorAll(".thread-row-shell").length, 1);
    assert.ok(document.getElementById("sidebar-pinned-heading"));
    await act(async () => projectsToggle.click());

    await act(async () => requiredButton(".thread-menu-trigger").click());
    await act(async () => exactMenuButton("Unpin").click());

    assert.equal(document.getElementById("sidebar-pinned-heading"), null);
    assert.equal(document.querySelectorAll(".thread-row-shell").length, 1);
    assert.equal(
      document.activeElement,
      document.getElementById("sidebar-thread-list-heading"),
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

function PinSidebar() {
  const [pinned, setPinned] = useState(false);
  const threads = [summary()];
  return createElement(Sidebar, {
    liveThread: null,
    mode: "projects",
    open: true,
    onClose: noop,
    onModeChange: noop,
    onNewThread: noop,
    onAddProject: noop,
    onRemoveProject: noop,
    onSetDefaultProject: noop,
    onOpenContribution: noop,
    onOpenSettings: noop,
    onChangeThreadLifecycle: async () => undefined,
    onChangeThreadPinned: async () => setPinned((value) => !value),
    onRenameThread: async () => undefined,
    onRetryThreads: noop,
    onSelectThread: noop,
    pendingApprovalThreadIds: new Set<string>(),
    pinnedThreads: pinned ? threads : [],
    pluginContributions: [],
    projects: {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: true,
          threadIds: ["thread-1"],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    },
    selectedPage: "agent",
    selectedThreadId: null,
    serverReady: true,
    threadError: null,
    threadLoading: false,
    threads,
    triggerSnapshot: { triggers: [], history: [], rooms: [] },
  });
}

function requiredButton(selector: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, `Expected ${selector}`);
  return button;
}

function exactMenuButton(label: string): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(button, `Expected ${label} menu item`);
  return button;
}

function summary(): NativeThreadSummary {
  return {
    threadId: "thread-1",
    currentMetadata: {
      model: "gpt-5.6-terra",
      provider: "openai",
      cwd: "/work/zen",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    name: "Pinned candidate",
    preview: "",
    status: "idle",
  };
}
