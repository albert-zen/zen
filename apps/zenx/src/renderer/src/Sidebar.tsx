import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { TriggerSnapshot } from "../../main/trigger-types.js";
import type { Thread } from "../../protocol-client/index.js";
import type { ZenXProjectProjectionSnapshot } from "../../main/project-projection.js";
import type { ZenXSidebarOrder } from "../../main/host-profile.js";
import type { AppServerHostStatus } from "../../main/app-server-manager.js";
import { Icon } from "./icons.js";
import type { LoadedPluginContribution } from "./plugin-contributions.js";
import { ProviderLogo } from "./ProviderLogo.js";
import { ZenXBrand } from "./ZenXBrand.js";
import {
  deriveInboxSections,
  deriveProjectGroups,
  EMPTY_SIDEBAR_ORDER,
  threadModelIdentity,
  threadHasActiveTurn,
  threadProject,
  threadTitle,
  type SidebarMode,
  type SidebarOrderPlacement,
} from "./thread-list.js";

interface SidebarProps {
  mode: SidebarMode;
  open: boolean;
  onClose(): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onReorderProject?(
    sourceKey: string,
    targetKey: string,
    placement: SidebarOrderPlacement,
  ): Promise<void>;
  onReorderThread?(
    sourceProjectKey: string,
    sourceThreadId: string,
    targetProjectKey: string,
    targetThreadId: string,
    placement: SidebarOrderPlacement,
  ): Promise<void>;
  onModeChange(mode: SidebarMode): void;
  onNewThread(workspace?: string): void;
  onAddProject(): void;
  onRemoveProject(workspace: string): void;
  onSetDefaultProject(workspace: string): void;
  onOpenContribution(page: "triggers" | "rooms"): void;
  onOpenSettings(): void;
  onRetryThreads(): void;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  pluginContributions: readonly LoadedPluginContribution[];
  selectedPage: "agent" | "triggers" | "rooms" | "settings";
  selectedThreadId: string | null;
  serverStatus: AppServerHostStatus;
  liveThread: Thread | null;
  threadError: string | null;
  threadLoading: boolean;
  projects: ZenXProjectProjectionSnapshot;
  sidebarOrder?: ZenXSidebarOrder;
  pinnedThreads: readonly NativeThreadSummary[];
  threads: readonly NativeThreadSummary[];
  triggerSnapshot: TriggerSnapshot;
}

