import type {
  CanonicalItem,
  QueuedUserMessageItem,
  UserInput,
} from "../../../../src/item.js";
import type { Thread } from "../../src/protocol-client/index.js";
import type { NativeQueueEditParams } from "../../../../src/protocol/native/wire.js";
import { pendingQueuedMessages } from "../../../../src/input-queue.js";
import { applyNativeThreadEvent } from "../../src/renderer/src/thread-view-state.js";
import {
  runtimeIntro,
  runtimeMessage,
  runtimeTask,
  runtimeThread,
} from "./agent-runtime-data.js";
import {
  queueImageAttachments,
  missingQueueImage,
} from "./agent-queue-images.js";
export const queueScenes = [
  "两条消息",
  "单条消息",
  "长消息与图片",
  "多条消息",
  "发送失败",
  "等待继续",
  "审批与排队",
  "隐藏行失败",
  "多张真实测试图片",
  "图片读取失败",
];
const imageInput = (index: number) => ({
  type: "image" as const,
  attachment: queueImageAttachments[index]!,
});
export const longQueueText =
  "请保留当前检查结果，然后逐项检查输入区上方的排队消息：\n1. 单条消息与多条消息的顺序清楚。\n2. 长消息能完整阅读，附件数量不会被正文遮住。\n3. 取消操作失败时保留原消息，也保留我正在输入的草稿。\n最后给出窄屏与键盘交互的验证结论，不要发布或部署。";
export function queueItem(
  index: number,
  input: UserInput,
): QueuedUserMessageItem {
  return {
    type: "user_message_queued",
    id: `queue-${index}`,
    clientId: `queue-client-${index}`,
    threadId: "runtime-thread",
    createdAt: new Date(Date.now() + index).toISOString(),
    input,
  };
}
export function applyQueueItem(thread: Thread, item: CanonicalItem): Thread {
  return applyNativeThreadEvent(thread, { type: "item_completed", item });
}
export function queueScenario(scene: number): Thread {
  const idle = scene === 4 || scene === 5;
  let thread = runtimeThread(
    [
      ...runtimeIntro.slice(0, 1),
      runtimeMessage(
        "queue-intro",
        idle
          ? "当前检查已结束。待发送消息仍保留在下方，可以继续处理。"
          : "我会并行读取组件、检查页面，并运行验证。",
      ),
      runtimeTask("queue-check", "queue-task", idle ? "completed" : "running"),
    ],
    idle ? "completed" : "inProgress",
  );
  const short = [
    "完成当前检查后，总结已经确认的问题。",
    "再检查窄屏布局和键盘焦点，先不要修改代码。",
  ];
  const many = [
    short[0]!,
    short[1]!,
    longQueueText,
    "最后附上修改前后的对比。",
    "保留草稿，并检查附件数量。",
    "整理一份简短的验证结论。",
  ];
  const inputs: UserInput[] =
    scene === 1
      ? [[{ type: "text", text: short[0]! }]]
      : scene === 2
        ? [
            [
              { type: "text", text: longQueueText },
              imageInput(0),
              imageInput(1),
            ],
            [imageInput(2)],
          ]
        : scene === 8
          ? [
              [
                {
                  type: "text",
                  text: "比较这些本地生成的测试图，保留原始顺序。",
                },
                ...queueImageAttachments.map((attachment) => ({
                  type: "image" as const,
                  attachment,
                })),
              ],
              [imageInput(2)],
            ]
          : scene === 9
            ? [
                [
                  {
                    type: "text",
                    text: "这张测试图片当前无法读取；保留待发送消息。",
                  },
                  { type: "image", attachment: missingQueueImage },
                ],
                [imageInput(1)],
              ]
            : scene === 6
              ? short.map((text, index) => [
                  { type: "text" as const, text },
                  imageInput(index),
                ])
              : scene === 3 || scene === 7
                ? many.map((text) => [{ type: "text", text }])
                : short.map((text) => [{ type: "text", text }]);
  inputs.forEach((input, index) => {
    thread = applyQueueItem(thread, queueItem(index, input));
  });
  return thread;
}
export function cancelQueueFact(
  thread: Thread,
  id: string,
  clientId: string,
): Thread {
  return applyQueueItem(thread, {
    type: "user_message_queue_cancelled",
    id: `cancel-${id}`,
    threadId: thread.id,
    createdAt: new Date().toISOString(),
    queuedItemId: id,
    clientId,
  });
}
export function drainQueueHead(thread: Thread): Thread {
  const head = thread.queuedMessages?.[0];
  if (!head) return thread;
  const queued = pendingQueuedMessages(thread.canonicalItems ?? []).find(
    (item) => item.id === head.id && item.clientId === head.clientId,
  );
  if (!queued) return thread;
  return applyQueueItem(thread, {
    type: "user_message",
    id: `accepted-${head.id}`,
    threadId: thread.id,
    turnId: "runtime-turn",
    clientId: head.clientId,
    createdAt: new Date().toISOString(),
    content: queued.input,
  });
}

/** Explicit simulated native commit; preserves queue anchor, order and client ID. */
export function editQueueFact(
  thread: Thread,
  params: NativeQueueEditParams,
): Thread {
  const current = pendingQueuedMessages(thread.canonicalItems ?? []).find(
    (item) =>
      item.id === params.queuedItemId && item.clientId === params.clientId,
  );
  if (thread.id !== params.threadId || current === undefined)
    throw Object.assign(
      new Error("这条消息已开始处理或已取消；编辑草稿仍保留。"),
      { code: "queue_already_started" },
    );
  if (current.revision !== params.expectedRevision)
    throw Object.assign(new Error("这条消息已被修改；请先检查当前版本。"), {
      code: "queue_revision_conflict",
    });
  return applyQueueItem(thread, {
    type: "user_message_queue_edited",
    id: `edit-${params.editId}`,
    threadId: thread.id,
    createdAt: new Date().toISOString(),
    queuedItemId: params.queuedItemId,
    clientId: params.clientId,
    editId: params.editId,
    revision: current.revision + 1,
    input: params.input,
  });
}
