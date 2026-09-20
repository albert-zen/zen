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
let compactions = 0;
// Controlled browser state for toolbar layout; no external site is loaded.
let previewTabs: import("../../src/main/workspace-browser.js").WorkspaceBrowserTab[] =
  [];

const options = {
  request: async (method: string) => {
    if (method === "zen/thread/resume") {
      const recovery = resumed(
        threadWithMessage(
          "已检查工作区。你可以在右侧阅读和编辑计划，同时保留当前对话。\n\n### 下一步\n\n- 统一浏览器和文件工作区\n- 在同一页面与 Agent 协作\n- 查看上下文压缩结果",
        ),
      );
      if (compactions)
        recovery.thread.items.push({
          id: `compact-${compactions}`,
          type: "context_compaction",
          threadId: "thread-1",
          createdAt: new Date().toISOString(),
          provenance: "provider_generated",
          initiator: "human",
          coveredThroughItemId: recovery.thread.items.at(-1)!.id,
          summary:
            "Visual fixture summary: keep one shared workspace for files, Browser and Computer. Markdown edits save automatically. Preserve the user's current draft.",
          retainedItemIds: [],
          providerProfileId: "fake",
          modelId: "fake",
          reasoningEffort: "medium",
          algorithmVersion: "zen.context-compaction.v2",
          tokenUsage: { inputTokens: 12000, outputTokens: 180 },
        });
      return recovery;
    }
    if (method === "thread/compact") {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      compactions += 1;
      return { compactionItemId: `compact-${compactions}` };
    }
    throw new Error("Fixture unsupported: " + method);
  },
};
const zenx = {
  workspaceBrowser: {
    command: async (
      threadId: string,
      command: string,
      tabId?: string,
      url?: string,
    ) => {
      if (command === "new")
        previewTabs.push({
          id: crypto.randomUUID(),
          threadId,
          title: "New tab",
          url: "about:blank",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          sharedWithAgent: true,
        });
      if (command === "close")
        previewTabs = previewTabs.filter((tab) => tab.id !== tabId);
      if (command === "navigate")
        previewTabs = previewTabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, title: "Personal Inbox", url: url ?? "about:blank" }
            : tab,
        );
      return previewTabs.filter((tab) => tab.threadId === threadId);
    },
    mount: async () => undefined,
    onChanged: () => () => undefined,
    onFocusAddress: () => () => undefined,
  },
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
        inputTokens: 12000,
        inputTokenSource: "usage",
        contextWindow: 128000,
        ratio: 12000 / 128000,
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
        workflowCommands: [
          {
            name: "review",
            description: "Review a change",
            prompt:
              "Review this change and list actionable issues.\n\n{{args}}",
            enabled: true,
          },
        ],
      },
    }),
    markWorkspaceUsed: async () => ({
      profile: {
        onboardingComplete: true,
        pinnedThreadIds: [],
        providerProfiles: [],
        workflowCommands: [
          {
            name: "review",
            description: "Review a change",
            prompt:
              "Review this change and list actionable issues.\n\n{{args}}",
            enabled: true,
          },
        ],
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
    get: async () => ({
      plugins: [{ id: "notes", enabled: true, available: true }],
      sidebar: [],
      pages: [],
      panels: [
        {
          key: "notes:preview",
          pluginId: "notes",
          id: "preview",
          title: "Project notes",
          surfaceId: "notes",
        },
      ],
      surfaces: [
        {
          key: "notes:notes",
          pluginId: "notes",
          id: "notes",
          bundleId: "ui",
          exportName: "main",
        },
      ],
      bundles: [
        {
          key: "notes:ui",
          pluginId: "notes",
          id: "ui",
          apiVersion: 1,
          kind: "isolated",
          entry:
            '<main style="padding:20px;font:14px/1.6 system-ui;color:inherit"><h2 style="font-size:17px">Project notes</h2><p>This view is provided by a registered plugin.</p><label>Notes<textarea aria-label="Project notes" style="display:block;width:100%;min-height:160px;margin-top:8px;font:inherit">The host supplies the tab; the plugin owns this view.</textarea></label></main>',
        },
      ],
      subroutes: [],
      settings: [],
      commands: [],
      menus: [],
    }),
    onChange: () => () => undefined,
  },
};

let fixtureFile = {
  path: "PLAN.md",
  text: "# A shared workspace\n\nKeep the conversation and the **work side by side**.\n\n## Current focus\n\n- One place for files, browser and computer\n- Clear state and deliberate actions\n- Edit Markdown with automatic saves\n\nSee the [Zen project](https://github.com/albert-zen/zen) for more context.\n\n> This is a visual fixture. Edits stay in this page; no real files are changed.",
  revision: "demo-0",
  editable: true,
};
let fileRevision = 0;
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
    read: async () => ({ ...fixtureFile }),
    save: async (
      _threadId: string,
      _path: string,
      text: string,
      revision: string,
    ) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (revision !== fixtureFile.revision)
        return { status: "conflict", file: { ...fixtureFile } };
      fixtureFile = {
        ...fixtureFile,
        text,
        revision: `demo-${++fileRevision}`,
      };
      return { status: "saved", file: { ...fixtureFile } };
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
            id: "browser-inspect-demo",
            type: "commandExecution",
            toolName: "zenx_browser_inspect",
            toolArguments: { tabId: "shared-demo" },
            pluginId: null,
            scriptPath: null,
            command: "Inspect shared page",
            cwd: "/work/zen",
            processId: null,
            source: "agent",
            status: "completed",
            commandActions: [],
            aggregatedOutput: "Shared workspace fixture ready.",
            exitCode: 0,
            durationMs: 125,
          },
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
