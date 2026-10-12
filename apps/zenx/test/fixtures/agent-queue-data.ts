import type {
  CanonicalItem,
  QueuedUserMessageItem,
  UserInput,
} from "../../../../src/item.js";
import type { Thread } from "../../src/protocol-client/index.js";
import { applyNativeThreadEvent } from "../../src/renderer/src/thread-view-state.js";
import {
  runtimeIntro,
  runtimeMessage,
  runtimeTask,
  runtimeThread,
} from "./agent-runtime-data.js";
export const queueScenes = [
  "两条消息",
  "单条消息",
  "长消息与图片",
  "多条消息",
  "发送失败",
  "等待继续",
  "审批与排队",
  "隐藏行失败",
];
const attachment = {
  type: "image",
  attachment: {
    type: "attachment",
    sha256: "0".repeat(64),
    mediaType: "image/png",
    byteLength: 68,
    width: 1,
    height: 1,
  },
} as const;
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
            [{ type: "text", text: longQueueText }, attachment, attachment],
            [attachment],
          ]
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
  const queued = thread.canonicalItems?.find(
    (x): x is QueuedUserMessageItem =>
      x.type === "user_message_queued" && x.id === head.id,
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
