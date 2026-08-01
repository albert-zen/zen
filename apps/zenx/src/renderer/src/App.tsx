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

export function App() {
  const selectionEpoch = useRef(0);
  const [railOpen, setRailOpen] = useState(true);
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
      return "inbox";
    }
  });
  const [requestError, setRequestError] = useState<string | null>(null);

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

  const selectedThread =
    threadDetail ??
    threads.find((thread) => thread.id === selectedThreadId) ??
    null;
  const pendingThreadIds = pendingApprovalThreadIds(approvals);

  const selectThread = async (threadId: string) => {
    const epoch = ++selectionEpoch.current;
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

  const newThread = async () => {
    const epoch = ++selectionEpoch.current;
    setThreadLoading(true);
    setThreadError(null);
    setModelUpdateError(null);
    try {
      const result = await window.zenx.protocol.request("thread/start", {});
      if (selectionEpoch.current !== epoch) return;
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

  const startTurn = async (text: string) => {
    if (threadDetail === null) throw new Error("No thread is selected");
    await window.zenx.protocol.request("turn/start", {
      threadId: threadDetail.id,
      input: [{ type: "text", text }],
    });
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
        onSelectThread={(threadId) => void selectThread(threadId)}
        pendingApprovalThreadIds={pendingThreadIds}
        selectedThreadId={selectedThreadId}
        serverReady={serverStatus.type === "ready"}
        threads={threads}
      />

      <main className="workspace">
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
            aria-label={railOpen ? "Hide details panel" : "Show details panel"}
            onClick={() => setRailOpen((open) => !open)}
          >
            <Icon name="panel-right" size={15} />
            Details
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
          <section className="empty-canvas" aria-live="polite">
            <div className="loading-ring" aria-hidden="true" />
            <h2>Starting Zen App Server</h2>
            <p>Connecting to the local agent runtime…</p>
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
            onInterrupt={interruptTurn}
            onRespondToApproval={respondToApproval}
            onStartTurn={startTurn}
            thread={threadDetail}
          />
        ) : (
          <section className="empty-canvas" aria-live="polite">
            <div className="loading-ring" aria-hidden="true" />
          </section>
        )}
      </main>

      <aside
        className={`detail-rail${railOpen ? " open" : ""}`}
        aria-label="Thread details"
        aria-hidden={!railOpen}
      >
        <div className="rail-content">
          <h2>Details</h2>
          {selectedThread === null ? (
            <p>Select a conversation to inspect its runtime context.</p>
          ) : (
            <dl className="thread-facts">
              <div>
                <dt>Workspace</dt>
                <dd>{selectedThread.cwd}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{selectedThread.modelProvider}</dd>
              </div>
              <div>
                <dt>Turns</dt>
                <dd>{selectedThread.turns.length}</dd>
              </div>
              <div>
                <dt>Thread ID</dt>
                <dd>{selectedThread.id}</dd>
              </div>
            </dl>
          )}
        </div>
      </aside>
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
