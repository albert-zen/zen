import "./dom-primitives.js";
/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { ModelUsageProjection } from "../../../src/model-usage.js";
import type { AppServerHostStatus } from "../src/main/app-server-manager.js";
import type { ZenXImageDraft } from "../src/main/image-attachments.js";
import type { ZenXProjectProjectionSnapshot } from "../src/main/project-projection.js";
import type { ModelSummary, Thread } from "../src/protocol-client/index.js";
import { encodeModelKey } from "../../../src/protocol/model-key.js";
import { workspaceLauncherSnapshot } from "./workspace-launcher-snapshot.js";
import { nativeRecoveryForThread } from "./native-recovery-fixture.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { parseSentReferenceContent } from "../src/renderer/src/reference-draft.js";
const { act, createElement } = React;
Object.assign(globalThis, { React });
const {
  App,
  acquireDraftPromotionLease,
  optimisticThreadSummary,
  releaseDraftPromotionLease,
} = await import("../src/renderer/src/App.js");

interface AppHarness {
  dom: JSDOM;
  root: Root;
}

function oneProject(): ZenXProjectProjectionSnapshot {
  return {
    projects: [
      {
        key: "/work/zen",
        workspace: "/work/zen",
        configured: true,
        isDefault: false,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: "/work/zen",
  };
}

function projectSwitcher(): HTMLButtonElement | undefined {
  return (
    document.querySelector<HTMLButtonElement>(".new-thread-project-trigger") ??
    undefined
  );
}

test("desktop title bar collapses and restores the Sidebar", async () => {
  const harness = await mountApp({
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  try {
    const inbox = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Open inbox"]'),
    );
    const collapse = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Collapse sidebar"]',
      ),
    );
    const productRow = document.querySelector(".window-titlebar-product");
    const nativeActions = document.querySelector(
      ".window-titlebar-native-actions",
    );
    assert.equal(productRow?.querySelector(".inbox-button"), inbox);
    assert.equal(productRow?.querySelector(".sidebar-collapse-button"), null);
    assert.equal(
      nativeActions?.querySelector(".sidebar-collapse-button"),
      collapse,
    );
    assert.equal(nativeActions?.querySelector(".inbox-button"), null);
    assert.equal(inbox.getAttribute("aria-pressed"), "false");
    assert.equal(collapse.getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelector(".app-shell")?.className, "app-shell");

    await act(async () => inbox.click());
    const returnToProjects = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Return to projects"]',
      ),
    );
    assert.equal(returnToProjects.getAttribute("aria-pressed"), "true");
    assert.equal(
      harness.dom.window.localStorage.getItem("zenx-sidebar-mode"),
      "inbox",
    );

    await act(async () => returnToProjects.click());
    await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Open inbox"]'),
    );

    await act(async () => collapse.click());
    const expand = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Expand sidebar"]',
      ),
    );
    assert.equal(expand.getAttribute("aria-expanded"), "false");
    assert.match(
      document.querySelector(".app-shell")?.className ?? "",
      /sidebar-collapsed/u,
    );
    assert.equal(
      document.getElementById("primary-sidebar")?.getAttribute("aria-hidden"),
      "true",
    );
    assert.equal(
      harness.dom.window.localStorage.getItem("zenx.sidebar-collapsed"),
      "true",
    );

    await act(async () => expand.click());
    await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Collapse sidebar"]',
      ),
    );
    assert.equal(
      document.getElementById("primary-sidebar")?.hasAttribute("aria-hidden"),
      false,
    );
    assert.equal(
      harness.dom.window.localStorage.getItem("zenx.sidebar-collapsed"),
      "false",
    );
  } finally {
    await unmountApp(harness);
  }
});

test("startup opens a local welcome draft without creating a Thread", async () => {
  let starts = 0;
  const harness = await mountApp(oneProject(), {
    startProjectThread: async (workspace) => {
      starts += 1;
      return started(liveThread(), workspace);
    },
  });
  try {
    const heading = await waitFor(() =>
      document.querySelector<HTMLElement>(".new-thread-draft-heading"),
    );
    assert.match(heading.textContent ?? "", /What should we build in zen\?/u);
    assert.equal(
      document.querySelector(".new-thread-draft-empty .empty-glyph"),
      null,
    );
    assert.ok(document.getElementById("thread-composer"));
    assert.equal(starts, 0);
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /Start a conversation|No thread selected/u,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("optimistic summary preserves Thread seconds, identity, and idle status", () => {
  const value = optimisticThreadSummary(
    {
      ...started(liveThread(), "/work/zen"),
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    },
    "preview",
  );
  assert.equal(value.createdAt, new Date(1_000).toISOString());
  assert.equal(value.updatedAt, new Date(2_000).toISOString());
  assert.equal(value.threadId, "thread-1");
  assert.equal(value.status, "idle");
  assert.equal(value.currentMetadata.sandbox, "workspace-write");
  assert.equal(value.currentMetadata.cwd, "/work/zen");
});

test("draft promotion leases delete released mappings", () => {
  const leases = new Map<string, number>();
  const promotions = new Map([["draft-1", "thread-1"]]);
  acquireDraftPromotionLease(leases, "draft-1");
  releaseDraftPromotionLease(leases, promotions, "draft-1");
  assert.equal(leases.size, 0);
  assert.equal(promotions.size, 0);
});

test("New thread stays local, switches Project, and creates on first Send", async () => {
  const selectedStart = deferred<ReturnType<typeof started>>();
  let projectReads = 0;
  let addWorkspaceCalls = 0;
  let markWorkspaceCalls = 0;
  const projectMutationOrder: string[] = [];
  const startedWorkspaces: string[] = [];
  const turnStarts: Array<{
    clientUserMessageId?: string;
    input?: Array<{ type: string; text?: string }>;
  }> = [];
  let created = false;
  const projects: ZenXProjectProjectionSnapshot = {
    projects: [
      {
        key: "/work/documents",
        workspace: "/work/documents",
        configured: true,
        isDefault: false,
        threadIds: [],
      },
      {
        key: "/work/zen",
        workspace: "/work/zen",
        configured: true,
        isDefault: true,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: "/work/zen",
  };
  const harness = await mountApp(projects, {
    addWorkspace: async () => {
      addWorkspaceCalls += 1;
      projectMutationOrder.push("add");
    },
    markWorkspaceUsed: async () => {
      markWorkspaceCalls += 1;
      return publicSettings([]);
    },
    projectsGet: async () => {
      projectReads += 1;
      return projects;
    },
    request: async (method, params) => {
      if (method === "zen/turn/send") {
        turnStarts.push(
          params as {
            clientUserMessageId?: string;
            input?: Array<{ type: string; text?: string }>;
          },
        );
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    startProjectThread: async (workspace) => {
      projectMutationOrder.push("start");
      startedWorkspaces.push(workspace);
      const value = await selectedStart.promise;
      created = true;
      return value;
    },
    threads: async (archived) =>
      !archived && created
        ? [summary(false, "thread-1", "Thread one", "/work/documents")]
        : [],
  });
  try {
    await waitFor(() => projectReads > 0);
    const readsBeforeDraft = projectReads;
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    assert.match(
      document.body.textContent ?? "",
      /What should we build in zen\?/u,
    );
    assert.deepEqual(startedWorkspaces, []);
    assert.equal(addWorkspaceCalls, 0);
    assert.equal(markWorkspaceCalls, 0);
    assert.equal(projectReads, readsBeforeDraft);

    await act(async () => projectSwitcher()?.click());
    const documents = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((button) => button.textContent?.includes("documents")),
    );
    await act(async () => documents.click());
    assert.match(
      document.body.textContent ?? "",
      /What should we build in documents\?/u,
    );
    assert.deepEqual(startedWorkspaces, []);
    assert.equal(addWorkspaceCalls, 0);
    assert.equal(markWorkspaceCalls, 0);
    assert.equal(projectReads, readsBeforeDraft);

    await setTextareaValue(composer, "Build the documents flow");
    const send = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    await act(async () => projectSwitcher()?.click());
    await waitFor(() =>
      document.querySelector('[role="menu"][aria-label="Choose a Project"]'),
    );
    await invokeButtonClick(send, 2);
    await waitFor(() => startedWorkspaces.length === 1);
    assert.deepEqual(startedWorkspaces, ["/work/documents"]);
    assert.deepEqual(projectMutationOrder, ["add", "start"]);
    assert.equal(turnStarts.length, 0);
    assert.equal(
      document.querySelector('[role="menu"][aria-label="Choose a Project"]'),
      null,
    );
    assert.equal(projectSwitcher()?.disabled, true);
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /Loading conversation/u,
    );
    await setTextareaValue(composer, "Second message stays queued");

    await act(async () => {
      selectedStart.resolve(started(liveThread(), "/work/documents"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => turnStarts.length === 1);
    assert.equal(turnStarts[0]?.input?.[0]?.text, "Build the documents flow");
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")?.value,
      "Second message stays queued",
    );
    assert.equal(addWorkspaceCalls, 1);
    assert.equal(markWorkspaceCalls, 1);
  } finally {
    await unmountApp(harness);
  }
});

test("fresh Thread establishes native provenance before sending and only durable current-epoch messages can quote or fork", async () => {
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  const recovery = deferred<ReturnType<typeof nativeRecoveryForThread>>();
  const requests: Array<{ method: string; params: unknown }> = [];
  let starts = 0;
  const harness = await mountApp(oneProject(), {
    startProjectThread: async (workspace) => {
      starts++;
      return started(liveThread(), workspace);
    },
    recoverCreatedThread: async () => {
      requests.push({
        method: "zen/thread/resume",
        params: { threadId: "thread-1" },
      });
      return recovery.promise;
    },
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "zen/turn/send") return {};
      if (method === "zen/thread/fork") return new Promise(() => undefined);
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  });
  const emit = async (
    watermark: number,
    event: import("../../../src/app-server.js").AppServerEvent,
    processEpoch = "fresh-native-epoch",
    threadId = "thread-1",
  ) =>
    act(async () =>
      notify?.("zen/thread/event", {
        processEpoch,
        threadId,
        watermark,
        event,
      }),
    );
  const message = {
    type: "agent_message" as const,
    id: "fresh-answer",
    threadId: "thread-1",
    turnId: "fresh-turn",
    createdAt: "2026-10-27T00:00:02.000Z",
    text: "Exact fresh native answer",
  };
  try {
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Start with native authority");
    await invokeButtonClick(
      await waitFor(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
      ),
      2,
    );
    await waitFor(() =>
      requests.some(({ method }) => method === "zen/thread/resume"),
    );
    assert.equal(starts, 1);
    assert.equal(
      requests.some(({ method }) => method === "zen/turn/send"),
      false,
    );
    await act(async () =>
      recovery.resolve(
        nativeRecoveryForThread(liveThread(), {
          processEpoch: "fresh-native-epoch",
        }),
      ),
    );
    await waitFor(() =>
      requests.some(({ method }) => method === "zen/turn/send"),
    );
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["zen/thread/resume", "zen/turn/send"],
    );
    await emit(1, {
      type: "turn_started",
      threadId: "thread-1",
      turnId: "fresh-turn",
    });
    await emit(2, {
      type: "item_started",
      threadId: "thread-1",
      turnId: "fresh-turn",
      itemId: message.id,
      itemType: "agent_message",
    });
    await emit(3, {
      type: "item_delta",
      threadId: "thread-1",
      turnId: "fresh-turn",
      itemId: message.id,
      delta: message.text,
    });
    await waitFor(() => document.querySelector(".agent-copy"));
    assert.equal(
      document.querySelector("[data-quote-item-id]"),
      null,
      "stream-only text has no source authority",
    );
    await emit(
      4,
      { type: "item_completed", item: message },
      "stale-native-epoch",
    );
    await emit(
      4,
      {
        type: "item_completed",
        item: { ...message, threadId: "other-thread" },
      },
      "fresh-native-epoch",
      "other-thread",
    );
    assert.equal(
      document.querySelector("[data-quote-item-id]"),
      null,
      "stale and cross-thread completions cannot authorize a visible message",
    );
    await emit(4, { type: "item_completed", item: message });
    await emit(5, {
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "fresh-turn",
      status: "completed",
    });
    const owner = await waitFor(() =>
      document.querySelector<HTMLElement>(
        '[data-quote-item-id="fresh-answer"]',
      ),
    );
    assert.equal(owner.dataset.quoteThreadId, "thread-1");
    const fork = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".message-fork"),
    );
    const paragraph = owner.querySelector("[data-message-quote-body] p")!;
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    const quote = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '.message-selection-actions [aria-keyshortcuts="Alt+Enter"]',
      ),
    );
    await act(async () => quote.click());
    await waitFor(() => document.querySelector(".composer .reference-token"));
    assert.equal(
      requests.filter(({ method }) => method === "zen/turn/send").length,
      1,
      "quoting never sends a Turn",
    );
    await act(async () => fork.click());
    assert.deepEqual(
      requests.find(({ method }) => method === "zen/thread/fork")?.params,
      {
        sourceThreadId: "thread-1",
        through: { type: "item", itemId: "fresh-answer" },
        workspace: { type: "same-directory" },
      },
    );
  } finally {
    await unmountApp(harness);
  }
});

test("native bootstrap reconciles overlapping native events after legacy completion without trusting stale epochs or covered watermarks", async () => {
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  const recovery = deferred<ReturnType<typeof nativeRecoveryForThread>>();
  let reading = false;
  let sends = 0;
  const harness = await mountApp(oneProject(), {
    startProjectThread: async (workspace) => started(liveThread(), workspace),
    recoverCreatedThread: async () => {
      reading = true;
      return recovery.promise;
    },
    request: async (method) => {
      if (method === "zen/turn/send") {
        sends++;
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  });
  const message = {
    type: "agent_message" as const,
    id: "overlapping-answer",
    threadId: "thread-1",
    turnId: "overlapping-turn",
    createdAt: "2026-10-27T00:00:03.000Z",
    text: "Durable overlapping answer",
  };
  const native = (
    watermark: number,
    event: import("../../../src/app-server.js").AppServerEvent,
    processEpoch = "fresh-native-epoch",
  ) =>
    notify?.("zen/thread/event", {
      processEpoch,
      threadId: "thread-1",
      watermark,
      event,
    });
  try {
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(
      composer,
      "Keep the send pending until native ownership is known",
    );
    await invokeButtonClick(
      await waitFor(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
      ),
    );
    await waitFor(() => reading);
    await act(async () => {
      native(4, {
        type: "item_completed",
        item: {
          ...message,
          id: "covered-answer",
          text: "Covered stale answer",
        },
      });
      native(6, {
        type: "turn_started",
        threadId: "thread-1",
        turnId: message.turnId,
      });
      native(7, { type: "item_completed", item: message });
      native(8, {
        type: "turn_completed",
        threadId: "thread-1",
        turnId: message.turnId,
        status: "completed",
      });
      native(
        9,
        {
          type: "item_completed",
          item: {
            ...message,
            id: "wrong-epoch-answer",
            text: "Wrong epoch answer",
          },
        },
        "old-native-epoch",
      );
      notify?.("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: message.turnId,
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 3,
          durationMs: 2000,
          itemsView: "full",
          items: [
            {
              id: message.id,
              type: "agentMessage",
              text: message.text,
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      });
    });
    assert.equal(sends, 0);
    assert.equal(
      document.querySelector("[data-quote-item-id]"),
      null,
      "unbound native events cannot confer ownership before recovery",
    );
    await act(async () =>
      recovery.resolve(
        nativeRecoveryForThread(liveThread(), {
          processEpoch: "fresh-native-epoch",
          watermark: 5,
        }),
      ),
    );
    await waitFor(() => sends === 1);
    const source = await waitFor(() =>
      document.querySelector('[data-quote-item-id="overlapping-answer"]'),
    );
    assert.match(source.textContent ?? "", /Durable overlapping answer/);
    assert.equal(
      document.querySelector('[data-quote-item-id="covered-answer"]'),
      null,
    );
    assert.equal(
      document.querySelector('[data-quote-item-id="wrong-epoch-answer"]'),
      null,
    );
    assert.ok(document.querySelector(".message-fork"));
  } finally {
    await unmountApp(harness);
  }
});

test("failed fresh native bootstrap preserves the promoted draft and retries the same Thread before sending", async () => {
  let starts = 0;
  let recoveries = 0;
  const sends: unknown[] = [];
  const harness = await mountApp(oneProject(), {
    startProjectThread: async (workspace) => {
      starts++;
      return started(liveThread(), workspace);
    },
    recoverCreatedThread: async () => {
      recoveries++;
      if (recoveries === 1) throw new Error("native bootstrap unavailable");
      return nativeRecoveryForThread(liveThread(), {
        processEpoch: "fresh-native-epoch",
      });
    },
    request: async (method, params) => {
      if (method === "zen/turn/send") {
        sends.push(params);
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Keep this exact first message");
    await invokeButtonClick(
      await waitFor(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
      ),
    );
    await waitFor(() =>
      /native bootstrap unavailable/.test(document.body.textContent ?? ""),
    );
    assert.equal(starts, 1);
    assert.equal(sends.length, 0);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")?.value,
      "Keep this exact first message",
    );
    await invokeButtonClick(
      await waitFor(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
      ),
    );
    await waitFor(() => sends.length === 1);
    assert.equal(starts, 1, "recovery failure never creates a second Thread");
    assert.equal(recoveries, 2);
    assert.equal((sends[0] as { threadId: string }).threadId, "thread-1");
  } finally {
    await unmountApp(harness);
  }
});

test("New thread sends its selected model, reasoning and file permissions to Project start", async () => {
  const starts: Array<{
    workspace: string;
    selection: { model?: string; effort?: string } | undefined;
  }> = [];
  const advanced = {
    ...wireModel(
      encodeModelKey({
        providerProfileId: "fake",
        modelId: "gpt-5.6-luna",
      }),
      false,
      "Compose model",
    ),
    model: "gpt-5.6-luna",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "low" },
      { reasoningEffort: "high", description: "high" },
    ],
    defaultReasoningEffort: "high",
  };
  const harness = await mountApp(oneProject(), {
    models: [wireModel("fake", true, "Local demo"), advanced],
    request: async (method) => {
      if (method === "zen/turn/send") return {};
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    startProjectThread: async (workspace, selection) => {
      starts.push({ workspace, selection });
      return started(liveThread(), workspace);
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const modelTrigger = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".composer-model-trigger"),
    );
    await invokeButtonClick(modelTrigger);
    const modelEntry = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).find((button) => button.textContent?.startsWith("Model")),
    );
    await invokeButtonClick(modelEntry);
    const advancedEntry = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((button) => button.textContent?.includes("Compose model")),
    );
    await invokeButtonClick(advancedEntry);
    await invokeButtonClick(modelTrigger);
    const reasoningEntry = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).find((button) => button.textContent?.startsWith("Reasoning")),
    );
    await invokeButtonClick(reasoningEntry);
    const low = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((button) => button.textContent?.includes("Low")),
    );
    await invokeButtonClick(low);

    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    const permission = document.querySelector<HTMLButtonElement>(
      '[aria-label="File permissions"]',
    )!;
    assert.equal(permission.textContent, "Full access");
    await invokeButtonClick(permission);
    await invokeButtonClick(
      document.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][data-permission="read-only"]',
      )!,
    );
    await setTextareaValue(composer, "Use the selected model");
    await invokeButtonClick(
      await waitFor(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
      ),
    );
    await waitFor(() => starts.length === 1);
    assert.deepEqual(starts, [
      {
        workspace: "/work/zen",
        selection: { model: advanced.id, effort: "low", sandbox: "read-only" },
      },
    ]);
  } finally {
    await unmountApp(harness);
  }
});

