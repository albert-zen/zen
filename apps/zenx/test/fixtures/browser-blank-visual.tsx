import React from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceBrowserPanel } from "../../src/renderer/src/workspace-browser-panel.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { WorkspaceBrowserTab } from "../../src/main/workspace-browser.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance =
  params.get("theme") === "dark" ? "dark" : "light";
const state = params.get("state") ?? "blank";
const tab: WorkspaceBrowserTab = {
  id: "synthetic-tab",
  threadId: "synthetic-thread",
  title: "New tab",
  url: state === "website" ? "https://example.test/" : "about:blank",
  loading: state === "loading",
  canGoBack: false,
  canGoForward: false,
  sharedWithAgent: true,
  control: "agent",
  agentActionsInFlight: 0,
  agentActionOutcomeUnknown: false,
  requiresFreshObservation: false,
  ...(state === "error"
    ? { error: "Synthetic navigation failure. Reload to retry." }
    : {}),
};
Object.defineProperty(window, "zenx", {
  value: {
    workspaceBrowser: {
      onFocusAddress: () => () => {},
      mount: async () => {},
      command: async () => [tab],
    },
  },
});
await i18n.changeLanguage("en");
createRoot(document.getElementById("root")!).render(
  <main
    style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      padding: 24,
      gap: 12,
    }}
  >
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <span>Browser · synthetic {state} state · production component</span>
      <button
        onClick={() => {
          document.documentElement.dataset.appearance =
            document.documentElement.dataset.appearance === "dark"
              ? "light"
              : "dark";
        }}
      >
        Switch appearance
      </button>
    </header>
    <div
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        border: "1px solid var(--color-border-default)",
      }}
    >
      <WorkspaceBrowserPanel threadId={tab.threadId} tab={tab} open />
    </div>
    <small>
      Synthetic renderer fixture. Native Electron web content is not simulated
      or overlaid.
    </small>
  </main>,
);
