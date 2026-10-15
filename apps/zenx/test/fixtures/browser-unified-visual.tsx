import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuxiliaryPanel } from "../../src/renderer/src/auxiliary-panel.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type {
  WorkspaceBrowserPresentation,
  WorkspaceBrowserTab,
} from "../../src/main/workspace-browser.js";
import type { BrowserThreadEvent } from "../../src/main/capabilities/browser-thread-observation.js";
import type { ZenXPluginSnapshot } from "../../src/main/capabilities/types.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

// Production components with explicitly synthetic state. This is not an
// Electron WebContents, connected-page screenshot, account or native QA result.
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
void i18n.changeLanguage(params.get("lang") ?? "en");
const state = params.get("state") ?? "working";
const threadId = "synthetic-browser-thread";
let pages: WorkspaceBrowserTab[] = [
  {
    id: "shared-draft",
    threadId,
    title: "Project draft",
    url: "https://example.test/draft",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sharedWithAgent: true,
    control: "agent",
    agentActionsInFlight: 0,
    agentInspectionsInFlight: state === "working" ? 1 : 0,
    agentActionOutcomeUnknown: state === "unknown",
    requiresFreshObservation: state === "unknown",
  },
  {
    id: "reference",
    threadId,
    title: "Reference",
    url: "https://example.test/reference",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sharedWithAgent: true,
    control: "human",
    agentActionsInFlight: 0,
    agentActionOutcomeUnknown: false,
    requiresFreshObservation: false,
  },
];
const changes = new Set<
  (value: { threadId: string; tabs: WorkspaceBrowserTab[] }) => void
>();
let operationSequence = 0;
const presentations = new Set<(value: WorkspaceBrowserPresentation) => void>();
const calls: unknown[] = [];
const external = {
  id: "connected:synthetic-target",
  backendId: "connected" as const,
  connectionId: "synthetic-connection",
  connectionLabel: "Synthetic external browser",
  sessionId: "synthetic-session",
  tabId: "synthetic-tab",
  title: "External reference",
  url: "https://example.test/reference",
  loading: false,
  mode: "live" as const,
};
const harness = Object.assign(window, {
  previewCalls: calls,
  previewPresent: () => {
    const requestedAt = Date.now();
    for (const listener of presentations)
      listener({
        requestId: crypto.randomUUID(),
        requestedAt,
        expiresAt: requestedAt + 750,
        threadId,
        sessionEpoch: "synthetic-session-epoch",
        operationSequence: ++operationSequence,
        tab: pages[0]!,
      });
  },
  previewActivity: (active: boolean) => {
    pages = pages.map((page, index) =>
      index === 0
        ? { ...page, agentInspectionsInFlight: active ? 1 : 0 }
        : page,
    );
    for (const listener of changes) listener({ threadId, tabs: pages });
  },
  zenx: {
    plugins: {},
    workspaceBrowser: {
      command: async (_threadId: string, command: string, id?: string) => {
        calls.push({ command, id });
        if (command === "take-control" || command === "return-control") {
          pages = pages.map((page) =>
            page.id === id
              ? {
                  ...page,
                  control: command === "take-control" ? "human" : "agent",
                }
              : page,
          );
          for (const listener of changes) listener({ threadId, tabs: pages });
        }
        return pages;
      },
      onChanged: (
        listener: (value: {
          threadId: string;
          tabs: WorkspaceBrowserTab[];
        }) => void,
      ) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
      onPresentation: (
        listener: (value: WorkspaceBrowserPresentation) => void,
      ) => {
        presentations.add(listener);
        return () => presentations.delete(listener);
      },
      onFocusAddress: () => () => {},
      presentationContext: async (request: unknown) => {
        calls.push({ context: request });
      },
      declinePresentation: async (requestId: string) => {
        calls.push({ declined: requestId });
      },
      mount: async (request: unknown) => {
        calls.push({ syntheticMount: request });
      },
    },
    browserObservation: {
      subscribe: (
        request: { targetId?: string },
        listener: (event: BrowserThreadEvent) => void,
      ) => {
        listener({
          type: "targets",
          targets: [external],
          ...(request.targetId ? { selectedId: external.id } : {}),
        });
        listener({
          type: "status",
          status: "unavailable",
          message:
            "Synthetic renderer fixture: no external browser is connected.",
        });
        return () => {};
      },
    },
  },
});
const snapshot = {
  plugins: [
    {
      id: "browser",
      enabled: true,
      available: true,
      admissionId: "synthetic-browser-provider",
    },
  ],
  panels: [],
} as unknown as ZenXPluginSnapshot;
function Preview() {
  const [selectedTab, onSelectTab] = useState(
    state === "external"
      ? `external-browser:${external.id}`
      : "browser:shared-draft",
  );
  const [open, onOpenChange] = useState(true);
  const [currentSnapshot, setSnapshot] = useState(snapshot);
  const [log, setLog] = useState("[]");
  useEffect(() => {
    const timer = setInterval(
      () => setLog(JSON.stringify(calls.slice(-6), null, 2)),
      250,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-surface-main)",
      }}
    >
      <p style={{ margin: 0, padding: "12px 16px", fontSize: 12 }}>
        SYNTHETIC RENDERER PREVIEW · No real account or native browser capture
      </p>
      <section
        aria-label="Synthetic fixture controls"
        style={{ padding: "0 16px 8px", fontSize: 12 }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button onClick={() => harness.previewActivity(true)}>
            Start synthetic activity
          </button>
          <button onClick={() => harness.previewActivity(false)}>
            Finish synthetic activity
          </button>
          <button onClick={() => harness.previewPresent()}>
            Request synthetic presentation
          </button>
          <button onClick={() => setSnapshot({ ...snapshot })}>
            Refresh external targets
          </button>
        </div>
        <p>
          Selected: {selectedTab} · Workspace: {open ? "open" : "closed"}
        </p>
        <details>
          <summary>Read-only synthetic calls</summary>
          <pre
            style={{ maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap" }}
          >
            {log}
          </pre>
        </details>
      </section>
      <div
        style={{
          position: "relative",
          display: "flex",
          flex: 1,
          minHeight: 0,
          width: params.get("size") === "narrow" ? 390 : "100%",
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            padding: 24,
            display: params.get("size") === "narrow" ? "none" : undefined,
          }}
        >
          <h2>Browser workspace</h2>
          <p>
            Shared pages and external read-only targets use the production tab
            strip.
          </p>
        </div>
        <AuxiliaryPanel
          threadId={threadId}
          title="Synthetic task"
          open={open}
          onOpenChange={onOpenChange}
          selectedTab={selectedTab}
          onSelectTab={onSelectTab}
          snapshot={currentSnapshot}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
// Clearly labelled inert content, not a fabricated native-page screenshot.
new MutationObserver(() => {
  const viewport = document.querySelector(".workspace-browser-viewport");
  if (viewport && !viewport.firstChild) {
    const note = document.createElement("div");
    note.style.cssText =
      "height:100%;display:grid;place-content:center;padding:32px;color:var(--color-text-primary);background:var(--color-surface-main);font-size:14px";
    note.textContent =
      "Synthetic page placeholder. Native same-page login and form state are verified separately by workspace-browser-smoke.";
    viewport.appendChild(note);
  }
}).observe(document.body, { childList: true, subtree: true });
