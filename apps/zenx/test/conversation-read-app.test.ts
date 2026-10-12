import "./dom-primitives.js";
/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { ModelUsageProjection } from "../../../src/model-usage.js";
import type {
  NativeThreadSummary,
  ThreadSummary,
} from "../../../src/thread-summary.js";
import type {
  AppServerHostStatus,
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "../src/main/app-server-manager.js";
import type { ZenXThreadAttachmentProjection } from "../src/main/image-attachments.js";
import type {
  ServerNotificationMethod,
  ServerNotificationParams,
  Thread,
} from "../src/protocol-client/index.js";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { App } from "../src/renderer/src/App.js";
import { pluginUiRegistry } from "../src/renderer/src/PluginProductPage.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { nativeRecoveryForThread } from "./native-recovery-fixture.js";
import { encodeModelKey } from "../../../src/protocol/codex/model-key.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });

type NotificationListener = <M extends ServerNotificationMethod>(
  method: M,
  params: ServerNotificationParams[M],
) => void;
interface MountOptions {
  seedMarks?: string;
  executeCommand?(...args: unknown[]): Promise<unknown>;
  pluginSnapshot?: ZenXPluginSnapshot;
  request(method: string, params?: unknown): Promise<unknown>;
  attachments?(threadId: string): Promise<ZenXThreadAttachmentProjection>;
  usage?(threadId: string): Promise<ModelUsageProjection>;
  threads?(archived: boolean): Promise<NativeThreadSummary[]>;
  getPendingApprovals?(): Promise<ApprovalRequestEvent[]>;
  onStatus?(listener: (value: AppServerHostStatus) => void): () => void;
  onNotification?(listener: NotificationListener): () => void;
  onApprovalRequest?(
    listener: (value: ApprovalRequestEvent) => void,
  ): () => void;
  onApprovalResolved?(
    listener: (value: ApprovalResolvedEvent) => void,
  ): () => void;
}

async function mountApp(options: MountOptions) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperties(dom.window.HTMLInputElement.prototype, {
    attachEvent: { value: () => undefined },
    detachEvent: { value: () => undefined },
  });
  const zenx = {
    panels: { onOpen: () => () => undefined },
    platform: "darwin",
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
        if (method === "model/list")
          return { data: [model()], nextCursor: null };
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
      list: async (
        { archived }: { archived: boolean } = { archived: false },
      ) =>
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
      executeCommand: (...args: unknown[]) =>
        options.executeCommand?.(...args) ?? Promise.resolve({ rooms: [] }),
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
  Object.defineProperty(dom.window, "zenx", { value: zenx });
  dom.window.localStorage.setItem("zenx-sidebar-mode", "inbox");
  const container = document.getElementById("root");
  assert.ok(container);
  if (options.seedMarks !== undefined)
    dom.window.localStorage.setItem(
      "zenx.conversation-read-watermarks.v2",
      options.seedMarks,
    );
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(App));
    await Promise.resolve();
  });
  return {
    unmount: async () => {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous, {
        IS_REACT_ACT_ENVIRONMENT: undefined,
      });
      dom.window.close();
    },
  };
}

