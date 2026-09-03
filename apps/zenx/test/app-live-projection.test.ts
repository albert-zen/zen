/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { ModelUsageProjection } from "../../../src/model-usage.js";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
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
import { App } from "../src/renderer/src/App.js";

test("resume commits canonical state before auxiliary reads and replays catch-up events", async () => {
  const resumeResponse = deferred<ReturnType<typeof resumed>>();
  const usage = deferred<ModelUsageProjection>();
  let notify: NotificationListener | undefined;
  const harness = await mountApp({
    request: async (method) => {
      if (method === "thread/resume") return await resumeResponse.promise;
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    attachments: async () => {
      throw new Error("attachment projection unavailable");
    },
    usage: async () => await usage.promise,
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    assert.match(document.body.textContent ?? "", /Loading conversation/u);
    assert.ok(notify);

    await act(async () => {
      resumeResponse.resolve(resumed(thread()));
      notify?.("turn/started", {
        threadId: "thread-1",
        turn: runningTurn(),
      });
      notify?.("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "agent-catch-up",
          type: "agentMessage",
          text: "Catch-up after resume",
          phase: "final_answer",
          memoryCitation: null,
        },
        completedAtMs: 20_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(document.body.textContent ?? "", /Catch-up after resume/u);
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /Loading conversation/u,
    );
    assert.match(document.body.textContent ?? "", /Catch-up after resume/u);
    assert.match(
      document.body.textContent ?? "",
      /attachment projection unavailable/u,
    );
    await act(async () => {
      usage.resolve({
        thread: { responseCount: 1, inputTokens: 7, outputTokens: 3 },
        turns: {},
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(document.body.textContent ?? "", /7 in/u);
  } finally {
    await harness.unmount();
  }
});

test("keeps an inactive Thread's streaming projection when returning to it", async () => {
  let notify: NotificationListener | undefined;
  const resumeCalls: string[] = [];
  const harness = await mountApp({
    request: async (method, params) => {
      if (method !== "thread/resume")
        throw new Error(`Unexpected protocol request: ${method}`);
      const threadId = (params as { threadId: string }).threadId;
      resumeCalls.push(threadId);
      return resumed(thread(threadId));
    },
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    threads: async (archived) =>
      archived
        ? []
        : [
            summary("thread-1", "Thread one"),
            summary("thread-2", "Thread two"),
          ],
  });
  try {
    const threadOne = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(".thread-row"),
      ).find((row) => row.textContent?.includes("Thread one")),
    );
    await act(async () => threadOne.click());
    await waitFor(() => resumeCalls.includes("thread-1"));
    assert.ok(notify);
    await act(async () => {
      notify?.("turn/started", {
        threadId: "thread-1",
        turn: runningTurn(),
      });
      notify?.("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "streamed-item",
          type: "agentMessage",
          text: "",
          phase: "final_answer",
          memoryCitation: null,
        },
        startedAtMs: 10_000,
      });
      notify?.("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "streamed-item",
        delta: "Initial stream",
      });
    });
    assert.match(document.body.textContent ?? "", /Initial stream/u);

    const threadTwo = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(".thread-row"),
      ).find((row) => row.textContent?.includes("Thread two")),
    );
    await act(async () => threadTwo.click());
    await waitFor(() => resumeCalls.includes("thread-2"));
    await act(async () => {
      notify?.("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "streamed-item",
        delta: " continues while away",
      });
    });

    await act(async () => threadOne.click());
    await waitFor(
      () =>
        resumeCalls.filter((threadId) => threadId === "thread-1").length === 2,
    );
    assert.match(
      document.body.textContent ?? "",
      /Initial stream continues while away/u,
    );
  } finally {
    await harness.unmount();
  }
});

