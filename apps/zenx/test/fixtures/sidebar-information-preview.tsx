import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { sidebarTriggerAdmissionId } from "../../src/renderer/src/sidebar-thread-information.js";
import type { ZenXPluginSnapshot } from "../../src/main/capabilities/types.js";
import { RoomsPage } from "../../src/renderer/src/bundled-automation-ui.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/room-conversations.css";
const search = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = search.get("theme") ?? "dark";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
void i18n.changeLanguage(search.get("lang") === "en" ? "en" : "zh-CN");
const now = Date.now();
const threads = [
  {
    id: "active",
    name: "设计评审：让自动化的下一步与当前运行一眼可见",
    status: "active",
  },
  {
    id: "unread",
    name: "Windows 输入体验：完整的中英文输入法回归结果",
    status: "idle",
  },
  {
    id: "scheduled",
    name: "整理今日项目进展与明天需要确认的事项",
    status: "idle",
  },
  {
    id: "plain",
    name: "A deliberately long thread title that can use every available pixel",
    status: "idle",
  },
  { id: "paused", name: "设备巡检与后台维护（已暂停）", status: "idle" },
  { id: "unknown", name: "检查跨机器调度状态与连接信息", status: "idle" },
].map((t) => ({
  threadId: t.id,
  name: t.name,
  status: t.status,
  archived: false,
  createdAt: new Date(now - 3600000).toISOString(),
  updatedAt: new Date(now).toISOString(),
  preview: "",
  lastMessage: {
    id: "message-" + t.id,
    createdAt: new Date(now - 900000).toISOString(),
    kind: "agent",
  },
  currentMetadata: {
    cwd: "/Projects/Zen",
    model: "gpt-5.6",
    provider: "openai",
    sandbox: "workspace-write",
    approvalPolicy: "always",
  },
}));
const timers = [
  {
    id: "a",
    threadId: "active",
    kind: "timer",
    active: true,
    timer: { nextRunAt: now + 1800000 },
  },
  {
    id: "b",
    threadId: "scheduled",
    kind: "timer",
    active: true,
    timer: { nextRunAt: now + 3600000 },
  },
  {
    id: "c",
    threadId: "scheduled",
    kind: "timer",
    active: true,
    timer: { nextRunAt: now + 7200000 },
  },
  {
    id: "p",
    threadId: "paused",
    kind: "timer",
    active: false,
    timer: { nextRunAt: now - 400000 },
  },
  {
    id: "u",
    threadId: "unknown",
    kind: "timer",
    active: true,
    timer: { nextRunAt: now - 400000 },
  },
];
const triggerSnapshot: ZenXPluginSnapshot = {
  plugins: [
    {
      id: "zenx-triggers",
      displayName: "Triggers",
      version: "1.0.1",
      source: "bundled",
      lifecycle: "enabled",
      enabled: true,
      available: true,
      admissionId: "fixture-trigger-admission",
      contributionCount: 1,
    },
  ],
  commands: [
    {
      id: "sidebar-facts",
      key: "zenx-triggers:sidebar-facts",
      pluginId: "zenx-triggers",
      title: "Read sidebar facts",
      tool: "zenx_triggers_sidebar_facts",
    },
  ],
  bundles: [],
  surfaces: [],
  sidebar: [],
  pages: [],
  subroutes: [],
  settings: [],
  panels: [],
  menus: [],
};
(window as any).zenx = {
  platform: "linux",
  threads: { list: async () => threads },
  plugins: {
    executeCommand: async (plugin: string, command: string) => {
      if (plugin === "zenx-triggers" && command === "sidebar-facts")
        return { triggers: timers };
      throw new Error("Fixture has no Host access");
    },
  },
};
let roomName = "PAW · 产品与工程";
const sdk: any = {
  commands: {
    execute: async (id: string, input: any) => {
      if (id === "list")
        return {
          rooms: [
            {
              id: "paw",
              name: roomName,
              assistant: { threadId: "active", triggerId: "a" },
              assistantRepliesEnabled: true,
              members: [{ name: "PAW", threadId: "active" }],
              messages: [],
              createdAt: now,
            },
          ],
        };
      if (id === "rename") {
        await new Promise((r) => setTimeout(r, 800));
        if (input.name === "error") throw new Error("Fixture save failed");
        roomName = input.name;
        return { renamed: true };
      }
      throw new Error("Fixture only supports read/rename");
    },
  },
  navigation: { navigate: () => {} },
};
function Fixture() {
  const [values, setValues] = useState(threads);
  const [selected, setSelected] = useState("active");
  const [showPaw, setShowPaw] = useState(false);
  const [log, setLog] = useState("");
  return (
    <div className="app-shell" style={{ "--sidebar-width": "300px" } as any}>
      <Sidebar
        triggerAdmissionId={sidebarTriggerAdmissionId(triggerSnapshot)}
        mode="projects"
        open={true}
        onClose={() => {}}
        onChangeThreadLifecycle={async () => {}}
        onChangeThreadPinned={async () => {}}
        onNewThread={() => {}}
        onAddProject={() => {}}
        onRemoveProject={() => {}}
        onSetDefaultProject={() => {}}
        onOpenContribution={() => {}}
        onOpenSettings={() => {}}
        onRetryThreads={() => {}}
        onRenameThread={async (id, title) => {
          await new Promise((r) => setTimeout(r, 800));
          if (title === "error") throw new Error("Fixture save failed");
          setValues((v) =>
            v.map((t) => (t.threadId === id ? { ...t, name: title } : t)),
          );
          setLog("已保存：" + id + " → " + title);
        }}
        onSelectThread={(id) => {
          setSelected(id);
          setShowPaw(false);
        }}
        roomConversations={{
          rooms: [
            {
              id: "paw",
              name: "PAW · 产品与工程",
              assistant: { threadId: "active", triggerId: "a" },
              members: [{ name: "PAW", threadId: "active" }],
              memberCount: 1,
              messagePreview: "刚刚整理了新的设计反馈",
              unreadCount: 3,
            },
            {
              id: "team",
              name: "工程讨论室",
              members: [],
              memberCount: 4,
              messagePreview: "集成与回归有新消息",
              unreadCount: 12,
            },
          ],
          error: null,
          loading: false,
        }}
        pendingApprovalThreadIds={new Set()}
        pluginContributions={
          [
            {
              pluginId: "zenx-triggers",
              id: "triggers",
              key: "triggers",
              title: "自动化",
              icon: "clock",
              page: {
                id: "triggers",
                route: "/plugins/zenx-triggers/triggers",
                pluginId: "zenx-triggers",
                title: "自动化",
              },
            },
          ] as any
        }
        selectedPage="agent"
        selectedThreadId={selected}
        serverStatus={{ type: "ready" } as any}
        liveThread={null}
        threadError={null}
        threadLoading={false}
        projects={{
          projects: [
            {
              key: "/Projects/Zen",
              workspace: "/Projects/Zen",
              name: "Zen",
              configured: true,
              isDefault: true,
              threadIds: values.map((t) => t.threadId),
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: "/Projects/Zen",
        }}
        pinnedThreads={[]}
        threads={values as any}
        unreadThreadIds={new Set(["unread"])}
      />
      <main
        className="workspace"
        style={{
          padding: 32,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <header>
          <p style={{ color: "var(--text-3)", fontSize: 12 }}>
            真实 Sidebar / RoomsPage 组件 · 合成数据 · 无真实 Host 写入
            <br />
            模拟基准：{new Date(now).toISOString()} · 显示时区：
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </p>
          <h1>让标题先说话</h1>
          <p>
            正常状态保留自动化与运行提示。移到线程可查看完整信息，点击完整名称直接改名。
          </p>
          <button type="button" onClick={() => setShowPaw(!showPaw)}>
            验证 PAW Enter 改名
          </button>
          <p role="status">{log}</p>
        </header>
        {showPaw ? (
          <div style={{ flex: 1, minHeight: 0 }}>
            <RoomsPage sdk={sdk} />
          </div>
        ) : (
          <section>
            <p>试试左侧正在运行、有未读回复、定时触发、暂停和未知状态。</p>
            <p>
              键盘聚焦线程，按 → 进入详情；Esc 关闭。名称输入 error
              可验证错误反馈。
            </p>
            <p>
              预览不代表 Electron
              原生验收。未读点是展示用测试值，实际游标链单独验证。
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
