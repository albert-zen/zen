import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
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
  assert.match(html, /Add project first/u);
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
