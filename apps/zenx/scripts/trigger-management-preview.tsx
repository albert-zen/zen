/** Actual trigger management components with synthetic memory-only data. */
import React from "react";
import { createRoot } from "react-dom/client";
import {
  TriggersPage,
  TriggersPanel,
} from "../src/renderer/src/bundled-automation-ui.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { getLanguageController } from "../src/renderer/src/language.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type { ZenXTrigger } from "../src/main/trigger-types.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
import "../src/renderer/src/trigger-ui.css";
const q = new URLSearchParams(location.search);
const language = q.get("lang") === "zh-CN" ? "zh-CN" : "en";
const zh = language === "zh-CN";
document.documentElement.lang = language;
document.documentElement.dataset.appearance =
  q.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.themePreset = "graphite";
const now = Date.UTC(2026, 9, 25, 8, 0);
const triggers: ZenXTrigger[] = [
  {
    id: "daily-brief",
    threadId: "research",
    kind: "timer",
    label: zh ? "每日研究简报" : "Daily research brief",
    prompt: zh
      ? "整理过去一天的研究进展，列出来源与需要跟进的问题。"
      : "Summarize yesterday's research, with source links and follow-up questions.",
    createdAt: now - 100000,
    active: true,
    timer: { nextRunAt: now + 86400000, intervalMinutes: 1440 },
  },
  {
    id: "review-complete",
    threadId: "research",
    kind: "thread",
    label: zh ? "代码审查完成后提醒" : "Notify when review completes",
    prompt: zh
      ? "审查完成后总结结论，不要自动合并。"
      : "Summarize the review outcome. Do not merge automatically.",
    createdAt: now - 200000,
    active: false,
    watch: { threadId: "review", event: "turn_completed", once: true },
  },
  {
    id: "deployment",
    threadId: "research",
    kind: "signal",
    label: zh ? "部署结果检查" : "Check deployment outcome",
    prompt: zh
      ? "检查部署状态，并记录失败原因。"
      : "Check deployment status and record any failure.",
    createdAt: now - 300000,
    active: true,
    signal: { name: "deployment.completed" },
    sourceError: zh
      ? "合成连接错误，仅用于展示"
      : "Synthetic connection error for preview only",
  },
];
const calls: Array<{ command: string; input: unknown }> = [];
const sdk: PluginUiSdkV1 = {
  version: 1,
  pluginId: "zenx-triggers",
  theme: "dark",
  context:
    q.get("panel") === "1"
      ? { threadId: "research" }
      : { route: "/plugins/zenx-triggers/triggers" },
  navigation: {
    navigate(route) {
      calls.push({ command: "navigate", input: route });
    },
  },
  handles: {
    read: async () => {
      throw new Error("No handles in fixture");
    },
  },
  commands: {
    async execute(command, input) {
      calls.push({ command, input });
      if (command === "list")
        return {
          triggers: structuredClone(triggers),
          history: [
            {
              id: "run1",
              triggerId: "daily-brief",
              threadId: "research",
              kind: "timer",
              reason: zh ? "计划时间已到" : "Scheduled time reached",
              prompt: "Synthetic prompt",
              status: "completed",
              startedAt: now,
              delivery: "queued",
            },
          ],
          rooms: [],
        };
      if (command === "threads")
        return {
          threads: [
            {
              threadId: "research",
              name: zh ? "研究助手" : "Research assistant",
              archived: false,
            },
            {
              threadId: "review",
              name: zh ? "代码审查" : "Code review",
              archived: false,
            },
          ],
        };
      if (command === "workspaces")
        return { workspaces: ["/synthetic/project"] };
      throw new Error("Preview mutations disabled");
    },
  },
};
Object.assign(window, { __triggerPreview: { calls } });
getLanguageController().receiveExternalPreference(language);
void i18n
  .changeLanguage(language)
  .then(() =>
    createRoot(document.getElementById("root")!).render(
      q.get("panel") === "1" ? (
        <TriggersPanel sdk={sdk} />
      ) : (
        <TriggersPage sdk={sdk} />
      ),
    ),
  );
