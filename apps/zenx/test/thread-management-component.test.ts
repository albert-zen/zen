import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
const { createElement } = React;
Object.assign(globalThis, { React });
const { Sidebar, ThreadItemMenu } =
  await import("../src/renderer/src/Sidebar.js");

const noop = () => undefined;

test("sidebar shows only active Threads and routes Settings as navigation", () => {
  const active = renderSidebar([summary(false)]);
  assert.doesNotMatch(active, /aria-label="Thread views"/u);
  assert.doesNotMatch(active, />Active<\/button>/u);
  assert.doesNotMatch(active, />Archived<\/button>/u);
  assert.match(active, /aria-haspopup="menu"/u);
  assert.match(active, /class="settings-nav-row"/u);
  assert.match(active, />Settings<\/span>/u);
});

test("sidebar announces Thread query failures with a retry action", () => {
  const html = renderSidebar([], {
    error: "summary projection unavailable",
  });
  assert.match(html, /role="alert"/u);
  assert.match(html, /summary projection unavailable/u);
  assert.match(html, />Try again</u);
});

test("sidebar announces active Thread loading", () => {
  const html = renderSidebar([], { loading: true });
  assert.match(html, /role="status"/u);
  assert.match(html, /Loading active Threads…/u);
});

test("active Thread menu offers Rename and a safely disabled Archive", () => {
  const html = renderToStaticMarkup(
    createElement(ThreadItemMenu, {
      archived: false,
      busyAction: null,
      error: null,
      hasActiveTurn: true,
      open: true,
      pinned: false,
      renaming: false,
      renameDraft: "Active Thread",
      onArchive: noop,
      onBeginRename: noop,
      onCancelRename: noop,
      onDraftChange: noop,
      onPin: noop,
      onRename: noop,
      onUnarchive: noop,
    }),
  );
  assert.match(html, /role="menu"/u);
  assert.match(html, />Rename</u);
  assert.match(html, />Pin<\/button>/u);
  assert.match(
    html,
    /role="menuitem"[^>]*disabled=""[^>]*>[\s\S]*?Archive<\/button>/u,
  );
  assert.match(html, /Wait for the active Turn to finish before archiving/u);
});

test("archived Thread menu offers Unarchive without inventing Delete", () => {
  const html = renderToStaticMarkup(
    createElement(ThreadItemMenu, {
      archived: true,
      busyAction: "unarchive",
      error: null,
      hasActiveTurn: false,
      open: true,
      pinned: false,
      renaming: false,
      renameDraft: "Archived Thread",
      onArchive: noop,
      onBeginRename: noop,
      onCancelRename: noop,
      onDraftChange: noop,
      onPin: noop,
      onRename: noop,
      onUnarchive: noop,
    }),
  );
  assert.match(html, />Unarchiving…</u);
  assert.doesNotMatch(html, />Delete</u);
  assert.doesNotMatch(html, />Rename</u);
  assert.doesNotMatch(html, />Pin<\/button>/u);
});

function renderSidebar(
  threads: NativeThreadSummary[],
  state: { error?: string; loading?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
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
      onChangeThreadLifecycle: async () => undefined,
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
      pinnedThreads: [],
      selectedPage: "agent",
      selectedThreadId: null,
      serverStatus: { type: "ready", reconnected: false },
      threadError: state.error ?? null,
      threadLoading: state.loading ?? false,
      threads,
    }),
  );
}

function summary(archived: boolean): NativeThreadSummary {
  return {
    threadId: archived ? "archived-thread" : "active-thread",
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd: "/work/zen",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    preview: "Thread preview",
    status: "idle",
  };
}
