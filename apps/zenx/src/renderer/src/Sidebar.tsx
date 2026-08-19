import { useEffect, useMemo, useRef, useState } from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { TriggerSnapshot } from "../../main/trigger-types.js";
import type { Thread } from "../../protocol-client/index.js";
import { Icon } from "./icons.js";
import type { LoadedPluginContribution } from "./plugin-contributions.js";
import {
  deriveInboxSections,
  deriveProjectGroups,
  threadModelIdentity,
  threadHasActiveTurn,
  threadProject,
  threadTitle,
  type SidebarMode,
  type ThreadScope,
} from "./thread-list.js";

interface SidebarProps {
  mode: SidebarMode;
  open: boolean;
  onClose(): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onModeChange(mode: SidebarMode): void;
  onNewThread(): void;
  onOpenContribution(page: "triggers" | "rooms"): void;
  onOpenSettings(): void;
  onRetryThreads(): void;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onSelectThread(threadId: string): void;
  onThreadScopeChange(scope: ThreadScope): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  pluginContributions: readonly LoadedPluginContribution[];
  selectedPage: "agent" | "triggers" | "rooms" | "settings";
  selectedThreadId: string | null;
  serverReady: boolean;
  liveThread: Thread | null;
  threadError: string | null;
  threadLoading: boolean;
  threadScope: ThreadScope;
  threads: readonly NativeThreadSummary[];
  triggerSnapshot: TriggerSnapshot;
}

export function Sidebar({
  mode,
  open,
  onClose,
  onChangeThreadLifecycle,
  onModeChange,
  onNewThread,
  onOpenContribution,
  onOpenSettings,
  onRetryThreads,
  onRenameThread,
  onSelectThread,
  onThreadScopeChange,
  pendingApprovalThreadIds,
  pluginContributions,
  selectedPage,
  selectedThreadId,
  serverReady,
  liveThread,
  threadError,
  threadLoading,
  threadScope,
  threads,
  triggerSnapshot,
}: SidebarProps) {
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
            <div className="brand" aria-label="ZenX">
              <BrandMark />
              <span>ZENX</span>
            </div>
            <div className="brand-actions">
              {threadScope === "active" ? (
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
              ) : null}
              <button
                className="icon-button"
                type="button"
                aria-label="New thread"
                onClick={onNewThread}
              >
                <Icon name="compose" />
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

          <div
            className="thread-scope-tabs"
            role="tablist"
            aria-label="Thread views"
          >
            {(["active", "archived"] as const).map((scope) => (
              <button
                aria-controls="thread-scope-panel"
                id={`thread-scope-${scope}`}
                key={scope}
                type="button"
                role="tab"
                aria-selected={threadScope === scope}
                onClick={() => onThreadScopeChange(scope)}
              >
                {scope === "active" ? "Active" : "Archived"}
              </button>
            ))}
          </div>

          <div className="sidebar-view-head">
            <strong>
              {threadScope === "archived"
                ? "Archived"
                : mode === "inbox"
                  ? "Inbox"
                  : "Projects"}
            </strong>
            <span>{threads.length}</span>
          </div>
        </header>

        <div
          className="sidebar-scroll"
          id="thread-scope-panel"
          role="tabpanel"
          aria-labelledby={`thread-scope-${threadScope}`}
        >
          {!serverReady ? (
            <p className="sidebar-empty">Waiting for the local App Server.</p>
          ) : threadLoading ? (
            <p className="sidebar-empty" role="status">
              Loading {threadScope === "active" ? "active" : "archived"}{" "}
              Threads…
            </p>
          ) : threadError !== null ? (
            <div className="sidebar-empty sidebar-error" role="alert">
              <p>{threadError}</p>
              <button type="button" onClick={onRetryThreads}>
                Try again
              </button>
            </div>
          ) : threads.length === 0 ? (
            <p className="sidebar-empty">
              {threadScope === "archived"
                ? "No archived Threads yet. Archived conversations stay safe here until you restore them."
                : "Your conversations will appear here."}
            </p>
          ) : threadScope === "active" && mode === "inbox" ? (
            <InboxView
              onSelectThread={onSelectThread}
              onChangeThreadLifecycle={onChangeThreadLifecycle}
              onRenameThread={onRenameThread}
              pendingApprovalThreadIds={pendingApprovalThreadIds}
              selectedThreadId={selectedThreadId}
              threads={threads}
              liveThread={liveThread}
              watchingThreadIds={watchingThreadIds}
            />
          ) : (
            <ProjectsView
              onSelectThread={onSelectThread}
              onChangeThreadLifecycle={onChangeThreadLifecycle}
              onRenameThread={onRenameThread}
              pendingApprovalThreadIds={pendingApprovalThreadIds}
              selectedThreadId={selectedThreadId}
              threads={threads}
              liveThread={liveThread}
              watchingThreadIds={watchingThreadIds}
            />
          )}
        </div>

        <footer className="sidebar-footer">
          <div className="service-status">
            <span className={`live-dot${serverReady ? " ready" : ""}`} />
            <span>{serverReady ? "Local service ready" : "Connecting…"}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-current={selectedPage === "settings" ? "page" : undefined}
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <Icon name="settings" />
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

function InboxView({
  threads,
  selectedThreadId,
  onSelectThread,
  onChangeThreadLifecycle,
  onRenameThread,
  pendingApprovalThreadIds,
  liveThread,
  watchingThreadIds,
}: {
  threads: readonly NativeThreadSummary[];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  pendingApprovalThreadIds: ReadonlySet<string>;
  liveThread: Thread | null;
  watchingThreadIds: ReadonlySet<string>;
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
            onRenameThread={onRenameThread}
            onSelectThread={onSelectThread}
            pendingApproval={pendingApprovalThreadIds.has(thread.threadId)}
            selected={thread.threadId === selectedThreadId}
            thread={thread}
            watching={watchingThreadIds.has(thread.threadId)}
          />
        ))}
      </section>
    ),
  );
}

