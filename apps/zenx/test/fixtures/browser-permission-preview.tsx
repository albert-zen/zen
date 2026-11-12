import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceBrowserPanel } from "../../src/renderer/src/workspace-browser-panel.js";
import type { WorkspaceBrowserTab } from "../../src/main/workspace-browser.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
void i18n.changeLanguage(params.get("lang") ?? "zh-CN");
const initial: WorkspaceBrowserTab = {
  id: "synthetic-tab",
  threadId: "synthetic-thread",
  title: "Synthetic sign-in",
  url: "https://example.com/sign-in",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  sharedWithAgent: true,
  control: "agent",
  agentActionsInFlight: 0,
  agentActionOutcomeUnknown: false,
  requiresFreshObservation: false,
};
const calls: unknown[] = [];
const mounts: unknown[] = [];
Object.assign(window, { previewCalls: calls, previewMounts: mounts });
function Preview() {
  const [tab, setTab] = useState<WorkspaceBrowserTab>(() => ({
    ...initial,
    control: params.get("permission") === "off" ? "human" : "agent",
  }));
  Object.assign(window, {
    previewSetTab: (change: Partial<WorkspaceBrowserTab>) =>
      setTab({ ...initial, ...change }),
    zenx: {
      workspaceBrowser: {
        onFocusAddress: () => () => {},
        mount: async (request: unknown) => {
          mounts.push(request);
        },
        command: async (...args: unknown[]) => {
          calls.push(args);
          if (args[1] === "take-control") setTab({ ...tab, control: "human" });
          if (args[1] === "return-control")
            setTab({
              ...tab,
              control: "agent",
              requiresFreshObservation: true,
            });
          return [];
        },
      },
    },
  });
  return (
    <div
      style={{
        height: "100dvh",
        width: params.get("size") === "narrow" ? 390 : "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-surface-main)",
      }}
    >
      <div
        style={{
          height: 44,
          flex: "none",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          borderBottom: "1px solid var(--color-border-subtle)",
          fontSize: 13,
        }}
      >
        ZenX · Browser · Synthetic sign-in
      </div>
      <div
        className="permission-preview"
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          containerType: "inline-size",
        }}
      >
        <WorkspaceBrowserPanel threadId={tab.threadId} tab={tab} open={true} />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
// This is deliberately a renderer fixture, not a native WebContents validation.
// Draw a synthetic, inert sign-in page inside the actual viewport placeholder.
const observer = new MutationObserver(() => {
  const viewport = document.querySelector(".workspace-browser-viewport");
  if (viewport && !viewport.firstChild) {
    const page = document.createElement("div");
    page.style.cssText =
      "height:100%;display:grid;place-items:center;background:var(--color-surface-main);color:var(--color-text-primary)";
    page.innerHTML =
      '<div style="width:min(300px,80%);font-size:14px"><p style="font-size:12px;opacity:.6">SYNTHETIC PAGE · NO REAL ACCOUNT</p><h2 style="font-weight:500">Sign in to continue</h2><label>Account<input style="display:block;width:100%;margin:8px 0 20px;padding:10px;border:1px solid #8885;border-radius:6px" placeholder="you@example.com" /></label><button style="padding:10px 16px;border-radius:6px;border:1px solid #8885">Continue</button></div>';
    viewport.appendChild(page);
  }
});
observer.observe(document.body, { childList: true, subtree: true });
