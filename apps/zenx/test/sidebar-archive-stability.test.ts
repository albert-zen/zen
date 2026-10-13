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

for (const mode of ["projects", "inbox"] as const) {
  test(`${mode}: repeated archives keep the nearby row focused without scrolling to the heading`, async () => {
    await withSidebar(mode, async ({ clickArchive, scroller, focusCalls }) => {
      scroller.scrollTop = 400;
      await clickArchive("thread-7");
      assert.equal(scroller.scrollTop, 360);
      assert.equal(
        document.activeElement
          ?.closest("[data-thread-id]")
          ?.getAttribute("data-thread-id"),
        "thread-8",
      );
      await clickArchive("thread-8");
      assert.equal(scroller.scrollTop, 320);
      assert.equal(
        document.activeElement
          ?.closest("[data-thread-id]")
          ?.getAttribute("data-thread-id"),
        "thread-9",
      );
      assert.ok(
        focusCalls.every(
          ({ target, options }) =>
            !target.id.includes("heading") || options?.preventScroll === true,
        ),
      );
    });
  });
}

test("archiving at the list end focuses the previous surviving row", async () => {
  await withSidebar("inbox", async ({ clickArchive }) => {
    const rows = [
      ...document.querySelectorAll<HTMLElement>(".thread-row-shell"),
    ];
    const last = rows.at(-1)!.dataset.threadId!;
    const previous = rows.at(-2)!.dataset.threadId!;
    await clickArchive(last);
    assert.equal(
      document.activeElement
        ?.closest("[data-thread-id]")
        ?.getAttribute("data-thread-id"),
      previous,
    );
  });
});

test("failed archive preserves the row, menu focus and position; double click sends once", async () => {
  let calls = 0;
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => {
    fail = reject;
  });
  await withSidebar(
    "inbox",
    async ({ clickArchive, scroller }) => {
      scroller.scrollTop = 400;
      await clickArchive("thread-7");
      const button = document.querySelector<HTMLButtonElement>(
        '[data-thread-action="archive"]',
      )!;
      await act(async () => button.click());
      assert.equal(calls, 1);
      await act(async () => fail(new Error("Archive failed")));
      assert.equal(scroller.scrollTop, 400);
      assert.ok(document.querySelector('[data-thread-id="thread-7"]'));
      assert.ok(
        document.activeElement === button,
        `Expected archive focus, got ${document.activeElement?.outerHTML}`,
      );
      assert.match(document.body.textContent ?? "", /Archive failed/u);
    },
    async () => {
      calls += 1;
      await pending;
    },
  );
});

test("a slow archive does not steal focus after selecting another thread", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await withSidebar(
    "inbox",
    async ({ clickArchive }) => {
      await clickArchive("thread-7");
      const newer = document.querySelector<HTMLButtonElement>(
        '[data-thread-id="thread-2"] .thread-row',
      )!;
      await act(async () => {
        newer.focus();
        newer.click();
      });
      await act(async () => finish());
      assert.ok(document.activeElement === newer);
    },
    async () => pending,
  );
});

test("a delayed refresh anchors at the user's latest scroll position", async () => {
  await withSidebar(
    "inbox",
    async ({ clickArchive, scroller, flushRemoval }) => {
      scroller.scrollTop = 400;
      await clickArchive("thread-7");
      assert.ok(document.querySelector('[data-thread-id="thread-7"]'));
      scroller.scrollTop = 700;
      scroller.dispatchEvent(new window.Event("scroll"));
      await act(async () => flushRemoval());
      assert.equal(scroller.scrollTop, 660);
    },
    async () => undefined,
    true,
  );
});

