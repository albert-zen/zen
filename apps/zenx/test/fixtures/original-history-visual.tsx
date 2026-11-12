import React from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { emptyComposerState } from "../../src/renderer/src/composer-state.js";
import type { Thread } from "../../src/protocol-client/index.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import {
  readOriginalThreadHistory,
  type OriginalHistoryOptions,
} from "../../../../src/thread-history.js";
import type { ThreadSnapshot } from "../../../../src/app-server.js";
import type {
  CanonicalItem,
  ContextCompactionItem,
} from "../../../../src/item.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
await i18n.changeLanguage("zh-CN");
const originalBase = {
  threadId: "synthetic-thread",
  turnId: "turn-1",
  createdAt: "2026-10-14T06:00:00Z",
};
const original: CanonicalItem[] = [
  {
    ...originalBase,
    id: "user-1",
    type: "user_message",
    content: [
      { type: "text", text: "请把压缩后的原始历史入口接通，并保留所有原文。" },
    ],
  },
  {
    ...originalBase,
    id: "tool-result-2",
    type: "tool_result",
    output:
      "Synthetic test output\n206 tests passed. Original tool text remains unchanged.",
    callId: "call-2",
    exitCode: 0,
  },
  {
    ...originalBase,
    id: "assistant-3",
    type: "agent_message",
    text: "模型读取与界面入口已接通。下一步检查窄屏和分页。",
  },
];
const item: ContextCompactionItem = {
  id: "compact-4",
  type: "context_compaction",
  provenance: "agentic",
  threadId: "synthetic-thread",
  turnId: "turn-1",
  callId: "compact-call",
  sourceModelResponseId: "response-1",
  createdAt: "2026-10-14T06:01:00Z",
  coveredThroughItemId: "assistant-3",
  summary:
    "保留原始历史的逻辑引用，可按准确边界读取完整公开条目。继续完成界面验证。",
  retainedItemIds: [],
  algorithmVersion: "test",
  includeOriginalReference: true,
};
const snapshot = {
  id: item.threadId,
  cwd: "/synthetic",
  items: [...original, item],
} as unknown as ThreadSnapshot;
Object.assign(window, {
  zenx: {
    protocol: {
      request: async (
        _method: string,
        request: OriginalHistoryOptions & { threadId: string },
      ) => {
        const { threadId: _threadId, ...options } = request;
        return readOriginalThreadHistory(snapshot, options);
      },
    },
  },
});
const thread = {
  id: item.threadId,
  sessionId: item.threadId,
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  isPinned: false,
  modelProvider: "fake",
  createdAt: Date.parse("2026-10-14T06:00:00Z") / 1000,
  updatedAt: Date.parse("2026-10-14T06:01:00Z") / 1000,
  recencyAt: null,
  status: { type: "idle" },
  path: null,
  cwd: "/synthetic",
  cliVersion: "fixture",
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "压缩后的历史读取",
  canonicalItems: snapshot.items,
  turns: [
    {
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: Date.parse("2026-10-14T06:00:00Z") / 1000,
      completedAt: Date.parse("2026-10-14T06:01:00Z") / 1000,
      durationMs: 1,
      items: [
        {
          id: "user-1",
          type: "userMessage",
          content: [
            {
              type: "text",
              text: "请把压缩后的原始历史入口接通，并保留所有原文。",
            },
          ],
        },
        {
          id: "assistant-3",
          type: "agentMessage",
          text: "模型读取与界面入口已接通。下一步检查窄屏和分页。",
        },
      ],
    },
  ],
} as Thread;
const noop = async () => {};
createRoot(document.getElementById("root")!).render(
  <main
    style={{
      height: "100vh",
      display: "grid",
      gridTemplateRows: "auto minmax(0, 1fr)",
      maxWidth: params.has("narrow") ? 420 : 1000,
      margin: "auto",
      padding: "16px",
    }}
  >
    <header style={{ marginBottom: 12 }}>
      <h2>压缩后的历史读取</h2>
      <p>Synthetic QA · actual ThreadView</p>
    </header>
    <ThreadView
      thread={thread}
      composer={emptyComposerState()}
      approvals={[]}
      onDraftChange={() => {}}
      onInterrupt={noop}
      onRespondToApproval={noop}
      onSubmit={noop}
    />
  </main>,
);