function summary(threadId = "thread-1", name = "Thread one"): ThreadSummary {
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
    completedAnswer: null,
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

function nativeEvent(
  watermark: number,
  event: ServerNotificationParams["zen/thread/event"]["event"],
): ServerNotificationParams["zen/thread/event"] {
  return {
    processEpoch: "test-process-epoch",
    threadId: "thread-1",
    watermark,
    event,
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

async function waitFor<T>(read: () => T | null | undefined | false) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("Timed out waiting for renderer projection");
}

function testPlugin(id = "route-harness", realRoom = false) {
  const route =
    id === "zenx-rooms"
      ? "/plugins/zenx-rooms/rooms"
      : "/plugins/route-harness/home";
  const dispose = pluginUiRegistry.registerTrusted("route-harness-ui", {
    overview: realRoom
      ? RoomsPage
      : ({ sdk }) =>
          createElement(
            "div",
            {},
            createElement(
              "p",
              { "data-testid": "plugin-route" },
              String(sdk.context.route),
            ),
            createElement(
              "button",
              {
                onClick: () =>
                  sdk.navigation.navigate(
                    `${route}?setup=room-reply&roomId=one`,
                  ),
              },
              "Open setup intent",
            ),
          ),
  });
  const pluginSnapshot = {
    plugins: [
      {
        id: id,
        displayName: "Route harness",
        enabled: true,
        available: true,
        lifecycle: "enabled",
        contributionCount: 1,
        version: "1",
        source: "bundled",
      },
    ],
    pages: [
      {
        key: "route-harness:home",
        pluginId: id,
        id: "home",
        title: "Route harness",
        route,
        surfaceId: "overview",
      },
    ],
    sidebar: [
      {
        key: "route-harness:home",
        pluginId: id,
        id: "home",
        label: "Route harness",
        icon: "plug",
        pageId: "home",
      },
    ],
    bundles: [
      {
        key: "route-harness:main",
        pluginId: id,
        id: "main",
        apiVersion: 1,
        kind: "trusted",
        entry: "route-harness-ui",
      },
    ],
    surfaces: [
      {
        key: "route-harness:overview",
        pluginId: id,
        id: "overview",
        bundleId: "main",
        exportName: "overview",
      },
    ],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
  } as ZenXPluginSnapshot;

  return { pluginSnapshot, dispose };
}

test("selected Thread must become unread after navigating to a plugin", async () => {
  const plugin = testPlugin();
  let current = summary();
  let notify: NotificationListener | undefined;
  const harness = await mountApp({
    pluginSnapshot: plugin.pluginSnapshot,
    request: async () => resumed(thread()),
    threads: async (archived) => (archived ? [] : [current]),
    onNotification: (listener) => {
      notify = listener;
      return () => {};
    },
  });
  try {
    await act(async () =>
      (
        await waitFor(() =>
          document.querySelector<HTMLButtonElement>(".thread-row"),
        )
      ).click(),
    );
    await act(async () =>
      (
        await waitFor(() =>
          document.querySelector<HTMLButtonElement>(
            '.plugin-space-link[title="Route harness"]',
          ),
        )
      ).click(),
    );
    assert.ok(
      document.querySelector('[data-testid="plugin-route"]'),
      "plugin is visible, not Thread",
    );
    current = {
      ...current,
      updatedAt: new Date(3000).toISOString(),
      completedAnswer: { itemId: "new-final", position: 4 },
    };
    await act(async () => {
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "item_completed",
          item: {
            id: "new-final",
            type: "agent_message",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: current.updatedAt!,
            text: "New final answer",
          },
        }),
      );
    });
    assert.ok(
      document.querySelector('[data-thread-id="thread-1"] .unread-dot'),
      "new background answer must show unread",
    );
  } finally {
    await harness.unmount();
    plugin.dispose();
  }
});

test("known empty Room should become unread on its first message", async () => {
  const plugin = testPlugin("zenx-rooms");
  let messages: unknown[] = [];
  const harness = await mountApp({
    pluginSnapshot: plugin.pluginSnapshot,
    request: async () => resumed(thread()),
    executeCommand: async () => ({
      rooms: [{ id: "room-1", name: "First room", members: [], messages }],
    }),
  });
  try {
    await waitFor(() =>
      document.querySelector('[aria-label="Open room First room"]'),
    );
    assert.equal(document.querySelector(".room-conversation-unread"), null);
    messages = [
      {
        id: "first-message",
        text: "First incoming answer",
        createdAt: 3000,
        author: "Agent",
        kind: "message",
      },
    ];
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3100));
    });
    assert.match(document.body.textContent!, /First incoming answer/);
    assert.ok(
      document.querySelector(".room-conversation-unread"),
      "existing empty Room is known; first incoming message must be unread",
    );
  } finally {
    await harness.unmount();
    plugin.dispose();
  }
});

test("metadata-only background change should not create unread", async () => {
  let current = summary();
  let notify: NotificationListener | undefined;
  const plugin = testPlugin();
  const harness = await mountApp({
    pluginSnapshot: plugin.pluginSnapshot,
    request: async () => resumed(thread()),
    threads: async (archived) => (archived ? [] : [current]),
    onNotification: (listener) => {
      notify = listener;
      return () => {};
    },
  });
  try {
    await waitFor(() => document.querySelector(".thread-row"));
    assert.equal(Boolean(document.querySelector(".unread-dot")), false);
    current = { ...current, updatedAt: new Date(3000).toISOString() };
    await act(async () => {
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "item_completed",
          item: {
            id: "settings-item",
            type: "thread_configuration_changed",
            threadId: "thread-1",
            createdAt: current.updatedAt!,
            selection: {
              from: {
                providerProfileId: "fake",
                modelId: "fake",
                reasoningEffort: null,
              },
              to: {
                providerProfileId: "fake",
                modelId: "other",
                reasoningEffort: null,
              },
            },
          },
        }),
      );
    });
    assert.equal(
      Boolean(document.querySelector(".unread-dot")),
      false,
      "configuration change has no new readable message",
    );
  } finally {
    await harness.unmount();
    plugin.dispose();
  }
});

