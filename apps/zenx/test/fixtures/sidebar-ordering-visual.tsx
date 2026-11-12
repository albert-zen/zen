import { installScrollbarVisibility } from "../../src/renderer/src/scrollbar-visibility.js";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import type { ZenXSidebarOrder } from "../../src/main/host-profile.js";
import type { ZenXProjectProjectionSnapshot } from "../../src/main/project-projection.js";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import {
  moveSidebarProject,
  moveSidebarThread,
  type SidebarOrderPlacement,
} from "../../src/renderer/src/thread-list.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
installScrollbarVisibility(document);
const { createElement } = React;
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
    serverStatus: { type: "ready", reconnected: false },
    threadError: null,
    threadLoading: false,
    threads,
  });
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

function previewInsertion(kind: "project" | "thread") {
  const source = document.querySelector(
    kind === "project"
      ? '[data-project-key="/work/b"] .project-toggle'
      : '[data-thread-id="idle"]',
  )!;
  const target = document.querySelector(
    kind === "project"
      ? '[data-project-key="/work/a"] .project-header'
      : '[data-thread-id="active"]',
  )!;
  const dataTransfer = new DataTransfer();
  source.dispatchEvent(
    new DragEvent("dragend", { bubbles: true, dataTransfer }),
  );
  source.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, dataTransfer }),
  );
  target.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientY: target.getBoundingClientRect().top + 2,
    }),
  );
}

createRoot(document.getElementById("root")!).render(
  <main style={{ display: "flex", height: "100vh" }}>
    <OrderingSidebar />
    <div style={{ padding: 40 }}>
      <h1>Sidebar ordering</h1>
      <p>Drag project titles or thread rows. Alt + Up / Down also reorders.</p>
      <button
        onClick={() =>
          (document.documentElement.dataset.appearance =
            document.documentElement.dataset.appearance === "dark"
              ? "light"
              : "dark")
        }
      >
        Toggle theme
      </button>
      <button onClick={() => previewInsertion("project")}>
        Preview project insertion
      </button>
      <button onClick={() => previewInsertion("thread")}>
        Preview thread insertion
      </button>
      <p>Fixture only; no live tasks or profile writes.</p>
    </div>
  </main>,
);
