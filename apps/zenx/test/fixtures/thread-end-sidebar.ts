import type { ComponentProps } from "react";
import type { Sidebar } from "../../src/renderer/src/Sidebar.js";
import type {
  NativeThreadSummary,
  ThreadSummary,
} from "../../../../src/thread-summary.js";

const noop = () => {};
export function threadEndSidebarProps(
  threads: NativeThreadSummary[],
  unreadThreadIds: ReadonlySet<string>,
): ComponentProps<typeof Sidebar> {
  return {
    mode: "projects",
    open: true,
    onClose: noop,
    onChangeThreadLifecycle: async () => {},
    onChangeThreadPinned: async () => {},
    onNewThread: noop,
    onAddProject: noop,
    onRemoveProject: noop,
    onSetDefaultProject: noop,
    onOpenContribution: noop,
    onOpenSettings: noop,
    onRetryThreads: noop,
    onRenameThread: async () => {},
    onSelectThread: noop,
    pendingApprovalThreadIds: new Set(),
    pluginContributions: [],
    selectedPage: "agent",
    selectedThreadId: null,
    serverStatus: { type: "ready", reconnected: false },
    liveThread: null,
    threadError: null,
    threadLoading: false,
    projects: {
      projects: [],
      unavailableThreadIds: [],
      lastUsedWorkspace: null,
    },
    threads,
    pinnedThreads: threads,
    unreadThreadIds,
  };
}

export function syntheticEndThreads(): ThreadSummary[] {
  return [
    ["completed", "Normal completion · unread", "idle", "completed"],
    ["failed", "Provider failure · unread", "idle", "failed"],
    ["running", "Running · no end marker", "active", "failed"],
    ["retrying", "Retrying · no end marker", "active", "failed"],
    ["cancelled", "Cancelled by user · unread", "idle", "aborted"],
    ["read", "Failure already viewed", "idle", "failed"],
  ].map(([threadId, name, status, outcome], index) => ({
    threadId: threadId!,
    name: name!,
    status: status as ThreadSummary["status"],
    archived: false,
    createdAt: "2026-10-16T10:00:00.000Z",
    updatedAt: "2026-10-16T10:01:00.000Z",
    preview: "",
    lastTurnEnd: {
      id: `${threadId}-end`,
      turnId: `${threadId}-turn`,
      position: index,
      createdAt: "2026-10-16T10:01:00.000Z",
      status: outcome as NonNullable<ThreadSummary["lastTurnEnd"]>["status"],
    },
    currentMetadata: {
      cwd: "/synthetic",
      model: "fixture",
      provider: "fixture",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
  }));
}
