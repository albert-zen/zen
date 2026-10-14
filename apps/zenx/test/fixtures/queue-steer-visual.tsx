import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import { Icon } from "../../src/renderer/src/icons.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import {
  runtimeMessage,
  runtimeThread,
  runtimeTask,
} from "./agent-runtime-data.js";
import {
  applyQueueItem,
  queueItem,
  cancelQueueFact,
  editQueueFact,
} from "./agent-queue-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { Thread } from "../../src/protocol-client/index.js";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
const zh = params.get("lang") !== "en";
void i18n.changeLanguage(zh ? "zh-CN" : "en");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const idle = params.has("idle");
const title = zh ? "发布前检查" : "Release checks";
let initial: Thread = {
  ...runtimeThread(
    [
      {
        type: "userMessage",
        id: "synthetic-user",
        clientId: null,
        content: [
          {
            type: "text",
            text: zh
              ? "帮我检查这次更新的消息投递和输入区交互。"
              : "Check message delivery and composer interactions before this release.",
            text_elements: [],
          },
        ],
      },
      runtimeMessage(
        "synthetic-response",
        zh
          ? "已经确认默认消息会在安全节点加入当前执行。\n\n接下来检查两件事：\n- 明确选择排队的消息，保持等待下一轮\n- 现有排队消息可以立即引导，且不丢失来源或附件\n\n正在验证并发投递和键盘操作。"
          : "Default messages join active work at a safe point.\n\nI’m checking two paths:\n- Explicitly queued messages wait until the current turn finishes\n- A queued message can steer now while retaining its source and attachments\n\nChecking concurrent delivery and keyboard interactions.",
      ),
      runtimeTask(
        "synthetic-check",
        "synthetic-task",
        idle ? "completed" : "running",
      ),
    ],
    idle ? "completed" : "inProgress",
  ),
  id: "runtime-thread",
  name: title,
  cwd: "/synthetic/workspace-demo",
};
initial = applyQueueItem(initial, {
  id: "synthetic-thread-message",
  clientId: "synthetic-thread-client",
  threadId: initial.id,
  type: "thread_message_queued",
  createdAt: "2026-10-14T06:00:00.000Z",
  deliveryMode: "batch-next",
  messageType: "follow_up",
  sender: {
    threadId: "synthetic-planner",
    threadName: zh ? "计划助手" : "Planning assistant",
    toolCallId: "synthetic-tool",
    callId: "synthetic-call",
  },
  input: [
    {
      type: "text",
      text: zh
        ? "再检查窄屏布局和键盘焦点。保留检查结果，暂时不要发布。"
        : "Check the narrow layout and keyboard focus too. Keep the findings; don’t publish yet.",
    },
  ],
});
if (params.has("many"))
  initial = applyQueueItem(
    initial,
    queueItem(1, [
      {
        type: "text",
        text: zh
          ? "最后补一份简短的验证结论，说明哪些行为已经通过。"
          : "Finish with a short summary of verified behaviors.",
      },
    ]),
  );
const summaries: NativeThreadSummary[] = [
  title,
  zh ? "计划助手" : "Planning assistant",
  zh ? "设计检查" : "Design review",
].map((name, index) => ({
  threadId: index === 0 ? initial.id : `synthetic-${index}`,
  title: name,
  preview: name,
  createdAt: "2026-10-14T06:00:00Z",
  updatedAt: "2026-10-14T06:00:00Z",
  status: index === 0 && !idle ? "inProgress" : "idle",
  currentMetadata: {
    cwd: "/synthetic/workspace-demo",
    provider: "openai",
    model: "demo-model",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  },
}));
(window as any).zenx = {
  triggers: { list: async () => [] },
  plugins: { executeCommand: async () => null },
};
function Fixture() {
  const [thread, setThread] = useState(initial);
  const [composer, setComposer] = useState(emptyComposerState());
  const narrow = params.has("narrow");
  return (
    <div className={`app-shell${narrow ? " sidebar-collapsed" : ""}`}>
      <header className="window-titlebar">
        <div className="window-titlebar-product">
          <span style={{ paddingLeft: 18, fontWeight: 650 }}>ZenX</span>
        </div>
        <div
          style={{
            paddingInline: 16,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--color-text-secondary)",
          }}
        >
          workspace-demo <Icon name="chevron-right" /> {title}
        </div>
      </header>
      <Sidebar
        mode="projects"
        open={false}
        collapsed={narrow}
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
        onRenameThread={async () => {}}
        onSelectThread={() => {}}
        pendingApprovalThreadIds={new Set()}
        pluginContributions={[]}
        selectedPage="agent"
        selectedThreadId={thread.id}
        serverStatus={{ type: "ready", reconnected: false }}
        liveThread={thread}
        threadError={null}
        threadLoading={false}
        projects={{
          projects: [
            {
              key: "/synthetic/workspace-demo",
              workspace: "/synthetic/workspace-demo",
              name: "workspace-demo",
              configured: true,
              isDefault: true,
              threadIds: summaries.map((value) => value.threadId),
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: "/synthetic/workspace-demo",
        }}
        pinnedThreads={[]}
        threads={summaries}
      />
      <main className="workspace">
        <section className="agent-surface">
          <ThreadReadingStateProvider>
            <ThreadView
              thread={thread}
              composer={composer}
              approvals={[]}
              composerSendMode="soft"
              onDraftChange={(text) =>
                setComposer((value) => ({
                  ...value,
                  draft: { ...value.draft, text },
                }))
              }
              onInterrupt={async () => {}}
              onRespondToApproval={async () => {}}
              onSubmit={async () => {}}
              onSteerQueued={async (target) => {
                await new Promise((resolve) => setTimeout(resolve, 700));
                if (params.has("error"))
                  throw new Error(
                    zh
                      ? "尚未确认送达。请检查连接并刷新后重试。"
                      : "Delivery is unconfirmed. Check the connection and refresh.",
                  );
                const original = thread.canonicalItems!.find(
                  (item) => item.id === target.queuedItemId,
                )!;
                if (original.type === "thread_message_queued")
                  setThread((value) =>
                    applyQueueItem(value, {
                      type: "thread_message",
                      id: "delivered-thread",
                      threadId: target.threadId,
                      turnId: "runtime-turn",
                      createdAt: new Date().toISOString(),
                      clientId: target.clientId,
                      sender: original.sender,
                      messageType: original.messageType,
                      mode: "steer",
                      content: original.input,
                    }),
                  );
                else if (original.type === "user_message_queued")
                  setThread((value) =>
                    applyQueueItem(value, {
                      type: "user_message",
                      id: "delivered-user",
                      threadId: target.threadId,
                      turnId: "runtime-turn",
                      createdAt: new Date().toISOString(),
                      clientId: target.clientId,
                      content: original.input,
                    }),
                  );
                return { ...target, status: "steered", turnId: "runtime-turn" };
              }}
              onCancelQueued={async (targets) => {
                setThread((value) =>
                  targets.reduce(
                    (result, target) =>
                      cancelQueueFact(
                        result,
                        target.queuedItemId,
                        target.clientId,
                      ),
                    value,
                  ),
                );
                return {
                  results: targets.map((target) => ({
                    ...target,
                    status: "cancelled",
                  })),
                };
              }}
              onEditQueued={async (target) => {
                setThread((value) => editQueueFact(value, target));
                return {
                  ...target,
                  status: "edited",
                  revision: target.expectedRevision + 1,
                  editItemId: "synthetic-edit",
                };
              }}
            />
          </ThreadReadingStateProvider>
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
