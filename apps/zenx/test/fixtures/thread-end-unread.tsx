import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { CanonicalItem } from "../../../../src/item.js";
import type { ThreadSummary } from "../../../../src/thread-summary.js";
import type { NativeThreadRecoverySnapshot } from "../../../../src/protocol/native/recovery.js";
import { latestTurnEnd, turnEndPosition } from "../../../../src/turn-end.js";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { projectNativeRecovery } from "../../src/renderer/src/thread-view-state.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import {
  CONVERSATION_READ_KEY,
  unreadThreadIds,
  useConversationReadPreference,
} from "../../src/renderer/src/conversation-read-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/room-conversations.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = query.get("theme") ?? "light";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
void i18n.changeLanguage(query.get("lang") === "en" ? "en" : "zh-CN");
const now = Date.now();
// Synthetic, isolated browser fixture only. No Host or user profile is accessed.
window.localStorage.setItem(
  CONVERSATION_READ_KEY,
  JSON.stringify({
    baseline: now - 10000,
    threadEndBaseline: now - 10000,
    threads: {},
    rooms: {},
  }),
);
const selection = {
  providerProfileId: "fixture",
  modelId: "synthetic",
  reasoningEffort: "medium",
};
const scenarios = [
  ["working", "正在运行：工具前中间文字", "inProgress"],
  ["done", "已正常完成：尚未查看", "completed"],
  ["empty", "已正常结束：最终回复为空", "completed"],
  ["stopped", "已确认中断：尚未查看", "interrupted"],
  ["failed", "已失败停止：尚未查看", "failed"],
] as const;
function data(
  id: string,
  name: string,
  status: "inProgress" | "completed" | "interrupted" | "failed",
) {
  const common = {
    threadId: id,
    turnId: `${id}-turn`,
    createdAt: new Date(now).toISOString(),
  };
  const items: CanonicalItem[] = [
    {
      id: `${id}-metadata`,
      type: "thread_metadata",
      threadId: id,
      createdAt: new Date(now - 1000).toISOString(),
      cwd: "/synthetic/Zen",
      ...selection,
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    { ...common, id: `${id}-started`, type: "turn_started" },
    {
      ...common,
      id: `${id}-user`,
      type: "user_message",
      content: [
        { type: "text", text: "合成验收任务：验证执行结束后才出现绿点。" },
      ],
    },
  ];
  if (id === "working" || id === "done")
    items.push({
      ...common,
      id: `${id}-agent`,
      type: "agent_message",
      text:
        id === "working"
          ? "我正在检查工具结果，任务仍在运行。"
          : "检查已经完成。这是合成回复。",
    });
  if (status === "interrupted")
    items.push({
      ...common,
      id: `${id}-end`,
      type: "turn_aborted",
      reason: "Synthetic user stop",
    });
  else if (status !== "inProgress")
    items.push({ ...common, id: `${id}-end`, type: "turn_completed", status });
  const snapshot: NativeThreadRecoverySnapshot = {
    processEpoch: "synthetic",
    threadId: id,
    watermark: items.length,
    events: [],
    thread: {
      id,
      name,
      items,
      turns: [
        {
          id: common.turnId,
          items: items.slice(1),
          status,
          selection,
          model: "synthetic",
        },
      ],
      ...selection,
      model: "synthetic",
      provider: "fixture",
      cwd: "/synthetic/Zen",
      sandbox: "read-only",
      approvalPolicy: "never",
      archived: false,
    },
  };
  const end = latestTurnEnd(items);
  const summary: ThreadSummary = {
    threadId: id,
    name,
    status: status === "inProgress" ? "active" : "idle",
    archived: false,
    preview: "",
    createdAt: common.createdAt,
    updatedAt: common.createdAt,
    currentMetadata: {
      ...selection,
      model: "synthetic",
      provider: "fixture",
      cwd: "/synthetic/Zen",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    ...(end
      ? {
          lastTurnEnd: {
            id: end.id,
            turnId: end.turnId,
            createdAt: end.createdAt,
            position: turnEndPosition(items, end),
          },
        }
      : {
          lastAgentMessage: { id: `${id}-agent`, createdAt: common.createdAt },
        }),
  };
  return { summary, thread: projectNativeRecovery(snapshot) };
}
const rows = scenarios.map(([id, name, status]) => data(id, name, status));
const summaries = rows.map((row) => row.summary);
const noop = () => {};
function Fixture() {
  const [selected, setSelected] = useState("working");
  const read = useConversationReadPreference();
  const thread = rows.find((row) => row.thread.id === selected)!.thread;
  return (
    <div
      className="app-shell"
      style={{ "--sidebar-width": "320px" } as React.CSSProperties}
    >
      <Sidebar
        mode="projects"
        open
        onClose={noop}
        onChangeThreadLifecycle={async () => {}}
        onChangeThreadPinned={async () => {}}
        onNewThread={noop}
        onAddProject={noop}
        onRemoveProject={noop}
        onSetDefaultProject={noop}
        onOpenContribution={noop}
        onOpenSettings={noop}
        onRetryThreads={noop}
        onRenameThread={async () => {}}
        onSelectThread={setSelected}
        pendingApprovalThreadIds={new Set()}
        pluginContributions={[]}
        selectedPage="agent"
        selectedThreadId={selected}
        serverStatus={{ type: "ready", reconnected: false }}
        liveThread={thread}
        threadError={null}
        threadLoading={false}
        projects={{
          projects: [
            {
              key: "/synthetic/Zen",
              workspace: "/synthetic/Zen",
              name: "合成验收",
              configured: true,
              isDefault: true,
              threadIds: summaries.map((s) => s.threadId),
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: "/synthetic/Zen",
        }}
        pinnedThreads={[summaries[0]!, summaries[1]!]}
        threads={summaries}
        unreadThreadIds={unreadThreadIds(summaries, read)}
        roomConversations={{
          rooms: [
            {
              id: "room",
              name: "PAW / Room 独立消息语义",
              members: [],
              memberCount: 1,
              messagePreview: "合成未读消息",
              unreadCount: 3,
            },
          ],
          error: null,
          loading: false,
        }}
      />
      <main
        className="workspace"
        style={{ minWidth: 0, display: "flex", flexDirection: "column" }}
      >
        <header
          style={{
            padding: "20px 28px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2 style={{ margin: "0 0 6px" }}>执行结束提醒</h2>
          <p style={{ margin: 0, color: "var(--text-3)", fontSize: 13 }}>
            真实 Sidebar / ThreadView · 全部合成数据 ·
            点击结束线程并看见结尾后清点
          </p>
        </header>
        <ThreadView
          thread={thread}
          approvals={[]}
          composer={emptyComposerState()}
          onDraftChange={noop}
          onInterrupt={async () => {}}
          onRespondToApproval={async () => {}}
          onSubmit={async () => {}}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