test("failed resume must not consume an unread answer", async () => {
  let current = summary();
  let notify: NotificationListener | undefined;
  const plugin = testPlugin();
  const harness = await mountApp({
    pluginSnapshot: plugin.pluginSnapshot,
    request: async () => {
      throw Error("Resume unavailable");
    },
    threads: async (archived) => (archived ? [] : [current]),
    onNotification: (listener) => {
      notify = listener;
      return () => {};
    },
  });
  try {
    await waitFor(() => document.querySelector(".thread-row"));
    current = {
      ...current,
      updatedAt: new Date(3000).toISOString(),
      completedAnswer: { itemId: "final", position: 4 },
    };
    await act(async () => {
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "item_completed",
          item: {
            id: "final",
            type: "agent_message",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: current.updatedAt!,
            text: "Unread answer",
          },
        }),
      );
    });
    assert.ok(document.querySelector(".unread-dot"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")!.click(),
    );
    assert.match(document.body.textContent!, /Resume unavailable/);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")!.click(),
    );
    assert.ok(
      document.querySelector(".unread-dot"),
      "answer was never rendered so unread should remain after leaving",
    );
  } finally {
    await harness.unmount();
    plugin.dispose();
  }
});

test("tokens per second preserve canonical subsecond timing", async () => {
  const { projectNativeRecovery } =
    await import("../src/renderer/src/thread-view-state.js");
  const { turnOutputRatePerSecond, threadOutputRatePerSecond } =
    await import("../src/renderer/src/ThreadView.js");
  const wire = thread();
  wire.turns = [
    {
      id: "turn-1",
      items: [],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 10.9,
      completedAt: 11.1,
      durationMs: 200,
    },
  ];
  const canonical = nativeRecoveryForThread(wire);
  const projected = projectNativeRecovery(canonical);
  const usage = { responseCount: 1, inputTokens: 1, outputTokens: 100 };
  const projection = {
    thread: usage,
    turns: { "turn-1": usage },
    context: {
      inputTokens: 1,
      inputTokenSource: "provider" as const,
      contextWindow: 1000,
      ratio: 0.001,
    },
  };
  const got = turnOutputRatePerSecond(usage, projected.turns[0]!);
  assert.equal(
    got,
    500,
    "100 tokens over canonical 200 ms must report 500 tok/s",
  );
});

test("background answer survives remount and clears after successful open", async () => {
  const plugin = testPlugin();
  let notify: NotificationListener | undefined;
  let current = summary();
  const options = {
    pluginSnapshot: plugin.pluginSnapshot,
    request: async () => resumed(answeredThread()),
    threads: async (archived: boolean) => (archived ? [] : [current]),
    onNotification: (listener: NotificationListener) => {
      notify = listener;
      return () => {};
    },
  };
  let harness = await mountApp(options);
  try {
    await waitFor(() => document.querySelector(".thread-row"));
    assert.equal(
      Boolean(document.querySelector(".unread-dot")),
      false,
      "first-seen thread baselined read",
    );
    current = {
      ...current,
      updatedAt: new Date(3000).toISOString(),
      completedAnswer: { itemId: "final", position: 4 },
    };
    await act(async () =>
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "item_completed",
          item: {
            id: "final",
            type: "agent_message",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: current.updatedAt!,
            text: "New answer",
          },
        }),
      ),
    );
    assert.ok(
      document.querySelector(".unread-dot"),
      "unselected background answer is unread",
    );
    const seedMarks = window.localStorage.getItem(
      "zenx.conversation-read-watermarks.v2",
    )!;
    assert.equal(JSON.parse(seedMarks)["t:thread-1"], 0);
    await harness.unmount();
    harness = await mountApp({ ...options, seedMarks });
    await waitFor(() => document.querySelector(".thread-row"));
    assert.ok(
      document.querySelector(".unread-dot"),
      "persisted unread survives remount",
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")!.click(),
    );
    assert.equal(Boolean(document.querySelector(".unread-dot")), false);
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("zenx.conversation-read-watermarks.v2")!,
      )["t:thread-1"],
      4,
    );
  } finally {
    await harness.unmount();
    plugin.dispose();
  }
});

