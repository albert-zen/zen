/** Real titlebar and auxiliary tabs; all content and native dots are synthetic. */
import React, { useEffect, useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { WindowTitleBar } from "../src/renderer/src/App.js";
import { Sidebar } from "../src/renderer/src/Sidebar.js";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { subagentsManifest } from "../../../packages/zenx-subagents-plugin/src/manifest.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import {
  sidebarTabFromId,
  type ThreadSidebarState,
} from "../src/thread-sidebar-state.js";
import { i18n } from "../src/renderer/src/i18n.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
const query = new URLSearchParams(location.search);
const platform = query.get("platform") ?? "darwin";
document.documentElement.dataset.platform = platform;
document.documentElement.dataset.appearance = query.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
Object.assign(window, {
  zenx: {
    platform,
    plugins: {
      executeCommand: async () => {
        throw new Error("Synthetic preview has no Host");
      },
      readHandle: async () => {
        throw new Error("Synthetic preview has no Host");
      },
    },
  },
});
const realSubject = query.get("subject") === "plugin";
// Use the bundled manifest contribution, not a custom tab with an assigned icon.
// Bundle execution is intentionally absent: this fixture exercises shell chrome only.
const subjectSnapshot: ZenXPluginSnapshot = {
  plugins: [],
  bundles: [],
  surfaces: [],
  sidebar: [],
  pages: [],
  subroutes: [],
  settings: [],
  commands: [],
  menus: [],
  panels: subagentsManifest.contributions.panels.map((panel) => ({
    ...panel,
    pluginId: subagentsManifest.id,
    key: `${subagentsManifest.id}:${panel.id}`,
  })),
};
const subjectId = `plugin:${subjectSnapshot.panels[0]!.key}`;
void i18n.changeLanguage(query.get("lang") ?? "en");
const overflowLabels = [
  "app.ts",
  "Workspace acceptance and verification.md",
  "侧栏标签与编辑器草稿保留说明.md",
  "Browser: synthetic documentation",
  "x.go",
  "Long resource title with multiple words and suffix.tsx",
  "工作区滚动与键盘导航验收.md",
  "README.md",
  "Synthetic production screenshot review.md",
  "计划.md",
  "workspace-panel-overflow-regression.test.ts",
  "最后一个资源.md",
];
const customTabs = Array.from(
  { length: query.get("count") === "short" ? 2 : 12 },
  (_, index) => ({
    id: `synthetic-${index}`,
    title:
      query.get("tabs") === "overflow"
        ? overflowLabels[index]!
        : index === 0
          ? query.has("navigation")
            ? "Subagents"
            : "workspace.md"
          : `Synthetic review ${index}`,
    icon: query.has("navigation") ? ("users" as const) : ("file" as const),
    render: () => (
      <p style={{ padding: 24 }}>
        Synthetic tab {index}. No Host, filesystem, network or user data.
      </p>
    ),
  }),
);
const previewThreads: NativeThreadSummary[] = [
  "pinned",
  "project",
  "recent",
].map((id, index) => ({
  threadId: id,
  name: ["Pinned synthetic task", "Project task", "Recent no-project task"][
    index
  ]!,
  preview: "",
  archived: false,
  status: "idle",
  createdAt: new Date(1000).toISOString(),
  updatedAt: new Date(2000 + index * 1000).toISOString(),
  currentMetadata: {
    model: "synthetic-model",
    provider: "fake",
    cwd:
      id === "recent" ? "/synthetic/workspaces/recent" : "/synthetic/project",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  },
}));
function Preview() {
  const [newProjectless, setNewProjectless] = useState(false);
  const [selectedThread, setSelectedThread] = useState("recent");
  const [collapsed, setCollapsed] = useState(query.get("sidebar") !== "open");
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(0);
  const widthTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportWidth = useCallback((value: number) => {
    if (widthTimer.current) clearTimeout(widthTimer.current);
    const delay = Math.min(
      60000,
      Math.max(0, Number(query.get("widthDelay")) || 0),
    );
    if (delay) widthTimer.current = setTimeout(() => setWidth(value), delay);
    else setWidth(value);
  }, []);
  useEffect(
    () => () => {
      if (widthTimer.current) clearTimeout(widthTimer.current);
    },
    [],
  );
  const [selected, setSelected] = useState(
    realSubject ? subjectId : "custom:synthetic-0",
  );
  const fixtureTabs = realSubject ? customTabs.slice(1) : customTabs;
  const [tabs, setTabs] = useState([
    ...(realSubject ? [subjectId] : []),
    ...fixtureTabs.map((tab) => `custom:${tab.id}`),
  ]);
  const [fullscreen, setFullscreen] = useState(false);
  const presentation: ThreadSidebarState | undefined =
    query.get("state") === "durable"
      ? {
          owner: { kind: "thread", id: "synthetic-safe-area-thread" },
          revision: 1,
          open,
          fullscreen,
          selectedTab: selected,
          resourceThreadId: "synthetic-safe-area-thread",
          tabs: tabs.map(sidebarTabFromId).filter((tab) => tab !== null),
        }
      : undefined;
  useEffect(() => {
    Object.assign(window, {
      __titlebarPreview: { setCollapsed, setSelected, setTabs },
    });
    void document.fonts.ready.then(() => {
      document.body.dataset.previewReady = "true";
    });
  }, []);
  return (
    <div
      className={`app-shell ${collapsed ? "sidebar-collapsed" : "sidebar-open"}`}
      style={{ "--workspace-panel-width": `${width}px` } as React.CSSProperties}
    >
      <WindowTitleBar
        mode="projects"
        pendingApprovalCount={0}
        sidebarCollapsed={collapsed}
        onToggleInbox={() => {}}
        onToggleSidebar={() => setCollapsed((value) => !value)}
      >
        <div className="thread-heading">
          <span>Synthetic conversation</span>
        </div>
      </WindowTitleBar>
      {platform === "darwin" && (
        <div
          data-synthetic-native-controls
          aria-label="Synthetic native controls, not interactive"
          style={{
            position: "absolute",
            left: 14,
            top: 16,
            display: "flex",
            gap: 8,
            zIndex: 100,
            pointerEvents: "none",
          }}
        >
          {["#ff6058", "#ffbd2e", "#28c840"].map((color) => (
            <span
              key={color}
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: color,
              }}
            />
          ))}
        </div>
      )}
      {query.has("navigation") ? (
        <Sidebar
          collapsed={collapsed}
          mode="projects"
          open={!collapsed}
          onClose={() => setCollapsed(true)}
          onNewThread={() => setNewProjectless(false)}
          onNewProjectlessThread={() => {
            setNewProjectless(true);
            document.body.dataset.projectlessDraft = "true";
          }}
          onAddProject={() => {}}
          onRemoveProject={() => {}}
          onSetDefaultProject={() => {}}
          onOpenContribution={() => {}}
          onOpenSettings={() => {}}
          onRetryThreads={() => {}}
          onChangeThreadLifecycle={async () => {}}
          onChangeThreadPinned={async () => {}}
          onRenameThread={async () => {}}
          onSelectThread={setSelectedThread}
          pendingApprovalThreadIds={new Set()}
          pluginContributions={[]}
          selectedPage="agent"
          selectedThreadId={selectedThread}
          serverStatus={{ type: "ready", reconnected: false }}
          liveThread={null}
          threadError={null}
          threadLoading={false}
          projects={{
            projects: [
              {
                key: "/synthetic/project",
                workspace: "/synthetic/project",
                name: "Synthetic project",
                configured: true,
                isDefault: true,
                threadIds: ["pinned", "project"],
              },
            ],
            unavailableThreadIds: [],
            projectlessThreadIds: ["recent"],
            lastUsedWorkspace: "/synthetic/project",
          }}
          pinnedThreads={[previewThreads[0]!]}
          threads={previewThreads}
        />
      ) : (
        <aside
          className={`sidebar${!collapsed ? " open" : ""}`}
          id="primary-sidebar"
        >
          <p style={{ padding: 16 }}>Synthetic Sidebar</p>
        </aside>
      )}
      <main className="workspace">
        <section className="agent-surface">
          <p style={{ padding: 24 }}>
            {newProjectless
              ? "No-project draft. No folder or Thread has been created."
              : "Actual WindowTitleBar, Sidebar and AuxiliaryPanel. Synthetic data only."}
          </p>
        </section>
        <AuxiliaryPanel
          threadId="synthetic-safe-area-thread"
          title="Synthetic workspace"
          open={open}
          onOpenChange={setOpen}
          onWidthChange={reportWidth}
          snapshot={realSubject ? subjectSnapshot : null}
          presentationState={presentation}
          onFullscreenChange={presentation ? setFullscreen : undefined}
          selectedTab={selected}
          onSelectTab={setSelected}
          openedTabs={tabs}
          onTabsChange={setTabs}
          customTabs={fixtureTabs}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