export function Sidebar({
  mode,
  open,
  onClose,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onReorderProject,
  onReorderThread,
  onModeChange,
  onNewThread,
  onAddProject,
  onRemoveProject,
  onSetDefaultProject,
  onOpenContribution,
  onOpenSettings,
  onRetryThreads,
  onRenameThread,
  onSelectThread,
  pendingApprovalThreadIds,
  pluginContributions,
  selectedPage,
  selectedThreadId,
  serverStatus,
  liveThread,
  threadError,
  threadLoading,
  projects,
  sidebarOrder = EMPTY_SIDEBAR_ORDER,
  pinnedThreads,
  threads,
  triggerSnapshot,
}: SidebarProps) {
  const [sidebarOrderError, setSidebarOrderError] = useState<string | null>(
    null,
  );
  const [sidebarOrderRetry, setSidebarOrderRetry] = useState<
    (() => Promise<void>) | null
  >(null);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [projectChooserOpen, setProjectChooserOpen] = useState(false);
  const lastUsedProject =
    projects.lastUsedWorkspace === null
      ? undefined
      : projects.projects.find(
          (project) =>
            project.configured &&
            project.workspace === projects.lastUsedWorkspace,
        );
  const projectsByKey = new Map(
    projects.projects.map((project) => [project.key, project] as const),
  );
  const configuredProjects = deriveProjectGroups(
    [],
    projects,
    sidebarOrder,
  ).flatMap((group) => {
    const project = projectsByKey.get(group.key);
    return project?.configured === true ? [project] : [];
  });
  const pinnedThreadIds = useMemo(
    () => new Set(pinnedThreads.map((thread) => thread.threadId)),
    [pinnedThreads],
  );
  const [pendingPinFocus, setPendingPinFocus] = useState<
    "pinned" | "list" | null
  >(null);
  const changeThreadPinned = async (thread: NativeThreadSummary) => {
    const willPin = !pinnedThreadIds.has(thread.threadId);
    await onChangeThreadPinned(thread);
    setPendingPinFocus(willPin && mode === "projects" ? "pinned" : "list");
  };
  const reportSidebarOrderError = (
    error: unknown,
    retry: () => Promise<void>,
  ) => {
    setSidebarOrderError(
      `Could not save Sidebar order: ${error instanceof Error ? error.message : String(error)}`,
    );
    setSidebarOrderRetry(() => retry);
  };
  const clearSidebarOrderError = () => {
    setSidebarOrderError(null);
    setSidebarOrderRetry(null);
  };
  useLayoutEffect(() => {
    if (pendingPinFocus === null) return;
    const target = document.getElementById(
      pendingPinFocus === "pinned"
        ? "sidebar-pinned-heading"
        : "sidebar-thread-list-heading",
    );
    if (target === null) return;
    target.focus();
    setPendingPinFocus(null);
  }, [mode, pendingPinFocus, pinnedThreads]);
  const watchingThreadIds = useMemo(
    () =>
      new Set(
        triggerSnapshot.triggers
          .filter((trigger) => trigger.active)
          .map((trigger) => trigger.threadId),
      ),
    [triggerSnapshot.triggers],
  );
  return (
    <>
      <aside
        className={`sidebar${open ? " open" : ""}`}
        aria-label="Projects and threads"
      >
        <header className="sidebar-header">
          <div className="brand-row">
            <ZenXBrand />
            <div className="brand-actions">
              <button
                className="icon-button inbox-button"
                type="button"
                aria-label={
                  mode === "inbox" ? "Return to projects" : "Open inbox"
                }
                aria-pressed={mode === "inbox"}
                onClick={() =>
                  onModeChange(mode === "inbox" ? "projects" : "inbox")
                }
              >
                <Icon name="inbox" />
                {pendingApprovalThreadIds.size > 0 ? (
                  <span className="inbox-dot" aria-hidden="true" />
                ) : null}
              </button>
            </div>
          </div>

          {pluginContributions.length === 0 ? null : (
            <section
              className="plugin-spaces"
              aria-label="Enabled plugin spaces"
            >
              <strong>Plugin spaces</strong>
              {pluginContributions.map((contribution) => (
                <button
                  className="plugin-space-link"
                  type="button"
                  aria-current={
                    selectedPage === contribution.page ? "page" : undefined
                  }
                  key={contribution.key}
                  onClick={() => onOpenContribution(contribution.page)}
                >
                  <Icon
                    name={contribution.icon === "rooms" ? "users" : "trigger"}
                  />
                  <span>{contribution.label}</span>
                  <small>
                    {contribution.page === "triggers"
                      ? triggerSnapshot.triggers.filter(
                          (trigger) => trigger.active,
                        ).length
                      : triggerSnapshot.rooms.length}
                  </small>
                </button>
              ))}
            </section>
          )}

          <div className="new-thread-control">
            <button
              className="new-thread-action"
              type="button"
              aria-expanded={
                configuredProjects.length > 0 && lastUsedProject === undefined
                  ? projectChooserOpen
                  : undefined
              }
              onClick={() => {
                if (configuredProjects.length === 0) {
                  onAddProject();
                  return;
                }
                if (lastUsedProject !== undefined) {
                  onNewThread(lastUsedProject.workspace);
                  return;
                }
                setProjectChooserOpen((value) => !value);
              }}
            >
              <Icon name="compose" size={14} />
              <span>New thread</span>
              <small title={lastUsedProject?.workspace}>
                {lastUsedProject === undefined
                  ? configuredProjects.length === 0
                    ? "Add project first"
                    : "Choose project"
                  : projectLabelForSidebar(lastUsedProject.workspace)}
              </small>
            </button>
            {configuredProjects.length > 0 &&
            lastUsedProject === undefined &&
            projectChooserOpen ? (
              <div className="new-thread-project-chooser">
                {configuredProjects.map((project) => (
                  <button
                    key={project.key}
                    type="button"
                    title={project.workspace}
                    onClick={() => {
                      setProjectChooserOpen(false);
                      onNewThread(project.workspace);
                    }}
                  >
                    <Icon name="folder" size={13} />
                    <span>{projectLabelForSidebar(project.workspace)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="sidebar-view-head">
            {mode === "projects" ? (
              <button
                id="sidebar-thread-list-heading"
                className="projects-section-toggle"
                type="button"
                aria-expanded={projectsOpen}
                onClick={() => setProjectsOpen((value) => !value)}
              >
                <Icon
                  className={projectsOpen ? "expanded" : undefined}
                  name="chevron-down"
                  size={13}
                />
                <strong>Projects</strong>
              </button>
            ) : (
              <strong id="sidebar-thread-list-heading" tabIndex={-1}>
                Inbox
              </strong>
            )}
            {mode === "projects" ? (
              <button
                className="sidebar-inline-action"
                type="button"
                aria-label="Add project"
                title="Add project"
                onClick={onAddProject}
              >
                <Icon name="folder-plus" size={14} />
              </button>
            ) : (
              <span>{threads.length}</span>
            )}
          </div>
        </header>

        <div
          className="sidebar-scroll"
          aria-labelledby="sidebar-thread-list-heading"
        >
          {sidebarOrderError !== null ? (
            <div className="sidebar-empty sidebar-error" role="alert">
              <p>{sidebarOrderError}</p>
              <button
                type="button"
                onClick={() => {
                  const retry = sidebarOrderRetry;
                  clearSidebarOrderError();
                  if (retry !== null) void retry();
                }}
              >
                Try again
              </button>
            </div>
          ) : null}
          {serverStatus.type !== "ready" ? (
            <p className="sidebar-empty">Waiting for the local App Server.</p>
          ) : threadLoading ? (
            <p className="sidebar-empty" role="status">
              Loading active Threads…
            </p>
          ) : threadError !== null ? (
            <div className="sidebar-empty sidebar-error" role="alert">
              <p>{threadError}</p>
              <button type="button" onClick={onRetryThreads}>
                Try again
              </button>
            </div>
          ) : mode === "inbox" && threads.length === 0 ? (
            <p className="sidebar-empty">
              Your conversations will appear here.
            </p>
          ) : mode === "inbox" ? (
            <InboxView
              onSelectThread={onSelectThread}
              onChangeThreadLifecycle={onChangeThreadLifecycle}
              onChangeThreadPinned={changeThreadPinned}
              onRenameThread={onRenameThread}
              pendingApprovalThreadIds={pendingApprovalThreadIds}
              selectedThreadId={selectedThreadId}
              threads={threads}
              liveThread={liveThread}
              pinnedThreadIds={pinnedThreadIds}
              watchingThreadIds={watchingThreadIds}
            />
          ) : (
            <>
              {pinnedThreads.length === 0 ? null : (
                <PinnedThreadsView
                  liveThread={liveThread}
                  onChangeThreadLifecycle={onChangeThreadLifecycle}
                  onChangeThreadPinned={changeThreadPinned}
                  onRenameThread={onRenameThread}
                  onSelectThread={onSelectThread}
                  pendingApprovalThreadIds={pendingApprovalThreadIds}
                  selectedThreadId={selectedThreadId}
                  threads={pinnedThreads}
                  watchingThreadIds={watchingThreadIds}
                />
              )}
              {!projectsOpen ? null : (
                <ProjectsView
                  projects={projects}
                  sidebarOrder={sidebarOrder}
                  onNewThread={onNewThread}
                  onRemoveProject={onRemoveProject}
                  onSetDefaultProject={onSetDefaultProject}
                  onSelectThread={onSelectThread}
                  onChangeThreadLifecycle={onChangeThreadLifecycle}
                  onChangeThreadPinned={changeThreadPinned}
                  onRenameThread={onRenameThread}
                  onReorderProject={onReorderProject}
                  onReorderThread={onReorderThread}
                  onSidebarOrderError={reportSidebarOrderError}
                  onSidebarOrderAttempt={clearSidebarOrderError}
                  pendingApprovalThreadIds={pendingApprovalThreadIds}
                  selectedThreadId={selectedThreadId}
                  threads={threads.filter(
                    (thread) => !pinnedThreadIds.has(thread.threadId),
                  )}
                  liveThread={liveThread}
                  pinnedThreadIds={pinnedThreadIds}
                  watchingThreadIds={watchingThreadIds}
                />
              )}
            </>
          )}
        </div>

        <footer className="sidebar-footer">
          <button
            className="settings-nav-row"
            type="button"
            aria-label={`Settings — ${serviceStatusPresentation(serverStatus).label}`}
            title={serviceStatusPresentation(serverStatus).label}
            aria-current={selectedPage === "settings" ? "page" : undefined}
            onClick={onOpenSettings}
          >
            <Icon name="settings" />
            <span>Settings</span>
            <ServiceStatusDot status={serverStatus} />
          </button>
        </footer>
      </aside>
      <button
        className={`sidebar-scrim${open ? " open" : ""}`}
        type="button"
        aria-label="Close sidebar"
        onClick={onClose}
      />
    </>
  );
}

export function serviceStatusPresentation(status: AppServerHostStatus): {
  className: "ready" | "starting" | "reconnecting" | "error" | "stopped";
  label: string;
} {
  switch (status.type) {
    case "ready":
      return { className: "ready", label: "Local service ready" };
    case "starting":
      return { className: "starting", label: "Local service starting" };
    case "reconnecting":
      return { className: "reconnecting", label: "Local service reconnecting" };
    case "error":
      return {
        className: "error",
        label: `Local service error: ${status.message}`,
      };
    case "stopped":
      return { className: "stopped", label: "Local service stopped" };
  }
}

function ServiceStatusDot({ status }: { status: AppServerHostStatus }) {
  const presentation = serviceStatusPresentation(status);
  return (
    <span
      className={`service-status-dot ${presentation.className}`}
      aria-hidden="true"
    />
  );
}

function InboxView({
  threads,
  selectedThreadId,
  onSelectThread,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onRenameThread,
  pendingApprovalThreadIds,
  liveThread,
  watchingThreadIds,
  pinnedThreadIds,
}: {
  threads: readonly NativeThreadSummary[];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  pendingApprovalThreadIds: ReadonlySet<string>;
  liveThread: Thread | null;
  watchingThreadIds: ReadonlySet<string>;
  pinnedThreadIds: ReadonlySet<string>;
}) {
  return deriveInboxSections(
    threads,
    pendingApprovalThreadIds,
    watchingThreadIds,
  ).map((section) =>
    section.threads.length === 0 ? null : (
      <section className="inbox-group" key={section.key}>
        <h2>{section.label}</h2>
        {section.threads.map((thread) => (
          <ThreadRow
            inbox
            key={thread.threadId}
            hasActiveTurn={threadHasActiveTurn(thread, liveThread)}
            onChangeThreadLifecycle={onChangeThreadLifecycle}
            onChangeThreadPinned={onChangeThreadPinned}
            onRenameThread={onRenameThread}
            onSelectThread={onSelectThread}
            pendingApproval={pendingApprovalThreadIds.has(thread.threadId)}
            pinned={pinnedThreadIds.has(thread.threadId)}
            selected={thread.threadId === selectedThreadId}
            thread={thread}
            watching={watchingThreadIds.has(thread.threadId)}
          />
        ))}
      </section>
    ),
  );
}

function PinnedThreadsView({
  liveThread,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onRenameThread,
  onSelectThread,
  pendingApprovalThreadIds,
  selectedThreadId,
  threads,
  watchingThreadIds,
}: {
  liveThread: Thread | null;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  selectedThreadId: string | null;
  threads: readonly NativeThreadSummary[];
  watchingThreadIds: ReadonlySet<string>;
}) {
  return (
    <section
      className="pinned-thread-group"
      aria-labelledby="sidebar-pinned-heading"
    >
      <h2 id="sidebar-pinned-heading" tabIndex={-1}>
        Pinned
      </h2>
      {threads.map((thread) => (
        <ThreadRow
          hasActiveTurn={threadHasActiveTurn(thread, liveThread)}
          key={thread.threadId}
          onChangeThreadLifecycle={onChangeThreadLifecycle}
          onChangeThreadPinned={onChangeThreadPinned}
          onRenameThread={onRenameThread}
          onSelectThread={onSelectThread}
          pendingApproval={pendingApprovalThreadIds.has(thread.threadId)}
          pinned
          selected={thread.threadId === selectedThreadId}
          thread={thread}
          watching={watchingThreadIds.has(thread.threadId)}
        />
      ))}
    </section>
  );
}

function ProjectsView({
  projects,
  sidebarOrder,
  onNewThread,
  onRemoveProject,
  onSetDefaultProject,
  threads,
  selectedThreadId,
  onSelectThread,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onRenameThread,
  onReorderProject,
  onReorderThread,
  onSidebarOrderError,
  onSidebarOrderAttempt,
  pendingApprovalThreadIds,
  liveThread,
  watchingThreadIds,
  pinnedThreadIds,
}: {
  projects: ZenXProjectProjectionSnapshot;
  sidebarOrder: ZenXSidebarOrder;
  onNewThread(workspace?: string): void;
  onRemoveProject(workspace: string): void;
  onSetDefaultProject(workspace: string): void;
  threads: readonly NativeThreadSummary[];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onReorderProject?: SidebarProps["onReorderProject"];
  onReorderThread?: SidebarProps["onReorderThread"];
  onSidebarOrderError?: (error: unknown, retry: () => Promise<void>) => void;
  onSidebarOrderAttempt?: () => void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  liveThread: Thread | null;
  watchingThreadIds: ReadonlySet<string>;
  pinnedThreadIds: ReadonlySet<string>;
}) {
  const projectDrag = useRef<string | null>(null);
  const threadDrag = useRef<{ projectKey: string; threadId: string } | null>(
    null,
  );
  if (
    projects.projects.length === 0 &&
    projects.unavailableThreadIds.length === 0
  ) {
    return (
      <div className="projects-zero-state">
        <Icon name="folder" size={18} />
        <strong>No projects yet</strong>
        <p>Add a folder before starting a Thread.</p>
      </div>
    );
  }
  const groups = deriveProjectGroups(threads, projects, sidebarOrder);
  return groups.map((group, projectIndex) => (
    <ProjectRows
      group={group}
      key={group.key}
      liveThread={liveThread}
      onChangeThreadLifecycle={onChangeThreadLifecycle}
      onChangeThreadPinned={onChangeThreadPinned}
      onRenameThread={onRenameThread}
      onNewThread={onNewThread}
      onRemoveProject={onRemoveProject}
      onSetDefaultProject={onSetDefaultProject}
      onSelectThread={onSelectThread}
      pendingApprovalThreadIds={pendingApprovalThreadIds}
      selectedThreadId={selectedThreadId}
      pinnedThreadIds={pinnedThreadIds}
      watchingThreadIds={watchingThreadIds}
      projectReorder={
        onReorderProject === undefined || group.key === "__unavailable__"
          ? undefined
          : {
              handleId: sidebarOrderHandleId("project", group.key),
              onDragStart: (event) => {
                projectDrag.current = group.key;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", group.key);
              },
              onDragEnd: () => {
                projectDrag.current = null;
              },
              onDragOver: (event) => {
                if (
                  projectDrag.current === null ||
                  projectDrag.current === group.key
                )
                  return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              },
              onDrop: (event) => {
                const sourceKey = projectDrag.current;
                projectDrag.current = null;
                if (sourceKey === null || sourceKey === group.key) return;
                event.preventDefault();
                void reorderAndRestoreFocus(
                  sidebarOrderHandleId("project", sourceKey),
                  () =>
                    onReorderProject(
                      sourceKey,
                      group.key,
                      dropPlacement(event),
                    ),
                  onSidebarOrderAttempt,
                  onSidebarOrderError,
                );
              },
              onKeyDown: (event) => {
                const target =
                  event.key === "ArrowUp"
                    ? groups[projectIndex - 1]
                    : event.key === "ArrowDown"
                      ? groups[projectIndex + 1]
                      : undefined;
                if (target === undefined || target.key === "__unavailable__")
                  return;
                event.preventDefault();
                void reorderAndRestoreFocus(
                  sidebarOrderHandleId("project", group.key),
                  () =>
                    onReorderProject(
                      group.key,
                      target.key,
                      event.key === "ArrowUp" ? "before" : "after",
                    ),
                  onSidebarOrderAttempt,
                  onSidebarOrderError,
                );
              },
            }
      }
      threadReorder={
        onReorderThread === undefined || group.key === "__unavailable__"
          ? undefined
          : {
              onDragStart: (threadId, event) => {
                threadDrag.current = { projectKey: group.key, threadId };
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", threadId);
              },
              onDragEnd: () => {
                threadDrag.current = null;
              },
              onDragOver: (targetThreadId, event) => {
                const source = threadDrag.current;
                if (
                  source === null ||
                  source.projectKey !== group.key ||
                  source.threadId === targetThreadId
                )
                  return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              },
              onDrop: (targetThreadId, event) => {
                const source = threadDrag.current;
                threadDrag.current = null;
                if (
                  source === null ||
                  source.projectKey !== group.key ||
                  source.threadId === targetThreadId
                )
                  return;
                event.preventDefault();
                void reorderAndRestoreFocus(
                  sidebarOrderHandleId("thread", source.threadId),
                  () =>
                    onReorderThread(
                      source.projectKey,
                      source.threadId,
                      group.key,
                      targetThreadId,
                      dropPlacement(event),
                    ),
                  onSidebarOrderAttempt,
                  onSidebarOrderError,
                );
              },
              onKeyDown: (threadIndex, threadId, event) => {
                const target =
                  event.key === "ArrowUp"
                    ? group.threads[threadIndex - 1]
                    : event.key === "ArrowDown"
                      ? group.threads[threadIndex + 1]
                      : undefined;
                if (target === undefined) return;
                event.preventDefault();
                void reorderAndRestoreFocus(
                  sidebarOrderHandleId("thread", threadId),
                  () =>
                    onReorderThread(
                      group.key,
                      threadId,
                      group.key,
                      target.threadId,
                      event.key === "ArrowUp" ? "before" : "after",
                    ),
                  onSidebarOrderAttempt,
                  onSidebarOrderError,
                );
              },
            }
      }
    />
  ));
}

function projectLabelForSidebar(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace;
}

interface ProjectReorderHandlers {
  handleId: string;
  onDragStart(event: ReactDragEvent<HTMLButtonElement>): void;
  onDragEnd(): void;
  onDragOver(event: ReactDragEvent<HTMLElement>): void;
  onDrop(event: ReactDragEvent<HTMLElement>): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
}

interface ThreadReorderHandlers {
  onDragStart(threadId: string, event: ReactDragEvent<HTMLButtonElement>): void;
  onDragEnd(): void;
  onDragOver(threadId: string, event: ReactDragEvent<HTMLDivElement>): void;
  onDrop(threadId: string, event: ReactDragEvent<HTMLDivElement>): void;
  onKeyDown(
    threadIndex: number,
    threadId: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void;
}

function ProjectRows({
  group,
  onNewThread,
  onRemoveProject,
  onSetDefaultProject,
  selectedThreadId,
  onSelectThread,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onRenameThread,
  pendingApprovalThreadIds,
  liveThread,
  watchingThreadIds,
  pinnedThreadIds,
  projectReorder,
  threadReorder,
}: {
  group: ReturnType<typeof deriveProjectGroups>[number];
  onNewThread(workspace?: string): void;
  onRemoveProject(workspace: string): void;
  onSetDefaultProject(workspace: string): void;
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  pendingApprovalThreadIds: ReadonlySet<string>;
  liveThread: Thread | null;
  watchingThreadIds: ReadonlySet<string>;
  pinnedThreadIds: ReadonlySet<string>;
  projectReorder?: ProjectReorderHandlers;
  threadReorder?: ThreadReorderHandlers;
}) {
  const [open, setOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const restoreMenuFocusRef = useRef(false);
  const initialMenuFocusRef = useRef<"first" | "last">("first");
  const projectMenuId = `project-menu-${encodeURIComponent(group.key)}`;
  const openMenu = (initialFocus: "first" | "last") => {
    initialMenuFocusRef.current = initialFocus;
    setMenuOpen(true);
  };
  const closeMenu = (restoreFocus = true) => {
    restoreMenuFocusRef.current = restoreFocus;
    setMenuOpen(false);
  };
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (
        menuRef.current !== null &&
        !menuRef.current.contains(event.target as Node)
      ) {
        closeMenu();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu();
    };
    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const items = enabledMenuItems(menuRef.current);
    const item =
      initialMenuFocusRef.current === "last" ? items.at(-1) : items.at(0);
    item?.focus();
  }, [menuOpen]);
  useLayoutEffect(() => {
    if (menuOpen || !restoreMenuFocusRef.current) return;
    restoreMenuFocusRef.current = false;
    moreRef.current?.focus();
  }, [menuOpen]);
  const toggleMenu = () => {
    if (menuOpen) {
      closeMenu();
      return;
    }
    openMenu("first");
  };
  const handleMoreKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    if (menuOpen) {
      closeMenu();
      return;
    }
    openMenu(event.key === "ArrowUp" ? "last" : "first");
  };
  const projectSelected = group.threads.some(
    (thread) => thread.threadId === selectedThreadId,
  );
  return (
    <section
      className="project-group"
      data-project-key={group.key}
      onDragOver={projectReorder?.onDragOver}
      onDrop={projectReorder?.onDrop}
    >
      <div className={`project-header${projectSelected ? " selected" : ""}`}>
        {projectReorder === undefined ? null : (
          <button
            className="reorder-handle project-reorder-handle"
            type="button"
            id={projectReorder.handleId}
            aria-keyshortcuts="ArrowUp ArrowDown"
            aria-label={`Reorder project ${group.label}. Use Up and Down arrow keys.`}
            title="Drag to reorder; use Up and Down arrow keys"
            draggable
            onDragStart={projectReorder.onDragStart}
            onDragEnd={projectReorder.onDragEnd}
            onKeyDown={projectReorder.onKeyDown}
          >
            <Icon name="grip" size={14} />
          </button>
        )}
        <button
          className="project-toggle"
          type="button"
          aria-expanded={open}
          title={group.workspace ?? undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="folder" size={14} />
          <span>{group.label}</span>
          {group.isDefault ? <small>Default</small> : null}
        </button>
        {group.workspace === null || !group.configured ? null : (
          <div className="project-actions" ref={menuRef}>
            <button
              type="button"
              aria-label={`New thread in ${group.label}`}
              title="New thread here"
              onClick={() => onNewThread(group.workspace!)}
            >
              <Icon name="compose" size={13} />
            </button>
            <button
              ref={moreRef}
              className="project-more-trigger"
              type="button"
              id={`project-more-trigger-${encodeURIComponent(group.key)}`}
              aria-label={`More actions for ${group.label}`}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-controls={menuOpen ? projectMenuId : undefined}
              title="More actions"
              onClick={toggleMenu}
              onKeyDown={handleMoreKeyDown}
            >
              <Icon name="more" size={15} />
            </button>
            {menuOpen ? (
              <div
                className="project-menu"
                id={projectMenuId}
                role="menu"
                aria-labelledby={`project-more-trigger-${encodeURIComponent(group.key)}`}
                aria-label={`${group.label} project actions`}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeMenu();
                    return;
                  }
                  if (
                    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                  ) {
                    return;
                  }
                  const items = enabledMenuItems(event.currentTarget);
                  if (items.length === 0) return;
                  event.preventDefault();
                  const currentIndex = items.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : currentIndex === -1
                          ? event.key === "ArrowUp"
                            ? items.length - 1
                            : 0
                          : event.key === "ArrowUp"
                            ? (currentIndex - 1 + items.length) % items.length
                            : (currentIndex + 1) % items.length;
                  items[nextIndex]?.focus();
                }}
              >
                {!group.isDefault ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSetDefaultProject(group.workspace!);
                      closeMenu();
                    }}
                  >
                    <Icon name="check" size={13} />
                    <span>Set as default</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onRemoveProject(group.workspace!);
                    closeMenu();
                  }}
                >
                  <Icon name="x" size={13} />
                  <span>Remove from ZenX</span>
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {open && group.threads.length === 0 ? (
        <p className="project-empty">No threads yet.</p>
      ) : open ? (
        group.threads.map((thread, threadIndex) => (
          <ThreadRow
            hasActiveTurn={threadHasActiveTurn(thread, liveThread)}
            key={thread.threadId}
            onChangeThreadLifecycle={onChangeThreadLifecycle}
            onChangeThreadPinned={onChangeThreadPinned}
            onRenameThread={onRenameThread}
            onSelectThread={onSelectThread}
            pendingApproval={pendingApprovalThreadIds.has(thread.threadId)}
            pinned={pinnedThreadIds.has(thread.threadId)}
            selected={thread.threadId === selectedThreadId}
            thread={thread}
            watching={watchingThreadIds.has(thread.threadId)}
            reorder={
              threadReorder === undefined
                ? undefined
                : {
                    handleId: sidebarOrderHandleId("thread", thread.threadId),
                    onDragStart: (event) =>
                      threadReorder.onDragStart(thread.threadId, event),
                    onDragEnd: threadReorder.onDragEnd,
                    onDragOver: (event) =>
                      threadReorder.onDragOver(thread.threadId, event),
                    onDrop: (event) =>
                      threadReorder.onDrop(thread.threadId, event),
                    onKeyDown: (event) =>
                      threadReorder.onKeyDown(
                        threadIndex,
                        thread.threadId,
                        event,
                      ),
                  }
            }
          />
        ))
      ) : null}
    </section>
  );
}

interface ThreadRowReorderHandlers {
  handleId: string;
  onDragStart(event: ReactDragEvent<HTMLButtonElement>): void;
  onDragEnd(): void;
  onDragOver(event: ReactDragEvent<HTMLDivElement>): void;
  onDrop(event: ReactDragEvent<HTMLDivElement>): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
}

function ThreadRow({
  thread,
  selected,
  hasActiveTurn,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onRenameThread,
  onSelectThread,
  pendingApproval,
  pinned,
  watching,
  inbox = false,
  reorder,
}: {
  thread: NativeThreadSummary;
  selected: boolean;
  hasActiveTurn: boolean;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onSelectThread(threadId: string): void;
  pendingApproval: boolean;
  pinned: boolean;
  watching: boolean;
  inbox?: boolean;
  reorder?: ThreadRowReorderHandlers;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreMenuFocusRef = useRef(false);
  const initialMenuFocusRef = useRef<"first" | "last">("first");
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(threadTitle(thread));
  const [busyAction, setBusyAction] = useState<
    "rename" | "pin" | "unpin" | "archive" | "unarchive" | null
  >(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const closeMenu = (restoreFocus = true) => {
    restoreMenuFocusRef.current = restoreFocus;
    setMenuOpen(false);
    setRenaming(false);
  };
  const focusThreadListHeading = (nextPinned = pinned) => {
    document
      .getElementById(
        nextPinned ? "sidebar-pinned-heading" : "sidebar-thread-list-heading",
      )
      ?.focus();
  };
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen || renaming) return;
    const items = enabledMenuItems(menuRef.current);
    const item =
      initialMenuFocusRef.current === "last" ? items.at(-1) : items.at(0);
    item?.focus();
  }, [menuOpen, renaming]);
  useLayoutEffect(() => {
    if (menuOpen || !restoreMenuFocusRef.current) return;
    restoreMenuFocusRef.current = false;
    menuTriggerRef.current?.focus();
  }, [menuOpen]);
  const identity = threadModelIdentity(thread);
  const contents = (
    <>
      {inbox ? (
        <span className="thread-project">
          <Icon name="folder" size={12} /> {threadProject(thread)}
        </span>
      ) : null}
      <span className="thread-title">
        <span>{threadTitle(thread)}</span>
        {pendingApproval ? (
          <span className="needs-dot" aria-label="Needs you" />
        ) : thread.status === "active" ? (
          <span className="live-dot ready" aria-label="Running" />
        ) : watching ? (
          <Icon name="moon" size={12} aria-label="Watching" />
        ) : null}
      </span>
      {identity === null ? null : (
        <span className="model-line">
          <ProviderLogo kind={identity.providerKind} />
          <span>{identity.label}</span>
        </span>
      )}
    </>
  );
  const runAction = async (
    action: "rename" | "pin" | "unpin" | "archive" | "unarchive",
    operation: () => Promise<void>,
  ) => {
    setBusyAction(action);
    setMenuError(null);
    try {
      if (action !== "rename") focusThreadListHeading();
      await operation();
      if (action !== "rename" && action !== "pin" && action !== "unpin")
        focusThreadListHeading(false);
      closeMenu(action === "rename");
    } catch (error) {
      setMenuError(error instanceof Error ? error.message : String(error));
      if (action !== "rename") {
        queueMicrotask(() =>
          menuRef.current
            ?.querySelector<HTMLButtonElement>(
              `[data-thread-action="${action}"]:not(:disabled)`,
            )
            ?.focus(),
        );
      }
    } finally {
      setBusyAction(null);
    }
  };
  return (
    <div
      ref={rowRef}
      className={`thread-row-shell${reorder === undefined ? "" : " reorderable"}`}
      data-thread-id={thread.threadId}
      onDragOver={reorder?.onDragOver}
      onDrop={reorder?.onDrop}
      onKeyDown={(event) => {
        if (menuOpen && event.key === "Escape") {
          event.preventDefault();
          closeMenu();
        }
      }}
    >
      {reorder === undefined ? null : (
        <button
          className="reorder-handle thread-reorder-handle"
          type="button"
          id={reorder.handleId}
          aria-keyshortcuts="ArrowUp ArrowDown"
          aria-label={`Reorder ${threadTitle(thread)} within ${threadProject(thread)}. Use Up and Down arrow keys.`}
          title="Drag to reorder; use Up and Down arrow keys"
          draggable
          onDragStart={reorder.onDragStart}
          onDragEnd={reorder.onDragEnd}
          onKeyDown={reorder.onKeyDown}
        >
          <Icon name="grip" size={14} />
        </button>
      )}
      {thread.status === "systemError" ? (
        <div className={`thread-row system-error${inbox ? " inbox" : ""}`}>
          {contents}
        </div>
      ) : (
        <button
          className={`thread-row${selected ? " selected" : ""}${inbox ? " inbox" : ""}`}
          type="button"
          aria-current={selected ? "page" : undefined}
          onClick={() => onSelectThread(thread.threadId)}
        >
          {contents}
        </button>
      )}
      <button
        ref={menuTriggerRef}
        className="thread-menu-trigger"
        type="button"
        id={`thread-menu-trigger-${thread.threadId}`}
        aria-label={`Manage ${threadTitle(thread)}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? `thread-menu-${thread.threadId}` : undefined}
        title={`Manage ${threadTitle(thread)}`}
        onClick={() => {
          if (menuOpen) {
            closeMenu();
            return;
          }
          initialMenuFocusRef.current = "first";
          setMenuError(null);
          setRenaming(false);
          setRenameDraft(threadTitle(thread));
          setMenuOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          initialMenuFocusRef.current =
            event.key === "ArrowUp" ? "last" : "first";
          setMenuError(null);
          setRenaming(false);
          setRenameDraft(threadTitle(thread));
          setMenuOpen(true);
        }}
      >
        <Icon name="more" size={18} />
      </button>
      <ThreadItemMenu
        archived={thread.archived}
        busyAction={busyAction}
        error={menuError}
        hasActiveTurn={hasActiveTurn}
        labelledBy={`thread-menu-trigger-${thread.threadId}`}
        menuId={`thread-menu-${thread.threadId}`}
        menuRef={menuRef}
        open={menuOpen}
        pinned={pinned}
        renaming={renaming}
        renameDraft={renameDraft}
        onArchive={() =>
          void runAction("archive", () => onChangeThreadLifecycle(thread))
        }
        onBeginRename={() => setRenaming(true)}
        onCancelRename={() => setRenaming(false)}
        onRequestClose={() => closeMenu()}
        onDraftChange={setRenameDraft}
        onPin={() =>
          void runAction(pinned ? "unpin" : "pin", () =>
            onChangeThreadPinned(thread),
          )
        }
        onRename={() =>
          void runAction("rename", () =>
            onRenameThread(thread.threadId, renameDraft),
          )
        }
        onUnarchive={() =>
          void runAction("unarchive", () => onChangeThreadLifecycle(thread))
        }
      />
    </div>
  );
}

export function ThreadItemMenu({
  archived,
  busyAction,
  error,
  hasActiveTurn,
  labelledBy,
  menuId,
  menuRef,
  open,
  pinned,
  renaming,
  renameDraft,
  onArchive,
  onBeginRename,
  onCancelRename,
  onRequestClose,
  onDraftChange,
  onPin,
  onRename,
  onUnarchive,
}: {
  archived: boolean;
  busyAction: "rename" | "pin" | "unpin" | "archive" | "unarchive" | null;
  error: string | null;
  hasActiveTurn: boolean;
  labelledBy?: string;
  menuId?: string;
  menuRef?: RefObject<HTMLDivElement | null>;
  open: boolean;
  pinned: boolean;
  renaming: boolean;
  renameDraft: string;
  onArchive(): void;
  onBeginRename(): void;
  onCancelRename(): void;
  onRequestClose?(): void;
  onDraftChange(value: string): void;
  onPin(): void;
  onRename(): void;
  onUnarchive(): void;
}) {
  if (!open) return null;
  const busy = busyAction !== null;
  return (
    <div
      ref={menuRef}
      className="thread-item-menu"
      id={menuId}
      role="menu"
      aria-labelledby={labelledBy}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onRequestClose?.();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          return;
        }
        const items = enabledMenuItems(event.currentTarget);
        if (items.length === 0) return;
        event.preventDefault();
        const currentIndex = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : currentIndex === -1
                ? event.key === "ArrowUp"
                  ? items.length - 1
                  : 0
                : event.key === "ArrowUp"
                  ? (currentIndex - 1 + items.length) % items.length
                  : (currentIndex + 1) % items.length;
        items[nextIndex]?.focus();
      }}
    >
      {renaming ? (
        <form
          className="thread-menu-rename"
          onSubmit={(event) => {
            event.preventDefault();
            onRename();
          }}
        >
          <label>
            <span>Thread name</span>
            <input
              autoFocus
              value={renameDraft}
              onChange={(event) => onDraftChange(event.target.value)}
            />
          </label>
          <div>
            <button type="submit" disabled={busy || !renameDraft.trim()}>
              {busyAction === "rename" ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={busy} onClick={onCancelRename}>
              Cancel
            </button>
          </div>
        </form>
      ) : archived ? (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-thread-action="unarchive"
          disabled={busy}
          onClick={onUnarchive}
        >
          <Icon name="restore" />
          {busyAction === "unarchive" ? "Unarchiving…" : "Unarchive"}
        </button>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-thread-action="rename"
            disabled={busy}
            onClick={onBeginRename}
          >
            <Icon name="compose" />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-thread-action={pinned ? "unpin" : "pin"}
            disabled={busy}
            onClick={onPin}
          >
            <Icon name={pinned ? "pin-off" : "pin"} />
            {busyAction === "pin"
              ? "Pinning…"
              : busyAction === "unpin"
                ? "Unpinning…"
                : pinned
                  ? "Unpin"
                  : "Pin"}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-thread-action="archive"
            disabled={busy || hasActiveTurn}
            title={
              hasActiveTurn
                ? "Wait for the active Turn to finish before archiving."
                : undefined
            }
            onClick={onArchive}
          >
            <Icon name="archive" />
            {busyAction === "archive" ? "Archiving…" : "Archive"}
          </button>
          {hasActiveTurn ? (
            <p className="thread-menu-help">
              Wait for the active Turn to finish before archiving.
            </p>
          ) : null}
        </>
      )}
      {error === null ? null : <p role="alert">{error}</p>}
    </div>
  );
}

function enabledMenuItems(container: HTMLElement | null): HTMLButtonElement[] {
  if (container === null) return [];
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    ),
  );
}

function sidebarOrderHandleId(
  kind: "project" | "thread",
  identifier: string,
): string {
  return `sidebar-${kind}-order-${encodeURIComponent(identifier)}`;
}

function dropPlacement<T extends HTMLElement>(
  event: ReactDragEvent<T>,
): SidebarOrderPlacement {
  const bounds = event.currentTarget.getBoundingClientRect();
  return bounds.height > 0 && event.clientY >= bounds.top + bounds.height / 2
    ? "after"
    : "before";
}

async function reorderAndRestoreFocus(
  handleId: string,
  operation: () => Promise<void>,
  onAttempt?: () => void,
  onError?: (error: unknown, retry: () => Promise<void>) => void,
): Promise<void> {
  onAttempt?.();
  try {
    await operation();
  } catch (error) {
    onError?.(error, () =>
      reorderAndRestoreFocus(handleId, operation, onAttempt, onError),
    );
  } finally {
    const restore = () => document.getElementById(handleId)?.focus();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(restore);
    } else {
      queueMicrotask(restore);
    }
  }
}
