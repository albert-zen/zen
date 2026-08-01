import { useState } from "react";
import { Icon } from "./icons";

export function App() {
  const [railOpen, setRailOpen] = useState(true);

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
          <h2 id="threads-heading">Threads</h2>
          <div className="sidebar-empty">
            Your conversations will appear here.
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
