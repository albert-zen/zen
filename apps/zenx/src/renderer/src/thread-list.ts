import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { Thread } from "../../protocol-client/index.js";
import type { ZenXProjectProjectionSnapshot } from "../../main/project-projection.js";

export type SidebarMode = "inbox" | "projects";

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
  workspace: string | null;
  configured: boolean;
  isDefault: boolean;
}

export interface ThreadModelIdentity {
  label: string;
  providerKind: "openai" | "deepseek" | "qwen" | "local" | "generic";
}

export function derivePinnedThreads(
  threads: readonly NativeThreadSummary[],
  pinnedThreadIds: readonly string[],
): NativeThreadSummary[] {
  const activeById = new Map(
    threads
      .filter((thread) => !thread.archived)
      .map((thread) => [thread.threadId, thread] as const),
  );
  return pinnedThreadIds.flatMap((threadId) => {
    const thread = activeById.get(threadId);
    return thread === undefined ? [] : [thread];
  });
}

export function lastUsedProjectWorkspace(
  projection: ZenXProjectProjectionSnapshot,
): string | null {
  if (projection.lastUsedWorkspace === null) return null;
  return (
    projection.projects.find(
      (project) =>
        project.configured &&
        project.workspace === projection.lastUsedWorkspace,
    )?.workspace ?? null
  );
}

export function projectThreadStartParams(workspace: string | null): {
  cwd: string;
} {
  if (workspace === null)
    throw new Error("Add a Project before creating a Thread");
  return { cwd: workspace };
}

export async function startProjectThread<T>(
  workspace: string,
  start: (params: { cwd: string }) => Promise<T>,
  onStarted: (workspace: string) => void,
): Promise<T> {
  const result = await start(projectThreadStartParams(workspace));
  onStarted(workspace);
  return result;
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

export function threadHasActiveTurn(
  thread: NativeThreadSummary,
  liveThread: Thread | null,
): boolean {
  if (thread.status === "active") return true;
  if (liveThread?.id !== thread.threadId) return false;
  return (
    liveThread.status.type === "active" ||
    liveThread.turns.some((turn) => turn.status === "inProgress")
  );
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
  projection: ZenXProjectProjectionSnapshot,
): ProjectGroup[] {
  const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
  const groups: ProjectGroup[] = projection.projects.map((project) => ({
    key: project.key,
    label: projectLabel(project.workspace),
    workspace: project.workspace,
    configured: project.configured,
    isDefault: project.isDefault,
    threads: sortByRecency(
      project.threadIds.flatMap((threadId) => {
        const thread = byId.get(threadId);
        return thread === undefined ? [] : [thread];
      }),
    ),
  }));
  groups.sort(
    (left, right) =>
      left.label.localeCompare(right.label) ||
      left.key.localeCompare(right.key),
  );
  const unavailable = projection.unavailableThreadIds.flatMap((threadId) => {
    const thread = byId.get(threadId);
    return thread === undefined ? [] : [thread];
  });
  if (unavailable.length > 0)
    groups.push({
      key: "__unavailable__",
      label: "Unavailable journals",
      workspace: null,
      configured: false,
      isDefault: false,
      threads: unavailable,
    });
  return groups;
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
      : provider.includes("deepseek") || /^deepseek/iu.test(model)
        ? "deepseek"
        : provider.includes("qwen") || /^qwen/iu.test(model)
          ? "qwen"
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
