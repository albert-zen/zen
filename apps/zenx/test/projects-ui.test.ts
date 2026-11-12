import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";

const baseProps = {
  liveThread: null,
  mode: "projects" as const,
  open: true,
  onClose: () => undefined,
  onNewThread: () => undefined,
  onAddProject: () => undefined,
  onRemoveProject: () => undefined,
  onSetDefaultProject: () => undefined,
  onChangeThreadLifecycle: async () => undefined,
  onChangeThreadPinned: async () => undefined,
  onRenameThread: async () => undefined,
  onRetryThreads: () => undefined,
  onOpenContribution: () => undefined,
  onOpenSettings: () => undefined,
  onSelectThread: () => undefined,
  pendingApprovalThreadIds: new Set<string>(),
  pluginContributions: [],
  selectedPage: "agent" as const,
  selectedThreadId: null,
  serverStatus: { type: "ready", reconnected: false } as const,
  threadError: null,
  threadLoading: false,
  pinnedThreads: [],
  threads: [],
};

test("no-project sidebar keeps explicit Add project and New thread guidance", async () => {
  Object.assign(globalThis, { React });
  const { Sidebar } = await import("../src/renderer/src/Sidebar.js");
  const html = renderToStaticMarkup(
    React.createElement(Sidebar, {
      ...baseProps,
      projects: {
        projects: [],
        unavailableThreadIds: [],
        lastUsedWorkspace: null,
      },
    }),
  );
  assert.match(html, />New thread</u);
  assert.match(html, /No project/u);
  assert.match(html, /aria-label="Add project"/u);
  assert.match(html, /title="Add project"/u);
  assert.doesNotMatch(html, />Add project<\/button>/u);
  assert.match(html, /aria-expanded="true"/u);
  assert.match(html, /No projects yet/u);
});

test("configured Project exposes the recent and scoped New thread actions", async () => {
  Object.assign(globalThis, { React });
  const { Sidebar } = await import("../src/renderer/src/Sidebar.js");
  const html = renderToStaticMarkup(
    React.createElement(Sidebar, {
      ...baseProps,
      projects: {
        projects: [
          {
            key: "/work/zen",
            workspace: "/work/zen",
            configured: true,
            isDefault: true,
            threadIds: [],
          },
        ],
        unavailableThreadIds: [],
        lastUsedWorkspace: "/work/zen",
      },
    }),
  );
  assert.match(html, /title="\/work\/zen">zen</u);
  assert.match(html, /aria-label="New thread in zen"/u);
  assert.match(html, /aria-label="More actions for zen"/u);
  assert.doesNotMatch(html, />Default</u);
  assert.doesNotMatch(html, /aria-label="Remove zen from ZenX"/u);
});

test("a grouped thread exposes its real working directory without changing its Project start path", async () => {
  Object.assign(globalThis, { React });
  const { Sidebar } = await import("../src/renderer/src/Sidebar.js");
  const thread: NativeThreadSummary = {
    threadId: "linked-id",
    name: "Feature",
    preview: "",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "idle",
    currentMetadata: {
      cwd: "/fixture/linked",
      model: "fixture-model",
      provider: "fixture",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(Sidebar, {
      ...baseProps,
      threads: [thread],
      projects: {
        projects: [
          {
            key: "/fixture/zen",
            workspace: "/fixture/zen",
            name: "Zen",
            configured: true,
            isDefault: true,
            threadIds: [thread.threadId],
          },
        ],
        unavailableThreadIds: [],
        lastUsedWorkspace: "/fixture/zen",
      },
    }),
  );
  assert.match(html, /Directory · linked/u);
  assert.match(html, /Working directory: \/fixture\/linked/u);
  assert.match(html, /aria-label="New thread in Zen"/u);
});

test("projectless-only sidebar renders its durable chat after reload without any configured Project", async () => {
  Object.assign(globalThis, { React });
  const { Sidebar } = await import("../src/renderer/src/Sidebar.js");
  const thread: NativeThreadSummary = {
    threadId: "owned",
    name: "My independent chat",
    preview: "",
    archived: false,
    status: "idle",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    currentMetadata: {
      cwd: "/synthetic/Documents/ZenX/date/report",
      model: "fixture",
      provider: "fixture",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(Sidebar, {
      ...baseProps,
      threads: [thread],
      projects: {
        projects: [],
        projectlessThreadIds: ["owned"],
        unavailableThreadIds: [],
        lastUsedWorkspace: null,
      },
    }),
  );
  assert.match(html, /My independent chat/u);
  assert.match(html, /No project/u);
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    assert.ok(
      document.querySelector(".projects-zero-state"),
      "real Projects remain empty",
    );
    assert.equal(
      document.querySelectorAll("[data-project-key]").length,
      0,
      "no synthetic No project folder is introduced",
    );
    const recent = document.querySelectorAll(
      '.recent-thread-group [data-thread-id="owned"]',
    );
    assert.equal(
      recent.length,
      1,
      "the durable independent chat is reachable once in Recent",
    );
    assert.match(recent[0]!.textContent ?? "", /My independent chat/u);
    assert.ok(
      recent[0]!.querySelector(".thread-row"),
      "the existing conversation has a navigation control",
    );
  } finally {
    dom.window.close();
  }
  // Recent keeps the directory in the existing details menu, rather than
  // duplicating a projectless folder row solely to carry a directory label.
  const interactive = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://localhost",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
  };
  Object.assign(globalThis, {
    window: interactive.window,
    document: interactive.window.document,
    HTMLElement: interactive.window.HTMLElement,
    Node: interactive.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(async () =>
      root.render(
        React.createElement(Sidebar, {
          ...baseProps,
          threads: [thread],
          projects: {
            projects: [],
            projectlessThreadIds: ["owned"],
            unavailableThreadIds: [],
            lastUsedWorkspace: null,
          },
        }),
      ),
    );
    const menu = document.querySelector<HTMLButtonElement>(
      '.recent-thread-group [data-thread-id="owned"] .thread-menu-trigger',
    );
    assert.ok(menu, "Recent retains the actual Thread menu");
    await React.act(async () => menu.click());
    assert.match(
      document.querySelector(".thread-menu-information")?.textContent ?? "",
      /\/synthetic\/Documents\/ZenX\/date\/report/u,
      "the original durable working directory is available through Recent details",
    );
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    interactive.window.close();
  }
});