function answeredThread(): Thread {
  const result = thread();
  result.turns = [
    {
      id: "turn-1",
      items: [
        {
          type: "agentMessage",
          id: "final",
          text: "New answer",
          phase: "final_answer",
          memoryCitation: null,
        },
      ],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 3,
      durationMs: 2000,
    },
  ];
  return result;
}

test("unfinished recovery and a completed recovery arriving after navigation do not consume unread", async () => {
  const plugin = testPlugin();
  let complete!: (value: ReturnType<typeof resumed>) => void;
  const waiting = new Promise<ReturnType<typeof resumed>>((resolve) => {
    complete = resolve;
  });
  const current = {
    ...summary(),
    completedAnswer: { itemId: "final", position: 4 },
  };
  const harness = await mountApp({
    pluginSnapshot: plugin.pluginSnapshot,
    seedMarks: '{"t:thread-1":0}',
    request: async () => waiting,
    threads: async (archived) => (archived ? [] : [current]),
  });
  try {
    await waitFor(() => document.querySelector(".thread-row"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")!.click(),
    );
    assert.ok(
      document.querySelector(".unread-dot"),
      "pending resume is not displayed content",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '.plugin-space-link[title="Route harness"]',
        )!
        .click(),
    );
    await act(async () => complete(resumed(answeredThread())));
    assert.ok(
      document.querySelector(".unread-dot"),
      "late hidden recovery cannot acknowledge",
    );
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("zenx.conversation-read-watermarks.v2")!,
      )["t:thread-1"],
      0,
    );
  } finally {
    await harness.unmount();
    plugin.dispose();
  }
});

test("a loaded older prefix cannot acknowledge a newer listed answer", async () => {
  const current = {
    ...summary(),
    completedAnswer: { itemId: "newer", position: 8 },
  };
  const harness = await mountApp({
    seedMarks: '{"t:thread-1":0}',
    request: async () => resumed(answeredThread()),
    threads: async (archived) => (archived ? [] : [current]),
  });
  try {
    await waitFor(() => document.querySelector(".thread-row"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")!.click(),
    );
    assert.ok(document.querySelector(".unread-dot"));
    assert.ok(
      JSON.parse(
        window.localStorage.getItem("zenx.conversation-read-watermarks.v2")!,
      )["t:thread-1"] < 8,
    );
  } finally {
    await harness.unmount();
  }
});

test("visible live completion acknowledges the exact final Item despite omitted control events", async () => {
  let current = summary();
  let notify: NotificationListener | undefined;
  const harness = await mountApp({
    request: async () => resumed(thread()),
    threads: async (archived) => (archived ? [] : [current]),
    onNotification: (listener) => {
      notify = listener;
      return () => {};
    },
  });
  try {
    await waitFor(() => document.querySelector(".thread-row"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")!.click(),
    );
    current = { ...current, completedAnswer: { itemId: "live", position: 10 } };
    await act(async () => {
      notify?.(
        "zen/thread/event",
        nativeEvent(1, {
          type: "turn_started",
          threadId: "thread-1",
          turnId: "turn-1",
        }),
      );
      notify?.(
        "zen/thread/event",
        nativeEvent(2, {
          type: "item_completed",
          item: {
            id: "live",
            type: "agent_message",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: new Date(3000).toISOString(),
            text: "A live answer",
          },
        }),
      );
      notify?.(
        "zen/thread/event",
        nativeEvent(3, {
          type: "turn_completed",
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
        }),
      );
    });
    assert.equal(document.querySelector(".unread-dot"), null);
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("zenx.conversation-read-watermarks.v2")!,
      )["t:thread-1"],
      10,
    );
  } finally {
    await harness.unmount();
  }
});

