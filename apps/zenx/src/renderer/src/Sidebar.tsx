import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import {
  type CSSProperties,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { Thread } from "../../protocol-client/index.js";
import type { ZenXProjectProjectionSnapshot } from "../../main/project-projection.js";
import type {
  PublicHostSettings,
  ZenXSidebarOrder,
} from "../../main/host-profile.js";
import type { AppServerHostStatus } from "../../main/app-server-manager.js";
import { Icon } from "./icons.js";
import type { LoadedPluginContribution } from "./plugin-contributions.js";
import { ProviderLogo } from "./ProviderLogo.js";
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

import {
  nextSidebarTrigger,
  useSidebarTriggers,
  type SidebarTriggerState,
} from "./sidebar-thread-information.js";

import { startSidebarDrag } from "./sidebar-drag.js";

import { useSidebarExpansion } from "./sidebar-expansion.js";
import {
  captureSidebarRemoval,
  restoreSidebarRemoval,
  type SidebarRemovalSnapshot,
} from "./sidebar-removal.js";
import {
  ROOM_ROUTE,
  RoomConversationNavigation,
  type RoomConversationState,
} from "./room-conversations.js";

const THREAD_DENSITY_STORAGE_KEY = "zenx.sidebar.thread-density";
type ThreadDensity = "compact" | "detailed";
const SidebarSettingsContext = createContext<{
  settings: PublicHostSettings | null;
  projects: ZenXProjectProjectionSnapshot;
  triggers: SidebarTriggerState;
  refreshTriggers(): Promise<void>;
  unreadThreadIds: ReadonlySet<string>;
  selectionKey: string;
} | null>(null);

interface SidebarProps {
  collapsed?: boolean;
  unreadThreadIds?: ReadonlySet<string>;
  mode: SidebarMode;
  open: boolean;
  onClose(): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onChangeProjectPinned?(key: string): Promise<void>;
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
  onNewThread(workspace?: string): void;
  newThreadDisabled?: boolean;
  onAddProject(): void;
  onRemoveProject(workspace: string): void;
  onEditProject?(workspace: string, name: string): void;
  onSetDefaultProject(workspace: string): void;
  onOpenContribution(route: string): void;
  onOpenSettings(): void;
  onRetryThreads(): void;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onForkThread?(threadId: string): Promise<void>;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  pluginContributions: readonly LoadedPluginContribution[];
  triggerAdmissionId?: string | null;
  roomConversations?: RoomConversationState;
  selectedRoomId?: string | null;
  selectedPage: string;
  selectedThreadId: string | null;
  serverStatus: AppServerHostStatus;
  liveThread: Thread | null;
  threadError: string | null;
  threadLoading: boolean;
  projects: ZenXProjectProjectionSnapshot;
  sidebarOrder?: ZenXSidebarOrder;
  pinnedThreads: readonly NativeThreadSummary[];
  threads: readonly NativeThreadSummary[];
}

export function Sidebar({
  collapsed = false,
  unreadThreadIds = new Set<string>(),
  mode,
  open,
  onClose,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onChangeProjectPinned,
  onReorderProject,
  onReorderThread,
  onNewThread,
  newThreadDisabled = false,
  onAddProject,
  onRemoveProject,
  onEditProject,
  onSetDefaultProject,
  onOpenContribution,
  onOpenSettings,
  onRetryThreads,
  onRenameThread,
  onForkThread = async () => undefined,
  onSelectThread,
  pendingApprovalThreadIds,
  pluginContributions,
  triggerAdmissionId = null,
  roomConversations,
  selectedRoomId,
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
}: SidebarProps) {
  useTranslation("shell");
  const [sidebarOrderError, setSidebarOrderError] = useState<string | null>(
    null,
  );
  const [sidebarOrderRetry, setSidebarOrderRetry] = useState<
    (() => Promise<void>) | null
  >(null);
  const [projectsOpen, toggleProjects, expansionError] =
    useSidebarExpansion("projects");
  const [threadDensity, setThreadDensity] = useState<ThreadDensity>(() => {
    try {
      return window.localStorage.getItem(THREAD_DENSITY_STORAGE_KEY) ===
        "compact"
        ? "compact"
        : "detailed";
    } catch {
      return "detailed";
    }
  });
  const [settings, setSettings] = useState<PublicHostSettings | null>(null);
  useEffect(() => {
    const api = window.zenx?.settings;
    if (api?.get === undefined) return;
    let active = true;
    let changed = false;
    const dispose = api.onChanged?.((value) => {
      changed = true;
      if (active) setSettings(value);
    });
    void api.get().then(
      (value) => {
        if (active && !changed) setSettings(value);
      },
      () => undefined,
    );
    return () => {
      active = false;
      dispose?.();
    };
  }, []);
  const removalSnapshots = useRef(new Map<string, SidebarRemovalSnapshot>());
  const lifecyclePending = useRef(new Set<string>());
  const removalTracking = useRef(new Map<string, () => void>());
  useEffect(
    () => () => {
      for (const stop of removalTracking.current.values()) stop();
      removalTracking.current.clear();
      removalSnapshots.current.clear();
    },
    [],
  );
  useLayoutEffect(() => {
    for (const [threadId, snapshot] of removalSnapshots.current) {
      if (snapshot.row.isConnected) continue;
      removalSnapshots.current.delete(threadId);
      removalTracking.current.get(threadId)?.();
      removalTracking.current.delete(threadId);
      // A user may collapse or change views while the request is pending.
      // DOM disappearance alone does not mean the archive has completed.
      if (
        threads.some((thread) => thread.threadId === threadId) ||
        pinnedThreads.some((thread) => thread.threadId === threadId)
      )
        continue;
      restoreSidebarRemoval(snapshot);
    }
  });
  const changeThreadLifecycle = async (thread: NativeThreadSummary) => {
    if (lifecyclePending.current.has(thread.threadId)) return;
    lifecyclePending.current.add(thread.threadId);
    removalTracking.current.get(thread.threadId)?.();
    removalTracking.current.delete(thread.threadId);
    const row = [
      ...document.querySelectorAll<HTMLElement>(".thread-row-shell"),
    ].find((entry) => entry.dataset.threadId === thread.threadId);
    if (row !== undefined) {
      const snapshot = captureSidebarRemoval(row);
      if (snapshot !== null)
        removalSnapshots.current.set(thread.threadId, snapshot);
    }
    const trackScroll = () => {
      if (row === undefined || !row.isConnected) return;
      const snapshot = captureSidebarRemoval(row);
      if (snapshot !== null) {
        snapshot.focus =
          removalSnapshots.current.get(thread.threadId)?.focus ??
          snapshot.focus;
        removalSnapshots.current.set(thread.threadId, snapshot);
      }
    };
    const scroller = row?.closest(".sidebar-scroll");
    scroller?.addEventListener("scroll", trackScroll);
    const Observer = row?.ownerDocument.defaultView?.MutationObserver;
    const disclosureObserver =
      Observer === undefined
        ? undefined
        : new Observer(() => {
            if (!row?.closest("[inert], [hidden]")) return;
            removalSnapshots.current.delete(thread.threadId);
            removalTracking.current.get(thread.threadId)?.();
            removalTracking.current.delete(thread.threadId);
          });
    for (const owner of removalSnapshots.current.get(thread.threadId)
      ?.disclosureOwners ?? []) {
      disclosureObserver?.observe(owner, {
        attributes: true,
        attributeFilter: ["inert", "hidden"],
      });
    }
    removalTracking.current.set(thread.threadId, () => {
      scroller?.removeEventListener("scroll", trackScroll);
      disclosureObserver?.disconnect();
    });
    try {
      await onChangeThreadLifecycle(thread);
    } catch (error) {
      removalSnapshots.current.delete(thread.threadId);
      removalTracking.current.get(thread.threadId)?.();
      removalTracking.current.delete(thread.threadId);
      throw error;
    } finally {
      lifecyclePending.current.delete(thread.threadId);
    }
  };
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
      i18n.t("shell:couldNotSaveSidebarOrder", {
        error: error instanceof Error ? error.message : String(error),
      }),
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
  useEffect(() => {
    let shortcutObserver: MutationObserver | null = null;
    const shortcutTargets = () => {
      const sidebar = document.getElementById("primary-sidebar");
      return {
        newThread:
          sidebar?.querySelector<HTMLButtonElement>(".new-thread-action") ??
          null,
        threads:
          sidebar === null
            ? []
            : Array.from(
                sidebar.querySelectorAll<HTMLButtonElement>(
                  ".thread-row-shell > button.thread-row",
                ),
              ).filter((row) => !row.closest("[inert]")),
      };
    };
    const clearShortcutHints = () => {
      shortcutObserver?.disconnect();
      shortcutObserver = null;
      document
        .querySelectorAll("#primary-sidebar [data-shortcut-key]")
        .forEach((target) => target.removeAttribute("data-shortcut-key"));
    };
    const projectShortcutHints = () => {
      const sidebar = document.getElementById("primary-sidebar");
      if (sidebar === null) return;
      sidebar
        .querySelectorAll("[data-shortcut-key]")
        .forEach((target) => target.removeAttribute("data-shortcut-key"));
      const targets = shortcutTargets();
      if (targets.newThread?.disabled === false)
        targets.newThread.setAttribute("data-shortcut-key", "N");
      targets.threads
        .slice(0, 9)
        .forEach((row, index) =>
          row.setAttribute("data-shortcut-key", String(index + 1)),
        );
    };
    const shortcutsBlocked = (event: KeyboardEvent) =>
      event.isComposing ||
      document.querySelector(
        '[role="dialog"]:not(.thread-information), dialog[open], [aria-modal="true"]',
      ) !== null ||
      (event.target instanceof window.Element &&
        event.target.closest(
          '[role="menu"], .project-menu, .thread-menu-rename',
        ) !== null);
    const showShortcutHints = () => {
      projectShortcutHints();
      if (shortcutObserver !== null) return;
      shortcutObserver = new window.MutationObserver(projectShortcutHints);
      const sidebar = document.getElementById("primary-sidebar");
      if (sidebar !== null)
        shortcutObserver.observe(sidebar, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["inert"],
        });
    };
    const switchThread = (event: KeyboardEvent) => {
      const mac = window.zenx?.platform === "darwin";
      const modifierOnly = mac
        ? event.key === "Meta" && event.metaKey && !event.ctrlKey
        : event.key === "Control" && event.ctrlKey && !event.metaKey;
      if (
        modifierOnly &&
        !event.defaultPrevented &&
        !event.altKey &&
        !event.shiftKey &&
        !event.repeat &&
        !shortcutsBlocked(event)
      )
        showShortcutHints();
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        (mac
          ? !event.metaKey || event.ctrlKey
          : !event.ctrlKey || event.metaKey) ||
        !(/^[1-9]$/u.test(event.key) || event.key.toLowerCase() === "n")
      )
        return;
      if (shortcutsBlocked(event)) return;
      if (event.key.toLowerCase() === "n") {
        const button = shortcutTargets().newThread;
        if (button === null || button.disabled) return;
        event.preventDefault();
        button.click();
        return;
      }
      const rows = shortcutTargets().threads;
      const target = rows[Number(event.key) - 1];
      if (target === undefined) return;
      event.preventDefault();
      target.click();
    };
    const releaseShortcutHints = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") clearShortcutHints();
    };
    document.addEventListener("keydown", switchThread);
    document.addEventListener("keyup", releaseShortcutHints);
    window.addEventListener("blur", clearShortcutHints);
    return () => {
      clearShortcutHints();
      document.removeEventListener("keydown", switchThread);
      document.removeEventListener("keyup", releaseShortcutHints);
      window.removeEventListener("blur", clearShortcutHints);
    };
  }, []);
  const triggerRevision = `${selectedPage}:${threads.map((thread) => `${thread.threadId}:${thread.status}`).join("|")}`;
  const triggers = useSidebarTriggers(triggerAdmissionId, triggerRevision);
  const watchingThreadIds = new Set<string>();
  return (
    <SidebarSettingsContext.Provider
      value={{
        settings,
        projects,
        triggers: triggers.state,
        refreshTriggers: triggers.refresh,
        unreadThreadIds,
        selectionKey: `${selectedPage}:${selectedThreadId ?? ""}`,
      }}
    >
      <aside
        id="primary-sidebar"
        className={`sidebar${open ? " open" : ""}`}
        data-thread-density={threadDensity}
        aria-label={
          roomConversations === undefined
            ? i18n.t("shell:projectsAndThreads")
            : i18n.t("shell:conversationsProjectsAndThreads")
        }
        aria-hidden={collapsed && !open ? true : undefined}
        inert={collapsed && !open}
      >
        <header className="sidebar-header">
          <div className="new-thread-control">
            <button
              className="new-thread-action"
              title={
                typeof window !== "undefined" &&
                window.zenx?.platform === "darwin"
                  ? i18n.t("shell:newThreadShortcut", { shortcut: "⌘N" })
                  : i18n.t("shell:newThreadShortcut", { shortcut: "Ctrl+N" })
              }
              aria-keyshortcuts={
                typeof window !== "undefined" &&
                window.zenx?.platform === "darwin"
                  ? "Meta+n"
                  : "Control+n"
              }
              type="button"
              disabled={newThreadDisabled}
              onClick={() => {
                if (configuredProjects.length === 0) {
                  onNewThread();
                  return;
                }
                onNewThread(lastUsedProject?.workspace);
              }}
            >
              <Icon name="compose" size={14} />
              <span>{i18n.t("shell:newThread")}</span>
              <small title={lastUsedProject?.workspace}>
                {lastUsedProject === undefined
                  ? configuredProjects.length === 0
                    ? i18n.t("shell:addProjectFirst")
                    : i18n.t("shell:chooseProject")
                  : (lastUsedProject.name ??
                    projectLabelForSidebar(lastUsedProject.workspace))}
              </small>
            </button>
          </div>
        </header>

        <div
          className="sidebar-scroll"
          aria-labelledby="sidebar-thread-list-heading"
        >
          <PluginSpaces
            contributions={
              roomConversations === undefined
                ? pluginContributions
                : pluginContributions.filter(
                    (contribution) => contribution.page.route !== ROOM_ROUTE,
                  )
            }
            onOpen={onOpenContribution}
            selectedPage={selectedPage}
          />
          {roomConversations === undefined ? null : (
            <RoomConversationNavigation
              {...roomConversations}
              selectedRoomId={selectedRoomId}
              selectedPage={selectedPage}
              onOpen={onOpenContribution}
            />
          )}

          <div className="sidebar-view-head">
            {mode === "projects" ? (
              <button
                id="sidebar-thread-list-heading"
                className="projects-section-toggle"
                type="button"
                aria-expanded={projectsOpen}
                onClick={toggleProjects}
              >
                <Icon
                  className={projectsOpen ? "expanded" : undefined}
                  name="chevron-down"
                  size={13}
                />
                <strong>{i18n.t("shell:projects")}</strong>
              </button>
            ) : (
              <strong id="sidebar-thread-list-heading" tabIndex={-1}>
                {i18n.t("shell:inbox")}
              </strong>
            )}
            <span className="sidebar-view-actions">
              {mode === "inbox" ? <span>{threads.length}</span> : null}
              <button
                className="sidebar-density-toggle"
                type="button"
                aria-label={i18n.t("shell:threadRowsSwitch", {
                  density:
                    threadDensity === "detailed"
                      ? i18n.t("shell:detailed")
                      : i18n.t("shell:compact"),
                  next:
                    threadDensity === "detailed"
                      ? i18n.t("shell:compact")
                      : i18n.t("shell:detailed"),
                })}
                aria-pressed={threadDensity === "compact"}
                title={i18n.t("shell:threadRows", {
                  density:
                    threadDensity === "detailed"
                      ? i18n.t("shell:detailed")
                      : i18n.t("shell:compact"),
                })}
                onClick={() => {
                  const next =
                    threadDensity === "detailed" ? "compact" : "detailed";
                  setThreadDensity(next);
                  try {
                    window.localStorage.setItem(
                      THREAD_DENSITY_STORAGE_KEY,
                      next,
                    );
                  } catch {
                    // The preference remains valid for this window.
                  }
                }}
              >
                <Icon name="list-detail" size={13} />
                <span>
                  {threadDensity === "detailed"
                    ? i18n.t("shell:detailed")
                    : i18n.t("shell:compact")}
                </span>
              </button>
              {mode === "projects" ? (
                <button
                  className="sidebar-inline-action"
                  type="button"
                  aria-label={i18n.t("shell:addProject")}
                  title={i18n.t("shell:addProject")}
                  onClick={onAddProject}
                >
                  <Icon name="folder-plus" size={14} />
                </button>
              ) : null}
            </span>
          </div>
          {expansionError !== null ? (
            <p role="alert">{expansionError}</p>
          ) : null}
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
                {i18n.t("shell:tryAgain")}
              </button>
            </div>
          ) : null}
          {serverStatus.type !== "ready" ? (
            <p className="sidebar-empty">
              {i18n.t("shell:waitingForTheLocalAppServer")}
            </p>
          ) : threadLoading ? (
            <p className="sidebar-empty" role="status">
              {i18n.t("shell:loadingActiveThreads")}
            </p>
          ) : threadError !== null ? (
            <div className="sidebar-empty sidebar-error" role="alert">
              <p>{threadError}</p>
              <button type="button" onClick={onRetryThreads}>
                {i18n.t("shell:tryAgain")}
              </button>
            </div>
          ) : mode === "inbox" && threads.length === 0 ? (
            <p className="sidebar-empty">
              {i18n.t("shell:conversationsAppearHere")}
            </p>
          ) : mode === "inbox" ? (
            <InboxView
              onSelectThread={onSelectThread}
              onChangeThreadLifecycle={changeThreadLifecycle}
              onChangeThreadPinned={changeThreadPinned}
              onRenameThread={onRenameThread}
              onForkThread={onForkThread}
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
                  onChangeThreadLifecycle={changeThreadLifecycle}
                  onChangeThreadPinned={changeThreadPinned}
                  onRenameThread={onRenameThread}
                  onForkThread={onForkThread}
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
                  newThreadDisabled={newThreadDisabled}
                  onRemoveProject={onRemoveProject}
                  onEditProject={onEditProject}
                  onSetDefaultProject={onSetDefaultProject}
                  onSelectThread={onSelectThread}
                  onChangeThreadLifecycle={changeThreadLifecycle}
                  onChangeThreadPinned={changeThreadPinned}
                  onRenameThread={onRenameThread}
                  onForkThread={onForkThread}
                  onChangeProjectPinned={onChangeProjectPinned}
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
            aria-label={i18n.t("shell:settingsServiceStatus", {
              status: serviceStatusPresentation(serverStatus).label,
            })}
            title={serviceStatusPresentation(serverStatus).label}
            aria-current={selectedPage === "settings" ? "page" : undefined}
            onClick={onOpenSettings}
          >
            <Icon name="settings" />
            <span>{i18n.t("shell:settings")}</span>
            <ServiceStatusDot status={serverStatus} />
          </button>
        </footer>
      </aside>
      <button
        className={`sidebar-scrim${open ? " open" : ""}`}
        type="button"
        aria-label={i18n.t("shell:closeSidebar")}
        onClick={onClose}
      />
    </SidebarSettingsContext.Provider>
  );
}

