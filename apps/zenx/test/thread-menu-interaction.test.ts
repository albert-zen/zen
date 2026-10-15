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
    "<!doctype html><html><body><button id=outside>Outside action</button><div id=root></div></body></html>",
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
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  let forkedThreadId: string | null = null;
  let finishRename: (() => void) | undefined;

  try {
    await act(async () =>
      root.render(
        createElement(TestSidebar, {
          onRenameThread: async () =>
            new Promise<void>((resolve) => {
              finishRename = resolve;
            }),
          onForkThread: async (threadId: string) => {
            forkedThreadId = threadId;
          },
        }),
      ),
    );
    const trigger = requiredElement<HTMLButtonElement>(".thread-menu-trigger");
    const threadRow = requiredElement<HTMLButtonElement>(".thread-row");
    let anchorLeft = 220;
    let menuWidth = 210;
    trigger.getBoundingClientRect = () =>
      rect({ left: anchorLeft, top: 520, width: 36, height: 36 });
    const getBoundingClientRect =
      dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("thread-item-menu")
        ? rect({ left: 0, top: 0, width: menuWidth, height: 140 })
        : getBoundingClientRect.call(this);
    };
    Object.defineProperties(dom.window, {
      innerHeight: { configurable: true, value: 600 },
      innerWidth: { configurable: true, value: 800 },
    });

    await act(async () => threadRow.focus());
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
    assert.equal(
      document.activeElement === threadRow,
      true,
      "focus returns to the exact threadRow object",
    );
    assert.equal(document.querySelector('[role="menu"]'), null);

    await act(async () => trigger.click());
    const menu = requiredElement<HTMLElement>(".thread-item-menu");
    assert.equal(menu.parentElement, document.body);
    assert.equal(menu.dataset.placement, "right");
    assert.equal(menu.style.left, "262px");
    assert.equal(menu.style.top, "452px");
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
    assert.equal(document.activeElement?.textContent?.trim(), "Fork thread");

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
    assert.equal(
      document.activeElement === trigger,
      true,
      "focus returns to the exact trigger object",
    );
    assert.equal(menuPresentWhenTriggerFocusRestored, false);
    assert.equal(document.querySelector('[role="menu"]'), null);

    anchorLeft = 5;
    menuWidth = 164;
    Object.defineProperty(dom.window, "innerWidth", {
      configurable: true,
      value: 180,
    });
    await act(async () => trigger.click());
    const narrowMenu = requiredElement<HTMLElement>(".thread-item-menu");
    assert.equal(narrowMenu.dataset.placement, "right");
    assert.equal(narrowMenu.style.left, "8px");
    await act(async () => {
      document.getElementById("outside")?.focus();
      document
        .getElementById("outside")
        ?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(
      document.activeElement === document.getElementById("outside"),
      true,
    );
    assert.equal(document.querySelector('[role="menu"]'), null);

    await act(async () => trigger.click());
    const rename = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes("Rename"));
    assert.ok(rename);
    const beforeRenamePanel = document.querySelector(".thread-item-menu");
    await act(async () => rename.click());
    assert.equal(
      document.querySelector(".thread-item-menu"),
      beforeRenamePanel,
    );
    assert.ok(
      document.querySelector(
        ".thread-menu-information .thread-menu-rename input",
      ),
    );
    assert.ok(document.querySelector('[data-thread-action="archive"]'));
    const renameInput = requiredElement<HTMLInputElement>(
      ".thread-menu-rename input",
    );
    assert.equal(
      document.activeElement === renameInput,
      true,
      "focus returns to the exact renameInput object",
    );
    await act(async () => {
      renameInput.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
      await Promise.resolve();
    });
    assert.equal(
      document.activeElement,
      rename,
      "Escape cancels in place and restores Rename",
    );
    assert.equal(
      document.querySelector(".thread-item-menu"),
      beforeRenamePanel,
    );
    await act(async () =>
      rename.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(document.activeElement, trigger);
    assert.equal(document.querySelector('[role="menu"]'), null);

    const openRename = async () => {
      if (!document.querySelector(".thread-item-menu"))
        await act(async () => trigger.click());
      await act(async () =>
        requiredElement<HTMLButtonElement>(
          '[data-thread-action="rename"]',
        ).click(),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      const input = requiredElement<HTMLInputElement>(
        ".thread-menu-rename input",
      );
      assert.equal(
        document.activeElement === input,
        true,
        "exact rename input owns focus",
      );
      return input;
    };
    let input = await openRename();
    await act(async () => {
      const cancel = [...input.form!.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      )!;
      cancel.click();
    });
    assert.equal(document.querySelector(".thread-menu-rename"), null);
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    assert.equal(
      document.activeElement === trigger,
      true,
      "Cancel then Escape preserves the exact ellipsis invoker",
    );

    const enter = async (input: HTMLInputElement) => {
      await act(async () => {
        const key = new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(key);
        assert.equal(
          key.defaultPrevented,
          false,
          "ordinary Enter permits native form submission",
        );
        // JSDOM does not perform the key's browser-default form submission.
        input.form!.requestSubmit();
      });
    };
    input = await openRename();
    await enter(input);
    assert.ok(finishRename);
    await act(async () => finishRename!());
    assert.equal(document.querySelector(".thread-menu-rename"), null);
    assert.equal(
      document.activeElement?.getAttribute("data-thread-action"),
      "rename",
      "successful rename returns to the same Rename action in its open menu",
    );

    input = await openRename();
    await enter(input);
    const outside = document.getElementById("outside")!;
    await act(async () => outside.focus());
    await act(async () => finishRename!());
    assert.equal(
      document.activeElement === outside,
      true,
      "late save cannot reclaim focus moved away from the editor",
    );

    if (!document.querySelector(".thread-item-menu"))
      await act(async () => trigger.click());
    const copy = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes("Fork thread"));
    assert.ok(copy);
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    assert.equal(forkedThreadId, "active-thread");
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
      document.activeElement ===
        document.getElementById("sidebar-thread-list-heading"),
      true,
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previousGlobals, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

function TestSidebar({
  onForkThread,
  onRenameThread,
}: {
  onForkThread(threadId: string): Promise<void>;
  onRenameThread(): Promise<void>;
}) {
  const [threads, setThreads] = useState<NativeThreadSummary[]>([
    activeSummary(),
  ]);
  return createElement(Sidebar, {
    mode: "projects",
    liveThread: null,
    open: true,
    onClose: noop,
    onNewThread: noop,
    onAddProject: noop,
    onRemoveProject: noop,
    onSetDefaultProject: noop,
    onOpenContribution: noop,
    onOpenSettings: noop,
    onChangeThreadLifecycle: async () => setThreads([]),
    onChangeThreadPinned: async () => undefined,
    onForkThread,
    onRenameThread,
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
    serverStatus: { type: "ready", reconnected: false },
    threadError: null,
    threadLoading: false,
    pinnedThreads: [],
    threads,
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

function rect({
  left,
  top,
  width,
  height,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
