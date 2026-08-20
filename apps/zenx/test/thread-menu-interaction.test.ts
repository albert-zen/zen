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

test("Thread menu manages keyboard focus through close and row removal", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><main id=outside></main><div id=root></div></body></html>",
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
    const trigger = requiredElement<HTMLButtonElement>(".thread-menu-trigger");
    const threadRow = requiredElement<HTMLButtonElement>(".thread-row");

    threadRow.focus();
    await act(async () => {
      threadRow.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
      await Promise.resolve();
    });
    assert.equal(document.activeElement, threadRow);
    assert.equal(document.querySelector('[role="menu"]'), null);

    await act(async () => trigger.click());
    assert.equal(document.activeElement?.textContent?.trim(), "Rename");
    let menuPresentWhenTriggerFocusRestored: boolean | undefined;
    const focusTrigger = trigger.focus.bind(trigger);
    trigger.focus = () => {
      menuPresentWhenTriggerFocusRestored =
        document.querySelector('[role="menu"]') !== null;
      focusTrigger();
    };

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });
    assert.equal(document.activeElement?.textContent?.trim(), "Pin");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Home",
        }),
      );
    });
    assert.equal(document.activeElement?.textContent?.trim(), "Rename");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "End",
        }),
      );
    });
    assert.equal(document.activeElement?.textContent?.trim(), "Archive");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowUp",
        }),
      );
    });
    assert.equal(document.activeElement?.textContent?.trim(), "Pin");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
      await Promise.resolve();
    });
    assert.equal(document.activeElement, trigger);
    assert.equal(menuPresentWhenTriggerFocusRestored, false);
    assert.equal(document.querySelector('[role="menu"]'), null);

    await act(async () => trigger.click());
    await act(async () => {
      document
        .getElementById("outside")
        ?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(document.activeElement, trigger);
    assert.equal(document.querySelector('[role="menu"]'), null);

    await act(async () => trigger.click());
    const archive = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes("Archive"));
    assert.ok(archive);
    await act(async () => {
      archive.click();
      await Promise.resolve();
    });
    assert.equal(document.querySelector(".thread-row-shell"), null);
    assert.equal(
      document.activeElement,
      document.getElementById("sidebar-thread-list-heading"),
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previousGlobals, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

function TestSidebar() {
  const [threads, setThreads] = useState<NativeThreadSummary[]>([
    activeSummary(),
  ]);
  return createElement(Sidebar, {
    mode: "projects",
    liveThread: null,
    open: true,
    onClose: noop,
    onModeChange: noop,
    onNewThread: noop,
    onAddProject: noop,
    onRemoveProject: noop,
    onSetDefaultProject: noop,
    onOpenContribution: noop,
    onOpenSettings: noop,
    onChangeThreadLifecycle: async () => setThreads([]),
    onChangeThreadPinned: async () => undefined,
    onRenameThread: async () => undefined,
    onRetryThreads: noop,
    onSelectThread: noop,
    pendingApprovalThreadIds: new Set<string>(),
    pluginContributions: [],
    projects: {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: true,
          threadIds: threads.map((thread) => thread.threadId),
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
    pinnedThreads: [],
    threads,
    triggerSnapshot: { triggers: [], history: [], rooms: [] },
  });
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  assert.ok(element, `Expected ${selector}`);
  return element;
}

function activeSummary(): NativeThreadSummary {
  return {
    threadId: "active-thread",
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd: "/work/zen",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    preview: "Thread preview",
    status: "idle",
  };
}
