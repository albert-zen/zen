import { useEffect, useRef, useState } from "react";
import type {
  AppServerHostStatus,
  ApprovalDecision,
} from "../../main/app-server-manager.js";
import type {
  ModelSummary,
  ServerNotificationParams,
  Thread,
} from "../../protocol-client/index.js";
import { Icon } from "./icons";
import { Sidebar } from "./Sidebar";
import { ThreadView } from "./ThreadView";
import { ModelSelector } from "./ModelSelector";
import { SettingsView } from "./SettingsView";
import { TriggerRail } from "./TriggerRail";
import { ScheduledView } from "./ScheduledView";
import { RoomView } from "./RoomView";
import type { TriggerSnapshot } from "../../main/trigger-types.js";
import {
  addApprovalRequest,
  markApprovalResponding,
  pendingApprovalThreadIds,
  resolveApproval,
  restoreApprovalPending,
  type ApprovalCardState,
} from "./approval-state";
import {
  applySettingsMirror,
  canChangeThreadModel,
  settingsFromSnapshot,
  validateModelCatalog,
  type SelectedThreadSettings,
} from "./model-settings";
import {
  applyThreadNotification,
  readSidebarMode,
  threadTitle,
  writeSidebarMode,
  type SidebarMode,
} from "./thread-list";
import { applyThreadViewNotification } from "./thread-view-state";
import {
  acceptComposerSubmission,
  beginComposerSubmission,
  editComposer,
  emptyComposerState,
  failComposerSubmission,
  type ComposerIntent,
  type ComposerState,
} from "./composer-state";