test("failed ready approval snapshot drops stale cards and replays live requests", async () => {
  const nextSnapshot = deferred<ApprovalRequestEvent[]>();
  let snapshotCalls = 0;
  let status: ((value: AppServerHostStatus) => void) | undefined;
  let requestApproval: ((value: ApprovalRequestEvent) => void) | undefined;
  let resolveApproval: ((value: ApprovalResolvedEvent) => void) | undefined;
  const oldApproval = approval("old-ui-id", "old command");
  const newApproval = approval("new-ui-id", "new command");
  const resolvedApproval = approval("resolved-ui-id", "resolved command");
  const harness = await mountApp({
    request: async (method) => {
      if (method === "thread/resume") return resumed(thread());
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    getPendingApprovals: async () => {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? [oldApproval] : await nextSnapshot.promise;
    },
    onStatus: (listener) => {
      status = listener;
      return () => {
        status = undefined;
      };
    },
    onApprovalRequest: (listener) => {
      requestApproval = listener;
      return () => {
        requestApproval = undefined;
      };
    },
    onApprovalResolved: (listener) => {
      resolveApproval = listener;
      return () => {
        resolveApproval = undefined;
      };
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    await waitFor(() =>
      (document.body.textContent ?? "").includes("old command"),
    );
    assert.ok(status);
    assert.ok(requestApproval);
    assert.ok(resolveApproval);

    await act(async () => {
      status?.({ type: "reconnecting", attempt: 1, delayMs: 0 });
      status?.({ type: "ready", reconnected: true });
      requestApproval?.(newApproval);
      requestApproval?.(resolvedApproval);
      resolveApproval?.({
        requestId: resolvedApproval.requestId,
        threadId: resolvedApproval.params.threadId,
        decision: "cancel",
      });
      nextSnapshot.reject(new Error("snapshot unavailable"));
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.doesNotMatch(document.body.textContent ?? "", /old command/u);
    assert.match(document.body.textContent ?? "", /new command/u);
    assert.doesNotMatch(document.body.textContent ?? "", /resolved command/u);
    assert.match(document.body.textContent ?? "", /snapshot unavailable/u);
  } finally {
    await harness.unmount();
  }
});

test("a late resume response from the previous Host generation cannot replace the current snapshot", async () => {
  const responses = [
    deferred<ReturnType<typeof resumed>>(),
    deferred<ReturnType<typeof resumed>>(),
  ];
  let resumeCalls = 0;
  let status: ((value: AppServerHostStatus) => void) | undefined;
  const harness = await mountApp({
    request: async (method) => {
      if (method === "thread/resume") {
        const response = responses[resumeCalls++];
        assert.ok(response);
        return await response.promise;
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    onStatus: (listener) => {
      status = listener;
      return () => {
        status = undefined;
      };
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    assert.equal(resumeCalls, 1);
    assert.ok(status);
    await act(async () => {
      status?.({ type: "reconnecting", attempt: 1, delayMs: 0 });
      status?.({ type: "ready", reconnected: true });
      await Promise.resolve();
    });
    assert.equal(resumeCalls, 2);

    await act(async () => {
      responses[1]!.resolve(resumed(threadWithMessage("current generation")));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(document.body.textContent ?? "", /current generation/u);

    await act(async () => {
      responses[0]!.resolve(resumed(threadWithMessage("stale generation")));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(document.body.textContent ?? "", /current generation/u);
    assert.doesNotMatch(document.body.textContent ?? "", /stale generation/u);
  } finally {
    await harness.unmount();
  }
});

test("a successor ready snapshot inherits live approval events when it fails", async () => {
  const snapshots = [
    deferred<ApprovalRequestEvent[]>(),
    deferred<ApprovalRequestEvent[]>(),
  ];
  let snapshotCalls = 0;
  let status: ((value: AppServerHostStatus) => void) | undefined;
  let requestApproval: ((value: ApprovalRequestEvent) => void) | undefined;
  let resolveApproval: ((value: ApprovalResolvedEvent) => void) | undefined;
  const live = approval("live-generation-id", "live command");
  const harness = await mountApp({
    request: async (method) => {
      if (method === "thread/resume") return resumed(thread());
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    getPendingApprovals: async () => {
      const snapshot = snapshots[snapshotCalls++];
      assert.ok(snapshot);
      return await snapshot.promise;
    },
    onStatus: (listener) => {
      status = listener;
      return () => {
        status = undefined;
      };
    },
    onApprovalRequest: (listener) => {
      requestApproval = listener;
      return () => {
        requestApproval = undefined;
      };
    },
    onApprovalResolved: (listener) => {
      resolveApproval = listener;
      return () => {
        resolveApproval = undefined;
      };
    },
  });
  try {
    await waitFor(() => snapshotCalls === 1);
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    assert.ok(status);
    assert.ok(requestApproval);
    assert.ok(resolveApproval);

    await act(async () => {
      requestApproval?.(live);
      status?.({ type: "ready", reconnected: true });
      resolveApproval?.({
        requestId: "an-old-generation-ui-id",
        threadId: "thread-1",
        decision: "cancel",
      });
      snapshots[1]!.reject(new Error("successor snapshot failed"));
      snapshots[0]!.resolve([]);
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(document.body.textContent ?? "", /live command/u);
    assert.match(document.body.textContent ?? "", /successor snapshot failed/u);
  } finally {
    await harness.unmount();
  }
});

type NotificationListener = <M extends ServerNotificationMethod>(
  method: M,
  params: ServerNotificationParams[M],
) => void;

interface MountOptions {
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
      list: async ({ archived }: { archived: boolean }) =>
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
      get: async () => ({ plugins: [], sidebar: [], pages: [] }),
      onChange: () => () => undefined,
    },
  };
  Object.defineProperty(dom.window, "zenx", { value: zenx });
  dom.window.localStorage.setItem("zenx-sidebar-mode", "inbox");
  const container = document.getElementById("root");
  assert.ok(container);
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

function approval(requestId: string, command: string): ApprovalRequestEvent {
  return {
    requestId,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: `item-${requestId}`,
      startedAtMs: 10,
      environmentId: null,
      reason: null,
      command,
      cwd: "/work/zen",
      commandActions: [],
      proposedExecpolicyAmendment: null,
      networkApprovalContext: null,
      proposedNetworkPolicyAmendments: null,
    },
  };
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
  return {
    thread: value,
    model: "fake",
    modelProvider: "fake",
    approvalPolicy: "never" as const,
    approvalsReviewer: "user" as const,
    cwd: value.cwd,
    instructionSources: [],
    reasoningEffort: "medium",
    sandbox: { type: "dangerFullAccess" as const },
    serviceTier: null,
  };
}

function model() {
  return {
    id: "fake",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, reject, resolve };
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
