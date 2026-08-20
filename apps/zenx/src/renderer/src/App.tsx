import { useEffect, useRef, useState } from "react";

import type { NativeThreadSummary } from "../../../../../src/thread-summary.js";
import type {
  AppServerHostStatus,
  ApprovalDecision,
} from "../../main/app-server-manager.js";
import type {
  ZenXCapabilitySnapshot,
  ZenXPluginSnapshot,
} from "../../main/capabilities/types.js";
import type { TriggerSnapshot } from "../../main/trigger-types.js";
import type { ZenXProjectProjectionSnapshot } from "../../main/project-projection.js";
import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "../../main/thread-title-types.js";
import type {
  ModelSummary,
  ServerNotificationParams,
  Thread,
} from "../../protocol-client/index.js";
import {
  addApprovalRequest,
  markApprovalResponding,
  pendingApprovalThreadIds,
  resolveApproval,
  restoreApprovalPending,
  type ApprovalCardState,
} from "./approval-state.js";
import {
  acceptComposerSubmission,
  beginComposerSubmission,
  editComposer,
  emptyComposerState,
  failComposerSubmission,
  type ComposerIntent,
  type ComposerState,
} from "./composer-state.js";
import { Icon } from "./icons.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import {
  applySettingsMirror,
  canChangeThreadModel,
  settingsFromSnapshot,
  validateModelCatalog,
  type SelectedThreadSettings,
} from "./model-settings.js";
import { loadedPluginContributions } from "./plugin-contributions.js";
import { RoomView } from "./RoomView.js";
import { ScheduledView } from "./ScheduledView.js";
import { SettingsView, type SettingsTab } from "./SettingsView.js";
import { Sidebar } from "./Sidebar.js";
import {
  derivePinnedThreads,
  readSidebarMode,
  threadHasActiveTurn,
  lastUsedProjectWorkspace,
  startProjectThread,
  threadTitle,
  writeSidebarMode,
  type SidebarMode,
} from "./thread-list.js";
import { applyThreadViewNotification } from "./thread-view-state.js";
import { ThreadLifecycleAction } from "./ThreadLifecycleAction.js";
import { ThreadView } from "./ThreadView.js";

type ProductPage = "agent" | "settings" | "triggers" | "rooms";

