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
  key: "needs" | "active" | "watching" | "settled";
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
  return storage.getItem("zenx-sidebar-mode") === "inbox"
    ? "inbox"
    : "projects";
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
  watchingThreadIds: ReadonlySet<string> = new Set(),
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
      key: "watching",
      label: "Watching",
      threads: sorted.filter(
        (thread) =>
          thread.status.type === "idle" &&
          watchingThreadIds.has(thread.id) &&
          !pendingApprovalThreadIds.has(thread.id),
      ),
    },
    {
      key: "settled",
      label: "Completed",
      threads: sorted.filter(
        (thread) =>
          thread.status.type === "idle" &&
          !watchingThreadIds.has(thread.id) &&
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
  if (method === "thread/archived") {
    const event = params as ServerNotificationParams["thread/archived"];
    return threads.filter((thread) => thread.id !== event.threadId);
  }
  if (method === "thread/settings/updated") {
    const update =
      params as ServerNotificationParams["thread/settings/updated"];
    return threads.map((thread) =>
      thread.id === update.threadId && thread.status.type !== "systemError"
        ? {
            ...thread,
            modelProvider: update.threadSettings.modelProvider,
            updatedAt: nowSeconds,
          }
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
  const named = thread.name?.trim() ?? "";
  const preview = thread.preview.trim();
  const wakeup = wakeupLabel(named) ?? wakeupLabel(preview);
  if (wakeup !== null) return wakeup;
  if (named.length > 0) return named;
  if (preview.length > 0) return preview;
  return thread.status.type === "systemError"
    ? `Unavailable thread · ${thread.id.slice(0, 8)}`
    : "Untitled thread";
}

export function threadPreview(thread: Thread): string {
  const preview = thread.preview.trim();
  const wakeup = wakeupLabel(preview) ?? wakeupLabel(thread.name ?? "");
  return wakeup === null ? preview : `${wakeup} · system-level wakeup`;
}

function wakeupLabel(value: string): string | null {
  if (!value.trimStart().startsWith("[ZenX trigger wakeup]")) return null;
  const sourceThread = /Source Thread:\s*([^\s]+)/u.exec(value)?.[1];
  if (sourceThread !== undefined)
    return `Relay from ${sourceThread.slice(0, 8)}`;
  const sourceRoom = /Source Room:\s*([^\s]+)/u.exec(value)?.[1];
  if (sourceRoom !== undefined)
    return `Room wakeup · ${sourceRoom.slice(0, 8)}`;
  return "Trigger wakeup";
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
