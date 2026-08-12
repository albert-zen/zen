import React, { useMemo, useState } from "react";

import type { Thread } from "../../protocol-client/index.js";
import type { TriggerSnapshot } from "../../main/trigger-types.js";
import { Icon } from "./icons";
import {
  deriveInboxSections,
  deriveProjectGroups,
  threadPreview,
  threadTitle,
  type SidebarMode,
} from "./thread-list";

interface SidebarProps {
  configuredWorkspaces: readonly string[];
  defaultWorkspace: string | null;
  mode: SidebarMode;
  onModeChange(mode: SidebarMode): void;
  onNewThread(cwd?: string): void;
  onAddProject(): void;
  onRemoveProject(workspace: string): void;
  onSetDefaultProject(workspace: string): void;
  onOpenSettings(): void;
  onOpenScheduled(): void;
  onSelectRoom(roomId: string): void;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  projectActionError: string | null;
  selectedThreadId: string | null;
  serverReady: boolean;
  threads: readonly Thread[];
  triggerSnapshot: TriggerSnapshot;
}

export function Sidebar({
  configuredWorkspaces,
  defaultWorkspace,
  mode,
  onModeChange,
  onNewThread,
  onAddProject,
  onRemoveProject,
  onSetDefaultProject,
  onOpenSettings,
  onOpenScheduled,
  onSelectRoom,
  onSelectThread,
  pendingApprovalThreadIds,
  projectActionError,
  selectedThreadId,
  serverReady,
  threads,
  triggerSnapshot,
}: SidebarProps) {
  const watchingThreadIds = new Set(
    triggerSnapshot.triggers
      .filter((trigger) => trigger.active)
      .map((trigger) => trigger.threadId),
  );
  return (
    <aside className="sidebar" aria-label="Thread navigation">
      <header className="sidebar-header">
        <div className="brand-mark" aria-hidden="true">
          Z
        </div>
        <div className="brand-name">
          ZenX <Icon name="chevron-down" size={11} />
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Search threads"
        >
          <Icon name="search" />
        </button>
        <button
          className={`icon-button${mode === "inbox" ? " active" : ""}`}
          type="button"
          aria-label={mode === "inbox" ? "Exit Inbox" : "Open Inbox"}
          aria-pressed={mode === "inbox"}
          onClick={() => onModeChange(mode === "inbox" ? "projects" : "inbox")}
        >
          <Icon name="inbox" />
        </button>
      </header>

      <nav className="sidebar-nav" aria-label="Primary">
        <button
          className="nav-item"
          type="button"
          onClick={() => onNewThread()}
        >
          <Icon name="compose" />
          New conversation
        </button>
        <button className="nav-item" type="button" onClick={onOpenSettings}>
          <Icon name="settings" />
          Settings
        </button>
        <button className="nav-item" type="button" onClick={onOpenScheduled}>
          <Icon name="trigger" />
          Scheduled
          <span className="nav-count">
            {
              triggerSnapshot.triggers.filter((trigger) => trigger.active)
                .length
            }
          </span>
        </button>
      </nav>

      <div className="sidebar-mode-label" aria-live="polite">
        <span>{mode === "inbox" ? "Inbox" : "Projects"}</span>
        {mode === "projects" ? (
          <button
            className="add-project-button"
            type="button"
            onClick={onAddProject}
          >
            <Icon name="plus" size={12} />
            Add project
          </button>
        ) : (
          <span>{threads.length}</span>
        )}
      </div>

      <div className="thread-list">
        {projectActionError === null ? null : (
          <p className="sidebar-action-error" role="alert">
            {projectActionError}
          </p>
        )}
        {triggerSnapshot.rooms.length > 0 ? (
          <section className="thread-section compact-section room-list">
            <h2>Rooms</h2>
            {triggerSnapshot.rooms.map((room) => (
              <button
                className="compact-thread"
                type="button"
                key={room.id}
                onClick={() => onSelectRoom(room.id)}
              >
                <span># {room.name}</span>
                <small>{room.messages.length}</small>
              </button>
            ))}
          </section>
        ) : null}
        {!serverReady ? (
          <p className="sidebar-empty">Waiting for the local App Server.</p>
        ) : threads.length === 0 &&
          (mode === "inbox" || configuredWorkspaces.length === 0) ? (
          <p className="sidebar-empty">Your conversations will appear here.</p>
        ) : mode === "inbox" ? (
          <InboxView
            onSelectThread={onSelectThread}
            pendingApprovalThreadIds={pendingApprovalThreadIds}
            selectedThreadId={selectedThreadId}
            threads={threads}
            watchingThreadIds={watchingThreadIds}
          />
        ) : (
          <ProjectsView
            configuredWorkspaces={configuredWorkspaces}
            defaultWorkspace={defaultWorkspace}
            onNewThread={onNewThread}
            onOpenSettings={onOpenSettings}
            onRemoveProject={onRemoveProject}
            onSetDefaultProject={onSetDefaultProject}
            onSelectThread={onSelectThread}
            pendingApprovalThreadIds={pendingApprovalThreadIds}
            selectedThreadId={selectedThreadId}
            threads={threads}
            watchingThreadIds={watchingThreadIds}
          />
        )}
      </div>
    </aside>
  );
}

