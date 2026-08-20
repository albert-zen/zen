import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { ZenXSidebarOrder } from "../src/main/host-profile.js";
import type { ZenXProjectProjectionSnapshot } from "../src/main/project-projection.js";
import {
  moveSidebarProject,
  moveSidebarThread,
  type SidebarOrderPlacement,
} from "../src/renderer/src/thread-list.js";

const { act, createElement, useRef, useState } = React;
Object.assign(globalThis, { React });
const { Sidebar } = await import("../src/renderer/src/Sidebar.js");
const noop = () => undefined;

const projection: ZenXProjectProjectionSnapshot = {
  projects: [
    {
      key: "/work/a",
      workspace: "/work/a",
      configured: true,
      isDefault: true,
      threadIds: ["pinned", "active", "idle"],
    },
    {
      key: "/work/b",
      workspace: "/work/b",
      configured: true,
      isDefault: false,
      threadIds: ["other"],
    },
  ],
  unavailableThreadIds: [],
  lastUsedWorkspace: "/work/a",
};

const threads = [
  summary("pinned", "idle", 40, "/work/a"),
  summary("active", "active", 30, "/work/a"),
  summary("idle", "idle", 20, "/work/a"),
  summary("other", "idle", 10, "/work/b"),
];

test("keyboard reorder restores focus while preserving selection, Pin, and active Turn state", async () => {
  await withDom(async (root) => {
    await act(async () => root.render(createElement(OrderingSidebar)));

    const projectA = requiredButton('[aria-label^="Reorder project a."]');
    projectA.focus();
    await act(async () => {
      projectA.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(projectKeys(), ["/work/b", "/work/a"]);
    assert.equal(document.activeElement, projectA);

    await act(async () =>
      requiredButton('[data-thread-id="idle"] .thread-menu-trigger').click(),
    );
    assert.ok(
      document.querySelector('[data-thread-id="idle"] .thread-item-menu'),
    );
    const idleHandle = requiredButton('[aria-label^="Reorder idle within"]');
    idleHandle.focus();
    await act(async () => {
      idleHandle.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowUp",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const projectAThreads = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-project-key="/work/a"] .thread-row-shell',
      ),
    ].map((row) => row.dataset.threadId);
    assert.deepEqual(projectAThreads, ["idle", "active"]);
    assert.equal(document.activeElement, idleHandle);
    assert.ok(
      document.querySelector('[data-thread-id="idle"] .thread-item-menu'),
    );
    assert.equal(
      document
        .querySelector('[data-thread-id="active"] .thread-row')
        ?.getAttribute("aria-current"),
      "page",
    );
    assert.ok(
      document.querySelector(
        '[data-thread-id="active"] [aria-label="Running"]',
      ),
    );
    assert.deepEqual(
      [
        ...document.querySelectorAll<HTMLElement>(
          ".pinned-thread-group .thread-row-shell",
        ),
      ].map((row) => row.dataset.threadId),
      ["pinned"],
    );
  });
});

test("reorder handles remain in sequential Tab order while visually quiet", async () => {
  await withDom(async (root) => {
    await act(async () => root.render(createElement(StaticSidebar)));
    const handles = [
      ...document.querySelectorAll<HTMLButtonElement>(".reorder-handle"),
    ];
    assert.ok(handles.length > 0);
    assert.ok(handles.every((handle) => handle.tabIndex === 0));
    assert.deepEqual(
      handles.map((handle) => handle.id),
      [
        "sidebar-project-order-%2Fwork%2Fa",
        "sidebar-thread-order-active",
        "sidebar-thread-order-idle",
        "sidebar-project-order-%2Fwork%2Fb",
        "sidebar-thread-order-other",
      ],
    );
  });
});

test("native Thread drag refuses a drop in a different Project", async () => {
  let reorderCalls = 0;
  await withDom(async (root) => {
    await act(async () =>
      root.render(
        createElement(StaticSidebar, {
          onReorderThread: async () => {
            reorderCalls += 1;
          },
        }),
      ),
    );
    const source = requiredButton('[aria-label^="Reorder active within"]');
    const target = document.querySelector<HTMLElement>(
      '[data-thread-id="other"]',
    );
    assert.ok(target);
    const dataTransfer = dragData();
    await act(async () => {
      source.dispatchEvent(dragEvent("dragstart", dataTransfer));
      target.dispatchEvent(dragEvent("dragover", dataTransfer));
      target.dispatchEvent(dragEvent("drop", dataTransfer));
      await Promise.resolve();
    });
    assert.equal(reorderCalls, 0);
    assert.deepEqual(projectKeys(), ["/work/a", "/work/b"]);
  });
});

test("Sidebar order failure is recoverable without replacing the Thread view", async () => {
  await withDom(async (root) => {
    await act(async () => root.render(createElement(FailingSidebar)));
    const projectA = requiredButton('[aria-label^="Reorder project a."]');
    projectA.focus();
    await act(async () => {
      projectA.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      document.body.textContent ?? "",
      /Could not save Sidebar order/u,
    );
    assert.equal(
      document
        .querySelector('[data-thread-id="active"] .thread-row')
        ?.getAttribute("aria-current"),
      "page",
    );
    assert.equal(document.activeElement, projectA);

    await act(async () => {
      requiredButton(".sidebar-error button").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /Could not save Sidebar order/u,
    );
    assert.deepEqual(projectKeys(), ["/work/b", "/work/a"]);
    assert.equal(document.activeElement, projectA);
    assert.equal(
      document
        .querySelector('[data-thread-id="active"] .thread-row')
        ?.getAttribute("aria-current"),
      "page",
    );
  });
});

test("native drag reorders Projects globally and Threads inside one Project", async () => {
  await withDom(async (root) => {
    await act(async () => root.render(createElement(OrderingSidebar)));
    const projectSource = requiredButton('[aria-label^="Reorder project b."]');
    const projectTarget = document.querySelector<HTMLElement>(
      '[data-project-key="/work/a"]',
    );
    assert.ok(projectTarget);
    const projectTransfer = dragData();
    await act(async () => {
      projectSource.dispatchEvent(dragEvent("dragstart", projectTransfer));
      projectTarget.dispatchEvent(dragEvent("dragover", projectTransfer));
      projectTarget.dispatchEvent(dragEvent("drop", projectTransfer));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(projectKeys(), ["/work/b", "/work/a"]);

    const threadSource = requiredButton('[aria-label^="Reorder idle within"]');
    const threadTarget = document.querySelector<HTMLElement>(
      '[data-thread-id="active"]',
    );
    assert.ok(threadTarget);
    const threadTransfer = dragData();
    await act(async () => {
      threadSource.dispatchEvent(dragEvent("dragstart", threadTransfer));
      threadTarget.dispatchEvent(dragEvent("dragover", threadTransfer));
      threadTarget.dispatchEvent(dragEvent("drop", threadTransfer));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-project-key="/work/a"] .thread-row-shell',
        ),
      ].map((row) => row.dataset.threadId),
      ["idle", "active"],
    );
  });
});

function OrderingSidebar() {
  const [order, setOrder] = useState<ZenXSidebarOrder>({
    projectKeys: [],
    threadIdsByProject: {},
  });
  return createElement(StaticSidebar, {
    sidebarOrder: order,
    onReorderProject: async (
      sourceKey: string,
      targetKey: string,
      placement: SidebarOrderPlacement,
    ) =>
      setOrder((current) =>
        moveSidebarProject(
          current,
          projection,
          sourceKey,
          targetKey,
          placement,
        ),
      ),
    onReorderThread: async (
      sourceProjectKey: string,
      sourceThreadId: string,
      targetProjectKey: string,
      targetThreadId: string,
      placement: SidebarOrderPlacement,
    ) =>
      setOrder((current) =>
        moveSidebarThread(
          current,
          threads,
          projection,
          sourceProjectKey,
          sourceThreadId,
          targetProjectKey,
          targetThreadId,
          placement,
        ),
      ),
  });
}

function FailingSidebar() {
  const [order, setOrder] = useState<ZenXSidebarOrder>({
    projectKeys: [],
    threadIdsByProject: {},
  });
  const attempts = useRef(0);
  return createElement(StaticSidebar, {
    sidebarOrder: order,
    onReorderProject: async (
      sourceKey: string,
      targetKey: string,
      placement: SidebarOrderPlacement,
    ) => {
      attempts.current += 1;
      if (attempts.current === 1) throw new Error("temporary profile failure");
      setOrder((current) =>
        moveSidebarProject(
          current,
          projection,
          sourceKey,
          targetKey,
          placement,
        ),
      );
    },
  });
}

function StaticSidebar({
  sidebarOrder = { projectKeys: [], threadIdsByProject: {} },
  onReorderProject = async () => undefined,
  onReorderThread = async () => undefined,
}: {
  sidebarOrder?: ZenXSidebarOrder;
  onReorderProject?: (
    sourceKey: string,
    targetKey: string,
    placement: SidebarOrderPlacement,
  ) => Promise<void>;
  onReorderThread?: (
    sourceProjectKey: string,
    sourceThreadId: string,
    targetProjectKey: string,
    targetThreadId: string,
    placement: SidebarOrderPlacement,
  ) => Promise<void>;
}) {
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
    onChangeThreadPinned: async () => undefined,
    onReorderProject,
    onReorderThread,
    onRenameThread: async () => undefined,
    onRetryThreads: noop,
    onSelectThread: noop,
    pendingApprovalThreadIds: new Set<string>(),
    pinnedThreads: [threads[0]!],
    pluginContributions: [],
    projects: projection,
    sidebarOrder,
    selectedPage: "agent",
    selectedThreadId: "active",
    serverReady: true,
    threadError: null,
    threadLoading: false,
    threads,
    triggerSnapshot: { triggers: [], history: [], rooms: [] },
  });
}

async function withDom(
  operation: (root: ReturnType<typeof createRoot>) => Promise<void>,
): Promise<void> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    requestAnimationFrame: undefined,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await operation(root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
}

function requiredButton(selector: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, `Expected ${selector}`);
  return button;
}

function projectKeys(): (string | undefined)[] {
  return [...document.querySelectorAll<HTMLElement>(".project-group")].map(
    (group) => group.dataset.projectKey,
  );
}

function dragData() {
  return {
    dropEffect: "none",
    effectAllowed: "all",
    setData: () => undefined,
  };
}

function dragEvent(type: string, dataTransfer: ReturnType<typeof dragData>) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientY: { value: 0 },
    dataTransfer: { value: dataTransfer },
  });
  return event;
}

function summary(
  threadId: string,
  status: "idle" | "active",
  updated: number,
  cwd: string,
): NativeThreadSummary {
  return {
    threadId,
    currentMetadata: {
      model: "gpt-5.6-terra",
      provider: "openai",
      cwd,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived: false,
    createdAt: new Date((updated - 1) * 1_000).toISOString(),
    updatedAt: new Date(updated * 1_000).toISOString(),
    name: threadId,
    preview: "",
    status,
  };
}
