import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { PublicHostSettings } from "../src/main/host-profile.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });
const { Sidebar } = await import("../src/renderer/src/Sidebar.js");

const noop = () => undefined;

test("collapsed Projects remain recoverable without an Archived scope", async () => {
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
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(createElement(ActiveSidebar, {})));
    const projectsToggle = requiredButton(".projects-section-toggle");
    await act(async () => projectsToggle.click());
    assert.equal(document.querySelector(".thread-row"), null);
    assert.equal(projectsToggle.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector('[aria-label="Thread views"]'), null);
    assert.ok(document.querySelector(".settings-nav-row"));

    await act(async () => projectsToggle.click());
    assert.equal(projectsToggle.getAttribute("aria-expanded"), "true");
    assert.match(document.body.textContent ?? "", /Active Thread/u);
    const projectToggle = requiredButton(".project-toggle");
    await act(async () => projectToggle.click());
    await act(async () => projectsToggle.click());
    await act(async () => projectsToggle.click());
    assert.equal(
      requiredButton(".project-toggle").getAttribute("aria-expanded"),
      "false",
    );
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(ActiveSidebar, {})));
    assert.equal(
      requiredButton(".project-toggle").getAttribute("aria-expanded"),
      "false",
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previousGlobals, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

test("active Sidebar uses a profile logo and falls back when its managed image disappears", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const logo = "data:image/png;base64,ZmFrZQ==";
  const settings = (includeImage: boolean) =>
    ({
      profile: {
        providerProfiles: [
          {
            providerProfileId: "custom",
            type: "fake",
            displayName: "Custom",
            models: [],
            logoResource: "managed-logo",
          },
        ],
      },
      providerLogoDataUrls: includeImage ? { custom: logo } : {},
    }) as unknown as PublicHostSettings;
  let onChanged: ((value: PublicHostSettings) => void) | undefined;
  Object.assign(dom.window, {
    zenx: {
      platform: "darwin",
      settings: {
        get: async () => settings(true),
        onChanged: (listener: (value: PublicHostSettings) => void) => {
          onChanged = listener;
          return () => {
            onChanged = undefined;
          };
        },
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => {
      root.render(
        createElement(ActiveSidebar, { providerProfileId: "custom" }),
      );
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector<HTMLImageElement>(
        ".thread-model .provider-logo img",
      )?.src,
      logo,
    );
    await act(async () => onChanged?.(settings(false)));
    assert.ok(document.querySelector(".thread-model .provider-logo.generic"));
    assert.equal(
      document.querySelector(".thread-model .provider-logo img"),
      null,
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previousGlobals, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

function ActiveSidebar({ providerProfileId }: { providerProfileId?: string }) {
  const threads = [
    summary("active-thread", "Active Thread", false, providerProfileId),
  ];
  return createElement(Sidebar, {
    liveThread: null,
    mode: "projects",
    open: true,
    onClose: noop,
    onNewThread: noop,
    onAddProject: noop,
    onRemoveProject: noop,
    onSetDefaultProject: noop,
    onOpenContribution: noop,
    onOpenSettings: noop,
    onChangeThreadLifecycle: async () => undefined,
    onChangeThreadPinned: async () => undefined,
    onRenameThread: async () => undefined,
    onRetryThreads: noop,
    onSelectThread: noop,
    pendingApprovalThreadIds: new Set<string>(),
    pluginContributions: [],
    projects: {
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
    selectedPage: "agent",
    selectedThreadId: null,
    serverStatus: { type: "ready", reconnected: false },
    threadError: null,
    threadLoading: false,
    pinnedThreads: [],
    threads,
  });
}

function requiredButton(selector: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(selector);
  assert.ok(button, `Expected ${selector}`);
  return button;
}

function summary(
  threadId: string,
  name: string,
  archived: boolean,
  providerProfileId?: string,
): NativeThreadSummary {
  return {
    threadId,
    currentMetadata: {
      model: "fake",
      provider: "fake",
      ...(providerProfileId === undefined ? {} : { providerProfileId }),
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