export function PluginSpaces({
  contributions,
  onOpen,
  selectedPage,
}: {
  contributions: readonly LoadedPluginContribution[];
  onOpen(route: string): void;
  selectedPage: string;
}) {
  useTranslation("shell");
  if (contributions.length === 0) return null;
  return (
    <nav
      className="plugin-spaces"
      aria-label={i18n.t("shell:workspaceNavigation")}
    >
      {contributions.map((contribution) => (
        <button
          className="plugin-space-link"
          type="button"
          aria-current={
            selectedPage === contribution.page.route ? "page" : undefined
          }
          title={contribution.label}
          key={contribution.key}
          onClick={() => onOpen(contribution.page.route)}
        >
          <Icon name={contribution.icon} size={14} />
          <span>{contribution.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function serviceStatusPresentation(status: AppServerHostStatus): {
  className: "ready" | "starting" | "reconnecting" | "error" | "stopped";
  label: string;
} {
  switch (status.type) {
    case "ready":
      return { className: "ready", label: i18n.t("shell:localServiceReady") };
    case "starting":
      return {
        className: "starting",
        label: i18n.t("shell:localServiceStarting"),
      };
    case "reconnecting":
      return {
        className: "reconnecting",
        label: i18n.t("shell:localServiceReconnecting"),
      };
    case "error":
      return {
        className: "error",
        label: i18n.t("shell:localServiceError", { error: status.message }),
      };
    case "stopped":
      return {
        className: "stopped",
        label: i18n.t("shell:localServiceStopped"),
      };
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
  onForkThread,
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
  onForkThread(threadId: string): Promise<void>;
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
            onForkThread={onForkThread}
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
  onForkThread,
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
  onForkThread(threadId: string): Promise<void>;
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
        {i18n.t("shell:pinned")}
      </h2>
      {threads.map((thread) => (
        <ThreadRow
          hasActiveTurn={threadHasActiveTurn(thread, liveThread)}
          key={thread.threadId}
          onChangeThreadLifecycle={onChangeThreadLifecycle}
          onChangeThreadPinned={onChangeThreadPinned}
          onRenameThread={onRenameThread}
          onForkThread={onForkThread}
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
  newThreadDisabled,
  onRemoveProject,
  onEditProject,
  onSetDefaultProject,
  threads,
  selectedThreadId,
  onSelectThread,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onRenameThread,
  onForkThread,
  onChangeProjectPinned,
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
  newThreadDisabled: boolean;
  onRemoveProject(workspace: string): void;
  onEditProject?(workspace: string, name: string): void;
  onSetDefaultProject(workspace: string): void;
  threads: readonly NativeThreadSummary[];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onForkThread(threadId: string): Promise<void>;
  onChangeProjectPinned?: SidebarProps["onChangeProjectPinned"];
  onReorderProject?: SidebarProps["onReorderProject"];
  onReorderThread?: SidebarProps["onReorderThread"];
  onSidebarOrderError?: (error: unknown, retry: () => Promise<void>) => void;
  onSidebarOrderAttempt?: () => void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  liveThread: Thread | null;
  watchingThreadIds: ReadonlySet<string>;
  pinnedThreadIds: ReadonlySet<string>;
}) {
  const [dropTarget, setDropTarget] = useState<{
    kind: "project" | "thread";
    key: string;
    placement: SidebarOrderPlacement;
  } | null>(null);
  const clearDropTarget = () => setDropTarget(null);
  const leaveDropTarget = (event: ReactDragEvent<HTMLElement>) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      clearDropTarget();
  };
  const [dragging, setDragging] = useState<{
    kind: "project" | "thread";
    key: string;
  } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const beginDrag = (
    kind: "project" | "thread",
    key: string,
    label: string,
    event: ReactDragEvent<HTMLElement>,
  ) => {
    dragCleanup.current?.();
    projectDrag.current = kind === "project" ? key : null;
    if (kind === "project") threadDrag.current = null;
    setDragging({ kind, key });
    clearDropTarget();
    dragCleanup.current = startSidebarDrag(
      event.currentTarget,
      event.dataTransfer,
      label,
      kind,
      event,
      () => {
        projectDrag.current = null;
        threadDrag.current = null;
        setDragging(null);
        clearDropTarget();
      },
    );
  };
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
        <strong>{i18n.t("shell:noProjectsYet")}</strong>
        <p>{i18n.t("shell:addAFolderBeforeStartingAThread")}</p>
      </div>
    );
  }
  const groups = deriveProjectGroups(threads, projects, sidebarOrder);
  return groups.map((group, projectIndex) => (
    <ProjectRows
      pinnedProject={
        sidebarOrder.pinnedProjectKeys?.includes(group.key) ?? false
      }
      onChangeProjectPinned={onChangeProjectPinned}
      group={group}
      key={group.key}
      liveThread={liveThread}
      onChangeThreadLifecycle={onChangeThreadLifecycle}
      onChangeThreadPinned={onChangeThreadPinned}
      onRenameThread={onRenameThread}
      onForkThread={onForkThread}
      onNewThread={onNewThread}
      newThreadDisabled={newThreadDisabled}
      onRemoveProject={onRemoveProject}
      onEditProject={onEditProject}
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
              controlId: sidebarOrderControlId("project", group.key),
              dragging:
                dragging?.kind === "project" && dragging.key === group.key,
              placement:
                dropTarget?.kind === "project" && dropTarget.key === group.key
                  ? dropTarget.placement
                  : undefined,
              onDragLeave: leaveDropTarget,
              onDragStart: (event) => {
                beginDrag("project", group.key, group.label, event);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", group.key);
              },
              onDragEnd: () => {
                projectDrag.current = null;
                clearDropTarget();
              },
              onDragOver: (event) => {
                if (
                  projectDrag.current === null ||
                  projectDrag.current === group.key ||
                  (sidebarOrder.pinnedProjectKeys?.includes(
                    projectDrag.current,
                  ) ?? false) !==
                    (sidebarOrder.pinnedProjectKeys?.includes(group.key) ??
                      false)
                )
                  return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget({
                  kind: "project",
                  key: group.key,
                  placement: projectDropPlacement(event),
                });
              },
              onDrop: (event) => {
                const sourceKey = projectDrag.current;
                projectDrag.current = null;
                clearDropTarget();
                if (
                  sourceKey === null ||
                  sourceKey === group.key ||
                  (sidebarOrder.pinnedProjectKeys?.includes(sourceKey) ??
                    false) !==
                    (sidebarOrder.pinnedProjectKeys?.includes(group.key) ??
                      false)
                )
                  return;
                event.preventDefault();
                void reorderAndRestoreFocus(
                  sidebarOrderControlId("project", sourceKey),
                  () =>
                    onReorderProject(
                      sourceKey,
                      group.key,
                      projectDropPlacement(event),
                    ),
                  onSidebarOrderAttempt,
                  onSidebarOrderError,
                );
              },
              onKeyDown: (event) => {
                if (!event.altKey) return;
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
                  sidebarOrderControlId("project", group.key),
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
              targetId:
                dropTarget?.kind === "thread" ? dropTarget.key : undefined,
              placement:
                dropTarget?.kind === "thread"
                  ? dropTarget.placement
                  : undefined,
              onDragLeave: leaveDropTarget,
              draggingId:
                dragging?.kind === "thread" ? dragging.key : undefined,
              onDragStart: (threadId, event) => {
                beginDrag(
                  "thread",
                  threadId,
                  threadTitle(
                    group.threads.find(
                      (thread) => thread.threadId === threadId,
                    )!,
                  ),
                  event,
                );
                threadDrag.current = { projectKey: group.key, threadId };
                clearDropTarget();
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", threadId);
              },
              onDragEnd: () => {
                threadDrag.current = null;
                clearDropTarget();
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
                event.stopPropagation();
                setDropTarget({
                  kind: "thread",
                  key: targetThreadId,
                  placement: dropPlacement(event),
                });
              },
              onDrop: (targetThreadId, event) => {
                const source = threadDrag.current;
                threadDrag.current = null;
                clearDropTarget();
                if (
                  source === null ||
                  source.projectKey !== group.key ||
                  source.threadId === targetThreadId
                )
                  return;
                event.preventDefault();
                void reorderAndRestoreFocus(
                  sidebarOrderControlId("thread", source.threadId),
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
                if (!event.altKey) return;
                const target =
                  event.key === "ArrowUp"
                    ? group.threads[threadIndex - 1]
                    : event.key === "ArrowDown"
                      ? group.threads[threadIndex + 1]
                      : undefined;
                if (target === undefined) return;
                event.preventDefault();
                void reorderAndRestoreFocus(
                  sidebarOrderControlId("thread", threadId),
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
  dragging: boolean;
  placement?: SidebarOrderPlacement;
  onDragLeave(event: ReactDragEvent<HTMLElement>): void;
  controlId: string;
  onDragStart(event: ReactDragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
  onDragOver(event: ReactDragEvent<HTMLElement>): void;
  onDrop(event: ReactDragEvent<HTMLElement>): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
}

interface ThreadReorderHandlers {
  draggingId?: string;
  targetId?: string;
  placement?: SidebarOrderPlacement;
  onDragLeave(event: ReactDragEvent<HTMLElement>): void;
  onDragStart(threadId: string, event: ReactDragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
  onDragOver(threadId: string, event: ReactDragEvent<HTMLDivElement>): void;
  onDrop(threadId: string, event: ReactDragEvent<HTMLDivElement>): void;
  onKeyDown(
    threadIndex: number,
    threadId: string,
    event: ReactKeyboardEvent<HTMLElement>,
  ): void;
}

function ProjectRows({
  group,
  pinnedProject,
  onChangeProjectPinned,
  onNewThread,
  newThreadDisabled,
  onRemoveProject,
  onEditProject,
  onSetDefaultProject,
  selectedThreadId,
  onSelectThread,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onRenameThread,
  onForkThread,
  pendingApprovalThreadIds,
  liveThread,
  watchingThreadIds,
  pinnedThreadIds,
  projectReorder,
  threadReorder,
}: {
  group: ReturnType<typeof deriveProjectGroups>[number];
  pinnedProject: boolean;
  onChangeProjectPinned?: SidebarProps["onChangeProjectPinned"];
  onNewThread(workspace?: string): void;
  newThreadDisabled: boolean;
  onRemoveProject(workspace: string): void;
  onEditProject?(workspace: string, name: string): void;
  onSetDefaultProject(workspace: string): void;
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onForkThread(threadId: string): Promise<void>;
  pendingApprovalThreadIds: ReadonlySet<string>;
  liveThread: Thread | null;
  watchingThreadIds: ReadonlySet<string>;
  pinnedThreadIds: ReadonlySet<string>;
  projectReorder?: ProjectReorderHandlers;
  threadReorder?: ThreadReorderHandlers;
}) {
  const [open, toggleOpen, expansionError] = useSidebarExpansion(
    `project:${group.key}`,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
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
        !actionsRef.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      ) {
        closeMenu(false);
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
      data-dragging={projectReorder?.dragging || undefined}
      data-drop-placement={projectReorder?.placement}
      onDragLeave={projectReorder?.onDragLeave}
      onDragOver={projectReorder?.onDragOver}
      onDrop={projectReorder?.onDrop}
    >
      {expansionError !== null ? <p role="alert">{expansionError}</p> : null}
      <div
        className={`project-header${projectSelected ? " selected" : ""}${projectReorder === undefined ? "" : " reorderable"}`}
        draggable={projectReorder !== undefined}
        onDragStart={(event) => {
          if (
            (event.target as HTMLElement | null)?.closest(
              ".project-actions",
            ) !== null
          ) {
            event.preventDefault();
            return;
          }
          projectReorder?.onDragStart(event);
        }}
        onDragEnd={projectReorder?.onDragEnd}
      >
        <button
          className="project-toggle"
          draggable={projectReorder !== undefined}
          type="button"
          id={projectReorder?.controlId}
          aria-expanded={open && !projectReorder?.dragging}
          aria-keyshortcuts={
            projectReorder === undefined
              ? undefined
              : "Alt+ArrowUp Alt+ArrowDown"
          }
          title={group.workspace ?? undefined}
          onClick={toggleOpen}
          onKeyDown={projectReorder?.onKeyDown}
        >
          <Icon name="folder" size={14} />
          <span>{group.label}</span>
          {pinnedProject ? (
            <Icon
              name="pin"
              size={12}
              aria-label={i18n.t("shell:pinnedProject")}
            />
          ) : null}
        </button>
        {group.workspace === null || !group.configured ? null : (
          <div className="project-actions" ref={actionsRef}>
            <button
              type="button"
              aria-label={i18n.t("shell:newThreadIn", { project: group.label })}
              title={i18n.t("shell:newThreadHere")}
              disabled={newThreadDisabled}
              onClick={() => onNewThread(group.workspace!)}
            >
              <Icon name="compose" size={13} />
            </button>
            <button
              ref={moreRef}
              className="project-more-trigger"
              type="button"
              id={`project-more-trigger-${encodeURIComponent(group.key)}`}
              aria-label={i18n.t("shell:moreActionsFor", {
                project: group.label,
              })}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-controls={menuOpen ? projectMenuId : undefined}
              title={i18n.t("shell:moreActions")}
              onClick={toggleMenu}
              onKeyDown={handleMoreKeyDown}
            >
              <Icon name="more" size={15} />
            </button>
            {menuOpen ? (
              <SidebarMenuPopover
                anchorRef={moreRef}
                className="project-menu"
                id={projectMenuId}
                menuRef={menuRef}
                role="menu"
                aria-labelledby={`project-more-trigger-${encodeURIComponent(group.key)}`}
                aria-label={i18n.t("shell:projectActions", {
                  project: group.label,
                })}
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
                <div className="project-menu-summary">
                  <strong>{group.label}</strong>
                  <span>
                    {group.threads.length}{" "}
                    {group.threads.length === 1 ? "thread" : "threads"}
                  </span>
                  <span title={group.workspace ?? undefined}>
                    {group.workspace}
                  </span>
                </div>
                {onChangeProjectPinned ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={pinBusy}
                    onClick={async () => {
                      setPinBusy(true);
                      setPinError(null);
                      try {
                        await onChangeProjectPinned(group.key);
                        closeMenu();
                      } catch (error) {
                        setPinError(
                          i18n.t("shell:couldNotSaveProjectPin", {
                            error:
                              error instanceof Error
                                ? error.message
                                : String(error),
                          }),
                        );
                      } finally {
                        setPinBusy(false);
                      }
                    }}
                  >
                    <Icon name={pinnedProject ? "pin-off" : "pin"} size={13} />
                    <span>
                      {pinBusy
                        ? i18n.t("shell:saving")
                        : pinnedProject
                          ? i18n.t("shell:unpinProject")
                          : i18n.t("shell:pinProject")}
                    </span>
                  </button>
                ) : null}
                {pinError !== null ? <p role="alert">{pinError}</p> : null}
                {onEditProject ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu(false);
                      onEditProject(group.workspace!, group.label);
                    }}
                  >
                    <Icon name="settings" size={13} />
                    <span>{i18n.t("shell:editProject")}</span>
                  </button>
                ) : null}
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
                    <span>{i18n.t("shell:setAsDefault")}</span>
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
                  <span>{i18n.t("shell:removeFromZenx")}</span>
                </button>
              </SidebarMenuPopover>
            ) : null}
          </div>
        )}
      </div>
      <div
        className="project-disclosure"
        data-open={open}
        inert={!open}
        aria-hidden={!open}
      >
        <div>
          {group.threads.length === 0 ? (
            <p className="project-empty">{i18n.t("shell:noThreadsYet")}</p>
          ) : (
            group.threads.map((thread, threadIndex) => (
              <ThreadRow
                hasActiveTurn={threadHasActiveTurn(thread, liveThread)}
                key={thread.threadId}
                onChangeThreadLifecycle={onChangeThreadLifecycle}
                onChangeThreadPinned={onChangeThreadPinned}
                onRenameThread={onRenameThread}
                onForkThread={onForkThread}
                onSelectThread={onSelectThread}
                pendingApproval={pendingApprovalThreadIds.has(thread.threadId)}
                pinned={pinnedThreadIds.has(thread.threadId)}
                selected={thread.threadId === selectedThreadId}
                thread={thread}
                projectWorkspace={group.workspace}
                watching={watchingThreadIds.has(thread.threadId)}
                reorder={
                  threadReorder === undefined
                    ? undefined
                    : {
                        controlId: sidebarOrderControlId(
                          "thread",
                          thread.threadId,
                        ),
                        dragging: threadReorder.draggingId === thread.threadId,
                        placement:
                          threadReorder.targetId === thread.threadId
                            ? threadReorder.placement
                            : undefined,
                        onDragLeave: threadReorder.onDragLeave,
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
          )}
        </div>
      </div>
    </section>
  );
}

interface ThreadRowReorderHandlers {
  dragging: boolean;
  placement?: SidebarOrderPlacement;
  onDragLeave(event: ReactDragEvent<HTMLElement>): void;
  controlId: string;
  onDragStart(event: ReactDragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
  onDragOver(event: ReactDragEvent<HTMLDivElement>): void;
  onDrop(event: ReactDragEvent<HTMLDivElement>): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void;
}

function ThreadRow({
  thread,
  projectWorkspace,
  selected,
  hasActiveTurn,
  onChangeThreadLifecycle,
  onChangeThreadPinned,
  onRenameThread,
  onForkThread,
  onSelectThread,
  pendingApproval,
  pinned,
  watching,
  inbox = false,
  reorder,
}: {
  thread: NativeThreadSummary;
  projectWorkspace?: string | null;
  selected: boolean;
  hasActiveTurn: boolean;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onChangeThreadPinned(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onForkThread(threadId: string): Promise<void>;
  onSelectThread(threadId: string): void;
  pendingApproval: boolean;
  pinned: boolean;
  watching: boolean;
  inbox?: boolean;
  reorder?: ThreadRowReorderHandlers;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const information = useContext(SidebarSettingsContext);
  const detailsRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuEpoch = useRef(0);
  const suppressDetailsFocus = useRef(false);
  const clearDetailsTimer = () => {
    if (detailsTimer.current !== null) clearTimeout(detailsTimer.current);
    detailsTimer.current = null;
  };
  const showDetails = (immediate = false) => {
    clearDetailsTimer();
    if (menuOpen) return;
    const open = () => {
      setDetailsOpen(true);
      void information?.refreshTriggers();
    };
    if (immediate) open();
    else detailsTimer.current = setTimeout(open, 350);
  };
  const leaveDetails = () => {
    clearDetailsTimer();
    detailsTimer.current = setTimeout(() => {
      if (
        !detailsRef.current?.contains(document.activeElement) &&
        !rowRef.current?.contains(document.activeElement)
      )
        setDetailsOpen(false);
    }, 180);
  };
  useEffect(
    () => () => {
      clearDetailsTimer();
      menuEpoch.current += 1;
    },
    [],
  );

  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreMenuFocusRef = useRef(false);
  const initialMenuFocusRef = useRef<"first" | "last">("first");
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(threadTitle(thread));
  const [busyAction, setBusyAction] = useState<
    "rename" | "copy" | "pin" | "unpin" | "archive" | "unarchive" | null
  >(null);
  const busyActionRef = useRef(false);
  const actionFocusRef = useRef<Element | null>(null);
  const retryFocusRef = useRef<string | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (busyAction !== null || retryFocusRef.current === null) return;
    const action = retryFocusRef.current;
    retryFocusRef.current = null;
    menuRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-thread-action="${action}"]:not(:disabled)`,
      )
      ?.focus({ preventScroll: true });
  }, [busyAction, menuError]);
  const closeMenu = (restoreFocus = true) => {
    menuEpoch.current += 1;
    const focused = document.activeElement;
    const ownsFocus =
      menuRef.current?.contains(focused) ||
      focused === menuTriggerRef.current ||
      (focused === document.body &&
        document.hasFocus() &&
        actionFocusRef.current?.matches(":disabled"));
    restoreMenuFocusRef.current = restoreFocus && !!ownsFocus;
    setMenuOpen(false);
    setRenaming(false);
  };
  const lastSelectionKey = useRef(information?.selectionKey);
  useLayoutEffect(() => {
    if (lastSelectionKey.current === information?.selectionKey) return;
    lastSelectionKey.current = information?.selectionKey;
    clearDetailsTimer();
    setDetailsOpen(false);
    closeMenu(false);
  }, [information?.selectionKey]);
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
      if (
        !rowRef.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      ) {
        closeMenu(false);
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
    // The ellipsis can be hidden as soon as the editor closes. Restore to the
    // always-visible row, without reopening its hover information.
    suppressDetailsFocus.current = true;
    const row = rowRef.current?.querySelector<HTMLElement>(".thread-row");
    (row ?? menuTriggerRef.current)?.focus({ preventScroll: true });
  }, [menuOpen]);

  useEffect(() => {
    if (!detailsOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        !rowRef.current?.contains(event.target as Node) &&
        !detailsRef.current?.contains(event.target as Node)
      )
        setDetailsOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [detailsOpen]);
  const boundTriggers =
    information?.triggers.triggers.filter(
      (t) => t.threadId === thread.threadId,
    ) ?? [];
  const unread = information?.unreadThreadIds.has(thread.threadId) ?? false;
  const statusCount =
    Number(boundTriggers.length > 0) +
    Number(hasActiveTurn || pendingApproval || watching) +
    Number(unread);
  const beginRename = () => {
    clearDetailsTimer();
    setDetailsOpen(false);
    menuEpoch.current += 1;
    setMenuError(null);
    setRenameDraft(threadTitle(thread));
    setRenaming(true);
    setMenuOpen(true);
  };
  const project = information?.projects.projects.find((p) =>
    p.threadIds.includes(thread.threadId),
  );
  const detailsContents = (
    <ThreadInformation
      thread={thread}
      projectName={project?.name ?? threadProject(thread)}
      projectPath={
        project?.workspace ??
        (thread.status === "systemError" ? null : thread.currentMetadata.cwd)
      }
      triggers={boundTriggers}
      triggerStatus={information?.triggers.status ?? "unavailable"}
      onRename={beginRename}
    />
  );
  const identity = threadModelIdentity(thread);
  const settings = information?.settings ?? null;
  const providerProfileId =
    thread.status === "systemError"
      ? undefined
      : thread.currentMetadata.providerProfileId;
  const providerProfile = settings?.profile.providerProfiles.find(
    (candidate) => candidate.providerProfileId === providerProfileId,
  );
  const customLogo =
    providerProfileId === undefined
      ? undefined
      : settings?.providerLogoDataUrls?.[providerProfileId];
  const logoKind =
    settings !== null &&
    providerProfileId !== undefined &&
    (providerProfile === undefined ||
      (providerProfile.logoResource !== undefined && customLogo === undefined))
      ? "generic"
      : identity?.providerKind;
  const modelProvider =
    thread.status === "systemError" ? null : thread.currentMetadata.provider;
  const contents = (
    <>
      {inbox ||
      (projectWorkspace !== undefined &&
        thread.status !== "systemError" &&
        thread.currentMetadata.cwd &&
        thread.currentMetadata.cwd !== projectWorkspace) ? (
        <span
          className="thread-project"
          title={
            thread.status === "systemError"
              ? undefined
              : (thread.currentMetadata.cwd ?? undefined)
          }
        >
          <Icon name="folder" size={12} />
          {inbox
            ? threadProject(thread)
            : i18n.t("shell:directoryLabel", { path: threadProject(thread) })}
        </span>
      ) : null}
      <span className="thread-title">
        <span>{threadTitle(thread)}</span>
      </span>
      {(identity === null || modelProvider === null) &&
      !pendingApproval &&
      !hasActiveTurn ? null : (
        <span className="thread-model">
          {identity === null || modelProvider === null ? null : (
            <>
              <ProviderLogo
                kind={logoKind ?? "generic"}
                customSrc={customLogo}
              />
              <span className="thread-model-name" title={identity.label}>
                {identity.label}
              </span>
            </>
          )}
          {pendingApproval || hasActiveTurn ? (
            <span className="thread-state-inline">
              {pendingApproval
                ? i18n.t("shell:needsYourApproval")
                : i18n.t("shell:working")}
            </span>
          ) : null}
        </span>
      )}
    </>
  );
  const runAction = async (
    action: "rename" | "copy" | "pin" | "unpin" | "archive" | "unarchive",
    operation: () => Promise<void>,
  ) => {
    if (busyActionRef.current) return;
    busyActionRef.current = true;
    actionFocusRef.current = document.activeElement;
    const epoch = menuEpoch.current;
    setBusyAction(action);
    setMenuError(null);
    try {
      if (action !== "rename" && action !== "archive" && action !== "unarchive")
        focusThreadListHeading();
      await operation();
      if (action === "copy") focusThreadListHeading(false);
      if (epoch === menuEpoch.current) closeMenu(action === "rename");
    } catch (error) {
      if (epoch !== menuEpoch.current) return;
      setMenuError(error instanceof Error ? error.message : String(error));
      if (action !== "rename") {
        retryFocusRef.current = action;
      }
    } finally {
      busyActionRef.current = false;
      actionFocusRef.current = null;
      setBusyAction(null);
    }
  };
  return (
    <div
      ref={rowRef}
      className={`thread-row-shell${reorder === undefined ? "" : " reorderable"}`}
      data-thread-id={thread.threadId}
      data-selected={selected || undefined}
      data-menu-open={menuOpen || undefined}
      data-unread={unread || undefined}
      style={
        {
          "--thread-state-space": `${statusCount * 28}px`,
        } as CSSProperties
      }
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") showDetails();
      }}
      onPointerLeave={leaveDetails}
      onFocus={(event) => {
        if (suppressDetailsFocus.current) {
          suppressDetailsFocus.current = false;
          return;
        }
        if (event.target === rowRef.current?.querySelector(".thread-row"))
          showDetails(true);
      }}
      onBlur={leaveDetails}
      data-dragging={reorder?.dragging || undefined}
      data-drop-placement={reorder?.placement}
      onDragLeave={reorder?.onDragLeave}
      draggable={reorder !== undefined}
      onDragStart={(event) => {
        if (
          (event.target as HTMLElement | null)?.closest(
            ".thread-menu-trigger, .thread-item-menu, .thread-information",
          ) !== null
        ) {
          event.preventDefault();
          return;
        }
        reorder?.onDragStart(event);
      }}
      onDragEnd={reorder?.onDragEnd}
      onDragOver={reorder?.onDragOver}
      onDrop={reorder?.onDrop}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (menuOpen || detailsOpen)) {
          event.preventDefault();
          event.stopPropagation();
          clearDetailsTimer();
          setDetailsOpen(false);
          if (menuOpen) closeMenu();
        }
        if (!menuOpen && event.key === "ArrowRight") {
          event.preventDefault();
          showDetails(true);
          requestAnimationFrame(() =>
            detailsRef.current
              ?.querySelector<HTMLButtonElement>("button")
              ?.focus(),
          );
        }
      }}
    >
      {thread.status === "systemError" ? (
        <div
          className={`thread-row system-error${inbox ? " inbox" : ""}`}
          id={reorder?.controlId}
          tabIndex={reorder === undefined ? undefined : 0}
          aria-keyshortcuts={
            reorder === undefined ? undefined : "Alt+ArrowUp Alt+ArrowDown"
          }
          onKeyDown={reorder?.onKeyDown}
        >
          {contents}
        </div>
      ) : (
        <button
          className={`thread-row${selected ? " selected" : ""}${inbox ? " inbox" : ""}`}
          type="button"
          id={reorder?.controlId}
          aria-current={selected ? "page" : undefined}
          aria-keyshortcuts={
            reorder === undefined ? undefined : "Alt+ArrowUp Alt+ArrowDown"
          }
          onClick={() => {
            setDetailsOpen(false);
            onSelectThread(thread.threadId);
          }}
          onKeyDown={reorder?.onKeyDown}
        >
          {contents}
        </button>
      )}
      <span className="thread-status-rail">
        {boundTriggers.length > 0 ? (
          <span className="thread-status-slot">
            <Icon
              name="clock"
              size={16}
              aria-label={i18n.t("shell:threadAutomationCount", {
                count: boundTriggers.length,
              })}
            />
          </span>
        ) : null}
        {pendingApproval || hasActiveTurn || watching ? (
          <span className="thread-status-slot">
            {pendingApproval ? (
              <span
                className="needs-dot"
                aria-label={i18n.t("shell:needsYou")}
              />
            ) : hasActiveTurn ? (
              <svg
                className="thread-running-spinner"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                role="img"
                aria-label={i18n.t("shell:running")}
              >
                <circle
                  cx="8"
                  cy="8"
                  r="5.7"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray="27 9"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <Icon
                name="moon"
                size={16}
                aria-label={i18n.t("shell:watching")}
              />
            )}
          </span>
        ) : null}
        {unread ? (
          <span className="thread-status-slot">
            <span
              className="thread-unread-dot"
              aria-label={i18n.t("shell:threadUnreadReply")}
            />
          </span>
        ) : null}
        <button
          ref={menuTriggerRef}
          className="thread-menu-trigger"
          type="button"
          id={`thread-menu-trigger-${thread.threadId}`}
          aria-label={i18n.t("shell:manageThread", {
            title: threadTitle(thread),
          })}
          aria-haspopup={renaming ? "dialog" : "menu"}
          aria-expanded={menuOpen}
          aria-controls={
            menuOpen ? `thread-menu-${thread.threadId}` : undefined
          }
          title={i18n.t("shell:manageThread", { title: threadTitle(thread) })}
          onClick={() => {
            if (menuOpen) {
              closeMenu();
              return;
            }
            clearDetailsTimer();
            setDetailsOpen(false);
            menuEpoch.current += 1;
            void information?.refreshTriggers();
            initialMenuFocusRef.current = "first";
            setMenuError(null);
            setRenaming(false);
            setRenameDraft(threadTitle(thread));
            setMenuOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            clearDetailsTimer();
            setDetailsOpen(false);
            menuEpoch.current += 1;
            void information?.refreshTriggers();
            initialMenuFocusRef.current =
              event.key === "ArrowUp" ? "last" : "first";
            setMenuError(null);
            setRenaming(false);
            setRenameDraft(threadTitle(thread));
            setMenuOpen(true);
          }}
        >
          <Icon name="more" size={16} />
        </button>
      </span>
      {detailsOpen && !menuOpen ? (
        <SidebarMenuPopover
          anchorRef={rowRef}
          menuRef={detailsRef}
          className="thread-information"
          role="dialog"
          aria-label={i18n.t("shell:threadDetails")}
          onPointerEnter={clearDetailsTimer}
          onPointerLeave={leaveDetails}
          onFocus={clearDetailsTimer}
          onBlur={leaveDetails}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              clearDetailsTimer();
              setDetailsOpen(false);
              suppressDetailsFocus.current = true;
              rowRef.current
                ?.querySelector<HTMLButtonElement>(".thread-row")
                ?.focus();
            }
          }}
        >
          {detailsContents}
        </SidebarMenuPopover>
      ) : null}
      <ThreadItemMenu
        details={detailsContents}
        archived={thread.archived}
        busyAction={busyAction}
        error={menuError}
        hasActiveTurn={hasActiveTurn}
        labelledBy={`thread-menu-trigger-${thread.threadId}`}
        menuId={`thread-menu-${thread.threadId}`}
        menuRef={menuRef}
        menuTriggerRef={menuTriggerRef}
        open={menuOpen}
        pinned={pinned}
        renaming={renaming}
        renameDraft={renameDraft}
        onArchive={() =>
          void runAction("archive", () => onChangeThreadLifecycle(thread))
        }
        onBeginRename={beginRename}
        onCopy={() =>
          void runAction("copy", () => onForkThread(thread.threadId))
        }
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

function ThreadInformation({
  thread,
  projectName,
  projectPath,
  triggers,
  triggerStatus,
  onRename,
}: {
  thread: NativeThreadSummary;
  projectName: string;
  projectPath: string | null;
  triggers: SidebarTriggerState["triggers"];
  triggerStatus: SidebarTriggerState["status"];
  onRename(): void;
}) {
  const [now, setNow] = useState(Date.now);
  const next = nextSidebarTrigger(triggers, now);
  useEffect(() => {
    setNow(Date.now());
  }, [triggers]);
  useEffect(() => {
    if (next.nextRunAt === null) return;
    // Expire only this displayed timestamp. The Trigger service owns scheduling.
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(1, next.nextRunAt - Date.now() + 1)),
    );
    return () => clearTimeout(timer);
  }, [next.nextRunAt]);
  // Native message metadata is optional on older/unavailable Hosts. Never use
  // updatedAt (tool calls, title changes, etc.) as a message timestamp.
  const lastMessage =
    thread.status === "systemError" ? undefined : thread.lastMessage;
  const messageAt = lastMessage?.createdAt;
  const formatDate = (value: string | number | undefined) => {
    if (value === undefined || !Number.isFinite(new Date(value).getTime()))
      return i18n.t("shell:threadFactUnknown");
    return new Date(value).toLocaleString(i18n.language, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };
  // Sidebar summaries come exclusively from manager.listThreadSummaries's
  // host-local child IPC. Fleet remote references are not admitted here.
  return (
    <>
      <button
        type="button"
        className="thread-information-title"
        onClick={onRename}
        aria-label={i18n.t("shell:renameThreadNamed", {
          title: threadTitle(thread),
        })}
      >
        <span>{threadTitle(thread)}</span>
        <Icon name="compose" size={14} />
      </button>
      <dl className="thread-information-facts">
        <div>
          <dt>{i18n.t("shell:threadProjectLabel")}</dt>
          <dd>
            {projectName}
            <small>{projectPath}</small>
          </dd>
        </div>
        <div>
          <dt>{i18n.t("shell:threadMachineLabel")}</dt>
          <dd>{i18n.t("shell:threadThisMachine")}</dd>
        </div>
        <div>
          <dt>{i18n.t("shell:threadLastMessage")}</dt>
          <dd>
            {messageAt ? (
              <time dateTime={messageAt}>{formatDate(messageAt)}</time>
            ) : (
              i18n.t("shell:threadFactUnknown")
            )}
          </dd>
        </div>
        {triggers.length > 0 ? (
          <div>
            <dt>{i18n.t("shell:threadNextTrigger")}</dt>
            <dd>
              {triggerStatus !== "ready" ? (
                i18n.t("shell:threadFactUnknown")
              ) : next.nextRunAt !== null ? (
                <time dateTime={new Date(next.nextRunAt).toISOString()}>
                  {formatDate(next.nextRunAt)}
                </time>
              ) : (
                i18n.t(
                  next.state === "paused"
                    ? "shell:threadTriggersPaused"
                    : next.state === "event"
                      ? "shell:threadTriggerOnEvent"
                      : "shell:threadFactUnknown",
                )
              )}
              {next.incomplete && next.nextRunAt !== null ? (
                <small>{i18n.t("shell:threadOtherTriggersUnknown")}</small>
              ) : null}
              <small>
                {i18n.t("shell:threadAutomationCount", {
                  count: triggers.length,
                })}
              </small>
            </dd>
          </div>
        ) : triggerStatus !== "ready" ? (
          <div>
            <dt>{i18n.t("shell:threadAutomationsLabel")}</dt>
            <dd>{i18n.t("shell:threadFactUnknown")}</dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}

export function ThreadItemMenu({
  details,
  archived,
  busyAction,
  error,
  hasActiveTurn,
  labelledBy,
  menuId,
  menuRef,
  menuTriggerRef,
  open,
  pinned,
  renaming,
  renameDraft,
  onArchive,
  onBeginRename,
  onCopy = () => undefined,
  onCancelRename,
  onRequestClose,
  onDraftChange,
  onPin,
  onRename,
  onUnarchive,
}: {
  details?: ReactNode;
  archived: boolean;
  busyAction:
    "rename" | "copy" | "pin" | "unpin" | "archive" | "unarchive" | null;
  error: string | null;
  hasActiveTurn: boolean;
  labelledBy?: string;
  menuId?: string;
  menuRef?: RefObject<HTMLDivElement | null>;
  menuTriggerRef?: RefObject<HTMLButtonElement | null>;
  open: boolean;
  pinned: boolean;
  renaming: boolean;
  renameDraft: string;
  onArchive(): void;
  onBeginRename(): void;
  onCopy?(): void;
  onCancelRename(): void;
  onRequestClose?(): void;
  onDraftChange(value: string): void;
  onPin(): void;
  onRename(): void;
  onUnarchive(): void;
}) {
  const composing = useRef(false);
  const renameInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    // Composition belongs to this input lifetime, not the persistent menu.
    composing.current = false;
    if (!open || !renaming) return;
    const previousFocus = document.activeElement;
    const input = renameInput.current;
    const request =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    const cancel = window.cancelAnimationFrame ?? window.clearTimeout;
    const frame = request(() => {
      if (!input?.isConnected) return;
      // The portal is initially hidden until positioned. React autoFocus runs
      // too early in Chromium; only complete that same focus intent afterward.
      if (
        document.activeElement === previousFocus ||
        (document.activeElement === document.body &&
          !previousFocus?.isConnected)
      )
        input.focus({ preventScroll: true });
    });
    return () => cancel(frame);
  }, [open, renaming]);
  if (!open) return null;
  const busy = busyAction !== null;
  return (
    <SidebarMenuPopover
      anchorRef={menuTriggerRef}
      className="thread-item-menu"
      id={menuId}
      menuRef={menuRef}
      role={renaming ? "dialog" : "menu"}
      aria-labelledby={labelledBy}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onRequestClose?.();
          return;
        }
        if (
          renaming ||
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
      {!renaming && details ? (
        <div className="thread-menu-information">{details}</div>
      ) : null}
      {renaming ? (
        <form
          className="thread-menu-rename"
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (composing.current ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229)
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || composing.current || !renameDraft.trim()) return;
            onRename();
          }}
        >
          <label>
            <span>{i18n.t("shell:threadName")}</span>
            <input
              ref={renameInput}
              autoFocus
              value={renameDraft}
              onChange={(event) => onDraftChange(event.target.value)}
            />
          </label>
          <div>
            <button type="submit" disabled={busy || !renameDraft.trim()}>
              {busyAction === "rename"
                ? i18n.t("shell:saving")
                : i18n.t("shell:save")}
            </button>
            <button type="button" disabled={busy} onClick={onCancelRename}>
              {i18n.t("shell:cancel")}
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
          {busyAction === "unarchive"
            ? i18n.t("shell:unarchiving")
            : i18n.t("shell:unarchive")}
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
            {i18n.t("shell:rename")}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-thread-action="copy"
            disabled={busy}
            title={i18n.t(
              "shell:copiesThroughTheLatestCompleteTurnAndUsesTheSameWorkingDirectory",
            )}
            onClick={onCopy}
          >
            <Icon name="copy" />
            {busyAction === "copy"
              ? i18n.t("shell:copying")
              : i18n.t("shell:copyThread")}
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
              ? i18n.t("shell:pinning")
              : busyAction === "unpin"
                ? i18n.t("shell:unpinning")
                : pinned
                  ? i18n.t("shell:unpin")
                  : i18n.t("shell:pin")}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-thread-action="archive"
            disabled={busy || hasActiveTurn}
            title={
              hasActiveTurn
                ? i18n.t("shell:waitForTheActiveTurnToFinishBeforeArchiving")
                : undefined
            }
            onClick={onArchive}
          >
            <Icon name="archive" />
            {busyAction === "archive"
              ? i18n.t("shell:archiving")
              : i18n.t("shell:archive")}
          </button>
          {hasActiveTurn ? (
            <p className="thread-menu-help">
              {i18n.t("shell:waitForTheActiveTurnToFinishBeforeArchiving")}
            </p>
          ) : null}
        </>
      )}
      {error === null ? null : <p role="alert">{error}</p>}
    </SidebarMenuPopover>
  );
}

const SIDEBAR_MENU_GAP = 6;
const SIDEBAR_MENU_VIEWPORT_MARGIN = 8;

function SidebarMenuPopover({
  anchorRef,
  children,
  className,
  menuRef,
  ...props
}: {
  anchorRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  className: string;
  menuRef?: RefObject<HTMLDivElement | null>;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "className">) {
  const [layout, setLayout] = useState<SidebarMenuLayout | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef?.current;
    const menu = menuRef?.current;
    if (
      anchor === undefined ||
      anchor === null ||
      menu === undefined ||
      menu === null
    ) {
      return;
    }
    const update = () => {
      const next = sidebarMenuLayout(
        anchor.getBoundingClientRect(),
        menu.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
      );
      setLayout((current) =>
        current?.left === next.left &&
        current.top === next.top &&
        current.placement === next.placement
          ? current
          : next,
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(anchor);
    observer?.observe(menu);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [anchorRef, menuRef]);

  const element = (
    <div
      {...props}
      ref={menuRef}
      className={className}
      data-placement={layout?.placement}
      style={anchorRef === undefined ? undefined : popoverStyle(layout)}
    >
      {children}
    </div>
  );
  return anchorRef === undefined || typeof document === "undefined"
    ? element
    : createPortal(element, document.body);
}

interface SidebarMenuLayout {
  left: number;
  top: number;
  placement: "left" | "right";
}

function sidebarMenuLayout(
  anchor: DOMRect,
  menu: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): SidebarMenuLayout {
  const right = anchor.right + SIDEBAR_MENU_GAP;
  const left = anchor.left - SIDEBAR_MENU_GAP - menu.width;
  const rightFits =
    right + menu.width <= viewportWidth - SIDEBAR_MENU_VIEWPORT_MARGIN;
  const leftFits = left >= SIDEBAR_MENU_VIEWPORT_MARGIN;
  const placement =
    rightFits || (!leftFits && viewportWidth - anchor.right >= anchor.left)
      ? "right"
      : "left";
  const preferredLeft = placement === "right" ? right : left;
  const maxLeft = Math.max(
    SIDEBAR_MENU_VIEWPORT_MARGIN,
    viewportWidth - SIDEBAR_MENU_VIEWPORT_MARGIN - menu.width,
  );
  const maxTop = Math.max(
    SIDEBAR_MENU_VIEWPORT_MARGIN,
    viewportHeight - SIDEBAR_MENU_VIEWPORT_MARGIN - menu.height,
  );
  return {
    left: Math.round(
      Math.min(Math.max(preferredLeft, SIDEBAR_MENU_VIEWPORT_MARGIN), maxLeft),
    ),
    top: Math.round(
      Math.min(Math.max(anchor.top, SIDEBAR_MENU_VIEWPORT_MARGIN), maxTop),
    ),
    placement,
  };
}

function popoverStyle(layout: SidebarMenuLayout | null): CSSProperties {
  return {
    left: `${layout?.left ?? 0}px`,
    top: `${layout?.top ?? 0}px`,
    visibility: layout === null ? "hidden" : undefined,
  };
}

function enabledMenuItems(container: HTMLElement | null): HTMLButtonElement[] {
  if (container === null) return [];
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    ),
  );
}

function sidebarOrderControlId(
  kind: "project" | "thread",
  identifier: string,
): string {
  return `sidebar-${kind}-order-${encodeURIComponent(identifier)}`;
}

// A project's children can be arbitrarily tall; its header is the sorting hitbox.
function projectDropPlacement(
  event: ReactDragEvent<HTMLElement>,
): SidebarOrderPlacement {
  const header = event.currentTarget.querySelector(".project-header");
  const bounds = (header ?? event.currentTarget).getBoundingClientRect();
  return bounds.height > 0 && event.clientY >= bounds.top + bounds.height / 2
    ? "after"
    : "before";
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
  controlId: string,
  operation: () => Promise<void>,
  onAttempt?: () => void,
  onError?: (error: unknown, retry: () => Promise<void>) => void,
): Promise<void> {
  onAttempt?.();
  try {
    await operation();
  } catch (error) {
    onError?.(error, () =>
      reorderAndRestoreFocus(controlId, operation, onAttempt, onError),
    );
  } finally {
    const restore = () => document.getElementById(controlId)?.focus();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(restore);
    } else {
      queueMicrotask(restore);
    }
  }
}
