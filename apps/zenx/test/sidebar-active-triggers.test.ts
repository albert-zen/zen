import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Sidebar } from "../src/renderer/src/Sidebar.js";
const noop = () => undefined;
const summary = (id: string) => ({
  threadId: id,
  name: `${id} · A complete and deliberately very long thread title`,
  archived: false,
  status: id === "a" ? "active" : "idle",
  createdAt: new Date(1000).toISOString(),
  updatedAt: new Date(9000).toISOString(),
  preview: "",
  currentMetadata: {
    model: "fake",
    provider: "fake",
    cwd: "/work/zen",
    sandbox: "workspace-write",
    approvalPolicy: "never",
  },
});

import { i18n } from "../src/renderer/src/i18n.js";

test("sidebar only advertises active triggers, including event-only and mixed definitions", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let triggers: any[] = [];
  Object.assign(window, {
    zenx: { plugins: { executeCommand: async () => ({ triggers }) } },
  });
  const root = createRoot(document.getElementById("root")!);
  const props: any = {
    mode: "projects",
    open: true,
    onClose: noop,
    onChangeThreadLifecycle: async () => {},
    onChangeThreadPinned: async () => {},
    onNewThread: noop,
    onAddProject: noop,
    onRemoveProject: noop,
    onSetDefaultProject: noop,
    onOpenContribution: noop,
    onOpenSettings: noop,
    triggerAdmissionId: "test-trigger-admission",
    onRetryThreads: noop,
    onRenameThread: async () => {},
    onSelectThread: noop,
    pendingApprovalThreadIds: new Set(),
    pluginContributions: [
      {
        pluginId: "zenx-triggers",
        id: "triggers",
        key: "triggers",
        title: "Triggers",
        icon: "clock",
        page: {
          id: "triggers",
          route: "/plugins/zenx-triggers/triggers",
          pluginId: "zenx-triggers",
          title: "Triggers",
        },
      },
    ],
    selectedPage: "agent",
    selectedThreadId: "a",
    serverStatus: { type: "ready" },
    liveThread: null,
    threadError: null,
    threadLoading: false,
    projects: {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          name: "Zen",
          configured: true,
          isDefault: true,
          threadIds: ["a", "b"],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    },
    pinnedThreads: [],
    threads: [summary("a"), summary("b")],
    unreadThreadIds: new Set(["b"]),
  };
  const timer = {
    id: "timer",
    threadId: "a",
    kind: "timer",
    active: true,
    timer: { nextRunAt: Date.now() + 100000 },
  };
  const event = { id: "event", threadId: "a", kind: "signal", active: true };
  try {
    for (const language of ["en", "zh-CN"]) {
      await act(async () => {
        await i18n.changeLanguage(language);
      });
      for (const [index, definitions] of [
        [],
        [{ ...timer, active: false }],
        [{ ...event, active: false }],
        [timer, { ...event, active: false }],
        [event],
        [timer, event],
      ].entries()) {
        triggers = definitions;
        await act(async () =>
          root.render(
            React.createElement(Sidebar, {
              ...props,
              key: `${language}-${index}`,
            }),
          ),
        );
        const row = document.querySelector<HTMLButtonElement>(
          '[data-thread-id="a"] > .thread-row',
        )!;
        await act(async () => row.focus());
        const details = document.querySelector(".thread-information")!;
        assert.ok(details);
        const count = definitions.filter((t) => t.active).length;
        const rail = document.querySelector(
          '[data-thread-id="a"] .thread-status-rail',
        )!;
        const label = i18n.t("shell:threadAutomationCount", { count });
        assert.equal(
          !!rail.querySelector(`[aria-label="${label}"]`),
          count > 0,
        );
        assert.equal(
          details.textContent!.includes(i18n.t("shell:threadNextTrigger")),
          count > 0,
        );
        assert.doesNotMatch(details.textContent!, /automation|自动化/i);
        if (count > 0) assert.ok(details.textContent!.includes(label));
        if (definitions.length === 1 && definitions[0] === event) {
          assert.ok(
            details.textContent!.includes(i18n.t("shell:threadTriggerOnEvent")),
          );
          assert.equal(details.querySelector("time"), null);
        }
      }
    }
  } finally {
    await act(async () => root.unmount());
    await i18n.changeLanguage("en");
    dom.window.close();
  }
});
