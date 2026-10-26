/** Real titlebar and auxiliary tabs; all content and native dots are synthetic. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WindowTitleBar } from "../src/renderer/src/App.js";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { i18n } from "../src/renderer/src/i18n.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
const query = new URLSearchParams(location.search);
const platform = query.get("platform") ?? "darwin";
document.documentElement.dataset.platform = platform;
document.documentElement.dataset.appearance = query.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
Object.assign(window, { zenx: { platform } });
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
const customTabs = Array.from({ length: 12 }, (_, index) => ({
  id: `synthetic-${index}`,
  title:
    query.get("tabs") === "overflow"
      ? overflowLabels[index]!
      : index === 0
        ? "workspace.md"
        : `Synthetic review ${index}`,
  icon: "file" as const,
  render: () => (
    <p style={{ padding: 24 }}>
      Synthetic tab {index}. No Host, filesystem, network or user data.
    </p>
  ),
}));
function Preview() {
  const [collapsed, setCollapsed] = useState(query.get("sidebar") !== "open");
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState("custom:synthetic-0");
  const [tabs, setTabs] = useState(customTabs.map((tab) => `custom:${tab.id}`));
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
      <aside
        className={`sidebar${!collapsed ? " open" : ""}`}
        id="primary-sidebar"
      >
        <p style={{ padding: 16 }}>Synthetic Sidebar</p>
      </aside>
      <main className="workspace">
        <section className="agent-surface">
          <p style={{ padding: 24 }}>
            Actual WindowTitleBar and AuxiliaryPanel. Synthetic tabs and
            native-control markers only.
          </p>
        </section>
        <AuxiliaryPanel
          threadId="synthetic-safe-area-thread"
          title="Synthetic workspace"
          open={open}
          onOpenChange={setOpen}
          onWidthChange={setWidth}
          snapshot={null}
          selectedTab={selected}
          onSelectTab={setSelected}
          openedTabs={tabs}
          onTabsChange={setTabs}
          customTabs={customTabs}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
