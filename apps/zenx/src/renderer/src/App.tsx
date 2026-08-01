import { useEffect, useState } from "react";
import type { AppServerHostStatus } from "../../main/app-server-manager";
import { Icon } from "./icons";

export function App() {
  const [railOpen, setRailOpen] = useState(true);
  const [serverStatus, setServerStatus] = useState<AppServerHostStatus>({
    type: "starting",
  });
  const [threadCount, setThreadCount] = useState<number | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadThreads = async () => {
      try {
        const result = await window.zenx.protocol.request("thread/list", {});
        if (active) {
          setThreadCount(result.data.length);
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
    };
  }, []);

  return (
    <div className="app-shell">
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
        </header>

        <nav className="sidebar-nav" aria-label="Primary">
          <button className="nav-item" type="button">
            <Icon name="compose" />
            New conversation
          </button>
          <button
            className="nav-item selected"
            type="button"
            aria-current="page"
          >
            <Icon name="inbox" />
            Inbox
          </button>
        </nav>

        <section className="thread-list" aria-labelledby="threads-heading">
          <h2 id="threads-heading">
            Threads{threadCount === null ? "" : ` · ${String(threadCount)}`}
          </h2>
          <div className="sidebar-empty">
            {serverStatus.type === "ready"
              ? "Your conversations will appear here."
              : "Waiting for the local App Server."}
          </div>
        </section>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <h1>Start a conversation</h1>
            <p>Select a thread or create a new one.</p>
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
        ) : (
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
