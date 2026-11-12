import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { MessageSourceNavigationContext } from "../../src/renderer/src/message-source-navigation.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import { Icon } from "../../src/renderer/src/icons.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { requestQueuedSteer } from "../../src/renderer/src/queue-steer-request.js";
import { requestQueuedReorder } from "../../src/renderer/src/queue-reorder-request.js";
import { createQueueMutationStore } from "../../src/renderer/src/queue-mutation-state.js";
import {
  createSteerRecallStore,
  restoreRecalledComposer,
} from "../../src/renderer/src/steer-recall-state.js";
import {
  pendingSteerMessages,
  recoverSteerRecall,
} from "../../../../src/steer-recall.js";
import {
  parseUserQuestionSpecification,
  renderUserQuestionReply,
} from "../../../../src/user-question.js";
import { referenceMessage } from "../../src/renderer/src/reference-draft.js";
import {
  queueImageAttachments,
  readQueueFixtureImage,
} from "./agent-queue-images.js";
import type { CanonicalItem } from "../../../../src/item.js";
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
initial = applyQueueItem(initial, {
  ...queueItem(7, [
    {
      type: "text",
      text: zh
        ? "等一下，先把 390px 窄窗的截图补上，再继续后面的检查。"
        : "Wait — add the 390px narrow-window screenshots before continuing.",
    },
  ]),
  deliveryMode: "steer",
  expectedTurnId: "runtime-turn",
});
initial = applyQueueItem(initial, {
  ...queueItem(8, [
    {
      type: "text",
      text: zh
        ? "还有，深色下问题卡和待发送区域也一起看一遍。"
        : "Also review the question card and pending area in dark mode.",
    },
  ]),
  deliveryMode: "steer",
  expectedTurnId: "runtime-turn",
});
if (params.has("many")) {
  for (let index = 1; index <= 5; index++)
    initial = applyQueueItem(
      initial,
      queueItem(index, [
        {
          type: "text",
          text: zh
            ? `第 ${index} 项：补齐验证结论，保留草稿，不要发布。`
            : `Check ${index}: preserve the draft and report the verified results without publishing.`,
        },
      ]),
    );
}
if (params.has("rich")) {
  const specification = parseUserQuestionSpecification({
    questions: [
      {
        id: "scope",
        prompt: zh
          ? "这次需要检查哪些部分？"
          : "Which areas should be checked?",
        options: [
          { id: "layout", label: zh ? "窄窗布局" : "Narrow layout" },
          { id: "delivery", label: zh ? "消息投递" : "Message delivery" },
        ],
        multiSelect: true,
      },
    ],
  });
  const reply = {
    version: 1 as const,
    outcome: "answer" as const,
    request: { threadId: initial.id, callItemId: "synthetic-question" },
    answers: [
      {
        questionId: "scope",
        optionIds: ["layout", "delivery"],
        text: zh
          ? "保留 **原文**，不发布。"
          : "Keep **literal text**. Do not publish.",
      },
    ],
  };
  initial = applyQueueItem(initial, {
    type: "tool_call",
    id: "synthetic-question",
    threadId: initial.id,
    turnId: "runtime-turn",
    createdAt: "2026-11-08T00:00:00Z",
    callId: "synthetic-question-rpc",
    name: "ask_user_question",
    arguments: specification as unknown as Record<string, unknown>,
  });
  initial = applyQueueItem(initial, {
    ...queueItem(20, [
      { type: "text", text: renderUserQuestionReply(specification, reply) },
      { type: "image", attachment: queueImageAttachments[0] },
    ]),
    questionReply: reply,
    deliveryMode: "steer",
    expectedTurnId: "runtime-turn",
  });
  initial = applyQueueItem(
    initial,
    queueItem(21, [
      {
        type: "text",
        text: referenceMessage(
          zh
            ? "对比 **这份结果**，确认图片后再处理。"
            : "Compare **these findings** and check the images first.",
          [
            {
              kind: "thread",
              id: "synthetic-planner",
              name: zh ? "计划助手" : "Planning assistant",
              cwd: initial.cwd!,
            },
          ],
          "queue-client-21",
        ),
      },
      ...queueImageAttachments
        .slice(1, 3)
        .map((attachment) => ({ type: "image" as const, attachment })),
    ]),
  );
}
const summaries: NativeThreadSummary[] = [
  title,
  zh ? "计划助手" : "Planning assistant",
  zh ? "设计检查" : "Design review",
].map((name, index) => ({
  threadId:
    index === 0
      ? initial.id
      : index === 1
        ? "synthetic-planner"
        : `synthetic-${index}`,
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
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const [queueMutationStore] = useState(createQueueMutationStore);
  const [steerRecallStore] = useState(createSteerRecallStore);
  const append = (item: CanonicalItem) => {
    const updated = applyQueueItem(threadRef.current, item);
    threadRef.current = updated;
    setThread(updated);
    return updated;
  };
  (window as any).zenx.protocol = {
    request: async (method: string, target: any) => {
      if (method === "zen/thread/read") {
        if (params.has("unknown"))
          throw new Error("Synthetic recovery read unavailable");
        return {
          thread: { id: initial.id, items: threadRef.current.canonicalItems },
        };
      }
      if (method === "zen/thread/steer/recall") {
        const pending = pendingSteerMessages(threadRef.current.canonicalItems!);
        if (
          !target.targets.every((expected: any) =>
            pending.some(
              (item) =>
                item.id === expected.queuedItemId &&
                item.clientId === expected.clientId &&
                item.revision === expected.expectedRevision,
            ),
          )
        )
          throw { data: { zenCode: "steer_recall_conflict" } };
        const receipt = {
          type: "user_message_steer_recalled" as const,
          id: crypto.randomUUID(),
          threadId: initial.id,
          createdAt: new Date().toISOString(),
          recallId: target.recallId,
          targets: target.targets,
        };
        const updated = append(receipt);
        return {
          ...recoverSteerRecall(
            updated.canonicalItems!,
            initial.id,
            target.recallId,
          ),
          status: "recalled",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (params.has("error"))
        throw {
          data: {
            zenCode: method.endsWith("/reorder")
              ? "queue_reorder_conflict"
              : "queue_revision_conflict",
          },
        };
      if (params.has("unknown"))
        throw new Error("Synthetic connection lost; outcome unknown");
      if (method === "zen/thread/queue/reorder") {
        const receipt = {
          type: "user_message_queue_reordered" as const,
          id: crypto.randomUUID(),
          threadId: target.threadId,
          createdAt: new Date().toISOString(),
          reorderId: target.reorderId,
          expectedTargets: target.expectedTargets,
          orderedQueuedItemIds: target.orderedQueuedItemIds,
        };
        append(receipt);
        if (params.has("lostack"))
          throw new Error("Synthetic ACK lost after canonical reorder");
        return { status: "reordered", reorderItemId: receipt.id };
      }
      if (method === "zen/thread/queue/steer") {
        const original = threadRef.current.canonicalItems!.find(
          (item) => item.id === target.queuedItemId,
        )!;
        if (original.type === "user_message_queued" && !idle) {
          const receipt = {
            type: "user_message_queue_promoted" as const,
            id: crypto.randomUUID(),
            threadId: target.threadId,
            createdAt: new Date().toISOString(),
            queuedItemId: target.queuedItemId,
            clientId: target.clientId,
            expectedRevision: target.expectedRevision,
            expectedTurnId: "runtime-turn",
          };
          append(receipt);
          if (params.has("lostack"))
            throw new Error("Synthetic ACK lost after canonical promotion");
          return {
            queuedItemId: target.queuedItemId,
            clientId: target.clientId,
            status: "staged",
            turnId: "runtime-turn",
            revision: target.expectedRevision + 1,
            promotionItemId: receipt.id,
          };
        }
        if (original.type === "thread_message_queued")
          append({
            type: "thread_message",
            id: crypto.randomUUID(),
            threadId: target.threadId,
            turnId: "runtime-turn",
            createdAt: new Date().toISOString(),
            clientId: target.clientId,
            sender: original.sender,
            messageType: original.messageType,
            mode: "steer",
            content: original.input,
          });
        else if (original.type === "user_message_queued")
          append({
            type: "user_message",
            id: crypto.randomUUID(),
            threadId: target.threadId,
            turnId: "runtime-turn",
            createdAt: new Date().toISOString(),
            clientId: target.clientId,
            content: original.input,
          });
        return {
          queuedItemId: target.queuedItemId,
          clientId: target.clientId,
          status: idle ? "started" : "steered",
          turnId: "runtime-turn",
        };
      }
      return {};
    },
  };
  const [selectedThreadId, setSelectedThreadId] = useState(initial.id);
  const sourceThread: Thread = {
    ...runtimeThread(
      [
        runtimeMessage(
          "synthetic-source-message",
          zh
            ? "这条来源会话明确要求下一轮检查。普通线程消息仍默认 soft steer。"
            : "This source explicitly requested a follow-up check. Ordinary thread messages still default to soft steer.",
        ),
      ],
      "completed",
    ),
    id: "synthetic-planner",
    name: zh ? "计划助手" : "Planning assistant",
    cwd: initial.cwd,
  };
  const view = selectedThreadId === initial.id ? thread : sourceThread;
  const [composer, setComposer] = useState(() => ({
    ...emptyComposerState(),
    ...(params.has("local")
      ? {
          pendingSends: [
            {
              clientId: "synthetic-local",
              intent: "start" as const,
              status: "unconfirmed" as const,
              error: "Synthetic transport outcome unknown",
              draft: {
                text: zh
                  ? "普通消息尚未确认，检查后再继续。"
                  : "An ordinary send has not been confirmed.",
                images: [],
              },
            },
          ],
        }
      : {}),
  }));
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
          workspace-demo <Icon name="chevron-right" /> {view.name}
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
        onSelectThread={(id) => {
          if (id === initial.id || id === sourceThread.id)
            setSelectedThreadId(id);
        }}
        pendingApprovalThreadIds={new Set()}
        pluginContributions={[]}
        selectedPage="agent"
        selectedThreadId={view.id}
        serverStatus={{ type: "ready", reconnected: false }}
        liveThread={view}
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
          <MessageSourceNavigationContext.Provider
            value={async (target, owner) => {
              if (!owner.isCurrent() || owner.threadId !== initial.id) return;
              if (
                target.kind !== "thread" ||
                target.id !== sourceThread.id ||
                target.deviceId
              )
                throw new Error("Synthetic source target is unavailable");
              setSelectedThreadId(sourceThread.id);
            }}
          >
            <ThreadReadingStateProvider>
              <ThreadView
                key={view.id}
                thread={view}
                composer={
                  view.id === initial.id ? composer : emptyComposerState()
                }
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
                queueMutationStore={queueMutationStore}
                steerRecallStore={steerRecallStore}
                onSteerQueued={requestQueuedSteer}
                onReorderQueued={requestQueuedReorder}
                onReadAttachment={readQueueFixtureImage}
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
                onRestoreRecalled={async (result) => {
                  setComposer((current) =>
                    restoreRecalledComposer(current, result, () =>
                      crypto.randomUUID(),
                    ),
                  );
                  return true;
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
          </MessageSourceNavigationContext.Provider>
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