function InboxView({
  threads,
  selectedThreadId,
  onSelectThread,
  pendingApprovalThreadIds,
  watchingThreadIds,
}: Pick<
  SidebarProps,
  "threads" | "selectedThreadId" | "onSelectThread" | "pendingApprovalThreadIds"
> & { watchingThreadIds: ReadonlySet<string> }) {
  const sections = deriveInboxSections(
    threads,
    pendingApprovalThreadIds,
    watchingThreadIds,
  );
  return (
    <>
      {sections.map((section) =>
        section.threads.length === 0 ? null : (
          <section className="thread-section" key={section.key}>
            <h2>
              {section.label} <span>{section.threads.length}</span>
            </h2>
            {section.threads.map((thread) => (
              <ThreadCard
                key={thread.id}
                onSelectThread={onSelectThread}
                pendingApproval={pendingApprovalThreadIds.has(thread.id)}
                selected={thread.id === selectedThreadId}
                thread={thread}
                watching={
                  watchingThreadIds.has(thread.id) &&
                  thread.status.type === "idle"
                }
              />
            ))}
          </section>
        ),
      )}
    </>
  );
}

function ProjectsView({
  configuredWorkspaces,
  defaultWorkspace,
  onNewThread,
  onOpenSettings,
  onRemoveProject,
  onSetDefaultProject,
  threads,
  selectedThreadId,
  onSelectThread,
  pendingApprovalThreadIds,
  watchingThreadIds,
}: Pick<
  SidebarProps,
  | "threads"
  | "selectedThreadId"
  | "onSelectThread"
  | "pendingApprovalThreadIds"
  | "configuredWorkspaces"
  | "defaultWorkspace"
  | "onNewThread"
  | "onOpenSettings"
  | "onRemoveProject"
  | "onSetDefaultProject"
> & { watchingThreadIds: ReadonlySet<string> }) {
  const groups = deriveProjectGroups(
    threads,
    configuredWorkspaces,
    defaultWorkspace,
  );
  const pinned = threads.filter((thread) => thread.isPinned);
  return (
    <>
      {pinned.length > 0 ? (
        <section className="thread-section compact-section">
          <h2>Pinned</h2>
          {pinned.map((thread) => (
            <CompactThreadRow
              key={thread.id}
              onSelectThread={onSelectThread}
              pendingApproval={pendingApprovalThreadIds.has(thread.id)}
              selected={thread.id === selectedThreadId}
              thread={thread}
              watching={
                watchingThreadIds.has(thread.id) &&
                thread.status.type === "idle"
              }
            />
          ))}
        </section>
      ) : null}
      <section className="thread-section compact-section projects-section">
        {groups.map((group) => (
          <ProjectRows
            group={group}
            key={group.key}
            onNewThread={onNewThread}
            onOpenSettings={onOpenSettings}
            onRemoveProject={onRemoveProject}
            onSetDefaultProject={onSetDefaultProject}
            onSelectThread={onSelectThread}
            pendingApprovalThreadIds={pendingApprovalThreadIds}
            selectedThreadId={selectedThreadId}
            watchingThreadIds={watchingThreadIds}
          />
        ))}
      </section>
    </>
  );
}