test("abandoning an untouched new-thread draft performs no Project mutation", async () => {
  let projectReads = 0;
  let addWorkspaceCalls = 0;
  let markWorkspaceCalls = 0;
  let starts = 0;
  const projects: ZenXProjectProjectionSnapshot = {
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
    lastUsedWorkspace: "/work/zen",
  };
  const harness = await mountApp(projects, {
    addWorkspace: async () => {
      addWorkspaceCalls += 1;
    },
    markWorkspaceUsed: async () => {
      markWorkspaceCalls += 1;
      return publicSettings([]);
    },
    projectsGet: async () => {
      projectReads += 1;
      return projects;
    },
    startProjectThread: async (workspace) => {
      starts += 1;
      return started(liveThread(), workspace);
    },
  });
  try {
    await waitFor(() => projectReads > 0);
    const readsBeforeDraft = projectReads;
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    await waitFor(() => document.getElementById("thread-composer"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.click(),
    );
    await waitFor(() => /Settings/u.test(document.body.textContent ?? ""));
    assert.equal(document.getElementById("thread-composer"), null);
    assert.equal(starts, 0);
    assert.equal(addWorkspaceCalls, 0);
    assert.equal(markWorkspaceCalls, 0);
    assert.equal(projectReads, readsBeforeDraft);
  } finally {
    await unmountApp(harness);
  }
});

test("pending draft image pick follows promotion and releases its lease", async () => {
  const pick = deferred<ZenXImageDraft[]>();
  const create = deferred<ReturnType<typeof started>>();
  const harness = await mountApp(oneProject(), {
    pickImages: async () => pick.promise,
    startProjectThread: async () => create.promise,
    request: async (method) => {
      if (method === "zen/turn/send") return {};
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Add images"]')
        ?.click(),
    );
    await setTextareaValue(composer, "Create with a late image");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(),
    );
    await act(async () => create.resolve(started(liveThread(), "/work/zen")));
    await waitFor(() => document.querySelector("#thread-composer"));
    await act(async () =>
      pick.resolve([
        {
          id: "late-image",
          name: "late.png",
          attachment: {
            type: "attachment",
            sha256: "a".repeat(64),
            mediaType: "image/png",
            byteLength: 4,
            width: 1,
            height: 1,
          },
        },
      ]),
    );
    await waitFor(() =>
      document.querySelector('[aria-label="Remove late.png"]'),
    );
  } finally {
    await unmountApp(harness);
  }
});

test("New thread replaces a pending Thread resume with the local draft", async () => {
  const resumeResponse = deferred<ReturnType<typeof resumed>>();
  let starts = 0;
  const projects: ZenXProjectProjectionSnapshot = {
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
  };
  const harness = await mountApp(projects, {
    request: async (method) => {
      if (method === "zen/thread/resume") return await resumeResponse.promise;
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    startProjectThread: async (workspace) => {
      starts += 1;
      return started(liveThread(), workspace);
    },
    threads: async (archived) => (archived ? [] : [summary(false)]),
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await act(async () => row.click());
    await waitFor(() =>
      /Loading conversation/u.test(document.body.textContent ?? ""),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    await waitFor(() => document.getElementById("thread-composer"));
    assert.match(
      document.body.textContent ?? "",
      /What should we build in zen\?/u,
    );
    assert.equal(starts, 0);

    await act(async () => {
      resumeResponse.resolve(resumed(liveThread()));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      document.body.textContent ?? "",
      /What should we build in zen\?/u,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("thread creation failure preserves the local draft for retry", async () => {
  let starts = 0;
  let created = false;
  const turnStarts: unknown[] = [];
  const projects: ZenXProjectProjectionSnapshot = {
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
    lastUsedWorkspace: "/work/zen",
  };
  const harness = await mountApp(projects, {
    request: async (method, params) => {
      if (method === "zen/turn/send") {
        turnStarts.push(params);
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    startProjectThread: async (workspace) => {
      starts += 1;
      if (starts === 1) throw new Error("runtime offline");
      created = true;
      return started(liveThread(), workspace);
    },
    threads: async (archived) => (!archived && created ? [summary(false)] : []),
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Retry this first message");
    const send = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    await invokeButtonClick(send);
    await waitFor(() =>
      /runtime offline/u.test(document.body.textContent ?? ""),
    );
    assert.equal(composer.value, "Retry this first message");
    assert.equal(turnStarts.length, 0);

    await invokeButtonClick(send);
    await waitFor(() => turnStarts.length === 1);
    assert.equal(starts, 2);
  } finally {
    await unmountApp(harness);
  }
});

test("turn failure retries on the created Thread with the stable message id", async () => {
  let starts = 0;
  let created = false;
  const turnStarts: Array<{ clientUserMessageId?: string }> = [];
  const projects: ZenXProjectProjectionSnapshot = {
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
    lastUsedWorkspace: "/work/zen",
  };
  const harness = await mountApp(projects, {
    request: async (method, params) => {
      if (method === "zen/turn/send") {
        turnStarts.push(params as { clientUserMessageId?: string });
        if (turnStarts.length === 1) throw new Error("turn rejected");
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    startProjectThread: async (workspace) => {
      starts += 1;
      created = true;
      return started(liveThread(), workspace);
    },
    threads: async (archived) => (!archived && created ? [summary(false)] : []),
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Keep one message identity");
    const send = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    await invokeButtonClick(send);
    await waitFor(() => /turn rejected/u.test(document.body.textContent ?? ""));
    assert.equal(starts, 1);
    assert.equal(composer.value, "Keep one message identity");

    await invokeButtonClick(
      await waitFor(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
      ),
    );
    await waitFor(() => turnStarts.length === 2);
    assert.equal(starts, 1);
    assert.equal(
      turnStarts[1]?.clientUserMessageId,
      turnStarts[0]?.clientUserMessageId,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("late create rejection restores the latest draft and stable submission id", async () => {
  const firstCreate = deferred<ReturnType<typeof started>>();
  const ids: string[] = [];
  let creates = 0;
  const harness = await mountApp(oneProject(), {
    startProjectThread: async (workspace) => {
      creates += 1;
      if (creates === 1) return firstCreate.promise;
      return started(liveThread(), workspace);
    },
    request: async (method, params) => {
      if (method === "zen/turn/send") {
        ids.push(
          (params as { clientUserMessageId: string }).clientUserMessageId,
        );
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Submitted first");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(),
    );
    await setTextareaValue(composer, "Latest queued edit");
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.click(),
    );
    await act(async () => firstCreate.reject(new Error("create rejected")));
    await waitFor(() => exactButton("Restore draft"));
    assert.match(document.body.textContent ?? "", /Settings/u);
    await act(async () => exactButton("Restore draft")?.click());
    const restored = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    assert.equal(restored.value, "Latest queued edit");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(),
    );
    await waitFor(() => ids.length === 1);
    assert.equal(creates, 2);
  } finally {
    await unmountApp(harness);
  }
});

test("a pending first Send finishes without stealing a newer navigation", async () => {
  const createResponse = deferred<ReturnType<typeof started>>();
  let created = false;
  const turnStarts: unknown[] = [];
  const projects: ZenXProjectProjectionSnapshot = {
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
    lastUsedWorkspace: "/work/zen",
  };
  const harness = await mountApp(projects, {
    request: async (method, params) => {
      if (method === "zen/turn/send") {
        turnStarts.push(params);
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    startProjectThread: async () => {
      const value = await createResponse.promise;
      created = true;
      return value;
    },
    threads: async (archived) => (!archived && created ? [summary(false)] : []),
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Finish in the background");
    await invokeButtonClick(
      await waitFor(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
      ),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.click(),
    );
    await waitFor(() => /Settings/u.test(document.body.textContent ?? ""));

    await act(async () => {
      createResponse.resolve(started(liveThread(), "/work/zen"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => turnStarts.length === 1);
    assert.match(document.body.textContent ?? "", /Settings/u);
    assert.equal(document.getElementById("thread-composer"), null);
  } finally {
    await unmountApp(harness);
  }
});

test("explicit newer draft discards stale recovery before unrelated errors", async () => {
  const create = deferred<ReturnType<typeof started>>();
  let starts = 0;
  const harness = await mountApp(oneProject(), {
    markWorkspaceUsed: async () => {
      throw new Error("later metadata error");
    },
    startProjectThread: async (workspace) => {
      starts += 1;
      if (starts === 1) return create.promise;
      return started(liveThread(), workspace);
    },
    request: async (method) => {
      if (method === "zen/turn/send") return {};
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    let composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Old recoverable draft");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.click(),
    );
    await act(async () => create.reject(new Error("old create failed")));
    await waitFor(() => exactButton("Restore draft"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "New draft wins");
    assert.equal(exactButton("Restore draft"), undefined);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(),
    );
    await waitFor(() =>
      /later metadata error/u.test(document.body.textContent ?? ""),
    );
    assert.equal(exactButton("Restore draft"), undefined);
  } finally {
    await unmountApp(harness);
  }
});

test("selecting an existing Thread discards stale recovery", async () => {
  const create = deferred<ReturnType<typeof started>>();
  const existing = summary(false, "existing-thread", "Existing thread");
  const harness = await mountApp(
    {
      projects: [
        { ...oneProject().projects[0]!, threadIds: [existing.threadId] },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    },
    {
      threads: async (archived) => (archived ? [] : [existing]),
      startProjectThread: async () => create.promise,
      request: async (method) => {
        if (method === "zen/thread/resume") return resumed(liveThread());
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    },
  );
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Recover me once");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.click(),
    );
    await act(async () => create.reject(new Error("create failed")));
    await waitFor(() => exactButton("Restore draft"));
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-thread-id="existing-thread"] > .thread-row',
        )
        ?.click(),
    );
    await waitFor(() => document.querySelector("#thread-composer"));
    assert.equal(exactButton("Restore draft"), undefined);
    assert.match(document.body.textContent ?? "", /Existing thread/u);
  } finally {
    await unmountApp(harness);
  }
});

test("New thread without a last-used Project visibly chooses No project and can open the menu", async () => {
  let starts = 0;
  const harness = await mountApp(
    {
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
    },
    {
      startProjectThread: async (workspace) => {
        starts += 1;
        return started(liveThread(), workspace);
      },
    },
  );
  try {
    await waitFor(() =>
      document.querySelector<HTMLElement>(".new-thread-draft-heading"),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    await waitFor(() => document.getElementById("thread-composer"));
    await act(async () => projectSwitcher()?.click());
    const menu = await waitFor(() =>
      document.querySelector<HTMLElement>(
        '[role="menu"][aria-label="Choose a Project"]',
      ),
    );
    const trigger = projectSwitcher();
    assert.ok(trigger);
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    const search = await waitFor(() =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Search projects"]',
      ),
    );
    await waitFor(() => document.activeElement === search);
    assert.match(menu.textContent ?? "", /zen/u);
    assert.match(
      document.body.textContent ?? "",
      /What should we build in No project/u,
    );
    assert.ok(
      document.querySelector('[role="dialog"][aria-label="Switch Project"]'),
    );
    assert.equal(starts, 0);

    const addProject = exactButton("Add project");
    assert.ok(addProject);
    await act(async () => {
      search.dispatchEvent(
        new window.FocusEvent("focusout", {
          bubbles: true,
          relatedTarget: addProject,
        }),
      );
    });
    assert.ok(
      document.querySelector('[role="menu"][aria-label="Choose a Project"]'),
    );
    const nextOutsideControl =
      document.querySelector<HTMLButtonElement>(".new-thread-action");
    assert.ok(nextOutsideControl);
    await act(async () => {
      addProject.focus();
      addProject.dispatchEvent(
        new window.FocusEvent("focusout", {
          bubbles: true,
          relatedTarget: nextOutsideControl,
        }),
      );
    });
    assert.equal(
      document.querySelector('[role="menu"][aria-label="Choose a Project"]'),
      null,
    );
    assert.notEqual(document.activeElement, trigger);
    await act(async () => trigger.click());
    await waitFor(
      () => document.activeElement?.getAttribute("type") === "search",
    );

    await act(async () => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector('[role="menu"][aria-label="Choose a Project"]'),
      null,
    );
    assert.equal(document.activeElement, trigger);
    await act(async () => trigger.click());
    await waitFor(
      () => document.activeElement?.getAttribute("type") === "search",
    );
    await act(async () => {
      document
        .querySelector<HTMLElement>(".new-thread-draft-empty")
        ?.dispatchEvent(
          new window.MouseEvent("pointerdown", { bubbles: true }),
        );
    });
    assert.equal(document.activeElement, trigger);
  } finally {
    await unmountApp(harness);
  }
});

test("same-leaf Projects show their parent paths in the draft chooser", async () => {
  const harness = await mountApp({
    projects: [
      {
        key: "/work/zen",
        workspace: "/work/zen",
        configured: true,
        isDefault: false,
        threadIds: [],
      },
      {
        key: "/tmp/zen",
        workspace: "/tmp/zen",
        configured: true,
        isDefault: false,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  try {
    const trigger = await waitFor(() => projectSwitcher());
    await act(async () => trigger.click());
    const menu = await waitFor(() =>
      document.querySelector<HTMLElement>(
        '[role="menu"][aria-label="Choose a Project"]',
      ),
    );
    assert.match(menu.textContent ?? "", /zen — \/work/u);
    assert.match(menu.textContent ?? "", /zen — \/tmp/u);
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search projects"]',
    );
    assert.ok(search);
    await setInputValue(search, "/tmp");
    await waitFor(
      () => menu.querySelectorAll('[role="menuitemradio"]').length === 1,
    );
    assert.doesNotMatch(menu.textContent ?? "", /zen — \/work/u);
    assert.match(menu.textContent ?? "", /zen — \/tmp/u);
    await act(async () => {
      search.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowDown",
        }),
      );
    });
    assert.equal(document.activeElement?.getAttribute("role"), "menuitemradio");
    const tmp = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).find((button) => button.getAttribute("aria-label")?.includes("/tmp/zen"));
    assert.ok(tmp);
    await act(async () => tmp.click());
    assert.match(
      document.body.textContent ?? "",
      /What should we build in zen — \/tmp\?/u,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("draft Project chooser stays within the viewport and only scrolls its results", async () => {
  const harness = await mountApp(oneProject());
  const originalInnerHeight = Object.getOwnPropertyDescriptor(
    window,
    "innerHeight",
  );
  const originalInnerWidth = Object.getOwnPropertyDescriptor(
    window,
    "innerWidth",
  );
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const trigger = await waitFor(() => projectSwitcher());
    let triggerTop = 40;
    let triggerBottom = 60;
    const messages = document.querySelector<HTMLElement>(".messages");
    assert.ok(messages);
    messages.getBoundingClientRect = () =>
      ({
        top: 24,
        bottom: 396,
        left: 0,
        right: 320,
        width: 320,
        height: 372,
        x: 0,
        y: 24,
        toJSON: () => ({}),
      }) as DOMRect;
    trigger.getBoundingClientRect = () =>
      ({
        top: triggerTop,
        bottom: triggerBottom,
        left: 400,
        right: 500,
        width: 100,
        height: triggerBottom - triggerTop,
        x: 400,
        y: triggerTop,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 420,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 320,
    });

    await act(async () => trigger.click());
    let popover = await waitFor(() =>
      document.querySelector<HTMLElement>(".new-thread-project-popover"),
    );
    assert.equal(popover.dataset.placement, "below");
    assert.equal(popover.style.maxHeight, "308px");
    assert.equal(popover.style.transform, "translateX(calc(-50% + -289px))");
    const results = popover.querySelector(".new-thread-project-menu");
    const actions = popover.querySelector(".new-thread-project-actions");
    assert.ok(results);
    assert.ok(actions);
    assert.equal(results.querySelector(".new-thread-project-add"), null);
    assert.ok(actions.querySelector(".new-thread-project-add"));

    triggerTop = 350;
    triggerBottom = 370;
    await act(async () => window.dispatchEvent(new window.Event("resize")));
    popover = await waitFor(() => {
      const candidate = document.querySelector<HTMLElement>(
        ".new-thread-project-popover",
      );
      return candidate?.dataset.placement === "above" ? candidate : undefined;
    });
    assert.equal(popover.style.maxHeight, "298px");
  } finally {
    if (originalInnerHeight === undefined) {
      Reflect.deleteProperty(window, "innerHeight");
    } else {
      Object.defineProperty(window, "innerHeight", originalInnerHeight);
    }
    if (originalInnerWidth === undefined) {
      Reflect.deleteProperty(window, "innerWidth");
    } else {
      Object.defineProperty(window, "innerWidth", originalInnerWidth);
    }
    await unmountApp(harness);
  }
});

for (const entry of ["heading", "chip"] as const) {
  test(`adding a new Project from ${entry} preserves the local draft`, async () => {
    let currentProjects = oneProject();
    let addWorkspaceCalls = 0;
    let starts = 0;
    const harness = await mountApp(currentProjects, {
      addWorkspace: async (workspace) => {
        addWorkspaceCalls += 1;
        currentProjects = {
          projects: [
            ...currentProjects.projects,
            {
              key: workspace,
              workspace,
              configured: true,
              isDefault: false,
              threadIds: [],
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: workspace,
        };
      },
      projectsGet: async () => currentProjects,
      startProjectThread: async (workspace) => {
        starts += 1;
        return started(liveThread(), workspace);
      },
    });
    try {
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(".new-thread-action")
          ?.click(),
      );
      const composer = await waitFor(() =>
        document.querySelector<HTMLTextAreaElement>("#thread-composer"),
      );
      await setTextareaValue(composer, "Keep this draft");
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            entry === "chip"
              ? ".new-thread-project-trigger-chip"
              : ".new-thread-project-trigger:not(.new-thread-project-trigger-chip)",
          )!
          .click(),
      );
      const addProject = await waitFor(() => exactButton("Add project"));
      await act(async () => addProject.click());
      const addFolder = await waitFor(() => exactButton("Add folder"));
      await waitFor(() => addFolder.disabled === false);
      await act(async () => addFolder.click());
      await waitFor(() => projectSwitcher()?.textContent?.trim() === "/");
      assert.equal(
        document.querySelector<HTMLTextAreaElement>("#thread-composer")?.value,
        "Keep this draft",
      );
      assert.equal(addWorkspaceCalls, 1);
      assert.equal(starts, 0);
    } finally {
      await unmountApp(harness);
    }
  });
}

test("first Turn starts before ancillary Project refresh completes", async () => {
  const marked = deferred<ReturnType<typeof publicSettings>>();
  let turnStarts = 0;
  const harness = await mountApp(
    {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: false,
          threadIds: [],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    },
    {
      markWorkspaceUsed: async () => marked.promise,
      startProjectThread: async (workspace) => started(liveThread(), workspace),
      request: async (method) => {
        if (method === "zen/turn/send") {
          turnStarts += 1;
          return {};
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    },
  );
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Start promptly");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(),
    );
    await waitFor(() => turnStarts === 1);
  } finally {
    marked.resolve(publicSettings([]));
    await unmountApp(harness);
  }
});

test("summary failure stays non-covering after real Thread promotion", async () => {
  let created = false;
  let turnStarts = 0;
  const harness = await mountApp(
    {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: false,
          threadIds: [],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    },
    {
      startProjectThread: async (workspace) => {
        created = true;
        return started(liveThread(), workspace);
      },
      threads: async () => {
        if (created) throw new Error("summary unavailable");
        return [];
      },
      request: async (method) => {
        if (method === "zen/turn/send") {
          turnStarts += 1;
          return {};
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    },
  );
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Keep the conversation visible");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(),
    );
    await waitFor(() => turnStarts === 1);
    assert.ok(document.querySelector("#thread-composer"));
    assert.match(document.body.textContent ?? "", /summary unavailable/u);
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /ZenX could not load data/u,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("title and mark-used failures are dismissible without covering the conversation", async () => {
  let turnStarts = 0;
  const harness = await mountApp(oneProject(), {
    observeTitle: async () => {
      throw new Error("title staging failed");
    },
    markWorkspaceUsed: async () => {
      throw new Error("mark used failed");
    },
    startProjectThread: async (workspace) => started(liveThread(), workspace),
    request: async (method) => {
      if (method === "zen/turn/send") {
        turnStarts += 1;
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Ancillary failures are not fatal");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(),
    );
    await waitFor(() => turnStarts === 1);
    assert.ok(document.querySelector("#thread-composer"));
    const notice = await waitFor(() =>
      document.querySelector<HTMLElement>(".app-notice[role=alert]"),
    );
    assert.match(
      notice.textContent ?? "",
      /(title staging failed|mark used failed)/u,
    );
    await act(async () => exactButton("Dismiss")?.click());
    assert.equal(document.querySelector(".app-notice"), null);
    assert.ok(document.querySelector("#thread-composer"));
  } finally {
    await unmountApp(harness);
  }
});

test("a Project revision lets an open draft reselect after its Project disappears", async () => {
  let starts = 0;
  let addWorkspaceCalls = 0;
  let markWorkspaceCalls = 0;
  let statusListener: ((status: AppServerHostStatus) => void) | undefined;
  let currentProjects: ZenXProjectProjectionSnapshot = {
    projects: [
      {
        key: "/work/zen",
        workspace: "/work/zen",
        configured: true,
        isDefault: true,
        threadIds: [],
      },
      {
        key: "/work/docs",
        workspace: "/work/docs",
        configured: true,
        isDefault: false,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: "/work/zen",
  };
  const harness = await mountApp(currentProjects, {
    addWorkspace: async () => {
      addWorkspaceCalls += 1;
    },
    markWorkspaceUsed: async () => {
      markWorkspaceCalls += 1;
      return publicSettings([]);
    },
    onStatus: (listener) => {
      statusListener = listener;
      return () => {
        statusListener = undefined;
      };
    },
    projectsGet: async () => currentProjects,
    startProjectThread: async (workspace) => {
      starts += 1;
      return started(liveThread(), workspace);
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    await waitFor(() => document.getElementById("thread-composer"));
    assert.match(
      document.body.textContent ?? "",
      /What should we build in zen\?/u,
    );

    currentProjects = {
      projects: [
        {
          key: "/work/docs",
          workspace: "/work/docs",
          configured: true,
          isDefault: true,
          threadIds: [],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/docs",
    };
    await act(async () => {
      statusListener?.({ type: "ready", reconnected: false });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      /zen unavailable/u.test(document.body.textContent ?? ""),
    );
    assert.match(
      document.querySelector(".composer-error")?.textContent ?? "",
      /no longer available/u,
    );

    await act(async () => projectSwitcher()?.click());
    const docs = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((button) => button.textContent?.includes("docs")),
    );
    assert.equal(docs.getAttribute("aria-checked"), "false");
    await act(async () => docs.click());
    assert.match(
      document.body.textContent ?? "",
      /What should we build in docs\?/u,
    );
    assert.equal(starts, 0);
    assert.equal(addWorkspaceCalls, 0);
    assert.equal(markWorkspaceCalls, 0);
  } finally {
    await unmountApp(harness);
  }
});

test("zero-Project New thread adds a Project but still does not create a Thread", async () => {
  const startedWorkspaces: string[] = [];
  let added = false;
  const emptyProjects: ZenXProjectProjectionSnapshot = {
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  const addedProjects: ZenXProjectProjectionSnapshot = {
    projects: [
      {
        key: "/",
        workspace: "/",
        configured: true,
        isDefault: true,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  };
  const harness = await mountApp(emptyProjects, {
    addWorkspace: async () => {
      added = true;
    },
    projectsGet: async () => (added ? addedProjects : emptyProjects),
    startProjectThread: async (workspace) => {
      startedWorkspaces.push(workspace);
      return started(liveThread(), workspace);
    },
  });
  try {
    const newThread = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".new-thread-action"),
    );
    assert.match(newThread.textContent ?? "", /No project/u);
    await act(async () => newThread.click());
    await waitFor(() => document.getElementById("thread-composer"));
    await act(async () => projectSwitcher()?.click());
    await act(async () => exactButton("Add project")?.click());
    await waitFor(() => document.querySelector('[role="dialog"]'));
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? "",
      /Add a project folder/u,
    );
    await act(async () => exactButton("Add folder")?.click());
    await waitFor(() => document.getElementById("thread-composer"));
    assert.deepEqual(startedWorkspaces, []);
  } finally {
    await unmountApp(harness);
  }
});

test("packaged startup clears a transient Project failure after the App Server becomes ready", async () => {
  const projects: ZenXProjectProjectionSnapshot = {
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
    lastUsedWorkspace: "/work/zen",
  };
  let statusListener: ((status: AppServerHostStatus) => void) | undefined;
  let projectCalls = 0;
  const harness = await mountApp(projects, {
    getStatus: async () => ({ type: "starting" }),
    onStatus: (listener) => {
      statusListener = listener;
      return () => {
        statusListener = undefined;
      };
    },
    projectsGet: async () => {
      projectCalls += 1;
      if (projectCalls === 1) throw new Error("Zen App Server is not ready");
      return projects;
    },
  });
  try {
    assert.match(document.body.textContent ?? "", /Starting Zen App Server/u);
    assert.ok(statusListener);

    await act(async () => {
      statusListener?.({ type: "ready", reconnected: false });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => projectCalls === 1);
    assert.match(
      document.body.textContent ?? "",
      /Zen App Server is not ready/u,
    );
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /Zen App Server stopped/u,
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.title,
      "Local service ready",
    );
    assert.match(
      document
        .querySelector<HTMLButtonElement>(".settings-nav-row")
        ?.getAttribute("aria-label") ?? "",
      /Local service ready/u,
    );

    await act(async () => {
      statusListener?.({ type: "starting" });
      statusListener?.({ type: "ready", reconnected: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => projectCalls === 2);
    await waitFor(
      () =>
        !(document.body.textContent ?? "").includes(
          "Zen App Server is not ready",
        ),
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.title,
      "Local service ready",
    );
    await waitFor(() =>
      document.querySelector<HTMLElement>(".new-thread-draft-heading"),
    );
    assert.match(
      document.body.textContent ?? "",
      /What should we build in zen\?/u,
    );
    assert.doesNotMatch(document.body.textContent ?? "", /No thread selected/u);

    await act(async () => {
      statusListener?.({ type: "error", message: "host exited" });
      await Promise.resolve();
    });
    assert.match(document.body.textContent ?? "", /Zen App Server stopped/u);
    assert.equal(
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.title,
      "Local service error: host exited",
    );
  } finally {
    await unmountApp(harness);
  }
});

test("zero-Project picker cancel fences delayed and duplicate folder selection", async () => {
  const add = deferred<void>();
  let adds = 0;
  const harness = await mountApp(
    { projects: [], unavailableThreadIds: [], lastUsedWorkspace: null },
    {
      addWorkspace: async () => {
        adds += 1;
        return add.promise;
      },
    },
  );
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    await waitFor(() => document.getElementById("thread-composer"));
    await act(async () => projectSwitcher()?.click());
    await act(async () => exactButton("Add project")?.click());
    await waitFor(() => document.querySelector(".directory-picker-dialog"));
    const addFolder = await waitFor(() => exactButton("Add folder"));
    await invokeButtonClick(addFolder, 2);
    assert.equal(adds, 1);
    await act(async () => exactButton("Cancel")?.click());
    await act(async () => add.resolve());
    assert.ok(document.querySelector("#thread-composer"));
    assert.equal(document.querySelector(".directory-picker-dialog"), null);
  } finally {
    await unmountApp(harness);
  }
});

test("same-event-loop duplicate Send owns one title stage and turn request", async () => {
  const titleResponse = deferred<undefined>();
  let titleCalls = 0;
  const turnStartRequests: unknown[] = [];
  const harness = await mountThreadApp({
    observeTitle: async () => {
      titleCalls += 1;
      return await titleResponse.promise;
    },
    request: async (method, params) => {
      if (method === "zen/thread/resume") return resumed(liveThread());
      if (method === "zen/turn/send") {
        turnStartRequests.push(params);
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Only once");
    const send = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    await invokePrimarySubmit(send, 2, async () => {
      titleResponse.resolve(undefined);
    });

    assert.equal(titleCalls, 1);
    assert.equal(turnStartRequests.length, 1);
  } finally {
    await unmountApp(harness);
  }
});

test("deleted Provider history stays readable and requires an explicit model switch before Send", async () => {
  const replacement = encodeModelKey({
    providerProfileId: "fake",
    modelId: "gpt-5.6-luna",
  });
  const turnRequests: unknown[] = [];
  const settingsRequests: unknown[] = [];
  const harness = await mountThreadApp({
    models: [wireModel(replacement, true, "Replacement model")],
    request: async (method, params) => {
      if (method === "zen/thread/resume")
        return nativeRecoveryForThread(liveThread(), {
          model: "old-model",
          modelProvider: "deleted-provider",
          reasoningEffort: "medium",
        });
      if (method === "zen/turn/send") {
        turnRequests.push(params);
        return {};
      }
      if (method === "thread/settings/update") {
        settingsRequests.push(params);
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const composer = await selectedComposer();
    assert.match(
      document.querySelector(".composer-error")?.textContent ?? "",
      /deleted-provider.*Choose a model before sending/u,
    );
    await setTextareaValue(composer, "Do not send with a deleted Provider");
    const send = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    await invokeButtonClick(send);
    assert.equal(turnRequests.length, 0);

    const modelTrigger = document.querySelector<HTMLButtonElement>(
      ".composer-model-trigger",
    );
    assert.ok(modelTrigger);
    await invokeButtonClick(modelTrigger);
    const modelEntry = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes("Model"));
    assert.ok(modelEntry);
    await invokeButtonClick(modelEntry);
    const replacementButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).find((button) => button.textContent?.includes("Replacement model"));
    assert.ok(replacementButton);
    await invokeButtonClick(replacementButton);
    assert.deepEqual(settingsRequests, [
      { threadId: "thread-1", model: replacement },
    ]);
  } finally {
    await unmountApp(harness);
  }
});

test("Composer keyboard and form routes do not duplicate one submit event", async () => {
  const turnStartRequests: unknown[] = [];
  const harness = await mountThreadApp({
    request: async (method, params) => {
      if (method === "zen/thread/resume") return resumed(liveThread());
      if (method === "zen/turn/send") {
        turnStartRequests.push(params);
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Keyboard message");
    await dispatchComposerKey(composer, { isComposing: true, key: "Enter" });
    await dispatchComposerKey(composer, { key: "Enter", repeat: true });
    assert.equal(turnStartRequests.length, 0);
    assert.equal(composer.value, "Keyboard message");

    await dispatchComposerKey(composer, { key: "Enter" });
    await waitFor(() => turnStartRequests.length === 1);
    await waitFor(() => composer.value === "");

    await setTextareaValue(composer, "Command Enter message");
    await dispatchComposerKey(composer, { key: "Enter", metaKey: true });
    await waitFor(() => turnStartRequests.length === 2);
    await waitFor(() => composer.value === "");

    await setTextareaValue(composer, "Form message");
    const form = document.querySelector<HTMLFormElement>("form.composer");
    assert.ok(form);
    await invokeFormSubmit(form);
    assert.equal(turnStartRequests.length, 3);
  } finally {
    await unmountApp(harness);
  }
});

for (const committed of [true, false] as const) {
  test(`uncertain native cancel ${committed ? "reads its committed fact" : "keeps its pending row"} without replay`, async () => {
    const base = nativeRecoveryForThread(runningThread());
    const queued = {
      id: "qa-queued",
      clientId: "qa-client",
      threadId: "thread-1",
      type: "user_message_queued" as const,
      createdAt: new Date(20_000).toISOString(),
      input: [{ type: "text" as const, text: "keep identity" }],
    };
    const cancellation = {
      id: "qa-cancelled",
      type: "user_message_queue_cancelled" as const,
      threadId: "thread-1",
      queuedItemId: queued.id,
      clientId: queued.clientId,
      createdAt: new Date(21_000).toISOString(),
    };
    let cancelCalls = 0;
    let readCalls = 0;
    const recovery = () => ({
      ...base,
      thread: {
        ...base.thread,
        items: [
          ...base.thread.items,
          queued,
          ...(committed && cancelCalls > 0 ? [cancellation] : []),
        ],
      },
    });
    const harness = await mountThreadApp({
      request: async (method) => {
        if (method === "zen/thread/resume") return recovery();
        if (method === "zen/thread/queue/cancel") {
          cancelCalls++;
          throw new Error("Transport closed after request; outcome unknown");
        }
        if (method === "zen/thread/read") {
          readCalls++;
          return { thread: recovery().thread };
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    });
    try {
      await selectedComposer();
      const button = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Cancel queued message 1"]',
        ),
      );
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      await waitFor(() => (readCalls === 1 ? true : undefined));
      assert.equal(cancelCalls, 1);
      assert.equal(readCalls, 1);
      if (committed) {
        await waitFor(() =>
          document.querySelector(".queue-shelf") === null ? true : undefined,
        );
      } else {
        assert.match(
          document.querySelector(".queue-shelf")?.textContent ?? "",
          /After this turn · 1/u,
        );
        await waitFor(() =>
          (
            document.querySelector(".queued-cancel-notice")?.textContent ?? ""
          ).includes("unconfirmed")
            ? true
            : undefined,
        );
      }
    } finally {
      await unmountApp(harness);
    }
  });
}

test("queue editor draft and pending request survive actual App loading unmount and do not steal another thread", async () => {
  type EditParams =
    import("../../../src/protocol/native/wire.js").NativeQueueEditParams;
  type EditResult =
    import("../../../src/protocol/native/wire.js").NativeQueueEditResult;
  const makeRecovery = (id: string, name: string) => {
    const base = nativeRecoveryForThread({
      ...liveThread(),
      id,
      sessionId: id,
      name,
    });
    return {
      ...base,
      thread: {
        ...base.thread,
        items: [
          ...base.thread.items,
          {
            id: `queued-${id}`,
            clientId: `client-${id}`,
            threadId: id,
            type: "user_message_queued" as const,
            createdAt: new Date(20_000).toISOString(),
            input: [{ type: "text" as const, text: `Original queued ${id}` }],
          },
        ],
      },
    };
  };
  const a = makeRecovery("thread-1", "Thread one");
  const b = makeRecovery("thread-2", "Thread two");
  const bLoading = deferred<typeof b>();
  const saving = deferred<EditResult>();
  const calls: EditParams[] = [];
  let bRequested = false;
  const harness = await mountApp(
    {
      ...oneProject(),
      projects: [
        { ...oneProject().projects[0]!, threadIds: ["thread-1", "thread-2"] },
      ],
    },
    {
      threads: async (archived) =>
        archived
          ? []
          : [summary(false), summary(false, "thread-2", "Thread two")],
      request: async (method, params) => {
        if (method === "zen/thread/resume") {
          if ((params as { threadId: string }).threadId === "thread-2") {
            bRequested = true;
            return await bLoading.promise;
          }
          return a;
        }
        if (method === "zen/thread/queue/edit") {
          calls.push(params as EditParams);
          return await saving.promise;
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    },
  );
  const editorText = () =>
    document.querySelector<HTMLTextAreaElement>(
      ".queued-message-editor textarea",
    );
  const selectThread = async (name: string) => {
    const row = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>(".thread-row")].find(
        (x) => x.textContent?.includes(name),
      ),
    );
    await act(async () => row.click());
  };
  const openEditor = async () => {
    const button = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".queue-row-edit"),
    );
    await act(async () => button.click());
    return await waitFor(editorText);
  };
  try {
    await selectThread("Thread one");
    const mainA = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(mainA, "Independent main draft A");
    const editA = await openEditor();
    await setTextareaValue(editA, "Preserved queue draft A");
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".queue-editor-save")!.click(),
    );
    await waitFor(() => calls.length === 1);
    const firstId = calls[0]!.editId;
    const oldView = document.querySelector(".thread-view")!;
    await selectThread("Thread two");
    await waitFor(() => bRequested);
    assert.equal(
      oldView.isConnected,
      false,
      "uncached navigation must really unmount ThreadView",
    );
    assert.equal(editA.isConnected, false);
    assert.equal(document.querySelector(".thread-view"), null);
    await act(async () => bLoading.resolve(b));
    const mainB = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(mainB, "Independent main draft B");
    await selectThread("Thread one");
    const reopened = await openEditor();
    assert.equal(reopened.value, "Preserved queue draft A");
    const save =
      document.querySelector<HTMLButtonElement>(".queue-editor-save")!;
    assert.equal(save.disabled, true);
    await act(async () => save.click());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.editId, firstId);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!.value,
      "Independent main draft A",
    );
    await selectThread("Thread two");
    const editB = await openEditor();
    await setTextareaValue(editB, "Independent queue draft B");
    await act(async () => editB.focus());
    await act(async () =>
      saving.resolve({
        status: "edited",
        queuedItemId: calls[0]!.queuedItemId,
        clientId: calls[0]!.clientId,
        revision: 1,
        editItemId: `edit-${firstId}`,
      }),
    );
    assert.equal(editorText(), editB);
    assert.equal(editB.value, "Independent queue draft B");
    assert.equal(document.activeElement, editB);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!.value,
      "Independent main draft B",
    );
    await selectThread("Thread one");
    const savedDraft = await openEditor();
    assert.equal(savedDraft.value, "Preserved queue draft A");
    assert.equal(
      document.querySelector<HTMLButtonElement>(".queue-editor-save")!.disabled,
      true,
      "receipt awaits exact canonical fact before another revision can be saved",
    );
    assert.match(
      document.querySelector(".queue-row")!.textContent!,
      /Original queued thread-1/u,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!.value,
      "Independent main draft A",
    );
  } finally {
    await unmountApp(harness);
  }
});

test("persisted queue edit recovers a lost event and response into the actual App projection without replay", async () => {
  type Params =
    import("../../../src/protocol/native/wire.js").NativeQueueEditParams;
  const base = nativeRecoveryForThread(liveThread());
  const queued = {
    id: "recover-edit-queue",
    clientId: "recover-edit-client",
    threadId: "thread-1",
    type: "user_message_queued" as const,
    createdAt: new Date(20_000).toISOString(),
    input: [{ type: "text" as const, text: "Original before uncertain edit" }],
  };
  let recovery = {
    ...base,
    thread: { ...base.thread, items: [...base.thread.items, queued] },
  };
  const calls: Params[] = [];
  let reads = 0;
  const harness = await mountThreadApp({
    request: async (method, params) => {
      if (method === "zen/thread/resume") return recovery;
      if (method === "zen/thread/queue/edit") {
        const edit = params as Params;
        calls.push(edit);
        recovery = {
          ...recovery,
          thread: {
            ...recovery.thread,
            items: [
              ...recovery.thread.items,
              {
                type: "user_message_queue_edited" as const,
                id: `edit-${edit.editId}`,
                threadId: edit.threadId,
                queuedItemId: edit.queuedItemId,
                clientId: edit.clientId,
                editId: edit.editId,
                revision: edit.expectedRevision + 1,
                input: edit.input,
                createdAt: new Date(21_000).toISOString(),
              },
            ],
          },
        };
        throw new Error(
          "Transport closed after durable append; event and response were lost",
        );
      }
      if (method === "zen/thread/read") {
        reads++;
        return { thread: recovery.thread };
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Main draft must survive recovery");
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".queue-row-edit")!.click(),
    );
    const edited = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>(
        ".queued-message-editor textarea",
      ),
    );
    await setTextareaValue(edited, "Recovered canonical edited input");
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".queue-editor-save")!.click(),
    );
    await waitFor(() =>
      document
        .querySelector(".queue-row")
        ?.textContent?.includes("Recovered canonical edited input"),
    );
    assert.equal(
      calls.length,
      1,
      "uncertain response is read back, never replayed",
    );
    assert.equal(reads, 1);
    assert.equal(calls[0]!.expectedRevision, 0);
    assert.equal(document.querySelectorAll(".queue-row").length, 1);
    assert.equal(
      document.querySelector(".queue-row")!.getAttribute("data-queue-id"),
      queued.id,
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!.value,
      "Main draft must survive recovery",
    );
    await waitFor(
      () => document.querySelector(".queued-message-editor") === null,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".queue-row-edit")!.click(),
    );
    const fresh = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>(
        ".queued-message-editor textarea",
      ),
    );
    assert.equal(fresh.value, "Recovered canonical edited input");
    assert.equal(
      document.querySelector<HTMLButtonElement>(".queue-editor-save")!.disabled,
      false,
      "observed recovered revision retires old syncing cache",
    );
    assert.equal(calls.length, 1);
  } finally {
    await unmountApp(harness);
  }
});

test("ambiguous historic Queue warns on current Thread, restores explicitly, and does not repeat", async () => {
  const migrated = {
    composerSendMode: "soft" as const,
    composerSendModeExplicit: false,
    composerSendModeMigration: {
      version: 1 as const,
      previousMode: "queue" as const,
      acknowledged: false,
    },
  };
  const savedUpdates: import("../src/main/host-profile.js").ZenXSettingsUpdate[] =
    [];
  const options = {
    initialProfile: migrated,
    onSettingsSave: (
      update: import("../src/main/host-profile.js").ZenXSettingsUpdate,
    ) => {
      savedUpdates.push(update);
    },
    request: async (method: string) => {
      if (method === "zen/thread/resume") return resumed(runningThread());
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  };
  const harness = await mountThreadApp(options);
  try {
    await selectedComposer();
    const notice = await waitFor(() =>
      document.querySelector(".composer-migration-notice"),
    );
    assert.match(notice.textContent ?? "", /older Queue preference/u);
    const restore = [...notice.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Restore per-message Queue"),
    );
    assert.ok(restore);
    await act(async () => restore.click());
    await waitFor(() =>
      savedUpdates.at(-1)?.composerSendMode === "queue" ? true : undefined,
    );
    assert.equal(savedUpdates.at(-1)?.composerSendModeExplicit, true);
    assert.equal(
      savedUpdates.at(-1)?.composerSendModeMigration?.acknowledged,
      true,
    );
    await waitFor(() =>
      document.querySelector(".composer-migration-notice") === null
        ? true
        : undefined,
    );
  } finally {
    await unmountApp(harness);
  }
  const reopened = await mountThreadApp({
    ...options,
    initialProfile: savedUpdates.at(-1) ?? migrated,
  });
  try {
    await selectedComposer();
    assert.equal(document.querySelector(".composer-migration-notice"), null);
  } finally {
    await unmountApp(reopened);
  }
});

test("acknowledging migrated Steer does not change implicit automation preference", async () => {
  const saved: import("../src/main/host-profile.js").ZenXSettingsUpdate[] = [];
  const harness = await mountThreadApp({
    initialProfile: {
      composerSendMode: "soft",
      composerSendModeExplicit: false,
      composerSendModeMigration: {
        version: 1,
        previousMode: "queue",
        acknowledged: false,
      },
    },
    onSettingsSave: (update) => saved.push(update),
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(runningThread());
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    await selectedComposer();
    const notice = await waitFor(() =>
      document.querySelector(".composer-migration-notice"),
    );
    const keep = [...notice.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Keep Steer"),
    );
    assert.ok(keep);
    await act(async () => keep.click());
    await waitFor(() => (saved.length === 1 ? true : undefined));
    assert.equal(saved[0]?.composerSendMode, "soft");
    assert.equal(saved[0]?.composerSendModeExplicit, false);
    assert.equal(saved[0]?.composerSendModeMigration?.acknowledged, true);
    await waitFor(() =>
      document.querySelector(".composer-migration-notice") === null
        ? true
        : undefined,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("native queue admission failure belongs to its queued Item and latest attempt", async () => {
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  const harness = await mountThreadApp({
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(runningThread());
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    await selectedComposer();
    assert.ok(notify);
    let watermark = 0;
    const send = async (
      event: import("../../../src/app-server.js").AppServerEvent,
      threadId = "thread-1",
    ) => {
      await act(async () => {
        notify?.("zen/thread/event", {
          threadId,
          processEpoch: "test-process-epoch",
          watermark: ++watermark,
          event,
        });
        await Promise.resolve();
      });
    };
    const image = {
      type: "attachment" as const,
      sha256: "0".repeat(64),
      mediaType: "image/png" as const,
      width: 1,
      height: 1,
      byteLength: 68,
    };
    for (const [id, clientId, input] of [
      ["queued-first", "first", [{ type: "text", text: "same" }]],
      ["queued-second", "second", [{ type: "image", attachment: image }]],
    ] as const) {
      await send({
        type: "item_completed",
        item: {
          id,
          clientId,
          input,
          type: "user_message_queued",
          threadId: "thread-1",
          createdAt: new Date(20_000).toISOString(),
        },
      });
    }
    const firstAttempt = "admission-one";
    const secondAttempt = "admission-two";
    const begun = (
      attemptId: string,
    ): import("../../../src/app-server.js").AppServerEvent => ({
      type: "queue_admission_started",
      threadId: "thread-1",
      queuedItemId: "queued-second",
      clientId: "second",
      attemptId,
    });
    const rejected = (
      attemptId: string,
    ): import("../../../src/app-server.js").AppServerEvent => ({
      type: "queue_failed",
      threadId: "thread-1",
      queuedItemId: "queued-second",
      clientId: "second",
      attemptId,
      code: "image_input_unsupported",
      message: "Choose an image-capable model, then Continue queue.",
    });
    await send(begun(firstAttempt));
    await send(rejected(firstAttempt));
    assert.match(
      document.querySelector(".queue-row-error")?.textContent ?? "",
      /image-capable model/u,
    );
    assert.equal(document.querySelectorAll(".queue-row-error").length, 1);
    assert.equal(
      document
        .querySelector(".queue-row-error")
        ?.closest(".queue-row")
        ?.getAttribute("data-queue-id"),
      "queued-second",
    );
    assert.equal(
      document.querySelector('[data-queue-id="queued-first"] .queue-row-error'),
      null,
    );
    await send(begun(secondAttempt));
    assert.equal(document.querySelector(".queue-row-error"), null);
    await send(rejected(firstAttempt)); // stale first attempt cannot override the new one
    assert.equal(document.querySelector(".queue-row-error"), null);
    await send(rejected(secondAttempt), "another-thread");
    assert.equal(document.querySelector(".queue-row-error"), null);
    await send(rejected(secondAttempt));
    assert.equal(document.querySelectorAll(".queue-row-error").length, 1);
    await send(rejected(secondAttempt)); // duplicate notification does not duplicate a card
    assert.equal(document.querySelectorAll(".queue-row-error").length, 1);
    await send({
      type: "item_completed",
      item: {
        id: "accepted-second",
        type: "user_message",
        threadId: "thread-1",
        turnId: "turn-1",
        clientId: "second",
        content: [{ type: "image", attachment: image }],
        createdAt: new Date(21_000).toISOString(),
      },
    });
    assert.equal(document.querySelector(".queue-row-error"), null);
    assert.match(
      document.querySelector(".queue-shelf")?.textContent ?? "",
      /After this turn · 1/u,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("running queue, soft steer and hard steer each own one pending admission", async () => {
  for (const [mode, wireMode, label] of [
    ["batch", "batch-next", "Next turn"],
    ["queue", "queue", "Each turn"],
    ["soft", undefined, "Steer now"],
    ["hard", "replace", "Interrupt and send"],
  ] as const) {
    const response = deferred<unknown>();
    let calls = 0;
    const harness = await mountThreadApp({
      composerSendMode: mode,
      request: async (requestedMethod, params) => {
        if (requestedMethod === "zen/thread/resume")
          return resumed(runningThread());
        if (requestedMethod === "zen/turn/send") {
          assert.equal((params as { mode?: string }).mode, wireMode);
          assert.equal(
            (params as { expectedTurnId?: string }).expectedTurnId,
            mode === "hard" ? "turn-1" : undefined,
          );
          calls += 1;
          return await response.promise;
        }
        throw new Error(`Unexpected protocol request: ${requestedMethod}`);
      },
    });
    try {
      const composer = await selectedComposer();
      await setTextareaValue(composer, "Guide this turn");
      const send = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`),
      );
      await invokePrimarySubmit(send, 2);
      assert.equal(calls, 1);
      await act(async () => {
        response.resolve({ turnId: "turn-1" });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => composer.value === "");
    } finally {
      await unmountApp(harness);
    }
  }
});

test("passive UI activation pending or failed never gates admission or consumes another draft", async (t) => {
  const diagnostic = t.mock.method(console, "error", () => {});
  for (const capture of ["pending", "degraded", "rejected"] as const) {
    const receipt = deferred<{ observed: boolean }>();
    const admission = deferred<unknown>();
    const activations: Array<{ observation: unknown }> = [];
    const sends: Array<{
      clientObservation: unknown;
      clientUserMessageId: string;
    }> = [];
    const harness = await mountThreadApp({
      observeActivation: async (params) => {
        activations.push(params as { observation: unknown });
        if (capture === "pending") return receipt.promise;
        if (capture === "rejected") throw Error("synthetic Trace unavailable");
        return { observed: false };
      },
      request: async (method, params) => {
        if (method === "zen/thread/resume") return resumed(runningThread());
        assert.equal(method, "zen/turn/send");
        assert.equal((params as { mode: string }).mode, "queue");
        sends.push(params as (typeof sends)[number]);
        return admission.promise;
      },
    });
    try {
      const composer = await selectedComposer();
      await setTextareaValue(composer, "original");
      const button = await waitFor(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Each turn"]'),
      );
      await invokePrimarySubmit(button, 2);
      assert.equal(
        sends.length,
        1,
        "pending admission still deduplicates repeated submit",
      );
      assert.equal(
        activations.length,
        2,
        "each actual handler activation is observed, not each admission",
      );
      assert.deepEqual(
        sends[0]!.clientObservation,
        activations[0]!.observation,
      );
      assert.equal(
        composer.value,
        "original",
        "observation cannot consume a draft",
      );
      assert.equal(document.querySelector(".composer-error"), null);
      await setTextareaValue(composer, "new draft");
      await act(async () => {
        admission.resolve({});
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(
        composer.value,
        "new draft",
        "late admission keeps newer draft generation",
      );
      assert.equal(sends.length, 1, "failed observation never resends input");
      assert.equal(document.querySelector(".composer-error"), null);
    } finally {
      await act(async () => {
        receipt.resolve({ observed: true });
        await Promise.resolve();
      });
      await unmountApp(harness);
    }
  }
  assert.equal(
    diagnostic.mock.callCount(),
    4,
    "both activations in each degraded/rejected case produce explicit diagnostics",
  );
});

for (const path of [
  "rpc",
  "canonical",
  "canonical-before-error-with-mode-return",
  "unknown-then-edit",
] as const) {
  test(`React App ${path}: late old admission cannot clear a new draft generation`, async () => {
    const response = deferred<unknown>();
    let clientId: string | undefined;
    let notify:
      Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
    let settingsChanged:
      ((value: ReturnType<typeof publicSettings>) => void) | undefined;
    const harness = await mountThreadApp({
      onSettingsChanged: (listener) => {
        settingsChanged = listener;
        return () => {
          settingsChanged = undefined;
        };
      },
      onNotification: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      request: async (method, params) => {
        if (method === "zen/thread/resume") return resumed(runningThread());
        if (method === "zen/turn/send") {
          assert.equal((params as { mode?: string }).mode, "queue");
          clientId = (params as { clientUserMessageId: string })
            .clientUserMessageId;
          return await response.promise;
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    });
    try {
      const composer = await selectedComposer();
      await setTextareaValue(composer, "original");
      await invokeFormSubmit(
        document.querySelector<HTMLFormElement>("form.composer")!,
      );
      await waitFor(() => clientId !== undefined);
      if (path === "unknown-then-edit") {
        await act(async () => {
          response.reject(new Error("request outcome unknown"));
          await Promise.resolve();
          await Promise.resolve();
        });
        await waitFor(() => document.querySelector(".composer-error"));
      }
      if (path !== "canonical-before-error-with-mode-return") {
        await setTextareaValue(composer, "changed");
        await setTextareaValue(composer, "original");
      }
      if (path === "unknown-then-edit")
        assert.equal(document.querySelector(".composer-error"), null);
      if (path === "canonical-before-error-with-mode-return") {
        assert.ok(settingsChanged);
        await act(async () => {
          const soft = publicSettings([]);
          soft.profile.composerSendMode = "soft";
          settingsChanged?.(soft);
          const back = publicSettings([]);
          back.profile.composerSendMode = "queue";
          settingsChanged?.(back);
          await Promise.resolve();
        });
      }
      const confirm = () =>
        notify?.("zen/thread/event", {
          threadId: "thread-1",
          processEpoch: "test-process-epoch",
          watermark: 1,
          event: {
            type: "item_completed",
            item: {
              type: "user_message_queued",
              id: "qa-queued",
              clientId: clientId!,
              threadId: "thread-1",
              createdAt: new Date().toISOString(),
              input: [{ type: "text", text: "original" }],
            },
          },
        });
      if (path === "rpc") {
        await act(async () => {
          response.resolve({});
          await Promise.resolve();
          await Promise.resolve();
        });
      } else if (path === "canonical") {
        await act(async () => {
          response.reject(new Error("request outcome unknown"));
          await Promise.resolve();
          await Promise.resolve();
        });
        await act(async () => confirm());
      } else if (path === "unknown-then-edit") {
        await act(async () => confirm());
      } else {
        await act(async () => confirm());
        await act(async () => {
          response.reject(new Error("request outcome unknown"));
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      assert.equal(composer.value, "original");
      if (path !== "rpc")
        assert.match(
          document.querySelector(".queue-shelf")?.textContent ?? "",
          /After this turn · 1/u,
        );
      assert.equal(document.querySelector(".composer-error"), null);
    } finally {
      await unmountApp(harness);
    }
  });
}

test("late canonical queue ID settles only the original unknown submission, not another Thread's draft", async () => {
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  const sends: Array<{ clientUserMessageId: string }> = [];
  const harness = await mountApp(
    {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: true,
          threadIds: ["thread-1", "thread-2"],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    },
    {
      threads: async (archived) =>
        archived
          ? []
          : [summary(false), summary(false, "thread-2", "Thread two")],
      onNotification: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      request: async (method, params) => {
        if (method === "zen/thread/resume") {
          const threadId = (params as { threadId: string }).threadId;
          return resumed({
            ...runningThread(),
            id: threadId,
            sessionId: threadId,
          });
        }
        if (method === "turn/queue" || method === "zen/turn/send") {
          sends.push(params as { clientUserMessageId: string });
          throw new Error(
            "Input admission reply timed out; request outcome unknown. No request was resent.",
          );
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    },
  );
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "identical text");
    await invokeFormSubmit(
      document.querySelector<HTMLFormElement>("form.composer")!,
    );
    await waitFor(() => document.querySelector(".composer-error"));
    assert.equal(sends.length, 1);
    const clientId = sends[0]!.clientUserMessageId;
    assert.match(document.body.textContent ?? "", /outcome unknown/u);
    assert.equal(composer.value, "identical text");
    await act(async () =>
      notify?.("zen/thread/event", {
        threadId: "thread-1",
        processEpoch: "test-process-epoch",
        watermark: 1,
        event: {
          type: "item_completed",
          item: {
            type: "user_message_queued",
            id: "other-item",
            clientId: "other-client-id",
            threadId: "thread-1",
            createdAt: new Date().toISOString(),
            input: [{ type: "text", text: "identical text" }],
          },
        },
      }),
    );
    assert.equal(composer.value, "identical text");
    const rowTwo = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ].find((row) => row.textContent?.includes("Thread two"));
    assert.ok(rowTwo);
    await invokeButtonClick(rowTwo);
    const otherComposer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(otherComposer, "different thread draft");
    await act(async () =>
      notify?.("zen/thread/event", {
        threadId: "thread-1",
        processEpoch: "test-process-epoch",
        watermark: 2,
        event: {
          type: "item_completed",
          item: {
            type: "user_message_queued",
            id: "admitted-item",
            clientId,
            threadId: "thread-1",
            createdAt: new Date().toISOString(),
            input: [{ type: "text", text: "identical text" }],
          },
        },
      }),
    );
    assert.equal(otherComposer.value, "different thread draft");
    const rowOne = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ].find((row) => row.textContent?.includes("Thread one"));
    assert.ok(rowOne);
    await invokeButtonClick(rowOne);
    await waitFor(
      () =>
        document.querySelector<HTMLTextAreaElement>("#thread-composer")
          ?.value === "",
    );
    // The matching receipt clears the unknown-send error and original draft;
    // it does not leave an implementation-level success note in the composer.
    assert.equal(document.querySelector(".composer-error"), null);
    assert.equal(document.querySelector(".composer-note"), null);
    await act(async () =>
      notify?.("zen/thread/event", {
        threadId: "thread-1",
        processEpoch: "test-process-epoch",
        watermark: 3,
        event: {
          type: "item_completed",
          item: {
            type: "user_message",
            id: "delivered-item",
            clientId,
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: new Date().toISOString(),
            text: "identical text",
          },
        },
      }),
    );
    assert.ok(document.querySelector(".turn.inProgress"));
    assert.equal(document.querySelector(".composer-note"), null);
    await act(async () =>
      notify?.("zen/thread/event", {
        threadId: "thread-1",
        processEpoch: "test-process-epoch",
        watermark: 4,
        event: {
          type: "turn_completed",
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
        },
      }),
    );
    assert.ok(document.querySelector(".turn.completed"));
    assert.equal(document.querySelector(".composer-note"), null);
    await setTextareaValue(composer, "new draft after reconnect");
    await invokeFormSubmit(
      document.querySelector<HTMLFormElement>("form.composer")!,
    );
    await waitFor(() => sends.length === 2);
    assert.notEqual(sends[1]!.clientUserMessageId, clientId);
    await waitFor(() => document.querySelector(".composer-error"));
    await act(async () =>
      notify?.("zen/thread/event", {
        threadId: "thread-1",
        processEpoch: "test-process-epoch",
        watermark: 5,
        event: {
          type: "item_completed",
          item: {
            type: "user_message",
            id: "late-old-message",
            clientId,
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: new Date().toISOString(),
            text: "identical text",
          },
        },
      }),
    );
    assert.equal(composer.value, "new draft after reconnect");
    assert.match(document.body.textContent ?? "", /outcome unknown/u);
    assert.equal(sends.length, 2);
  } finally {
    await unmountApp(harness);
  }
});

test("failed Send preserves its draft and stable id for a deliberate retry", async () => {
  const turnStartRequests: Array<{
    clientUserMessageId?: string;
  }> = [];
  const harness = await mountThreadApp({
    request: async (method, params) => {
      if (method === "zen/thread/resume") return resumed(liveThread());
      if (method === "zen/turn/send") {
        turnStartRequests.push(
          (params ?? {}) as { clientUserMessageId?: string },
        );
        if (turnStartRequests.length === 1) throw new Error("offline");
        return {};
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Retry this message");
    const send = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    await act(async () => {
      send.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => (document.body.textContent ?? "").includes("offline"));
    assert.equal(composer.value, "Retry this message");

    await act(async () => {
      send.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => turnStartRequests.length === 2);
    assert.equal(
      turnStartRequests[1]?.clientUserMessageId,
      turnStartRequests[0]?.clientUserMessageId,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("host recovery refreshes the selected Thread without clearing draft or local navigation", async () => {
  let statusListener: ((status: AppServerHostStatus) => void) | undefined;
  let notificationListener:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  let resumeCalls = 0;
  const reconnected = deferred<ReturnType<typeof nativeRecoveryForThread>>();
  const harness = await mountThreadApp({
    onStatus: (listener) => {
      statusListener = listener;
      return () => {
        statusListener = undefined;
      };
    },
    onNotification: (listener) => {
      notificationListener = listener;
      return () => {
        notificationListener = undefined;
      };
    },
    request: async (method) => {
      if (method === "zen/thread/resume") {
        resumeCalls += 1;
        return resumeCalls === 1
          ? nativeRecoveryForThread(liveThread(), {
              processEpoch: "old-host",
            })
          : await reconnected.promise;
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Keep this local draft");
    const openWorkspace = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Open side panel"]',
      ),
    );
    await act(async () => openWorkspace.click());
    await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Close side panel"]',
      ),
    );
    assert.ok(statusListener);
    assert.ok(notificationListener);

    await act(async () => {
      statusListener?.({ type: "reconnecting", attempt: 1, delayMs: 10 });
      statusListener?.({ type: "ready", reconnected: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => resumeCalls === 2);
    await act(async () => {
      notificationListener?.("zen/thread/event", {
        processEpoch: "new-host",
        threadId: "thread-1",
        watermark: 1,
        event: {
          type: "item_completed",
          item: {
            id: "new-host-message",
            type: "agent_message",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: new Date(20_000).toISOString(),
            text: "Arrived after the recovery snapshot",
          },
        },
      });
      reconnected.resolve(
        nativeRecoveryForThread(runningThread(), {
          processEpoch: "new-host",
          watermark: 0,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      document.body.textContent ?? "",
      /Arrived after the recovery snapshot/u,
    );
    assert.ok(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Close side panel"]',
      ),
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")?.value,
      "Keep this local draft",
    );
  } finally {
    await unmountApp(harness);
  }
});

test("conversation header omits usage while Composer owns context indicator and workspace action remains", async () => {
  const longTitle =
    "Verify the complete ZenX integrated title bar with an intentionally long real Thread title";
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
      threads: async (archived) =>
        archived ? [] : [{ ...summary(false), name: longTitle }],
      modelUsage: async () => ({
        thread: {
          responseCount: 1,
          inputTokens: 200,
          cachedInputTokens: 50,
          outputTokens: 25,
          cacheHitRate: undefined,
        },
        turns: {},
        context: {
          inputTokens: 200,
          inputTokenSource: "provider",
          contextWindow: 400,
          ratio: 0.5,
        },
      }),
      request: async (method) => {
        if (method === "zen/thread/resume")
          return started(liveThread(), "/work/zen");
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    },
  );
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")?.click(),
    );
    await waitFor(() => document.getElementById("thread-composer"));
    const titlebarSession = document.querySelector(
      ".window-titlebar-session .workspace-header",
    );
    assert.ok(titlebarSession);
    assert.equal(
      titlebarSession.querySelector(".thread-title-line > strong")?.textContent,
      longTitle,
    );
    assert.equal(
      titlebarSession
        .querySelector(".thread-title-line > strong")
        ?.getAttribute("title"),
      longTitle,
    );
    assert.equal(
      document.querySelector(".agent-surface > .workspace-header"),
      null,
    );
    assert.doesNotMatch(
      document.querySelector(".workspace-header")?.textContent ?? "",
      /Context|Thread cache|50%/u,
    );
    for (const language of ["en", "zh-CN"]) {
      await act(async () => {
        await i18n.changeLanguage(language);
      });
      const rename: HTMLButtonElement =
        titlebarSession.querySelector<HTMLButtonElement>(
          ".thread-title-line button",
        )!;
      assert.equal(rename.type, "button");
      assert.equal(rename.textContent, "");
      assert.equal(rename.title, i18n.t("shell:renameThreadTitle"));
      assert.equal(rename.getAttribute("aria-label"), rename.title);
      assert.equal(
        rename.querySelector("svg")?.getAttribute("data-icon"),
        "compose",
      );
      assert.equal(rename.querySelector("svg")?.getAttribute("width"), "16");
      assert.equal(
        rename.querySelector("svg")?.getAttribute("aria-hidden"),
        "true",
      );
      await act(async () => rename.focus());
      assert.equal(document.activeElement, rename);
      await act(async () => rename.click());
      const input: HTMLInputElement =
        titlebarSession.querySelector<HTMLInputElement>(
          ".thread-title-form input",
        )!;
      assert.equal(input.value, longTitle);
      assert.equal(document.activeElement, input);
      await act(async () =>
        titlebarSession
          .querySelector<HTMLButtonElement>(
            '.thread-title-form button[type="button"]',
          )!
          .click(),
      );
      assert.equal(titlebarSession.querySelector(".thread-title-form"), null);
      assert.equal(
        titlebarSession.querySelector(".thread-title-line > strong")
          ?.textContent,
        longTitle,
      );
    }
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    const contextIndicator = document.querySelector<HTMLButtonElement>(
      ".composer .context-usage-trigger",
    );
    assert.ok(contextIndicator);
    assert.equal(contextIndicator.getAttribute("aria-haspopup"), "dialog");
    assert.equal(contextIndicator.getAttribute("aria-expanded"), "false");
    assert.match(
      contextIndicator.getAttribute("aria-label") ?? "",
      /Context 50%/u,
    );
    assert.equal(
      document.querySelector(".messages-inner > .thread-usage"),
      null,
    );
    const workspaceAction = document.querySelector(
      '.app-shell > [aria-label="Open side panel"]',
    );
    assert.ok(workspaceAction);
    assert.equal(
      document
        .querySelector('.app-shell > [aria-label="Open side panel"]')
        ?.getAttribute("disabled"),
      null,
    );
    assert.equal(
      document.querySelector(
        '.workspace-header [aria-label="Thread search is not available in this build"]',
      ),
      null,
    );
    assert.doesNotMatch(
      document.querySelector(".workspace-header")?.textContent ?? "",
      /Archive/u,
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
        if (method === "zen/thread/resume")
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
        if (method === "zen/thread/resume")
          return {
            thread: liveThread(),
            model: "fake",
            modelProvider: "fake",
          };
        if (method === "thread/archive") return await archiveResponse.promise;
        if (method === "zen/turn/send") {
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
        if (method === "zen/thread/resume")
          return {
            thread: liveThread(),
            model: "fake",
            modelProvider: "fake",
          };
        if (method === "thread/archive") return await archiveResponse.promise;
        if (method === "zen/turn/send") {
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
        if (method === "zen/thread/resume")
          return {
            thread: liveThread(),
            model: "fake",
            modelProvider: "fake",
          };
        if (method === "thread/archive") {
          archiveCalls += 1;
          return await archiveResponse.promise;
        }
        if (method === "zen/turn/send") {
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

test("existing Thread reasoning selection follows native settings events", async () => {
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  const projects = oneProject();
  projects.projects[0]!.threadIds = ["thread-1"];
  const model = wireModel("fake", true);
  model.supportedReasoningEfforts.push({
    reasoningEffort: "high",
    description: "high",
  });
  const recovery = nativeRecoveryForThread(liveThread(), {
    reasoningEffort: null,
  });
  const harness = await mountApp(projects, {
    models: [model],
    threads: async (archived) => (archived ? [] : [summary(false)]),
    onNotification: (listener) => {
      notify = listener;
      return () => undefined;
    },
    request: async (method, params) => {
      if (method === "zen/thread/resume") return recovery;
      if (method === "thread/settings/update") {
        assert.deepEqual(params, {
          threadId: "thread-1",
          model: model.id,
          effort: "high",
        });
        notify?.("zen/thread/event", {
          processEpoch: recovery.processEpoch,
          threadId: "thread-1",
          watermark: 1,
          event: {
            type: "thread_settings_updated",
            threadId: "thread-1",
            settings: { ...recovery.thread, reasoningEffort: "high" },
          },
        });
        return {};
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  try {
    const row = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".thread-row"),
    );
    await invokeButtonClick(row);
    await waitFor(() => document.querySelector("#thread-composer"));
    const trigger = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".composer-model-trigger"),
    );
    await invokeButtonClick(trigger);
    const reasoning = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).find((button) => button.textContent?.startsWith("Reasoning")),
    );
    await invokeButtonClick(reasoning);
    const high = await waitFor(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((button) => button.textContent === "High"),
    );
    await invokeButtonClick(high);
    assert.match(trigger.textContent ?? "", /High/u);
    await invokeButtonClick(trigger);
    await invokeButtonClick(
      await waitFor(() =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        ).find((button) => button.textContent?.startsWith("Reasoning")),
      ),
    );
    assert.equal(
      document.querySelector('[role="menuitemradio"][aria-checked="true"]')
        ?.textContent,
      "High",
    );
  } finally {
    await unmountApp(harness);
  }
});

test("current permissions follow notifications even when the Thread list fails", async () => {
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  let failList = false;
  const projects = oneProject();
  projects.projects[0]!.threadIds = ["thread-1"];
  const harness = await mountApp(projects, {
    threads: async (archived) => {
      if (failList) throw new Error("list unavailable");
      return archived
        ? []
        : [
            {
              ...summary(false),
              currentMetadata: {
                model: "fake",
                provider: "fake",
                cwd: "/work/zen",
                sandbox: "read-only",
                approvalPolicy: "always",
              },
            } as NativeThreadSummary,
          ];
    },
    onNotification: (listener) => {
      notify = listener;
      return () => undefined;
    },
    request: async (method) => {
      if (method === "zen/thread/resume")
        return nativeRecoveryForThread(liveThread(), {
          sandbox: "read-only",
          approvalPolicy: "on-request",
        });
      throw new Error(`Unexpected ${method}`);
    },
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")?.click(),
    );
    const select = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="File permissions"]',
      ),
    );
    assert.equal(select.textContent, "Read only");
    failList = true;
    await act(async () =>
      notify?.("thread/settings/updated", {
        threadId: "thread-1",
        threadSettings: {
          approvalPolicy: "never",
          approvalsReviewer: "user",
          collaborationMode: {
            mode: "default",
            settings: { model: "fake", reasoning_effort: null },
          },
          cwd: "/work/zen",
          effort: null,
          model: "fake",
          modelProvider: "fake",
          personality: null,
          sandboxPolicy: { type: "dangerFullAccess" },
          serviceTier: null,
          summary: null,
        },
      }),
    );
    await waitFor(() => select.textContent === "Full access");
    assert.equal(select.disabled, false);
    assert.match(document.body.textContent ?? "", /list unavailable/);
  } finally {
    await unmountApp(harness);
  }
});

function twoProjectSnapshot(): ZenXProjectProjectionSnapshot {
  return {
    projects: [
      {
        key: "/work/documents",
        workspace: "/work/documents",
        configured: true,
        isDefault: false,
        threadIds: ["existing-thread"],
      },
      {
        key: "/work/zen",
        workspace: "/work/zen",
        configured: true,
        isDefault: true,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: "/work/zen",
  };
}

async function chooseDraftProject(name: string): Promise<void> {
  await act(async () => projectSwitcher()?.click());
  const option = await waitFor(() =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '.new-thread-project-popover [role="menuitemradio"]',
      ),
    ).find((button) => button.textContent?.includes(name)),
  );
  await act(async () => option.click());
}

test("the Composer-context Project chip opens the searchable switcher", async () => {
  const projects = twoProjectSnapshot();
  let projectReads = 0;
  const harness = await mountApp(projects, {
    projectsGet: async () => {
      projectReads += 1;
      return projects;
    },
  });
  try {
    await waitFor(() => projectReads > 0);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const chip = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        ".new-thread-composer-context .new-thread-project-trigger-chip",
      ),
    );
    assert.match(chip.textContent ?? "", /zen/u);
    assert.equal(chip.getAttribute("aria-haspopup"), "dialog");
    assert.equal(chip.getAttribute("aria-expanded"), "false");

    await act(async () => chip.click());
    const portal = await waitFor(() =>
      document.querySelector<HTMLElement>(".new-thread-project-popover-portal"),
    );
    assert.equal(chip.getAttribute("aria-expanded"), "true");
    // The central heading keeps its own popover closed while the chip is open.
    assert.equal(
      document.querySelectorAll(".new-thread-project-popover").length,
      0,
    );
    const search = portal.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    assert.ok(search);
    assert.equal(search.getAttribute("aria-label"), "Search projects");
    await act(async () => setInputValue(search, "documents"));
    const options = await waitFor(() =>
      Array.from(
        portal.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ),
    );
    assert.equal(options.length, 1);
    assert.match(options[0]?.textContent ?? "", /documents/u);
    assert.ok(portal.querySelector(".new-thread-project-add"));

    await act(async () => options[0]?.click());
    assert.equal(
      document.querySelector(".new-thread-project-popover-portal"),
      null,
    );
    assert.match(
      document.querySelector(".new-thread-draft-heading")?.textContent ?? "",
      /What should we build in documents\?/u,
    );
    assert.match(chip.textContent ?? "", /documents/u);
  } finally {
    await unmountApp(harness);
  }
});

test("the Chinese welcome sentence embeds the Project name in the middle", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    const harness = await mountApp(oneProject(), {});
    try {
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(".new-thread-action")
          ?.click(),
      );
      const heading = await waitFor(() =>
        document.querySelector<HTMLElement>(".new-thread-draft-heading"),
      );
      assert.match(heading.textContent ?? "", /我们要在 zen 中构建什么？/u);
    } finally {
      await unmountApp(harness);
    }
  } finally {
    await i18n.changeLanguage("en");
  }
});

test("welcome drafts retain unsent input per Project, restore across navigation, and are consumed by the first Send", async () => {
  const selectedStart = deferred<ReturnType<typeof started>>();
  const startedWorkspaces: string[] = [];
  let created = false;
  const existing = summary(
    false,
    "existing-thread",
    "Existing thread",
    "/work/documents",
  );
  const projects = twoProjectSnapshot();
  const harness = await mountApp(projects, {
    addWorkspace: async () => undefined,
    markWorkspaceUsed: async () => publicSettings([]),
    projectsGet: async () => projects,
    threads: async (archived) =>
      archived
        ? []
        : created
          ? [existing, summary(false, "thread-1", "Thread one", "/work/zen")]
          : [existing],
    startProjectThread: async (workspace) => {
      startedWorkspaces.push(workspace);
      const value = await selectedStart.promise;
      created = true;
      return value;
    },
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(liveThread());
      if (method === "turn/start") return {};
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  const draftText = () =>
    document.querySelector<HTMLTextAreaElement>(
      ".new-thread-draft-surface #thread-composer",
    )?.value;
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>(
        ".new-thread-draft-surface #thread-composer",
      ),
    );
    await setTextareaValue(composer, "Plan the zen refactor");

    // Switching Project keeps each Project's unsent input independent, like
    // two separate drafts.
    await chooseDraftProject("documents");
    assert.equal(draftText(), "");
    const documentsComposer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>(
        ".new-thread-draft-surface #thread-composer",
      ),
    );
    await setTextareaValue(documentsComposer, "Draft the documents flow");
    await chooseDraftProject("zen");
    assert.equal(draftText(), "Plan the zen refactor");
    await chooseDraftProject("documents");
    assert.equal(draftText(), "Draft the documents flow");
    await chooseDraftProject("zen");
    assert.equal(draftText(), "Plan the zen refactor");

    // Opening a Thread keeps the draft; returning restores it.
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-thread-id="existing-thread"] .thread-row',
        )
        ?.click(),
    );
    await waitFor(
      () => document.querySelector(".new-thread-draft-surface") === null,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    await waitFor(() =>
      document.querySelector(".new-thread-draft-surface #thread-composer"),
    );
    assert.equal(draftText(), "Plan the zen refactor");

    // The first Send creates the Thread and consumes the retained input.
    const send = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    await invokeButtonClick(send, 2);
    await waitFor(() => startedWorkspaces.length === 1);
    assert.deepEqual(startedWorkspaces, ["/work/zen"]);
    await act(async () => {
      selectedStart.resolve(started(liveThread(), "/work/zen"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(
      () => document.querySelector(".new-thread-draft-surface") === null,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    await waitFor(
      () =>
        document.querySelector<HTMLTextAreaElement>(
          ".new-thread-draft-surface #thread-composer",
        ) !== null,
    );
    assert.equal(draftText(), "");
    // Project B's untouched input is still retained after Project A sent.
    await chooseDraftProject("documents");
    assert.equal(draftText(), "Draft the documents flow");
  } finally {
    await unmountApp(harness);
  }
});

test("No project creates its independent directory only on a valid first Send and starts the ordinary Turn", async () => {
  const allocations: Array<{ name?: string; selection?: unknown }> = [];
  const projectMutations: string[] = [];
  const sent: unknown[] = [];
  const result = started(
    liveThread(),
    "/synthetic/Documents/ZenX/2026-10-27/new-chat",
  );
  const harness = await mountApp(
    { projects: [], unavailableThreadIds: [], lastUsedWorkspace: null },
    {
      addWorkspace: async (cwd) => {
        projectMutations.push(cwd);
      },
      markWorkspaceUsed: async (cwd) => {
        projectMutations.push(cwd);
        return publicSettings([]);
      },
      startProjectlessThread: async (name, selection) => {
        allocations.push({ name, selection });
        return result;
      },
      request: async (method, params) => {
        if (method === "zen/turn/send") {
          sent.push(params);
          return { turn: { id: "new-turn", status: "inProgress", items: [] } };
        }
        return undefined;
      },
    },
  );
  try {
    await waitFor(() => document.getElementById("thread-composer"));
    assert.match(projectSwitcher()?.textContent ?? "", /No project/u);
    assert.equal(allocations.length, 0);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    assert.equal(allocations.length, 0);
    const input =
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "写一个中文报告");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const send = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
    );
    await act(async () => send.click());
    await waitFor(() => sent.length === 1);
    assert.equal(allocations.length, 1);
    assert.equal(allocations[0]!.name, "写一个中文报告");
    assert.deepEqual(projectMutations, []);
    assert.equal(document.querySelector(".new-thread-draft-surface"), null);
  } finally {
    await unmountApp(harness);
  }
});

async function mountApp(
  projects: ZenXProjectProjectionSnapshot,
  options: {
    addWorkspace?(workspace: string): Promise<void>;
    getStatus?(): Promise<AppServerHostStatus>;
    initialPinnedThreadIds?: string[];
    composerSendMode?: "batch" | "queue" | "soft" | "hard";
    initialProfile?: Partial<
      import("../src/main/host-profile.js").ZenXHostProfile
    >;
    onSettingsSave?(
      settings: import("../src/main/host-profile.js").ZenXSettingsUpdate,
    ): void;
    onSettingsChanged?(
      listener: (value: ReturnType<typeof publicSettings>) => void,
    ): () => void;
    onNotification?: Window["zenx"]["protocol"]["onNotification"];
    onStatus?(listener: (status: AppServerHostStatus) => void): () => void;
    onPinnedThreadIds?(threadIds: readonly string[]): void;
    models?: ModelSummary[];
    modelUsage?(): Promise<ModelUsageProjection>;
    markWorkspaceUsed?(
      workspace: string,
    ): Promise<ReturnType<typeof publicSettings>>;
    projectsGet?(): Promise<ZenXProjectProjectionSnapshot>;
    startProjectlessThread?(
      directoryName?: string,
      selection?: { model?: string; effort?: string },
    ): Promise<unknown>;
    startProjectThread?(
      workspace: string,
      selection?: { model?: string; effort?: string },
    ): Promise<unknown>;
    setPinnedThreadIds?(
      threadIds: readonly string[],
    ): Promise<ReturnType<typeof publicSettings>>;
    setSubagentThreadSidebarVisible?(
      threadId: string,
      visible: boolean,
    ): Promise<ReturnType<typeof publicSettings>>;
    request?(method: string, params?: unknown): Promise<unknown>;
    recoverCreatedThread?(
      thread: Thread,
    ): Promise<ReturnType<typeof nativeRecoveryForThread>>;
    observeActivation?(params: unknown): Promise<{ observed: boolean }>;
    observeTitle?(): Promise<undefined>;
    pickImages?(): Promise<ZenXImageDraft[]>;
    threads?(archived: boolean): Promise<NativeThreadSummary[]>;
    plugins?: Partial<Window["zenx"]["plugins"]>;
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
  Object.defineProperties(dom.window.HTMLInputElement.prototype, {
    attachEvent: { value: () => undefined },
    detachEvent: { value: () => undefined },
  });
  let currentSettings = publicSettings(options.initialPinnedThreadIds ?? []);
  currentSettings.profile.composerSendMode =
    options.composerSendMode ?? "queue";
  Object.assign(currentSettings.profile, options.initialProfile);
  const createdThreads = new Map<string, Thread>();
  const zenx = {
    panels: { onOpen: () => () => undefined },
    platform: "darwin",
    protocol: {
      getStatus: async () =>
        options.getStatus === undefined
          ? { type: "ready", reconnected: false }
          : await options.getStatus(),
      getPendingApprovals: async () => [],
      request: async (method: string, params?: unknown) => {
        if (method === "zen/initialize") return { processEpoch: "test-host" };
        // Passive evidence is not an input-admission call. Scenarios can fail or
        // hold its reply independently without changing the native send mock.
        if (method === "zen/trace/client-activation")
          return options.observeActivation?.(params) ?? { observed: true };
        if (method === "model/list")
          return {
            data: options.models ?? [wireModel("fake", true)],
            nextCursor: null,
          };
        if (method === "zen/thread/resume") {
          const created = createdThreads.get(
            (params as { threadId: string }).threadId,
          );
          if (created)
            return (
              options.recoverCreatedThread?.(created) ??
              nativeRecoveryForThread(created)
            );
        }
        if (options.request !== undefined) {
          const result = await options.request(method, params);
          // Keep older scenario setup concise while exposing the native resume
          // contract at the preload boundary.
          if (
            method === "zen/thread/resume" &&
            typeof result === "object" &&
            result !== null &&
            "thread" in result &&
            !("processEpoch" in result)
          ) {
            const thread = result.thread as Thread;
            const overrides = result as {
              model?: string;
              modelProvider?: string;
              reasoningEffort?: string | null;
            };
            return nativeRecoveryForThread(thread, {
              ...(overrides.model === undefined
                ? {}
                : { model: overrides.model }),
              ...(overrides.modelProvider === undefined
                ? {}
                : { modelProvider: overrides.modelProvider }),
              ...(overrides.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: overrides.reasoningEffort }),
            });
          }
          return result;
        }
        throw new Error(`Unexpected protocol request: ${method}`);
      },
      respondToApproval: async () => undefined,
      onApprovalRequest: () => () => undefined,
      onApprovalResolved: () => () => undefined,
      onStatus: (listener: (status: AppServerHostStatus) => void) =>
        options.onStatus?.(listener) ?? (() => undefined),
      onNotification: (
        listener: Parameters<Window["zenx"]["protocol"]["onNotification"]>[0],
      ) => options.onNotification?.(listener) ?? (() => undefined),
    },
    threads: {
      list: async ({ archived }: { archived: boolean }) =>
        options.threads === undefined ? [] : await options.threads(archived),
    },
    imageAttachments: {
      pick: async () =>
        options.pickImages === undefined ? [] : await options.pickImages(),
      import: async () => [],
      read: async () => new Uint8Array(),
      forThread: async () => ({}),
    },
    modelUsage: {
      forThread: async () =>
        options.modelUsage === undefined
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
          : await options.modelUsage(),
    },
    projects: {
      startProjectlessThread: async (
        directoryName?: string,
        selection?: { model?: string; effort?: string },
      ) => {
        if (!options.startProjectlessThread)
          throw new Error("Unexpected projectless Thread start");
        const result = await options.startProjectlessThread(
          directoryName,
          selection,
        );
        if (
          typeof result === "object" &&
          result !== null &&
          "thread" in result
        ) {
          const thread = result.thread as Thread;
          createdThreads.set(thread.id, thread);
        }
        return result;
      },
      get: async () =>
        options.projectsGet === undefined
          ? projects
          : await options.projectsGet(),
      startThread: async (
        workspace: string,
        selection?: { model?: string; effort?: string },
      ) => {
        if (options.startProjectThread === undefined) {
          throw new Error(`Unexpected Project Thread start: ${workspace}`);
        }
        const result = await options.startProjectThread(workspace, selection);
        if (
          typeof result === "object" &&
          result !== null &&
          "thread" in result
        ) {
          const thread = result.thread as Thread;
          createdThreads.set(thread.id, thread);
        }
        return result;
      },
    },
    settings: {
      get: async () => currentSettings,
      onChanged: (
        listener: (value: ReturnType<typeof publicSettings>) => void,
      ) => options.onSettingsChanged?.(listener) ?? (() => undefined),
      save: async (
        update: import("../src/main/host-profile.js").ZenXSettingsUpdate,
      ) => {
        options.onSettingsSave?.(update);
        Object.assign(currentSettings.profile, update);
        return currentSettings;
      },
      setPinnedThreadIds: async (threadIds: readonly string[]) => {
        if (options.setPinnedThreadIds !== undefined)
          return await options.setPinnedThreadIds(threadIds);
        options.onPinnedThreadIds?.(threadIds);
        currentSettings = {
          ...currentSettings,
          profile: {
            ...currentSettings.profile,
            pinnedThreadIds: [...threadIds],
          },
        };
        return currentSettings;
      },
      setSubagentThreadSidebarVisible: async (
        threadId: string,
        visible: boolean,
      ) => {
        if (options.setSubagentThreadSidebarVisible !== undefined)
          return await options.setSubagentThreadSidebarVisible(
            threadId,
            visible,
          );
        const current = currentSettings.profile.visibleSubagentThreadIds;
        currentSettings = {
          ...currentSettings,
          profile: {
            ...currentSettings.profile,
            visibleSubagentThreadIds: visible
              ? [...new Set([...current, threadId])]
              : current.filter((id) => id !== threadId),
          },
        };
        return currentSettings;
      },
      markWorkspaceUsed: async (workspace: string) =>
        options.markWorkspaceUsed === undefined
          ? currentSettings
          : await options.markWorkspaceUsed(workspace),
      onManualCodeRequested: () => () => undefined,
      addWorkspace: async (workspace: string) => {
        await options.addWorkspace?.(workspace);
        return { profile: { onboardingComplete: true } };
      },
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
      ...options.plugins,
    },
    marketplace: { get: async () => ({ entries: [], builtIns: [] }) },
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
      version: 3 as const,
      composerSendMode: "queue" as "batch" | "queue" | "soft" | "hard",
      onboardingComplete: true,
      providerProfiles: [
        {
          providerProfileId: "fake",
          type: "fake" as const,
          displayName: "Local demo",
          models: [catalogModel("fake"), catalogModel("gpt-5.6-luna")],
        },
      ],
      defaultModel: { providerProfileId: "fake", modelId: "fake" },
      titleModel: {
        providerProfileId: "fake",
        modelId: "gpt-5.6-luna",
      },
      workspace: "/work/zen",
      workspaces: ["/work/zen"],
      lastUsedWorkspace: "/work/zen",
      approvalPolicy: "never" as const,
      pinnedThreadIds,
      visibleSubagentThreadIds: [] as string[],
      sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
    },
    hasApiKey: false,
    apiKeyProviderProfileIds: [],
    subscriptionProviderProfileId: null,
    subscription: { authenticated: false, expired: false },
  };
}

function catalogModel(id: string) {
  return {
    id,
    displayName: id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text" as const],
    contextWindow: null,
    source: "legacy" as const,
  };
}

function wireModel(id: string, isDefault = false, displayName = id) {
  const wireId = id.startsWith("zen-model-v1:")
    ? id
    : encodeModelKey({ providerProfileId: "fake", modelId: id });
  return {
    id: wireId,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName,
    description: displayName,
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
    isDefault,
  };
}

function summary(
  archived: boolean,
  threadId = "thread-1",
  name = "Thread one",
  cwd = "/work/zen",
): NativeThreadSummary {
  return {
    threadId,
    currentMetadata: {
      model: "fake",
      provider: "fake",
      cwd,
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

function runningThread(): Thread {
  return {
    ...liveThread(),
    status: { type: "active", activeFlags: [] },
    turns: [
      {
        id: "turn-1",
        items: [],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: 10,
        completedAt: null,
        durationMs: null,
      },
    ],
  };
}

function resumed(thread: Thread) {
  return nativeRecoveryForThread(thread);
}

function started(thread: Thread, cwd: string) {
  return {
    thread: { ...thread, cwd },
    model: encodeModelKey({ providerProfileId: "fake", modelId: "fake" }),
    modelProvider: "fake",
    approvalPolicy: "never" as const,
    approvalsReviewer: "user" as const,
    cwd,
    instructionSources: [],
    reasoningEffort: "medium",
    sandbox: { type: "dangerFullAccess" as const },
    serviceTier: null,
  };
}

async function mountThreadApp(
  options: Parameters<typeof mountApp>[1],
): Promise<AppHarness> {
  return await mountApp(
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
      threads: async (archived) => (archived ? [] : [summary(false)]),
      ...options,
    },
  );
}

async function selectedComposer(): Promise<HTMLTextAreaElement> {
  const row = await waitFor(() =>
    document.querySelector<HTMLButtonElement>(".thread-row"),
  );
  await act(async () => row.click());
  return await waitFor(() =>
    document.querySelector<HTMLTextAreaElement>("#thread-composer"),
  );
}

async function dispatchComposerKey(
  composer: HTMLTextAreaElement,
  init: KeyboardEventInit,
): Promise<void> {
  const onKeyDown = reactProps<{
    onKeyDown?(event: {
      key: string;
      metaKey: boolean;
      nativeEvent: { isComposing: boolean };
      preventDefault(): void;
      repeat: boolean;
      shiftKey: boolean;
    }): void;
  }>(composer).onKeyDown;
  assert.ok(onKeyDown);
  await act(async () => {
    onKeyDown({
      key: init.key ?? "",
      metaKey: init.metaKey ?? false,
      nativeEvent: { isComposing: init.isComposing ?? false },
      preventDefault: () => undefined,
      repeat: init.repeat ?? false,
      shiftKey: init.shiftKey ?? false,
    });
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function invokeButtonClick(
  button: HTMLButtonElement,
  times = 1,
): Promise<void> {
  const onClick = reactProps<{ onClick?(): void }>(button).onClick;
  assert.ok(onClick);
  await act(async () => {
    for (let index = 0; index < times; index += 1) onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function invokePrimarySubmit(
  button: HTMLButtonElement,
  times = 1,
  beforeSettle?: () => Promise<void>,
): Promise<void> {
  const onClick = reactProps<{ onClick?(): void }>(button).onClick;
  const form = button.closest<HTMLFormElement>("form");
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      if (onClick !== undefined) onClick();
      else {
        assert.ok(form);
        invokeFormSubmitNow(form);
      }
    }
    await Promise.resolve();
    await beforeSettle?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function invokeFormSubmit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    invokeFormSubmitNow(form);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function invokeFormSubmitNow(form: HTMLFormElement): void {
  const onSubmit = reactProps<{
    onSubmit?(event: { preventDefault(): void }): void;
  }>(form).onSubmit;
  assert.ok(onSubmit);
  onSubmit({ preventDefault: () => undefined });
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
  const props = reactProps<{
    onChange?(event: { target: { value: string } }): void;
  }>(textarea);
  const onChange = props?.onChange;
  assert.ok(onChange);
  await act(async () => {
    onChange({ target: { value } });
    await Promise.resolve();
  });
}

async function setInputValue(input: HTMLInputElement, value: string) {
  const props = reactProps<{
    onChange?(event: { target: { value: string } }): void;
  }>(input);
  const onChange = props?.onChange;
  assert.ok(onChange);
  await act(async () => {
    onChange({ target: { value } });
    await Promise.resolve();
  });
}

function reactProps<T>(element: Element): T {
  const reactPropsKey = Object.getOwnPropertyNames(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  assert.ok(reactPropsKey);
  return (element as unknown as Record<string, T>)[reactPropsKey] as T;
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

test("Settings and thread navigation are mutually exclusive, including return to the same thread", async () => {
  const harness = await mountApp(
    {
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: true,
          threadIds: ["thread-1", "thread-2"],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    },
    {
      threads: async () => [
        summary(false, "thread-1", "Thread one"),
        summary(false, "thread-2", "Thread two"),
      ],
      request: async (method, params) => {
        if (method === "zen/thread/resume")
          return resumed({
            ...liveThread(),
            id: (params as { threadId: string }).threadId,
          });
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    },
  );
  try {
    await selectedComposer();
    for (const id of ["thread-1", "thread-2", "thread-1"]) {
      await act(async () =>
        document.querySelector<HTMLButtonElement>(".settings-nav-row")!.click(),
      );
      await waitFor(
        () =>
          document
            .querySelector('[aria-label="ZenX settings"]')
            ?.closest("[hidden]") === null,
      );
      const settingsSurface = document.querySelector(
        '[aria-label="ZenX settings"]',
      );
      assert.ok(settingsSurface);
      assert.equal(
        document.querySelectorAll('.thread-row[aria-current="page"]').length,
        0,
      );
      assert.equal(
        document
          .querySelector(".settings-nav-row")
          ?.getAttribute("aria-current"),
        "page",
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            `[data-thread-id="${id}"] .thread-row`,
          )!
          .click(),
      );
      await waitFor(() => document.querySelector("#thread-composer"));
      assert.equal(
        document.querySelector('[aria-label="ZenX settings"]') ===
          settingsSurface,
        true,
      );
      assert.equal(
        document
          .querySelector('[aria-label="ZenX settings"]')
          ?.closest("[hidden]") !== null,
        true,
      );
      assert.equal(
        document.querySelectorAll('.thread-row[aria-current="page"]').length,
        1,
      );
      assert.equal(
        document
          .querySelector('.thread-row[aria-current="page"]')
          ?.closest("[data-thread-id]")
          ?.getAttribute("data-thread-id"),
        id,
      );
      assert.equal(
        document
          .querySelector(".settings-nav-row")
          ?.getAttribute("aria-current"),
        null,
      );
    }
  } finally {
    await unmountApp(harness);
  }
});

test("/compact preserves later edits and refreshes the canonical compaction item", async () => {
  const methods: string[] = [];
  const response = deferred<{ compactionItemId: string }>();
  let compacted = false;
  const harness = await mountThreadApp({
    request: async (method, params) => {
      methods.push(method);
      if (method === "zen/thread/resume") {
        const recovery = resumed(liveThread());
        return compacted
          ? {
              ...recovery,
              thread: {
                ...recovery.thread,
                items: [
                  ...recovery.thread.items,
                  {
                    id: "compact-1",
                    type: "context_compaction" as const,
                    threadId: "thread-1",
                    createdAt: "2026-09-20T10:00:00Z",
                    provenance: "provider_generated" as const,
                    initiator: "human" as const,
                    coveredThroughItemId: "thread-1-metadata",
                    summary: "Continue from the compacted context.",
                    retainedItemIds: [],
                    providerProfileId: "fake",
                    modelId: "fake",
                    reasoningEffort: "medium",
                    algorithmVersion: "zen.context-compaction.v2",
                    tokenUsage: { inputTokens: 12, outputTokens: 5 },
                  },
                ],
              },
            }
          : recovery;
      }
      if (method === "thread/compact") {
        assert.deepEqual(params, { threadId: "thread-1" });
        const result = await response.promise;
        compacted = true;
        return result;
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  try {
    const textarea = await selectedComposer();
    await setTextareaValue(textarea, "/compact");
    await invokePrimarySubmit(exactButtonByAria("Compact context"), 2);
    assert.equal(methods.filter((m) => m === "thread/compact").length, 1);
    assert.match(document.body.textContent!, /Compacting context/);
    await setTextareaValue(textarea, "Keep this later draft");
    await act(async () => {
      response.resolve({ compactionItemId: "compact-1" });
      await response.promise;
    });
    await waitFor(() =>
      document.body.textContent?.includes("Context compacted"),
    );
    assert.match(document.body.textContent ?? "", /Human initiated/u);
    assert.equal(textarea.value, "Keep this later draft");
    assert.equal(
      methods.some((m) => /^turn\//u.test(m)),
      false,
    );
    assert.equal(document.querySelector(".settings-toast"), null);
  } finally {
    await unmountApp(harness);
  }
});

test("context ring opens details and only its popover action compacts", async () => {
  const methods: string[] = [];
  const harness = await mountThreadApp({
    modelUsage: async () => ({
      thread: { responseCount: 1, inputTokens: 40, outputTokens: 5 },
      turns: {},
      context: {
        inputTokens: 50,
        inputTokenSource: "provider",
        contextWindow: 100,
        ratio: 0.5,
      },
    }),
    request: async (method) => {
      methods.push(method);
      if (method === "zen/thread/resume") return resumed(liveThread());
      if (method === "thread/compact") return { compactionItemId: "compact-1" };
      throw new Error(`Unexpected ${method}`);
    },
  });
  try {
    await selectedComposer();
    const ring = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".context-usage-trigger"),
    );
    await act(async () => ring.click());
    assert.equal(
      methods.filter((method) => method === "thread/compact").length,
      0,
    );
    assert.ok(document.querySelector('[role="dialog"]'));
    const compact = document.querySelector<HTMLButtonElement>(
      ".context-usage-compact",
    );
    assert.ok(compact);
    await act(async () => compact.click());
    await waitFor(
      () =>
        methods.filter((method) => method === "thread/compact").length === 1,
    );
    assert.equal(
      methods.some((method) => /^turn\//u.test(method)),
      false,
    );
  } finally {
    await unmountApp(harness);
  }
});

for (const mode of ["queue", "soft", "hard"] as const) {
  test(`/compact during a running reply does not ${mode} or interrupt`, async () => {
    const methods: string[] = [];
    const harness = await mountThreadApp({
      composerSendMode: mode,
      request: async (method) => {
        methods.push(method);
        if (method === "zen/thread/resume") return resumed(runningThread());
        throw new Error(`Unexpected ${method}`);
      },
    });
    try {
      const textarea = await selectedComposer();
      await setTextareaValue(textarea, "/compact");
      await invokePrimarySubmit(exactButtonByAria("Compact context"));
      assert.match(document.body.textContent!, /Wait for the current reply/);
      assert.equal(textarea.value, "/compact");
      assert.equal(methods.includes("thread/compact"), false);
      assert.equal(
        methods.some((m) => /^turn\//u.test(m)),
        false,
      );
    } finally {
      await unmountApp(harness);
    }
  });
}

test("/compact in a new draft reports no conversation without creating an empty thread", async () => {
  const methods: string[] = [];
  const harness = await mountApp(oneProject(), {
    request: async (method) => {
      methods.push(method);
      throw new Error(`Unexpected ${method}`);
    },
  });
  try {
    const textarea = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(textarea, "/compact");
    await invokePrimarySubmit(exactButtonByAria("Compact context"));
    assert.match(document.body.textContent!, /no conversation to compact/);
    assert.equal(textarea.value, "/compact");
    assert.equal(methods.includes("thread/start"), false);
  } finally {
    await unmountApp(harness);
  }
});

function exactButtonByAria(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  assert(button);
  return button;
}

test("Ctrl+1 releases hidden plugin control portals while retaining the isolated bridge", async () => {
  const snapshot = {
    plugins: [],
    bundles: [
      {
        key: "sample:ui",
        pluginId: "sample",
        id: "ui",
        apiVersion: 1,
        kind: "isolated",
        entry: "<input value='draft'>",
      },
    ],
    surfaces: [
      {
        key: "sample:settings",
        pluginId: "sample",
        id: "settings",
        bundleId: "ui",
        exportName: "settings",
      },
    ],
    settings: [
      {
        key: "sample:settings",
        pluginId: "sample",
        id: "settings",
        title: "Sample settings",
        surfaceId: "settings",
      },
    ],
    sidebar: [],
    pages: [],
    subroutes: [],
    panels: [],
    commands: [],
    menus: [],
  };
  let reads = 0;
  const harness = await mountThreadApp({
    threads: async () => [summary(false)],
    request: async () => resumed(liveThread()),
    plugins: {
      get: async () => snapshot as any,
      readHandle: async () => ++reads,
    },
  });
  try {
    await selectedComposer();
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")!.click(),
    );
    const pluginTab = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (button) => button.textContent === "Plugins",
      ),
    );
    await act(async () => pluginTab.click());
    const frame = await waitFor(() => document.querySelector("iframe"));
    const messages: any[] = [];
    frame.contentWindow!.postMessage = (message) => {
      messages.push(message);
    };
    await act(async () =>
      frame.dispatchEvent(new harness.dom.window.Event("load")),
    );
    const channel = JSON.parse(
      messages
        .find((message) => message.type === "zenx-plugin-ui:document")
        .html.match(/const init=(.*?);const deepFreeze/s)[1],
    ).channel;
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Install from source…")!
        .click(),
    );
    const source = document.querySelector<HTMLButtonElement>(
      '[aria-label="Plugin source"]',
    )!;
    await act(async () =>
      source.dispatchEvent(
        new harness.dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.equal(document.body.style.pointerEvents, "none");
    Object.assign(window.zenx, { platform: "win32" });
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new harness.dom.window.KeyboardEvent("keydown", {
          key: "1",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await waitFor(() => document.querySelector("#thread-composer"));
    assert.equal(
      document.querySelector<HTMLElement>(".settings-view")?.hidden,
      true,
    );
    assert.notEqual(document.body.style.pointerEvents, "none");
    assert.equal(
      document
        .querySelector('[role="listbox"]')
        ?.contains(document.activeElement) ?? false,
      false,
    );
    const composer =
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!;
    composer.focus();
    assert.equal(document.activeElement === composer, true);
    await act(async () =>
      window.dispatchEvent(
        new harness.dom.window.MessageEvent("message", {
          source: frame.contentWindow,
          data: {
            channel,
            type: "zenx-plugin-ui:request",
            requestId: "hidden",
            operation: "handles.read",
            id: "sample:context",
          },
        }),
      ),
    );
    assert.equal(reads, 1);
    assert.equal(
      messages.some(
        (message) =>
          message.requestId === "hidden" &&
          message.type === "zenx-plugin-ui:result",
      ),
      true,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")!.click(),
    );
    assert.equal(document.querySelector("iframe") === frame, true);
  } finally {
    await unmountApp(harness);
  }
});

test("reference selector sends exact locators through App with and without native Skills", async () => {
  for (const includeSkill of [false, true]) {
    const sends: { method: string; params: any }[] = [];
    const titles: string[] = [];
    const harness = await mountThreadApp({
      request: async (method, params) => {
        if (method === "zen/thread/resume") return resumed(liveThread());
        if (method === "zen/turn/send") {
          sends.push({ method, params });
          return {};
        }
        throw new Error(`Unexpected ${method}`);
      },
    });
    try {
      window.zenx.workspaceFiles = {
        ...window.zenx.workspaceFiles,
        search: async () => ({
          cwd: "C:/space root",
          entries: [{ name: '文 [x]".ts', path: 'src/文 [x]".ts' }],
          truncated: false,
          scanned: 1,
        }),
        validateReference: async (_id, path) => ({
          cwd: "C:/space root",
          name: '文 [x]".ts',
          path,
        }),
      };
      window.zenx.titles.observe = async (_id, text) => {
        titles.push(text);
        return undefined as any;
      };
      const textarea = await selectedComposer();
      const prefix = includeSkill
        ? "[skill:11111111-1111-1111-1111-111111111111:sample]\n"
        : "";
      await setTextareaValue(textarea, prefix + "Read @src/");
      const option = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(".selector-option"),
      );
      await act(async () => option.click());
      await waitFor(() =>
        document.querySelector(".inline-composer-editor .reference-token"),
      );
      assert.ok(document.querySelector(".composer .reference-token"));
      assert.equal(sends.length, 0);
      assert.doesNotMatch(
        textarea.value,
        /zenx-references|relative path|space root/,
      );
      const inlineInput = document.querySelector<HTMLElement>(".cm-content")!;
      await act(async () =>
        inlineInput.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await waitFor(() => sends.length === 1);
      const send = sends[0]!;
      assert.equal(send.method, "zen/turn/send");
      const text = send.params.input.find(
        (part: any) => part.type === "text",
      ).text;
      assert.match(text, /^\[zenx-reference-message:v3;/u);
      assert.deepEqual(
        parseSentReferenceContent(text, send.params.clientUserMessageId)
          .references,
        [
          {
            kind: "file",
            name: '文 [x]".ts',
            path: 'src/文 [x]".ts',
            cwd: "C:/space root",
            position: 5,
          },
        ],
      );
      assert.ok(text.includes(JSON.stringify('src/文 [x]".ts')));
      assert.ok(text.includes("C:/space root"));
      assert.doesNotMatch(text, /zenx-references/);
      assert.equal(send.params.model, undefined);
      assert.equal(send.params.approvalPolicy, undefined);
      assert.equal(send.params.reasoningEffort, undefined);
      if (includeSkill)
        assert.ok(
          send.params.input.some(
            (part: any) =>
              part.type === "skill" &&
              part.id === "11111111-1111-1111-1111-111111111111",
          ),
        );
      assert.ok(titles.some((title) => title.includes('文 [x]".ts')));
      assert.ok(
        titles.every(
          (title) =>
            !title.includes("zenx-references") &&
            !title.includes("C:/space root"),
        ),
      );
    } finally {
      await unmountApp(harness);
    }
  }
});

test("composer default save cannot roll back a newer settings notification", async () => {
  let notify: ((value: ReturnType<typeof publicSettings>) => void) | undefined;
  const harness = await mountApp(oneProject(), {
    initialProfile: { revision: 1, composerSendMode: "soft" },
    onSettingsChanged: (listener) => {
      notify = listener;
      return () => undefined;
    },
  });
  try {
    await waitFor(() => document.querySelector(".composer-send-control"));
    const reply = deferred<ReturnType<typeof publicSettings>>();
    const writes: import("../src/main/host-profile.js").ZenXSettingsUpdate[] =
      [];
    window.zenx.settings.save = async (update) => {
      writes.push(update);
      return reply.promise;
    };
    await act(async () =>
      document
        .querySelector<HTMLElement>(".composer-send-control")!
        .dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true })),
    );
    const select = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Default send mode"]',
      ),
    );
    await act(async () => select.click());
    const queueOption = await waitFor(() =>
      document.querySelector<HTMLElement>(
        '[role="option"][data-value="queue"]',
      ),
    );
    await act(async () => queueOption.click());
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.baseRevision, 1);
    assert.equal(writes[0]?.composerSendModeExplicit, true);
    const latest = publicSettings([]);
    Object.assign(latest.profile, { revision: 3, composerSendMode: "hard" });
    await act(async () => notify?.(latest));
    assert.equal(select.getAttribute("data-value"), "hard");
    const old = publicSettings([]);
    Object.assign(old.profile, { revision: 2, composerSendMode: "queue" });
    await act(async () => reply.resolve(old));
    assert.equal(select.getAttribute("data-value"), "hard");
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("textarea")?.value,
      "",
    );
  } finally {
    await unmountApp(harness);
  }
});

for (const text of ["Original Project draft", ""]) {
  test(`late image pick returns to owning Project draft with ${text ? "text" : "only a pending image"}`, async () => {
    const pick = deferred<ZenXImageDraft[]>();
    const harness = await mountApp(twoProjectSnapshot(), {
      pickImages: async () => pick.promise,
    });
    try {
      const composer = await waitFor(() =>
        document.querySelector<HTMLTextAreaElement>("#thread-composer"),
      );
      if (text) await setTextareaValue(composer, text);
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[aria-label="Add images"]')
          ?.click(),
      );
      await chooseDraftProject("documents");
      await act(async () =>
        pick.resolve([
          {
            id: "late-image",
            name: "late.png",
            attachment: {
              type: "attachment",
              sha256: "a".repeat(64),
              mediaType: "image/png",
              byteLength: 4,
              width: 1,
              height: 1,
            },
          },
        ]),
      );
      assert.equal(
        document.querySelector('[aria-label="Remove late.png"]'),
        null,
      );
      await chooseDraftProject("zen");
      assert.equal(
        document.querySelector<HTMLTextAreaElement>("#thread-composer")?.value,
        text,
      );
      assert.ok(
        document.querySelector('[aria-label="Remove late.png"]'),
        "late image must be retained by the original draft",
      );
    } finally {
      await unmountApp(harness);
    }
  });
}

for (const entry of ["heading", "chip"] as const) {
  for (const retainedText of ["Zen draft must survive", ""]) {
    test(`Add project from ${entry} restores an existing Project with ${retainedText ? "a retained draft" : "no draft"}`, async () => {
      const projects = twoProjectSnapshot();
      const harness = await mountApp(projects);
      try {
        const text = () =>
          document.querySelector<HTMLTextAreaElement>("#thread-composer")!;
        await waitFor(text);
        if (retainedText) await setTextareaValue(text(), retainedText);
        await chooseDraftProject("documents");
        await setTextareaValue(text(), "Documents draft must survive");
        // The directory picker can choose a folder that is already configured.
        window.zenx.settings.getDirectoryBrowser = async () => ({
          locations: [{ label: "Zen", path: "/work/zen" }],
          initialPath: "/work/zen",
        });
        window.zenx.settings.listDirectory = async () => ({
          path: "/work/zen",
          parent: "/work",
          breadcrumbs: [{ label: "zen", path: "/work/zen" }],
          directories: [],
        });
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              entry === "chip"
                ? ".new-thread-project-trigger-chip"
                : ".new-thread-project-trigger:not(.new-thread-project-trigger-chip)",
            )!
            .click(),
        );
        await act(async () => exactButton("Add project")!.click());
        const addFolder = await waitFor(() => exactButton("Add folder"));
        await waitFor(() => !addFolder.disabled);
        await act(async () => addFolder.click());
        await waitFor(() => projectSwitcher()?.textContent?.trim() === "zen");
        assert.equal(text().value, retainedText);
        await chooseDraftProject("documents");
        assert.equal(text().value, "Documents draft must survive");
        await chooseDraftProject("zen");
        assert.equal(text().value, retainedText);
      } finally {
        await unmountApp(harness);
      }
    });
  }
}
test("import saved but native open failed retains App-level retry without reimport", async () => {
  let importCalls = 0;
  let resumeCalls = 0;
  const { parseSessionImport, previewSessionImport } =
    await import("../../../src/protocol/session-import.js");
  const contents = [
    {
      type: "session_meta",
      payload: { id: "app-import", cli_version: "0.146.0", cwd: "/source" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "app integration fixture" }],
      },
    },
  ]
    .map((entry) =>
      JSON.stringify({ timestamp: "2026-10-12T00:00:00Z", ...entry }),
    )
    .join("\n");
  const harness = await mountApp(oneProject(), {
    request: async (method) => {
      if (method === "zen/thread/import/preview")
        return previewSessionImport(
          parseSessionImport({ format: "codex-rollout-0.146.0", contents }),
        );
      if (method === "zen/thread/import") {
        importCalls++;
        return { thread: { id: "thread-1" }, status: "imported" };
      }
      if (method === "zen/thread/resume") {
        resumeCalls++;
        if (resumeCalls === 1) throw new Error("Synthetic import open failure");
        return resumed(liveThread());
      }
      return {};
    },
  });
  try {
    assert.equal(
      document.querySelector(
        '.sidebar [aria-label="Import Codex conversation"]',
      ),
      null,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.click(),
    );
    const general = await waitFor(() =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(".settings-nav button"),
      ].find((button) => button.textContent?.trim() === "General"),
    );
    await act(async () => general.click());
    const open = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '.settings-view [aria-label="Import Codex conversation"]',
      ),
    );
    await act(async () => open.click());
    const cancel = await waitFor(() =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".session-import-dialog button",
        ),
      ].find((button) => button.textContent === "Cancel"),
    );
    await act(async () => cancel.click());
    await waitFor(() => !document.querySelector(".session-import-dialog"));
    assert.equal(importCalls, 0);
    assert(
      document.querySelector(
        '.settings-view [aria-label="Import Codex conversation"]',
      ),
    );
    await act(async () => open.click());
    const input = await waitFor(() =>
      document.querySelector<HTMLInputElement>(
        '.session-import-dialog input[type="file"]',
      ),
    );
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [
        {
          name: "selected.jsonl",
          size: Buffer.byteLength(contents),
          arrayBuffer: async () => new TextEncoder().encode(contents).buffer,
        },
      ],
    });
    await act(async () =>
      input.dispatchEvent(
        new harness.dom.window.Event("change", { bubbles: true }),
      ),
    );
    const confirm = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) =>
          button.textContent === "Import and open" && !button.disabled,
      ),
    );
    await act(async () => confirm.click());
    const retry = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) =>
          button.textContent === "Open imported conversation" &&
          !button.disabled,
      ),
    );
    assert(document.querySelector(".session-import-dialog"));
    assert(
      document
        .querySelector(".session-import-dialog [role=alert]")
        ?.textContent?.includes("Synthetic import open failure"),
    );
    assert.equal(importCalls, 1);
    assert.equal(resumeCalls, 1);
    await act(async () => retry.click());
    await waitFor(() => !document.querySelector(".session-import-dialog"));
    assert.equal(importCalls, 1);
    assert.equal(resumeCalls, 2);
  } finally {
    await unmountApp(harness);
  }
});

function sourceNavigationThread(deviceId?: string): Thread {
  return {
    ...liveThread(),
    turns: [
      {
        id: "source-navigation-turn",
        status: "completed",
        itemsView: "full",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
        items: [
          {
            type: "threadMessage",
            id: "incoming-source",
            clientId: "incoming-source-client",
            sender: {
              threadId: "exact/source",
              threadName: "Renamed sender",
              toolCallId: "send-call",
              callId: "send",
              ...(deviceId === undefined ? {} : { deviceId }),
            },
            content: [
              {
                type: "text",
                text: "Do not follow /threads/forged in this body.",
                text_elements: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("message source reads and opens its exact canonical thread without sending, forking or following body URLs", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const harness = await mountThreadApp({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "zen/thread/read")
        return { thread: { id: "exact/source", archived: false } };
      if (method === "zen/thread/resume")
        return resumed(
          (params as { threadId: string }).threadId === "thread-1"
            ? sourceNavigationThread()
            : { ...liveThread(), id: "exact/source", name: "Exact source" },
        );
      throw new Error(method);
    },
  });
  try {
    await selectedComposer();
    const link = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".message-source-link"),
    );
    assert.match(link.textContent!, /Renamed sender/);
    assert.doesNotMatch(link.title, /send-call|exact\/source/);
    await act(async () => link.click());
    await waitFor(() =>
      calls.find(
        (call) =>
          call.method === "zen/thread/resume" &&
          (call.params as { threadId: string }).threadId === "exact/source",
      ),
    );
    assert.deepEqual(
      calls
        .filter((call) => call.method === "zen/thread/read")
        .map((call) => call.params),
      [{ threadId: "exact/source" }],
    );
    assert.ok(
      calls.every((call) =>
        ["zen/thread/read", "zen/thread/resume"].includes(call.method),
      ),
    );
  } finally {
    await unmountApp(harness);
  }
});

for (const failure of [
  "archived",
  "deleted",
  "mismatched",
  "denied",
  "remote",
] as const) {
  test(`message source ${failure} gives visible feedback and never opens a fallback thread`, async () => {
    const resumes: string[] = [];
    let reads = 0;
    const harness = await mountThreadApp({
      request: async (method, params) => {
        if (method === "zen/thread/read") {
          reads++;
          if (failure === "deleted" || failure === "denied")
            throw new Error(failure);
          return {
            thread: {
              id: failure === "mismatched" ? "wrong-thread" : "exact/source",
              archived: failure === "archived",
            },
          };
        }
        if (method === "zen/thread/resume") {
          resumes.push((params as { threadId: string }).threadId);
          return resumed(
            sourceNavigationThread(
              failure === "remote" ? "authenticated-peer" : undefined,
            ),
          );
        }
        throw new Error(method);
      },
    });
    try {
      await selectedComposer();
      const link = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(".message-source-link"),
      );
      await act(async () => link.click());
      await waitFor(() => document.querySelector(".message-source-status"));
      assert.deepEqual(resumes, ["thread-1"]);
      assert.equal(reads, failure === "remote" ? 0 : 1);
      assert.match(
        document.querySelector(".message-source-status")!.textContent!,
        failure === "archived"
          ? /archived/
          : failure === "remote"
            ? /verified return route/
            : /unavailable|access/,
      );
    } finally {
      await unmountApp(harness);
    }
  });
}

test("repeated source clicks share one read and a newer Settings navigation wins over its late reply", async () => {
  const pending = deferred<{ thread: { id: string; archived: boolean } }>();
  const resumes: string[] = [];
  let reads = 0;
  const harness = await mountThreadApp({
    request: async (method, params) => {
      if (method === "zen/thread/read") {
        reads++;
        return pending.promise;
      }
      if (method === "zen/thread/resume") {
        resumes.push((params as { threadId: string }).threadId);
        return resumed(sourceNavigationThread());
      }
      throw new Error(method);
    },
  });
  try {
    await selectedComposer();
    const link = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".message-source-link"),
    );
    await act(async () => {
      link.click();
      link.click();
    });
    assert.equal(reads, 1);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")!.click(),
    );
    await act(async () =>
      pending.resolve({ thread: { id: "exact/source", archived: false } }),
    );
    assert.deepEqual(resumes, ["thread-1"]);
    assert.equal(document.querySelector(".message-source-link"), null);
  } finally {
    await unmountApp(harness);
  }
});

function messageSourcePlugins() {
  return {
    plugins: ["zenx-subagents", "zenx-triggers"].map((id) => ({
      id,
      name: id,
      enabled: true,
      available: true,
      commands: [],
    })),
    sidebar: [],
    settings: [],
    commands: [],
    menus: [],
    threadHeaders: [],
    resultRenderers: [],
    subroutes: [],
    pages: [
      {
        key: "zenx-triggers:triggers",
        id: "triggers",
        pluginId: "zenx-triggers",
        route: "/plugins/zenx-triggers/triggers",
        title: "Triggers",
        surfaceId: "triggers-page",
      },
    ],
    panels: [
      {
        key: "zenx-triggers:triggers",
        id: "triggers",
        pluginId: "zenx-triggers",
        title: "Triggers",
        surfaceId: "trigger-panel",
      },
      {
        key: "zenx-subagents:subagents",
        id: "subagents",
        pluginId: "zenx-subagents",
        title: "Subagents",
        surfaceId: "subagents-panel",
      },
    ],
    surfaces: [
      {
        pluginId: "zenx-triggers",
        id: "trigger-panel",
        bundleId: "main",
        exportName: "trigger-panel",
      },
      {
        pluginId: "zenx-subagents",
        id: "subagents-panel",
        bundleId: "main",
        exportName: "subagents-panel",
      },
      {
        pluginId: "zenx-triggers",
        id: "triggers-page",
        bundleId: "main",
        exportName: "triggers-page",
      },
    ],
    bundles: [
      {
        pluginId: "zenx-subagents",
        id: "main",
        apiVersion: 1,
        kind: "trusted",
        entry: "zenx/bundled/subagents-ui",
      },
      {
        pluginId: "zenx-triggers",
        id: "main",
        apiVersion: 1,
        kind: "trusted",
        entry: "zenx/bundled/triggers-ui",
      },
    ],
  } as any;
}

test("App trigger source opens the exact scoped sidebar definition without global navigation or writes", async () => {
  const thread = sourceNavigationThread();
  thread.turns[0]!.items.push({
    type: "hostMessage",
    id: "host-source",
    clientId: "host-source-client",
    source: "trigger",
    sourceId: "exact/trigger",
    mode: "start",
    text: "A message body naming a different trigger is not a route.",
  });
  const calls: string[] = [];
  const resumes: string[] = [];
  const harness = await mountThreadApp({
    request: async (method, params) => {
      if (method === "zen/thread/resume") {
        resumes.push((params as { threadId: string }).threadId);
        return resumed(thread);
      }
      throw new Error(method);
    },
    plugins: {
      get: async () => messageSourcePlugins(),
      executeCommand: async (pluginId, command) => {
        calls.push(`${pluginId}/${command}`);
        if (command === "list")
          return {
            triggers: ["other", "exact/trigger"].map((id) => ({
              id,
              label: "Same name",
              threadId: "thread-1",
              kind: "signal",
              signal: { name: id },
              prompt: id,
              active: false,
              createdAt: 1,
            })),
            history: [],
          };
        if (command === "threads") return { threads: [] };
        if (command === "workspaces") return { workspaces: [] };
        throw new Error(command);
      },
    },
  });
  try {
    const composer = await selectedComposer();
    const link = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        ".host-message-source.message-source-link",
      ),
    );
    await act(async () => link.click());
    await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>(
        ".auxiliary-panel .trigger-editor textarea",
      ),
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(
        ".auxiliary-panel .trigger-editor textarea",
      )!.value,
      "exact/trigger",
    );
    assert.equal(
      document.querySelector("#thread-composer"),
      composer,
      "Main conversation stays mounted",
    );
    assert.deepEqual(
      resumes,
      ["thread-1"],
      "Source click does not resume or navigate any other Thread",
    );
    assert.equal(
      document.querySelector(".auxiliary-panel")?.getAttribute("data-open"),
      "true",
    );
    assert.equal(
      document.querySelector(".trigger-message-row .user-bubble")?.textContent,
      "A message body naming a different trigger is not a route.",
    );
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => /\/(list|threads|workspaces)$/.test(call)));
  } finally {
    await unmountApp(harness);
  }
});

test("side conversation message source stays in the side panel and preserves the main composer", async () => {
  const resumes: string[] = [];
  const harness = await mountThreadApp({
    request: async (method, params) => {
      const id = (params as { threadId: string }).threadId;
      if (method === "zen/thread/read")
        return { thread: { id, archived: false } };
      if (method === "zen/thread/resume") {
        resumes.push(id);
        const value =
          id === "side-thread"
            ? { ...sourceNavigationThread(), id }
            : { ...liveThread(), id };
        return resumed(value);
      }
      throw new Error(method);
    },
    plugins: {
      get: async () => messageSourcePlugins(),
      executeCommand: async (_plugin, command) => {
        if (command === "list")
          return {
            threads: [
              {
                ...summary(false, "side-thread", "Side conversation"),
                parentThreadId: "thread-1",
              },
            ],
          };
        throw new Error(command);
      },
    },
  });
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Keep main draft");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Open side panel"]')!
        .click(),
    );
    const subagents = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.querySelector("strong")?.textContent === "Subagents",
      ),
    );
    await act(async () => subagents.click());
    const side = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".subagent-tree-row"),
    );
    await act(async () => side.click());
    const link = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        ".auxiliary-conversation .message-source-link",
      ),
    );
    await act(async () => link.click());
    await waitFor(() =>
      document.querySelector("#side-composer-exact\\/source"),
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!.value,
      "Keep main draft",
    );
    assert.deepEqual(resumes, ["thread-1", "side-thread", "exact/source"]);
  } finally {
    await unmountApp(harness);
  }
});
for (const olderFirst of [true, false]) {
  test(`newer message source intent wins when older request finishes ${olderFirst ? "first" : "last"}`, async () => {
    const first = deferred<{ thread: { id: string; archived: boolean } }>();
    const second = deferred<{ thread: { id: string; archived: boolean } }>();
    const resumes: string[] = [];
    const thread = sourceNavigationThread();
    const original = thread.turns[0]!.items[0]! as any;
    thread.turns[0]!.items.push({
      ...original,
      id: "second-source-message",
      clientId: "second-source-client",
      sender: {
        ...original.sender,
        threadId: "second/source",
        threadName: "Second sender",
      },
    });
    const harness = await mountThreadApp({
      request: async (method, params) => {
        const id = (params as { threadId: string }).threadId;
        if (method === "zen/thread/read")
          return id === "exact/source" ? first.promise : second.promise;
        if (method === "zen/thread/resume") {
          resumes.push(id);
          return resumed(id === "thread-1" ? thread : { ...liveThread(), id });
        }
        throw new Error(method);
      },
    });
    try {
      await selectedComposer();
      const links = await waitFor(() => {
        const values = document.querySelectorAll<HTMLButtonElement>(
          ".message-source-link",
        );
        return values.length === 2 ? values : null;
      });
      await act(async () => links[0]!.click());
      await act(async () => links[1]!.click());
      const finishFirst = () =>
        first.resolve({ thread: { id: "exact/source", archived: false } });
      const finishSecond = () =>
        second.resolve({ thread: { id: "second/source", archived: false } });
      await act(async () => (olderFirst ? finishFirst() : finishSecond()));
      await act(async () => (olderFirst ? finishSecond() : finishFirst()));
      assert.equal(
        resumes.at(-1),
        "second/source",
        "the second source click must own navigation",
      );
    } finally {
      await unmountApp(harness);
    }
  });
}

for (const visibility of ["keep", "hide", "reopen"] as const) {
  test(`queued message source preserves ownership across ${visibility}`, async () => {
    const hide = visibility !== "keep";
    const base = nativeRecoveryForThread(runningThread());
    const queue = {
      type: "thread_message_queued" as const,
      id: "queued-source",
      clientId: "queued-source-client",
      threadId: "thread-1",
      createdAt: new Date(20000).toISOString(),
      sender: {
        threadId: "exact/source",
        threadName: "Queued sender",
        toolCallId: "queued-call",
        callId: "send",
      },
      input: [{ type: "text" as const, text: "Queued instructions" }],
      deliveryMode: "batch-next" as const,
      messageType: "follow_up" as const,
    };
    const pending = deferred<{ thread: { id: string; archived: boolean } }>();
    const calls: string[] = [];
    const resumes: string[] = [];
    const harness = await mountThreadApp({
      request: async (method, params) => {
        calls.push(method);
        if (method === "zen/thread/read") return pending.promise;
        if (method === "zen/thread/resume") {
          const id = (params as { threadId: string }).threadId;
          resumes.push(id);
          return id === "thread-1"
            ? {
                ...base,
                thread: {
                  ...base.thread,
                  items: [...base.thread.items, queue],
                },
              }
            : resumed({ ...liveThread(), id });
        }
        throw new Error(method);
      },
    });
    try {
      await selectedComposer();
      const toggle = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(".queue-shelf-toggle"),
      );
      if (toggle.getAttribute("aria-expanded") === "false")
        await act(async () => toggle.click());
      const link = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(
          ".queue-row .message-source-link",
        ),
      );
      assert.equal(link.closest('[role="button"]'), null);
      await act(async () => {
        link.focus();
        link.click();
      });
      if (hide) await act(async () => toggle.click());
      if (visibility === "reopen") await act(async () => toggle.click());
      await act(async () =>
        pending.resolve({ thread: { id: "exact/source", archived: false } }),
      );
      assert.deepEqual(
        resumes,
        hide ? ["thread-1"] : ["thread-1", "exact/source"],
      );
      if (hide) {
        if (visibility === "hide") await act(async () => toggle.click());
        assert.equal(link.getAttribute("aria-busy"), "false");
        await act(async () => link.click());
        assert.deepEqual(resumes, ["thread-1", "exact/source"]);
      }
      assert.ok(
        calls.every((method) =>
          ["zen/thread/read", "zen/thread/resume"].includes(method),
        ),
      );
    } finally {
      await unmountApp(harness);
    }
  });
}

test("same-title side conversations retain identity, drafts and reading positions through rename, close, reopen and main navigation", async () => {
  const children = ["child-a", "child-b"].map((id) => ({
    ...summary(false, id, "Same child title"),
    parentThreadId: "thread-1",
  }));
  const renames: Array<{ threadId: string; title: string }> = [];
  const harness = await mountThreadApp({
    initialPinnedThreadIds: ["child-a"],
    initialProfile: { visibleSubagentThreadIds: ["child-a"] },
    projectsGet: async () => ({
      projects: [
        {
          key: "/work/zen",
          workspace: "/work/zen",
          configured: true,
          isDefault: true,
          threadIds: ["thread-1", "other-parent", "child-a", "child-b"],
        },
      ],
      unavailableThreadIds: [],
      lastUsedWorkspace: "/work/zen",
    }),
    threads: async (archived) =>
      archived
        ? []
        : [
            summary(false),
            summary(false, "other-parent", "Other parent"),
            ...children,
          ],
    request: async (method, params) => {
      const id = (params as { threadId: string }).threadId;
      if (method === "zen/thread/resume")
        return resumed({ ...liveThread(), id });
      throw new Error(method);
    },
    plugins: {
      get: async () => messageSourcePlugins(),
      executeCommand: async (_plugin, command) => {
        if (command === "list") return { threads: children };
        throw new Error(command);
      },
    },
  });
  window.zenx.titles.rename = async (threadId, title) => {
    renames.push({ threadId, title });
    return { threadId, title, status: "manual", version: 1, source: "manual" };
  };
  // Model native scroll clamping while exercising App's real per-Thread cache.
  const tops = new WeakMap<HTMLElement, number>();
  Object.defineProperties(harness.dom.window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => 1600 },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        tops.set(this, Math.max(0, Math.min(1200, value)));
      },
    },
  });
  const tab = (id: string) =>
    document.getElementById(`aux-tab-${id}`) as HTMLButtonElement;
  const sideComposer = (id: string) =>
    waitFor(
      () =>
        document.getElementById(
          `side-composer-${id}`,
        ) as HTMLTextAreaElement | null,
    );
  const sideMessages = (id: string) => {
    const messages = document
      .getElementById(`side-composer-${id}`)
      ?.closest(".thread-view")
      ?.querySelector<HTMLElement>(".messages");
    assert.ok(messages, `Expected the visible transcript for ${id}`);
    return messages;
  };
  const readAt = async (id: string, top: number) => {
    const messages = sideMessages(id);
    await act(async () => {
      messages.dispatchEvent(
        new window.WheelEvent("wheel", { deltaY: -75, bubbles: true }),
      );
      messages.scrollTop = top;
      messages.dispatchEvent(new window.Event("scroll"));
    });
    assert.equal(messages.scrollTop, top);
  };
  const click = async (button: HTMLElement) => {
    assert.ok(button);
    await act(async () => button.click());
  };
  const openChild = async (index: number) => {
    await click(tab("plugin:zenx-subagents:subagents"));
    const row = await waitFor(
      () =>
        document.querySelectorAll<HTMLButtonElement>(".subagent-tree-row")[
          index
        ],
    );
    await click(row);
  };
  try {
    await click(
      await waitFor(() =>
        [...document.querySelectorAll<HTMLButtonElement>(".thread-row")].find(
          (node) => node.textContent?.includes("Thread one"),
        ),
      ),
    );
    await setTextareaValue(
      await waitFor(() =>
        document.querySelector<HTMLTextAreaElement>("#thread-composer"),
      ),
      "Keep parent draft",
    );
    await click(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Open side panel"]',
      )!,
    );
    await click(
      await waitFor(() =>
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".workspace-tab-types button",
          ),
        ].find(
          (node) => node.querySelector("strong")?.textContent === "Subagents",
        ),
      ),
    );
    const rows = await waitFor(() => {
      const rows =
        document.querySelectorAll<HTMLButtonElement>(".subagent-tree-row");
      return rows.length === 2 ? rows : null;
    });
    await click(rows[0]!);
    await setTextareaValue(await sideComposer("child-a"), "Draft A");
    await readAt("child-a", 275);
    await openChild(1);
    await setTextareaValue(await sideComposer("child-b"), "Draft B");
    await readAt("child-b", 650);
    assert.ok(
      tab("thread:child-a"),
      "Opening B must retain the existing A instance",
    );
    assert.ok(tab("thread:child-b"));
    assert.equal(tab("thread:child-b").getAttribute("aria-selected"), "true");
    assert.equal(tab("thread:child-a").textContent, "Same child title");
    assert.equal(tab("thread:child-b").textContent, "Same child title");
    const selectedTranscript = sideMessages("child-b");
    const selectedDraft = await sideComposer("child-b");
    // Rename inactive A through the real Sidebar action, keeping B selected.
    await click(document.getElementById("thread-menu-trigger-child-a")!);
    await click(
      await waitFor(() =>
        document.querySelector<HTMLButtonElement>(
          '[data-thread-action="rename"]',
        ),
      ),
    );
    const titleInput = await waitFor(() =>
      document.querySelector<HTMLInputElement>(".thread-menu-rename input"),
    );
    await setInputValue(titleInput, "Renamed child A");
    await invokeFormSubmit(titleInput.form!);
    await waitFor(
      () => tab("thread:child-a").textContent === "Renamed child A",
    );
    assert.deepEqual(renames, [
      { threadId: "child-a", title: "Renamed child A" },
    ]);
    assert.equal(tab("thread:child-b").textContent, "Same child title");
    assert.equal(tab("thread:child-b").getAttribute("aria-selected"), "true");
    assert.equal(await sideComposer("child-b"), selectedDraft);
    assert.equal(selectedDraft.value, "Draft B");
    assert.equal(sideMessages("child-b"), selectedTranscript);
    assert.equal(selectedTranscript.scrollTop, 650);
    assert.equal(
      document.querySelector(".workspace-header .thread-title-line strong")
        ?.textContent,
      "Thread one",
    );
    await click(tab("thread:child-a"));
    assert.equal((await sideComposer("child-a")).value, "Draft A");
    assert.equal(sideMessages("child-a").scrollTop, 275);
    await click(
      tab("thread:child-b").parentElement!.querySelector<HTMLButtonElement>(
        ".workspace-tab-close",
      )!,
    );
    assert.equal(tab("thread:child-b"), null);
    assert.equal(tab("thread:child-a").getAttribute("aria-selected"), "true");
    await openChild(1);
    assert.equal((await sideComposer("child-b")).value, "Draft B");
    assert.equal(sideMessages("child-b").scrollTop, 650);
    assert.equal(tab("thread:child-a").textContent, "Renamed child A");
    await openChild(1);
    assert.equal(
      document.querySelectorAll('[id="aux-tab-thread:child-b"]').length,
      1,
    );
    assert.equal((await sideComposer("child-b")).value, "Draft B");
    const other = [
      ...document.querySelectorAll<HTMLButtonElement>(".sidebar .thread-row"),
    ].find((node) => node.textContent?.includes("Other parent"))!;
    await click(other);
    await waitFor(() => document.querySelector("#thread-composer"));
    const parent = [
      ...document.querySelectorAll<HTMLButtonElement>(".sidebar .thread-row"),
    ].find((node) => node.textContent?.includes("Thread one"))!;
    await click(parent);
    assert.equal((await sideComposer("child-b")).value, "Draft B");
    assert.ok(tab("thread:child-a"));
    assert.equal(tab("thread:child-a").textContent, "Renamed child A");
    assert.equal(sideMessages("child-b").scrollTop, 650);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!.value,
      "Keep parent draft",
    );
    await click(
      tab("thread:child-b").parentElement!.querySelector<HTMLButtonElement>(
        ".workspace-tab-close",
      )!,
    );
    assert.equal(tab("thread:child-a").getAttribute("aria-selected"), "true");
    assert.equal((await sideComposer("child-a")).value, "Draft A");
    assert.equal(sideMessages("child-a").scrollTop, 275);
  } finally {
    await unmountApp(harness);
  }
});

test("App persists per-child visibility independently of Pin and preserves open conversation tabs", async () => {
  const children = [
    { ...summary(false, "child-a", "Child A"), parentThreadId: "thread-1" },
    { ...summary(false, "child-b", "Child B"), parentThreadId: "thread-1" },
    { ...summary(false, "nested", "Nested"), parentThreadId: "child-a" },
  ];
  const resumes: string[] = [];
  const pinWrites: string[][] = [];
  const harness = await mountThreadApp({
    initialPinnedThreadIds: ["child-a"],
    threads: async (archived) =>
      archived ? [] : [summary(false), ...children],
    projectsGet: async () => ({
      ...oneProject(),
      projects: [
        {
          ...oneProject().projects[0]!,
          threadIds: ["thread-1", ...children.map((child) => child.threadId)],
        },
      ],
    }),
    onPinnedThreadIds: (ids) => pinWrites.push([...ids]),
    request: async (method, params) => {
      assert.equal(method, "zen/thread/resume");
      const id = (params as { threadId: string }).threadId;
      resumes.push(id);
      return resumed({ ...liveThread(), id });
    },
    plugins: {
      get: async () => messageSourcePlugins(),
      executeCommand: async (_plugin, command) => {
        assert.equal(command, "list");
        return { threads: children };
      },
    },
  });
  const click = async (element: HTMLElement | null) => {
    assert.ok(element);
    await act(async () => element.click());
  };
  const row = (id: string) =>
    document.getElementById(`thread-menu-trigger-${id}`);
  const toggle = (title: string) =>
    document.querySelector<HTMLButtonElement>(
      `[role="switch"][aria-label="Show in sidebar: ${title}"]`,
    );
  const tab = (id: string) => document.getElementById(`aux-tab-${id}`);
  const openTree = async () => {
    if (tab("plugin:zenx-subagents:subagents"))
      await click(tab("plugin:zenx-subagents:subagents"));
    else {
      await click(
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Open side panel"]',
        ),
      );
      await click(
        await waitFor(() =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              ".workspace-tab-types button",
            ),
          ].find(
            (node) => node.querySelector("strong")?.textContent === "Subagents",
          ),
        ),
      );
    }
    await waitFor(() => toggle("Child A"));
  };
  try {
    harness.dom.window.localStorage.setItem(
      "zenx-sidebar-show-subagents",
      "true",
    );
    await selectedComposer();
    await openTree();
    assert.equal(row("child-a"), null, "Pin does not override default hidden");
    assert.equal(row("child-b"), null);
    assert.equal(row("nested"), null);
    await click(toggle("Child B"));
    assert.ok(row("child-b"));
    assert.equal(
      document.querySelector(".pinned-thread-group"),
      null,
      "show does not Pin",
    );
    assert.equal(row("child-a"), null);
    await click(row("child-b"));
    await click(exactMenuButton("Pin")!);
    assert.ok(
      document.querySelector(".pinned-thread-group")?.contains(row("child-b")),
    );
    assert.deepEqual(pinWrites, [["child-b", "child-a"]]);
    await click(toggle("Child B"));
    assert.equal(row("child-b"), null);
    assert.deepEqual(
      (await window.zenx.settings.get()).profile.pinnedThreadIds,
      ["child-b", "child-a"],
    );
    await click(toggle("Child B"));
    await click(row("child-b"));
    await click(exactMenuButton("Unpin")!);
    assert.ok(row("child-b"), "Unpin does not hide");
    assert.equal(toggle("Child B")?.getAttribute("aria-checked"), "true");
    await click(toggle("Child A"));
    await click(toggle("Nested"));
    assert.deepEqual(pinWrites, [["child-b", "child-a"], ["child-a"]]);
    await click(
      [
        ...document.querySelectorAll<HTMLButtonElement>(".subagent-tree-row"),
      ].find((node) => node.textContent?.includes("Child A"))!,
    );
    await waitFor(() => document.getElementById("side-composer-child-a"));
    await setTextareaValue(
      document.getElementById("side-composer-child-a") as HTMLTextAreaElement,
      "Retain child draft",
    );
    await openTree();
    const beforeHideResumes = [...resumes];
    await click(toggle("Child A"));
    assert.equal(row("child-a"), null);
    assert.ok(row("nested"), "hiding a parent does not hide its nested child");
    assert.ok(
      tab("thread:child-a"),
      "hiding does not close an existing child tab",
    );
    assert.equal(
      tab("plugin:zenx-subagents:subagents")?.getAttribute("aria-selected"),
      "true",
    );
    assert.deepEqual(
      resumes,
      beforeHideResumes,
      "visibility does not navigate",
    );
    await click(tab("thread:child-a"));
    assert.equal(
      (
        await waitFor(
          () =>
            document.getElementById(
              "side-composer-child-a",
            ) as HTMLTextAreaElement,
        )
      ).value,
      "Retain child draft",
    );
    await act(async () => harness.root.render(null));
    await act(async () => harness.root.render(createElement(App)));
    await waitFor(() => row("thread-1"));
    assert.equal(row("child-a"), null, "remount preserves hidden Pin");
    assert.ok(row("child-b"));
    assert.ok(row("nested"));
    await click(
      row("thread-1")!
        .closest(".thread-row-shell")!
        .querySelector<HTMLButtonElement>(".thread-row"),
    );
    await waitFor(() => document.getElementById("thread-composer"));
    await openTree();
    assert.equal(toggle("Child A")?.getAttribute("aria-checked"), "false");
    assert.equal(toggle("Child B")?.getAttribute("aria-checked"), "true");
    await click(toggle("Child A"));
    assert.ok(
      document.querySelector(".pinned-thread-group")?.contains(row("child-a")),
      "show restores the existing Pin",
    );
    assert.deepEqual(
      children.map((child) => child.parentThreadId),
      ["thread-1", "thread-1", "child-a"],
    );
  } finally {
    await unmountApp(harness);
  }
});

test("Side chat opening and closing mount a normal local Composer without native creation", async () => {
  const calls: string[] = [];
  const harness = await mountThreadApp({
    plugins: {
      get: async () => ({
        ...workspaceLauncherSnapshot,
        plugins: workspaceLauncherSnapshot.plugins.filter(
          (plugin) => plugin.id === "zenx-subagents",
        ),
      }),
      executeCommand: async () => ({ threads: [] }),
    },
    request: async (method) => {
      calls.push(method);
      if (method === "zen/thread/resume") return resumed(liveThread());
      if (method === "zen/thread/read")
        return { thread: resumed(liveThread()).thread };
      throw new Error(`Unexpected request ${method}`);
    },
  });
  try {
    await selectedComposer();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Open side panel"]')
        ?.click(),
    );
    const open = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="New side chat"]'),
    );
    await act(async () => open.click());
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>('[id^="side-chat-draft-"]'),
    );
    await setTextareaValue(composer, "Unsent local input");
    const tab = document.querySelector(
      '[role="tab"][id*="custom:side-chat-draft-"]',
    );
    assert.ok(tab);
    assert.equal(
      calls.filter((method) => method.includes("create-child")).length,
      0,
    );
    assert.equal(document.querySelectorAll(".subagent-tree-row").length, 0);
    const close = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Close tab Side chat"]',
      ),
    );
    await act(async () => close.click());
    await waitFor(
      () => document.querySelector('[id^="side-chat-draft-"]') === null,
    );
    assert.equal(
      calls.filter((method) => method.includes("create-child")).length,
      0,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("Side chat first Send uses opening snapshot once and promotes to a real child tab", async () => {
  const creates: unknown[] = [];
  const sends: Array<{ threadId: string }> = [];
  const parent = resumed(liveThread()).thread;
  const childView = {
    ...liveThread(),
    id: "child",
    sessionId: "child",
    name: "Sent side chat",
  };
  const create = deferred<{ thread: typeof parent }>();
  const harness = await mountThreadApp({
    plugins: {
      get: async () => ({
        ...workspaceLauncherSnapshot,
        plugins: workspaceLauncherSnapshot.plugins.filter(
          (plugin) => plugin.id === "zenx-subagents",
        ),
      }),
      executeCommand: async () => ({ threads: [] }),
    },
    request: async (method, params) => {
      if (method === "zen/thread/resume")
        return resumed(
          (params as { threadId: string }).threadId === "child"
            ? childView
            : liveThread(),
        );
      if (method === "zen/thread/read") return { thread: parent };
      if (method === "zen/thread/create-child-configured") {
        creates.push(params);
        return create.promise;
      }
      if (method === "zen/turn/send") {
        sends.push(params as { threadId: string });
        return {};
      }
      throw new Error(`Unexpected request ${method}`);
    },
  });
  try {
    await selectedComposer();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Open side panel"]')
        ?.click(),
    );
    const open = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="New side chat"]'),
    );
    await act(async () => open.click());
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>('[id^="side-chat-draft-"]'),
    );
    await setTextareaValue(composer, "First real message");
    const send = composer
      .closest("form")!
      .querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
    await invokePrimarySubmit(send, 2);
    assert.deepEqual(creates, [
      {
        parentThreadId: "thread-1",
        mode: "side-chat",
        snapshot: { itemId: "thread-1-metadata", contextItemId: null },
      },
    ]);
    await act(async () =>
      create.resolve({ thread: resumed(childView).thread }),
    );
    await waitFor(() =>
      document.querySelector('[role="tab"][id*="thread:child"]'),
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.threadId, "child");
    assert.equal(
      document.querySelector('[role="tab"][id*="custom:side-chat-draft-"]'),
      null,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("Side chat drafts stay with their parent across actual Sidebar navigation", async () => {
  const projects = oneProject();
  projects.projects[0]!.threadIds = ["thread-1", "thread-2"];
  let creates = 0;
  const harness = await mountApp(projects, {
    threads: async (archived) =>
      archived
        ? []
        : [summary(false), summary(false, "thread-2", "Thread two")],
    plugins: {
      get: async () => ({
        ...workspaceLauncherSnapshot,
        plugins: workspaceLauncherSnapshot.plugins.filter(
          (plugin) => plugin.id === "zenx-subagents",
        ),
      }),
      executeCommand: async () => ({ threads: [] }),
    },
    request: async (method, params) => {
      const id = (params as { threadId: string }).threadId;
      const thread = {
        ...liveThread(),
        id,
        sessionId: id,
        name: id === "thread-1" ? "Thread one" : "Thread two",
      };
      if (method === "zen/thread/resume") return resumed(thread);
      if (method === "zen/thread/read")
        return { thread: resumed(thread).thread };
      if (method.includes("create-child")) creates++;
      throw new Error(`Unexpected ${method}`);
    },
  });
  try {
    await selectedComposer();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Open side panel"]')
        ?.click(),
    );
    const open = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="New side chat"]'),
    );
    await act(async () => open.click());
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>('[id^="side-chat-draft-"]'),
    );
    await setTextareaValue(composer, "Parent one only");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-thread-id="thread-2"] .thread-row',
        )!
        .click(),
    );
    await waitFor(
      () => document.querySelector('[id^="side-chat-draft-"]') === null,
    );
    assert.doesNotMatch(document.body.textContent ?? "", /Parent one only/);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-thread-id="thread-1"] .thread-row',
        )!
        .click(),
    );
    const restored = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>('[id^="side-chat-draft-"]'),
    );
    assert.equal(restored.value, "Parent one only");
    assert.equal(creates, 0);
  } finally {
    await unmountApp(harness);
  }
});
