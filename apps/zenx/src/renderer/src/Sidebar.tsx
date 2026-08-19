import { useMemo, useState } from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { TriggerSnapshot } from "../../main/trigger-types.js";
import { Icon } from "./icons.js";
import type { LoadedPluginContribution } from "./plugin-contributions.js";
import {
  deriveInboxSections,
  deriveProjectGroups,
  threadModelIdentity,
  threadProject,
  threadTitle,
  type SidebarMode,
} from "./thread-list.js";

interface SidebarProps {
  mode: SidebarMode;
  open: boolean;
  onClose(): void;
  onModeChange(mode: SidebarMode): void;
  onNewThread(): void;
  onOpenContribution(page: "triggers" | "rooms"): void;
  onOpenSettings(): void;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  pluginContributions: readonly LoadedPluginContribution[];
  selectedPage: "agent" | "triggers" | "rooms" | "settings";
  selectedThreadId: string | null;
  serverReady: boolean;
  threads: readonly NativeThreadSummary[];
  triggerSnapshot: TriggerSnapshot;
}

export function Sidebar({
  mode,
  open,
  onClose,
  onModeChange,
  onNewThread,
  onOpenContribution,
  onOpenSettings,
  onSelectThread,
  pendingApprovalThreadIds,
  pluginContributions,
  selectedPage,
  selectedThreadId,
  serverReady,
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
                  key={`${contribution.capabilityId}:${contribution.id}`}
                  onClick={() => onOpenContribution(contribution.page)}
                >
                  <Icon
                    name={
                      contribution.icon === "rooms" ? "users" : "trigger"
                    }
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

          <div className="sidebar-view-head">
            <strong>{mode === "inbox" ? "Inbox" : "Projects"}</strong>
            <span>{threads.length}</span>
          </div>
        </header>

        <div className="sidebar-scroll">
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
              watchingThreadIds={watchingThreadIds}
            />
          ) : (
            <ProjectsView
              onSelectThread={onSelectThread}
              pendingApprovalThreadIds={pendingApprovalThreadIds}
              selectedThreadId={selectedThreadId}
              threads={threads}
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
  pendingApprovalThreadIds,
  watchingThreadIds,
}: {
  threads: readonly NativeThreadSummary[];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
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
  pendingApprovalThreadIds,
  watchingThreadIds,
}: {
  threads: readonly NativeThreadSummary[];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
  watchingThreadIds: ReadonlySet<string>;
}) {
  return deriveProjectGroups(threads).map((group) => (
    <ProjectRows
      group={group}
      key={group.key}
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
  pendingApprovalThreadIds,
  watchingThreadIds,
}: {
  group: ReturnType<typeof deriveProjectGroups>[number];
  selectedThreadId: string | null;
  onSelectThread(threadId: string): void;
  pendingApprovalThreadIds: ReadonlySet<string>;
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
              key={thread.threadId}
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
  onSelectThread,
  pendingApproval,
  watching,
  inbox = false,
}: {
  thread: NativeThreadSummary;
  selected: boolean;
  onSelectThread(threadId: string): void;
  pendingApproval: boolean;
  watching: boolean;
  inbox?: boolean;
}) {
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
  if (thread.status === "systemError") {
    return (
      <div className={`thread-row system-error${inbox ? " inbox" : ""}`}>
        {contents}
      </div>
    );
  }
  return (
    <button
      className={`thread-row${selected ? " selected" : ""}${inbox ? " inbox" : ""}`}
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={() => onSelectThread(thread.threadId)}
    >
      {contents}
    </button>
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
