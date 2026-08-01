import { useEffect, useState } from "react";
import type { AppServerHostStatus } from "../../main/app-server-manager.js";
import type { Thread } from "../../protocol-client/index.js";
import { Icon } from "./icons";
import { Sidebar } from "./Sidebar";
import {
  applyThreadNotification,
  readSidebarMode,
  threadTitle,
  writeSidebarMode,
  type SidebarMode,
} from "./thread-list";

export function App() {
  const [railOpen, setRailOpen] = useState(true);
  const [serverStatus, setServerStatus] = useState<AppServerHostStatus>({
    type: "starting",
  });
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
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
    const dispose = window.zenx.protocol.onStatus((status) => {
      if (!active) return;
      setServerStatus(status);
      if (status.type === "ready") void loadThreads();
    });
    const disposeNotifications = window.zenx.protocol.onNotification(
      (method, params) => {
        if (active) {
          setThreads((current) =>
            applyThreadNotification(current, method, params),
          );
        }
      },
    );
    void window.zenx.protocol
      .getStatus()
      .then((status) => {
        if (!active) return;
        setServerStatus(status);
        if (status.type === "ready") void loadThreads();
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
    };
  }, []);

  const selectedThread =
    threads.find((thread) => thread.id === selectedThreadId) ?? null;
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
        onSelectThread={setSelectedThreadId}
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
                : `${selectedThread.cwd} · ${selectedThread.modelProvider}`}
            </p>
          </div>
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
        ) : selectedThread === null ? (
          <section className="empty-canvas" aria-label="Empty conversation">
            <div className="empty-glyph" aria-hidden="true">
              <Icon name="thread" size={22} />
            </div>
            <h2>No thread selected</h2>
            <p>Create a conversation to start working with Zen.</p>
            <button className="primary-button" type="button">
              <Icon name="compose" size={15} />
              New conversation
            </button>
          </section>
        ) : (
          <section className="empty-canvas" aria-label="Selected thread">
            <div className="empty-glyph" aria-hidden="true">
              <Icon name="thread" size={22} />
            </div>
            <h2>Thread selected</h2>
            <p>Conversation history will appear here in the thread view.</p>
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
          <p>Thread information and activity will appear here.</p>
          <div className="rail-placeholder" aria-hidden="true" />
          <div className="rail-placeholder short" aria-hidden="true" />
        </div>
      </aside>
    </div>
  );
}
