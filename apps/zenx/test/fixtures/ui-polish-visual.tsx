import { createChildQuestionData } from "./child-question-data.js";
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
import type { ThreadSummary } from "../../../../src/thread-summary.js";
import type { Thread } from "../../src/protocol-client/index.js";
import { App, WindowTitleBar } from "../../src/renderer/src/App.js";
import { AuxiliaryPanel } from "../../src/renderer/src/auxiliary-panel.js";
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import { encodeModelKey } from "../../../../src/protocol/model-key.js";
import { createUiPolishTitleBridge } from "./ui-polish-title-bridge.js";
import { readNavigationQuestions } from "./ui-polish-visual-navigation.js";
import {
  guardReadingBridge,
  readReadingRequest,
  createReadingApprovalFixture,
  readingBrowserCommand,
} from "./ui-polish-reading.js";
import { codeWrapMarkdown, codeWrapText } from "./code-wrap-content.js";
import { supportingRailsData } from "./supporting-rails-data.js";
import type { NativeInformationApi } from "../../src/native-information.js";
import { installScrollbarVisibility } from "../../src/renderer/src/scrollbar-visibility.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
// Match the production renderer startup; never hide scrollbars only for captures.
installScrollbarVisibility(document);
Object.assign(globalThis, { React });
const params = new URLSearchParams(location.search);
const rails = supportingRailsData(params.get("rails"));
const emptyProjectScene =
  params.get("scene") === "reading" && params.get("emptyProjects") === "1";
const emptyProjectKeys = [
  "/work/zen",
  "/work/design-system",
  "/work/field-notes",
  "/work/research",
  "/work/delivery",
];
if (emptyProjectScene) {
  for (const key of emptyProjectKeys)
    localStorage.setItem(
      `zenx.sidebar.expanded.${encodeURIComponent(`project:${key}`)}`,
      "true",
    );
  localStorage.setItem("zenx.sidebar.expanded.projects", "true");
}
const childQuestionScene =
  params.get("scene") === "reading" && params.get("childQuestions") === "1";
const childQuestionData = childQuestionScene
  ? createChildQuestionData(summary)
  : null;
const questionListeners = new Set<(method: string, params: unknown) => void>();
const readingScene = params.get("scene") === "reading";
const resultScene = readingScene && params.get("results") === "1";
const inlineTraceScene = resultScene && params.get("inlineTrace") === "1";
const codeWrapScene = readingScene && params.get("codeWrap") === "1";
// Independent synthetic keyboard probe; existing scenes retain their exact text.
const tableKeyboardMode =
  readingScene && !codeWrapScene && !resultScene
    ? params.get("tableKeyboard")
    : null;
const tableKeyboardMarkdown = ["plain", "links", "fit"].includes(
  tableKeyboardMode ?? "",
)
  ? (() => {
      const count = tableKeyboardMode === "fit" ? 2 : 16;
      const headers = Array.from({ length: count }, (_, i) => `Field ${i + 1}`);
      const cells = headers.map((_, i) =>
        tableKeyboardMode === "links" && i % 2 === 0
          ? `[Read ${i + 1}](https://example.com/)`
          : `Read ${i + 1}`,
      );
      return [
        "# Synthetic table keyboard probe",
        "",
        `| ${headers.join(" | ")} |`,
        `| ${headers.map(() => "---").join(" | ")} |`,
        `| ${cells.join(" | ")} |`,
      ].join("\n");
    })()
  : undefined;
// This opt-in synthetic probe records writes only; it never reads or writes the OS clipboard.
if (codeWrapScene) {
  const probe = {
    text: codeWrapText,
    copied: [] as string[],
    kind: "synthetic-clipboard-only",
  };
  Object.assign(window, { __codeWrapFixture: probe });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        probe.copied.push(text);
      },
    },
  });
}
const readingPending = readingScene && params.get("pending") === "1";
const readingApprovalFixture = readingScene
  ? createReadingApprovalFixture(readingPending)
  : null;
