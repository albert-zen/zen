/** Production components with synthetic receipts only; no Host, tools, network or persistence. */
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ThreadView,
  ThreadViewActionsProvider,
} from "../src/renderer/src/ThreadView.js";
import { TriggersPanel } from "../src/renderer/src/bundled-automation-ui.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import {
  ThreadReadingStateProvider,
  useThreadReadingState,
  disclosureKey,
} from "../src/renderer/src/thread-reading-state.js";
import { resolveDeliveredMessage } from "../src/renderer/src/tool-action-targets.js";
import type { MessageTargetRequest } from "../src/renderer/src/message-target-navigation.js";
import {
  runtimeThread,
  runtimeCommand,
  runtimeMessage,
} from "../test/fixtures/agent-runtime-data.js";
import { nativeRecoveryForThread } from "../test/native-recovery-fixture.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
import "../src/renderer/src/trigger-ui.css";
const zh = new URLSearchParams(location.search).get("lang") === "zh-CN";
const message = zh
  ? "请审阅这份实施方案，只记录问题，不要自动发布。"
  : "Review this implementation plan. Record concerns; do not publish automatically.";
const source = runtimeThread(
  [
    {
      ...runtimeCommand("send"),
      toolName: "zenx_threads_send",
      command: "zenx_threads_send",
      toolArguments: { ref: "r1", text: message },
      aggregatedOutput: JSON.stringify({
        ref: "r1",
        message: "r2",
        queued: false,
      }),
    },
    runtimeMessage(
      "between",
      zh
        ? "消息已送达，接着更新例行复查。"
        : "The message was delivered. I also updated the scheduled review.",
    ),
    {
      ...runtimeCommand("trigger"),
      toolName: "zenx_triggers_update",
      command: "zenx_triggers_update",
      toolArguments: { ref: "r3" },
      aggregatedOutput: JSON.stringify({
        ref: "r3",
        thread: "r1",
        label: "Morning review",
      }),
    },
    runtimeMessage(
      "final",
      zh
        ? "两项操作都已完成，可直接查看目标。"
        : "Both actions are recorded. Open either exact destination below.",
    ),
  ],
  "completed",
  "source",
);
source.name = zh ? "实施协调" : "Implementation coordination";
source.canonicalItems = nativeRecoveryForThread(source).thread.items;
for (const item of source.canonicalItems)
  if (item.type === "tool_result")
    item.referenceBindings = [
      {
        ref: "r1",
        ownerThreadId: "source",
        namespace: "threads",
        kind: "thread",
        value: { id: "destination", device: "local" },
      },
      {
        ref: "r2",
        ownerThreadId: "source",
        namespace: "threads",
        kind: "item",
        value: {
          id: "exact-message",
          threadId: "destination",
          device: "local",
        },
      },
      {
        ref: "r3",
        ownerThreadId: "source",
        namespace: "triggers",
        kind: "trigger",
        value: { id: "exact-trigger" },
      },
    ];