test("collapsing a project while archive is pending retires hidden anchors", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((r) => (finish = r));
  await withSidebar(
    "projects",
    async ({ clickArchive, scroller }) => {
      scroller.scrollTop = 400;
      await clickArchive("thread-7");
      const toggle =
        document.querySelector<HTMLButtonElement>(".project-toggle")!;
      await act(async () => {
        toggle.focus();
        toggle.click();
      });
      const target = document.querySelector<HTMLElement>(
        '[data-thread-id="thread-7"]',
      )!;
      assert.ok(target.isConnected && target.closest("[inert]"));
      scroller.scrollTop = 700;
      scroller.dispatchEvent(new window.Event("scroll"));
      await act(async () => finish());
      assert.equal(
        scroller.scrollTop,
        700,
        "hidden row removal must not move visible viewport",
      );
    },
    async () => pending,
  );
});

async function withSidebar(
  mode: "projects" | "inbox",
  run: (harness: {
    scroller: HTMLElement;
    flushRemoval(): void;
    clickArchive(threadId: string): Promise<void>;
    focusCalls: { target: HTMLElement; options?: FocusOptions }[];
  }) => Promise<void>,
  operation: () => Promise<void> = async () => undefined,
  delayRemoval = false,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
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
  const focusCalls: { target: HTMLElement; options?: FocusOptions }[] = [];
  const focus = dom.window.HTMLElement.prototype.focus;
  dom.window.HTMLElement.prototype.focus = function (options?: FocusOptions) {
    focusCalls.push({ target: this, options });
    // Chromium cannot focus the CSS-hidden menu trigger until its row owns focus.
    if (
      this.classList.contains("thread-menu-trigger") &&
      !this.closest(".thread-row-shell")?.contains(document.activeElement)
    )
      return;
    if (this.id.includes("heading") && !options?.preventScroll) {
      const scroller = document.querySelector<HTMLElement>(".sidebar-scroll");
      if (scroller) scroller.scrollTop = 0;
    }
    focus.call(this, options);
  };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const scroller = document.querySelector<HTMLElement>(".sidebar-scroll");
    const rows = [...document.querySelectorAll(".thread-row-shell")];
    const index = rows.indexOf(this);
    const top =
      this === scroller
        ? 0
        : index < 0
          ? 0
          : 200 + index * 40 - (scroller?.scrollTop ?? 0);
    return {
      x: 0,
      y: top,
      top,
      bottom: top + (this === scroller ? 300 : 40),
      left: 0,
      right: 280,
      width: 280,
      height: this === scroller ? 300 : 40,
      toJSON: noop,
    };
  };
  const root = createRoot(document.getElementById("root")!);
  let flushRemoval: () => void = () => undefined;
  function Harness() {
    const [threads, setThreads] = useState(
      Array.from({ length: 12 }, (_, i) => summary(`thread-${i}`)),
    );
    return createElement(Sidebar, {
      mode,
      liveThread: null,
      open: true,
      onClose: noop,
      onNewThread: noop,
      onAddProject: noop,
      onRemoveProject: noop,
      onSetDefaultProject: noop,
      onOpenContribution: noop,
      onOpenSettings: noop,
      onChangeThreadLifecycle: async (thread) => {
        await operation();
        const remove = () =>
          setThreads((value) =>
            value.filter((entry) => entry.threadId !== thread.threadId),
          );
        if (delayRemoval) flushRemoval = remove;
        else remove();
      },
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
      serverStatus: { type: "ready", reconnected: false },
      threadError: null,
      threadLoading: false,
      pinnedThreads: [],
      threads,
    });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    const scroller = document.querySelector<HTMLElement>(".sidebar-scroll")!;
    await run({
      scroller,
      flushRemoval: () => flushRemoval(),
      focusCalls,
      clickArchive: async (threadId) => {
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              `[data-thread-id="${threadId}"] .thread-menu-trigger`,
            )!
            .click(),
        );
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>('[data-thread-action="archive"]')!
            .click(),
        );
      },
    });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

function summary(threadId: string): NativeThreadSummary {
  return {
    threadId,
    name: threadId,
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd: "/work/zen",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived: false,
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(2000).toISOString(),
    preview: "",
    status: "idle",
  };
}