const projectlessScene = params.get("scene") === "projectless";
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
document.documentElement.dataset.platform = params.get("platform") ?? "win32";
// Slow the same production transition for inspectable intermediate-frame QA.
if (params.has("slowMotion"))
  document.documentElement.style.setProperty("--motion-layout", "1600ms");
let compactions = 0;
// Controlled browser state for toolbar layout; no external site is loaded.
let previewTabs: import("../../src/main/workspace-browser.js").WorkspaceBrowserTab[] =
  [];

const sideConversations = childQuestionData?.rows ?? [
  {
    ...summary("design-child", rails?.children[0] ?? "Design review"),
    parentThreadId: "thread-1",
  },
  {
    ...summary("test-child", rails?.children[1] ?? "Test coverage"),
    parentThreadId: "thread-1",
  },
];
const uiPolishTelemetry = {
  protocolCalls: [] as string[],
  workspaceUsedCalls: 0,
  machineStatusCalls: 0,
  machineCatalogCalls: 0,
  machineThreadCreateCalls: 0,
  sideChatCreateCommandCalls: 0,
  informationReads: [] as { kind: string; id: string }[],
  informationUpdates: 0,
  navigationInputEvents: [] as {
    type: string;
    target: string;
    key?: string;
    trusted: boolean;
  }[],
};
// Deterministic holds for the Side chat UI acceptance scene only. No Host/model calls.
const sideChatFixture = {
  creates: 0,
  sends: 0,
  releaseCreation: () => {},
  releaseAdmission: () => {},
  failAdmission: () => {},
};
const options = {
  request: async (method: string, request?: unknown) => {
    uiPolishTelemetry.protocolCalls.push(method);
    if (readingScene)
      return readReadingRequest(
        method,
        request,
        thread(),
        readingPending,
        codeWrapScene ? codeWrapMarkdown : tableKeyboardMarkdown,
        resultScene,
        inlineTraceScene,
      );
    if (
      params.get("scene") === "navigation" &&
      method === "zen/thread/questions/list"
    )
      return readNavigationQuestions(request);
    if (
      method === "zen/thread/resume" ||
      method === "zen/thread/resume-window"
    ) {
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
    if (method === "zen/thread/read") {
      const threadId =
        (request as { threadId?: string } | undefined)?.threadId ?? "thread-1";
      return {
        thread: resumed(
          threadWithMessage(
            "Synthetic parent read for local side chat draft.",
            threadId,
          ),
        ).thread,
      };
    }
    if (params.get("scene") === "sidechat") {
      if (method === "zen/trace/client-activation") return { observed: true };
      if (method === "zen/thread/create-child-configured") {
        sideChatFixture.creates += 1;
        return await new Promise((resolve) => {
          sideChatFixture.releaseCreation = () =>
            resolve({
              thread: resumed(
                threadWithMessage(
                  "Inherited synthetic parent context.",
                  "sidechat-created",
                ),
              ).thread,
            });
        });
      }
      if (method === "zen/turn/send") {
        sideChatFixture.sends += 1;
        return await new Promise((resolve, reject) => {
          sideChatFixture.releaseAdmission = () => resolve({});
          sideChatFixture.failAdmission = () =>
            reject(new Error("Synthetic send failure; input retained."));
        });
      }
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
      if (readingScene) {
        if (tabId !== undefined || url !== undefined)
          throw new Error("Reading browser list accepts no tab or URL");
        return readingBrowserCommand(threadId, command);
      }
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
    getPendingApprovals: async () =>
      readingApprovalFixture?.getPendingApprovals() ?? [],
    request: async (method: string, params?: unknown) => {
      if (method === "model/list") return { data: [model()], nextCursor: null };
      return await options.request(method, params);
    },
    respondToApproval: async () => {
      if (readingScene)
        throw new Error("Reading preview cannot respond to approvals");
    },
    onApprovalRequest: (
      listener: Parameters<
        ReturnType<typeof createReadingApprovalFixture>["onApprovalRequest"]
      >[0],
    ) =>
      readingApprovalFixture?.onApprovalRequest(listener) ?? (() => undefined),
    onApprovalResolved: (
      listener: Parameters<
        ReturnType<typeof createReadingApprovalFixture>["onApprovalResolved"]
      >[0],
    ) =>
      readingApprovalFixture?.onApprovalResolved(listener) ?? (() => undefined),
    onStatus: () => () => undefined,
    onNotification: (listener: (method: string, params: unknown) => void) => {
      if (!childQuestionScene) return () => undefined;
      questionListeners.add(listener);
      return () => {
        questionListeners.delete(listener);
      };
    },
  },
  threads: {
    list: async ({ archived }: { archived: boolean }) =>
      archived
        ? []
        : [
            ...(params.has("noProjects") ? [] : [summary()]),
            ...(projectlessScene
              ? [summary("projectless-existing", "Trip planning")]
              : []),
            ...(emptyProjectScene
              ? [
                  {
                    ...summary("thread-delivery", "Synthetic delivery check"),
                    currentMetadata: {
                      ...summary().currentMetadata,
                      cwd: "/work/delivery",
                    },
                  },
                ]
              : []),
            ...(params.has("conversationTabs") || childQuestionScene
              ? sideConversations
              : []),
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
      projects: params.has("noProjects")
        ? []
        : [
            {
              key: "/work/zen",
              workspace: "/work/zen",
              name: rails?.project ?? "Zen",
              configured: true,
              isDefault: true,
              threadIds: [
                "thread-1",
                ...(params.has("conversationTabs") || childQuestionScene
                  ? sideConversations.map((entry) => entry.threadId)
                  : []),
              ],
            },
            {
              key: "/work/design-system",
              workspace: "/work/design-system",
              name: emptyProjectScene
                ? "Design system reference library and desktop component catalogue"
                : "Design system",
              configured: true,
              isDefault: false,
              threadIds: [],
            },
            {
              key: "/work/field-notes",
              workspace: "/work/field-notes",
              name: emptyProjectScene
                ? "资料整理与跨项目设计审查参考记录"
                : "Field notes",
              configured: true,
              isDefault: false,
              threadIds: [],
            },
            ...(emptyProjectScene
              ? [
                  {
                    key: "/work/research",
                    workspace: "/work/research",
                    name: "Research",
                    configured: true,
                    isDefault: false,
                    threadIds: [],
                  },
                  {
                    key: "/work/delivery",
                    workspace: "/work/delivery",
                    name: "Delivery",
                    configured: true,
                    isDefault: false,
                    threadIds: ["thread-delivery"],
                  },
                ]
              : []),
          ],
      unavailableThreadIds: [],
      ...(projectlessScene
        ? { projectlessThreadIds: ["projectless-existing"] }
        : {}),
      lastUsedWorkspace: projectlessScene ? null : "/work/zen",
    }),
  },
  settings: {
    get: async () => ({
      profile: {
        onboardingComplete: true,
        pinnedThreadIds: [],
        ...(childQuestionData
          ? {
              visibleSubagentThreadIds: childQuestionData.rows.map(
                (row) => row.threadId,
              ),
            }
          : {}),
        ...(emptyProjectScene
          ? { sidebarOrder: { pinnedProjectKeys: ["/work/design-system"] } }
          : {}),
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
          ...(childQuestionData
            ? {
                visibleSubagentThreadIds: childQuestionData.rows.map(
                  (row) => row.threadId,
                ),
              }
            : {}),
          ...(emptyProjectScene
            ? { sidebarOrder: { pinnedProjectKeys: ["/work/design-system"] } }
            : {}),
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
  titles: createUiPolishTitleBridge(),
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
              label: "Design and prototyping MacBook Pro for the visual QA lab",
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
    catalog: async (id: string) => {
      uiPolishTelemetry.machineCatalogCalls += 1;
      return {
        machine: {
          id,
          key: `synthetic-key-${id}`,
          hostId: "synthetic-host",
          label: "Design and prototyping MacBook Pro for the visual QA lab",
          description: "Synthetic QA target; no connection is attempted.",
          access: "read" as const,
          shellEnabled: false,
        },
        workspaces: [
          { id: "synthetic-workspace", label: "Synthetic workspace" },
        ],
        models: [
          {
            id: "fake::fake",
            label: "Local demo",
            isDefault: true,
            efforts: ["medium"],
            defaultEffort: "medium",
          },
        ],
        preferredWorkspace: "synthetic-workspace",
      };
    },
    listThreads: async () => ({ threads: [], truncated: false }),
    createThread: async (input: {
      deviceId: string;
      deviceKey: string;
      workspace: string;
    }) => {
      uiPolishTelemetry.machineThreadCreateCalls += 1;
      return {
        ...input,
        hostId: "synthetic-host",
        threadId: "synthetic-never-created",
      };
    },
    readThread: async () => ({}),
    threadStatus: async () => ({ status: "idle" }),
    sendThread: async () => ({}),
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
if (readingScene || params.has("launchers") || params.has("conversationTabs")) {
  Object.assign(zenx.plugins, {
    get: async () =>
      rails
        ? {
            ...workspaceLauncherSnapshot,
            plugins: workspaceLauncherSnapshot.plugins.map((plugin) =>
              plugin.id === "zenx-triggers"
                ? { ...plugin, admissionId: "synthetic-rails-triggers" }
                : plugin,
            ),
            commands: [
              ...workspaceLauncherSnapshot.commands,
              {
                key: "zenx-triggers:sidebar-facts",
                pluginId: "zenx-triggers",
                id: "sidebar-facts",
                title: "Synthetic trigger facts",
                tool: "zenx_triggers_sidebar_facts",
              },
            ],
          }
        : workspaceLauncherSnapshot,
    executeCommand: async (pluginId: string, command: string) => {
      if (
        readingScene &&
        !(pluginId === "zenx-subagents" && command === "list") &&
        !(rails && pluginId === "zenx-triggers" && command === "sidebar-facts")
      )
        throw new Error("Reading preview only admits subagent list");
      if (pluginId === "zenx-subagents") {
        if (command === "list")
          return {
            threads:
              readingScene || params.has("conversationTabs")
                ? sideConversations
                : [],
          };
        if (command === "create") {
          uiPolishTelemetry.sideChatCreateCommandCalls += 1;
          return { threadId: "synthetic-side-chat" };
        }
      }
      if (rails && pluginId === "zenx-triggers" && command === "sidebar-facts")
        return { triggers: structuredClone(rails.triggers) };
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
if (params.get("scene") === "navigation" || readingScene) {
  // Observe native input only on navigation controls, never collect editor text.
  for (const type of ["keydown", "keypress", "keyup", "click"]) {
    document.addEventListener(type, (event) => {
      const element =
        event.target instanceof Element ? event.target.closest("button") : null;
      const target = element?.matches(".information-toolbar button")
        ? "entry"
        : element?.matches(".information-dismiss-toolbar button")
          ? "close"
          : element?.matches(".projects-section-toggle")
            ? "projects"
            : element?.matches(".recent-thread-group .thread-row")
              ? "recent"
              : null;
      if (!target) return;
      uiPolishTelemetry.navigationInputEvents.push({
        type,
        target,
        ...(event instanceof KeyboardEvent ? { key: event.key } : {}),
        trusted: event.isTrusted,
      });
      if (uiPolishTelemetry.navigationInputEvents.length > 80)
        uiPolishTelemetry.navigationInputEvents.shift();
    });
  }
  // Read-only synthetic Host data. Opening/closing/focus remain production App UI.
  const information: NativeInformationApi = {
    read: async (owner) => {
      if (
        typeof owner === "string" ||
        owner.kind !== "thread" ||
        owner.id !== "thread-1"
      )
        throw new Error("Unexpected synthetic information owner");
      uiPolishTelemetry.informationReads.push({ ...owner });
      return {
        owner,
        revision: 0,
        basis: "synthetic-navigation",
        members: [],
        resourceThreadId: owner.id,
        layout: rails?.layout ?? {
          version: 1,
          widgets: [
            {
              id: "synthetic-lineage",
              type: "lineage",
              binding: { kind: "owner" },
              visible: true,
              collapsed: false,
              config: {},
            },
          ],
        },
      };
    },
    update: async () => {
      uiPolishTelemetry.informationUpdates += 1;
      throw new Error("Navigation preview does not admit information edits");
    },
  };
  Object.assign(zenx, { information });
}
Object.defineProperty(window, "zenx", {
  value: readingScene ? guardReadingBridge(zenx) : zenx,
});
Object.assign(window, {
  __uiPolishTelemetry: uiPolishTelemetry,
  __sideChatFixture: sideChatFixture,
});
if (childQuestionData) {
  let watermark = 0;
  Object.assign(window, {
    __childQuestionFixture: {
      clear() {
        const receipt = childQuestionData.clear();
        for (const threadId of receipt.threadIds) {
          const event = {
            processEpoch: "synthetic-child-question-host",
            threadId,
            watermark: ++watermark,
            event: { type: "user_question_attention_invalidated", threadId },
          } satisfies import("../../src/protocol-client/index.js").ServerNotificationParams["zen/thread/event"];
          for (const listener of questionListeners)
            listener("zen/thread/event", event);
        }
        return { ...receipt, listenerCount: questionListeners.size, watermark };
      },
    },
  });
}
if (readingApprovalFixture)
  Object.assign(window, {
    __readingApprovalFixture: {
      replaceRequest: readingApprovalFixture.replaceRequest,
    },
  });
localStorage.setItem("zenx-sidebar-mode", "projects");
const scene = params.get("scene") ?? "welcome";

function SideChatFixture() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <aside
        aria-label="Synthetic side-chat controls"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          padding: 10,
          borderBottom: "1px solid var(--color-border-subtle)",
          background: "var(--color-surface-control)",
          fontSize: 12,
        }}
      >
        <strong>Synthetic controls · no Host or model</strong>
        <button
          data-testid="sidechat-release-creation"
          onClick={() => sideChatFixture.releaseCreation()}
        >
          Release creation
        </button>
        <button
          data-testid="sidechat-fail-send"
          onClick={() => sideChatFixture.failAdmission()}
        >
          Fail send
        </button>
        <button
          data-testid="sidechat-resolve-send"
          onClick={() => sideChatFixture.releaseAdmission()}
        >
          Resolve send
        </button>
        <button onClick={() => location.reload()}>Reset fixture</button>
      </aside>
      <div style={{ minWidth: 0, minHeight: 0 }}>
        <App />
      </div>
    </div>
  );
}

function AuxiliaryFixture() {
  // Test-only synthetic entries use the genuine side-conversation tab path.
  const lookalike = params.get("tabLookalike");
  const pairTitles =
    lookalike === "en"
      ? [
          "Cross-project implementation consistency and detailed interaction validation - Alpha",
          "Cross-project implementation consistency and detailed interaction validation - Beta",
        ]
      : lookalike === "zh"
        ? [
            "跨项目实施一致性与详细交互验证甲组",
            "跨项目实施一致性与详细交互验证乙组",
          ]
        : null;
  // Opt-in desktop overflow scene; the original two-conversation cases are unchanged.
  const lookalikeTitles =
    params.has("tabCrowded") && pairTitles
      ? [
          ...pairTitles,
          ...["Gamma", "Delta", "Epsilon"].map(
            (suffix) => `${pairTitles[0]} · ${suffix}`,
          ),
        ]
      : pairTitles;
  const conversations = (lookalikeTitles ?? []).map((title, index) => ({
    threadId: `synthetic-lookalike-${index}`,
    title,
    render: (threadId: string) => (
      <div style={{ padding: 24 }} data-synthetic-thread-id={threadId}>
        <p>
          Synthetic read-only conversation. No account, approval or rename
          action.
        </p>
      </div>
    ),
  }));
  const discovery = params.has("tabDiscovery") || lookalikeTitles !== null;
  const [collapsed, setCollapsed] = React.useState(window.innerWidth <= 720);
  const [width, setWidth] = React.useState(520);
  const [selected, setSelected] = React.useState(
    lookalikeTitles ? "thread:synthetic-lookalike-1" : "custom:browser",
  );
  const [order, setOrder] = React.useState(
    lookalikeTitles
      ? conversations.map(({ threadId }) => `thread:${threadId}`)
      : discovery
        ? ["custom:files", "custom:browser"]
        : [
            "custom:files",
            "custom:browser",
            "custom:computer",
            "custom:subagents",
            "custom:triggers",
          ],
  );
  const writes = React.useRef<string[][]>([]);
  const openChangeRequests = React.useRef<boolean[]>([]);
  const customTabs = [
    ["files", discovery ? "项目反馈汇总与下一阶段计划" : "PLAN.md", "file"],
    [
      "browser",
      discovery ? "协作工作流与表单发布检查" : "Browser",
      discovery ? "users" : "browser",
    ],
    ["computer", "Computer", "computer"],
    ["subagents", "Subagents", "users"],
    ["triggers", "Triggers", "trigger"],
  ] as const;
  React.useEffect(() => {
    Object.assign(window, {
      __uiPolishAuxiliary: {
        getState: () => ({
          order,
          selected,
          writes: writes.current,
          openChangeRequests: openChangeRequests.current,
          sourceConversations: conversations.map(({ threadId, title }) => ({
            threadId,
            title,
          })),
        }),
      },
    });
  }, [order, selected]);
  return (
    <div
      className={`app-shell ${collapsed ? "sidebar-collapsed" : "sidebar-open"}`}
      style={{ "--workspace-panel-width": `${width}px` } as React.CSSProperties}
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
            <h1>
              {discovery
                ? "Workspace tab discoverability"
                : "Auxiliary tab reorder"}
            </h1>
            <p>Production AuxiliaryPanel with synthetic tabs and content.</p>
          </div>
        </section>
        <AuxiliaryPanel
          threadId="synthetic-ui-polish-thread"
          title="Synthetic workspace"
          open
          onOpenChange={(next) => {
            if (lookalikeTitles) openChangeRequests.current.push(next);
          }}
          onWidthChange={setWidth}
          snapshot={null}
          selectedTab={selected}
          onSelectTab={setSelected}
          openedTabs={order}
          onTabsChange={(next) => {
            writes.current.push(next);
            setOrder(next);
          }}
          conversations={conversations}
          customTabs={(lookalikeTitles ? [] : customTabs).map(
            ([id, title, icon]) => ({
              id,
              title,
              icon,
              render: () => (
                <div style={{ padding: 24 }}>
                  <h2>{title}</h2>
                  <p>
                    Synthetic preview data only. No Host, model, or network.
                  </p>
                </div>
              ),
            }),
          )}
        />
        {discovery ? (
          <div className="information-toolbar">
            <button
              className="icon-button"
              title="Synthetic information control"
              aria-label="Synthetic information control"
            >
              ≡
            </button>
          </div>
        ) : null}
        <span className="sr-only" aria-hidden="true">
          {width}
        </span>
      </main>
    </div>
  );
}

function summary(
  threadId = "thread-1",
  name = rails?.thread ?? "Thread one",
): ThreadSummary {
  return {
    threadId,
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd:
        threadId === "projectless-existing"
          ? "/synthetic/Documents/ZenX/2026-10-27/trip-planning"
          : "/work/zen",
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
    name:
      threadId === "thread-1" ? (rails?.thread ?? "Thread one") : "Thread two",
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
  else if (scene === "sidechat")
    createRoot(document.getElementById("root")!).render(<SideChatFixture />);
  else createRoot(document.getElementById("root")!).render(<App />);
});
