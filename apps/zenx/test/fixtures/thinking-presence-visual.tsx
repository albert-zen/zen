/** Synthetic production ThreadView probe. No real user data, provider or Host calls. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import { applyNativeThreadEvent } from "../../src/renderer/src/thread-view-state.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import {
  runtimeThread,
  runtimeCommand,
  runtimeMessage,
} from "./agent-runtime-data.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") ?? "zh-CN");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
let initial = runtimeThread([], "inProgress", "synthetic-thinking");
initial.turns[0]!.items = [
  {
    type: "userMessage",
    id: "user-thinking",
    clientId: null,
    content: [
      {
        type: "text",
        text: "验证思考项显示：有摘要显示摘要，没有摘要也保留思考项。",
        text_elements: [],
      },
    ],
  },
];
function addReasoning(id: string, summary?: string, publicContent?: string) {
  initial = applyNativeThreadEvent(initial, {
    type: "item_completed",
    item: {
      type: "reasoning",
      id,
      threadId: initial.id,
      turnId: initial.turns[0]!.id,
      createdAt: "2026-11-04T00:00:00.000Z",
      contentVisibility: publicContent ? "public" : "opaque",
      reasoningContent:
        publicContent ?? "synthetic-opaque-payload-must-never-display",
      ...(summary ? { summary } : {}),
    },
  });
}
addReasoning("opaque-a");
addReasoning("opaque-b");
initial.turns[0]!.items.push(runtimeCommand("tool-a", "检查项目文件"));
addReasoning("opaque-summary", "核对调用记录与保存的会话内容");
initial.turns[0]!.items.push(runtimeCommand("tool-b", "运行回归测试"));
addReasoning("opaque-c");
addReasoning(
  "public-content",
  "验证公开摘要与可展开正文",
  "这是提供方明确公开的合成推理正文。加密内容从未作为可读文本显示。",
);
function Preview() {
  const [thread, setThread] = useState(initial);
  Object.assign(window, {
    thinkingProbe: {
      finish() {
        setThread({
          ...initial,
          turns: [
            {
              ...initial.turns[0]!,
              status: "completed",
              completedAt: 12,
              items: [
                ...initial.turns[0]!.items,
                runtimeMessage(
                  "result",
                  "验证完成：每条思考记录均按原顺序保留。",
                ),
              ],
            },
          ],
        });
      },
    },
  });
  return (
    <div
      className="agent-surface"
      style={{ gridTemplateRows: "minmax(0, 1fr)" }}
    >
      <ThreadView
        approvals={[]}
        composer={emptyComposerState()}
        thread={thread}
        onDraftChange={() => {}}
        onInterrupt={async () => {}}
        onRespondToApproval={async () => {}}
        onSubmit={async () => {}}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
