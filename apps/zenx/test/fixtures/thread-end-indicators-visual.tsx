import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import {
  syntheticEndThreads,
  threadEndSidebarProps,
} from "./thread-end-sidebar.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

const search = new URLSearchParams(location.search);
const appearance = search.get("appearance") === "light" ? "light" : "dark";
const accent = search.get("accent") ?? "jade";
document.documentElement.dataset.appearance = appearance;
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.accent = accent;
document.documentElement.dataset.platform = "linux";
if (accent === "red-token")
  document.documentElement.style.setProperty(
    "--color-accent",
    appearance === "light" ? "#b74742" : "#ef877f",
  );
void i18n.changeLanguage("en");
const threads = syntheticEndThreads();
function Fixture() {
  const [unread, setUnread] = useState(
    new Set(
      threads.filter((t) => t.threadId !== "read").map((t) => t.threadId),
    ),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const props = threadEndSidebarProps(threads, unread);
  return (
    <div
      className="app-shell"
      style={{ "--sidebar-width": "320px" } as React.CSSProperties}
    >
      <Sidebar
        {...props}
        selectedThreadId={selected}
        onSelectThread={setSelected}
      />
      <main
        className="workspace"
        style={{
          padding: 32,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <p>Production Sidebar · synthetic data only</p>
        <h1>Unread execution endings</h1>
        <p>
          {appearance} /{" "}
          {accent === "red-token"
            ? "red token verification (not a selectable theme)"
            : accent}
        </p>
        <p>
          Normal completion: 10px theme accent dot.
          <br />
          Failure: 10px red outlined exclamation, replacing the dot.
          <br />
          Running and retrying: no end marker.
          <br />
          Cancellation: ordinary dot. Viewed failure: no marker.
        </p>
        <p>
          Selection alone keeps the unread ending. The button below simulates
          the actual visible terminal-tail read; runtime/read integration is
          tested separately.
        </p>
        <button
          type="button"
          disabled={!selected}
          onClick={() =>
            setUnread((previous) => {
              const next = new Set(previous);
              if (selected) next.delete(selected);
              return next;
            })
          }
        >
          Mark selected ending viewed
        </button>
        <p>
          Appearance:{" "}
          {["light", "dark"].map((value) => (
            <a
              key={value}
              style={{ marginRight: 16 }}
              href={`?appearance=${value}&accent=${accent}`}
            >
              {value}
            </a>
          ))}
        </p>
        <p>
          Accent:{" "}
          {["azure", "iris", "jade", "red-token"].map((value) => (
            <a
              key={value}
              style={{ marginRight: 16 }}
              href={`?appearance=${appearance}&accent=${value}`}
            >
              {value}
            </a>
          ))}
        </p>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
