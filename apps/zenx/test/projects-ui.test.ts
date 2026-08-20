import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

const baseProps = {
  liveThread: null,
  mode: "projects" as const,
  open: true,
  onClose: () => undefined,
  onModeChange: () => undefined,
  onNewThread: () => undefined,
  onAddProject: () => undefined,
  onRemoveProject: () => undefined,
  onSetDefaultProject: () => undefined,
  onChangeThreadLifecycle: async () => undefined,
  onChangeThreadPin: async () => undefined,
  onRenameThread: async () => undefined,
  onRetryThreads: () => undefined,
  onOpenContribution: () => undefined,
  onOpenSettings: () => undefined,
  onSelectThread: () => undefined,
  pendingApprovalThreadIds: new Set<string>(),
  pinnedThreadIds: [],
  pluginContributions: [],
  selectedPage: "agent" as const,
  selectedThreadId: null,
  serverReady: true,
  threadError: null,
  threadLoading: false,
  threadScope: "active" as const,
  onThreadScopeChange: () => undefined,
  threads: [],
  triggerSnapshot: { triggers: [], history: [], rooms: [] },
};

test("no-project sidebar keeps explicit Add project and non-creating New thread guidance", async () => {
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
  assert.match(html, />Add project</u);
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
  assert.match(html, /Remove zen from ZenX/u);
});