export function App() {
  const selectionEpoch = useRef(0);
  const selectedThreadIdRef = useRef<string | null>(null);
  const composerStatesRef = useRef<Record<string, ComposerState>>({});
  const [railOpen, setRailOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [triggerSnapshot, setTriggerSnapshot] = useState<TriggerSnapshot>({
    triggers: [],
    history: [],
    rooms: [],
  });
  const [serverStatus, setServerStatus] = useState<AppServerHostStatus>({
    type: "starting",
  });
  const [threads, setThreads] = useState<Thread[]>([]);
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
  const [composerStates, setComposerStates] = useState<
    Record<string, ComposerState>
  >({});

  const resumeThread = async (threadId: string) => {
    const epoch = ++selectionEpoch.current;
    selectedThreadIdRef.current = threadId;
    setSettingsOpen(false);
    setScheduledOpen(false);
    setSelectedRoomId(null);
    setSelectedThreadId(threadId);
    setThreadDetail(null);
    setSelectedSettings(null);
    setModelUpdateError(null);
    setThreadLoading(true);
    setThreadError(null);
    try {
      const result = await window.zenx.protocol.request("thread/resume", {
        threadId,
      });
      if (selectionEpoch.current !== epoch) return;
      setThreadDetail(result.thread);
      setSelectedSettings(settingsFromSnapshot(result.thread.id, result));
    } catch (error) {
      if (selectionEpoch.current === epoch) {
        setThreadError(describeError(error));
      }
    } finally {
      if (selectionEpoch.current === epoch) setThreadLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const loadThreads = async () => {
      try {
        const result = await window.zenx.protocol.request("thread/list", {});
        if (active) {
          setThreads(result.data);
          setRequestError(null);
        }
      } catch (error) {
        if (active) {
          setRequestError(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    };
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
    const dispose = window.zenx.protocol.onStatus((status) => {
      if (!active) return;
      setServerStatus(status);
      if (status.type === "ready") {
        void loadThreads();
        void loadModels();
        if (status.reconnected && selectedThreadIdRef.current !== null) {
          void resumeThread(selectedThreadIdRef.current);
        }
      }
    });
    const disposeNotifications = window.zenx.protocol.onNotification(
      (method, params) => {
        if (active) {
          setThreads((current) =>
            applyThreadNotification(current, method, params),
          );
          setThreadDetail((current) =>
            current === null
              ? null
              : applyThreadViewNotification(current, method, params),
          );
          if (method === "thread/settings/updated") {
            const event =
              params as ServerNotificationParams["thread/settings/updated"];
            setSelectedSettings((current) =>
              applySettingsMirror(
                current,
                event.threadId,
                event.threadSettings,
              ),
            );
            setModelUpdateError(null);
          }
        }
      },
    );
    const disposeApprovals = window.zenx.protocol.onApprovalRequest((event) => {
      if (active) {
        setApprovals((current) => addApprovalRequest(current, event));
      }
    });
    const disposeResolved = window.zenx.protocol.onApprovalResolved((event) => {
      if (active) {
        setApprovals((current) => resolveApproval(current, event));
      }
    });
    void window.zenx.protocol
      .getPendingApprovals()
      .then((pending) => {
        if (!active) return;
        setApprovals((current) => pending.reduce(addApprovalRequest, current));
      })
      .catch(() => undefined);
    void window.zenx.protocol
      .getStatus()
      .then((status) => {
        if (!active) return;
        setServerStatus(status);
        if (status.type === "ready") {
          void loadThreads();
          void loadModels();
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setRequestError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      active = false;
      dispose();
      disposeNotifications();
      disposeApprovals();
      disposeResolved();
    };
  }, []);

  useEffect(() => {
    const dispose = window.zenx.triggers.onChange(setTriggerSnapshot);
    void window.zenx.triggers
      .get()
      .then(setTriggerSnapshot)
      .catch((error: unknown) => {
        setRequestError(
          `ZenX orchestration state failed: ${describeError(error)}`,
        );
      });
    return dispose;
  }, []);

  useEffect(() => {
    void window.zenx.settings
      .get()
      .then((value) => {
        if (!value.profile.onboardingComplete) setSettingsOpen(true);
      })
      .catch(() => undefined);
  }, []);

  const selectedThread =
    threadDetail ??
    threads.find((thread) => thread.id === selectedThreadId) ??
    null;
  const pendingThreadIds = pendingApprovalThreadIds(approvals);

  const selectThread = resumeThread;

  const newThread = async () => {
    const epoch = ++selectionEpoch.current;
    setThreadLoading(true);
    setThreadError(null);
    setModelUpdateError(null);
    try {
      const result = await window.zenx.protocol.request("thread/start", {});
      if (selectionEpoch.current !== epoch) return;
      selectedThreadIdRef.current = result.thread.id;
      setSettingsOpen(false);
      setScheduledOpen(false);
      setSelectedRoomId(null);
      setSelectedThreadId(result.thread.id);
      setThreadDetail(result.thread);
      setSelectedSettings(settingsFromSnapshot(result.thread.id, result));
      setThreads((current) =>
        applyThreadNotification(current, "thread/started", {
          thread: result.thread,
        }),
      );
    } catch (error) {
      if (selectionEpoch.current === epoch) {
        setThreadError(describeError(error));
      }
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

  const changeDraft = (threadId: string, draft: string) => {
    updateComposer(threadId, (state) => editComposer(state, draft));
  };

  const submitComposer = async (
    intent: ComposerIntent,
    expectedTurnId: string | null,
  ) => {
    if (threadDetail === null) return;
    const threadId = threadDetail.id;
    if (composerStatesRef.current[threadId]?.submission?.status === "pending") {
      return;
    }
    const started = updateComposer(threadId, (state) =>
      beginComposerSubmission(state, intent, expectedTurnId, () =>
        crypto.randomUUID(),
      ),
    );
    const submission = started.submission;
    if (submission === null || submission.status !== "pending") return;
    try {
      const input = [{ type: "text" as const, text: submission.text }];
      if (submission.intent === "start") {
        await window.zenx.protocol.request("turn/start", {
          threadId,
          input,
          clientUserMessageId: submission.clientUserMessageId,
        });
      } else if (submission.intent === "steer") {
        if (submission.expectedTurnId === null) {
          throw new Error("The active turn changed before steering");
        }
        await window.zenx.protocol.request("turn/steer", {
          threadId,
          expectedTurnId: submission.expectedTurnId,
          input,
          clientUserMessageId: submission.clientUserMessageId,
        });
      } else {
        if (submission.expectedTurnId === null) {
          throw new Error("The active turn changed before replacement");
        }
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

  const interruptTurn = async (turnId: string) => {
    if (threadDetail === null) throw new Error("No thread is selected");
    await window.zenx.protocol.request("turn/interrupt", {
      threadId: threadDetail.id,
      turnId,
    });
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
    ) {
      return;
    }
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
  const changeSidebarMode = (mode: SidebarMode) => {
    setSidebarMode(mode);
    try {
      writeSidebarMode(window.localStorage, mode);
    } catch {
      // A disabled localStorage keeps the in-memory preference for this window.
    }
  };

  return (
    <div className="app-shell">
      <Sidebar
        mode={sidebarMode}
        onModeChange={changeSidebarMode}
        onNewThread={() => void newThread()}
        onOpenSettings={() => {
          setSettingsOpen(true);
          setScheduledOpen(false);
          setSelectedRoomId(null);
        }}
        onOpenScheduled={() => {
          setSettingsOpen(false);
          setScheduledOpen(true);
          setSelectedRoomId(null);
        }}
        onSelectRoom={(roomId) => {
          setSettingsOpen(false);
          setScheduledOpen(false);
          setSelectedRoomId(roomId);
        }}
        onSelectThread={(threadId) => void selectThread(threadId)}
        pendingApprovalThreadIds={pendingThreadIds}
        selectedThreadId={selectedThreadId}
        serverReady={serverStatus.type === "ready"}
        threads={threads}
        triggerSnapshot={triggerSnapshot}
      />

      <main className="workspace">
        {settingsOpen ? (
          <SettingsView onClose={() => setSettingsOpen(false)} />
        ) : scheduledOpen ? (
          <ScheduledView
            snapshot={triggerSnapshot}
            threads={threads}
            onOpenThread={(id) => void resumeThread(id)}
            onOpenRoom={(id) => {
              setScheduledOpen(false);
              setSelectedRoomId(id);
            }}
          />
        ) : selectedRoomId !== null ? (
          <RoomView
            roomId={selectedRoomId}
            snapshot={triggerSnapshot}
            threads={threads}
            onOpenThread={(id) => void resumeThread(id)}
          />
        ) : (
          <>
            <header className="workspace-header">
              <div>
                <h1>
                  {selectedThread === null
                    ? "Start a conversation"
                    : threadTitle(selectedThread)}
                </h1>
                <p>
                  {selectedThread === null
                    ? "Select a thread or create a new one."
                    : `${selectedThread.cwd} · ${selectedSettings?.model ?? selectedThread.modelProvider}`}
                </p>
              </div>
              {selectedSettings === null ? null : (
                <ModelSelector
                  disabled={
                    threadDetail === null || !canChangeThreadModel(threadDetail)
                  }
                  error={modelUpdateError ?? modelCatalogError}
                  models={models}
                  onChange={(model) => void changeModel(model)}
                  selectedModel={selectedSettings.model}
                  switching={switchingModel}
                />
              )}
              <button
                className={`toolbar-button${railOpen ? " active" : ""}`}
                type="button"
                aria-expanded={railOpen}
                aria-label={
                  railOpen ? "Hide triggers panel" : "Show triggers panel"
                }
                onClick={() => setRailOpen((open) => !open)}
              >
                <Icon name="panel-right" size={15} />
                Triggers
              </button>
            </header>

            {serverStatus.type === "error" || requestError !== null ? (
              <section className="empty-canvas server-error" role="alert">
                <div className="empty-glyph" aria-hidden="true">
                  <Icon name="thread" size={22} />
                </div>
                <h2>Zen App Server stopped</h2>
                <p>
                  {serverStatus.type === "error"
                    ? serverStatus.message
                    : requestError}
                </p>
                <span>Restart ZenX after checking the host configuration.</span>
              </section>
            ) : serverStatus.type !== "ready" ? (
              <section
                className="empty-canvas"
                aria-live="polite"
                role={serverStatus.type === "stopped" ? "alert" : undefined}
              >
                {serverStatus.type === "starting" ? (
                  <div className="loading-ring" aria-hidden="true" />
                ) : (
                  <div className="empty-glyph" aria-hidden="true">
                    <Icon name="warning" size={22} />
                  </div>
                )}
                <h2>
                  {serverStatus.type === "starting"
                    ? "Starting Zen App Server"
                    : serverStatus.type === "reconnecting"
                      ? "Reconnecting to Zen App Server"
                      : "Zen App Server disconnected"}
                </h2>
                <p>
                  {serverStatus.type === "starting"
                    ? "Connecting to the local agent runtime…"
                    : serverStatus.type === "reconnecting"
                      ? `Attempt ${serverStatus.attempt}. Your draft is preserved; the current thread will be rebuilt from App Server history after reconnecting.`
                      : "Your draft is preserved. Restart ZenX to reconnect and rebuild the thread from App Server history."}
                </p>
              </section>
            ) : threadLoading ? (
              <section className="empty-canvas" aria-live="polite">
                <div className="loading-ring" aria-hidden="true" />
                <h2>Loading conversation</h2>
                <p>Reconstructing this thread from its journal…</p>
              </section>
            ) : threadError !== null ? (
              <section className="empty-canvas thread-load-error" role="alert">
                <div className="empty-glyph" aria-hidden="true">
                  <Icon name="warning" size={22} />
                </div>
                <h2>Could not open conversation</h2>
                <p>{threadError}</p>
              </section>
            ) : selectedThread === null ? (
              <section className="empty-canvas" aria-label="Empty conversation">
                <div className="empty-glyph" aria-hidden="true">
                  <Icon name="thread" size={22} />
                </div>
                <h2>No thread selected</h2>
                <p>Create a conversation to start working with Zen.</p>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void newThread()}
                >
                  <Icon name="compose" size={15} />
                  New conversation
                </button>
              </section>
            ) : threadDetail !== null ? (
              <ThreadView
                approvals={approvals.filter(
                  (approval) => approval.params.threadId === threadDetail.id,
                )}
                composer={
                  composerStates[threadDetail.id] ?? emptyComposerState()
                }
                onDraftChange={(draft) => changeDraft(threadDetail.id, draft)}
                onInterrupt={interruptTurn}
                onRespondToApproval={respondToApproval}
                onSubmit={submitComposer}
                thread={threadDetail}
                wakeups={triggerSnapshot.history.filter(
                  (entry) => entry.threadId === threadDetail.id,
                )}
                watching={triggerSnapshot.triggers.some(
                  (trigger) =>
                    trigger.active && trigger.threadId === threadDetail.id,
                )}
              />
            ) : (
              <section className="empty-canvas" aria-live="polite">
                <div className="loading-ring" aria-hidden="true" />
              </section>
            )}
          </>
        )}
      </main>

      <aside
        className={`detail-rail${railOpen && !settingsOpen && !scheduledOpen && selectedRoomId === null ? " open" : ""}`}
        aria-label="Thread triggers"
        aria-hidden={
          !railOpen || settingsOpen || scheduledOpen || selectedRoomId !== null
        }
      >
        {selectedThread === null ? (
          <div className="rail-content">
            <h2>Triggers</h2>
            <p>Select a conversation to manage wakeup conditions.</p>
          </div>
        ) : (
          <TriggerRail
            thread={selectedThread}
            snapshot={triggerSnapshot}
            threads={threads}
          />
        )}
      </aside>
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