function ProjectsView({
  threads,
  selectedThreadId,
  onSelectThread,
  onChangeThreadLifecycle,
  onRenameThread,
  pendingApprovalThreadIds,
  liveThread,
  watchingThreadIds,
}: {
  threads: readonly NativeThreadSummary[];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  pendingApprovalThreadIds: ReadonlySet<string>;
  liveThread: Thread | null;
  watchingThreadIds: ReadonlySet<string>;
}) {
  return deriveProjectGroups(threads).map((group) => (
    <ProjectRows
      group={group}
      key={group.key}
      liveThread={liveThread}
      onChangeThreadLifecycle={onChangeThreadLifecycle}
      onRenameThread={onRenameThread}
      onSelectThread={onSelectThread}
      pendingApprovalThreadIds={pendingApprovalThreadIds}
      selectedThreadId={selectedThreadId}
      watchingThreadIds={watchingThreadIds}
    />
  ));
}

function ProjectRows({
  group,
  selectedThreadId,
  onSelectThread,
  onChangeThreadLifecycle,
  onRenameThread,
  pendingApprovalThreadIds,
  liveThread,
  watchingThreadIds,
}: {
  group: ReturnType<typeof deriveProjectGroups>[number];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  pendingApprovalThreadIds: ReadonlySet<string>;
  liveThread: Thread | null;
  watchingThreadIds: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="project-group">
      <button
        className="project-header"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <Icon name="folder" size={14} />
          <span>{group.label}</span>
        </span>
        <Icon
          className={open ? "expanded" : undefined}
          name="chevron-down"
          size={14}
        />
      </button>
      {open
        ? group.threads.map((thread) => (
            <ThreadRow
              hasActiveTurn={threadHasActiveTurn(thread, liveThread)}
              key={thread.threadId}
              onChangeThreadLifecycle={onChangeThreadLifecycle}
              onRenameThread={onRenameThread}
              onSelectThread={onSelectThread}
              pendingApproval={pendingApprovalThreadIds.has(thread.threadId)}
              selected={thread.threadId === selectedThreadId}
              thread={thread}
              watching={watchingThreadIds.has(thread.threadId)}
            />
          ))
        : null}
    </section>
  );
}

