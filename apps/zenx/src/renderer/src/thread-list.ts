import type {
  ServerNotificationMethod,
  ServerNotificationParams,
  Thread,
} from "../../protocol-client/index.js";

export type SidebarMode = "inbox" | "projects";

interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface InboxSection {
  key: "needs" | "active" | "settled";
  label: string;
  threads: Thread[];
}

export interface ProjectGroup {
  key: string;
  label: string;
  threads: Thread[];
}

export function readSidebarMode(
  storage: Pick<SidebarStorage, "getItem">,
): SidebarMode {
  return storage.getItem("zenx-sidebar-mode") === "projects"
    ? "projects"
    : "inbox";
}

export function writeSidebarMode(
  storage: Pick<SidebarStorage, "setItem">,
  mode: SidebarMode,
): void {
  storage.setItem("zenx-sidebar-mode", mode);
}

export function deriveInboxSections(
  threads: readonly Thread[],
  pendingApprovalThreadIds: ReadonlySet<string> = new Set(),
): InboxSection[] {
  const sorted = sortByRecency(threads);
  return [
    {
      key: "needs",
      label: "Needs you",
      threads: sorted.filter(
        (thread) =>
          thread.status.type === "systemError" ||
          pendingApprovalThreadIds.has(thread.id),
      ),
    },
    {
      key: "active",
      label: "In progress",
      threads: sorted.filter(
        (thread) =>
          thread.status.type === "active" &&
          !pendingApprovalThreadIds.has(thread.id),
      ),
    },
    {
      key: "settled",
      label: "Completed",
      threads: sorted.filter(
        (thread) =>
          thread.status.type === "idle" &&
          !pendingApprovalThreadIds.has(thread.id),
      ),
    },
  ];
}

export function deriveProjectGroups(
  threads: readonly Thread[],
): ProjectGroup[] {
  const groups = new Map<string, Thread[]>();
  for (const thread of sortByRecency(threads)) {
    const key =
      thread.status.type === "systemError" || thread.cwd.length === 0
        ? "__unavailable__"
        : thread.cwd;
    const list = groups.get(key) ?? [];
    list.push(thread);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, groupedThreads]) => ({
      key,
      label:
        key === "__unavailable__" ? "Unavailable journals" : projectLabel(key),
      threads: groupedThreads,
    }))
    .sort((left, right) => {
      if (left.key === "__unavailable__") return 1;
      if (right.key === "__unavailable__") return -1;
      return left.label.localeCompare(right.label);
    });
}

export function applyThreadNotification(
  threads: readonly Thread[],
  method: ServerNotificationMethod,
  params: ServerNotificationParams[ServerNotificationMethod],
  nowSeconds = Math.floor(Date.now() / 1_000),
): Thread[] {
  if (method === "thread/started") {
    const started = (params as ServerNotificationParams["thread/started"])
      .thread;
    return [started, ...threads.filter((thread) => thread.id !== started.id)];
  }
  if (method === "thread/name/updated") {
    const update = params as ServerNotificationParams["thread/name/updated"];
    return threads.map((thread) =>
      thread.id === update.threadId
        ? { ...thread, name: update.threadName, updatedAt: nowSeconds }
        : thread,
    );
  }
  if (method === "turn/started") {
    const event = params as ServerNotificationParams["turn/started"];
    return threads.map((thread) =>
      thread.id === event.threadId && thread.status.type !== "systemError"
        ? {
            ...thread,
            status: { type: "active" as const, activeFlags: [] },
            updatedAt: nowSeconds,
          }
        : thread,
    );
  }
  if (method === "item/completed") {
    const event = params as ServerNotificationParams["item/completed"];
    if (event.item.type !== "userMessage") return [...threads];
    const preview = event.item.content
      .map((content) => content.text)
      .join("\n");
    return threads.map((thread) =>
      thread.id === event.threadId && thread.status.type !== "systemError"
        ? { ...thread, preview, updatedAt: nowSeconds }
        : thread,
    );
  }
  if (method === "turn/completed") {
    const event = params as ServerNotificationParams["turn/completed"];
    return threads.map((thread) =>
      thread.id === event.threadId && thread.status.type !== "systemError"
        ? {
            ...thread,
            status: { type: "idle" as const },
            updatedAt: nowSeconds,
          }
        : thread,
    );
  }
  return [...threads];
}

export function threadTitle(thread: Thread): string {
  if (thread.name !== null && thread.name.trim().length > 0) return thread.name;
  if (thread.preview.trim().length > 0) return thread.preview;
  return thread.status.type === "systemError"
    ? `Unavailable thread · ${thread.id.slice(0, 8)}`
    : "Untitled thread";
}

function sortByRecency(threads: readonly Thread[]): Thread[] {
  return [...threads].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  );
}

function projectLabel(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/u, "");
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? cwd;
}