const destination = runtimeThread(
  [
    {
      type: "threadMessage",
      id: "same-text-neighbor",
      clientId: "neighbor",
      sender: {
        threadId: "source",
        threadName: source.name!,
        toolCallId: "older",
        callId: "older",
      },
      content: [{ type: "text", text: message, text_elements: [] }],
    },
    runtimeMessage(
      "old-answer",
      zh
        ? "这是之前的同文消息。"
        : "This is an earlier message with the same text.",
    ),
    {
      type: "threadMessage",
      id: "exact-message",
      clientId: "receipt",
      sender: {
        threadId: "source",
        threadName: source.name!,
        toolCallId: "send",
        callId: "send-call",
      },
      content: [{ type: "text", text: message, text_elements: [] }],
    },
    runtimeMessage(
      "answer",
      zh
        ? "已收到这条确切的消息，开始复查。"
        : "Received this exact message. Beginning the review.",
    ),
  ],
  "completed",
  "destination",
);
destination.name = zh ? "方案复查" : "Implementation review";
destination.canonicalItems = nativeRecoveryForThread(destination).thread.items;
const commands: string[] = [];
function Preview() {
  const [thread, setThread] = useState(source);
  const [request, setRequest] = useState<MessageTargetRequest | null>(null);
  const [trigger, setTrigger] = useState<string | null>(null);
  const reading = useThreadReadingState(source.id);
  useLayoutEffect(
    () => reading.set(disclosureKey("turn", "runtime-turn"), true),
    [reading],
  );
  const sdk = {
    version: 1,
    pluginId: "zenx-triggers",
    theme: "light",
    context: {
      threadId: "source",
      triggerSourceRequest: {
        threadId: "destination",
        triggerId: trigger,
        requestId: 1,
      },
    },
    commands: {
      execute: async (name: string) => {
        commands.push(name);
        if (name === "list")
          return {
            triggers: ["other", "exact-trigger"].map((id) => ({
              id,
              label: "Morning review",
              threadId: "destination",
              kind: "signal",
              signal: { name: id },
              prompt:
                id === "exact-trigger"
                  ? zh
                    ? "复查实施进展并保留来源。"
                    : "Review implementation progress and preserve sources."
                  : "Not the selected trigger",
              active: false,
              createdAt: 1,
            })),
            history: [],
          };
        if (name === "threads")
          return {
            threads: [
              {
                threadId: "destination",
                name: destination.name,
                shortId: "destinat",
                cwd: "/synthetic/destination",
                archived: false,
                status: "idle",
              },
            ],
          };
        if (name === "workspaces") return { workspaces: [] };
        throw Error("Synthetic preview does not execute mutations");
      },
    },
    navigation: {
      navigate() {
        throw Error("Synthetic preview does not navigate to live products");
      },
    },
  } as unknown as PluginUiSdkV1;
  return (
    <ThreadViewActionsProvider
      fork={async () => {}}
      source={async (target) => {
        if (target.kind === "trigger") {
          setTrigger(target.id);
          return;
        }
        if (target.id === "source") {
          setThread(source);
          setRequest(null);
          return;
        }
        const exact = resolveDeliveredMessage(
          destination.canonicalItems!,
          target.itemId ?? "",
        );
        if (typeof exact === "string") throw Error(exact);
        setThread(destination);
        setTrigger(null);
        setRequest({
          threadId: destination.id,
          itemId: exact.itemId,
          requestId: Date.now(),
        });
      }}
      messageTarget={request}
      onMessageTargetConsumed={() => setRequest(null)}
    >
      <main className="tool-target-preview">
        <header>
          <div>
            <strong>ZenX · {thread.name}</strong>
            <small>
              {zh
                ? "合成数据 · 真实组件 · 无网络或写入"
                : "Synthetic data · production components · no network or writes"}
            </small>
          </div>
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              setThread(source);
              setTrigger(null);
              setRequest(null);
            }}
          >
            {zh ? "返回工具记录" : "Back to tool records"}
          </button>
        </header>
        <div className="tool-target-preview-layout">
          <ThreadView
            thread={thread}
            approvals={[]}
            composer={emptyComposerState()}
            onDraftChange={() => {}}
            onInterrupt={async () => {}}
            onRespondToApproval={async () => {}}
            onSubmit={async () => {}}
          />
          {trigger && (
            <aside>
              <TriggersPanel sdk={sdk} />
            </aside>
          )}
        </div>
      </main>
    </ThreadViewActionsProvider>
  );
}
Object.assign(window, { __toolTargetPreview: { commands } });

document.documentElement.dataset.appearance = "light";
const style = document.createElement("style");
style.textContent = `.tool-target-preview{height:100vh;display:flex;flex-direction:column;background:var(--surface-1)}.tool-target-preview>header{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;border-bottom:1px solid var(--border-soft)}.tool-target-preview header small{display:block;margin-top:4px;color:var(--text-3);font-size:12px}.tool-target-preview-layout{display:flex;flex:1;min-height:0}.tool-target-preview-layout>.thread-conversation-surface{flex:1;min-width:0}.tool-target-preview-layout>aside{width:440px;overflow:auto;border-left:1px solid var(--border-soft)}@media(max-width:700px){.tool-target-preview-layout>aside{width:100%;position:absolute;inset:80px 0 0;background:var(--surface-1)}}`;
document.head.append(style);
void i18n.changeLanguage(zh ? "zh-CN" : "en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <ThreadReadingStateProvider>
      <Preview />
    </ThreadReadingStateProvider>,
  ),
);
