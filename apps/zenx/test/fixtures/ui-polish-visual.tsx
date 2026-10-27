import "../../src/renderer/src/shell-thread-panel.css";
import "../../src/renderer/src/agent-readiness-notice.css";
import "../../src/renderer/src/trigger-ui.css";
import "../../src/renderer/src/skills.css";
import "../../src/renderer/src/rooms-layout.css";
import "../../src/renderer/src/room-message-actions.css";
import "../../src/renderer/src/room-conversations.css";
import "../../src/renderer/src/companion-workspace.css";
import { i18n } from "../../src/renderer/src/i18n.js";
import { workspaceLauncherSnapshot } from "../workspace-launcher-snapshot.js";
import React from "react";
import { createRoot } from "react-dom/client";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import type { ThreadTitleSnapshot } from "../../src/main/thread-title-types.js";
import type { Thread } from "../../src/protocol-client/index.js";
import { App, WindowTitleBar } from "../../src/renderer/src/App.js";
import { AuxiliaryPanel } from "../../src/renderer/src/auxiliary-panel.js";
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import { encodeModelKey } from "../../../../src/protocol/model-key.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.platform = params.get("platform") ?? "win32";
// Slow the same production transition for inspectable intermediate-frame QA.
if (params.has("slowMotion"))
  document.documentElement.style.setProperty("--motion-layout", "1600ms");
let compactions = 0;
// Controlled browser state for toolbar layout; no external site is loaded.
let previewTabs: import("../../src/main/workspace-browser.js").WorkspaceBrowserTab[] =
  [];