test("native engines without readable summary evidence stay unknown", async () => {
  const current = { ...summary(), completedAnswer: undefined };
  const harness = await mountApp({
    request: async () => resumed(thread()),
    threads: async (archived) => (archived ? [] : [current]),
  });
  try {
    await waitFor(() => document.querySelector(".thread-row"));
    assert.equal(document.querySelector(".unread-dot"), null);
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("zenx.conversation-read-watermarks.v2")!,
      )["t:thread-1"],
      undefined,
    );
  } finally {
    await harness.unmount();
  }
});

test("same-second Turn duration remains precise and absent duration stays Unknown", async () => {
  const { projectNativeRecovery, applyNativeThreadEvent } =
    await import("../src/renderer/src/thread-view-state.js");
  const { turnOutputRatePerSecond, threadOutputRatePerSecond } =
    await import("../src/renderer/src/ThreadView.js");
  const wire = answeredThread();
  wire.turns[0] = {
    ...wire.turns[0]!,
    startedAt: 10.1,
    completedAt: 10.3,
    durationMs: 200,
  };
  const projected = projectNativeRecovery(nativeRecoveryForThread(wire));
  const usage = { responseCount: 1, inputTokens: 1, outputTokens: 100 };
  assert.equal(projected.turns[0]!.durationMs, 200);
  assert.equal(turnOutputRatePerSecond(usage, projected.turns[0]!), 500);
  for (const durationMs of [null, 0, -1, NaN, Infinity])
    assert.equal(
      turnOutputRatePerSecond(usage, { ...projected.turns[0]!, durationMs }),
      null,
    );
  let live = projectNativeRecovery(nativeRecoveryForThread(thread()));
  live = applyNativeThreadEvent(
    live,
    { type: "turn_started", threadId: "thread-1", turnId: "live" },
    10,
  );
  live = applyNativeThreadEvent(
    live,
    {
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "live",
      status: "completed",
    },
    11,
  );
  assert.equal(
    turnOutputRatePerSecond(usage, live.turns[0]!),
    null,
    "receipt-time timestamps cannot invent a duration",
  );
  const projection = {
    thread: usage,
    turns: { "turn-1": usage, live: usage },
    context: {
      inputTokens: null,
      inputTokenSource: null,
      contextWindow: null,
      ratio: null,
    },
  };
  assert.equal(
    threadOutputRatePerSecond(
      { ...projected, turns: [...projected.turns, ...live.turns] },
      projection,
    ),
    500,
    "only matched usage and precise duration contribute",
  );
});

test("same-time Room identities stay unread through failed and stale saturated-history loads", async () => {
  const plugin = testPlugin("zenx-rooms", true);
  const oldMessage = {
    id: "z-old",
    roomId: "room-1",
    text: "Earlier answer",
    createdAt: 5000,
    author: "Bot",
    kind: "agent",
  };
  const newMessage = {
    ...oldMessage,
    id: "a-new",
    text: "New answer at the same time",
  };
  let history: "failure" | "old" | "new" = "failure";
  const room = {
    id: "room-1",
    name: "Saturated room",
    members: [],
    messages: [newMessage],
    messageCount: 1000,
    createdAt: 1,
  };
  const harness = await mountApp({
    pluginSnapshot: plugin.pluginSnapshot,
    seedMarks: '{"r:room-1":"z-old"}',
    request: async () => resumed(thread()),
    executeCommand: async (_plugin, command) => {
      if (command === "list") return { rooms: [structuredClone(room)] };
      if (command === "messages") {
        if (history === "failure") throw Error("Room history unavailable");
        return {
          messages: [history === "old" ? oldMessage : newMessage],
          nextCursor: null,
        };
      }
      throw Error(String(command));
    },
  });
  try {
    const button = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Open room Saturated room"]',
      ),
    );
    assert.ok(
      document.querySelector(".room-conversation-unread"),
      "new ID differs despite identical timestamp and saturated retained count",
    );
    await act(async () => button.click());
    assert.ok(
      document.querySelector(".room-conversation-unread"),
      "failed Room load must preserve unread",
    );
    history = "old";
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")!.click(),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open room Saturated room"]',
        )!
        .click(),
    );
    await waitFor(() => document.querySelector(".room-message"));
    assert.match(
      document.querySelector(".rooms-chat-feed")!.textContent!,
      /Earlier answer/,
    );
    assert.ok(
      document.querySelector(".room-conversation-unread"),
      "older loaded tail cannot acknowledge the current navigation tail",
    );
    history = "new";
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3100));
    });
    assert.match(
      document.querySelector(".rooms-chat-feed")!.textContent!,
      /New answer at the same time/,
    );
    assert.equal(document.querySelector(".room-conversation-unread"), null);
    assert.equal(
      JSON.parse(
        window.localStorage.getItem("zenx.conversation-read-watermarks.v2")!,
      )["r:room-1"],
      "a-new",
    );
  } finally {
    await harness.unmount();
    plugin.dispose();
  }
});

