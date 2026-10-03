import type { WorkspaceFileDrafts } from "./workspace-file-drafts.js";
import React, { useEffect, useState } from "react";
import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";
import type {
  AssistantWorkspace,
  ZenXTrigger,
} from "../../main/trigger-types.js";
import type { RoomConversation } from "./room-conversations.js";
import { AuxiliaryPanel } from "./auxiliary-panel.js";
import { threadTitle } from "./thread-list.js";

export interface CompanionViewState {
  selected: string;
  tabs: string[];
  member: string;
  conversationThreadId?: string;
}

export function CompanionWorkspace({
  room,
  threads,
  snapshot,
  section,
  navigate,
  onClose,
  fileDrafts,
  onWidthChange,
  viewState,
  onViewChange,
  renderConversation,
}: {
  renderConversation?(threadId: string): React.ReactNode;
  room: RoomConversation;
  threads: readonly NativeThreadSummary[];
  snapshot: ZenXPluginSnapshot;
  viewState?: CompanionViewState;
  onViewChange?(
    update: (current: CompanionViewState) => CompanionViewState,
  ): void;
  fileDrafts: WorkspaceFileDrafts;
  onWidthChange(width: number): void;
  section: string;
  navigate(route: string): void;
  onClose(): void;
}) {
  const [localView, setLocalView] = useState<CompanionViewState>({
    selected: `custom:${section || "overview"}`,
    tabs: [],
    member: room.assistant?.threadId ?? "",
  });
  const view = viewState ?? localView;
  const changeView = onViewChange ?? setLocalView;
  const { selected, tabs, member } = view;
  const setSelected = (selected: string) =>
    changeView((current) => ({ ...current, selected }));
  const setTabs = (tabs: string[]) =>
    changeView((current) => ({ ...current, tabs }));
  const setMember = (member: string) =>
    changeView((current) => ({ ...current, member }));
  const [notebook, setNotebook] = useState<AssistantWorkspace | null>(null);
  const [triggers, setTriggers] = useState<ZenXTrigger[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggersLoaded, setTriggersLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const memberExists = room.members.some((value) => value.threadId === member);
  const execution = memberExists
    ? threads.find(
        (value) => value.threadId === member && value.status !== "systemError",
      )
    : undefined;
  const resource =
    execution && execution.status !== "systemError"
      ? {
          threadId: execution.threadId,
          title: threadTitle(execution),
          workspacePath: execution.currentMetadata.cwd,
        }
      : undefined;
  const triggersEnabled = snapshot.plugins.some(
    (p) => p.id === "zenx-triggers" && p.enabled && p.available,
  );
  useEffect(() => {
    if (section) setSelected(`custom:${section}`);
  }, [section]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setNotebook(null);
    setTriggers([]);
    setError(null);
    setTriggerError(null);
    setTriggersLoaded(false);
    const refresh = async () => {
      if (room.assistant)
        try {
          const value = (await window.zenx.plugins.executeCommand(
            "zenx-rooms",
            "workspace",
            { roomId: room.id },
          )) as AssistantWorkspace;
          if (active) {
            setNotebook(value);
            setError(null);
          }
        } catch (reason) {
          if (active) {
            setNotebook(null);
            setError(String(reason instanceof Error ? reason.message : reason));
          }
        }
      if (triggersEnabled && room.assistant)
        try {
          const value = (await window.zenx.plugins.executeCommand(
            "zenx-triggers",
            "list",
          )) as { triggers: ZenXTrigger[] };
          if (active) {
            setTriggers(
              value.triggers.filter(
                (t) => t.threadId === room.assistant!.threadId,
              ),
            );
            setTriggerError(null);
            setTriggersLoaded(true);
          }
        } catch (reason) {
          if (active) {
            setTriggers([]);
            setTriggerError(
              String(reason instanceof Error ? reason.message : reason),
            );
          }
        }
      if (active) timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [room.id, room.assistant?.threadId, triggersEnabled, revision]);
  const recurring = triggers.filter(
    (t) => t.kind === "timer" && t.timer?.intervalMinutes !== null,
  );
  const triggerPanel = snapshot.panels.find(
    (p) => p.pluginId === "zenx-triggers",
  );
  const localThreads = threads.filter(
    (t) =>
      t.parentThreadId === room.assistant?.threadId &&
      room.assistant !== undefined,
  );
  const reference = (
    ref: NonNullable<
      AssistantWorkspace["matters"][number]["references"]
    >[number],
    i: number,
  ) => {
    if (ref.kind === "trigger") {
      const trigger = triggers.find((t) => t.id === ref.triggerId);
      return (
        <li key={i}>
          <strong>{ref.label || ref.triggerId}</strong>
          <small>
            {trigger
              ? `${trigger.kind} · ${trigger.active ? "Enabled" : "Paused"}`
              : "Trigger unavailable in this assistant context"}
          </small>
        </li>
      );
    }
    const candidate =
      ref.device === "local"
        ? threads.find(
            (t) =>
              t.threadId === ref.threadId &&
              t.status !== "systemError" &&
              t.currentMetadata.cwd === ref.workspace,
          )
        : undefined;
    return (
      <li key={i}>
        {candidate ? (
          <button
            type="button"
            onClick={() =>
              navigate(`/threads/${encodeURIComponent(ref.threadId)}`)
            }
          >
            {ref.label || threadTitle(candidate)}
          </button>
        ) : (
          <strong>{ref.label || ref.threadId}</strong>
        )}
        <small>
          {ref.device} · {ref.workspace} · {ref.threadId}
        </small>
        <small>
          {candidate
            ? `Thread: ${candidate.status}`
            : ref.device === "local"
              ? "Thread unavailable or workspace changed"
              : "Remote status not loaded"}
        </small>
      </li>
    );
  };
  const facts = (
    <>
      <h3>Companion</h3>
      <p>
        An ongoing assistant using Rooms, Triggers and Fleet. Its working thread
        keeps the execution history.
      </p>
      <dl>
        <dt>Working thread</dt>
        <dd>
          {room.assistant ? (
            <button
              type="button"
              onClick={() =>
                navigate(
                  `/threads/${encodeURIComponent(room.assistant!.threadId)}`,
                )
              }
            >
              Open working Thread
            </button>
          ) : (
            "Shared room"
          )}
        </dd>
        <dt>Heartbeat / recurring checks</dt>
        <dd>
          {!triggersEnabled
            ? "Triggers disabled"
            : triggerError
              ? "Unavailable"
              : !triggersLoaded
                ? "Loading…"
                : recurring.length
                  ? recurring
                      .map(
                        (t) =>
                          `${t.label}: every ${t.timer!.intervalMinutes} min (${t.active ? "enabled" : "paused"})`,
                      )
                      .join("; ")
                  : "No recurring check configured"}
        </dd>
        <dt>Notebook</dt>
        <dd>
          {notebook
            ? `${notebook.matters.length} matters · ${notebook.memory.length} notes · revision ${notebook.revision}`
            : error
              ? "Unavailable"
              : "Loading…"}
        </dd>
      </dl>
      <p className="companion-note">
        Direct Thread messages stay in the Thread. The assistant posts here only
        through its Room messaging tool. This binding keeps both conversations
        connected without copying every message between them.
      </p>
      <p className="companion-note">
        Creating a Companion enables message wakeups only. Configure recurring
        checks in Automations when needed; they can consume model quota. Reading
        this workspace does not start agent work.
      </p>
    </>
  );
  const tabsContent = [
    {
      id: "overview",
      title: "Overview",
      icon: "layers" as const,
      render: () => (
        <div className="companion-content">
          {room.assistant ? (
            facts
          ) : (
            <>
              <h3>{room.name}</h3>
              <p>
                {room.members.length} members share this conversation. Choose a
                member above to use its files, browser and other thread tools.
              </p>
            </>
          )}
          {error ? <p role="alert">{error}</p> : null}
          {triggerError ? (
            <p role="alert">Automation status unavailable: {triggerError}</p>
          ) : null}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            Refresh
          </button>
          <nav
            className="companion-shortcuts"
            aria-label="Assistant workspace sections"
          >
            {(room.assistant
              ? ["matters", "memory", "automations", "threads"]
              : ["threads"]
            ).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setSelected(`custom:${id}`)}
              >
                {id[0]!.toUpperCase() + id.slice(1)}
              </button>
            ))}
          </nav>
        </div>
      ),
    },
    ...(room.assistant
      ? [
          {
            id: "matters",
            title: "Matters",
            icon: "thread" as const,
            render: () => (
              <div className="companion-content">
                <h3>What I’m tracking</h3>
                <p className="companion-note">
                  Assistant-written plans and notes. Linked execution status is
                  shown separately.
                </p>
                {error ? (
                  <p role="alert">{error}</p>
                ) : notebook === null ? (
                  <p>Loading…</p>
                ) : notebook.matters.length === 0 ? (
                  <p>
                    No matters recorded yet. Ask your companion to track
                    something.
                  </p>
                ) : (
                  notebook.matters.map((m) => (
                    <article key={m.id}>
                      <h4>{m.title}</h4>
                      {m.statusNote ? (
                        <p className="companion-note">{m.statusNote}</p>
                      ) : null}
                      <p>{m.plan}</p>
                      {m.notes ? <p>{m.notes}</p> : null}
                      <ul>{m.references.map(reference)}</ul>
                    </article>
                  ))
                )}
              </div>
            ),
          },
          {
            id: "memory",
            title: "Memory",
            icon: "file" as const,
            render: () => (
              <div className="companion-content">
                <h3>What I’m keeping in mind</h3>
                {error ? (
                  <p role="alert">{error}</p>
                ) : notebook === null ? (
                  <p>Loading…</p>
                ) : notebook.memory.length === 0 ? (
                  <p>No notes saved yet.</p>
                ) : (
                  notebook.memory.map((n) => (
                    <article key={n.id}>
                      <h4>{n.title}</h4>
                      <p>{n.text}</p>
                    </article>
                  ))
                )}
              </div>
            ),
          },
          {
            id: "automations",
            title: "Automations",
            icon: "layers" as const,
            render: () => (
              <div className="companion-content">
                <h3>Checks and triggers</h3>
                {triggerError ? (
                  <p role="alert">{triggerError}</p>
                ) : !triggersEnabled ? (
                  <p>Triggers is disabled.</p>
                ) : !triggersLoaded ? (
                  <p>Loading…</p>
                ) : (
                  <ul>
                    {triggers.map((t) => (
                      <li key={t.id}>
                        <strong>{t.label}</strong>
                        <small>
                          {t.kind} · {t.active ? "Enabled" : "Paused"}
                        </small>
                        {t.timer ? (
                          <small>
                            {t.timer.intervalMinutes
                              ? `Every ${t.timer.intervalMinutes} min`
                              : "One time"}{" "}
                            · next{" "}
                            {new Date(t.timer.nextRunAt).toLocaleString()}
                          </small>
                        ) : null}
                        {t.sourceError ? (
                          <small role="alert">{t.sourceError}</small>
                        ) : null}
                        <details>
                          <summary>Instructions</summary>
                          <p>{t.prompt}</p>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}
                {triggerPanel && resource ? (
                  <button
                    type="button"
                    onClick={() => setSelected(`plugin:${triggerPanel.key}`)}
                  >
                    Configure automations
                  </button>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
    {
      id: "threads",
      title: "Threads",
      icon: "users" as const,
      render: () => (
        <div className="companion-content">
          <h3>Members and delegated work</h3>
          <ul>
            {room.members.map((m) => (
              <li key={m.threadId}>
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/threads/${encodeURIComponent(m.threadId)}`)
                  }
                >
                  {m.name}
                </button>
                <small>{m.threadId}</small>
              </li>
            ))}
          </ul>
          {localThreads.length ? (
            <>
              <h4>Native child threads</h4>
              <ul>
                {localThreads.map((t) => (
                  <li key={t.threadId}>
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/threads/${encodeURIComponent(t.threadId)}`)
                      }
                    >
                      {threadTitle(t)}
                    </button>
                    <small>
                      {t.status}
                      {t.archived ? " · archived" : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="companion-note">
            Other delegated work appears under its matter with its device and
            workspace identity.
          </p>
        </div>
      ),
    },
  ];
  return (
    <AuxiliaryPanel
      conversation={
        view.conversationThreadId && renderConversation
          ? {
              threadId: view.conversationThreadId,
              title: (() => {
                const t = threads.find(
                  (t) => t.threadId === view.conversationThreadId,
                );
                return t ? threadTitle(t) : "Conversation";
              })(),
              render: renderConversation,
            }
          : undefined
      }
      fileDrafts={fileDrafts}
      onWidthChange={onWidthChange}
      conversationContext={{
        kind: "room",
        roomId: room.id,
        resourceThread: resource,
      }}
      title={room.name}
      open
      onOpenChange={(open) => {
        if (open) return;
        const opener = document.getElementById("thread-browser-toggle");
        const owner = room.id;
        onClose();
        requestAnimationFrame(() => {
          // The Room route unmounts this panel instead of rendering open=false.
          // Restore only its original opener, never a newer route or focus.
          if (
            opener?.isConnected &&
            opener.dataset.roomId === owner &&
            document.activeElement === document.body &&
            !document.querySelector('.auxiliary-panel[data-open="true"]')
          )
            opener.focus();
        });
      }}
      snapshot={snapshot}
      selectedTab={selected}
      onSelectTab={setSelected}
      openedTabs={tabs}
      onTabsChange={setTabs}
      navigate={navigate}
      threadContext={{ threads }}
      customTabs={tabsContent}
      contextControl={
        <label className="companion-context">
          Resources from
          <select
            aria-label="Room resource thread"
            value={memberExists ? member : ""}
            onChange={(event) => setMember(event.target.value)}
          >
            <option value="">Choose a room member</option>
            {room.members.map((m) => (
              <option key={m.threadId} value={m.threadId}>
                {m.name}
              </option>
            ))}
          </select>
          {memberExists && !resource ? <small>Thread unavailable</small> : null}
        </label>
      }
    />
  );
}
