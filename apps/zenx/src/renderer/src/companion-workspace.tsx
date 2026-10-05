import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
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
  useTranslation("panels");
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
              ? `${trigger.kind} · ${trigger.active ? i18n.t("panels:enabled") : i18n.t("panels:paused")}`
              : i18n.t("panels:triggerUnavailableInThisAssistantContext")}
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
              ? i18n.t("panels:threadUnavailableOrWorkspaceChanged")
              : i18n.t("panels:remoteStatusNotLoaded")}
        </small>
      </li>
    );
  };
  const facts = (
    <>
      <h3>PAW</h3>
      <p>{i18n.t("panels:pawOverviewDescription")}</p>
      <dl>
        <dt>{i18n.t("panels:workingThread")}</dt>
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
              {i18n.t("panels:openWorkingThread")}
            </button>
          ) : (
            i18n.t("panels:sharedRoom")
          )}
        </dd>
        <dt>{i18n.t("panels:heartbeatRecurringChecks")}</dt>
        <dd>
          {!triggersEnabled
            ? i18n.t("panels:triggersDisabled")
            : triggerError
              ? i18n.t("panels:unavailable")
              : !triggersLoaded
                ? i18n.t("panels:loading")
                : recurring.length
                  ? recurring
                      .map((t) =>
                        i18n.t("panels:recurringCheck", {
                          name: t.label,
                          count: t.timer!.intervalMinutes,
                          status: t.active
                            ? i18n.t("panels:enabled")
                            : i18n.t("panels:paused"),
                        }),
                      )
                      .join("; ")
                  : i18n.t("panels:noRecurringCheckConfigured")}
        </dd>
        <dt>{i18n.t("panels:notebook")}</dt>
        <dd>
          {notebook
            ? i18n.t("panels:notebookCounts", {
                matters: notebook.matters.length,
                notes: notebook.memory.length,
                revision: notebook.revision,
              })
            : error
              ? i18n.t("panels:unavailable")
              : i18n.t("panels:loading")}
        </dd>
      </dl>
      <p className="companion-note">{i18n.t("panels:pawThreadRoomNote")}</p>
      <p className="companion-note">{i18n.t("panels:pawWakeupNote")}</p>
    </>
  );
  const tabsContent = [
    {
      id: "overview",
      title: i18n.t("panels:overview"),
      icon: "layers" as const,
      render: () => (
        <div className="companion-content">
          {room.assistant ? (
            facts
          ) : (
            <>
              <h3>{room.name}</h3>
              <p>
                {i18n.t("panels:roomMemberResourceCount", {
                  count: room.members.length,
                })}
              </p>
            </>
          )}
          {error ? <p role="alert">{error}</p> : null}
          {triggerError ? (
            <p role="alert">
              {i18n.t("panels:automationStatusUnavailable")} {triggerError}
            </p>
          ) : null}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            {i18n.t("panels:refresh")}
          </button>
          <nav
            className="companion-shortcuts"
            aria-label={i18n.t("panels:assistantWorkspaceSections")}
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
                {i18n.t(`panels:${id}`)}
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
            title: i18n.t("panels:matters"),
            icon: "thread" as const,
            render: () => (
              <div className="companion-content">
                <h3>{i18n.t("panels:whatIMTracking")}</h3>
                <p className="companion-note">
                  {i18n.t("panels:mattersDescription")}
                </p>
                {error ? (
                  <p role="alert">{error}</p>
                ) : notebook === null ? (
                  <p>{i18n.t("panels:loading")}</p>
                ) : notebook.matters.length === 0 ? (
                  <p>{i18n.t("panels:noMattersRecordedYetAskYourPaw")}</p>
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
            title: i18n.t("panels:memory"),
            icon: "file" as const,
            render: () => (
              <div className="companion-content">
                <h3>{i18n.t("panels:whatIMKeepingInMind")}</h3>
                {error ? (
                  <p role="alert">{error}</p>
                ) : notebook === null ? (
                  <p>{i18n.t("panels:loading")}</p>
                ) : notebook.memory.length === 0 ? (
                  <p>{i18n.t("panels:noNotesSavedYet")}</p>
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
            title: i18n.t("panels:automations"),
            icon: "layers" as const,
            render: () => (
              <div className="companion-content">
                <h3>{i18n.t("panels:checksAndTriggers")}</h3>
                {triggerError ? (
                  <p role="alert">{triggerError}</p>
                ) : !triggersEnabled ? (
                  <p>{i18n.t("panels:triggersIsDisabled")}</p>
                ) : !triggersLoaded ? (
                  <p>{i18n.t("panels:loading")}</p>
                ) : (
                  <ul>
                    {triggers.map((t) => (
                      <li key={t.id}>
                        <strong>{t.label}</strong>
                        <small>
                          {t.kind} ·{" "}
                          {t.active
                            ? i18n.t("panels:enabled")
                            : i18n.t("panels:paused")}
                        </small>
                        {t.timer ? (
                          <small>
                            {t.timer.intervalMinutes
                              ? i18n.t("panels:everyMinutes", {
                                  count: t.timer.intervalMinutes,
                                })
                              : i18n.t("panels:oneTime")}{" "}
                            {i18n.t("panels:next")}{" "}
                            {new Date(t.timer.nextRunAt).toLocaleString(
                              i18n.resolvedLanguage,
                            )}
                          </small>
                        ) : null}
                        {t.sourceError ? (
                          <small role="alert">{t.sourceError}</small>
                        ) : null}
                        <details>
                          <summary>{i18n.t("panels:instructions")}</summary>
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
                    {i18n.t("panels:configureAutomations")}
                  </button>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
    {
      id: "threads",
      title: i18n.t("panels:threads"),
      icon: "users" as const,
      render: () => (
        <div className="companion-content">
          <h3>{i18n.t("panels:membersAndDelegatedWork")}</h3>
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
              <h4>{i18n.t("panels:nativeChildThreads")}</h4>
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
                      {t.archived ? i18n.t("panels:archived") : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="companion-note">
            {i18n.t("panels:delegatedWorkDescription")}
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
                return t ? threadTitle(t) : i18n.t("panels:conversation");
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
          {i18n.t("panels:resourcesFrom")}
          <select
            aria-label={i18n.t("panels:roomResourceThread")}
            value={memberExists ? member : ""}
            onChange={(event) => setMember(event.target.value)}
          >
            <option value="">{i18n.t("panels:chooseARoomMember2")}</option>
            {room.members.map((m) => (
              <option key={m.threadId} value={m.threadId}>
                {m.name}
              </option>
            ))}
          </select>
          {memberExists && !resource ? (
            <small>{i18n.t("panels:threadUnavailable")}</small>
          ) : null}
        </label>
      }
    />
  );
}