for (const hostStatus of [
  { type: "ready", reconnected: false },
  { type: "error", message: "Runtime process exited" },
  { type: "stopped" },
  { type: "starting" },
  { type: "reconnecting", attempt: 1, delayMs: 50 },
] satisfies AppServerHostStatus[]) {
  const serverReady = hostStatus.type === "ready";
  test(`R2 cached unread answer is acknowledged only when rendered: status=${hostStatus.type}`, async () => {
    const plugin = testPlugin();
    let current = summary();
    let notify: NotificationListener | undefined;
    let status: ((value: AppServerHostStatus) => void) | undefined;
    let resumeCount = 0;
    const harness = await mountApp({
      pluginSnapshot: plugin.pluginSnapshot,
      request: async () => {
        resumeCount += 1;
        if (resumeCount === 1) return resumed(thread());
        return new Promise(() => {});
      },
      threads: async (archived) => (archived ? [] : [current]),
      onNotification: (listener) => {
        notify = listener;
        return () => {};
      },
      onStatus: (listener) => {
        status = listener;
        return () => {};
      },
    });
    try {
      await act(async () =>
        (
          await waitFor(() =>
            document.querySelector<HTMLButtonElement>(".thread-row"),
          )
        ).click(),
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            '.plugin-space-link[title="Route harness"]',
          )!
          .click(),
      );
      current = {
        ...current,
        completedAnswer: { itemId: "r2-hidden-final", position: 4 },
      };
      await act(async () => {
        notify?.(
          "zen/thread/event",
          nativeEvent(1, {
            type: "turn_started",
            threadId: "thread-1",
            turnId: "turn-r2",
          }),
        );
        notify?.(
          "zen/thread/event",
          nativeEvent(2, {
            type: "item_completed",
            item: {
              id: "r2-hidden-final",
              type: "agent_message",
              threadId: "thread-1",
              turnId: "turn-r2",
              createdAt: new Date(3000).toISOString(),
              text: "This answer has never been shown",
            },
          }),
        );
        notify?.(
          "zen/thread/event",
          nativeEvent(3, {
            type: "turn_completed",
            threadId: "thread-1",
            turnId: "turn-r2",
            status: "completed",
          }),
        );
      });
      assert.ok(
        document.querySelector(".unread-dot"),
        "background answer is initially unread",
      );
      assert.equal(
        JSON.parse(
          window.localStorage.getItem("zenx.conversation-read-watermarks.v2")!,
        )["t:thread-1"],
        0,
      );
      await act(async () => {
        document.querySelector<HTMLButtonElement>(".thread-row")!.click();
        if (!serverReady) status?.(hostStatus);
      });
      const rendered = document.querySelector(".agent-surface")!.textContent!;
      if (serverReady)
        assert.match(rendered, /This answer has never been shown/);
      else {
        if (hostStatus.type === "error")
          assert.match(rendered, /Runtime process exited/);
        assert.doesNotMatch(rendered, /This answer has never been shown/);
      }
      const mark = JSON.parse(
        window.localStorage.getItem("zenx.conversation-read-watermarks.v2")!,
      )["t:thread-1"];
      assert.equal(
        mark,
        serverReady ? 4 : 0,
        `read watermark must reflect rendered transcript (serverReady=${serverReady})`,
      );
      if (!serverReady) {
        await act(async () => status?.({ type: "ready", reconnected: false }));
        assert.match(
          document.querySelector(".agent-surface")!.textContent!,
          /This answer has never been shown/,
        );
        assert.equal(
          JSON.parse(
            window.localStorage.getItem(
              "zenx.conversation-read-watermarks.v2",
            )!,
          )["t:thread-1"],
          4,
          "ready rendered cached content can finally acknowledge",
        );
      }
    } finally {
      await harness.unmount();
      plugin.dispose();
    }
  });
}
