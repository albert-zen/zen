import { useMemo, useState } from "react";

import type { Thread } from "../../protocol-client/index.js";
import { Icon } from "./icons";
import {
  deriveInboxSections,
  deriveProjectGroups,
  threadTitle,
  type SidebarMode,
} from "./thread-list";

interface SidebarProps {
  mode: SidebarMode;
  onModeChange(mode: SidebarMode): void;
  onNewThread(): void;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  selectedThreadId: string | null;
  serverReady: boolean;
  threads: readonly Thread[];
}

export function Sidebar({
  mode,
  onModeChange,
  onNewThread,
  onSelectThread,
  pendingApprovalThreadIds,
  selectedThreadId,
  serverReady,
  threads,
}: SidebarProps) {
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
          className="icon-button"
          type="button"
          aria-label={
            mode === "inbox" ? "Switch to project view" : "Switch to inbox view"
          }
          aria-pressed={mode === "projects"}
          onClick={() => onModeChange(mode === "inbox" ? "projects" : "inbox")}
        >
          <Icon name={mode === "inbox" ? "tree" : "inbox"} />
        </button>
      </header>

      <nav className="sidebar-nav" aria-label="Primary">
        <button className="nav-item" type="button" onClick={onNewThread}>
          <Icon name="compose" />
          New conversation
        </button>
      </nav>

      <div className="sidebar-mode-label" aria-live="polite">
        <span>{mode === "inbox" ? "Inbox" : "Projects"}</span>
        <span>{threads.length}</span>
      </div>

      <div className="thread-list">
        {!serverReady ? (
          <p className="sidebar-empty">Waiting for the local App Server.</p>
        ) : threads.length === 0 ? (
          <p className="sidebar-empty">Your conversations will appear here.</p>
        ) : mode === "inbox" ? (
          <InboxView
            onSelectThread={onSelectThread}
            pendingApprovalThreadIds={pendingApprovalThreadIds}
            selectedThreadId={selectedThreadId}
            threads={threads}
          />
        ) : (
          <ProjectsView
            onSelectThread={onSelectThread}
            pendingApprovalThreadIds={pendingApprovalThreadIds}
            selectedThreadId={selectedThreadId}
            threads={threads}
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
}: Pick<
  SidebarProps,
  "threads" | "selectedThreadId" | "onSelectThread" | "pendingApprovalThreadIds"
>) {
  const sections = deriveInboxSections(threads, pendingApprovalThreadIds);
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
              />
            ))}
          </section>
        ),
      )}
      <section
        className="thread-section watching-placeholder"
        aria-disabled="true"
      >
        <h2>
          Watching <span>v1</span>
        </h2>
      </section>
    </>
  );
}

function ProjectsView({
  threads,
  selectedThreadId,
  onSelectThread,
  pendingApprovalThreadIds,
}: Pick<
  SidebarProps,
  "threads" | "selectedThreadId" | "onSelectThread" | "pendingApprovalThreadIds"
>) {
  const groups = deriveProjectGroups(threads);
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
            />
          ))}
        </section>
      ) : null}
      <section className="thread-section compact-section">
        <h2>Projects</h2>
        {groups.map((group) => (
          <ProjectRows
            group={group}
            key={group.key}
            onSelectThread={onSelectThread}
            pendingApprovalThreadIds={pendingApprovalThreadIds}
            selectedThreadId={selectedThreadId}
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
  pendingApprovalThreadIds,
}: {
  group: ReturnType<typeof deriveProjectGroups>[number];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(true);
  const activeCount = useMemo(
    () =>
      group.threads.filter((thread) => thread.status.type === "active").length,
    [group.threads],
  );
  return (
    <div className="project-group">
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
        <span>{group.label}</span>
        <small>
          {activeCount > 0 ? `${activeCount} active` : group.threads.length}
        </small>
      </button>
      {open
        ? group.threads.map((thread) => (
            <CompactThreadRow
              key={thread.id}
              onSelectThread={onSelectThread}
              pendingApproval={pendingApprovalThreadIds.has(thread.id)}
              selected={thread.id === selectedThreadId}
              thread={thread}
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
}: {
  thread: Thread;
  selected: boolean;
  onSelectThread(threadId: string): void;
  pendingApproval: boolean;
}) {
  const content = (
    <>
      <div className="thread-card-title-row">
        <StatusDot pendingApproval={pendingApproval} thread={thread} />
        <strong>{threadTitle(thread)}</strong>
        <time>{formatRecency(thread.updatedAt)}</time>
      </div>
      <div className="thread-card-meta">
        <StatusPill pendingApproval={pendingApproval} thread={thread} />
        {thread.cwd.length > 0 ? <span>{projectName(thread.cwd)}</span> : null}
        {thread.modelProvider.length > 0 ? (
          <span>{thread.modelProvider}</span>
        ) : null}
      </div>
      <p>
        {thread.preview ||
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
}: {
  thread: Thread;
  selected: boolean;
  onSelectThread(threadId: string): void;
  pendingApproval: boolean;
}) {
  const contents = (
    <>
      <span>{threadTitle(thread)}</span>
      <StatusGlyph pendingApproval={pendingApproval} thread={thread} />
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
}: {
  thread: Thread;
  pendingApproval: boolean;
}) {
  return (
    <span
      className={`status-dot ${statusClass(thread, pendingApproval)}`}
      aria-hidden="true"
    />
  );
}

function StatusPill({
  thread,
  pendingApproval,
}: {
  thread: Thread;
  pendingApproval: boolean;
}) {
  const label = pendingApproval
    ? "Approval needed"
    : thread.status.type === "active"
      ? "Running"
      : thread.status.type === "systemError"
        ? "Unavailable"
        : "Complete";
  return (
    <span className={`status-pill ${statusClass(thread, pendingApproval)}`}>
      {label}
    </span>
  );
}

function StatusGlyph({
  thread,
  pendingApproval,
}: {
  thread: Thread;
  pendingApproval: boolean;
}) {
  return pendingApproval ? (
    <span className="status-approval" aria-label="Approval needed">
      <Icon name="warning" size={13} />
    </span>
  ) : thread.status.type === "active" ? (
    <span className="mini-spinner" aria-label="Running" />
  ) : thread.status.type === "systemError" ? (
    <span className="status-warning" aria-label="Unavailable">
      <Icon name="warning" size={13} />
    </span>
  ) : null;
}

function statusClass(thread: Thread, pendingApproval: boolean): string {
  return pendingApproval
    ? "approval"
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
