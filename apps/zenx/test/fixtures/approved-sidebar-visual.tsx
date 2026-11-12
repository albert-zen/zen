import React, { useEffect, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import type { ZenXProjectProjectionSnapshot } from "../../src/main/project-projection.js";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

const search = new URLSearchParams(location.search);
const platform = search.get("platform") === "win32" ? "win32" : "darwin";
const theme = search.get("theme") === "light" ? "light" : "dark";
const width = search.get("width") === "360" ? 360 : 220;
const lang = search.get("lang") === "en" ? "en" : "zh-CN";
const workspace = "/synthetic/approved-sidebar";
const now = Date.now();
const noop = () => undefined;

document.documentElement.dataset.appearance = theme;
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = platform;
document.documentElement.lang = lang;
void i18n.changeLanguage(lang);

// Only this fixture's renderer-local preferences are reset. No Host is present.
localStorage.setItem("zenx.sidebar.thread-density", "detailed");
// This focused shortcut/status fixture compares exactly five Project rows.
// Recent is independently covered by the navigation fixture; leave its real
// disclosure present but collapsed so duplicate projections do not double the
// readiness/status counts or silently turn screenshot checks into timeouts.
localStorage.setItem("zenx.sidebar.expanded.recent", "false");
for (const identity of ["projects", `project:${workspace}`]) {
  localStorage.removeItem(
    `zenx.sidebar.expanded.${encodeURIComponent(identity)}`,
  );
}

const rows = [
  {
    id: "running",
    state: "running + Trigger",
    status: "active",
    title:
      lang === "en"
        ? "Running: verify the complete sidebar shortcut, status and hover layout"
        : "运行中：验证侧栏快捷键、真实状态与悬停操作在长标题下的完整布局",
  },
  {
    id: "unread",
    state: "idle unread + Trigger",
    status: "idle",
    title:
      lang === "en"
        ? "Unread result: review the full Windows input and scheduling regression"
        : "未读结果：检查 Windows 输入体验与触发器调度回归的完整测试结论",
  },
  {
    id: "approval",
    state: "approval + Trigger",
    status: "active",
    title:
      lang === "en"
        ? "Approval: confirm the next action while keeping every status visible"
        : "等待审批：确认下一步执行内容并保留全部真实状态与快捷键提示",
  },
  {
    id: "plain",
    state: "plain idle",
    status: "idle",
    title:
      lang === "en"
        ? "A deliberately long idle thread title should use all remaining space"
        : "普通空闲会话：没有额外状态时标题应该使用全部剩余可用空间",
  },
  {
    id: "cjk",
    state: "long CJK title",
    status: "idle",
    title:
      "跨平台侧栏视觉回归：中日韩长标题、运行状态、快捷键和悬停操作区域互不重叠",
  },
] as const;

const threads: NativeThreadSummary[] = rows.map((row, index) => ({
  threadId: row.id,
  name: row.title,
  status: row.status,
  archived: false,
  createdAt: new Date(now - 3_600_000).toISOString(),
  updatedAt: new Date(now - index * 1_000).toISOString(),
  preview: "",
  currentMetadata: {
    cwd: workspace,
    model: "gpt-5.6",
    provider: "openai",
    sandbox: "workspace-write",
    approvalPolicy: "always",
  },
  lastMessage: {
    id: `synthetic-message-${row.id}`,
    createdAt: new Date(now - 900_000).toISOString(),
    kind: "agent",
  },
  ...(row.id === "unread"
    ? {
        lastTurnEnd: {
          id: "synthetic-unread-end",
          turnId: "synthetic-unread-turn",
          createdAt: new Date(now - 900_000).toISOString(),
          position: 0,
          status: "completed" as const,
        },
      }
    : {}),
}));

const projects: ZenXProjectProjectionSnapshot = {
  projects: [
    {
      key: workspace,
      workspace,
      name: "Sidebar QA",
      configured: true,
      isDefault: true,
      threadIds: rows.map((row) => row.id),
    },
  ],
  unavailableThreadIds: [],
  lastUsedWorkspace: workspace,
};

const triggers = rows.slice(0, 3).map((row, index) => ({
  id: `synthetic-trigger-${row.id}`,
  threadId: row.id,
  kind: "timer",
  active: true,
  timer: { nextRunAt: now + (index + 1) * 3_600_000 },
}));

// This is the entire mock bridge: one admitted read command and platform.
// Unexpected commands fail instead of reaching a real Host or network.
Object.assign(window, {
  zenx: {
    platform,
    plugins: {
      executeCommand: async (pluginId: string, commandId: string) => {
        if (pluginId === "zenx-triggers" && commandId === "sidebar-facts")
          return { triggers };
        throw new Error("Synthetic fixture has no Host command access");
      },
    },
  },
});

const sidebarVisual = {
  ready: false,
  source:
    "Production Sidebar and theme/styles; synthetic Thread, Trigger, approval and unread facts. No live Host, network or profile writes. Not native Electron acceptance.",
  platform,
  theme,
  width,
  height: 680,
  lang,
  rows,
  selectors: {
    stage: ".sidebar-visual-stage",
    frame: "#sidebar-visual-frame",
    sidebar: "#primary-sidebar",
    row: ".thread-row-shell[data-thread-id]",
    title: ".thread-title",
    status: ".thread-status-rail",
    trigger: '.thread-status-slot [data-icon="clock"]',
    running: ".thread-running-spinner",
    unread: ".thread-unread-dot",
    approval: ".needs-dot",
    menu: ".thread-menu-trigger",
    shortcut: ".thread-row[data-shortcut-key]",
    information: ".thread-information",
  },
  setModifier(pressed: boolean) {
    // Exercise Sidebar's real document keyboard handlers, not its attributes.
    const mac = platform === "darwin";
    document.dispatchEvent(
      new KeyboardEvent(pressed ? "keydown" : "keyup", {
        key: mac ? "Meta" : "Control",
        code: mac ? "MetaLeft" : "ControlLeft",
        metaKey: mac && pressed,
        ctrlKey: !mac && pressed,
        bubbles: true,
        cancelable: true,
      }),
    );
  },
  blur() {
    window.dispatchEvent(new Event("blur"));
  },
};

Object.assign(window, { __sidebarVisual: sidebarVisual });

async function rejectMutation() {
  throw new Error("This synthetic screenshot fixture is read-only");
}

function Fixture() {
  const [selectedThreadId, setSelectedThreadId] = useState("running");

  useEffect(() => {
    let active = true;
    let checking = false;
    const checkReady = () => {
      if (
        checking ||
        document.querySelectorAll(sidebarVisual.selectors.row).length !== 5 ||
        document.querySelectorAll(sidebarVisual.selectors.trigger).length !== 3
      )
        return;
      checking = true;
      void document.fonts.ready.then(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!active) return;
            sidebarVisual.ready = true;
            observer.disconnect();
          });
        });
      });
    };
    const observer = new MutationObserver(checkReady);
    observer.observe(document.getElementById("primary-sidebar")!, {
      childList: true,
      subtree: true,
    });
    checkReady();
    return () => {
      active = false;
      observer.disconnect();
      sidebarVisual.ready = false;
    };
  }, []);

  return (
    <main className="sidebar-visual-stage" style={{ padding: 20 }}>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>
          Sidebar shortcut slot · synthetic QA
        </h1>
        <p style={{ color: "var(--text-3)", fontSize: 12, margin: 0 }}>
          {platform} · {theme} · {width} × 680 · {lang}
        </p>
      </header>
      <section
        id="sidebar-visual-frame"
        aria-label="Production Sidebar with synthetic QA data"
        style={
          {
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gridTemplateRows: "0 minmax(0, 1fr)",
            width,
            height: 680,
            "--product-row-height": "48px",
          } as CSSProperties
        }
      >
        <Sidebar
          mode="projects"
          open={true}
          onClose={noop}
          onChangeThreadLifecycle={rejectMutation}
          onChangeThreadPinned={rejectMutation}
          onNewThread={noop}
          onAddProject={noop}
          onRemoveProject={noop}
          onSetDefaultProject={noop}
          onOpenContribution={noop}
          onOpenSettings={noop}
          onRetryThreads={noop}
          onRenameThread={rejectMutation}
          onSelectThread={setSelectedThreadId}
          pendingApprovalThreadIds={new Set(["approval"])}
          pluginContributions={[]}
          triggerAdmissionId="synthetic-approved-sidebar-trigger-admission"
          selectedPage="agent"
          selectedThreadId={selectedThreadId}
          serverStatus={{ type: "ready", reconnected: false }}
          liveThread={null}
          threadError={null}
          threadLoading={false}
          projects={projects}
          sidebarOrder={{
            projectKeys: [workspace],
            threadIdsByProject: {
              [workspace]: rows.map((row) => row.id),
            },
          }}
          pinnedThreads={[]}
          threads={threads}
          unreadThreadIds={new Set(["unread"])}
        />
      </section>
      <p style={{ color: "var(--text-3)", fontSize: 11, margin: "10px 0 0" }}>
        Real production component · synthetic facts · no live Host or network ·
        browser capture, not native Electron acceptance
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
