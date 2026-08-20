import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { TriggerSnapshot } from "../../main/trigger-types.js";
import type { Thread } from "../../protocol-client/index.js";
import type { ZenXProjectProjectionSnapshot } from "../../main/project-projection.js";
import { Icon } from "./icons.js";
import type { LoadedPluginContribution } from "./plugin-contributions.js";
import { ProviderLogo } from "./ProviderLogo.js";
import { ZenXBrand } from "./ZenXBrand.js";
import {
  deriveInboxSections,
  deriveProjectGroups,
  threadModelIdentity,
  threadHasActiveTurn,
  threadProject,
  threadTitle,
  type SidebarMode,
} from "./thread-list.js";

interface SidebarProps {
  mode: SidebarMode;
  open: boolean;
  onClose(): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
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
  serverReady: boolean;
  liveThread: Thread | null;
  threadError: string | null;
  threadLoading: boolean;
  projects: ZenXProjectProjectionSnapshot;
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
  serverReady,
  liveThread,
  threadError,
  threadLoading,
  projects,
  pinnedThreads,
  threads,
  triggerSnapshot,
}: SidebarProps) {
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
  const configuredProjects = projects.projects.filter(
    (project) => project.configured,
  );
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
          {!serverReady ? (
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
                  onNewThread={onNewThread}
                  onRemoveProject={onRemoveProject}
                  onSetDefaultProject={onSetDefaultProject}
                  onSelectThread={onSelectThread}
                  onChangeThreadLifecycle={onChangeThreadLifecycle}
                  onChangeThreadPinned={changeThreadPinned}
                  onRenameThread={onRenameThread}
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
            aria-current={selectedPage === "settings" ? "page" : undefined}
            onClick={onOpenSettings}
          >
            <Icon name="settings" />
            <span>Settings</span>
          </button>
          <div className="service-status">
            <span className={`live-dot${serverReady ? " ready" : ""}`} />
            <span>{serverReady ? "Local service ready" : "Connecting…"}</span>
          </div>
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
  onNewThread,
  onRemoveProject,
  onSetDefaultProject,
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
  projects: ZenXProjectProjectionSnapshot;
  onNewThread(workspace?: string): void;
  onRemoveProject(workspace: string): void;
  onSetDefaultProject(workspace: string): void;
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
  return deriveProjectGroups(threads, projects).map((group) => (
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
    />
  ));
}

function projectLabelForSidebar(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace;
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
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="project-group">
      <div className="project-header">
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
          <Icon
            className={open ? "expanded" : undefined}
            name="chevron-down"
            size={14}
          />
        </button>
        {group.workspace === null || !group.configured ? null : (
          <div className="project-actions">
            <button
              type="button"
              aria-label={`New thread in ${group.label}`}
              title="New thread here"
              onClick={() => onNewThread(group.workspace!)}
            >
              <Icon name="compose" size={13} />
            </button>
            {!group.isDefault ? (
              <button
                type="button"
                aria-label={`Make ${group.label} the default project`}
                title="Set as default"
                onClick={() => onSetDefaultProject(group.workspace!)}
              >
                <Icon name="check" size={13} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Remove ${group.label} from ZenX`}
              title="Remove from ZenX (files stay on disk)"
              onClick={() => onRemoveProject(group.workspace!)}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        )}
      </div>
      {open && group.threads.length === 0 ? (
        <p className="project-empty">No threads yet.</p>
      ) : open ? (
        group.threads.map((thread) => (
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
          />
        ))
      ) : null}
    </section>
  );
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
      className="thread-row-shell"
      onKeyDown={(event) => {
        if (menuOpen && event.key === "Escape") {
          event.preventDefault();
          closeMenu();
        }
      }}
    >
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
