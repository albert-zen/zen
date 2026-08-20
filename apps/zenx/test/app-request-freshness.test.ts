/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { AppServerHostStatus } from "../src/main/app-server-manager.js";
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
      get: async () => ({ profile: { onboardingComplete: true } }),
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