const sideConversations = [
  { ...summary("design-child", "Design review"), parentThreadId: "thread-1" },
  { ...summary("test-child", "Test coverage"), parentThreadId: "thread-1" },
];
const fixtureTitles: ThreadTitleSnapshot = {};
let titleVersion = 0;
const uiPolishTelemetry = {
  protocolCalls: [] as string[],
  workspaceUsedCalls: 0,
  machineStatusCalls: 0,
  machineCatalogCalls: 0,
};
const options = {
  request: async (method: string, request?: unknown) => {
    uiPolishTelemetry.protocolCalls.push(method);
    if (method === "zen/thread/resume") {
      const threadId =
        (request as { threadId?: string } | undefined)?.threadId ?? "thread-1";
      const recovery = resumed(
        threadWithMessage(
          threadId === "thread-1"
            ? "已检查工作区。你可以在右侧阅读和编辑计划，同时保留当前对话。\n\n### 下一步\n\n- 统一浏览器和文件工作区\n- 在同一页面与 Agent 协作\n- 查看上下文压缩结果"
            : `Synthetic ${sideConversations.find((entry) => entry.threadId === threadId)?.name ?? "side chat"}. This conversation has its own draft and reading state.`,
          threadId,
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
  computerReadiness: {
    get: async () => ({
      platform: params.get("platform") ?? "win32",
      accessibility: "granted",
      screenRecording: "granted",
    }),
  },
  chromeBridge: {
    get: async () => ({
      effectiveMode: "user-session",
      connection: { state: "connected" },
    }),
  },
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
      return await options.request(method, params);
    },
    respondToApproval: async () => undefined,
    onApprovalRequest: () => () => undefined,
    onApprovalResolved: () => () => undefined,
    onStatus: () => () => undefined,
    onNotification: () => () => undefined,
  },
  threads: {
    list: async ({ archived }: { archived: boolean }) =>
      archived
        ? []
        : [
            summary(),
            ...(params.has("conversationTabs") ? sideConversations : []),
          ],
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
          name: "Zen",
          configured: true,
          isDefault: true,
          threadIds: [
            "thread-1",
            ...(params.has("conversationTabs")
              ? sideConversations.map((entry) => entry.threadId)
              : []),
          ],
        },
        {
          key: "/work/design-system",
          workspace: "/work/design-system",
          name: "Design system",
          configured: true,
          isDefault: false,
          threadIds: [],
        },
        {
          key: "/work/field-notes",
          workspace: "/work/field-notes",
          name: "Field notes",
          configured: true,
          isDefault: false,
          threadIds: [],
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
    markWorkspaceUsed: async () => {
      uiPolishTelemetry.workspaceUsedCalls += 1;
      return {
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
      };
    },
  },
  titles: {
    get: async () => ({ ...fixtureTitles }),
    rename: async (threadId: string, title: string) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const projection = {
        threadId,
        title,
        status: "manual" as const,
        source: "user" as const,
        version: ++titleVersion,
      };
      fixtureTitles[threadId] = projection;
      return projection;
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
  fleet: {
    status: async () => {
      uiPolishTelemetry.machineStatusCalls += 1;
      return {
        revision: 1,
        config: {
          version: 1,
          devices: [
            {
              id: "synthetic-research",
              label: "Research workstation · Linux",
              description: "Synthetic QA target; no connection is attempted.",
              access: "read" as const,
              transport: "https" as const,
              endpoint: "https://synthetic.invalid",
              hostId: "synthetic-host",
            },
            {
              id: "synthetic-design",
              label: "Design and prototyping MacBook Pro",
              description: "Synthetic QA target; no connection is attempted.",
              access: "read" as const,
              transport: "https" as const,
              endpoint: "https://synthetic.invalid",
              hostId: "synthetic-host",
            },
          ],
        },
        host: { enabled: false, hostId: "synthetic-host", clients: [] },
      };
    },
    catalog: async () => {
      uiPolishTelemetry.machineCatalogCalls += 1;
      throw new Error("This fixture never connects to a machine.");
    },
  },
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
// Launcher mode mounts the real admitted Subagents/Triggers UI on a synthetic bridge.
if (params.has("launchers") || params.has("conversationTabs")) {
  Object.assign(zenx.plugins, {
    get: async () => workspaceLauncherSnapshot,
    executeCommand: async (pluginId: string, command: string) => {
      if (pluginId === "zenx-subagents") {
        if (command === "list")
          return {
            threads: params.has("conversationTabs") ? sideConversations : [],
          };
        if (command === "create") return { threadId: "synthetic-side-chat" };
      }
      if (pluginId === "zenx-triggers") {
        if (command === "threads")
          return {
            threads: [
              {
                threadId: "thread-1",
                shortId: "thread-1",
                name: "Thread one",
                cwd: "/work/zen",
                archived: false,
                status: "idle",
              },
            ],
          };
        if (command === "workspaces") return { workspaces: [] };
        if (command === "list") return { triggers: [], history: [], rooms: [] };
      }
      throw new Error(`Unsupported synthetic command: ${pluginId}/${command}`);
    },
    readHandle: async () => null,
  });
}
Object.defineProperty(window, "zenx", { value: zenx });
Object.assign(window, { __uiPolishTelemetry: uiPolishTelemetry });
localStorage.setItem("zenx-sidebar-mode", "projects");
const scene = params.get("scene") ?? "welcome";

function AuxiliaryFixture() {
  const [collapsed, setCollapsed] = React.useState(window.innerWidth <= 720);
  const [width, setWidth] = React.useState(520);
  const [selected, setSelected] = React.useState("custom:browser");
  const [order, setOrder] = React.useState([
    "custom:files",
    "custom:browser",
    "custom:computer",
    "custom:subagents",
    "custom:triggers",
  ]);
  const writes = React.useRef<string[][]>([]);
  const customTabs = [
    ["files", "PLAN.md", "file"],
    ["browser", "Browser", "browser"],
    ["computer", "Computer", "computer"],
    ["subagents", "Subagents", "users"],
    ["triggers", "Triggers", "trigger"],
  ] as const;
  React.useEffect(() => {
    Object.assign(window, {
      __uiPolishAuxiliary: {
        getState: () => ({ order, selected, writes: writes.current }),
      },
    });
  }, [order, selected]);
  return (
    <div
      className={`app-shell ${collapsed ? "sidebar-collapsed" : "sidebar-open"}`}
    >
      <WindowTitleBar
        mode="projects"
        pendingApprovalCount={0}
        sidebarCollapsed={collapsed}
        onToggleInbox={() => {}}
        onToggleSidebar={() => setCollapsed((value) => !value)}
      >
        <div className="thread-heading">Synthetic workspace · QA</div>
      </WindowTitleBar>
      <aside
        id="primary-sidebar"
        className={`sidebar${collapsed ? "" : " open"}`}
      >
        <p style={{ padding: 16 }}>Synthetic Projects sidebar</p>
      </aside>
      <main className="workspace">
        <section className="agent-surface">
          <div style={{ padding: 24 }}>
            <h1>Auxiliary tab reorder</h1>
            <p>Production AuxiliaryPanel with synthetic tabs and content.</p>
          </div>
        </section>
        <AuxiliaryPanel
          threadId="synthetic-ui-polish-thread"
          title="Synthetic workspace"
          open
          onOpenChange={() => {}}
          onWidthChange={setWidth}
          snapshot={null}
          selectedTab={selected}
          onSelectTab={setSelected}
          openedTabs={order}
          onTabsChange={(next) => {
            writes.current.push(next);
            setOrder(next);
          }}
          customTabs={customTabs.map(([id, title, icon]) => ({
            id,
            title,
            icon,
            render: () => (
              <div style={{ padding: 24 }}>
                <h2>{title}</h2>
                <p>Synthetic preview data only. No Host, model, or network.</p>
              </div>
            ),
          }))}
        />
        <span className="sr-only" aria-hidden="true">
          {width}
        </span>
      </main>
    </div>
  );
}

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
    createdAt: "2026-10-15T03:00:00.000Z",
    updatedAt: "2026-10-15T03:01:00.000Z",
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
    createdAt: 1792033200,
    updatedAt: 1792033260,
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
    startedAt: 1792033200,
    completedAt: null,
    durationMs: null,
  };
}

function threadWithMessage(text: string, threadId = "thread-1"): Thread {
  return {
    ...thread(threadId),
    turns: [
      {
        ...runningTurn(),
        status: "completed",
        completedAt: 1792033210,
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

void i18n.changeLanguage(params.get("lang") ?? "en").then(() => {
  void document.fonts.ready.then(() => {
    document.body.dataset.previewReady = "true";
  });
  if (scene === "auxiliary")
    createRoot(document.getElementById("root")!).render(<AuxiliaryFixture />);
  else createRoot(document.getElementById("root")!).render(<App />);
});
