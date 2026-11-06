import React from "react";
import { createRoot } from "react-dom/client";
import { getAppearanceController } from "../../src/renderer/src/appearance.js";
import { App } from "../../src/renderer/src/App.js";
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
import { nativeRecoveryForThread } from "../native-recovery-fixture.js";
import { encodeModelKey } from "../../../../src/protocol/model-key.js";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import type { Thread } from "../../src/protocol-client/index.js";
type AppServerHostStatus = any;
type ApprovalRequestEvent = any;
type ApprovalResolvedEvent = any;
type NotificationListener = any;
document.documentElement.dataset.platform = "linux";
getAppearanceController();
const ids = Array.from({ length: 32 }, (_, i) => `history-${i + 1}`);
const reads: Record<string, number> = {};
const recoveryGate: { waiting: boolean; release?: () => void } = {
  waiting: false,
};
function payload(id: string, turn: number) {
  let seed = (Number(id.split("-")[1]) * 1009 + turn) | 0;
  let value = `Synthetic ${id} turn ${turn}. `;
  for (let n = 0; n < 160; n++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    value += (seed >>> 0).toString(36) + " ";
  }
  return value;
}
function makeThread(id: string): Thread {
  return {
    ...thread(id),
    name: `Synthetic history ${id.split("-")[1]}`,
    turns: Array.from({ length: 128 }, (_, i) => ({
      ...runningTurn(),
      id: `${id}-turn-${i}`,
      status: "completed",
      completedAt: 20,
      durationMs: 10,
      items: [
        {
          id: `${id}-answer-${i}`,
          type: "agentMessage",
          text: payload(id, i),
          phase: "final_answer",
          memoryCitation: null,
        },
      ],
    })),
  };
}
const options: any = {
  threads: async (archived: boolean) =>
    archived
      ? []
      : ids.map((id) => summary(id, `Synthetic history ${id.split("-")[1]}`)),
  request: async (method: string, params: any) => {
    if (method === "zen/thread/questions/list")
      return { questions: [], totalPending: 0 };
    if (method === "zen/thread/resume") {
      const id = params.threadId;
      if (!ids.includes(id)) throw Error("Unexpected synthetic owner");
      reads[id] = (reads[id] ?? 0) + 1;
      if (id === "history-1" && reads[id] === 2)
        await new Promise<void>((resolve) => {
          recoveryGate.waiting = true;
          recoveryGate.release = () => {
            recoveryGate.waiting = false;
            resolve();
          };
        });
      return nativeRecoveryForThread(makeThread(id));
    }
    throw Error(`Unexpected protocol request: ${method}`);
  },
};
const zenx = {
  information: options.information,
  roomQuestions: options.roomQuestions,
  shellPanel: options.shellPanel,
  workspaceFiles: {
    applications: async () => ({ platform: "linux", applications: {} }),
    read: options.readFile,
  },
  panels: { onOpen: () => () => undefined },
  platform: "darwin",
  threadSidebar: options.sidebarApi,
  protocol: {
    getStatus: async (): Promise<AppServerHostStatus> => ({
      type: "ready",
      reconnected: false,
    }),
    getPendingApprovals: async () =>
      options.getPendingApprovals === undefined
        ? []
        : await options.getPendingApprovals(),
    request: async (method: string, params?: unknown) => {
      options.observeRequest?.(method, params);
      // Existing projection scenarios share full/window recovery fixtures.
      // Observe the raw method above when testing the actual wire route.
      if (method === "zen/thread/resume-window") method = "zen/thread/resume";
      if (method === "model/list") return { data: [model()], nextCursor: null };
      if (method === "zen/initialize") return { processEpoch: "live-epoch" };
      return await options.request(method, params);
    },
    respondToApproval: async () => undefined,
    onApprovalRequest: (listener: (value: ApprovalRequestEvent) => void) =>
      options.onApprovalRequest?.(listener) ?? (() => undefined),
    onApprovalResolved: (listener: (value: ApprovalResolvedEvent) => void) =>
      options.onApprovalResolved?.(listener) ?? (() => undefined),
    onStatus: (listener: (value: AppServerHostStatus) => void) =>
      options.onStatus?.(listener) ?? (() => undefined),
    onNotification: (listener: NotificationListener) =>
      options.onNotification?.(listener) ?? (() => undefined),
  },
  threads: {
    list: async ({ archived = false }: { archived?: boolean } = {}) =>
      options.threads === undefined
        ? archived
          ? []
          : [summary()]
        : await options.threads(archived),
  },
  imageAttachments: {
    pick: async () => [],
    import: async () => [],
    read: async () => new Uint8Array(),
    forThread: async (threadId: string) =>
      options.attachments === undefined
        ? {}
        : await options.attachments(threadId),
  },
  modelUsage: {
    forThread: async (threadId: string) =>
      options.usage === undefined
        ? {
            thread: { responseCount: 0, inputTokens: 0, outputTokens: 0 },
            turns: {},
            context: {
              inputTokens: null,
              inputTokenSource: null,
              contextWindow: null,
              ratio: null,
            },
          }
        : await options.usage(threadId),
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
    onManualCodeRequested: () => () => undefined,
    onChanged: () => () => undefined,
    get: async () => ({
      profile: {
        onboardingComplete: true,
        pinnedThreadIds: [],
        providerProfiles: [],
        defaultModel: { providerProfileId: "fake", modelId: "fake" },
        titleModel: { providerProfileId: "fake", modelId: "fake" },
        workspaces: [],
        workspace: "/work/zen",
      },
      subscription: { authenticated: false, expired: false },
      hasApiKey: false,
      apiKeyProviderProfileIds: [],
    }),
    markWorkspaceUsed: async () => ({
      profile: {
        onboardingComplete: true,
        pinnedThreadIds: [],
        providerProfiles: [],
      },
    }),
  },
  titles: options.titles ?? {
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
    executeCommand: async (
      pluginId: string,
      commandId: string,
      input?: unknown,
    ) => {
      if (options.executeCommand)
        return options.executeCommand(pluginId, commandId, input);
      throw Error(`Unexpected plugin command: ${pluginId}/${commandId}`);
    },
    get: async () =>
      options.pluginSnapshot ?? {
        plugins: [],
        sidebar: [],
        pages: [],
        surfaces: [],
        bundles: [],
      },
    onChange: () => () => undefined,
  },
};

Object.defineProperty(window, "zenx", { value: zenx });
localStorage.setItem("zenx-sidebar-mode", "inbox");
(window as any).__historyAcceptance = {
  ids,
  reads,
  recoveryGate,
  scope:
    "Real production App with generated text and synthetic protocol, no Host, images, GPU attribution or native macOS footprint",
};
createRoot(document.getElementById("root")!).render(<App />);
document.body.dataset.fixtureReady = "true";
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
