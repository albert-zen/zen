/** Production components with synthetic Host facts. No native page, window or input. */
import React from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceBrowserPanel } from "../../src/renderer/src/workspace-browser-panel.js";
import { ComputerThreadPanel } from "../../src/renderer/src/computer-thread-panel.js";
import { PluginAccessReview } from "../../src/renderer/src/PluginAccessReview.js";
import { foregroundActivityHtml } from "../../src/foreground-activity-view.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { ComputerThreadEvent } from "../../src/main/capabilities/computer-thread-observation.js";
import type { WorkspaceBrowserTab } from "../../src/main/workspace-browser.js";
import computerManifest from "../../../../packages/zenx-computer-plugin/zenx.plugin.json";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "./browser-computer-experience-visual.css";

const visualParams = new URLSearchParams(location.search);
const scenario = visualParams.get("scenario") ?? "browser-working";
const nativeLocked = scenario === "environment-mac-locked";
const visualLanguage = visualParams.get("language") === "zh" ? "zh-CN" : "en";
document.documentElement.dataset.appearance =
  visualParams.get("appearance") === "light" ? "light" : "dark";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = nativeLocked ? "darwin" : "win32";
document.body.dataset.scenario = scenario;

const browserTab: WorkspaceBrowserTab = {
  id: "synthetic-page",
  threadId: "synthetic-thread",
  title: "Example documentation",
  url: "https://example.test/docs",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  sharedWithAgent: true,
  control: scenario === "browser-human" ? "human" : "agent",
  agentActionsInFlight: scenario === "browser-working" ? 1 : 0,
  agentInspectionsInFlight: 0,
  agentActionOutcomeUnknown: false,
  requiresFreshObservation: false,
};

(window as any).zenx = {
  workspaceBrowser: {
    onFocusAddress: () => () => {},
    mount: async () => {},
    command: async () => {},
    openExternal: async () => {},
  },
  computerObservation: {
    subscribe: (
      _request: unknown,
      listener: (event: ComputerThreadEvent) => void,
    ) => {
      queueMicrotask(() => {
        listener({
          type: "targets",
          selectedId: "synthetic-window",
          targets: [
            {
              id: "synthetic-window",
              invocationId: "synthetic-call",
              mode: "live",
              target: { pid: 42, windowTitle: "Example editor" },
              activity: { kind: "background-window", count: 1 },
            },
          ],
        });
        listener({
          type: "status",
          status: "live",
          message: "Live window preview",
        });
      });
      return () => {};
    },
  },
  computerReadiness: {
    probe: async () => ({
      platform: nativeLocked ? "darwin" : "win32",
      accessibility: nativeLocked ? "granted" : "not-applicable",
      screenRecording: nativeLocked ? "granted" : "not-applicable",
      foregroundControlEnabled: false,
      environment: {
        platform: nativeLocked ? "darwin" : "win32",
        sessionState:
          nativeLocked || scenario === "environment-locked"
            ? "locked"
            : "unknown",
        revision: 1,
        displayState: "unknown",
        lockedUse: nativeLocked ? "provider-dependent" : "unsupported",
        keepAwake: "inactive",
      },
    }),
  },
};

const root = document.getElementById("root")!;
void i18n.changeLanguage(visualLanguage).then(() => {
  if (scenario.startsWith("foreground-")) {
    const stopping = scenario === "foreground-stopping";
    root.innerHTML = `<div class="synthetic-desktop"><div class="synthetic-desktop-label">Synthetic desktop · no native input</div><div class="synthetic-window">Example editor window</div><iframe id="edge" title="Production edge indicator"></iframe><iframe id="status" title="Production foreground status"></iframe></div>`;
    const options = {
      agentNames: ["ZenX Agent"],
      actions: ["click"],
      stopping,
      language: "en" as const,
      escapeAvailable: true,
    };
    (document.getElementById("edge") as HTMLIFrameElement).srcdoc =
      foregroundActivityHtml({ ...options, kind: "edges" });
    (document.getElementById("status") as HTMLIFrameElement).srcdoc =
      foregroundActivityHtml({ ...options, kind: "status" });
    return;
  }
  const label =
    scenario === "browser-working"
      ? "Browser · Agent working on a page"
      : scenario === "browser-human"
        ? "Browser · human has control"
        : scenario === "computer-background"
          ? "Computer · exact background window activity"
          : nativeLocked || scenario === "environment-locked"
            ? "Computer settings · locked session"
            : "Computer settings · unknown session";
  createRoot(root).render(
    <main className="synthetic-stage">
      <p className="synthetic-eyebrow">
        ZenX production component · synthetic Host facts
      </p>
      <h1>{label}</h1>
      <div className="synthetic-panel">
        {scenario.startsWith("browser-") ? (
          <WorkspaceBrowserPanel
            threadId="synthetic-thread"
            tab={browserTab}
            open={true}
          />
        ) : scenario === "computer-background" ? (
          <ComputerThreadPanel threadId="synthetic-thread" active={true} />
        ) : (
          <PluginAccessReview
            pluginId="computer"
            permissions={
              nativeLocked
                ? computerManifest.permissions
                : [
                    {
                      id: "computer.window.capture",
                      title: "Capture a targeted window",
                      description: "Read the selected app window only.",
                      scope: "local-device",
                    },
                  ]
            }
          />
        )}
      </div>
      <p className="synthetic-boundary">
        Synthetic data. Native browser page, actual app windows and desktop
        input are not connected.
      </p>
    </main>,
  );
});
