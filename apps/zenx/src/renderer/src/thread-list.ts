import type { AgentSessionBinding } from "../../main/agent-providers/types.js";
import { agentSessionNavigationId } from "../../main/conversation-navigation.js";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { Thread } from "../../protocol-client/index.js";
import type { ZenXProjectProjectionSnapshot } from "../../main/project-projection.js";
import type { ZenXSidebarOrder } from "../../main/host-profile.js";
import {
  providerLogoKindForIdentity,
  type ProviderLogoKind,
} from "./ProviderLogo.js";

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

export interface AgentNavigationSession {
  binding: AgentSessionBinding;
  providerLabel: string;
  title?: string;
  model?: string;
  /** Unknown until observed from the native engine. */
  status?: "active" | "idle" | "error";
  updatedAt?: number;
  pendingApproval?: boolean;
}

export type ConversationNavigationRow =
  | { kind: "zen"; id: string; thread: NativeThreadSummary }
  | { kind: "agent"; id: string; session: AgentNavigationSession };

export interface ProjectGroup {
  key: string;
  label: string;
  threads: NativeThreadSummary[];
  rows: ConversationNavigationRow[];
  workspace: string | null;
  configured: boolean;
  isDefault: boolean;
}

export interface ThreadModelIdentity {
  label: string;
  providerKind: ProviderLogoKind;
}

export type SidebarOrderPlacement = "before" | "after";

export const EMPTY_SIDEBAR_ORDER: ZenXSidebarOrder = {
  projectKeys: [],
  threadIdsByProject: {},
};

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

/** Native state is shown only when observed; unread sessions are not called completed. */
export function deriveConversationInboxSections(
  threads: readonly NativeThreadSummary[],
  sessions: readonly AgentNavigationSession[],
  pendingApprovalThreadIds: ReadonlySet<string>,
  watchingThreadIds: ReadonlySet<string>,
): Array<{ key: string; label: string; rows: ConversationNavigationRow[] }> {
  const sections = deriveInboxSections(
    threads,
    pendingApprovalThreadIds,
    watchingThreadIds,
  ).map((section) => ({
    key: section.key as string,
    label: section.label,
    rows: section.threads.map((thread): ConversationNavigationRow => ({
      kind: "zen",
      id: thread.threadId,
      thread,
    })),
  }));
  const unknown: ConversationNavigationRow[] = [];
  for (const session of sessions) {
    const row: ConversationNavigationRow = {
      kind: "agent",
      id: agentSessionNavigationId(session.binding.id),
      session,
    };
    const key =
      session.pendingApproval || session.status === "error"
        ? "needs"
        : session.status === "active"
          ? "active"
          : session.status === "idle"
            ? "settled"
            : null;
    if (key === null) unknown.push(row);
    else sections.find((section) => section.key === key)!.rows.push(row);
  }
  for (const section of sections)
    section.rows.sort(
      (left, right) =>
        rowRecency(right) - rowRecency(left) || left.id.localeCompare(right.id),
    );
  if (unknown.length)
    sections.push({ key: "unobserved", label: "Conversations", rows: unknown });
  return sections;
}

export function deriveProjectGroups(
  threads: readonly NativeThreadSummary[],
  projection: ZenXProjectProjectionSnapshot,
  preference: ZenXSidebarOrder = EMPTY_SIDEBAR_ORDER,
  sessions: readonly AgentNavigationSession[] = [],
): ProjectGroup[] {
  const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
  const agentById = new Map(
    sessions.map((session) => [
      agentSessionNavigationId(session.binding.id),
      session,
    ]),
  );
  const rowsFor = (
    ids: readonly string[],
    preferred: readonly string[] = [],
  ): ConversationNavigationRow[] => {
    const rows: ConversationNavigationRow[] = ids.flatMap(
      (id): ConversationNavigationRow[] => {
        const thread = byId.get(id);
        if (thread) return [{ kind: "zen", id, thread }];
        const session = agentById.get(id);
        return session ? [{ kind: "agent", id, session }] : [];
      },
    );
    rows.sort(
      (left, right) =>
        rowRecency(right) - rowRecency(left) || left.id.localeCompare(right.id),
    );
    return orderByPreference(rows, preferred, (row) => row.id);
  };
  const groups: ProjectGroup[] = projection.projects
    .map((project) => {
      const stableThreads = sortByRecency(
        project.threadIds.flatMap((threadId) => {
          const thread = byId.get(threadId);
          return thread === undefined ? [] : [thread];
        }),
      );
      return {
        key: project.key,
        rows: rowsFor(
          project.threadIds,
          preference.threadIdsByProject[project.key] ?? [],
        ),
        label: project.name ?? projectLabel(project.workspace),
        workspace: project.workspace,
        configured: project.configured,
        isDefault: project.isDefault,
        threads: orderByPreference(
          stableThreads,
          preference.threadIdsByProject[project.key] ?? [],
          (thread) => thread.threadId,
        ),
      };
    })
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.key.localeCompare(right.key),
    );
  const orderedGroups = orderByPreference(
    groups,
    preference.projectKeys,
    (group) => group.key,
  );
  const pinnedKeys = new Set(preference.pinnedProjectKeys ?? []);
  orderedGroups.sort(
    (left, right) =>
      Number(pinnedKeys.has(right.key)) - Number(pinnedKeys.has(left.key)),
  );
  const unavailable = projection.unavailableThreadIds.flatMap((threadId) => {
    const thread = byId.get(threadId);
    return thread === undefined ? [] : [thread];
  });
  if (unavailable.length > 0)
    orderedGroups.push({
      key: "__unavailable__",
      label: "Unavailable journals",
      workspace: null,
      configured: false,
      isDefault: false,
      threads: unavailable,
      rows: rowsFor(projection.unavailableThreadIds),
    });
  return orderedGroups;
}

