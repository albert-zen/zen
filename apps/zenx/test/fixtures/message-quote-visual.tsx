import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/renderer/src/Sidebar.js";
import { ThreadView } from "../../src/renderer/src/ThreadView.js";
import { ThreadReadingStateProvider } from "../../src/renderer/src/thread-reading-state.js";
import { Icon } from "../../src/renderer/src/icons.js";
import {
  editComposer,
  emptyComposerState,
  beginComposerSubmission,
  acceptComposerSubmission,
} from "../../src/renderer/src/composer-state.js";
import { parseSkillDraft } from "../../src/renderer/src/skill-draft.js";
import { referenceMessage } from "../../src/renderer/src/reference-draft.js";
import { applyNativeThreadEvent } from "../../src/renderer/src/thread-view-state.js";
import { runtimeMessage, runtimeThread } from "./agent-runtime-data.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import type { Thread } from "../../src/protocol-client/index.js";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "zh-CN");
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
const sourceText =
  "建议把执行细节留在对话里，但不要让日志成为页面的主角。\n\n完成后保留结果，具体命令和输出按需展开。\n\n选中文字后，复制不会改变输入框；引用则作为上下文，问题仍写在原来的输入框。\n\n```ts\nconst source = { threadId, messageId };\nconst excerpt = selection.toString();\n// 保留换行、缩进与准确来源\n```";
const base: Thread = {
  ...runtimeThread(
    [runtimeMessage("synthetic-answer", sourceText)],
    "completed",
    "quote-thread",
  ),
  name: "选段引用体验",
  cwd: "/synthetic/zenx",
  canonicalItems: [
    {
      type: "agent_message",
      id: "synthetic-answer",
      threadId: "quote-thread",
      turnId: "runtime-turn",
      createdAt: "2026-10-20T08:00:00Z",
      text: sourceText,
    },
  ],
};
/** The same native event projection used after an actual send. No provider is called. */
export function appendSyntheticSent(
  thread: Thread,
  text: string,
  clientId: string,
): Thread {
  const turnId = `turn-${clientId}`;
  let next = applyNativeThreadEvent(thread, {
    type: "turn_started",
    threadId: thread.id,
    turnId,
  });
  next = applyNativeThreadEvent(next, {
    type: "item_completed",
    item: {
      type: "user_message",
      id: `message-${clientId}`,
      threadId: thread.id,
      turnId,
      createdAt: "2026-10-20T08:00:01Z",
      clientId,
      content: [{ type: "text", text }],
    },
  });
  return applyNativeThreadEvent(next, {
    type: "turn_completed",
    threadId: thread.id,
    turnId,
    status: "completed",
  });
}
const initial = params.has("empty")
  ? base
  : appendSyntheticSent(
      base,
      referenceMessage(
        "这部分可以举个例子吗？",
        [
          {
            kind: "message",
            name: "ZenX",
            cwd: base.cwd,
            threadId: base.id,
            id: "synthetic-answer",
            excerpt: "按需展开",
          },
        ],
        "synthetic-example",
      ),
      "synthetic-example",
    );
const summaries: NativeThreadSummary[] = [
  "选段引用体验",
  "消息投递与队列",
  "发布前检查",
].map((title, i) => ({
  threadId: i ? `synthetic-${i}` : base.id,
  title,
  preview: title,
  createdAt: "2026-10-20T08:00:00Z",
  updatedAt: "2026-10-20T08:00:00Z",
  status: "idle",
  currentMetadata: {
    cwd: base.cwd,
    provider: "openai",
    model: "demo-model",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  },
}));
Object.assign(window, {
  zenx: {
    triggers: { list: async () => [] },
    plugins: { executeCommand: async () => null },
  },
});
function Fixture() {
  const [composer, setComposer] = useState(emptyComposerState());
  const [thread, setThread] = useState(initial);
  const counter = useRef(0);
  const sending = useRef(false);
  const [sent, setSent] = useState<string[]>([]);
  const narrow = params.has("narrow");
  Object.assign(window, {
    quoteFixture: {
      getDraft: () => parseSkillDraft(composer.draft.text),
      getSent: () => sent,
      getThread: () => thread,
      navigate: () => {
        setThread({ ...base, id: "other-thread", canonicalItems: [] });
        setComposer(emptyComposerState());
      },
    },
  });
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
            minWidth: 0,
          }}
        >
          zenx <Icon name="chevron-right" /> 选段引用
          <span
            style={{
              marginLeft: "auto",
              color: "var(--color-text-muted)",
              whiteSpace: "nowrap",
            }}
          >
            合成数据 · 发送只添加本地示例消息
          </span>
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
              key: base.cwd,
              workspace: base.cwd,
              name: "zenx",
              configured: true,
              isDefault: true,
              threadIds: summaries.map((v) => v.threadId),
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: base.cwd,
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
              onDraftChange={(value) =>
                setComposer((state) => editComposer(state, value))
              }
              onInterrupt={async () => {}}
              onRespondToApproval={async () => {}}
              onSubmit={async (intent, expectedTurnId) => {
                if (sending.current) return;
                sending.current = true;
                try {
                  const prepared = beginComposerSubmission(
                    composer,
                    intent,
                    expectedTurnId,
                    () => `synthetic-send-${++counter.current}`,
                  );
                  const submission = prepared.submission;
                  if (!submission) return;
                  setComposer(prepared);
                  const draft = parseSkillDraft(submission.text);
                  const payload = referenceMessage(
                    draft.text,
                    draft.references,
                    submission.clientUserMessageId,
                  );
                  setThread((current) =>
                    appendSyntheticSent(
                      current,
                      payload,
                      submission.clientUserMessageId,
                    ),
                  );
                  setSent((current) => [...current, payload]);
                  setComposer((current) =>
                    acceptComposerSubmission(
                      current,
                      submission.clientUserMessageId,
                    ),
                  );
                } finally {
                  sending.current = false;
                }
              }}
            />
          </ThreadReadingStateProvider>
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
