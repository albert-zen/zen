import React from "react";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import type { Thread } from "../../src/protocol-client/index.js";
import { App } from "../../src/renderer/src/App.js";
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import { encodeModelKey } from "../../../../src/protocol/codex/model-key.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.platform = params.get("platform") ?? "win32";
const options = {
  request: async (method: string) => {
    if (method === "zen/thread/resume")
      return resumed(
        threadWithMessage(
          "已检查工作区。你可以在右侧阅读和编辑计划，同时保留当前对话。\n\n### 下一步\n\n- 统一浏览器和文件工作区\n- 在同一页面与 Agent 协作\n- 查看上下文压缩结果",
        ),
      );
    throw new Error("Fixture unsupported: " + method);
  },
};
const zenx = {
  panels: { onOpen: () => () => undefined },
  platform: params.get("platform") ?? "win32",
  protocol: {
    getStatus: async () => ({
      type: "ready",
      reconnected: false,
    }),
    getPendingApprovals: async () => [],
    request: async (method: string, params?: unknown) => {
      if (method === "model/list") return { data: [model()], nextCursor: null };
      return await options.request(method);
    },
    respondToApproval: async () => undefined,
    onApprovalRequest: () => () => undefined,
    onApprovalResolved: () => () => undefined,
    onStatus: () => () => undefined,
    onNotification: () => () => undefined,
  },
  threads: {
    list: async ({ archived }: { archived: boolean }) =>
      archived ? [] : [summary()],
  },
  imageAttachments: {
    pick: async () => [],
    import: async () => [],
    read: async () => new Uint8Array(),
    forThread: async () => ({}),
  },
  modelUsage: {
    forThread: async () => ({
      thread: { responseCount: 0, inputTokens: 0, outputTokens: 0 },
      turns: {},
      context: {
        inputTokens: null,
        inputTokenSource: null,
        contextWindow: null,
        ratio: null,
      },
    }),
  },
  projects: {
    get: async () => ({
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: true,
          threadIds: ["thread-1"],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    }),
  },
  settings: {
    get: async () => ({
      profile: {
        onboardingComplete: true,
        pinnedThreadIds: [],
        providerProfiles: [],
      },
    }),
    markWorkspaceUsed: async () => ({
      profile: {
        onboardingComplete: true,
        pinnedThreadIds: [],
        providerProfiles: [],
      },
    }),
  },
  titles: {
    get: async () => ({}),
    onChange: () => () => undefined,
  },
  triggers: {
    get: async () => ({ triggers: [], history: [], rooms: [] }),
    onChange: () => () => undefined,
  },
  capabilities: {
    get: async () => ({ capabilities: [], audit: [], providers: [] }),
    onChange: () => () => undefined,
  },
  plugins: {
    get: async () => ({ plugins: [], sidebar: [], pages: [] }),
    onChange: () => () => undefined,
  },
};

Object.assign(zenx, {
  browserObservation: { subscribe: () => () => undefined },
  workspaceFiles: {
    list: async () => ({
      path: ".",
      entries: [
        { name: "PLAN.md", path: "PLAN.md", kind: "file" },
        { name: "src", path: "src", kind: "directory" },
      ],
      truncated: false,
    }),
    read: async () => ({
      path: "PLAN.md",
      text: "# A shared workspace\n\nKeep the conversation and the work side by side.\n\n## Current focus\n\n- One place for files, browser and computer\n- Clear state and deliberate actions\n- Editable Markdown with safe saves\n\n> This is a visual fixture. No real files are changed.",
      revision: "demo",
      editable: true,
    }),
    save: async () => {
      throw new Error("Fixture does not write real files");
    },
  },
});
Object.defineProperty(window, "zenx", { value: zenx });
localStorage.setItem("zenx-sidebar-mode", "inbox");
createRoot(document.getElementById("root")!).render(<App />);
function summary(
  threadId = "thread-1",
  name = "Thread one",
): NativeThreadSummary {
  return {
    threadId,
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd: "/work/zen",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived: false,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    name,
    preview: "",
    status: "idle",
  };
}

function thread(threadId = "thread-1"): Thread {
  return {
    id: threadId,
    sessionId: threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "fake",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/work/zen",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: threadId === "thread-1" ? "Thread one" : "Thread two",
    turns: [],
  };
}

function runningTurn(): Thread["turns"][number] {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 10,
    completedAt: null,
    durationMs: null,
  };
}

function threadWithMessage(text: string): Thread {
  return {
    ...thread(),
    turns: [
      {
        ...runningTurn(),
        status: "completed",
        completedAt: 20,
        durationMs: 10,
        items: [
          {
            id: `agent-${text}`,
            type: "agentMessage",
            text,
            phase: "final_answer",
            memoryCitation: null,
          },
        ],
      },
    ],
  };
}

function resumed(value: Thread) {
  return nativeRecoveryForThread(value);
}

function model() {
  const id = encodeModelKey({ providerProfileId: "fake", modelId: "fake" });
  return {
    id,
    model: "fake",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "Local demo",
    description: "Local demo",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "medium" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text" as const],
    supportsPersonality: false as const,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  };
}
