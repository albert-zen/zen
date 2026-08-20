/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { ZenXProjectProjectionSnapshot } from "../src/main/project-projection.js";
import type { Thread } from "../src/protocol-client/index.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });
const { App } = await import("../src/renderer/src/App.js");

interface AppHarness {
  dom: JSDOM;
  root: Root;
}

test("desktop Choose project opens the existing directory picker", async () => {
  const harness = await mountApp({
    projects: [
      {
        key: "/work/zen",
        workspace: "/work/zen",
        configured: true,
        isDefault: true,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  try {
    const chooseProject = await waitFor(() => exactButton("Choose project"));
    await act(async () => chooseProject.click());
    await waitFor(() => document.querySelector('[role="dialog"]'));
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? "",
      /Add a project folder/u,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("zero-Project New thread opens the existing directory picker", async () => {
  const harness = await mountApp({
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  try {
    const newThread = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".new-thread-action"),
    );
    assert.match(newThread.textContent ?? "", /Add project first/u);
    await act(async () => newThread.click());
    await waitFor(() => document.querySelector('[role="dialog"]'));
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? "",
      /Add a project folder/u,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("Sidebar archive clears the selected Chat and opens its Settings restore entry", async () => {
  let archived = false;
  let persistedPins = ["thread-1"];
  const harness = await mountApp(
    {
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
    },
    {
      request: async (method) => {
        if (method === "thread/resume")
          return {
            thread: liveThread(),
            model: "fake",
            modelProvider: "fake",
          };
        if (method === "thread/archive") {
          archived = true;
          return {};
        }
        if (method === "thread/unarchive") {
          archived = false;
          return {};
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
      threads: async (requestedArchived) =>
        requestedArchived === archived ? [summary(archived)] : [],
      initialPinnedThreadIds: persistedPins,
      onPinnedThreadIds: (threadIds) => {
        persistedPins = [...threadIds];
      },
    },
  );
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    await waitFor(() => document.getElementById("thread-composer"));
    await act(async () => threadMenuButton("Thread one").click());
    const archive = await waitFor(() => exactMenuButton("Archive"));
    await act(async () => {
      archive.click();
      await Promise.resolve();
    });
    await waitFor(() => exactButton("Unarchive"));
    assert.match(document.body.textContent ?? "", /Archived threads/u);
    assert.match(document.body.textContent ?? "", /Thread one/u);
    assert.equal(document.querySelector('[aria-label="Thread views"]'), null);
    assert.equal(document.getElementById("thread-composer"), null);
    assert.equal(document.querySelector(".thread-view"), null);
    assert.deepEqual(persistedPins, []);

    await act(async () => exactButton("Unarchive")?.click());
    await waitFor(() => document.querySelector(".thread-row"));
    assert.equal(document.getElementById("sidebar-pinned-heading"), null);
  } finally {
    await unmountApp(harness);
  }
});

test("selected Sidebar archive fences Send until a failed response restores Chat", async () => {
  const archiveResponse = deferred<unknown>();
  let turnStartCalls = 0;
  const harness = await mountApp(
    {
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
    },
    {
      request: async (method) => {
        if (method === "thread/resume")
          return {
            thread: liveThread(),
            model: "fake",
            modelProvider: "fake",
          };
        if (method === "thread/archive") return await archiveResponse.promise;
        if (method === "turn/start") {
          turnStartCalls += 1;
          return {};
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
      threads: async (archived) => (archived ? [] : [summary(false)]),
    },
  );
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Keep this draft");
    const staleSend = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    assert.equal(staleSend.disabled, false);

    await act(async () => threadMenuButton("Thread one").click());
    const archive = await waitFor(() => exactMenuButton("Archive"));
    await act(async () => {
      archive.click();
      staleSend.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(turnStartCalls, 0);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")?.disabled,
      true,
    );

    await act(async () => {
      archiveResponse.reject(new Error("archive failed"));
      await Promise.resolve();
    });
    const restoredComposer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    assert.equal(restoredComposer.value, "Keep this draft");
    assert.match(document.body.textContent ?? "", /archive failed/u);

    const restoredSend = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    assert.equal(restoredSend.disabled, false);
    await act(async () => {
      restoredSend.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(turnStartCalls, 1);
  } finally {
    await unmountApp(harness);
  }
});

test("selected archive fences a submission already staging its title", async () => {
  const titleResponse = deferred<undefined>();
  const archiveResponse = deferred<unknown>();
  let turnStartCalls = 0;
  const harness = await mountApp(
    {
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
    },
    {
      observeTitle: async () => await titleResponse.promise,
      request: async (method) => {
        if (method === "thread/resume")
          return {
            thread: liveThread(),
            model: "fake",
            modelProvider: "fake",
          };
        if (method === "thread/archive") return await archiveResponse.promise;
        if (method === "turn/start") {
          turnStartCalls += 1;
          return {};
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
      threads: async (archived) => (archived ? [] : [summary(false)]),
    },
  );
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Retry after archive failure");
    const send = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    await act(async () => {
      send.click();
      await Promise.resolve();
    });
    assert.equal(turnStartCalls, 0);

    await act(async () => threadMenuButton("Thread one").click());
    const archive = await waitFor(() => exactMenuButton("Archive"));
    await act(async () => {
      archive.click();
      await Promise.resolve();
      titleResponse.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(turnStartCalls, 0);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")?.disabled,
      true,
    );

    await act(async () => {
      archiveResponse.reject(new Error("archive failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const restoredComposer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    assert.equal(restoredComposer.value, "Retry after archive failure");
    const restoredSend = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    assert.equal(restoredSend.disabled, false);

    await act(async () => {
      restoredSend.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(turnStartCalls, 1);
  } finally {
    await unmountApp(harness);
  }
});

test("duplicate selected archive shares one pending fence owner", async () => {
  const archiveResponse = deferred<unknown>();
  let archiveCalls = 0;
  let turnStartCalls = 0;
  const harness = await mountApp(
    {
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
    },
    {
      request: async (method) => {
        if (method === "thread/resume")
          return {
            thread: liveThread(),
            model: "fake",
            modelProvider: "fake",
          };
        if (method === "thread/archive") {
          archiveCalls += 1;
          return await archiveResponse.promise;
        }
        if (method === "turn/start") {
          turnStartCalls += 1;
          return {};
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
      threads: async (archived) => (archived ? [] : [summary(false)]),
    },
  );
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Keep the fence");
    const staleSend = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );

    await act(async () => threadMenuButton("Thread one").click());
    const archive = await waitFor(() => exactMenuButton("Archive"));
    await act(async () => {
      archive.click();
      archive.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(archiveCalls, 1);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")?.disabled,
      true,
    );
    await act(async () => {
      staleSend.click();
      await Promise.resolve();
    });
    assert.equal(turnStartCalls, 0);

    await act(async () => {
      archiveResponse.reject(new Error("archive failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const restoredSend = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    assert.equal(restoredSend.disabled, false);
    await act(async () => {
      restoredSend.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(turnStartCalls, 1);
  } finally {
    await unmountApp(harness);
  }
});

test("serializes cross-row Pin mutations against the latest confirmed order", async () => {
  const requests: Array<{
    threadIds: readonly string[];
    response: ReturnType<typeof deferred<ReturnType<typeof publicSettings>>>;
  }> = [];
  const threads = [
    summary(false, "thread-1", "Thread one"),
    summary(false, "thread-2", "Thread two"),
  ];
  const harness = await mountApp(
    {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: true,
          threadIds: threads.map((thread) => thread.threadId),
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    },
    {
      threads: async (archived) => (archived ? [] : threads),
      setPinnedThreadIds: async (threadIds) => {
        const response = deferred<ReturnType<typeof publicSettings>>();
        requests.push({ threadIds: [...threadIds], response });
        return await response.promise;
      },
    },
  );
  try {
    await act(async () => threadMenuButton("Thread one").click());
    await act(async () => exactButton("Pin")?.click());
    await act(async () => threadMenuButton("Thread two").click());
    await act(async () => exactButton("Pin")?.click());

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.threadIds, ["thread-1"]);

    await act(async () => {
      requests[0]?.response.resolve(publicSettings(["thread-1"]));
      await Promise.resolve();
    });
    await waitFor(() => requests.length === 2);
    assert.deepEqual(requests[1]?.threadIds, ["thread-2", "thread-1"]);

    await act(async () => {
      requests[1]?.response.resolve(publicSettings(["thread-2", "thread-1"]));
      await Promise.resolve();
    });
    await waitFor(
      () =>
        document.querySelectorAll(".pinned-thread-group .thread-row").length ===
        2,
    );
    assert.deepEqual(
      [
        ...document.querySelectorAll(
          ".pinned-thread-group .thread-title > span:first-child",
        ),
      ].map((title) => title.textContent),
      ["Thread two", "Thread one"],
    );
  } finally {
    await unmountApp(harness);
  }
});

async function mountApp(
  projects: ZenXProjectProjectionSnapshot,
  options: {
    initialPinnedThreadIds?: string[];
    onPinnedThreadIds?(threadIds: readonly string[]): void;
    setPinnedThreadIds?(
      threadIds: readonly string[],
    ): Promise<ReturnType<typeof publicSettings>>;
    request?(method: string): Promise<unknown>;
    observeTitle?(): Promise<undefined>;
    threads?(archived: boolean): Promise<NativeThreadSummary[]>;
  } = {},
): Promise<AppHarness> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let currentSettings = publicSettings(options.initialPinnedThreadIds ?? []);
  const zenx = {
    platform: "darwin",
    protocol: {
      getStatus: async () => ({ type: "ready", reconnected: false }),
      getPendingApprovals: async () => [],
      request: async (method: string) => {
        if (method === "model/list") return { data: [] };
        if (options.request !== undefined) return await options.request(method);
        throw new Error(`Unexpected protocol request: ${method}`);
      },
      respondToApproval: async () => undefined,
      onApprovalRequest: () => () => undefined,
      onApprovalResolved: () => () => undefined,
      onStatus: () => () => undefined,
      onNotification: () => () => undefined,
    },
    threads: {
      list: async ({ archived }: { archived: boolean }) =>
        options.threads === undefined ? [] : await options.threads(archived),
    },
    projects: { get: async () => projects },
    settings: {
      get: async () => currentSettings,
      setPinnedThreadIds: async (threadIds: readonly string[]) => {
        if (options.setPinnedThreadIds !== undefined)
          return await options.setPinnedThreadIds(threadIds);
        options.onPinnedThreadIds?.(threadIds);
        currentSettings = publicSettings([...threadIds]);
        return currentSettings;
      },
      markWorkspaceUsed: async () => currentSettings,
      onManualCodeRequested: () => () => undefined,
      addWorkspace: async () => ({ profile: { onboardingComplete: true } }),
      getDirectoryBrowser: async () => ({
        locations: [{ label: "Root", path: "/" }],
        initialPath: "/",
      }),
      listDirectory: async () => ({
        path: "/",
        parent: null,
        breadcrumbs: [{ label: "/", path: "/" }],
        directories: [],
      }),
    },
    titles: {
      get: async () => ({}),
      observe: async () => await options.observeTitle?.(),
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
  } as unknown as Window["zenx"];
  Object.defineProperty(dom.window, "zenx", { value: zenx });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(App)));
  return { dom, root };
}

function publicSettings(pinnedThreadIds: string[]) {
  return {
    profile: {
      version: 1 as const,
      onboardingComplete: true,
      provider: { type: "fake" as const, displayName: "Local demo" },
      defaultModel: "fake",
      titleModel: "gpt-5.6-luna",
      models: ["fake"],
      workspace: "/work/zen",
      workspaces: ["/work/zen"],
      lastUsedWorkspace: "/work/zen",
      approvalPolicy: "never" as const,
      pinnedThreadIds,
      sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
    },
    hasApiKey: false,
    subscription: { authenticated: false, expired: false },
  };
}

function summary(
  archived: boolean,
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
    archived,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    name,
    preview: "",
    status: "idle",
  };
}

function threadMenuButton(threadName: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[aria-label="Manage ${threadName}"]`,
  );
  assert.ok(button, `Expected menu trigger for ${threadName}`);
  return button;
}

function liveThread(): Thread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
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
    name: "Thread one",
    turns: [],
  };
}

async function unmountApp(harness: AppHarness): Promise<void> {
  await act(async () => harness.root.unmount());
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: undefined,
  });
  harness.dom.window.close();
}

async function setTextareaValue(
  textarea: HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const reactPropsKey = Object.getOwnPropertyNames(textarea).find((key) =>
    key.startsWith("__reactProps$"),
  );
  assert.ok(reactPropsKey);
  const props = (
    textarea as unknown as Record<
      string,
      { onChange?(event: { target: { value: string } }): void }
    >
  )[reactPropsKey];
  const onChange = props?.onChange;
  assert.ok(onChange);
  await act(async () => {
    onChange({ target: { value } });
    await Promise.resolve();
  });
}

function exactButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

function exactMenuButton(label: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((button) => button.textContent?.trim() === label);
}

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("Timed out waiting for App interaction state");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, reject, resolve };
}