export function App() {
  const selectionEpoch = useRef(0);
  const threadSummaryLoadEpoch = useRef(0);
  const projectLoadEpoch = useRef(0);
  const selectedThreadIdRef = useRef<string | null>(null);
  const composerStatesRef = useRef<Record<string, ComposerState>>({});
  const pinnedThreadIdsRef = useRef<string[]>([]);
  const pinMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [page, setPage] = useState<ProductPage>("agent");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("account");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [triggerSnapshot, setTriggerSnapshot] = useState<TriggerSnapshot>({
    triggers: [],
    history: [],
    rooms: [],
  });
  const [capabilitySnapshot, setCapabilitySnapshot] =
    useState<ZenXCapabilitySnapshot | null>(null);
  const [pluginSnapshot, setPluginSnapshot] =
    useState<ZenXPluginSnapshot | null>(null);
  const [titleSnapshot, setTitleSnapshot] = useState<ThreadTitleSnapshot>({});
  const [serverStatus, setServerStatus] = useState<AppServerHostStatus>({
    type: "starting",
  });
  const [threadSummaries, setThreadSummaries] = useState<NativeThreadSummary[]>(
    [],
  );
  const [pinnedThreadIds, setPinnedThreadIds] = useState<string[]>([]);
  const [archivedThreadSummaries, setArchivedThreadSummaries] = useState<
    NativeThreadSummary[]
  >([]);
  const [threadListLoaded, setThreadListLoaded] = useState({
    active: false,
    archived: false,
  });
  const [threadListErrors, setThreadListErrors] = useState<{
    active: string | null;
    archived: string | null;
  }>({ active: null, archived: null });
  const [projects, setProjects] = useState<ZenXProjectProjectionSnapshot>({
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<Thread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalCardState[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(
    null,
  );
  const [selectedSettings, setSelectedSettings] =
    useState<SelectedThreadSettings | null>(null);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [modelUpdateError, setModelUpdateError] = useState<string | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    try {
      return readSidebarMode(window.localStorage);
    } catch {
      return "projects";
    }
  });
  const [requestError, setRequestError] = useState<string | null>(null);
  const [threadLifecycleBusy, setThreadLifecycleBusy] = useState(false);
  const [threadLifecycleError, setThreadLifecycleError] = useState<
    string | null
  >(null);
  const [composerStates, setComposerStates] = useState<
    Record<string, ComposerState>
  >({});

  const confirmPinnedThreadIds = (threadIds: readonly string[]) => {
    const confirmed = [...threadIds];
    pinnedThreadIdsRef.current = confirmed;
    setPinnedThreadIds(confirmed);
  };

  const queuePinMutation = (
    update: (current: readonly string[]) => readonly string[],
  ): Promise<void> => {
    const result = pinMutationQueueRef.current.then(async () => {
      const current = pinnedThreadIdsRef.current;
      const next = update(current);
      if (next === current) return;
      const value = await window.zenx.settings.setPinnedThreadIds(next);
      confirmPinnedThreadIds(value.profile.pinnedThreadIds);
    });
    pinMutationQueueRef.current = result.catch(() => undefined);
    return result;
  };

  const loadThreadSummaries = async (showLoading = false) => {
    const epoch = ++threadSummaryLoadEpoch.current;
    if (showLoading) setThreadListLoaded({ active: false, archived: false });
    const [active, archived] = await Promise.allSettled([
      window.zenx.threads.list({ archived: false }),
      window.zenx.threads.list({ archived: true }),
    ]);
    if (threadSummaryLoadEpoch.current !== epoch) return;
    if (active.status === "fulfilled") {
      setThreadSummaries(active.value);
      setThreadListErrors((current) => ({ ...current, active: null }));
    } else {
      setThreadListErrors((current) => ({
        ...current,
        active: describeError(active.reason),
      }));
    }
    if (archived.status === "fulfilled") {
      setArchivedThreadSummaries(archived.value);
      setThreadListErrors((current) => ({ ...current, archived: null }));
    } else {
      setThreadListErrors((current) => ({
        ...current,
        archived: describeError(archived.reason),
      }));
    }
    setThreadListLoaded({ active: true, archived: true });
  };

  const loadProjects = async () => {
    const epoch = ++projectLoadEpoch.current;
    try {
      const snapshot = await window.zenx.projects.get({ archived: false });
      if (projectLoadEpoch.current === epoch) setProjects(snapshot);
    } catch (error) {
      if (projectLoadEpoch.current === epoch)
        setRequestError(describeError(error));
    }
  };

  const resumeThread = async (threadId: string) => {
    const epoch = ++selectionEpoch.current;
    selectedThreadIdRef.current = threadId;
    setPage("agent");
    setSidebarOpen(false);
    setWorkspaceOpen(false);
    setSelectedThreadId(threadId);
    setThreadDetail(null);
    setSelectedSettings(null);
    setModelUpdateError(null);
    setThreadLifecycleError(null);
    setThreadLoading(true);
    setThreadError(null);
    try {
      const result = await window.zenx.protocol.request("thread/resume", {
        threadId,
      });
      if (selectionEpoch.current !== epoch) return;
      setThreadDetail(result.thread);
      setSelectedSettings(settingsFromSnapshot(result.thread.id, result));
      void window.zenx.settings
        .markWorkspaceUsed(result.thread.cwd)
        .then(() => loadProjects())
        .catch(() => undefined);
    } catch (error) {
      if (selectionEpoch.current === epoch)
        setThreadError(describeError(error));
    } finally {
      if (selectionEpoch.current === epoch) setThreadLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const loadModels = async () => {
      try {
        const result = await window.zenx.protocol.request("model/list", {});
        validateModelCatalog(result.data);
        if (active) {
          setModels(result.data);
          setModelCatalogError(null);
        }
      } catch (error) {
        if (active) setModelCatalogError(describeError(error));
      }
    };
    const disposeStatus = window.zenx.protocol.onStatus((status) => {
      if (!active) return;
      setServerStatus(status);
      if (status.type === "ready") {
        void loadThreadSummaries();
        void loadProjects();
        void loadModels();
        if (status.reconnected && selectedThreadIdRef.current !== null) {
          void resumeThread(selectedThreadIdRef.current);
        }
      }
    });
    const disposeNotifications = window.zenx.protocol.onNotification(
      (method, params) => {
        if (!active) return;
        if (
          method.startsWith("thread/") ||
          method.startsWith("turn/") ||
          method === "item/completed"
        ) {
          void loadThreadSummaries();
          void loadProjects();
        }
        setThreadDetail((current) =>
          current === null
            ? null
            : applyThreadViewNotification(current, method, params),
        );
        if (method === "thread/settings/updated") {
          const event =
            params as ServerNotificationParams["thread/settings/updated"];
          setSelectedSettings((current) =>
            applySettingsMirror(current, event.threadId, event.threadSettings),
          );
          setModelUpdateError(null);
        }
      },
    );
    const disposeApprovals = window.zenx.protocol.onApprovalRequest((event) => {
      if (active) setApprovals((current) => addApprovalRequest(current, event));
    });
    const disposeResolved = window.zenx.protocol.onApprovalResolved((event) => {
      if (active) setApprovals((current) => resolveApproval(current, event));
    });
    void window.zenx.protocol
      .getPendingApprovals()
      .then((pending) => {
        if (active)
          setApprovals((current) =>
            pending.reduce(addApprovalRequest, current),
          );
      })
      .catch(() => undefined);
    void window.zenx.protocol
      .getStatus()
      .then((status) => {
        if (!active) return;
        setServerStatus(status);
        if (status.type === "ready") {
          void loadThreadSummaries();
          void loadProjects();
          void loadModels();
        }
      })
      .catch(
        (error: unknown) => active && setRequestError(describeError(error)),
      );
    return () => {
      active = false;
      disposeStatus();
      disposeNotifications();
      disposeApprovals();
      disposeResolved();
    };
  }, []);

  useEffect(() => {
    const dispose = window.zenx.plugins.onChange(setPluginSnapshot);
    void window.zenx.plugins
      .get()
      .then(setPluginSnapshot)
      .catch((error: unknown) =>
        setRequestError(`ZenX plugin catalog failed: ${describeError(error)}`),
      );
    return dispose;
  }, []);

  useEffect(() => {
    const dispose = window.zenx.triggers.onChange(setTriggerSnapshot);
    void window.zenx.triggers
      .get()
      .then(setTriggerSnapshot)
      .catch((error: unknown) =>
        setRequestError(`ZenX automation data failed: ${describeError(error)}`),
      );
    return dispose;
  }, []);

  useEffect(() => {
    const dispose = window.zenx.capabilities.onChange(setCapabilitySnapshot);
    void window.zenx.capabilities
      .get()
      .then(setCapabilitySnapshot)
      .catch((error: unknown) =>
        setRequestError(`ZenX plugin catalog failed: ${describeError(error)}`),
      );
    return dispose;
  }, []);

  useEffect(() => {
    const result = pinMutationQueueRef.current.then(async () => {
      const value = await window.zenx.settings.get();
      confirmPinnedThreadIds(value.profile.pinnedThreadIds);
      if (!value.profile.onboardingComplete) setPage("settings");
    });
    pinMutationQueueRef.current = result.catch(() => undefined);
  }, []);

  useEffect(() => {
    const dispose = window.zenx.titles.onChange(setTitleSnapshot);
    void window.zenx.titles
      .get()
      .then(setTitleSnapshot)
      .catch((error: unknown) =>
        setRequestError(`ZenX title metadata failed: ${describeError(error)}`),
      );
    return dispose;
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (projectPickerOpen) setProjectPickerOpen(false);
      else if (workspaceOpen) setWorkspaceOpen(false);
      else if (sidebarOpen) setSidebarOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [projectPickerOpen, sidebarOpen, workspaceOpen]);

  const activeSummaries = threadSummaries.map((summary) =>
    titleSnapshot[summary.threadId]?.title === undefined
      ? summary
      : { ...summary, name: titleSnapshot[summary.threadId]!.title },
  );
  const archivedSummaries = archivedThreadSummaries.map((summary) =>
    titleSnapshot[summary.threadId]?.title === undefined
      ? summary
      : { ...summary, name: titleSnapshot[summary.threadId]!.title },
  );
  const pinnedSummaries = derivePinnedThreads(activeSummaries, pinnedThreadIds);
  const selectedSummary =
    [...activeSummaries, ...archivedSummaries].find(
      (summary) => summary.threadId === selectedThreadId,
    ) ?? null;
  const pendingThreadIds = pendingApprovalThreadIds(approvals);
  const pluginContributions = loadedPluginContributions(pluginSnapshot);
  const lastUsedWorkspace = lastUsedProjectWorkspace(projects);

  const newThread = async (workspace: string) => {
    const epoch = ++selectionEpoch.current;
    setThreadLoading(true);
    setThreadError(null);
    setModelUpdateError(null);
    try {
      const result = await startProjectThread(
        workspace,
        async (params) =>
          await window.zenx.protocol.request("thread/start", params),
        (startedWorkspace) => {
          void window.zenx.settings
            .markWorkspaceUsed(startedWorkspace)
            .then(() => loadProjects())
            .catch((error: unknown) => setRequestError(describeError(error)));
        },
      );
      if (selectionEpoch.current !== epoch) return;
      selectedThreadIdRef.current = result.thread.id;
      setPage("agent");
      setSidebarOpen(false);
      setSelectedThreadId(result.thread.id);
      setThreadDetail(result.thread);
      setSelectedSettings(settingsFromSnapshot(result.thread.id, result));
      await loadThreadSummaries();
    } catch (error) {
      if (selectionEpoch.current === epoch)
        setThreadError(describeError(error));
    } finally {
      if (selectionEpoch.current === epoch) setThreadLoading(false);
    }
  };

  const updateComposer = (
    threadId: string,
    update: (state: ComposerState) => ComposerState,
  ): ComposerState => {
    const current = composerStatesRef.current[threadId] ?? emptyComposerState();
    const next = update(current);
    if (next !== current) {
      composerStatesRef.current = {
        ...composerStatesRef.current,
        [threadId]: next,
      };
      setComposerStates(composerStatesRef.current);
    }
    return next;
  };

  const submitComposer = async (
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ) => {
    if (threadDetail === null) return;
    const threadId = threadDetail.id;
    const started = updateComposer(threadId, (state) =>
      beginComposerSubmission(state, intent, expectedTurnId, () =>
        crypto.randomUUID(),
      ),
    );
    const submission = started.submission;
    if (submission === null || submission.status !== "pending") return;
    try {
      await window.zenx.titles
        .observe(threadId, submission.text)
        .then((projection) => {
          if (projection !== undefined)
            setTitleSnapshot((current) => ({
              ...current,
              [threadId]: projection,
            }));
        })
        .catch((error: unknown) =>
          setRequestError(
            `Thread title could not be staged: ${describeError(error)}`,
          ),
        );
      const input = [{ type: "text" as const, text: submission.text }];
      if (submission.intent === "start") {
        await window.zenx.protocol.request("turn/start", {
          threadId,
          input,
          clientUserMessageId: submission.clientUserMessageId,
        });
      } else if (submission.intent === "steer") {
        if (submission.expectedTurnId === null)
          throw new Error("The active turn changed before steering");
        await window.zenx.protocol.request("turn/steer", {
          threadId,
          expectedTurnId: submission.expectedTurnId,
          input,
          clientUserMessageId: submission.clientUserMessageId,
        });
      } else {
        if (submission.expectedTurnId === null)
          throw new Error("The active turn changed before replacement");
        await window.zenx.protocol.request("turn/replace", {
          threadId,
          expectedTurnId: submission.expectedTurnId,
          input,
          clientUserMessageId: submission.clientUserMessageId,
        });
      }
      updateComposer(threadId, (state) =>
        acceptComposerSubmission(state, submission.clientUserMessageId),
      );
    } catch (error) {
      updateComposer(threadId, (state) =>
        failComposerSubmission(
          state,
          submission.clientUserMessageId,
          describeError(error),
        ),
      );
    }
  };

  const respondToApproval = async (
    requestId: string,
    decision: ApprovalDecision,
  ) => {
    setApprovals((current) =>
      markApprovalResponding(current, requestId, decision),
    );
    try {
      await window.zenx.protocol.respondToApproval(requestId, decision);
    } catch (error) {
      setApprovals((current) => restoreApprovalPending(current, requestId));
      throw error;
    }
  };

  const changeModel = async (model: string) => {
    if (
      threadDetail === null ||
      selectedSettings === null ||
      model === selectedSettings.model
    )
      return;
    if (!canChangeThreadModel(threadDetail)) {
      setModelUpdateError("Wait for the current turn to finish.");
      return;
    }
    setSwitchingModel(true);
    setModelUpdateError(null);
    try {
      await window.zenx.protocol.request("thread/settings/update", {
        threadId: threadDetail.id,
        model,
      });
    } catch (error) {
      setModelUpdateError(describeError(error));
    } finally {
      setSwitchingModel(false);
    }
  };

  const openPage = (next: ProductPage) => {
    setPage(next);
    setSidebarOpen(false);
    setWorkspaceOpen(false);
    if (next === "rooms" && selectedRoomId === null)
      setSelectedRoomId(triggerSnapshot.rooms[0]?.id ?? null);
  };

  const renameThread = async (threadId: string, title: string) => {
    const projection = await window.zenx.titles.rename(threadId, title);
    setTitleSnapshot((current) => ({
      ...current,
      [threadId]: projection,
    }));
  };

  const changeThreadPinned = async (summary: NativeThreadSummary) => {
    const shouldPin = !pinnedThreadIds.includes(summary.threadId);
    await queuePinMutation((current) =>
      shouldPin
        ? [
            summary.threadId,
            ...current.filter((threadId) => threadId !== summary.threadId),
          ]
        : current.filter((threadId) => threadId !== summary.threadId),
    );
  };

  const clearSelectedThreadForArchive = (threadId: string) => {
    if (selectedThreadIdRef.current !== threadId) return;
    selectionEpoch.current += 1;
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setThreadDetail(null);
    setSelectedSettings(null);
    setSettingsTab("archived");
    openPage("settings");
  };

  const performThreadLifecycle = async (
    summary: NativeThreadSummary,
    clearSelectedOnArchive = false,
  ) => {
    if (!summary.archived && threadHasActiveTurn(summary, threadDetail)) {
      throw new Error("Wait for the active Turn to finish before archiving.");
    }
    await window.zenx.protocol.request(
      summary.archived ? "thread/unarchive" : "thread/archive",
      { threadId: summary.threadId },
    );
    if (!summary.archived) {
      if (clearSelectedOnArchive)
        clearSelectedThreadForArchive(summary.threadId);
      try {
        await queuePinMutation((current) =>
          current.includes(summary.threadId)
            ? current.filter((threadId) => threadId !== summary.threadId)
            : current,
        );
      } catch (error) {
        setRequestError(
          `Thread archived, but its local Pin could not be cleared: ${describeError(error)}`,
        );
      }
    }
    await loadThreadSummaries();
    await loadProjects();
  };

  const changeThreadLifecycle = async () => {
    if (selectedSummary === null) return;
    setThreadLifecycleBusy(true);
    setThreadLifecycleError(null);
    try {
      await performThreadLifecycle(selectedSummary, true);
    } catch (error) {
      setThreadLifecycleError(describeError(error));
    } finally {
      setThreadLifecycleBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar
        liveThread={threadDetail}
        mode={sidebarMode}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onChangeThreadLifecycle={(summary) =>
          performThreadLifecycle(summary, true)
        }
        onChangeThreadPinned={changeThreadPinned}
        onModeChange={(mode) => {
          setSidebarMode(mode);
          try {
            writeSidebarMode(window.localStorage, mode);
          } catch {
            // The preference remains valid for this window.
          }
        }}
        onNewThread={(workspace) => {
          if (workspace !== undefined) void newThread(workspace);
        }}
        onAddProject={() => setProjectPickerOpen(true)}
        onRemoveProject={(workspace) => {
          void window.zenx.settings
            .removeWorkspace(workspace)
            .then(async () => await loadProjects())
            .catch((error: unknown) => setRequestError(describeError(error)));
        }}
        onSetDefaultProject={(workspace) => {
          void window.zenx.settings
            .setDefaultWorkspace(workspace)
            .then(async () => await loadProjects())
            .catch((error: unknown) => setRequestError(describeError(error)));
        }}
        onOpenContribution={(target) => openPage(target)}
        onOpenSettings={() => openPage("settings")}
        onRetryThreads={() => void loadThreadSummaries(true)}
        onRenameThread={renameThread}
        onSelectThread={(threadId) => void resumeThread(threadId)}
        pendingApprovalThreadIds={pendingThreadIds}
        pluginContributions={pluginContributions}
        selectedPage={page}
        selectedThreadId={selectedThreadId}
        serverReady={serverStatus.type === "ready"}
        projects={projects}
        pinnedThreads={pinnedSummaries}
        threadError={threadListErrors.active}
        threadLoading={!threadListLoaded.active}
        threads={activeSummaries}
        triggerSnapshot={triggerSnapshot}
      />

      <main className="workspace">
        {page === "settings" ? (
          <SettingsView
            archivedError={threadListErrors.archived}
            archivedLoading={!threadListLoaded.archived}
            archivedThreads={archivedSummaries}
            onRetryArchived={() => void loadThreadSummaries(true)}
            onTabChange={setSettingsTab}
            onUnarchive={performThreadLifecycle}
            onOpenSidebar={() => setSidebarOpen(true)}
            tab={settingsTab}
          />
        ) : page === "triggers" ? (
          <ScheduledView
            roomsAvailable={pluginContributions.some(
              (contribution) => contribution.page === "rooms",
            )}
            snapshot={triggerSnapshot}
            threads={activeSummaries}
            onOpenThread={(id) => void resumeThread(id)}
            onOpenRoom={(id) => {
              setSelectedRoomId(id);
              openPage("rooms");
            }}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        ) : page === "rooms" ? (
          <RoomView
            roomId={selectedRoomId}
            snapshot={triggerSnapshot}
            threads={activeSummaries}
            onOpenThread={(id) => void resumeThread(id)}
            onOpenSidebar={() => setSidebarOpen(true)}
            onSelectRoom={setSelectedRoomId}
          />
        ) : (
          <AgentSurface
            approvals={approvals}
            composerStates={composerStates}
            models={models}
            modelCatalogError={modelCatalogError}
            modelUpdateError={modelUpdateError}
            onDraftChange={(threadId, draft) =>
              updateComposer(threadId, (state) => editComposer(state, draft))
            }
            onInterrupt={async (turnId) => {
              if (threadDetail === null)
                throw new Error("No thread is selected");
              await window.zenx.protocol.request("turn/interrupt", {
                threadId: threadDetail.id,
                turnId,
              });
            }}
            onModelChange={(model) => void changeModel(model)}
            onChangeThreadLifecycle={changeThreadLifecycle}
            hasProjects={projects.projects.some(
              (project) => project.configured,
            )}
            hasLastUsedProject={lastUsedWorkspace !== null}
            onAddProject={() => setProjectPickerOpen(true)}
            onNewThread={() => {
              if (lastUsedWorkspace !== null) void newThread(lastUsedWorkspace);
              else setProjectPickerOpen(true);
            }}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenWorkspace={() => setWorkspaceOpen(true)}
            onRename={async (title) => {
              if (selectedSummary === null) return;
              await renameThread(selectedSummary.threadId, title);
            }}
            onRespondToApproval={respondToApproval}
            onRetryTitle={async () => {
              if (selectedSummary === null) return;
              const projection = await window.zenx.titles.retry(
                selectedSummary.threadId,
              );
              setTitleSnapshot((current) => ({
                ...current,
                [selectedSummary.threadId]: projection,
              }));
            }}
            onSubmit={submitComposer}
            requestError={requestError}
            selectedSettings={selectedSettings}
            selectedSummary={selectedSummary}
            serverStatus={serverStatus}
            switchingModel={switchingModel}
            threadLifecycleBusy={threadLifecycleBusy}
            threadLifecycleError={threadLifecycleError}
            threadDetail={threadDetail}
            threadError={threadError}
            threadLoading={threadLoading}
            titleProjection={
              selectedSummary === null
                ? undefined
                : titleSnapshot[selectedSummary.threadId]
            }
            triggerSnapshot={triggerSnapshot}
          />
        )}
      </main>

      {workspaceOpen && threadDetail !== null ? (
        <WorkspaceDrawer
          capabilitySnapshot={capabilitySnapshot}
          onClose={() => setWorkspaceOpen(false)}
          settings={selectedSettings}
          thread={threadDetail}
        />
      ) : null}
      {projectPickerOpen ? (
        <DirectoryPicker
          onCancel={() => setProjectPickerOpen(false)}
          onSelect={(workspace) => {
            void window.zenx.settings
              .addWorkspace(workspace)
              .then(async () => {
                await loadProjects();
                setProjectPickerOpen(false);
              })
              .catch((error: unknown) => setRequestError(describeError(error)));
          }}
        />
      ) : null}
    </div>
  );
}

function AgentSurface({
  approvals,
  composerStates,
  models,
  modelCatalogError,
  modelUpdateError,
  onChangeThreadLifecycle,
  onDraftChange,
  hasProjects,
  hasLastUsedProject,
  onAddProject,
  onInterrupt,
  onModelChange,
  onNewThread,
  onOpenSidebar,
  onOpenWorkspace,
  onRename,
  onRespondToApproval,
  onRetryTitle,
  onSubmit,
  requestError,
  selectedSettings,
  selectedSummary,
  serverStatus,
  switchingModel,
  threadLifecycleBusy,
  threadLifecycleError,
  threadDetail,
  threadError,
  threadLoading,
  titleProjection,
  triggerSnapshot,
}: {
  approvals: ApprovalCardState[];
  composerStates: Record<string, ComposerState>;
  models: ModelSummary[];
  modelCatalogError: string | null;
  modelUpdateError: string | null;
  onChangeThreadLifecycle(): Promise<void>;
  onDraftChange(threadId: string, draft: string): void;
  hasProjects: boolean;
  hasLastUsedProject: boolean;
  onAddProject(): void;
  onInterrupt(turnId: string): Promise<void>;
  onModelChange(model: string): void;
  onNewThread(): void;
  onOpenSidebar(): void;
  onOpenWorkspace(): void;
  onRename(title: string): Promise<void>;
  onRespondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  onRetryTitle(): Promise<void>;
  onSubmit(
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ): Promise<void>;
  requestError: string | null;
  selectedSettings: SelectedThreadSettings | null;
  selectedSummary: NativeThreadSummary | null;
  serverStatus: AppServerHostStatus;
  switchingModel: boolean;
  threadLifecycleBusy: boolean;
  threadLifecycleError: string | null;
  threadDetail: Thread | null;
  threadError: string | null;
  threadLoading: boolean;
  titleProjection: ThreadTitleProjection | undefined;
  triggerSnapshot: TriggerSnapshot;
}) {
  return (
    <section className="agent-surface">
      <header className="workspace-header">
        <div className="workspace-heading-row">
          <button
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open sidebar"
            onClick={onOpenSidebar}
          >
            <Icon name="tree" />
          </button>
          <div className="thread-heading">
            {selectedSummary === null ? (
              <strong>Start a conversation</strong>
            ) : (
              <ThreadTitleEditor
                editable={!selectedSummary.archived}
                onRename={onRename}
                onRetry={onRetryTitle}
                projection={titleProjection}
                title={threadTitle(selectedSummary)}
              />
            )}
            <span>
              {selectedSummary === null
                ? "Select a Thread or create a new one"
                : selectedSummary.status === "systemError"
                  ? "Unavailable journal"
                  : selectedSummary.currentMetadata.cwd}
            </span>
          </div>
        </div>
        <div className="top-actions">
          {selectedSummary === null ||
          selectedSummary.status === "systemError" ||
          selectedSummary.archived ? null : (
            <ThreadLifecycleAction
              archived={selectedSummary.archived}
              busy={threadLifecycleBusy}
              error={threadLifecycleError}
              hasActiveTurn={threadHasActiveTurn(selectedSummary, threadDetail)}
              onChange={onChangeThreadLifecycle}
            />
          )}
          <button
            className="icon-button search-thread"
            type="button"
            aria-label="Thread search is not available in this build"
            disabled
          >
            <Icon name="search" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Open workspace panel"
            aria-haspopup="dialog"
            disabled={threadDetail === null}
            onClick={onOpenWorkspace}
          >
            <Icon name="panel-right" />
          </button>
        </div>
      </header>

      {serverStatus.type === "error" || requestError !== null ? (
        <EmptyState
          error
          title="Zen App Server stopped"
          detail={
            serverStatus.type === "error" ? serverStatus.message : requestError!
          }
        />
      ) : serverStatus.type !== "ready" ? (
        <EmptyState
          loading={
            serverStatus.type === "starting" ||
            serverStatus.type === "reconnecting"
          }
          title={
            serverStatus.type === "starting"
              ? "Starting Zen App Server"
              : serverStatus.type === "reconnecting"
                ? "Reconnecting to Zen App Server"
                : "Zen App Server disconnected"
          }
          detail="Your draft is preserved while ZenX reconnects to the local runtime."
        />
      ) : threadLoading ? (
        <EmptyState
          loading
          title="Loading conversation"
          detail="Reconstructing this Thread from App Server history…"
        />
      ) : threadError !== null ? (
        <EmptyState
          error
          title="Could not open conversation"
          detail={threadError}
        />
      ) : selectedSummary === null || threadDetail === null ? (
        <EmptyState
          title={hasProjects ? "No thread selected" : "Add your first project"}
          detail={
            hasProjects
              ? "Choose New thread to start working in the selected Project."
              : "Choose a folder before ZenX creates a Thread. Your files stay where they are."
          }
          action={hasProjects ? onNewThread : onAddProject}
          actionLabel={
            hasProjects
              ? hasLastUsedProject
                ? "New thread"
                : "Choose project"
              : "Add project"
          }
          actionIcon={hasProjects ? "compose" : "folder"}
        />
      ) : (
        <ThreadView
          approvals={approvals.filter(
            (approval) => approval.params.threadId === threadDetail.id,
          )}
          composer={composerStates[threadDetail.id] ?? emptyComposerState()}
          modelDisabled={!canChangeThreadModel(threadDetail)}
          modelError={modelUpdateError ?? modelCatalogError}
          models={models}
          permissionLabel={
            selectedSummary.status !== "systemError" &&
            selectedSummary.currentMetadata.approvalPolicy === "never"
              ? "Full access"
              : "Approval required"
          }
          selectedModel={selectedSettings?.model}
          switchingModel={switchingModel}
          thread={threadDetail}
          wakeups={triggerSnapshot.history.filter(
            (entry) => entry.threadId === threadDetail.id,
          )}
          watching={triggerSnapshot.triggers.some(
            (trigger) => trigger.active && trigger.threadId === threadDetail.id,
          )}
          onDraftChange={(draft) => onDraftChange(threadDetail.id, draft)}
          onInterrupt={onInterrupt}
          onModelChange={onModelChange}
          onRespondToApproval={onRespondToApproval}
          onSubmit={onSubmit}
        />
      )}
    </section>
  );
}

function WorkspaceDrawer({
  capabilitySnapshot,
  onClose,
  settings,
  thread,
}: {
  capabilitySnapshot: ZenXCapabilitySnapshot | null;
  onClose(): void;
  settings: SelectedThreadSettings | null;
  thread: Thread;
}) {
  const [tab, setTab] = useState<"files" | "artifacts" | "context">("files");
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);
  const commands = thread.turns.flatMap((turn) =>
    turn.items.filter(
      (
        item,
      ): item is Extract<
        (typeof turn.items)[number],
        { type: "commandExecution" }
      > => item.type === "commandExecution",
    ),
  );
  return (
    <div
      className="drawer-layer"
      role="presentation"
      onPointerDown={(event) =>
        event.target === event.currentTarget && onClose()
      }
    >
      <aside
        className="workspace-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-drawer-title"
      >
        <header>
          <div>
            <strong id="workspace-drawer-title">Workspace</strong>
            <span>Linked context for this Thread</span>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            aria-label="Close workspace"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <div
          className="drawer-tabs"
          role="tablist"
          aria-label="Workspace views"
        >
          {(["files", "artifacts", "context"] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
            >
              {name[0]!.toUpperCase() + name.slice(1)}
            </button>
          ))}
        </div>
        <div className="drawer-content">
          {tab === "files" ? (
            <>
              <p>
                Files explicitly represented by this Thread’s current product
                projection.
              </p>
              <div className="drawer-row">
                <Icon name="folder" />
                <div>
                  <strong>{thread.cwd}</strong>
                  <span>Thread workspace</span>
                </div>
              </div>
              <p className="drawer-empty">
                No file-reference Items are available for this Thread.
              </p>
            </>
          ) : tab === "artifacts" ? (
            capabilitySnapshot?.currentScreenshot === undefined ? (
              <p className="drawer-empty">No live artifacts are available.</p>
            ) : (
              <div className="drawer-row">
                <Icon name="file" />
                <div>
                  <strong>Browser observation</strong>
                  <span>
                    {capabilitySnapshot.currentScreenshot.width} ×{" "}
                    {capabilitySnapshot.currentScreenshot.height}
                  </span>
                </div>
              </div>
            )
          ) : (
            <>
              <div className="drawer-row">
                <Icon name="folder" />
                <div>
                  <strong>{thread.cwd}</strong>
                  <span>Current workspace</span>
                </div>
              </div>
              <div className="drawer-row">
                <Icon name="layers" />
                <div>
                  <strong>{settings?.model ?? thread.modelProvider}</strong>
                  <span>Effective Thread model</span>
                </div>
              </div>
              <div className="drawer-row">
                <Icon name="terminal" />
                <div>
                  <strong>
                    {commands.length} tool{" "}
                    {commands.length === 1 ? "call" : "calls"}
                  </strong>
                  <span>From canonical Thread Items</span>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function EmptyState({
  title,
  detail,
  action,
  loading = false,
  error = false,
  actionLabel = "New thread",
  actionIcon = "compose",
}: {
  title: string;
  detail: string;
  action?: () => void;
  loading?: boolean;
  error?: boolean;
  actionLabel?: string;
  actionIcon?: "compose" | "folder";
}) {
  return (
    <section
      className={`empty-canvas${error ? " error" : ""}`}
      role={error ? "alert" : undefined}
    >
      {loading ? (
        <div className="loading-ring" />
      ) : (
        <div className="empty-glyph">
          <Icon name={error ? "warning" : "compose"} size={20} />
        </div>
      )}
      <h2>{title}</h2>
      <p>{detail}</p>
      {action === undefined ? null : (
        <button className="primary-button" type="button" onClick={action}>
          <Icon name={actionIcon} />
          {actionLabel}
        </button>
      )}
    </section>
  );
}

function ThreadTitleEditor({
  editable,
  title,
  projection,
  onRename,
  onRetry,
}: {
  editable: boolean;
  title: string;
  projection: ThreadTitleProjection | undefined;
  onRename(title: string): Promise<void>;
  onRetry(): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);
  if (editing) {
    return (
      <form
        className="thread-title-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void onRename(draft)
            .then(() => setEditing(false))
            .catch((reason: unknown) => setError(describeError(reason)))
            .finally(() => setBusy(false));
        }}
      >
        <input
          autoFocus
          aria-label="Thread title"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {error ? <small role="alert">{error}</small> : null}
      </form>
    );
  }
  return (
    <div className="thread-title-line">
      <strong>{title}</strong>
      {editable ? (
        <button
          type="button"
          aria-label="Rename Thread"
          onClick={() => setEditing(true)}
        >
          Rename
        </button>
      ) : null}
      {editable && projection?.status === "generating" ? (
        <small>Generating title…</small>
      ) : null}
      {editable && projection?.status === "failed" ? (
        <button type="button" onClick={() => void onRetry()}>
          Retry title
        </button>
      ) : null}
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