function ThreadRow({
  thread,
  selected,
  hasActiveTurn,
  onChangeThreadLifecycle,
  onRenameThread,
  onSelectThread,
  pendingApproval,
  watching,
  inbox = false,
}: {
  thread: NativeThreadSummary;
  selected: boolean;
  hasActiveTurn: boolean;
  onChangeThreadLifecycle(thread: NativeThreadSummary): Promise<void>;
  onRenameThread(threadId: string, title: string): Promise<void>;
  onSelectThread(threadId: string): void;
  pendingApproval: boolean;
  watching: boolean;
  inbox?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(threadTitle(thread));
  const [busyAction, setBusyAction] = useState<
    "rename" | "archive" | "unarchive" | null
  >(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setRenaming(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
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
          <ProviderMark kind={identity.providerKind} />
          <span>{identity.label}</span>
        </span>
      )}
    </>
  );
  const runAction = async (
    action: "rename" | "archive" | "unarchive",
    operation: () => Promise<void>,
  ) => {
    setBusyAction(action);
    setMenuError(null);
    try {
      await operation();
      setMenuOpen(false);
      setRenaming(false);
    } catch (error) {
      setMenuError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };
  return (
    <div
      ref={rowRef}
      className="thread-row-shell"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setMenuOpen(false);
          setRenaming(false);
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
        className="thread-menu-trigger"
        type="button"
        aria-label={`Manage ${threadTitle(thread)}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          setMenuError(null);
          setRenaming(false);
          setRenameDraft(threadTitle(thread));
          setMenuOpen((value) => !value);
        }}
      >
        <Icon name="more" />
      </button>
      <ThreadItemMenu
        archived={thread.archived}
        busyAction={busyAction}
        error={menuError}
        hasActiveTurn={hasActiveTurn}
        open={menuOpen}
        renaming={renaming}
        renameDraft={renameDraft}
        onArchive={() =>
          void runAction("archive", () => onChangeThreadLifecycle(thread))
        }
        onBeginRename={() => setRenaming(true)}
        onCancelRename={() => setRenaming(false)}
        onDraftChange={setRenameDraft}
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
  open,
  renaming,
  renameDraft,
  onArchive,
  onBeginRename,
  onCancelRename,
  onDraftChange,
  onRename,
  onUnarchive,
}: {
  archived: boolean;
  busyAction: "rename" | "archive" | "unarchive" | null;
  error: string | null;
  hasActiveTurn: boolean;
  open: boolean;
  renaming: boolean;
  renameDraft: string;
  onArchive(): void;
  onBeginRename(): void;
  onCancelRename(): void;
  onDraftChange(value: string): void;
  onRename(): void;
  onUnarchive(): void;
}) {
  if (!open) return null;
  const busy = busyAction !== null;
  return (
    <div className="thread-item-menu" role="menu">
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
            disabled={busy}
            onClick={onBeginRename}
          >
            <Icon name="compose" />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
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

function ProviderMark({
  kind,
}: {
  kind: "openai" | "anthropic" | "google" | "local" | "generic";
}) {
  return (
    <span className={`provider-mark ${kind}`} aria-hidden="true">
      {kind === "openai"
        ? "◎"
        : kind === "anthropic"
          ? "A"
          : kind === "google"
            ? "✦"
            : kind === "local"
              ? "⌂"
              : "◇"}
    </span>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 18 18">
        <path d="M3 13.5 7 5l4 8.5L15 5" />
      </svg>
    </span>
  );
}
