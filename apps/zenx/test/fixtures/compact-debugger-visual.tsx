import "../../src/renderer/src/shell-thread-panel.css";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/agent-readiness-notice.css";
import "../../src/renderer/src/trigger-ui.css";
import "../../src/renderer/src/skills.css";
import "../../src/renderer/src/rooms-layout.css";
import "../../src/renderer/src/room-message-actions.css";
import "../../src/renderer/src/room-conversations.css";
import "../../src/renderer/src/companion-workspace.css";
import React from "react";
import { i18n } from "../../src/renderer/src/i18n.js";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
  ModelRequestDebugSummary,
} from "../../../cli/src/model-request-debug-types.js";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import type { Thread } from "../../src/protocol-client/index.js";
import { RoomsPage } from "../../src/renderer/src/bundled-automation-ui.js";
import { pluginUiRegistry } from "../../src/renderer/src/PluginProductPage.js";
import { App } from "../../src/renderer/src/App.js";
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import { encodeModelKey } from "../../../../src/protocol/model-key.js";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.platform = params.get("platform") ?? "win32";
// Slow the same production transition for inspectable intermediate-frame QA.
if (params.has("slowMotion"))
  document.documentElement.style.setProperty("--motion-layout", "1600ms");
const pawRooms = [
  {
    id: "synthetic-paw",
    name: "Research assistant",
    createdAt: 0,
    messages: [],
    assistant: { threadId: "thread-1", triggerId: "synthetic-trigger" },
    members: [{ name: "PAW speaker", threadId: "thread-1" }],
  },
];
if (params.has("paw"))
  pluginUiRegistry.registerTrusted("synthetic-paw-ui", {
    overview: ({ sdk }) => React.createElement(RoomsPage, { sdk }),
  });
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
    list: async ({ archived = false }: { archived?: boolean } = {}) =>
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
    rename: async (threadId: string, title: string) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (title === "error")
        throw new Error("Synthetic rename failed. Try again.");
      return {
        threadId,
        title,
        status: "manual",
        source: "user",
        version: Date.now(),
      };
    },
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
  computerReadiness: {
    get: async () => ({
      platform: "linux",
      accessibility: "not-applicable",
      screenRecording: "not-applicable",
      foregroundControlEnabled: false,
    }),
    probe: async () => ({
      platform: "linux",
      accessibility: "not-applicable",
      screenRecording: "not-applicable",
      foregroundControlEnabled: false,
    }),
    onChange: () => () => undefined,
  },
  plugins: {
    executeCommand: async (plugin: string, command: string) => {
      if (plugin === "zenx-rooms" && command === "list")
        return { rooms: pawRooms };
      if (plugin === "zenx-rooms" && command === "workspace")
        return { revision: 1, matters: [], memory: [] };
      throw new Error(
        `Synthetic fixture does not support ${plugin}/${command}`,
      );
    },
    get: async () => ({
      plugins: [
        { id: "notes", enabled: true, available: true },
        ...(params.has("paw")
          ? [
              {
                id: "zenx-rooms",
                displayName: "Rooms",
                enabled: true,
                available: true,
                lifecycle: "enabled",
                contributionCount: 1,
                version: "1",
                source: "bundled",
              },
            ]
          : []),
      ],
      sidebar: [],
      pages: params.has("paw")
        ? [
            {
              key: "zenx-rooms:rooms",
              pluginId: "zenx-rooms",
              id: "rooms",
              title: "Rooms",
              route: "/plugins/zenx-rooms/rooms",
              surfaceId: "overview",
            },
          ]
        : [],
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
        ...(params.has("paw")
          ? [
              {
                key: "zenx-rooms:overview",
                pluginId: "zenx-rooms",
                id: "overview",
                bundleId: "main",
                exportName: "overview",
              },
            ]
          : []),
        {
          key: "notes:notes",
          pluginId: "notes",
          id: "notes",
          bundleId: "ui",
          exportName: "main",
        },
      ],
      bundles: [
        ...(params.has("paw")
          ? [
              {
                key: "zenx-rooms:main",
                pluginId: "zenx-rooms",
                id: "main",
                apiVersion: 1,
                kind: "trusted",
                entry: "synthetic-paw-ui",
              },
            ]
          : []),
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
    applications: async () => ({
      platform: "darwin",
      applications: {
        vscode: "/Applications/Visual Studio Code.app",
        cursor: "/Applications/Cursor.app",
        editor: "/System/Applications/TextEdit.app",
      },
    }),
    openExternal: async () => {
      throw new Error("Synthetic preview: no application is launched");
    },
    configureApplication: async () => {
      throw new Error("Synthetic preview: no native picker is opened");
    },
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
// Every request, identity and payload below is synthetic. No Host or provider is contacted.
let enabled = params.get("capture") !== "off";
let generation = 1;
const body = JSON.stringify(
  {
    model: "synthetic-model",
    instructions:
      "You are reviewing a local-only synthetic workspace. Preserve exact canonical history and report evidence clearly.",
    messages: [
      {
        role: "system",
        content:
          "Long strings wrap naturally in Tree. Raw remains exactly the retained text. “多语言数据与完整的上下文。” ".repeat(
            8,
          ),
      },
      {
        role: "user",
        content:
          "Inspect the workspace and describe the next steps. No real data is used in this fixture.",
      },
      {
        role: "assistant",
        content:
          "I will check the context, compare the views and report any anomalies.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "synthetic_workspace_inspect",
          description: "Read synthetic fixture metadata",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ],
    temperature: 0.2,
  },
  null,
  2,
);
const rows: ModelRequestDebugSummary[] = Array.from(
  { length: 18 },
  (_, index) => ({
    id: `synthetic-request-${index}`,
    capturedAt: new Date(1791983100000 - index * 5000).toISOString(),
    threadId: "thread-1",
    purpose: index === 3 ? "compaction" : "turn",
    turnId: index === 3 ? null : "synthetic-turn-1",
    sampleId: `synthetic-sample-${index}`,
    contextBoundaryItemId: "synthetic-context-boundary",
    sampleAttempt: index === 4 ? 2 : 1,
    transportAttempt: index === 5 ? 3 : 1,
    provider: "Synthetic provider",
    model: params.has("long")
      ? "超长模型名称-LongMultilingualModelNameWithoutBreaks-2026-10-14"
      : "synthetic-model",
    format: index === 2 ? "model-input" : "chat-completions",
    redacted: index === 1 || index === 2,
    truncated: index === 2,
    originalBytes: body.length + (index === 2 ? 9000 : 0),
    retainedBytes: body.length,
    sourceAttachmentCount: index === 1 ? 1 : 0,
    sourceAttachments:
      index === 1
        ? [
            {
              sha256: "a".repeat(64),
              mediaType: "image/png",
              byteLength: 128,
              width: 16,
              height: 16,
            },
          ]
        : [],
  }),
);
let records = enabled ? rows : [];
const commands: ModelRequestDebugCommand[] = [];
Object.assign(zenx, {
  modelRequestDebug: {
    request: async (
      command: ModelRequestDebugCommand,
    ): Promise<ModelRequestDebugResult> => {
      commands.push(command);
      if (command.action === "setEnabled") {
        enabled = command.enabled;
        generation++;
        records = enabled ? rows : [];
      }
      if (command.action === "clear") {
        generation++;
        records = [];
      }
      const result: ModelRequestDebugResult = {
        sessionId: "synthetic-session",
        generation,
        enabled,
        retainedCount: records.length,
        retainedBytes: body.length * records.length,
        evictedCount: 3,
        limits: {
          maxRecords: 200,
          maxBytes: 33554432,
          maxRecordBytes: 1048576,
          pageCharacters: 50000,
        },
      };
      if (command.action === "list")
        result.records = records.filter(
          (record) =>
            (!command.threadId || record.threadId === command.threadId) &&
            (!command.query ||
              JSON.stringify(record).includes(command.query) ||
              body.includes(command.query)),
        );
      if (command.action === "read") {
        const record = records.find((entry) => entry.id === command.id);
        if (!record) throw new Error("Synthetic capture missing");
        const view = command.view ?? "payload";
        const data = JSON.parse(body);
        const text = record.truncated
          ? body.slice(0, 700)
          : view === "payload"
            ? body
            : JSON.stringify(
                view === "messages"
                  ? data.messages
                  : view === "tools"
                    ? data.tools
                    : {
                        instructions: data.instructions,
                        temperature: data.temperature,
                      },
                null,
                2,
              );
        result.page = {
          record,
          view,
          text,
          offset: 0,
          nextOffset: null,
          totalCharacters: text.length,
        };
      }
      return result;
    },
  },
});
Object.assign(window, { compactDebugFixture: { commands, body } });
Object.defineProperty(window, "zenx", { value: zenx });
localStorage.setItem("zenx-sidebar-mode", "inbox");
await i18n.changeLanguage(params.get("lang") ?? "en");
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
    createdAt: new Date(1791982800000).toISOString(),
    updatedAt: new Date(1791983100000).toISOString(),
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
    createdAt: 1791982800,
    updatedAt: 1791983100,
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
    startedAt: 1791982800,
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
        completedAt: 1791983100,
        durationMs: 300000,
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
