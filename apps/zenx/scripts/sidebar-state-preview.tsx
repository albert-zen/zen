/** Actual sidebar/controller components; synthetic state/resource ports only. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { useThreadSidebar } from "../src/renderer/src/use-thread-sidebar.js";
import { WorkspaceFileDrafts } from "../src/renderer/src/workspace-file-drafts.js";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  applySidebarPatch,
  emptySidebarState,
  sidebarOwnerKey,
  sidebarTabId,
  type SidebarOwner,
  type ThreadSidebarApi,
  type ThreadSidebarState,
  type ThreadSidebarUpdate,
} from "../src/thread-sidebar-state.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
const values = new Map<string, ThreadSidebarState>();
const listeners = new Set<(state: ThreadSidebarState) => void>();
const calls: Array<{ method: string; threadId?: string }> = [];
const api: ThreadSidebarApi = {
  read: async (owner) =>
    structuredClone(
      values.get(sidebarOwnerKey(owner)) ?? emptySidebarState(owner),
    ),
  update: async (request: ThreadSidebarUpdate) => {
    const current = await api.read(request.owner);
    if (current.revision !== request.expectedRevision)
      return { applied: false, state: current };
    const state = applySidebarPatch(current, request.patch);
    values.set(sidebarOwnerKey(request.owner), state);
    for (const listener of listeners) listener(structuredClone(state));
    return { applied: true, state };
  },
  onChanged: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
Object.assign(window, {
  zenx: {
    platform: "linux",
    threadSidebar: api,
    workspaceFiles: {
      // External-open toolbar is mounted by the production file panel.
      // The catalog is synthetic and empty; no native application is launched.
      applications: async () => ({ platform: "linux", applications: {} }),
      read: async (threadId: string, path: string) => {
        calls.push({ method: "read", threadId });
        return {
          path,
          revision: "synthetic-v1",
          text: `# ${threadId === "thread-a" ? "设计任务 A" : "协作成员 B"}\n\n这个文件只在选回所属工作区、打开并选中此标签后读取。\n\n- 后台更新的是侧边栏状态，不是前台窗口。\n- 多个成员的同名文件保持各自资源归属。\n- 本页全部为 synthetic fixture，不含真实项目数据。\n`,
        };
      },
      list: async (threadId: string) => {
        calls.push({ method: "list", threadId });
        return {
          path: ".",
          entries: [{ name: "README.md", path: "README.md", kind: "file" }],
          truncated: false,
        };
      },
    },
    workspaceBrowser: {
      command: async (threadId: string, method: string) => {
        calls.push({ method, threadId });
        return [];
      },
      onChanged: () => () => {},
    },
    plugins: { executeCommand: async () => null, readHandle: async () => null },
  },
});
document.documentElement.dataset.appearance = "dark";
document.documentElement.dataset.themePreset = "graphite";
void i18n.changeLanguage("zh-CN");
const drafts = new WorkspaceFileDrafts();
let activeOwner: SidebarOwner = { kind: "thread", id: "thread-b" };
function Preview() {
  const [owner, setOwner] = useState(activeOwner);
  activeOwner = owner;
  const state = useThreadSidebar();
  const current = state.controller.get(owner) ?? emptySidebarState(owner);
  useEffect(() => {
    void state.controller.load(owner);
  }, [owner, state.controller]);
  const edit = (patch: Parameters<typeof applySidebarPatch>[1]) => {
    void state.controller.edit(owner, () => patch);
  };
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      <header
        style={{
          padding: "18px 24px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          gap: 16,
          alignItems: "center",
        }}
      >
        <strong>ZenX · 工作区状态验收</strong>
        {[
          { kind: "thread", id: "thread-a" },
          { kind: "thread", id: "thread-b" },
          { kind: "room", id: "room-shared" },
        ].map((target) => (
          <button
            key={target.id}
            data-owner={target.id}
            aria-pressed={owner.id === target.id}
            onClick={() => setOwner(target as SidebarOwner)}
          >
            {target.id === "thread-a"
              ? "设计任务 A"
              : target.id === "thread-b"
                ? "当前任务 B"
                : "共享聊天室"}
          </button>
        ))}
        <span style={{ marginLeft: "auto", opacity: 0.7 }}>
          Synthetic · 实际组件与样式
        </span>
      </header>
      <main
        style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}
      >
        <section style={{ padding: 36, flex: 1 }}>
          <h2>
            {owner.id === "thread-b"
              ? "继续查看任务 B"
              : owner.kind === "room"
                ? "共享聊天室"
                : "设计任务 A"}
          </h2>
          <p>后台操作不会把你切走，也不会抢焦点。</p>
          <p>
            当前状态 revision {current.revision} ·{" "}
            {current.open ? "右栏已展开" : "右栏已收起"}
          </p>
          <p style={{ opacity: 0.65 }}>消息内容与侧边栏展示状态相互独立。</p>
        </section>
        <AuxiliaryPanel
          key={sidebarOwnerKey(owner)}
          title={owner.id}
          {...(owner.kind === "thread"
            ? { threadId: owner.id }
            : {
                conversationContext: {
                  kind: "room" as const,
                  roomId: owner.id,
                  resourceThreads: [
                    {
                      threadId: "thread-a",
                      title: "成员 A",
                      workspacePath: "/synthetic/a",
                    },
                    {
                      threadId: "thread-b",
                      title: "成员 B",
                      workspacePath: "/synthetic/b",
                    },
                  ],
                },
              })}
          presentationState={current}
          open={current.open}
          onOpenChange={(open) => edit({ open })}
          snapshot={null}
          fileDrafts={drafts}
          selectedTab={current.selectedTab ?? ""}
          openedTabs={current.tabs.map(sidebarTabId)}
          onTabsChange={() => {}}
          onSelectTab={(selectedTab) => edit({ selectedTab })}
          onFullscreenChange={(fullscreen) => edit({ fullscreen })}
        />
      </main>
    </div>
  );
}
Object.assign(window, {
  __sidebarFixture: {
    background: () =>
      api.update({
        owner: { kind: "thread", id: "thread-a" },
        expectedRevision: 0,
        patch: {
          open: true,
          tabs: [{ kind: "file", path: "README.md" }],
          selectedTab: "file:README.md",
        },
      }),
    room: () =>
      api.update({
        owner: { kind: "room", id: "room-shared" },
        expectedRevision: 0,
        patch: {
          open: true,
          tabs: [
            { kind: "file", path: "README.md", resourceThreadId: "thread-a" },
            { kind: "file", path: "README.md", resourceThreadId: "thread-b" },
          ],
          selectedTab: "file:@thread-b:README.md",
        },
      }),
    measure: () => ({
      owner: activeOwner,
      states: [...values.values()],
      calls: [...calls],
    }),
  },
});
createRoot(document.getElementById("root")!).render(<Preview />);
