import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";

export type SidebarMode = "inbox" | "projects";
export type ThreadScope = "active" | "archived";

interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface InboxSection {
  key: "needs" | "active" | "watching" | "settled";
  label: string;
  threads: NativeThreadSummary[];
}

export interface ProjectGroup {
  key: string;
  label: string;
  threads: NativeThreadSummary[];
}

export interface ThreadModelIdentity {
  label: string;
  providerKind: "openai" | "anthropic" | "google" | "local" | "generic";
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

export function readThreadScope(
  storage: Pick<SidebarStorage, "getItem">,
): ThreadScope {
  return storage.getItem("zenx-thread-scope") === "archived"
    ? "archived"
    : "active";
}

export function writeThreadScope(
  storage: Pick<SidebarStorage, "setItem">,
  scope: ThreadScope,
): void {
  storage.setItem("zenx-thread-scope", scope);
}

export function deriveInboxSections(
  threads: readonly NativeThreadSummary[],
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
          thread.status === "systemError" ||
          pendingApprovalThreadIds.has(thread.threadId),
      ),
    },
    {
      key: "active",
      label: "In progress",
      threads: sorted.filter(
        (thread) =>
          thread.status === "active" &&
          !pendingApprovalThreadIds.has(thread.threadId),
      ),
    },
    {
      key: "watching",
      label: "Watching",
      threads: sorted.filter(
        (thread) =>
          thread.status === "idle" &&
          watchingThreadIds.has(thread.threadId) &&
          !pendingApprovalThreadIds.has(thread.threadId),
      ),
    },
    {
      key: "settled",
      label: "Completed",
      threads: sorted.filter(
        (thread) =>
          thread.status === "idle" &&
          !watchingThreadIds.has(thread.threadId) &&
          !pendingApprovalThreadIds.has(thread.threadId),
      ),
    },
  ];
}

export function deriveProjectGroups(
  threads: readonly NativeThreadSummary[],
): ProjectGroup[] {
  const groups = new Map<string, NativeThreadSummary[]>();
  for (const thread of sortByRecency(threads)) {
    const cwd =
      thread.status === "systemError" ? "" : thread.currentMetadata.cwd;
    const key = cwd.length === 0 ? "__unavailable__" : cwd;
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

export function threadTitle(thread: NativeThreadSummary): string {
  const named = thread.name?.trim() ?? "";
  const preview = thread.preview.trim();
  const wakeup = wakeupLabel(named) ?? wakeupLabel(preview);
  if (wakeup !== null) return wakeup;
  if (named.length > 0) return named;
  if (preview.length > 0) return preview;
  return thread.status === "systemError"
    ? `Unavailable thread · ${thread.threadId.slice(0, 8)}`
    : "Untitled thread";
}

export function threadPreview(thread: NativeThreadSummary): string {
  const preview = thread.preview.trim();
  const wakeup = wakeupLabel(preview) ?? wakeupLabel(thread.name ?? "");
  return wakeup === null ? preview : `${wakeup} · system-level wakeup`;
}

export function threadProject(thread: NativeThreadSummary): string {
  if (thread.status === "systemError") return "Unavailable journal";
  return projectLabel(thread.currentMetadata.cwd);
}

export function threadModelIdentity(
  thread: NativeThreadSummary,
): ThreadModelIdentity | null {
  if (thread.status === "systemError") return null;
  const model = thread.currentMetadata.model.trim();
  const provider = thread.currentMetadata.provider.toLocaleLowerCase();
  if (model.length === 0) return null;
  if (model.toLocaleLowerCase() === "fake") {
    return { label: "Local demo", providerKind: "local" };
  }
  const normalized = model
    .replace(/^gpt-/iu, "GPT-")
    .replace(/^claude-/iu, "Claude ")
    .replace(/^gemini-/iu, "Gemini ");
  const providerKind =
    provider.includes("openai") || /^gpt-/iu.test(model)
      ? "openai"
      : provider.includes("anthropic") || /^claude/iu.test(model)
        ? "anthropic"
        : provider.includes("google") || /^gemini/iu.test(model)
          ? "google"
          : provider.includes("local")
            ? "local"
            : "generic";
  return { label: normalized, providerKind };
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

function sortByRecency(
  threads: readonly NativeThreadSummary[],
): NativeThreadSummary[] {
  return [...threads].sort((left, right) => {
    const leftTime = left.updatedAt === null ? 0 : Date.parse(left.updatedAt);
    const rightTime =
      right.updatedAt === null ? 0 : Date.parse(right.updatedAt);
    return rightTime - leftTime || left.threadId.localeCompare(right.threadId);
  });
}

function projectLabel(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/u, "");
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? cwd;
}
