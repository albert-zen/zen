/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { ModelUsageProjection } from "../../../src/model-usage.js";
import type { AppServerHostStatus } from "../src/main/app-server-manager.js";
import type {
  ServerNotificationMethod,
  ServerNotificationParams,
  Thread,
} from "../src/protocol-client/index.js";
import { App } from "../src/renderer/src/App.js";

test("ignores an older Thread summary response after a newer refresh", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  const requests: Array<ReturnType<typeof deferred<NativeThreadSummary[]>>> =
    [];
  let notifyStatus: ((status: AppServerHostStatus) => void) | undefined;
  const never = new Promise<AppServerHostStatus>(() => undefined);
  const zenx = {
    platform: "darwin",
    protocol: {
      getStatus: async () => await never,
      getPendingApprovals: async () => [],
      request: async (method: string) => {
        if (method === "model/list") return { data: [] };
        throw new Error(`Unexpected protocol request: ${method}`);
      },
      respondToApproval: async () => undefined,
      onApprovalRequest: () => () => undefined,
      onApprovalResolved: () => () => undefined,
      onStatus: (listener: (status: AppServerHostStatus) => void) => {
        notifyStatus = listener;
        return () => undefined;
      },
      onNotification: () => () => undefined,
    },
    threads: {
      list: () => {
        const request = deferred<NativeThreadSummary[]>();
        requests.push(request);
        return request.promise;
      },
    },
    projects: {
      get: async () => ({
        projects: [],
        unavailableThreadIds: [],
        lastUsedWorkspace: null,
      }),
    },
    settings: {
      get: async () => ({
        profile: { onboardingComplete: true, pinnedThreadIds: [] },
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
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window, "zenx", { value: zenx });
  dom.window.localStorage.setItem("zenx-sidebar-mode", "inbox");
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(notifyStatus);
    await act(async () => {
      notifyStatus?.({ type: "ready", reconnected: false });
      await Promise.resolve();
    });
    await act(async () => {
      notifyStatus?.({ type: "ready", reconnected: true });
      await Promise.resolve();
    });
    assert.equal(requests.length, 4);

    await act(async () => {
      requests[2]?.resolve([summary("new-thread", "New summary")]);
      requests[3]?.resolve([]);
      await Promise.resolve();
    });
    assert.match(document.body.textContent ?? "", /New summary/u);

    await act(async () => {
      requests[0]?.resolve([summary("old-thread", "Old summary")]);
      requests[1]?.resolve([]);
      await Promise.resolve();
    });
    assert.match(document.body.textContent ?? "", /New summary/u);
    assert.doesNotMatch(document.body.textContent ?? "", /Old summary/u);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previousGlobals, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

test("refreshes failed-turn usage live without allowing stale reads to win", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  let notify:
    | (<M extends ServerNotificationMethod>(
        method: M,
        params: ServerNotificationParams[M],
      ) => void)
    | undefined;
  const usageRequests: Array<{
    threadId: string;
    response: ReturnType<typeof deferred<ModelUsageProjection>>;
  }> = [];
  const threads = [
    summary("thread-a", "Thread A"),
    summary("thread-b", "Thread B"),
  ];
  const zenx = {
    platform: "darwin",
    protocol: {
      getStatus: async (): Promise<AppServerHostStatus> => ({
        type: "ready",
        reconnected: false,
      }),
      getPendingApprovals: async () => [],
      request: async (method: string, params?: unknown) => {
        if (method === "model/list")
          return { data: [wireModel("fake")], nextCursor: null };
        if (method === "thread/resume") {
          const threadId = (params as { threadId: string }).threadId;
          return {
            thread: resumedThread(threadId),
            model: "fake",
            modelProvider: "fake",
            reasoningEffort: "medium",
          };
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
      respondToApproval: async () => undefined,
      onApprovalRequest: () => () => undefined,
      onApprovalResolved: () => () => undefined,
      onStatus: () => () => undefined,
      onNotification: (
        listener: <M extends ServerNotificationMethod>(
          method: M,
          params: ServerNotificationParams[M],
        ) => void,
      ) => {
        notify = listener;
        return () => undefined;
      },
    },
    threads: {
      list: async ({ archived }: { archived: boolean }) =>
        archived ? [] : threads,
    },
    imageAttachments: {
      pick: async () => [],
      import: async () => [],
      read: async () => new Uint8Array(),
      forThread: async () => ({}),
    },
    modelUsage: {
      forThread: (threadId: string) => {
        const response = deferred<ModelUsageProjection>();
        usageRequests.push({ threadId, response });
        return response.promise;
      },
    },
    projects: {
      get: async () => ({
        projects: [],
        unavailableThreadIds: [],
        lastUsedWorkspace: null,
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
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window, "zenx", { value: zenx });
  dom.window.localStorage.setItem("zenx-sidebar-mode", "inbox");
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(createElement(App));
      await Promise.resolve();
    });
    const threadA = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ].find((button) => button.textContent?.includes("Thread A"));
    assert.ok(threadA);
    await act(async () =>
      threadA.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      ),
    );
    assert.equal(usageRequests.length, 1);
    await act(async () => {
      usageRequests[0]?.response.resolve(projectedUsage(0));
      await Promise.resolve();
    });
    assert.match(document.body.textContent ?? "", /Start a new thread/u);

    assert.ok(notify);
    await act(async () => {
      notify?.("turn/completed", {
        threadId: "thread-a",
        turn: failedTurn("turn-a"),
      });
      notify?.("turn/completed", {
        threadId: "thread-a",
        turn: failedTurn("turn-a"),
      });
      await Promise.resolve();
    });
    assert.equal(usageRequests.length, 3);
    await act(async () => {
      usageRequests[2]?.response.resolve(projectedUsage(9));
      await Promise.resolve();
    });
    const contextUsageText = (): string | null =>
      document
        .querySelector(".context-usage-indicator")
        ?.getAttribute("aria-valuetext") ?? null;
    assert.equal(
      contextUsageText(),
      "Context 9% · 9 / 100\nThread cache unknown",
    );
    await act(async () => {
      usageRequests[1]?.response.resolve(projectedUsage(4));
      await Promise.resolve();
    });
    assert.equal(
      contextUsageText(),
      "Context 9% · 9 / 100\nThread cache unknown",
    );

    await act(async () => {
      notify?.("turn/completed", {
        threadId: "thread-a",
        turn: failedTurn("turn-a"),
      });
      await Promise.resolve();
    });
    const threadB = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ].find((button) => button.textContent?.includes("Thread B"));
    assert.ok(threadB);
    await act(async () =>
      threadB.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      ),
    );
    assert.equal(usageRequests.at(-1)?.threadId, "thread-b");
    await act(async () => {
      usageRequests.at(-1)?.response.resolve(projectedUsage(2));
      await Promise.resolve();
    });
    assert.equal(
      contextUsageText(),
      "Context 2% · 2 / 100\nThread cache unknown",
    );
    await act(async () => {
      usageRequests[3]?.response.resolve(projectedUsage(12));
      await Promise.resolve();
    });
    assert.equal(
      contextUsageText(),
      "Context 2% · 2 / 100\nThread cache unknown",
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previousGlobals, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

function summary(threadId: string, name: string): NativeThreadSummary {
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

function projectedUsage(inputTokens: number): ModelUsageProjection {
  return {
    thread: {
      responseCount: inputTokens === 0 ? 0 : 1,
      inputTokens,
      outputTokens: 1,
    },
    turns: {},
    context: {
      inputTokens: inputTokens === 0 ? null : inputTokens,
      inputTokenSource: inputTokens === 0 ? null : "provider",
      contextWindow: inputTokens === 0 ? null : 100,
      ratio: inputTokens === 0 ? null : inputTokens / 100,
    },
  };
}

function resumedThread(threadId: string): Thread {
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
    updatedAt: 1,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/work/zen",
    cliVersion: "0.146.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function failedTurn(
  turnId: string,
): ServerNotificationParams["turn/completed"]["turn"] {
  return {
    id: turnId,
    status: "failed",
    items: [],
    itemsView: "full",
    error: {
      message: "model failed after reporting usage",
      codexErrorInfo: null,
      additionalDetails: null,
    },
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
}

function wireModel(id: string) {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id,
    description: id,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