function ProjectRows({
  group,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onOpenSettings,
  onRemoveProject,
  onSetDefaultProject,
  pendingApprovalThreadIds,
  watchingThreadIds,
}: {
  group: ReturnType<typeof deriveProjectGroups>[number];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  onNewThread(cwd?: string): void;
  onOpenSettings(): void;
  onRemoveProject(workspace: string): void;
  onSetDefaultProject(workspace: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  watchingThreadIds: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(true);
  const activeCount = useMemo(
    () =>
      group.threads.filter((thread) => thread.status.type === "active").length,
    [group.threads],
  );
  if (group.key === "__unavailable__") {
    return (
      <div className="legacy-summary" role="status">
        <div className="legacy-summary-heading">
          <Icon name="warning" size={14} />
          <strong>{group.threads.length} unavailable journals</strong>
        </div>
        <p>ZenX cannot read these legacy or damaged entries.</p>
        <button type="button" onClick={onOpenSettings} className="text-button">
          Review cleanup in Settings
        </button>
      </div>
    );
  }
  const workspace = group.configured ? group.workspace : null;
  return (
    <div className="project-group">
      <div className="project-heading-row">
        <button
          className="project-header"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            className={open ? "rotated" : undefined}
            name="chevron-right"
            size={11}
          />
          <Icon name="folder" size={14} />
          <span title={workspace ?? group.label}>{group.label}</span>
          {group.isDefault ? <em>Default</em> : null}
          <small>
            {activeCount > 0 ? `${activeCount} active` : group.threads.length}
          </small>
        </button>
        <div
          className="project-actions"
          aria-label={`${group.label} project actions`}
        >
          <button
            type="button"
            title={`New thread in ${group.label}`}
            aria-label={`New thread in ${group.label}`}
            onClick={() => onNewThread(workspace ?? group.threads[0]?.cwd)}
          >
            <Icon name="plus" size={13} />
          </button>
          {workspace !== null && !group.isDefault ? (
            <button
              type="button"
              title={`Make ${group.label} the default project on this device`}
              aria-label={`Make ${group.label} default`}
              onClick={() => onSetDefaultProject(workspace)}
            >
              Default
            </button>
          ) : null}
          {workspace !== null ? (
            <button
              className="remove-project"
              type="button"
              title="Remove this project entry only; files stay untouched"
              aria-label={`Remove ${group.label} project entry; files stay untouched`}
              onClick={() => onRemoveProject(workspace)}
            >
              <Icon name="trash" size={13} />
            </button>
          ) : null}
        </div>
      </div>
      {group.configured && group.threads.length === 0 && open ? (
        <p className="project-empty">
          No threads yet. Files stay local to this folder.
        </p>
      ) : null}
      {open
        ? group.threads.map((thread) => (
            <CompactThreadRow
              key={thread.id}
              onSelectThread={onSelectThread}
              pendingApproval={pendingApprovalThreadIds.has(thread.id)}
              selected={thread.id === selectedThreadId}
              thread={thread}
              watching={
                watchingThreadIds.has(thread.id) &&
                thread.status.type === "idle"
              }
            />
          ))
        : null}
    </div>
  );
}

function ThreadCard({
  thread,
  selected,
  onSelectThread,
  pendingApproval,
  watching,
}: {
  thread: Thread;
  selected: boolean;
  onSelectThread(threadId: string): void;
  pendingApproval: boolean;
  watching: boolean;
}) {
  const content = (
    <>
      <div className="thread-card-title-row">
        <StatusDot
          pendingApproval={pendingApproval}
          thread={thread}
          watching={watching}
        />
        <strong>{threadTitle(thread)}</strong>
        <time>{formatRecency(thread.updatedAt)}</time>
      </div>
      <div className="thread-card-meta">
        <StatusPill
          pendingApproval={pendingApproval}
          thread={thread}
          watching={watching}
        />
        {thread.cwd.length > 0 ? <span>{projectName(thread.cwd)}</span> : null}
        {thread.modelProvider.length > 0 ? (
          <span>{thread.modelProvider}</span>
        ) : null}
      </div>
      <p>
        {threadPreview(thread) ||
          (thread.status.type === "systemError"
            ? "Thread journal could not be loaded."
            : "No messages yet.")}
      </p>
    </>
  );
  return thread.status.type === "systemError" ? (
    <div className="thread-card system-error" role="status">
      {content}
    </div>
  ) : (
    <button
      className={`thread-card${selected ? " selected" : ""}`}
      type="button"
      onClick={() => onSelectThread(thread.id)}
    >
      {content}
    </button>
  );
}

function CompactThreadRow({
  thread,
  selected,
  onSelectThread,
  pendingApproval,
  watching,
}: {
  thread: Thread;
  selected: boolean;
  onSelectThread(threadId: string): void;
  pendingApproval: boolean;
  watching: boolean;
}) {
  const contents = (
    <>
      <span>{threadTitle(thread)}</span>
      <StatusGlyph
        pendingApproval={pendingApproval}
        thread={thread}
        watching={watching}
      />
    </>
  );
  return thread.status.type === "systemError" ? (
    <div className="compact-thread system-error" role="status">
      {contents}
    </div>
  ) : (
    <button
      className={`compact-thread${selected ? " selected" : ""}`}
      type="button"
      onClick={() => onSelectThread(thread.id)}
    >
      {contents}
    </button>
  );
}

function StatusDot({
  thread,
  pendingApproval,
  watching,
}: {
  thread: Thread;
  pendingApproval: boolean;
  watching: boolean;
}) {
  return (
    <span
      className={`status-dot ${statusClass(thread, pendingApproval, watching)}`}
      aria-hidden="true"
    />
  );
}

function StatusPill({
  thread,
  pendingApproval,
  watching,
}: {
  thread: Thread;
  pendingApproval: boolean;
  watching: boolean;
}) {
  const label = pendingApproval
    ? "Approval needed"
    : watching
      ? "Watching"
      : thread.status.type === "active"
        ? "Running"
        : thread.status.type === "systemError"
          ? "Unavailable"
          : "Complete";
  return (
    <span
      className={`status-pill ${statusClass(thread, pendingApproval, watching)}`}
    >
      {label}
    </span>
  );
}

function StatusGlyph({
  thread,
  pendingApproval,
  watching,
}: {
  thread: Thread;
  pendingApproval: boolean;
  watching: boolean;
}) {
  return pendingApproval ? (
    <span className="status-approval" aria-label="Approval needed">
      <Icon name="warning" size={13} />
    </span>
  ) : watching ? (
    <span className="status-watching" aria-label="Watching">
      <Icon name="moon" size={13} />
    </span>
  ) : thread.status.type === "active" ? (
    <span className="mini-spinner" aria-label="Running" />
  ) : thread.status.type === "systemError" ? (
    <span className="status-warning" aria-label="Unavailable">
      <Icon name="warning" size={13} />
    </span>
  ) : null;
}

function statusClass(
  thread: Thread,
  pendingApproval: boolean,
  watching: boolean,
): string {
  return pendingApproval
    ? "approval"
    : watching
      ? "watching"
      : thread.status.type === "active"
        ? "active"
        : thread.status.type === "systemError"
          ? "error"
          : "settled";
}

function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function formatRecency(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1_000) - seconds);
  if (elapsed < 60) return "now";
  if (elapsed < 3_600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3_600)}h`;
  return `${Math.floor(elapsed / 86_400)}d`;
}