export function moveSidebarProject(
  preference: ZenXSidebarOrder,
  projection: ZenXProjectProjectionSnapshot,
  sourceKey: string,
  targetKey: string,
  placement: SidebarOrderPlacement,
): ZenXSidebarOrder {
  const pins = new Set(preference.pinnedProjectKeys ?? []);
  if (pins.has(sourceKey) !== pins.has(targetKey)) return preference;
  const stableProjects = projection.projects
    .map((project) => ({
      key: project.key,
      label: project.name ?? projectLabel(project.workspace),
    }))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.key.localeCompare(right.key),
    );
  const order = orderByPreference(
    stableProjects,
    preference.projectKeys,
    (project) => project.key,
  ).map((project) => project.key);
  const moved = moveIdentifier(order, sourceKey, targetKey, placement);
  if (moved === null) return preference;
  return {
    ...preference,
    projectKeys: moved,
    threadIdsByProject: preference.threadIdsByProject,
  };
}

export function moveSidebarThread(
  preference: ZenXSidebarOrder,
  threads: readonly NativeThreadSummary[],
  projection: ZenXProjectProjectionSnapshot,
  sourceProjectKey: string,
  sourceThreadId: string,
  targetProjectKey: string,
  targetThreadId: string,
  placement: SidebarOrderPlacement,
): ZenXSidebarOrder {
  if (sourceProjectKey !== targetProjectKey) return preference;
  const project = projection.projects.find(
    (candidate) => candidate.key === sourceProjectKey,
  );
  if (
    project === undefined ||
    !project.threadIds.includes(sourceThreadId) ||
    !project.threadIds.includes(targetThreadId)
  ) {
    return preference;
  }
  const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
  const stableThreads = sortByRecency(
    project.threadIds.flatMap((threadId) => {
      const thread = byId.get(threadId);
      return thread === undefined ? [] : [thread];
    }),
  );
  const order = orderByPreference(
    stableThreads,
    preference.threadIdsByProject[sourceProjectKey] ?? [],
    (thread) => thread.threadId,
  ).map((thread) => thread.threadId);
  const moved = moveIdentifier(
    order,
    sourceThreadId,
    targetThreadId,
    placement,
  );
  if (moved === null) return preference;
  return {
    ...preference,
    projectKeys: preference.projectKeys,
    threadIdsByProject: {
      ...preference.threadIdsByProject,
      [sourceProjectKey]: moved,
    },
  };
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
  const providerKind = providerLogoKindForIdentity(provider, model);
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
    const leftTime =
      left.createdAt === null
        ? 0
        : Date.parse(left.turnSortAt ?? left.createdAt);
    const rightTime =
      right.createdAt === null
        ? 0
        : Date.parse(right.turnSortAt ?? right.createdAt);
    return rightTime - leftTime || left.threadId.localeCompare(right.threadId);
  });
}

function orderByPreference<T>(
  stableItems: readonly T[],
  preferredIds: readonly string[],
  identify: (item: T) => string,
): T[] {
  const byId = new Map(stableItems.map((item) => [identify(item), item]));
  const ordered: T[] = [];
  const included = new Set<string>();
  for (const id of preferredIds) {
    const item = byId.get(id);
    if (item === undefined || included.has(id)) continue;
    included.add(id);
    ordered.push(item);
  }
  for (const item of stableItems) {
    const id = identify(item);
    if (included.has(id)) continue;
    included.add(id);
    ordered.push(item);
  }
  return ordered;
}

function moveIdentifier(
  current: readonly string[],
  sourceId: string,
  targetId: string,
  placement: SidebarOrderPlacement,
): string[] | null {
  if (sourceId === targetId) return null;
  const sourceIndex = current.indexOf(sourceId);
  const targetIndex = current.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) return null;
  const moved = [...current];
  moved.splice(sourceIndex, 1);
  const remainingTargetIndex = moved.indexOf(targetId);
  moved.splice(
    placement === "after" ? remainingTargetIndex + 1 : remainingTargetIndex,
    0,
    sourceId,
  );
  return moved.every((id, index) => id === current[index]) ? null : moved;
}

function projectLabel(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/u, "");
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function rowRecency(row: ConversationNavigationRow): number {
  if (row.kind === "agent") return row.session.updatedAt ?? 0;
  const time =
    row.thread.status === "systemError"
      ? row.thread.createdAt
      : (row.thread.turnSortAt ?? row.thread.createdAt);
  return time === null ? 0 : Date.parse(time);
}
