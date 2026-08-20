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

test("archiving an active Thread opens its Settings restore entry", async () => {
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
    const archive = await waitFor(() => exactButton("Archive"));
    await act(async () => {
      archive.click();
      await Promise.resolve();
    });
    await waitFor(() => exactButton("Unarchive"));
    assert.match(document.body.textContent ?? "", /Archived threads/u);
    assert.match(document.body.textContent ?? "", /Thread one/u);
    assert.equal(document.querySelector('[aria-label="Thread views"]'), null);
    assert.deepEqual(persistedPins, []);

    await act(async () => exactButton("Unarchive")?.click());
    await waitFor(() => document.querySelector(".thread-row"));
    assert.equal(document.getElementById("sidebar-pinned-heading"), null);
  } finally {
    await unmountApp(harness);
  }
});

async function mountApp(
  projects: ZenXProjectProjectionSnapshot,
  options: {
    initialPinnedThreadIds?: string[];
    onPinnedThreadIds?(threadIds: readonly string[]): void;
    request?(method: string): Promise<unknown>;
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
        options.onPinnedThreadIds?.(threadIds);
        currentSettings = publicSettings([...threadIds]);
        return currentSettings;
      },
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
    },
    hasApiKey: false,
    subscription: { authenticated: false, expired: false },
  };
}

function summary(archived: boolean): NativeThreadSummary {
  return {
    threadId: "thread-1",
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
    name: "Thread one",
    preview: "",
    status: "idle",
  };
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

function exactButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
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
