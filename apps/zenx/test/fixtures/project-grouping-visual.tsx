// Isolated visual acceptance fixture: production Sidebar component, synthetic Git worktree summaries.
// The real temporary Git repository and actual grouping are tested in project-projection.test.ts.
import React from "react";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

const before = new URLSearchParams(location.search).has("before");
const paths = ["/fixture/zen", "/fixture/linked-one", "/fixture/linked-two"];
const threads: NativeThreadSummary[] = paths.map((cwd, index) => ({
  threadId: `work-${index + 1}`,
  name: ["Zen · main", "Feature · worktree 1", "Review · worktree 2"][index],
  preview: "",
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: `2026-01-01T00:00:0${index}.000Z`,
  status: "idle",
  currentMetadata: {
    cwd,
    model: "fixture-model",
    provider: "fixture",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  },
}));
const projects = before
  ? paths.map((workspace, index) => ({
      key: workspace,
      workspace,
      configured: true,
      isDefault: index === 0,
      ...(index === 0 ? { name: "Zen" } : {}),
      threadIds: [threads[index]!.threadId],
    }))
  : [
      {
        key: paths[0]!,
        workspace: paths[0]!,
        name: "Zen",
        configured: true,
        isDefault: true,
        threadIds: threads.map((thread) => thread.threadId),
      },
    ];
const noop = () => undefined;
createRoot(document.getElementById("root")!).render(
  <>
    <p
      style={{
        position: "absolute",
        left: 360,
        top: 30,
        color: "#b4b6bd",
        fontFamily: "sans-serif",
      }}
    >
      Isolated production Sidebar fixture · {before ? "before" : "after"} · 3
      IDs / 3 cwd unchanged
    </p>
    <Sidebar
      liveThread={null}
      mode="projects"
      open
      onClose={noop}
      onNewThread={noop}
      onAddProject={noop}
      onRemoveProject={noop}
      onSetDefaultProject={noop}
      onOpenContribution={noop}
      onOpenSettings={noop}
      onChangeThreadLifecycle={async () => undefined}
      onChangeThreadPinned={async () => undefined}
      onRenameThread={async () => undefined}
      onRetryThreads={noop}
      onSelectThread={noop}
      pendingApprovalThreadIds={new Set()}
      pinnedThreads={[]}
      pluginContributions={[]}
      selectedPage="agent"
      selectedThreadId={null}
      serverStatus={{ type: "ready", reconnected: false }}
      threadError={null}
      threadLoading={false}
      threads={threads}
      projects={{
        projects,
        unavailableThreadIds: [],
        lastUsedWorkspace: paths[0]!,
      }}
    />
  </>,
);
