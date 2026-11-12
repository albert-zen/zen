/** Isolated renderer fixture, not a second implementation of What's New. */
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import { Sidebar } from "../src/renderer/src/Sidebar.js";
import { ZenXBrand } from "../src/renderer/src/ZenXBrand.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { RELEASE_NOTES } from "../src/renderer/src/release-notes.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";

const search = new URLSearchParams(location.search);
const language = search.get("lang") === "zh-CN" ? "zh-CN" : "en";
const appearance = search.get("theme") === "light" ? "light" : "dark";
const workspace = "/synthetic/whats-new-preview";
const noop = () => undefined;
const noHostMutation = async () => {
  throw new Error("This synthetic component fixture has no Host access.");
};

document.documentElement.lang = language;
document.documentElement.dataset.appearance = appearance;
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
void i18n.changeLanguage(language);
// No credentials, profile, settings API, plugins or live Host are provided.
Object.assign(window, {
  zenx: { platform: "linux" },
  __whatsNewPreview: {
    expectedNotes: RELEASE_NOTES.map((release) => ({
      date: release.date,
      items: release.items.map(
        (item) => item[language === "zh-CN" ? "zh" : "en"],
      ),
    })),
  },
});

const threads: NativeThreadSummary[] = [
  {
    threadId: "synthetic-whats-new-thread",
    name: language === "en" ? "Review the latest changes" : "查看最新更新",
    status: "idle",
    archived: false,
    createdAt: "2026-10-20T08:00:00.000Z",
    updatedAt: "2026-10-20T08:00:00.000Z",
    preview: "",
    currentMetadata: {
      cwd: workspace,
      model: "",
      provider: "",
      sandbox: "workspace-write",
      approvalPolicy: "always",
    },
  },
];

function Preview() {
  useEffect(() => {
    let active = true;
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (active) document.body.dataset.previewReady = "true";
        });
      });
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="app-shell sidebar-open">
      <header className="window-titlebar">
        <div className="window-titlebar-product">
          <ZenXBrand />
        </div>
        <div className="window-titlebar-session" />
      </header>
      <Sidebar
        mode="projects"
        open={true}
        onClose={noop}
        onChangeThreadLifecycle={noHostMutation}
        onChangeThreadPinned={noHostMutation}
        onNewThread={noop}
        onAddProject={noop}
        onRemoveProject={noop}
        onSetDefaultProject={noop}
        onOpenContribution={noop}
        onOpenSettings={noop}
        onRetryThreads={noop}
        onRenameThread={noHostMutation}
        onSelectThread={noop}
        pendingApprovalThreadIds={new Set()}
        pluginContributions={[]}
        selectedPage="agent"
        selectedThreadId={threads[0]!.threadId}
        serverStatus={{ type: "ready", reconnected: false }}
        liveThread={null}
        threadError={null}
        threadLoading={false}
        projects={{
          projects: [
            {
              key: workspace,
              workspace,
              name: "Synthetic preview",
              configured: true,
              isDefault: true,
              threadIds: threads.map((thread) => thread.threadId),
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: workspace,
        }}
        pinnedThreads={[]}
        threads={threads}
      />
      <main
        className="workspace"
        style={{
          display: "grid",
          placeItems: "center",
          padding: 32,
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 400 }}>
          <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>
            {language === "en" ? "What’s New preview" : "更新内容预览"}
          </h1>
          <p
            style={{
              color: "var(--color-text-muted)",
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            Production Sidebar, What’s New, shared Dialog and theme tokens.
            Synthetic project and thread only. Bundled release notes are
            unchanged. No Host or private profile.
          </p>
          <p style={{ color: "var(--color-text-muted)", fontSize: 11 }}>
            Open What’s New from the sidebar. Other navigation is inactive. This
            browser fixture is not native Electron acceptance.
          </p>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
