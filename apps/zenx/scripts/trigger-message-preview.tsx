/** Actual message and scoped-trigger components, synthetic data, no Host. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThreadView } from "../src/renderer/src/ThreadView.js";
import { TriggersPanel } from "../src/renderer/src/bundled-automation-ui.js";
import { emptyComposerState } from "../src/renderer/src/composer-state.js";
import { MessageSourceNavigationContext } from "../src/renderer/src/message-source-navigation.js";
import { getLanguageController } from "../src/renderer/src/language.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { Thread } from "../src/protocol-client/index.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
import "../src/renderer/src/trigger-ui.css";
const now = Date.UTC(2026, 9, 25, 6, 0) / 1000;
const q = new URLSearchParams(location.search);
const zh = q.get("lang") === "zh-CN";
const label = zh ? "每日研究简报" : "Daily research brief";
const prompt = zh
  ? "请整理昨天的研究进展。\n\n- 检查已经完成的工作。\n- 对比两条线程的结论，指出矛盾。\n- 保留来源，不要自动合并任何方案。\n\n这是完整的触发器消息，不需要展开才能阅读。"
  : "Summarize yesterday’s research.\n\n- Check which tasks are complete.\n- Compare the two threads and identify contradictions.\n- Keep source references. Do not merge any proposal automatically.\n\nThis is the complete trigger message. No disclosure is needed to read it.";
const text = `[ZenX trigger wakeup]\nTrigger ID: daily-brief\nReason: Scheduled time reached\nRegistered trigger: ${label}\n\nInjected prompt:\n${prompt}\n\nBounded source context (read-only projection):\n${zh ? "审查线程：测试通过，设计仍待确认。" : "Review thread: tests passed; the design still needs a decision."}`;
const thread: Thread = {
  id: "research",
  sessionId: "research",
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  isPinned: false,
  modelProvider: "synthetic",
  createdAt: now - 10,
  updatedAt: now,
  recencyAt: null,
  status: { type: "idle" },
  path: null,
  cwd: "/synthetic",
  cliVersion: "preview",
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Research",
  turns: [
    {
      id: "turn",
      items: [
        {
          type: "hostMessage",
          id: "trigger-message",
          clientId: "trigger-client",
          source: "trigger",
          sourceId: "daily-brief",
          text,
          mode: "steer",
        },
        {
          type: "agentMessage",
          id: "reply",
          text: zh
            ? "研究结果已整理，待你审阅。"
            : "The research summary is ready for your review.",
          phase: "final_answer",
          memoryCitation: null,
        },
      ],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: now - 10,
      completedAt: now,
      durationMs: 10000,
    },
  ],
};
const calls: string[] = [];
const sdk = {
  version: 1,
  pluginId: "zenx-triggers",
  theme: "dark",
  context: {
    threadId: "research",
    triggerSourceRequest: {
      threadId: "research",
      triggerId: "daily-brief",
      requestId: 1,
    },
  },
  commands: {
    execute: async (command: string) => {
      calls.push(command);
      if (command === "list")
        return {
          triggers: [
            {
              id: "daily-brief",
              threadId: "research",
              kind: "signal",
              label,
              prompt,
              signal: { name: "daily" },
              active: false,
              createdAt: 1,
            },
          ],
          history: [],
        };
      if (command === "threads")
        return {
          threads: [
            {
              threadId: "research",
              name: zh ? "研究助手" : "Research assistant",
              archived: false,
              shortId: "research",
              status: "idle",
              cwd: "/synthetic",
            },
          ],
        };
      if (command === "workspaces") return { workspaces: [] };
      throw Error("Fixture mutations forbidden");
    },
  },
  navigation: {
    navigate() {
      throw Error("Fixture navigation forbidden");
    },
  },
  handles: {
    read: async () => {
      throw Error("No handles");
    },
  },
} as unknown as PluginUiSdkV1;
(window as any).__triggerPreview = { calls };
document.documentElement.dataset.appearance =
  q.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.themePreset = "graphite";
const style = document.createElement("style");
style.textContent = `body{margin:0;height:100vh}#root{height:100%}.preview-layout{height:100%;display:flex;min-width:0}.preview-conversation{min-width:0;min-height:0;flex:1;display:flex;flex-direction:column}.preview-source{width:420px;max-width:55vw;overflow:auto;border-left:1px solid var(--border);background:var(--surface)}@media(max-width:600px){.preview-layout[data-panel=true] .preview-conversation{display:none}.preview-source{max-width:none;width:100%}}`;
document.head.append(style);
function Preview() {
  const [open, setOpen] = useState(false);
  return (
    <MessageSourceNavigationContext.Provider
      value={async (target, owner) => {
        if (
          target.kind !== "trigger" ||
          target.id !== "daily-brief" ||
          owner.threadId !== "research"
        )
          throw Error("Unexpected source");
        if (owner.isCurrent()) setOpen(true);
      }}
    >
      <div className="preview-layout" data-panel={open}>
        <div className="preview-conversation">
          <ThreadView
            thread={thread}
            composer={emptyComposerState()}
            approvals={[]}
            onDraftChange={() => {}}
            onSubmit={async () => {}}
            onInterrupt={async () => {}}
            onRespondToApproval={async () => {}}
          />
        </div>
        {open && (
          <aside className="preview-source">
            <TriggersPanel sdk={sdk} />
          </aside>
        )}
      </div>
    </MessageSourceNavigationContext.Provider>
  );
}
getLanguageController().receivePreference(zh ? "zh-CN" : "en");
void i18n
  .changeLanguage(zh ? "zh-CN" : "en")
  .then(() => createRoot(document.getElementById("root")!).render(<Preview />));
