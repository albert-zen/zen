import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import { ThreadLifecycleAction } from "../src/renderer/src/ThreadLifecycleAction.js";
import { Sidebar, ThreadItemMenu } from "../src/renderer/src/Sidebar.js";

const noop = () => undefined;

test("sidebar exposes distinct Active and Archived Thread views", () => {
  const active = renderSidebar("active", [summary(false)]);
  assert.match(active, /role="tablist" aria-label="Thread views"/u);
  assert.match(active, />Active</u);
  assert.match(active, />Archived</u);
  assert.match(active, /aria-selected="true"[^>]*>Active/u);
  assert.match(active, /aria-haspopup="menu"/u);

  const archived = renderSidebar("archived", []);
  assert.match(archived, /aria-selected="true"[^>]*>Archived/u);
  assert.match(archived, /No archived Threads yet/u);
});

test("sidebar announces Thread query failures with a retry action", () => {
  const html = renderSidebar("archived", [], {
    error: "summary projection unavailable",
  });
  assert.match(html, /role="alert"/u);
  assert.match(html, /summary projection unavailable/u);
  assert.match(html, />Try again</u);
});

test("sidebar announces which Thread view is loading", () => {
  const html = renderSidebar("archived", [], { loading: true });
  assert.match(html, /role="status"/u);
  assert.match(html, /Loading archived Threads…/u);
});

test("Thread lifecycle action is reversible and honest about active Turns", () => {
  const idle = renderToStaticMarkup(
    createElement(ThreadLifecycleAction, {
      archived: false,
      busy: false,
      hasActiveTurn: false,
      onChange: async () => undefined,
    }),
  );
  assert.match(idle, />Archive</u);

  const running = renderToStaticMarkup(
    createElement(ThreadLifecycleAction, {
      archived: false,
      busy: false,
      hasActiveTurn: true,
      onChange: async () => undefined,
    }),
  );
  assert.match(running, /disabled=""/u);
  assert.match(running, /Wait for the active Turn to finish before archiving/u);

  const archived = renderToStaticMarkup(
    createElement(ThreadLifecycleAction, {
      archived: true,
      busy: true,
      hasActiveTurn: false,
      onChange: async () => undefined,
    }),
  );
  assert.match(archived, />Unarchiving…</u);
  assert.doesNotMatch(archived, />Delete</u);
});

test("active Thread menu offers Rename and a safely disabled Archive", () => {
  const html = renderToStaticMarkup(
    createElement(ThreadItemMenu, {
      archived: false,
      busyAction: null,
      error: null,
      hasActiveTurn: true,
      open: true,
      renaming: false,
      renameDraft: "Active Thread",
      onArchive: noop,
      onBeginRename: noop,
      onCancelRename: noop,
      onDraftChange: noop,
      onRename: noop,
      onUnarchive: noop,
    }),
  );
  assert.match(html, /role="menu"/u);
  assert.match(html, />Rename</u);
  assert.match(
    html,
    /role="menuitem" disabled=""[^>]*>[\s\S]*?Archive<\/button>/u,
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
      renaming: false,
      renameDraft: "Archived Thread",
      onArchive: noop,
      onBeginRename: noop,
      onCancelRename: noop,
      onDraftChange: noop,
      onRename: noop,
      onUnarchive: noop,
    }),
  );
  assert.match(html, />Unarchiving…</u);
  assert.doesNotMatch(html, />Delete</u);
  assert.doesNotMatch(html, />Rename</u);
});

function renderSidebar(
  scope: "active" | "archived",
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
      onOpenContribution: noop,
      onOpenSettings: noop,
      onChangeThreadLifecycle: async () => undefined,
      onRenameThread: async () => undefined,
      onRetryThreads: noop,
      onSelectThread: noop,
      onThreadScopeChange: noop,
      pendingApprovalThreadIds: new Set<string>(),
      pluginContributions: [],
      selectedPage: "agent",
      selectedThreadId: null,
      serverReady: true,
      threadError: state.error ?? null,
      threadLoading: state.loading ?? false,
      threadScope: scope,
      threads,
      triggerSnapshot: { triggers: [], history: [], rooms: [] },
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
