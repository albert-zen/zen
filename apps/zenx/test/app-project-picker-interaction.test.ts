import { runtimeCommand } from "./fixtures/agent-runtime-data.js";
import { defaultInformationLayout } from "../src/information-layout.js";
import { NativeInformationService } from "../src/main/native-information-service.js";
import { ThreadSidebarStore } from "../src/main/thread-sidebar-store.js";
import "./dom-primitives.js";
/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZenXCredentialVault } from "../src/main/credential-vault.js";
import { ZenXSettingsService } from "../src/main/settings-service.js";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ZenXSidebarOrder } from "../src/main/host-profile.js";
import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { ServerNotificationParams } from "../src/protocol-client/types.js";
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
      requests
        .filter(({ method }) => method !== "zen/thread/questions/list")
        .map(({ method }) => method),
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
    `both activations in each degraded/rejected case produce explicit diagnostics: ${JSON.stringify(diagnostic.mock.calls.map((call) => call.arguments))}`,
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
    const newClientId = sends[1]!.clientUserMessageId;
    const pending = await waitFor(() =>
      document.querySelector(
        `[data-pending-send-client-id="${newClientId}"][data-send-state="unconfirmed"]`,
      ),
    );
    assert.match(pending.textContent ?? "", /new draft after reconnect/u);
    assert.equal(composer.value, "");
    await setTextareaValue(composer, "Even newer local draft");
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
    assert.equal(composer.value, "Even newer local draft");
    assert.ok(
      document.querySelector(
        `[data-pending-send-client-id="${newClientId}"][data-send-state="unconfirmed"]`,
      ),
    );
    assert.match(document.body.textContent ?? "", /outcome unknown/u);
    assert.equal(sends.length, 2);
  } finally {
    await unmountApp(harness);
  }
});

test("unconfirmed Send keeps a recoverable row and requires explicit recovery before same-id retry", async () => {
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
    assert.equal(composer.value, "");
    const pending = document.querySelector('[data-send-state="unconfirmed"]');
    assert.ok(pending);
    assert.match(pending.textContent ?? "", /Retry this message/u);
    assert.equal(
      turnStartRequests.length,
      1,
      "unknown outcomes never automatically resend",
    );
    const recover = [
      ...pending.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Add back to draft");
    assert.ok(recover);
    await invokeButtonClick(recover);
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

test("selected archive fences later sends without waiting for an earlier auxiliary title", async () => {
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
    assert.equal(
      turnStartCalls,
      1,
      "the earlier send does not wait for its title",
    );
    assert.equal(composer.value, "");
    await setTextareaValue(composer, "Retry after archive failure");

    await act(async () => threadMenuButton("Thread one").click());
    const archive = await waitFor(() => exactMenuButton("Archive"));
    await act(async () => {
      archive.click();
      await Promise.resolve();
      titleResponse.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      turnStartCalls,
      1,
      "title completion cannot resend accepted input",
    );
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
    assert.equal(turnStartCalls, 2);
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
    assert.deepEqual(requests[1]?.threadIds, ["thread-1", "thread-2"]);

    await act(async () => {
      requests[1]?.response.resolve(publicSettings(["thread-1", "thread-2"]));
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
      ["Thread one", "Thread two"],
    );
  } finally {
    await unmountApp(harness);
  }
});

test("new Pins append after manual order and Unpin/re-Pin persists through host restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zenx-app-pin-order-"));
  const createSettings = () =>
    new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: join(directory, "zen"),
      vault: new ZenXCredentialVault(join(directory, "credentials.vault"), {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString(),
      }),
      subscription: {
        login: async () => undefined,
        logout: async () => undefined,
        status: async () => ({ authenticated: false, expired: false }),
      },
    });
  const service = createSettings();
  const rows = [1, 2, 3, 4].map((id) =>
    summary(false, `thread-${id}`, `Thread ${id}`),
  );
  const projects = oneProject();
  projects.projects[0]!.threadIds = rows.map((row) => row.threadId);
  const projectOrder = {
    projectKeys: ["/work/zen"],
    threadIdsByProject: {
      "/work/zen": ["thread-4", "thread-3", "thread-2", "thread-1"],
    },
  };
  let harness: AppHarness | undefined;
  try {
    await service.initialize({ ZENX_PROVIDER: "fake" });
    await service.setSidebarOrder(projectOrder);
    await service.setPinnedThreadIds(["thread-2", "thread-1"]);
    harness = await mountApp(projects, {
      threads: async (archived) => (archived ? [] : rows),
      initialPinnedThreadIds: ["thread-2", "thread-1"],
      initialProfile: { sidebarOrder: projectOrder },
      setPinnedThreadIds: async (threadIds) => {
        await service.setPinnedThreadIds(threadIds);
        const { profile } = await service.publicSettings();
        const value = publicSettings(profile.pinnedThreadIds);
        value.profile.sidebarOrder = profile.sidebarOrder;
        return value;
      },
    });
    const pinnedIds = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          ".pinned-thread-group .thread-row-shell",
        ),
      ].map((row) => row.dataset.threadId);
    const expectPins = async (expected: string[]) => {
      await waitFor(() => pinnedIds().join() === expected.join());
      assert.deepEqual(pinnedIds(), expected);
    };
    const pin = async (name: string, label = "Pin") => {
      await act(async () => threadMenuButton(name).click());
      const button = await waitFor(() => exactMenuButton(label));
      await act(async () => {
        button.click();
        button.click();
      });
    };
    await expectPins(["thread-2", "thread-1"]);
    await pin("Thread 3");
    await expectPins(["thread-2", "thread-1", "thread-3"]);
    const third = document.querySelector<HTMLElement>(
      '.pinned-thread-group [data-thread-id="thread-3"] .thread-row',
    )!;
    await act(async () =>
      third.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowUp",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expectPins(["thread-2", "thread-3", "thread-1"]);
    await pin("Thread 4");
    await expectPins(["thread-2", "thread-3", "thread-1", "thread-4"]);
    await pin("Thread 3", "Unpin");
    await expectPins(["thread-2", "thread-1", "thread-4"]);
    await pin("Thread 3");
    const expected = ["thread-2", "thread-1", "thread-4", "thread-3"];
    await expectPins(expected);
    assert.deepEqual(
      (await service.publicSettings()).profile.sidebarOrder,
      projectOrder,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "host-profile.json"), "utf8"))
        .pinnedThreadIds,
      expected,
    );
    const restarted = createSettings();
    await restarted.initialize({});
    assert.deepEqual(
      (await restarted.publicSettings()).profile.pinnedThreadIds,
      expected,
    );
    assert.deepEqual(
      (await restarted.publicSettings()).profile.sidebarOrder,
      projectOrder,
    );
    await unmountApp(harness);
    harness = await mountApp(projects, {
      threads: async (archived) => (archived ? [] : rows),
      initialPinnedThreadIds: (await restarted.publicSettings()).profile
        .pinnedThreadIds,
      initialProfile: { sidebarOrder: projectOrder },
    });
    assert.deepEqual(
      pinnedIds(),
      expected,
      "reopening App preserves persisted Pin order",
    );
  } finally {
    if (harness) await unmountApp(harness);
    await rm(directory, { recursive: true, force: true });
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
    threadSidebar?: Window["zenx"]["threadSidebar"];
    information?: Window["zenx"]["information"];
    threadQuestionAttention?: Window["zenx"]["threadQuestionAttention"];
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
    modelUsage?(threadId: string): Promise<ModelUsageProjection>;
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
    threadSidebar: options.threadSidebar,
    information: options.information,
    threadQuestionAttention: options.threadQuestionAttention,
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
      forThread: async (threadId: string) =>
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
          : await options.modelUsage(threadId),
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
      sidebarOrder: {
        projectKeys: [],
        threadIdsByProject: {},
      } as ZenXSidebarOrder,
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
): Exclude<NativeThreadSummary, { status: "systemError" }> {
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
    for (const [index, id] of ["thread-1", "thread-2", "thread-1"].entries()) {
      const navigationScope =
        index % 2 === 0 ? "[data-project-key]" : ".recent-thread-group";
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
            `${navigationScope} [data-thread-id="${id}"] .thread-row`,
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
      for (const scope of ["[data-project-key]", ".recent-thread-group"]) {
        const current = document.querySelectorAll(
          `${scope} .thread-row[aria-current="page"]`,
        );
        assert.equal(
          current.length,
          1,
          `${scope} has exactly one selected conversation`,
        );
        assert.equal(
          current[0]
            ?.closest("[data-thread-id]")
            ?.getAttribute("data-thread-id"),
          id,
          `${scope} reflects the same selected Thread after navigating from ${navigationScope}`,
        );
      }
      assert.equal(
        document.querySelectorAll('.thread-row[aria-current="page"]').length,
        2,
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
    assert.match(document.body.textContent ?? "", /Explicit request/u);
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
        [
          "zen/thread/read",
          "zen/thread/resume",
          "zen/thread/questions/list",
        ].includes(call.method),
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
          [
            "zen/thread/read",
            "zen/thread/resume",
            "zen/thread/questions/list",
          ].includes(method),
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
    assert.deepEqual(pinWrites, [["child-a", "child-b"]]);
    await click(toggle("Child B"));
    assert.equal(row("child-b"), null);
    assert.deepEqual(
      (await window.zenx.settings.get()).profile.pinnedThreadIds,
      ["child-a", "child-b"],
    );
    await click(toggle("Child B"));
    await click(row("child-b"));
    await click(exactMenuButton("Unpin")!);
    assert.ok(row("child-b"), "Unpin does not hide");
    assert.equal(toggle("Child B")?.getAttribute("aria-checked"), "true");
    await click(toggle("Child A"));
    await click(toggle("Nested"));
    assert.deepEqual(pinWrites, [["child-a", "child-b"], ["child-a"]]);
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

test("Side chat first Send displays inherited context and staged progress before promoting exactly once", async () => {
  const creates: unknown[] = [];
  const sends: Array<{ threadId: string }> = [];
  const parentView = runningThread();
  parentView.turns[0]!.status = "completed";
  parentView.turns[0]!.items = [
    {
      id: "parent-request",
      type: "userMessage",
      content: [
        {
          type: "text",
          text: "Parent request before opening",
          text_elements: [],
        },
      ],
      clientId: null,
    },
    {
      id: "parent-answer",
      type: "agentMessage",
      text: "Inherited parent answer",
      phase: "final_answer",
      memoryCitation: null,
    },
  ];
  const parent = resumed(parentView).thread;
  const admission = deferred<unknown>();
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
        return admission.promise;
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
    const sideSurface = composer.closest(".thread-view")!;
    assert.match(
      sideSurface.textContent ?? "",
      /Parent request before opening/,
    );
    assert.match(sideSurface.textContent ?? "", /Inherited parent answer/);
    assert.doesNotMatch(sideSurface.textContent ?? "", /Start a new thread/);
    assert.equal(sideSurface.querySelector(".message-fork"), null);
    await setTextareaValue(composer, "First real message");
    const send = composer
      .closest("form")!
      .querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
    await invokePrimarySubmit(send, 2);
    assert.deepEqual(creates, [
      {
        parentThreadId: "thread-1",
        mode: "side-chat",
        snapshot: { itemId: parent.items.at(-1)!.id, contextItemId: null },
      },
    ]);
    assert.match(
      sideSurface.querySelector('[role="status"]')?.textContent ?? "",
      /Creating side chat/,
    );
    assert.ok(
      sideSurface.querySelector(".side-chat-context-note .mini-spinner"),
    );
    assert.equal(send.disabled, true);
    assert.equal(sends.length, 0);
    await act(async () =>
      create.resolve({ thread: resumed(childView).thread }),
    );
    await waitFor(() => sends.length === 1);
    assert.match(
      sideSurface.querySelector(".side-chat-context-note")?.textContent ?? "",
      /Sending your message/,
    );
    assert.equal(composer.value, "First real message");
    await act(async () => admission.resolve({}));
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

test("Add to side chat targets the visible child composer during deferred sidebar promotion", async () => {
  const creates: unknown[] = [];
  const sends: Array<{ threadId: string }> = [];
  const parentView = runningThread();
  parentView.turns[0]!.status = "completed";
  parentView.turns[0]!.items = [
    {
      id: "parent-request",
      type: "userMessage",
      content: [
        {
          type: "text",
          text: "Parent request before opening",
          text_elements: [],
        },
      ],
      clientId: null,
    },
    {
      id: "parent-answer",
      type: "agentMessage",
      text: "Inherited parent answer",
      phase: "final_answer",
      memoryCitation: null,
    },
  ];
  const parent = resumed(parentView).thread;
  const admission = deferred<unknown>();
  const promotion = deferred<void>();
  let promotionPending = false;
  const { emptySidebarState, applySidebarPatch } =
    await import("../src/thread-sidebar-state.js");
  let sidebar = emptySidebarState("thread-1");
  const childView = {
    ...liveThread(),
    id: "child",
    sessionId: "child",
    name: "Sent side chat",
  };
  const create = deferred<{ thread: typeof parent }>();
  const harness = await mountThreadApp({
    threadSidebar: {
      read: async () => sidebar,
      onChanged: () => () => undefined,
      update: async ({ patch }) => {
        if (
          patch.tabs?.some(
            (tab) => tab.kind === "thread" && tab.threadId === "child",
          )
        ) {
          promotionPending = true;
          await promotion.promise;
        }
        sidebar = {
          ...applySidebarPatch(sidebar, patch),
          revision: sidebar.revision + 1,
        };
        return { applied: true, state: sidebar };
      },
    },
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
            : parentView,
        );
      if (method === "zen/thread/read") return { thread: parent };
      if (method === "zen/thread/create-child-configured") {
        creates.push(params);
        return create.promise;
      }
      if (method === "zen/turn/send") {
        sends.push(params as { threadId: string });
        return admission.promise;
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
    const sideSurface = composer.closest(".thread-view")!;
    assert.match(
      sideSurface.textContent ?? "",
      /Parent request before opening/,
    );
    assert.match(sideSurface.textContent ?? "", /Inherited parent answer/);
    assert.doesNotMatch(sideSurface.textContent ?? "", /Start a new thread/);
    assert.equal(sideSurface.querySelector(".message-fork"), null);
    await setTextareaValue(composer, "First real message");
    const send = composer
      .closest("form")!
      .querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
    await invokePrimarySubmit(send, 2);
    assert.deepEqual(creates, [
      {
        parentThreadId: "thread-1",
        mode: "side-chat",
        snapshot: { itemId: parent.items.at(-1)!.id, contextItemId: null },
      },
    ]);
    assert.match(
      sideSurface.querySelector('[role="status"]')?.textContent ?? "",
      /Creating side chat/,
    );
    assert.ok(
      sideSurface.querySelector(".side-chat-context-note .mini-spinner"),
    );
    assert.equal(send.disabled, true);
    assert.equal(sends.length, 0);
    await act(async () =>
      create.resolve({ thread: resumed(childView).thread }),
    );
    await waitFor(() => sends.length === 1);
    assert.match(
      sideSurface.querySelector(".side-chat-context-note")?.textContent ?? "",
      /Sending your message/,
    );
    assert.equal(composer.value, "First real message");
    await act(async () => admission.resolve({}));
    await waitFor(() => promotionPending);
    const childComposer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#side-composer-child"),
    );
    await setTextareaValue(childComposer, "Preserved child draft ");
    const paragraph = document.querySelector(
      '#primary-conversation-content [data-quote-item-id="parent-answer"] [data-message-quote-body] p',
    )!;
    assert.ok(paragraph);
    await act(async () => {
      childComposer.blur();
      document.dispatchEvent(new window.Event("pointerdown"));
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      document.dispatchEvent(new window.Event("selectionchange"));
      selection.addRange(range);
      document.dispatchEvent(new window.Event("pointerup"));
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    const add = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '.message-selection-actions [aria-label="Add to side chat"]',
      ),
    );
    await act(async () => add.click());
    const token = await waitFor(() =>
      document.querySelector("#side-composer-child .reference-token"),
    );
    assert.match(token.textContent ?? "", /Inherited parent answer/);
    await waitFor(() => document.activeElement?.id === "side-composer-child");
    assert.match(
      document.getElementById("side-composer-child")?.textContent ?? "",
      /Preserved child draft/,
    );
    assert.equal(sends.length, 1, "Add never sends another turn");
    await act(async () => promotion.resolve());

    await waitFor(() =>
      document.querySelector('[role="tab"][id*="thread:child"]'),
    );
    assert.ok(document.querySelector("#side-composer-child .reference-token"));
    assert.match(
      document.getElementById("side-composer-child")?.textContent ?? "",
      /Preserved child draft/,
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

for (const scenario of ["idle", "steer", "queue", "new"] as const) {
  test(`send latency: ${scenario} admission does not wait for auxiliary title persistence`, async (t) => {
    const title = deferred<undefined>();
    const admission = deferred<unknown>();
    const sendTimes: number[] = [];
    const sendModes: unknown[] = [];
    const sendClientIds: string[] = [];
    const immediate = scenario === "idle" || scenario === "steer";
    let titleStarted = false;
    const options: Parameters<typeof mountApp>[1] = {
      composerSendMode: scenario === "steer" ? "soft" : "queue",
      observeTitle: async () => {
        titleStarted = true;
        return title.promise;
      },
      startProjectThread: async (workspace) => started(liveThread(), workspace),
      request: async (method, params) => {
        if (method === "zen/thread/resume")
          return resumed(
            scenario === "steer" || scenario === "queue"
              ? runningThread()
              : liveThread(),
          );
        if (method === "zen/turn/send") {
          sendTimes.push(performance.now());
          sendModes.push((params as { mode?: unknown }).mode);
          sendClientIds.push(
            (params as { clientUserMessageId: string }).clientUserMessageId,
          );
          return admission.promise;
        }
        throw new Error(`Unexpected ${method}`);
      },
    };
    const harness =
      scenario === "new"
        ? await mountApp(oneProject(), options)
        : await mountThreadApp(options);
    try {
      const composer =
        scenario === "new"
          ? await waitFor(() =>
              document.querySelector<HTMLTextAreaElement>("#thread-composer"),
            )
          : await selectedComposer();
      await setTextareaValue(composer, "Synthetic delayed title send");
      const activatedAt = performance.now();
      await dispatchComposerKey(composer, { key: "Enter" });
      await waitFor(() => titleStarted);
      // Hold an auxiliary operation while observing the real production App
      // send entry. No Provider requests or fabricated successful messages.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
      const dispatchedBeforeTitle = sendTimes.length === 1;
      assert.equal(
        composer.value,
        immediate ? "" : "Synthetic delayed title send",
        "ordinary input moves to honest Sending; legacy new/queue flows retain the editor",
      );
      assert.equal(
        document.querySelectorAll(".user-row[data-sent-message-id]").length,
        0,
        "no invented accepted bubble",
      );
      if (immediate) {
        const pending = document.querySelector('[data-send-state="sending"]');
        assert.ok(pending);
        assert.match(
          pending.textContent ?? "",
          /Synthetic delayed title send/u,
        );
        assert.equal(pending.hasAttribute("data-sent-message-id"), false);
        assert.equal(
          pending.getAttribute("data-pending-send-client-id"),
          sendClientIds[0],
        );
      } else {
        assert.equal(
          document.querySelector("[data-pending-send-client-id]"),
          null,
        );
      }
      await act(async () => title.resolve(undefined));
      await waitFor(() => sendTimes.length === 1);
      assert.deepEqual(
        sendModes,
        [scenario === "queue" ? "queue" : undefined],
        "running-thread fixture must distinguish actual steer from legacy queue",
      );
      t.diagnostic(
        JSON.stringify({
          scenario,
          titleHoldMs: 200,
          activationToSendMs: Math.round(sendTimes[0]! - activatedAt),
          dispatchedBeforeTitle,
        }),
      );
      await act(async () =>
        admission.reject(
          new Error("Synthetic admission rejected before commit"),
        ),
      );
      assert.equal(
        document.querySelector<HTMLTextAreaElement>("#thread-composer")?.value,
        immediate ? "" : "Synthetic delayed title send",
      );
      if (immediate) {
        const pending = document.querySelector(
          '[data-send-state="unconfirmed"]',
        );
        assert.ok(pending);
        assert.match(
          pending.textContent ?? "",
          /Synthetic delayed title send/u,
        );
      }
      assert.match(
        document.body.textContent ?? "",
        /Synthetic admission rejected/u,
      );
      assert.equal(sendTimes.length, 1, "failure never automatically resends");
      assert.ok(
        dispatchedBeforeTitle,
        "auxiliary title staging must not block input admission",
      );
    } finally {
      title.resolve(undefined);
      admission.resolve({});
      await unmountApp(harness);
    }
  });
}

test("send presentation shows honest pending before admission and canonical identity replaces it without clearing newer drafts", async (t) => {
  const title = deferred<undefined>();
  const admission = deferred<unknown>();
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  let clientId: string | undefined;
  let sends = 0;
  const harness = await mountThreadApp({
    observeTitle: async () => title.promise,
    onNotification: (listener) => {
      notify = listener;
      return () => undefined;
    },
    request: async (method, params: any) => {
      if (method === "zen/thread/resume") return resumed(liveThread());
      if (method === "zen/turn/send") {
        sends++;
        clientId = params.clientUserMessageId;
        return admission.promise;
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  let watermark = 0;
  const emit = async (
    event: import("../../../src/app-server.js").AppServerEvent,
  ) =>
    act(async () =>
      notify?.("zen/thread/event", {
        processEpoch: "test-process-epoch",
        threadId: "thread-1",
        watermark: ++watermark,
        event,
      }),
    );
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Synthetic canonically admitted message");
    const activatedAt = performance.now();
    await dispatchComposerKey(composer, { key: "Enter" });
    await waitFor(() => clientId);
    await emit({
      type: "item_completed",
      item: {
        type: "turn_started",
        id: "started",
        turnId: "turn-delayed",
        threadId: "thread-1",
        createdAt: new Date().toISOString(),
        selection: {
          providerProfileId: "fake",
          modelId: "fake",
          reasoningEffort: "medium",
        },
      },
    });
    await emit({
      type: "turn_started",
      turnId: "turn-delayed",
      threadId: "thread-1",
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    assert.equal(
      document.querySelectorAll(".user-row[data-sent-message-id]").length,
      0,
    );
    const pending = document.querySelector(
      `[data-pending-send-client-id="${clientId}"][data-send-state="sending"]`,
    );
    assert.ok(pending);
    assert.match(
      pending.textContent ?? "",
      /Synthetic canonically admitted message/u,
    );
    assert.equal(document.querySelectorAll(".turn-duration").length, 0);
    assert.equal(composer.value, "");
    const committedAt = performance.now();
    await emit({
      type: "item_completed",
      item: {
        type: "user_message",
        id: "admitted-user",
        turnId: "turn-delayed",
        threadId: "thread-1",
        createdAt: new Date().toISOString(),
        clientId: clientId!,
        text: "Synthetic canonically admitted message",
      },
    });
    const bubble = document.querySelector(
      '.user-row[data-sent-message-id="admitted-user"]',
    );
    assert.equal(
      document.querySelector(`[data-pending-send-client-id="${clientId}"]`),
      null,
    );
    assert.ok(bubble);
    assert.match(
      bubble.textContent ?? "",
      /Synthetic canonically admitted message/u,
    );
    assert.equal(
      composer.value,
      "",
      "canonical admission does not resurrect the already-cleared pending draft",
    );
    assert.equal(document.querySelectorAll(".turn-duration").length, 1);
    const turn = bubble.closest(".turn")!;
    assert.ok(
      [...turn.children].indexOf(bubble) <
        [...turn.children].indexOf(turn.querySelector(".turn-running-label")!),
    );
    t.diagnostic(
      JSON.stringify({
        durableInputHoldMs: 200,
        activationToBubbleMs: Math.round(performance.now() - activatedAt),
        canonicalEventToBubbleMs: Math.round(performance.now() - committedAt),
        titleAndRpcStillPending: true,
      }),
    );
    await setTextareaValue(composer, "New draft survives old acknowledgements");
    await act(async () => {
      admission.resolve({});
      title.reject(new Error("Synthetic auxiliary title failure"));
    });
    assert.equal(composer.value, "New draft survives old acknowledgements");
    assert.equal(sends, 1);
    assert.match(
      document.body.textContent ?? "",
      /Synthetic auxiliary title failure/u,
    );
    assert.equal(document.querySelectorAll(".user-row").length, 1);
  } finally {
    title.resolve(undefined);
    admission.resolve({});
    await unmountApp(harness);
  }
});

function toolDestinationThread(
  name: string,
  output: Record<string, unknown>,
): Thread {
  const thread = sourceNavigationThread();
  thread.turns[0]!.status = "inProgress";
  thread.turns[0]!.items = [
    {
      type: "commandExecution",
      id: "destination-call",
      toolName: name,
      command: name,
      toolArguments: { target: "Same name" },
      pluginId: null,
      scriptPath: null,
      cwd: "/work/zen",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: JSON.stringify(output),
      exitCode: 0,
      durationMs: null,
    },
  ];
  return thread;
}

test("tool destination opens and focuses the exact delivered message, not just its thread or same-text neighbor", async () => {
  const source = toolDestinationThread("zenx_threads_send", {
    threadId: "destination",
    messageId: "exact-delivered",
  });
  const destination = sourceNavigationThread();
  destination.id = "destination";
  const input = destination.turns[0]!.items[0]!;
  assert.equal(input.type, "threadMessage");
  destination.turns[0]!.items = [
    { ...input, id: "same-text-neighbor", clientId: "neighbor" },
    { ...input, id: "exact-delivered", clientId: "receipt" },
  ];
  const calls: string[] = [];
  const harness = await mountThreadApp({
    request: async (method, params) => {
      calls.push(method);
      if (method === "zen/thread/read")
        return { thread: nativeRecoveryForThread(destination).thread };
      if (method === "zen/thread/resume")
        return resumed(
          (params as { threadId: string }).threadId === "thread-1"
            ? source
            : destination,
        );
      throw Error(method);
    },
  });
  try {
    await selectedComposer();
    const link = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".tool-action-target button"),
    );
    assert.equal(link.textContent, "View sent message");
    assert.ok(
      link.closest(".trace-reveal") === null,
      "Action is available independently of tool details",
    );
    assert.equal(
      document
        .querySelector(".trace-item-toggle")
        ?.getAttribute("aria-expanded"),
      "false",
    );
    await act(async () => link.click());
    await waitFor(
      () =>
        document.activeElement?.getAttribute("data-sent-message-id") ===
        "exact-delivered",
    );
    assert.equal(
      document
        .querySelector('[data-sent-message-id="same-text-neighbor"]')
        ?.hasAttribute("data-message-target"),
      false,
    );
    assert.equal(
      document.querySelector(".turn-toggle")?.getAttribute("aria-expanded"),
      "true",
    );
    assert.ok(
      calls.every((method) =>
        [
          "zen/thread/read",
          "zen/thread/resume",
          "zen/thread/questions/list",
        ].includes(method),
      ),
    );
  } finally {
    await unmountApp(harness);
  }
});

for (const failure of ["missing", "pending", "cancelled"] as const) {
  test(`tool destination ${failure} gives precise feedback without selecting another message`, async () => {
    const source = toolDestinationThread("zenx_threads_send", {
      threadId: "destination",
      messageId: "receipt",
    });
    const base = { threadId: "destination", createdAt: "2026-10-28T00:00:00Z" };
    const items =
      failure === "missing"
        ? []
        : [
            {
              ...base,
              id: "receipt",
              type: "thread_message_queued",
              clientId: "client",
              input: [],
              sender: {},
            },
            ...(failure === "cancelled"
              ? [
                  {
                    ...base,
                    id: "cancel",
                    type: "thread_message_cancelled",
                    queuedItemId: "receipt",
                    clientId: "client",
                  },
                ]
              : []),
          ];
    const resumes: string[] = [];
    const harness = await mountThreadApp({
      request: async (method, params) => {
        if (method === "zen/thread/read")
          return { thread: { id: "destination", archived: false, items } };
        if (method === "zen/thread/resume") {
          resumes.push((params as { threadId: string }).threadId);
          return resumed(source);
        }
        throw Error(method);
      },
    });
    try {
      await selectedComposer();
      const link = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(".tool-action-target button"),
      );
      await act(async () => link.click());
      await waitFor(() =>
        document.querySelector(".tool-action-target [role=alert]"),
      );
      assert.match(
        document.querySelector(".tool-action-target [role=alert]")!
          .textContent!,
        failure === "missing"
          ? /exact sent message is unavailable/
          : failure === "pending"
            ? /still queued/
            : /was cancelled/,
      );
      assert.deepEqual(resumes, ["thread-1"]);
    } finally {
      await unmountApp(harness);
    }
  });
}

test("tool trigger destination opens actual other-thread definition in the existing plugin tab without writes", async () => {
  const source = toolDestinationThread("zenx_triggers_update", {
    id: "exact-trigger",
    threadId: "actual-owner",
    label: "Same name",
  });
  const commands: string[] = [];
  const harness = await mountThreadApp({
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(source);
      throw Error(method);
    },
    plugins: {
      get: async () => messageSourcePlugins(),
      executeCommand: async (_pluginId, command) => {
        commands.push(command);
        if (command === "list")
          return {
            triggers: ["other", "exact-trigger"].map((id) => ({
              id,
              label: "Same name",
              threadId: "actual-owner",
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
        throw Error(`Unexpected mutation: ${command}`);
      },
    },
  });
  try {
    const composer = await selectedComposer();
    const link = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".tool-action-target button"),
    );
    await act(async () => link.click());
    const editor = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>(
        ".auxiliary-panel .trigger-editor textarea",
      ),
    );
    assert.equal(editor.value, "exact-trigger");
    assert.ok(
      document.querySelector("#thread-composer") === composer,
      "Opening the exact trigger preserves the existing composer",
    );
    assert.ok(
      commands.every((command) =>
        ["list", "threads", "workspaces", "sidebar_facts"].includes(command),
      ),
    );
  } finally {
    await unmountApp(harness);
  }
});

test("Add to side chat creates only a local structured draft, preserves main input, and reuses the selected draft", async () => {
  const calls: string[] = [];
  const parent = runningThread();
  parent.turns[0]!.status = "completed";
  parent.status = { type: "idle" };
  parent.turns[0]!.items = [
    {
      id: "quote-source",
      type: "agentMessage",
      text: "Exact selected side chat context",
      phase: "final_answer",
      memoryCitation: null,
    },
  ];
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
      if (method === "zen/thread/resume") return resumed(parent);
      if (method === "zen/thread/read")
        return { thread: resumed(parent).thread };
      throw new Error(`Unexpected request ${method}`);
    },
  });
  try {
    const main = await selectedComposer();
    await setTextareaValue(main, "Keep my main question");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Open side panel"]')
        ?.click(),
    );
    await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="New side chat"]'),
    );
    const add = async () => {
      await act(
        async () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      const paragraph = document.querySelector(
        '#primary-conversation-content [data-quote-item-id="quote-source"] [data-message-quote-body] p',
      )!;
      assert.ok(paragraph);
      await act(async () => {
        (document.activeElement as HTMLElement)?.blur();
        document.dispatchEvent(new window.Event("pointerdown"));
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        document.dispatchEvent(new window.Event("selectionchange"));
        selection.addRange(range);
        document.dispatchEvent(new window.Event("pointerup"));
        document.dispatchEvent(new window.Event("selectionchange"));
      });
      const action = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(
          '.message-selection-actions [aria-label="Add to side chat"]',
        ),
      );
      await act(async () => action.click());
    };
    await add();
    const token = await waitFor(() =>
      document.querySelector('[id^="side-chat-draft-"] .reference-token'),
    );
    assert.match(token.textContent ?? "", /Exact selected side chat context/);
    assert.equal(main.value, "Keep my main question");
    assert.equal(
      document.querySelectorAll('[role="tab"][id*="custom:side-chat-draft-"]')
        .length,
      1,
    );
    await add();
    assert.equal(
      document.querySelectorAll('[id^="side-chat-draft-"] .reference-token')
        .length,
      1,
    );
    assert.equal(
      calls.filter((method) => method === "zen/thread/read").length,
      1,
    );
    const openSubagents = async () => {
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
          .click(),
      );
      const choice = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(
          ".workspace-plugin-choice > button",
        ),
      );
      await act(async () => choice.click());
    };
    await openSubagents();
    const newSide = await waitFor(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="New side chat"]'),
    );
    await act(async () => newSide.click());
    const second = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>(
        'textarea[id^="side-chat-draft-"]',
      ),
    );
    await setTextareaValue(second, "Second draft question");
    await add();
    await waitFor(() =>
      document.querySelector('[id^="side-chat-draft-"] .reference-token'),
    );
    assert.equal(
      document.querySelector('[role="dialog"]'),
      null,
      "selected target wins even with multiple side chats",
    );
    assert.equal(
      document.querySelectorAll('[role="tab"][id*="custom:side-chat-draft-"]')
        .length,
      2,
    );
    await openSubagents();
    await add();
    const chooser = await waitFor(() =>
      document.querySelector('[role="dialog"]'),
    );
    assert.match(chooser.textContent ?? "", /Choose a side chat/);
    const first = [
      ...chooser.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Side chat 1");
    assert.ok(first);
    await act(async () => first.click());
    await waitFor(() => document.querySelector('[role="dialog"]') === null);
    assert.equal(
      document.querySelectorAll('[id^="side-chat-draft-"] .reference-token')
        .length,
      1,
    );
    assert.equal(
      calls.some((method) => /send|fork|create-child/.test(method)),
      false,
    );
  } finally {
    await unmountApp(harness);
  }
});

test("Add to side chat keeps a delayed local draft in its original workspace without navigating or focusing after departure", async () => {
  const projects = oneProject();
  projects.projects[0]!.threadIds = ["thread-1", "thread-2"];
  const parent = runningThread();
  parent.status = { type: "idle" };
  parent.turns[0]!.status = "completed";
  parent.turns[0]!.items = [
    {
      id: "delayed-source",
      type: "agentMessage",
      text: "Keep this exact context",
      phase: "final_answer",
      memoryCitation: null,
    },
  ];
  const read = deferred<{ thread: ReturnType<typeof resumed>["thread"] }>();
  const calls: string[] = [];
  const harness = await mountApp(projects, {
    threads: async (archived) =>
      archived
        ? []
        : [summary(false), summary(false, "thread-2", "Thread two")],
    request: async (method, params) => {
      calls.push(method);
      const id = (params as { threadId: string }).threadId;
      if (method === "zen/thread/resume")
        return resumed(
          id === "thread-1"
            ? parent
            : { ...liveThread(), id, sessionId: id, name: "Thread two" },
        );
      if (method === "zen/thread/read") return read.promise;
      throw new Error(`Unexpected request ${method}`);
    },
  });
  try {
    await selectedComposer();
    await act(async () => {
      const paragraph = document.querySelector(
        '#primary-conversation-content [data-quote-item-id="delayed-source"] [data-message-quote-body] p',
      )!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    const action = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '.message-selection-actions [aria-label="Add to side chat"]',
      ),
    );
    await act(async () => action.click());
    await waitFor(() => calls.includes("zen/thread/read"));
    await act(async () => {
      const paragraph = document.querySelector(
        '#primary-conversation-content [data-quote-item-id="delayed-source"] [data-message-quote-body] p',
      )!;
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.firstChild!, 4);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    const again = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '.message-selection-actions [aria-label="Add to side chat"]',
      ),
    );
    await act(async () => again.click());
    assert.equal(
      calls.filter((method) => method === "zen/thread/read").length,
      1,
      "pending source reads share one local draft creation",
    );

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-thread-id="thread-2"] .thread-row',
        )!
        .click(),
    );
    await waitFor(
      () =>
        document
          .querySelector('[data-thread-id="thread-2"] .thread-row')
          ?.getAttribute("aria-current") === "page" ||
        document.querySelector(".thread-heading h1")?.textContent ===
          "Thread two",
    );
    await act(async () => read.resolve({ thread: resumed(parent).thread }));
    assert.equal(document.querySelector('[id^="side-chat-draft-"]'), null);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-thread-id="thread-1"] .thread-row',
        )!
        .click(),
    );
    await selectedComposer();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Open side panel"]')
        ?.click(),
    );
    const tab = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[role="tab"][id*="custom:side-chat-draft-"]',
      ),
    );
    await act(async () => tab.click());
    const token = await waitFor(() =>
      document.querySelector('[id^="side-chat-draft-"] .reference-token'),
    );
    assert.match(token.textContent ?? "", /Keep this exact context/);
    assert.equal(
      document.querySelectorAll('[id^="side-chat-draft-"] .reference-token')
        .length,
      2,
    );
    assert.equal(
      calls.some((method) => /send|fork|create-child/.test(method)),
      false,
    );
  } finally {
    await unmountApp(harness);
  }
});

test(
  "real App canonical append preserves 5000 historical Turn and message renders",
  { timeout: 180000 },
  async (t) => {
    const historicalTurns = 5000;
    const historical: Thread = {
      ...liveThread(),
      turns: Array.from({ length: historicalTurns }, (_, index) => ({
        id: `history-${index}`,
        itemsView: "full" as const,
        status: "completed" as const,
        error: null,
        startedAt: index + 10,
        completedAt: index + 11,
        durationMs: 1000,
        items: [
          {
            id: `user-${index}`,
            type: "userMessage" as const,
            clientId: `client-${index}`,
            content: [
              {
                type: "text" as const,
                text: "Synthetic historical input",
                text_elements: [],
              },
            ],
          },
          {
            id: `agent-${index}`,
            type: "agentMessage" as const,
            text: "Synthetic historical answer",
            phase: "final_answer" as const,
            memoryCitation: null,
          },
        ],
      })),
    };
    const recovery = resumed(historical);
    let notify:
      Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
    const counts = { turns: 0, user: 0, agent: 0, fork: 0 };
    const renderedHistoricalTurnNumbers: number[] = [];
    let observing = false;
    const originalTranslate = i18n.t;
    i18n.t = ((...args: unknown[]) => {
      if (observing) {
        const key = args[0];
        const options = args[1] as { number?: number } | undefined;
        if (
          key === "shell:turnNumber" &&
          typeof options?.number === "number" &&
          options.number <= historicalTurns
        ) {
          counts.turns++;
          renderedHistoricalTurnNumbers.push(options.number);
        }
        if (key === "shell:copyUserMessage") counts.user++;
        if (key === "shell:copyAssistantMessage") counts.agent++;
        if (key === "shell:forkFromMessage") counts.fork++;
      }
      return (
        originalTranslate as unknown as (...values: unknown[]) => unknown
      ).apply(i18n, args);
    }) as unknown as typeof i18n.t;
    const harness = await mountThreadApp({
      onNotification: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      request: async (method) => {
        if (method === "zen/thread/resume") return recovery;
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    });
    let watermark = 0;
    const emit = async (
      event: import("../../../src/app-server.js").AppServerEvent,
    ) =>
      act(async () =>
        notify?.("zen/thread/event", {
          threadId: "thread-1",
          processEpoch: "test-process-epoch",
          watermark: ++watermark,
          event,
        }),
      );
    try {
      await selectedComposer();
      assert.equal(document.querySelectorAll(".turn").length, historicalTurns);
      assert.equal(
        document.querySelectorAll(".agent-copy").length,
        historicalTurns,
      );
      const historicalUser = document.querySelector(
        '[data-sent-message-id="user-0"]',
      );
      const historicalAgent = document.querySelector(
        '[data-read-message-id="agent-0"]',
      );
      assert.equal(
        historicalUser?.getAttribute("data-quote-item-id"),
        "user-0",
      );
      assert.equal(
        historicalAgent?.getAttribute("data-quote-item-id"),
        "agent-0",
      );
      observing = true;
      await emit({
        type: "item_completed",
        item: {
          type: "turn_started",
          id: "next-start",
          threadId: "thread-1",
          turnId: "next",
          createdAt: new Date().toISOString(),
          selection: {
            providerProfileId: "fake",
            modelId: "fake",
            reasoningEffort: "medium",
          },
        },
      });
      await emit({
        type: "turn_started",
        threadId: "thread-1",
        turnId: "next",
      });
      t.diagnostic(
        JSON.stringify({
          phase: "started",
          counts,
          renderedHistoricalTurnNumbers,
        }),
      );
      // latestTurnEnd intentionally drops the previous last end when a newer
      // canonical turn_started exists. Only that Turn loses its endItemId prop.
      assert.deepEqual(
        renderedHistoricalTurnNumbers,
        [historicalTurns],
        "only the previous latest end may rerender; the other 4999 Turns stay unchanged",
      );
      assert.ok(
        counts.user <= 2,
        "only the changed end-owner input may rerender",
      );
      assert.ok(
        counts.agent <= 2,
        "unrelated AgentMessage contexts stay stable",
      );
      assert.ok(counts.fork <= 2, "unrelated fork controls stay stable");
      const boundaryCounts = { ...counts };
      await emit({
        type: "item_completed",
        item: {
          type: "user_message",
          id: "next-user",
          threadId: "thread-1",
          turnId: "next",
          clientId: "next-client",
          createdAt: new Date().toISOString(),
          text: "New synthetic input",
        },
      });
      t.diagnostic(
        JSON.stringify({
          phase: "new-input",
          counts,
          renderedHistoricalTurnNumbers,
        }),
      );
      assert.equal(counts.turns, boundaryCounts.turns);
      assert.ok(
        counts.user - boundaryCounts.user <= 2,
        "only the actual new input may render",
      );
      assert.equal(counts.agent, boundaryCounts.agent);
      assert.equal(counts.fork, boundaryCounts.fork);
      assert.equal(
        document
          .querySelector('[data-sent-message-id="next-user"]')
          ?.getAttribute("data-quote-item-ids"),
        JSON.stringify(["next-user"]),
      );
      assert.equal(
        historicalUser?.getAttribute("data-quote-item-id"),
        "user-0",
      );
      assert.equal(
        historicalAgent?.getAttribute("data-quote-item-id"),
        "agent-0",
      );
      // A genuine late append to an old Turn must still update that Turn and its
      // canonical descendant; the optimization is not a frozen history cache.
      const beforeBackfill = { ...counts };
      await emit({
        type: "item_completed",
        item: {
          type: "agent_message",
          id: "late-history-answer",
          threadId: "thread-1",
          turnId: "history-0",
          createdAt: new Date().toISOString(),
          text: "Late canonical correction",
        },
      });
      t.diagnostic(
        JSON.stringify({
          phase: "late-backfill",
          counts,
          renderedHistoricalTurnNumbers,
        }),
      );
      assert.deepEqual(renderedHistoricalTurnNumbers, [historicalTurns, 1]);
      assert.ok(
        counts.user > beforeBackfill.user &&
          counts.user - beforeBackfill.user <= 2,
      );
      assert.ok(
        counts.agent > beforeBackfill.agent &&
          counts.agent - beforeBackfill.agent <= 2,
      );
      assert.ok(
        counts.fork > beforeBackfill.fork &&
          counts.fork - beforeBackfill.fork <= 2,
      );
      assert.equal(
        document
          .querySelector('[data-read-message-id="late-history-answer"]')
          ?.getAttribute("data-quote-item-ids"),
        JSON.stringify(["late-history-answer"]),
      );
      assert.match(
        document.querySelector('[data-read-message-id="late-history-answer"]')
          ?.textContent ?? "",
        /Late canonical correction/u,
      );
    } finally {
      observing = false;
      i18n.t = originalTranslate;
      await unmountApp(harness);
    }
  },
);

test(
  "real App tool results preserve 5000 historical Turns and keep late tool quotes current",
  { timeout: 180000 },
  async (t) => {
    const historicalTurns = 5000;
    const command = (id: string) => ({
      ...runtimeCommand(id, "echo synthetic", "inProgress"),
      callId: `${id}-call`,
    });
    const historical: Thread = {
      ...liveThread(),
      status: { type: "active", activeFlags: [] },
      turns: Array.from({ length: historicalTurns }, (_, index) => ({
        id: `tool-history-${index}`,
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: index + 10,
        completedAt: index + 11,
        durationMs: 1000,
        items: [
          {
            type: "userMessage",
            id: `tool-history-user-${index}`,
            clientId: null,
            content: [
              {
                type: "text",
                text: "Synthetic historical input",
                text_elements: [],
              },
            ],
          },
          ...(index === 0 ? [command("old-tool")] : []),
          {
            type: "agentMessage",
            id: `tool-history-agent-${index}`,
            text: "Synthetic historical answer",
            phase: "final_answer",
            memoryCitation: null,
          },
        ],
      })),
    };
    historical.turns.push({
      id: "active-tool-turn",
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 6000,
      completedAt: null,
      durationMs: null,
      items: [command("active-tool")],
    });
    const recovery = resumed(historical);
    let notify:
      Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
    const consoleMessages: string[] = [];
    t.mock.method(console, "error", (...values: unknown[]) => {
      consoleMessages.push(values.map(String).join(" "));
    });
    t.mock.method(console, "warn", (...values: unknown[]) => {
      consoleMessages.push(values.map(String).join(" "));
    });
    const renderedHistoricalTurnNumbers: number[] = [];
    let observing = false;
    const originalTranslate = i18n.t;
    t.mock.method(i18n, "t", ((...args: unknown[]) => {
      const options = args[1] as { number?: number } | undefined;
      if (
        observing &&
        args[0] === "shell:turnNumber" &&
        typeof options?.number === "number" &&
        options.number <= historicalTurns
      )
        renderedHistoricalTurnNumbers.push(options.number);
      return (
        originalTranslate as unknown as (...values: unknown[]) => unknown
      ).apply(i18n, args);
    }) as unknown as typeof i18n.t);
    const harness = await mountThreadApp({
      plugins: {
        get: async () => ({
          plugins: [],
          bundles: [],
          surfaces: [],
          sidebar: [],
          pages: [],
          subroutes: [],
          settings: [],
          panels: [],
          commands: [],
          menus: [],
          resultRenderers: [],
        }),
      },
      onNotification: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      request: async (method) => {
        if (method === "zen/thread/resume") return recovery;
        throw new Error(`Unexpected protocol request: ${method}`);
      },
    });
    let watermark = 0;
    const emitResult = async (
      callId: string,
      turnId: string,
      id: string,
      output: string,
    ) => {
      assert.ok(notify, "native event subscription is mounted");
      await act(async () =>
        notify!("zen/thread/event", {
          threadId: "thread-1",
          processEpoch: "test-process-epoch",
          watermark: ++watermark,
          event: {
            type: "item_completed",
            item: {
              type: "tool_result",
              id,
              threadId: "thread-1",
              turnId,
              createdAt: "2026-10-30T00:00:00.000Z",
              callId,
              output,
              exitCode: 0,
            },
          },
        }),
      );
    };
    try {
      await selectedComposer();
      assert.equal(
        document.querySelectorAll(".turn").length,
        historicalTurns + 1,
      );
      const firstTurn = document.querySelector(".turn")!;
      const firstMessage = firstTurn.querySelector(".agent-copy");
      const activeTurn = document.querySelector(".turn.inProgress")!;
      await act(async () => {
        firstTurn.querySelector<HTMLButtonElement>(".turn-toggle")!.click();
        activeTurn
          .querySelector<HTMLButtonElement>(".trace-item-toggle")!
          .click();
      });
      await act(async () =>
        firstTurn
          .querySelector<HTMLButtonElement>(".trace-item-toggle")!
          .click(),
      );
      const activeDetails = activeTurn.querySelector(".trace-tool-detail")!;
      const oldDetails = firstTurn.querySelector(".trace-tool-detail")!;
      assert.ok(
        activeDetails !== null && oldDetails !== null,
        "both tool details are mounted",
      );
      assert.equal(
        activeDetails.getAttribute("data-quote-item-ids"),
        JSON.stringify(["active-tool"]),
      );
      observing = true;
      await emitResult(
        "active-tool-call",
        "active-tool-turn",
        "active-tool-result",
        "Fresh active output",
      );
      assert.deepEqual(
        renderedHistoricalTurnNumbers,
        [],
        "active tool completion does not rerender old Turn bodies",
      );
      assert.match(activeDetails.textContent ?? "", /Fresh active output/u);
      assert.equal(
        activeDetails.getAttribute("data-quote-item-ids"),
        JSON.stringify(["active-tool", "active-tool-result"]),
      );
      assert.ok(
        firstTurn.querySelector(".agent-copy") === firstMessage,
        "historical message DOM is retained",
      );
      assert.ok(
        document.querySelector(".turn") === firstTurn,
        "historical Turn DOM is retained",
      );

      await emitResult(
        "missing-call",
        "missing-turn",
        "unmatched-result",
        "Canonical unmatched result",
      );
      assert.deepEqual(
        renderedHistoricalTurnNumbers,
        [],
        "unmatched result does not invalidate any Turn",
      );
      assert.equal(
        activeDetails.getAttribute("data-quote-item-ids"),
        JSON.stringify(["active-tool", "active-tool-result"]),
      );

      await emitResult(
        "old-tool-call",
        "tool-history-0",
        "old-tool-result",
        "Late historical output",
      );
      assert.deepEqual(
        renderedHistoricalTurnNumbers,
        [1],
        "late result updates only its historical Turn",
      );
      assert.match(oldDetails.textContent ?? "", /Late historical output/u);
      assert.equal(
        oldDetails.getAttribute("data-quote-item-ids"),
        JSON.stringify(["old-tool", "old-tool-result"]),
      );

      await emitResult(
        "active-tool-call",
        "active-tool-turn",
        "replacement-result",
        "Replacement active output",
      );
      assert.deepEqual(
        renderedHistoricalTurnNumbers,
        [1],
        "replacement leaves historical Turns reusable",
      );
      assert.match(
        activeDetails.textContent ?? "",
        /Replacement active output/u,
      );
      assert.doesNotMatch(
        activeDetails.textContent ?? "",
        /Fresh active output/u,
      );
      assert.equal(
        activeDetails.getAttribute("data-quote-item-ids"),
        JSON.stringify([
          "active-tool",
          "active-tool-result",
          "replacement-result",
        ]),
      );
    } finally {
      observing = false;
      await unmountApp(harness);
      assert.deepEqual(
        consoleMessages,
        [],
        "no React/DOM warnings or errors are accepted",
      );
    }
  },
);
for (const claimWins of [false, true]) {
  test(
    "complete App and real native Host: " +
      (claimWins
        ? "claimed batch cannot be recalled or overwrite a newer draft"
        : "whole pending batch restores into the latest Composer before any model claim"),
    { timeout: 15_000 },
    async () => {
      const { fixture } =
        await import("../../../test/thread-message-fixture.js");
      const { NativeConnection } =
        await import("../../../src/protocol/native/connection.js");
      const { NativeRecoveryProjection } =
        await import("../../../src/protocol/native/recovery.js");
      const { pendingSteerMessages } =
        await import("../../../src/steer-recall.js");
      const entered = deferred<void>();
      const release = deferred<void>();
      const secondEntered = deferred<void>();
      const releaseSecond = deferred<void>();
      const recallEntered = deferred<void>();
      const releaseRecall = deferred<void>();
      const observed: import("../../../src/model.js").ModelRequest[] = [];
      const f = fixture({
        provider: "fake",
        async *stream(request) {
          observed.push(request);
          if (observed.length === 1) {
            entered.resolve();
            await release.promise;
          } else {
            secondEntered.resolve();
            await releaseSecond.promise;
          }
          yield { type: "text_delta", delta: "Synthetic gated provider reply" };
        },
      });
      const native = new NativeRecoveryProjection(f.server);
      const listeners = new Set<
        Parameters<Window["zenx"]["protocol"]["onNotification"]>[0]
      >();
      const replies = new Map<
        number,
        {
          resolve(value: unknown): void;
          reject(reason: unknown): void;
        }
      >();
      let nextId = 0;
      const calls: string[] = [];
      const connection = new NativeConnection({
        appServer: f.server,
        projection: native,
        send(message) {
          if ("id" in message && typeof message.id === "number") {
            const waiter = replies.get(message.id);
            if (!waiter) return;
            replies.delete(message.id);
            if ("error" in message)
              waiter.reject(
                Object.assign(new Error(message.error.message), {
                  data: message.error.data,
                }),
              );
            else if ("result" in message) waiter.resolve(message.result);
          } else if ("method" in message) {
            const method = message.method;
            assert(
              method === "zen/thread/event" ||
                method === "model/catalog/updated",
            );
            const params =
              message.params as ServerNotificationParams[typeof method];
            for (const listener of listeners) listener(method, params);
          }
        },
      });
      const request = async (
        method: string,
        params?: unknown,
      ): Promise<unknown> => {
        calls.push(method);
        if (method === "zen/thread/steer/recall" && claimWins) {
          recallEntered.resolve();
          await releaseRecall.promise;
        }
        const id = ++nextId;
        return await new Promise((resolve, reject) => {
          replies.set(id, { resolve, reject });
          void connection.receive({ id, method, params }).catch(reject);
        });
      };
      await request("zen/initialize", {});
      const target = await f.server.startThread();
      const active = await f.server.startTurn(target.id, "Initial model input");
      await entered.promise;
      let harness: AppHarness | undefined;
      try {
        harness = await mountApp(
          {
            projects: [
              {
                key: target.cwd,
                workspace: target.cwd,
                configured: true,
                isDefault: true,
                threadIds: [target.id],
              },
            ],
            unavailableThreadIds: [],
            lastUsedWorkspace: target.cwd,
          },
          {
            composerSendMode: "soft",
            threads: async (archived) =>
              archived
                ? []
                : [
                    {
                      ...summary(
                        false,
                        target.id,
                        "Native recall Thread",
                        target.cwd,
                      ),
                      status: "active",
                    },
                  ],
            request,
            onNotification: (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
        );
        let composer = await selectedComposer();
        for (const text of [
          "First native pending input",
          "Second native pending input",
        ]) {
          await setTextareaValue(composer, text);
          const send = await waitFor(() =>
            document.querySelector<HTMLButtonElement>(
              ".composer-actions .action-orb.steer",
            ),
          );
          await invokePrimarySubmit(send);
          await waitFor(() => composer.value === "");
        }
        let snapshot = await f.server.readThread(target.id);
        assert.equal(pendingSteerMessages(snapshot.items).length, 2);
        assert.equal(
          snapshot.items.filter((item) => item.type === "user_message").length,
          1,
        );
        assert.equal(observed.length, 1);
        await setTextareaValue(composer, "Latest independent draft");
        const recall = await waitFor(() =>
          document.querySelector<HTMLButtonElement>(
            ".pending-steer-heading .queue-header-action",
          ),
        );
        await act(async () => {
          recall.click();
        });
        if (claimWins) {
          await recallEntered.promise;
          await act(async () => {
            release.resolve();
            await secondEntered.promise;
          });
          await act(async () => {
            releaseRecall.resolve();
          });
          await waitFor(() =>
            document
              .querySelector(".pending-steer-panel")
              ?.textContent?.includes(i18n.t("shell:steerRecallConflict")),
          );
          assert.equal(composer.value, "Latest independent draft");
          snapshot = await f.server.readThread(target.id);
          assert.equal(
            snapshot.items.filter(
              (item) => item.type === "user_message_steer_recalled",
            ).length,
            0,
          );
          assert.equal(
            snapshot.items.filter((item) => item.type === "user_message")
              .length,
            3,
          );
          assert.equal(observed.length, 2);
        } else {
          await waitFor(
            () =>
              composer.value ===
              "First native pending input\n\nSecond native pending input\n\nLatest independent draft",
          );
          assert.equal(document.querySelector("[data-queue-id]"), null);
          snapshot = await f.server.readThread(target.id);
          assert.equal(pendingSteerMessages(snapshot.items).length, 0);
          assert.equal(
            snapshot.items.filter(
              (item) => item.type === "user_message_steer_recalled",
            ).length,
            1,
          );
          assert.equal(
            snapshot.items.filter((item) => item.type === "user_message_queued")
              .length,
            2,
          );
          assert.equal(
            snapshot.items.filter((item) => item.type === "user_message")
              .length,
            1,
          );
          await act(async () => {
            release.resolve();
            await active.done;
          });
          assert.equal(observed.length, 1);
          assert.doesNotMatch(
            JSON.stringify(observed),
            /First native pending input|Second native pending input/,
          );
        }
        assert.equal(
          calls.filter((method) => method === "zen/thread/steer/recall").length,
          1,
        );
        assert.equal((await f.server.readThread(target.id)).turns.length, 1);
      } finally {
        await act(async () => {
          release.resolve();
          releaseSecond.resolve();
          releaseRecall.resolve();
          await active.done;
        });
        if (harness) await unmountApp(harness);
        connection.close();
        native.close();
      }
    },
  );
}

test("complete App late recall acknowledgement never navigates or refreshes the newly selected Thread", async () => {
  const { pendingSteerMessages, recoverSteerRecall } =
    await import("../../../src/steer-recall.js");
  const first = nativeRecoveryForThread(runningThread());
  first.thread.items = [
    ...first.thread.items,
    {
      type: "user_message_queued",
      id: "pending-one",
      threadId: "thread-1",
      createdAt: "2026-11-02T00:00:00Z",
      clientId: "pending-client",
      input: [{ type: "text", text: "Recall only into Thread one" }],
      deliveryMode: "steer",
      expectedTurnId: "turn-1",
    },
  ];
  const second = nativeRecoveryForThread({
    ...liveThread(),
    id: "thread-2",
    name: "Thread two",
  });
  const ack =
    deferred<
      import("../../../src/protocol/native/wire.js").NativeSteerRecallResult
    >();
  let requested:
    | import("../../../src/protocol/native/wire.js").NativeSteerRecallParams
    | undefined;
  const resumes: string[] = [];
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
      request: async (method, params) => {
        if (method === "zen/thread/resume") {
          const id = (params as { threadId: string }).threadId;
          resumes.push(id);
          return id === "thread-1" ? first : second;
        }
        if (method === "zen/thread/steer/recall") {
          requested = params as typeof requested;
          return ack.promise;
        }
        throw new Error("Unexpected navigation side effect: " + method);
      },
    },
  );
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Thread one draft");
    const recall = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        ".pending-steer-heading .queue-header-action",
      ),
    );
    await act(async () => recall.click());
    assert.ok(requested);
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ].find((entry) => entry.textContent?.includes("Thread two"));
    assert.ok(row);
    await act(async () => row.click());
    await waitFor(() => resumes.includes("thread-2"));
    const secondComposer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(secondComposer, "Thread two independent draft");
    const receipt: import("../../../src/item.js").SteerRecalledItem = {
      type: "user_message_steer_recalled",
      id: "recall-receipt",
      threadId: "thread-1",
      createdAt: "2026-11-02T00:00:01Z",
      recallId: requested.recallId,
      targets: requested.targets,
    };
    first.thread.items = [...first.thread.items, receipt];
    const result = recoverSteerRecall(
      first.thread.items,
      "thread-1",
      requested.recallId,
    )!;
    assert.ok(result);
    const before = [...resumes];
    await act(async () => ack.resolve({ ...result, status: "recalled" }));
    assert.deepEqual(resumes, before);
    assert.equal(secondComposer.value, "Thread two independent draft");
    assert.equal(pendingSteerMessages(first.thread.items).length, 0);
    assert.equal(document.querySelector(".pending-steer-panel"), null);
  } finally {
    await unmountApp(harness);
  }
});

function derivedScanHistory(running = false): Thread {
  return {
    ...liveThread(),
    ...(running ? { status: runningThread().status } : {}),
    turns: [
      ...Array.from({ length: 40 }, (_, index): Thread["turns"][number] => ({
        id: `derived-history-${index}`,
        itemsView: "full" as const,
        status: "completed" as const,
        error: null,
        startedAt: index + 10,
        completedAt: index + 11,
        durationMs: 1000,
        items: [
          {
            id: `derived-user-${index}`,
            type: "userMessage" as const,
            clientId: `derived-client-${index}`,
            content: [
              {
                type: "text" as const,
                text: "Synthetic history",
                text_elements: [],
              },
            ],
          },
          {
            id: `derived-agent-${index}`,
            type: "agentMessage" as const,
            text: "Synthetic answer",
            phase: "final_answer" as const,
            memoryCitation: null,
          },
        ],
      })),
      ...(running ? runningThread().turns : []),
    ],
  };
}

for (const running of [false, true]) {
  test(`real App ${running ? "active" : "idle"} input and ACK reuse canonical end and active-Turn derivations`, async (t) => {
    const admission = deferred<unknown>();
    let sends = 0;
    const harness = await mountThreadApp({
      composerSendMode: "soft",
      request: async (method) => {
        if (method === "zen/thread/resume")
          return resumed(derivedScanHistory(running));
        if (method === "zen/turn/send") {
          sends++;
          return admission.promise;
        }
        throw new Error(`Unexpected ${method}`);
      },
    });
    const methods = ["findLastIndex", "filter", "reverse", "findLast"] as const;
    const originals = methods.map(
      (method) =>
        [
          method,
          Object.getOwnPropertyDescriptor(Array.prototype, method)!,
        ] as const,
    );
    const emptyCounts = () => ({
      canonicalFindLastIndex: 0,
      canonicalFilter: 0,
      turnSearch: 0,
    });
    let counts = emptyCounts();
    let observing = false;
    // Count the actual arrays created by App's native recovery/projection, not
    // a hand-rendered ThreadView with artificially stable props. Scope the
    // wrappers to this synthetic fixture and always restore the descriptors.
    for (const [method, descriptor] of originals) {
      Object.defineProperty(Array.prototype, method, {
        ...descriptor,
        value: function (this: unknown[], ...args: unknown[]) {
          if (observing) {
            const first = this[0] as { id?: string } | undefined;
            if (first?.id === "thread-1-metadata") {
              if (method === "findLastIndex") counts.canonicalFindLastIndex++;
              if (method === "filter") counts.canonicalFilter++;
            }
            if (
              first?.id === "derived-history-0" &&
              (method === "reverse" || method === "findLast")
            )
              counts.turnSearch++;
          }
          return Reflect.apply(descriptor.value, this, args);
        },
      });
    }
    const samples: { phase: string; counts: ReturnType<typeof emptyCounts> }[] =
      [];
    const record = (phase: string) => {
      samples.push({ phase, counts });
      t.diagnostic(JSON.stringify({ running, phase, counts }));
      counts = emptyCounts();
    };
    try {
      const composer = await selectedComposer();
      observing = true;
      await setTextareaValue(composer, "Synthetic immediate input");
      record("typing");
      await dispatchComposerKey(composer, { key: "Enter" });
      await waitFor(() => sends === 1);
      assert.equal(composer.value, "");
      assert.ok(document.querySelector('[data-send-state="sending"]'));
      record("local-pending-before-ack");
      await act(async () => admission.resolve({ turnId: "turn-1" }));
      record("ack-only");
      await setTextareaValue(composer, "Newer draft after ACK");
      record("newer-draft");
      for (const sample of samples)
        assert.deepEqual(sample.counts, emptyCounts(), sample.phase);
      assert.equal(sends, 1);
    } finally {
      observing = false;
      for (const [method, descriptor] of originals)
        Object.defineProperty(Array.prototype, method, descriptor);
      admission.resolve({});
      await unmountApp(harness);
    }
  });
}

test("real App canonical end and active-Turn derivations invalidate on append, backfill and fork boundaries", async () => {
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
      if (method === "zen/thread/resume") return resumed(derivedScanHistory());
      throw new Error(`Unexpected ${method}`);
    },
  });
  let watermark = 0;
  const emit = async (
    event: import("../../../src/app-server.js").AppServerEvent,
  ) =>
    act(async () =>
      notify?.("zen/thread/event", {
        threadId: "thread-1",
        processEpoch: "test-process-epoch",
        watermark: ++watermark,
        event,
      }),
    );
  const canonical = async (
    item: import("../../../src/item.js").CanonicalItem,
  ) => emit({ type: "item_completed", item });
  const common = {
    threadId: "thread-1",
    createdAt: "2026-11-02T00:00:00.000Z",
  };
  const readEnds = () =>
    [...document.querySelectorAll("section.turn[data-read-message-id]")].map(
      (element) => element.getAttribute("data-read-message-id"),
    );
  try {
    await selectedComposer();
    assert.deepEqual(readEnds(), ["derived-history-39-completed"]);
    await canonical({
      ...common,
      type: "turn_started",
      id: "new-start",
      turnId: "new",
    });
    await emit({ type: "turn_started", threadId: "thread-1", turnId: "new" });
    assert.deepEqual(
      readEnds(),
      [],
      "a new active Turn invalidates the previous end",
    );
    assert.ok(document.querySelector("section.turn.inProgress"));
    assert.ok(
      document.querySelector(".composer-send-control .action-orb.stop"),
    );
    await canonical({
      ...common,
      type: "agent_message",
      id: "late-backfill",
      turnId: "derived-history-0",
      text: "Late historical answer",
    });
    assert.deepEqual(
      readEnds(),
      [],
      "backfill does not revive the prior end while another Turn runs",
    );
    assert.match(
      document.querySelector('[data-read-message-id="late-backfill"]')
        ?.textContent ?? "",
      /Late historical answer/u,
    );
    await canonical({
      ...common,
      type: "turn_completed",
      id: "new-end",
      turnId: "new",
      status: "completed",
    });
    await emit({
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "new",
      status: "completed",
    });
    assert.deepEqual(readEnds(), ["new-end"]);
    assert.equal(document.querySelector("section.turn.inProgress"), null);
    assert.equal(
      document.querySelector(".composer-send-control .action-orb.stop"),
      null,
    );
    await canonical({
      ...common,
      type: "thread_forked",
      id: "fork-boundary",
      sourceThreadId: "source",
      sourceBoundaryItemId: "new-end",
      sourceTurnId: "new",
      workspace: "same-directory",
    });
    assert.deepEqual(
      readEnds(),
      [],
      "copied pre-fork ends are not local execution ends",
    );
    await canonical({
      ...common,
      type: "turn_started",
      id: "local-start",
      turnId: "local",
    });
    await emit({ type: "turn_started", threadId: "thread-1", turnId: "local" });
    await canonical({
      ...common,
      type: "turn_aborted",
      id: "local-end",
      turnId: "local",
      reason: "Synthetic stop",
    });
    await emit({
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "local",
      status: "interrupted",
    });
    assert.deepEqual(
      readEnds(),
      ["local-end"],
      "a local post-fork end is observable immediately",
    );
  } finally {
    await unmountApp(harness);
  }
});

for (const activation of ["pointer", "keyboard-button"] as const) {
  test(`real App ${activation} submit returns focused Send to its Composer before disabling`, async (t) => {
    const admission = deferred<unknown>();
    let sends = 0;
    let observation:
      | import("../../../src/client-observation.js").ClientSendObservation
      | undefined;
    const harness = await mountThreadApp({
      request: async (method, params) => {
        if (method === "zen/thread/resume")
          return resumed(derivedScanHistory());
        if (method === "zen/turn/send") {
          sends++;
          observation = (params as { clientObservation?: typeof observation })
            .clientObservation;
          return admission.promise;
        }
        throw new Error(`Unexpected ${method}`);
      },
    });
    const originalSetAttribute = Element.prototype.setAttribute;
    let restoreFocus = () => {};
    let removeFocusListeners = () => {};
    try {
      const composer = await selectedComposer();
      await setTextareaValue(composer, "Synthetic focused Send");
      const send = document.querySelector<HTMLButtonElement>(
        ".composer-send-control > button.action-orb.send",
      )!;
      assert.ok(send);
      // JSDOM does not synthesize native pointer/keyboard focus or button activation.
      // Establish that focus precondition explicitly, then exercise App's real click route.
      await act(async () => send.focus());
      const calls: FocusOptions[] = [];
      const order: string[] = [];
      const focusEvents: string[] = [];
      let observingFocus = true;
      const recordFocus = (event: Event) => {
        if (!observingFocus) return;
        if (event.target === send) focusEvents.push(`send-${event.type}`);
        if (event.target === composer)
          focusEvents.push(`composer-${event.type}`);
      };
      for (const type of ["blur", "focusout", "focus", "focusin"])
        document.addEventListener(type, recordFocus, true);
      removeFocusListeners = () => {
        for (const type of ["blur", "focusout", "focus", "focusin"])
          document.removeEventListener(type, recordFocus, true);
      };
      let focusAt = 0;
      const originalFocus = composer.focus;
      composer.focus = function (options?: FocusOptions) {
        calls.push(options ?? {});
        focusAt = performance.now();
        order.push("composer-focus");
        originalFocus.call(this, options);
      };
      restoreFocus = () => {
        composer.focus = originalFocus;
      };
      Element.prototype.setAttribute = function (name: string, value: string) {
        if (this === send && name === "disabled") {
          order.push(
            document.activeElement === composer
              ? "disable-after-focus"
              : "disable-without-focus",
          );
        }
        return originalSetAttribute.call(this, name, value);
      };
      await act(async () =>
        send.dispatchEvent(
          new harness.dom.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            detail: activation === "pointer" ? 1 : 0,
          }),
        ),
      );
      await waitFor(() => sends === 1);
      observingFocus = false;
      assert.equal(composer.value, "");
      assert.ok(document.querySelector('[data-send-state="sending"]'));
      assert.deepEqual(calls, [{ preventScroll: true }]);
      assert.deepEqual(order, ["composer-focus", "disable-after-focus"]);
      assert.deepEqual(focusEvents, [
        "send-blur",
        "send-focusout",
        "composer-focus",
        "composer-focusin",
      ]);
      assert.equal(document.activeElement === composer, true);
      assert.equal(send.disabled, true);
      assert.ok(observation);
      assert.ok(
        BigInt(observation.clock.monotonicNs) <=
          BigInt(Math.floor(focusAt * 1e6)),
        "activation clock includes the focus operation",
      );
      await act(async () => send.click());
      assert.equal(
        sends,
        1,
        "native disabled still prevents duplicate submission",
      );
      await setTextareaValue(composer, "New draft after immediate send");
      const elsewhere =
        document.querySelector<HTMLButtonElement>(".thread-row")!;
      await act(async () => elsewhere.focus());
      await act(async () => admission.resolve({ turnId: "focus-turn" }));
      assert.equal(
        document.activeElement === elsewhere,
        true,
        "old ACK must not reclaim focus",
      );
      assert.equal(composer.value, "New draft after immediate send");
      assert.equal(calls.length, 1);
      t.diagnostic(
        JSON.stringify({
          activation,
          order,
          focusEvents,
          focusCalls: calls.length,
          sends,
        }),
      );
    } finally {
      Element.prototype.setAttribute = originalSetAttribute;
      removeFocusListeners();
      restoreFocus();
      admission.resolve({});
      await unmountApp(harness);
    }
  });
}

test("real App editor, invalid and external-owner submits do not acquire Composer focus", async () => {
  let sends = 0;
  const harness = await mountThreadApp({
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(derivedScanHistory());
      if (method === "zen/turn/send") {
        sends++;
        return {};
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  let restoreFocus = () => {};
  try {
    const composer = await selectedComposer();
    const send = document.querySelector<HTMLButtonElement>(
      ".composer-send-control > button.action-orb.send",
    )!;
    let focuses = 0;
    const originalFocus = composer.focus;
    composer.focus = function (options?: FocusOptions) {
      focuses++;
      originalFocus.call(this, options);
    };
    restoreFocus = () => {
      composer.focus = originalFocus;
    };
    const elsewhere = document.querySelector<HTMLButtonElement>(".thread-row")!;
    await act(async () => elsewhere.focus());
    await invokeButtonClick(send); // Even bypassing the DOM disabled check must hit submit's guard.
    assert.equal(sends, 0);
    assert.equal(document.activeElement === elsewhere, true);
    assert.equal(focuses, 0);
    await setTextareaValue(composer, "IME draft");
    await act(async () => composer.focus());
    focuses = 0;
    await dispatchComposerKey(composer, { key: "Enter", isComposing: true });
    await dispatchComposerKey(composer, { key: "Enter", repeat: true });
    assert.equal(sends, 0);
    assert.equal(focuses, 0);
    await dispatchComposerKey(composer, { key: "Enter" });
    await waitFor(() => sends === 1);
    assert.equal(document.activeElement === composer, true);
    assert.equal(focuses, 0, "textarea Enter does not refocus the editor");
    await setTextareaValue(composer, "External focus remains owned");
    await act(async () => elsewhere.focus());
    await invokeButtonClick(send);
    await waitFor(() => sends === 2);
    assert.equal(
      document.activeElement === elsewhere,
      true,
      "a Send without focus does not steal another owner's focus",
    );
    assert.equal(focuses, 0);
  } finally {
    restoreFocus();
    await unmountApp(harness);
  }
});

test("real App delayed send ACK after Thread navigation never focuses the new owner", async () => {
  const admission = deferred<unknown>();
  let sends = 0;
  const resumes: string[] = [];
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
      request: async (method, params) => {
        if (method === "zen/thread/resume") {
          const id = (params as { threadId: string }).threadId;
          resumes.push(id);
          return resumed({
            ...liveThread(),
            id,
            name: id === "thread-2" ? "Thread two" : "Thread one",
          });
        }
        if (method === "zen/turn/send") {
          sends++;
          return admission.promise;
        }
        throw new Error(`Unexpected ${method}`);
      },
    },
  );
  try {
    const first = await selectedComposer();
    await setTextareaValue(first, "Thread one send");
    const send = document.querySelector<HTMLButtonElement>(
      ".composer-send-control > button.action-orb.send",
    )!;
    await act(async () => send.focus());
    await act(async () => send.click());
    await waitFor(() => sends === 1);
    assert.equal(document.activeElement === first, true);
    const secondRow = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ].find((row) => row.textContent?.includes("Thread two"))!;
    await act(async () => secondRow.click());
    await waitFor(() => resumes.includes("thread-2"));
    const second =
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!;
    await setTextareaValue(second, "Thread two draft");
    await act(async () => second.focus());
    const before = [...resumes];
    await act(async () => admission.resolve({ turnId: "old-turn" }));
    assert.equal(document.activeElement === second, true);
    assert.equal(second.value, "Thread two draft");
    assert.deepEqual(resumes, before);
    assert.equal(sends, 1);
  } finally {
    admission.resolve({});
    await unmountApp(harness);
  }
});

test("native streaming deltas update the real App without reloading or cloning information catalogs", async (t) => {
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  let summaryReads = 0,
    projectReads = 0,
    contextClones = 0;
  const clone = globalThis.structuredClone;
  let summaries: NativeThreadSummary[] = [
    summary(false),
    ...Array.from({ length: 64 }, (_, index) => ({
      ...summary(false, `child-${index}`, `Child ${index}`),
      parentThreadId: "thread-1",
    })),
  ];
  const snapshot = messageSourcePlugins();
  globalThis.structuredClone = ((
    value: unknown,
    options?: StructuredSerializeOptions,
  ) => {
    if (
      value &&
      typeof value === "object" &&
      "threadId" in value &&
      "threads" in value
    )
      contextClones++;
    return clone(value, options);
  }) as typeof structuredClone;
  const harness = await mountThreadApp({
    information: {
      read: async (value) => {
        const owner =
          typeof value === "string"
            ? { kind: "thread" as const, id: value }
            : value;
        return {
          owner,
          revision: 0,
          basis: "synthetic-default",
          layout: defaultInformationLayout(owner),
          members: [],
          ...(owner.kind === "thread" ? { resourceThreadId: owner.id } : {}),
        };
      },
      update: async () => {
        throw Error("Streaming must not edit the layout");
      },
    },
    threads: async (archived) => {
      summaryReads++;
      return clone(archived ? [] : summaries);
    },
    projectsGet: async () => {
      projectReads++;
      return {
        ...oneProject(),
        projects: [{ ...oneProject().projects[0]!, threadIds: ["thread-1"] }],
      };
    },
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(runningThread());
      throw new Error(method);
    },
    plugins: {
      get: async () => snapshot,
      executeCommand: async (_plugin, command) => {
        assert.equal(command, "list");
        return { threads: clone(summaries.slice(1)) };
      },
    },
  });
  let watermark = 0;
  const emit = (event: import("../../../src/app-server.js").AppServerEvent) =>
    act(async () =>
      notify?.("zen/thread/event", {
        threadId:
          event.type === "item_completed"
            ? event.item.threadId
            : "threadId" in event
              ? event.threadId
              : "thread-1",
        processEpoch: "test-process-epoch",
        watermark: ++watermark,
        event,
      }),
    );
  try {
    await selectedComposer();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".information-toolbar button")!
        .click(),
    );
    await waitFor(() =>
      document.querySelector(".information-content .subagents-panel"),
    );
    for (const [itemId, itemType] of [
      ["stream-answer", "agent_message"],
      ["stream-reasoning", "reasoning"],
    ] as const)
      await emit({
        type: "item_started",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId,
        itemType,
      });
    const before = { summaryReads, projectReads, contextClones };
    assert.ok(
      before.contextClones > 0,
      "real admitted GenericPluginUiHost has cloned its immutable context",
    );
    for (let index = 0; index < 10; index++) {
      await emit({
        type: "item_delta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "stream-answer",
        delta: `visible-token-${index} `,
      });
      await emit({
        type: "reasoning_summary_delta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "stream-reasoning",
        delta: "summary ",
      });
      await emit({
        type: "reasoning_content_delta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "stream-reasoning",
        delta: "reasoning ",
      });
    }
    assert.match(
      document.querySelector(".agent-surface")!.textContent!,
      /visible-token-9/,
    );
    assert.deepEqual(
      { summaryReads, projectReads, contextClones },
      before,
      "30 native transient deltas do not issue list/project IPC or clone catalog contexts, even when every RPC returns fresh arrays",
    );
    t.diagnostic(
      JSON.stringify({
        deltas: 30,
        summaryReads: summaryReads - before.summaryReads,
        projectReads: projectReads - before.projectReads,
        contextClones: contextClones - before.contextClones,
      }),
    );
    const refresh = async (
      event: import("../../../src/app-server.js").AppServerEvent,
    ) => {
      const reads = summaryReads,
        projects = projectReads;
      await emit(event);
      assert.equal(
        summaryReads,
        reads + 2,
        `${event.type} refreshes active and archived summaries`,
      );
      assert.equal(
        projectReads,
        projects + 1,
        `${event.type} refreshes project facts`,
      );
    };
    summaries = summaries.map((row, index) =>
      index === 1 && row.status !== "systemError"
        ? { ...row, name: "Changed live child", status: "active" as const }
        : row,
    );
    await refresh({
      type: "thread_name_updated",
      threadId: "child-0",
      name: "Changed live child",
    });
    assert.match(
      document.querySelector(".information-content")!.textContent!,
      /Changed live child/,
    );
    assert.ok(
      contextClones > before.contextClones,
      "real child facts still reach the card",
    );
    await refresh({
      type: "thread_settings_updated",
      threadId: "thread-1",
      settings: {
        providerProfileId: "fake",
        modelId: "fake",
        reasoningEffort: "medium",
        model: "fake",
        provider: "fake",
        cwd: "/work/zen",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    await refresh({
      type: "turn_started",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await refresh({
      type: "item_completed",
      item: {
        type: "user_message",
        id: "first-input",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-11-02T00:00:00Z",
        text: "Canonical input still refreshes",
      },
    });
    await refresh({
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    await refresh({
      type: "thread_archived_updated",
      threadId: "child-0",
      archived: true,
    });
    await refresh({
      type: "item_completed",
      item: {
        type: "agent_message",
        id: "final-answer",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-11-02T00:00:01Z",
        text: "Canonical answer still refreshes",
      },
    });
  } finally {
    await unmountApp(harness);
    globalThis.structuredClone = clone;
  }
});

function usageProjection(inputTokens: number | null): ModelUsageProjection {
  return {
    thread: { responseCount: 1, inputTokens: 12, outputTokens: 3 },
    turns: {},
    context: {
      inputTokens,
      inputTokenSource: inputTokens === null ? null : "estimated",
      contextWindow: inputTokens === null ? null : 100,
      ratio: inputTokens === null ? null : inputTokens / 100,
    },
  };
}

function contextUsageLabel(): string {
  return (
    document
      .querySelector(".context-usage-trigger")
      ?.getAttribute("aria-label") ?? ""
  );
}

test("App usage coalesces six native completion reads and drains the latest burst on long history", async (t) => {
  const requests: ReturnType<typeof deferred<ModelUsageProjection>>[] = [];
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  const history: Thread = {
    ...liveThread(),
    turns: Array.from({ length: 40 }, (_, index) => ({
      id: `history-${index}`,
      status: "completed" as const,
      itemsView: "full" as const,
      items: [
        {
          type: "userMessage" as const,
          id: `input-${index}`,
          clientId: `client-${index}`,
          content: [
            {
              type: "text" as const,
              text: `Historical input ${index}`,
              text_elements: [],
            },
          ],
        },
        {
          type: "agentMessage" as const,
          id: `answer-${index}`,
          text: `Historical answer ${index}`,
          phase: "final_answer" as const,
          memoryCitation: null,
        },
      ],
      error: null,
      startedAt: index + 1,
      completedAt: index + 2,
      durationMs: 1,
    })),
  };
  const admission = deferred<unknown>();
  let clientId: string | undefined;
  const harness = await mountThreadApp({
    composerSendMode: "soft",
    modelUsage: () => {
      const request = deferred<ModelUsageProjection>();
      requests.push(request);
      return request.promise;
    },
    request: async (method, params) => {
      if (method === "zen/thread/resume") return resumed(history);
      if (method === "zen/turn/send") {
        clientId = (params as { clientUserMessageId: string })
          .clientUserMessageId;
        return admission.promise;
      }
      throw new Error(method);
    },
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  });
  let watermark = 0;
  const emit = (event: import("../../../src/app-server.js").AppServerEvent) =>
    act(async () => {
      notify?.("zen/thread/event", {
        threadId: "thread-1",
        processEpoch: "test-process-epoch",
        watermark: ++watermark,
        event,
      });
    });
  try {
    const composer = await selectedComposer();
    await act(async () => requests[0]!.resolve(usageProjection(1)));
    assert.match(contextUsageLabel(), /1 \/ 100 tokens/);
    await setTextareaValue(composer, "Ordinary message");
    await dispatchComposerKey(composer, { key: "Enter" });
    await waitFor(() => clientId);
    await act(async () => admission.resolve({ turnId: "ordinary-turn" }));
    const common = {
      threadId: "thread-1",
      turnId: "ordinary-turn",
      createdAt: "2026-11-02T00:00:01Z",
    };
    const items: import("../../../src/item.js").CanonicalItem[] = [
      {
        ...common,
        id: "ordinary-start",
        type: "turn_started",
        selection: {
          providerProfileId: "fake",
          modelId: "fake",
          reasoningEffort: "medium",
        },
      },
      {
        ...common,
        id: "ordinary-user",
        type: "user_message",
        clientId,
        content: [{ type: "text", text: "Ordinary message" }],
      },
      {
        ...common,
        id: "ordinary-usage",
        type: "model_usage",
        modelResponseId: "ordinary-response",
        inputTokens: 12,
        outputTokens: 3,
      },
      {
        ...common,
        id: "ordinary-answer",
        type: "agent_message",
        text: "Ordinary answer",
      },
      {
        ...common,
        id: "ordinary-end",
        type: "turn_completed",
        status: "completed",
      },
    ];
    await emit({ type: "item_completed", item: items[0]! });
    await emit({
      type: "turn_started",
      threadId: "thread-1",
      turnId: "ordinary-turn",
    });
    for (const [role, text, sequence] of [
      ["user", "Ordinary message", 161],
      ["assistant", "Ordinary answer", 162],
    ] as const) {
      await emit({
        type: "context_item_completed",
        threadId: "thread-1",
        item: {
          ...common,
          id: `semantic-${role}`,
          kind: "message",
          role,
          source: {
            kind: role === "user" ? "user_message" : "agent_message",
            sequence,
          },
          content: { text, parts: [{ type: "text", text }] },
        },
      });
    }
    for (const item of items.slice(1))
      await emit({ type: "item_completed", item });
    await emit({
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "ordinary-turn",
      status: "completed",
    });
    assert.match(
      document.querySelector(".agent-surface")!.textContent!,
      /Ordinary message/,
    );
    assert.match(
      document.querySelector(".agent-surface")!.textContent!,
      /Ordinary answer/,
    );
    assert.equal(
      requests.length,
      2,
      "six completion notifications share one in-flight read after the initial resume read",
    );
    await act(async () => requests[1]!.resolve(usageProjection(4)));
    assert.equal(
      requests.length,
      3,
      "one dirty follow-up reads after all six notifications",
    );
    assert.match(
      contextUsageLabel(),
      /1 \/ 100 tokens/,
      "superseded read cannot publish",
    );
    await act(async () => requests[2]!.resolve(usageProjection(12)));
    assert.match(contextUsageLabel(), /12 \/ 100 tokens/);
    t.diagnostic(
      JSON.stringify({
        historicalTurns: 40,
        completionNotifications: 6,
        completionUsageReads: requests.length - 1,
      }),
    );

    // More events while the follow-up itself is pending must drain again, not
    // freeze at an arbitrary two-read budget or run concurrent context builds.
    await emit({
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "ordinary-turn",
      status: "completed",
    });
    await emit({
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "ordinary-turn",
      status: "completed",
    });
    await act(async () => requests[3]!.resolve(usageProjection(13)));
    await emit({
      type: "turn_completed",
      threadId: "thread-1",
      turnId: "ordinary-turn",
      status: "completed",
    });
    assert.equal(requests.length, 5);
    await act(async () => requests[4]!.resolve(usageProjection(14)));
    assert.equal(requests.length, 6);
    assert.match(contextUsageLabel(), /12 \/ 100 tokens/);
    await act(async () => requests[5]!.resolve(usageProjection(15)));
    assert.match(contextUsageLabel(), /15 \/ 100 tokens/);
  } finally {
    await unmountApp(harness);
  }
});

async function mountUsageApp(options: Parameters<typeof mountApp>[1] = {}) {
  const requests: Array<{
    threadId: string;
    response: ReturnType<typeof deferred<ModelUsageProjection>>;
  }> = [];
  const methods: string[] = [];
  let notify:
    Parameters<Window["zenx"]["protocol"]["onNotification"]>[0] | undefined;
  let status: ((value: AppServerHostStatus) => void) | undefined;
  const harness = await mountThreadApp({
    threads: async (archived) =>
      archived
        ? []
        : [summary(false), summary(false, "thread-2", "Thread two")],
    modelUsage: (threadId) => {
      const response = deferred<ModelUsageProjection>();
      requests.push({ threadId, response });
      return response.promise;
    },
    request: async (method, params) => {
      methods.push(method);
      if (method === "zen/thread/resume")
        return resumed({
          ...liveThread(),
          id: (params as { threadId: string }).threadId,
        });
      if (method === "thread/archive") return {};
      throw new Error(method);
    },
    onNotification: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    onStatus: (listener) => {
      status = listener;
      return () => {
        status = undefined;
      };
    },
    ...options,
  });
  const select = async (name = "Thread one") => {
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-row"),
    ].find((button) => button.textContent?.includes(name));
    assert.ok(row, `Expected ${name} row`);
    await act(async () => row.click());
  };
  const complete = async (threadId = "thread-1") =>
    act(async () =>
      notify?.("turn/completed", {
        threadId,
        turn: {
          id: "completed-turn",
          status: "completed",
          items: [],
          itemsView: "full",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      }),
    );
  return {
    harness,
    requests,
    methods,
    select,
    complete,
    status: async (value: AppServerHostStatus) =>
      act(async () => status?.(value)),
    notify: async <
      M extends
        import("../src/protocol-client/index.js").ServerNotificationMethod,
    >(
      method: M,
      params: import("../src/protocol-client/index.js").ServerNotificationParams[M],
    ) => act(async () => notify?.(method, params)),
    resolve: async (index: number, tokens: number | null) =>
      act(async () =>
        requests[index]!.response.resolve(usageProjection(tokens)),
      ),
  };
}

test("App usage keeps different Threads independent and drains only the latest returning owner", async () => {
  const app = await mountUsageApp();
  try {
    await app.select();
    await app.complete();
    await app.complete();
    await app.select("Thread two");
    assert.deepEqual(
      app.requests.map((request) => request.threadId),
      ["thread-1", "thread-2"],
    );
    await app.resolve(1, 2);
    await app.resolve(0, 99);
    assert.equal(
      app.requests.length,
      2,
      "leaving drops dirty demand rather than reading an unobserved Thread",
    );
    assert.match(contextUsageLabel(), /2 \/ 100 tokens/);

    await app.select();
    await app.complete();
    await app.select("Thread two");
    await app.select();
    assert.equal(
      app.requests.length,
      4,
      "returning owner shares the old in-flight slot, not its stale result",
    );
    await app.resolve(2, 98);
    assert.equal(app.requests.length, 5);
    assert.ok(!contextUsageLabel().includes("98 / 100 tokens"));
    await app.resolve(4, 9);
    await app.resolve(3, 97);
    assert.match(contextUsageLabel(), /9 \/ 100 tokens/);
    assert.equal(app.requests.length, 5);
  } finally {
    await unmountApp(app.harness);
  }
});

test("App usage retires disconnected reads without letting old callbacks remove the reconnect owner", async () => {
  const app = await mountUsageApp();
  try {
    await app.select();
    await app.complete();
    await app.status({ type: "reconnecting", attempt: 1, delayMs: 0 });
    await app.complete();
    assert.equal(app.requests.length, 1);
    await app.status({ type: "ready", reconnected: true });
    assert.equal(
      app.requests.length,
      2,
      "new connection does not wait for an old unresolved IPC",
    );
    await app.complete();
    await app.resolve(0, 99);
    assert.equal(
      app.requests.length,
      2,
      "old finally neither drains nor removes the new owner",
    );
    assert.ok(!contextUsageLabel().includes("99 / 100 tokens"));
    await app.resolve(1, 8);
    assert.equal(app.requests.length, 3);
    await app.resolve(2, 12);
    assert.match(contextUsageLabel(), /12 \/ 100 tokens/);
  } finally {
    await unmountApp(app.harness);
  }
});

test("App usage fences a late ready snapshot after a disconnect notification", async () => {
  const initialStatus = deferred<AppServerHostStatus>();
  const app = await mountUsageApp({ getStatus: () => initialStatus.promise });
  try {
    await app.status({ type: "ready", reconnected: false });
    await app.select();
    await app.status({ type: "reconnecting", attempt: 1, delayMs: 0 });
    await act(async () =>
      initialStatus.resolve({ type: "ready", reconnected: false }),
    );
    await app.complete();
    await app.resolve(0, 99);
    assert.equal(app.requests.length, 1);
    assert.ok(!contextUsageLabel().includes("99 / 100 tokens"));
    await app.status({ type: "ready", reconnected: true });
    await app.resolve(1, 9);
    assert.match(contextUsageLabel(), /9 \/ 100 tokens/);
  } finally {
    await unmountApp(app.harness);
  }
});

test("App usage preserves errors and unknown values without automatic retry or mutation", async () => {
  const app = await mountUsageApp();
  try {
    await app.select();
    await app.resolve(0, 12);
    await app.complete();
    await act(async () =>
      app.requests[1]!.response.reject(new Error("usage unavailable")),
    );
    assert.equal(app.requests.length, 2, "clean failure is not retried");
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /usage unavailable/,
    );
    assert.match(
      contextUsageLabel(),
      /12 \/ 100 tokens/,
      "failure does not replace the last real value with zero",
    );
    await app.complete();
    await app.complete();
    await act(async () =>
      app.requests[2]!.response.reject(new Error("superseded failure")),
    );
    assert.equal(
      app.requests.length,
      4,
      "a real dirty invalidation still drains after failure",
    );
    assert.doesNotMatch(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /superseded failure/,
    );
    await app.resolve(3, null);
    assert.equal(
      contextUsageLabel(),
      "",
      "unknown context retains the existing unavailable indicator, never a fabricated zero",
    );
    assert.doesNotMatch(contextUsageLabel(), /0%/);
    assert.deepEqual(
      app.methods,
      ["zen/thread/resume", "zen/thread/questions/list"],
      "usage refresh never retries model, tool, or send mutations",
    );
  } finally {
    await unmountApp(app.harness);
  }
});

for (const retirement of ["new-thread", "archive", "unmount"] as const) {
  test(`App usage does not drain dirty reads after ${retirement}`, async () => {
    const app = await mountUsageApp();
    let mounted = true;
    try {
      await app.select();
      await app.complete();
      if (retirement === "unmount") {
        await act(async () => app.harness.root.unmount());
        mounted = false;
      } else if (retirement === "new-thread") {
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(".new-thread-action")!
            .click(),
        );
      } else {
        await act(async () => threadMenuButton("Thread one").click());
        const archive = await waitFor(() => exactButton("Archive"));
        await act(async () => archive.click());
        assert.ok(
          document.querySelector(".thread-view") === null,
          "archive leaves the old Thread owner",
        );
      }
      await app.resolve(0, 99);
      assert.equal(
        app.requests.length,
        1,
        "retired demand cannot launch a follow-up",
      );
      assert.ok(!contextUsageLabel().includes("99 / 100 tokens"));
    } finally {
      if (mounted) await unmountApp(app.harness);
      else {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: undefined });
        app.harness.dom.window.close();
      }
    }
  });
}

test("App usage coalesces model setting and catalog invalidations into the latest read", async () => {
  const app = await mountUsageApp();
  try {
    await app.select();
    await app.resolve(0, 1);
    await app.complete();
    await app.notify("zen/thread/event", {
      threadId: "thread-1",
      processEpoch: "test-process-epoch",
      watermark: 1,
      event: {
        type: "thread_settings_updated",
        threadId: "thread-1",
        settings: { ...resumed(liveThread()).thread, modelId: "gpt-5.6-luna" },
      },
    });
    assert.equal(app.requests.length, 2);
    await app.resolve(1, 99);
    assert.equal(app.requests.length, 3);
    assert.match(contextUsageLabel(), /1 \/ 100 tokens/);
    await app.resolve(2, 9);
    assert.match(contextUsageLabel(), /9 \/ 100 tokens/);
    await app.notify("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        collaborationMode: {
          mode: "default",
          settings: { model: "fake", reasoning_effort: "medium" },
        },
        cwd: "/work/zen",
        effort: "medium",
        model: "fake",
        modelProvider: "fake",
        personality: null,
        sandboxPolicy: { type: "dangerFullAccess" },
        serviceTier: null,
        summary: null,
      },
    });
    assert.equal(
      app.requests.length,
      4,
      "legacy settings publication also refreshes current usage",
    );
    await app.notify("model/catalog/updated", {
      processEpoch: "test-process-epoch",
      revision: 3,
    });
    assert.equal(app.requests.length, 4);
    await app.resolve(3, 99);
    assert.equal(
      app.requests.length,
      5,
      "catalog invalidation drains with current Host settings",
    );
    assert.match(contextUsageLabel(), /9 \/ 100 tokens/);
    await app.resolve(4, null);
    assert.equal(
      contextUsageLabel(),
      "",
      "unknown context retains the existing unavailable indicator, never a fabricated zero",
    );
  } finally {
    await unmountApp(app.harness);
  }
});

async function mountInitialUsageApp(options: Parameters<typeof mountApp>[1]) {
  const { pluginUiRegistry } =
    await import("../src/renderer/src/PluginProductPage.js");
  const pluginId = "usage-navigation-fixture";
  const route = `/plugins/${pluginId}/home`;
  const dispose = pluginUiRegistry.registerTrusted(pluginId, {
    overview: ({ sdk }) =>
      createElement(
        "button",
        {
          onClick: () => sdk.navigation.navigate("/threads/thread-1"),
        },
        "Open existing Thread",
      ),
  });
  const snapshot: import("../src/main/capabilities/types.js").ZenXPluginSnapshot =
    {
      plugins: [
        {
          id: pluginId,
          displayName: "Usage navigation",
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
          key: `${pluginId}:home`,
          pluginId,
          id: "home",
          title: "Usage navigation",
          route,
          surfaceId: "overview",
        },
      ],
      sidebar: [
        {
          key: `${pluginId}:home`,
          pluginId,
          id: "home",
          label: "Usage navigation",
          icon: "plug",
          pageId: "home",
        },
      ],
      bundles: [
        {
          key: `${pluginId}:main`,
          pluginId,
          id: "main",
          apiVersion: 1,
          kind: "trusted",
          entry: pluginId,
        },
      ],
      surfaces: [
        {
          key: `${pluginId}:overview`,
          pluginId,
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
    };
  let recovered = 0;
  const app = await mountUsageApp({
    ...options,
    markWorkspaceUsed: async () => {
      recovered++;
      return publicSettings([]);
    },
    plugins: { get: async () => snapshot },
  });
  return {
    ...app,
    recovered: () => recovered,
    open: async () => {
      // Production plugin pages remain usable while the initial status IPC is
      // pending. Their real SDK navigation enters App's normal native resume.
      const page = await waitFor(() => exactButton("Usage navigation"));
      await act(async () => page.click());
      const open = await waitFor(() => exactButton("Open existing Thread"));
      await act(async () => open.click());
    },
    unmount: async () => {
      await unmountApp(app.harness);
      dispose();
    },
  };
}

for (const readySource of ["snapshot", "notification"] as const) {
  test(`App usage first ready ${readySource} reads an already recovered Thread without another resume`, async () => {
    const initialStatus = deferred<AppServerHostStatus>();
    const app = await mountInitialUsageApp({
      getStatus: () => initialStatus.promise,
    });
    try {
      await app.open();
      assert.equal(
        app.recovered(),
        1,
        "native resume completed before readiness publication",
      );
      assert.deepEqual(app.methods, [
        "zen/thread/resume",
        "zen/thread/questions/list",
      ]);
      assert.equal(
        app.requests.length,
        0,
        "usage waits for observed readiness",
      );
      if (readySource === "snapshot")
        await act(async () =>
          initialStatus.resolve({ type: "ready", reconnected: false }),
        );
      else await app.status({ type: "ready", reconnected: false });
      assert.ok(document.querySelector(".thread-view") !== null);
      assert.equal(
        app.requests.length,
        1,
        "first ready must not lose completed-resume usage demand",
      );
      await app.resolve(0, 9);
      assert.match(contextUsageLabel(), /9 \/ 100 tokens/);
      assert.deepEqual(
        app.methods,
        ["zen/thread/resume", "zen/thread/questions/list"],
        "readiness does not repeat native hydration",
      );
    } finally {
      await app.unmount();
    }
  });

  test(`App usage first ready ${readySource} does not read before cold resume completes`, async () => {
    const initialStatus = deferred<AppServerHostStatus>();
    const recovery = deferred<ReturnType<typeof resumed>>();
    let resumeCalls = 0;
    const app = await mountInitialUsageApp({
      getStatus: () => initialStatus.promise,
      request: async (method) => {
        assert.equal(method, "zen/thread/resume");
        resumeCalls++;
        return recovery.promise;
      },
    });
    try {
      await app.open();
      if (readySource === "snapshot")
        await act(async () =>
          initialStatus.resolve({ type: "ready", reconnected: false }),
        );
      else await app.status({ type: "ready", reconnected: false });
      assert.equal(
        app.requests.length,
        0,
        "first ready must not create pre-recovery usage hydration",
      );
      await act(async () => recovery.resolve(resumed(liveThread())));
      assert.equal(app.requests.length, 1);
      assert.equal(resumeCalls, 1);
      await app.resolve(0, 9);
      assert.match(contextUsageLabel(), /9 \/ 100 tokens/);
    } finally {
      await app.unmount();
    }
  });
}

for (const burst of [false, true]) {
  test(`real App native text deltas reuse canonical ordering and historical metadata (${burst ? "batched" : "separate"})`, async (t) => {
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
        if (method === "zen/thread/resume")
          return resumed(derivedScanHistory(true));
        throw new Error(method);
      },
    });
    let observing = false;
    let canonicalVisits = 0,
      historicalItemVisits = 0;
    const forEach = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "forEach",
    )!;
    const iterator = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    )!;
    // Observe actual immutable arrays created by App recovery. No production
    // instrumentation or hand-rendered ThreadView substitutes for its cache.
    Object.defineProperty(Array.prototype, "forEach", {
      ...forEach,
      value: function (
        this: unknown[],
        callback: (...args: unknown[]) => unknown,
        thisArg?: unknown,
      ) {
        const canonical =
          observing &&
          (this[0] as { id?: string } | undefined)?.id === "thread-1-metadata";
        return Reflect.apply(forEach.value, this, [
          canonical
            ? (...args: unknown[]) => {
                canonicalVisits++;
                return callback.apply(thisArg, args);
              }
            : callback,
          thisArg,
        ]);
      },
    });
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      ...iterator,
      value: function (this: unknown[]) {
        const source = Reflect.apply(
          iterator.value,
          this,
          [],
        ) as IterableIterator<unknown>;
        if (
          !observing ||
          !(this[0] as { id?: string } | undefined)?.id?.startsWith(
            "derived-user-",
          )
        )
          return source;
        return {
          next() {
            const value = source.next();
            if (!value.done) historicalItemVisits++;
            return value;
          },
          [Symbol.iterator]() {
            return this;
          },
        };
      },
    });
    let watermark = 0;
    const emit = (event: import("../../../src/app-server.js").AppServerEvent) =>
      notify?.("zen/thread/event", {
        threadId: "thread-1",
        processEpoch: "test-process-epoch",
        watermark: ++watermark,
        event,
      });
    try {
      await selectedComposer();
      await act(async () =>
        emit({
          type: "item_started",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "incremental-answer",
          itemType: "agent_message",
        }),
      );
      const originalRows = [...document.querySelectorAll("section.turn")].slice(
        0,
        40,
      );
      const delta = (index: number) =>
        emit({
          type: "item_delta",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "incremental-answer",
          delta: `incremental-${index} `,
        });
      observing = true;
      if (burst)
        await act(async () => {
          for (let index = 0; index < 15; index++) delta(index);
        });
      else
        for (let index = 0; index < 15; index++)
          await act(async () => delta(index));
      observing = false;
      assert.match(
        document.querySelector(".agent-surface")!.textContent!,
        /incremental-14/u,
      );
      assert.deepEqual(
        [...document.querySelectorAll("section.turn")].slice(0, 40),
        originalRows,
      );
      t.diagnostic(
        JSON.stringify({
          burst,
          deltas: 15,
          canonicalVisits,
          historicalItemVisits,
        }),
      );
      assert.deepEqual(
        { canonicalVisits, historicalItemVisits },
        { canonicalVisits: 0, historicalItemVisits: 0 },
      );
      observing = true;
      await act(async () =>
        emit({
          type: "item_completed",
          item: {
            type: "agent_message",
            id: "incremental-backfill",
            threadId: "thread-1",
            turnId: "derived-history-0",
            createdAt: "2026-11-02T00:02:00.000Z",
            text: "Late canonical answer remains current",
          },
        }),
      );
      observing = false;
      assert.ok(canonicalVisits > 0, "a real canonical append rebuilds order");
      assert.ok(
        historicalItemVisits > 0,
        "new canonical metadata rechecks membership",
      );
      const backfilled = document.querySelector(
        '[data-quote-item-id="incremental-backfill"]',
      );
      assert.match(backfilled?.textContent ?? "", /Late canonical answer/u);
      assert.equal(
        [...document.querySelectorAll("section.turn")]
          .at(-1)
          ?.contains(backfilled),
        true,
        "canonical backfill preserves existing transcript ordering semantics",
      );
    } finally {
      observing = false;
      Object.defineProperty(Array.prototype, "forEach", forEach);
      Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
      await unmountApp(harness);
    }
  });
}

test("real Host questions render in full App information panel with independent drafts and explicit native answer/cancel", async () => {
  const { questionNativeFixture } =
    await import("./user-question-native-fixture.js");
  const f = await questionNativeFixture();
  const sidebar = new ThreadSidebarStore(
    join(f.directory, "information-layout"),
  );
  const information = new NativeInformationService({
    sidebar,
    rooms: () => [],
    assertThreadExists: async (id) => {
      await f.host.readThread(id);
    },
  });
  const documentAdmission = () => {};
  let harness: AppHarness | undefined;
  let statusListener: ((status: AppServerHostStatus) => void) | undefined;
  try {
    const thread = await f.host.startThread();
    const first = await f.publish(thread.id);
    const second = await f.publish(thread.id, {
      questions: [{ id: "next", prompt: "Any additional constraint?" }],
      answerTemplate: "Constraint: {{next}}",
    });
    let completedWrites = 0;
    const writes: import("../../../src/protocol/native/wire.js").NativeQuestionRespondParams[] =
      [];
    harness = await mountApp(
      {
        projects: [
          {
            key: f.directory,
            workspace: f.directory,
            configured: true,
            isDefault: true,
            threadIds: [thread.id],
          },
        ],
        unavailableThreadIds: [],
        lastUsedWorkspace: f.directory,
      },
      {
        information: {
          read: (owner) => information.read(owner, documentAdmission),
          update: (request) => information.update(request, documentAdmission),
        },
        threadSidebar: {
          read: (owner) => information.readSidebar(owner, documentAdmission),
          update: (request) =>
            information.updateSidebar(request, documentAdmission),
          onChanged: (listener) => sidebar.onChanged(listener),
        },
        onStatus: (listener) => {
          statusListener = listener;
          return () => {
            statusListener = undefined;
          };
        },
        threads: (archived) => f.host.listThreadSummaries({ archived }),
        request: async (method, params) => {
          if (method === "zen/thread/questions/respond")
            writes.push(params as (typeof writes)[number]);
          const result = await f.request(method, params);
          if (method === "zen/thread/questions/respond") completedWrites++;
          return result;
        },
        plugins: {
          get: async () => ({
            ...workspaceLauncherSnapshot,
            plugins: [],
            panels: [],
            information: [],
            commands: [],
          }),
        },
        onNotification: (listener) =>
          f.onNotification((method, params) =>
            listener(method as never, params as never),
          ),
      },
    );
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Ordinary composer draft stays here");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".information-toolbar button")!
        .click(),
    );
    const firstCard = await waitFor(() =>
      document.querySelector<HTMLElement>(
        `[data-question-call-id="${first.request.callItemId}"]`,
      ),
    );
    const secondCard = await waitFor(() =>
      document.querySelector<HTMLElement>(
        `[data-question-call-id="${second.request.callItemId}"]`,
      ),
    );
    await invokeButtonClick(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Customize information"]',
      )!,
    );
    await waitFor(
      () =>
        document.querySelectorAll('.information-widget[data-visible="true"]')
          .length === 6,
    );
    for (let index = 0; index < 6; index++) {
      await invokeButtonClick(
        document.querySelector<HTMLButtonElement>(
          '.information-widget[data-visible="true"] .information-widget-actions button:nth-child(3)',
        )!,
      );
      await waitFor(
        () =>
          document.querySelectorAll('.information-widget[data-visible="true"]')
            .length ===
          5 - index,
      );
    }
    await invokeButtonClick(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Customize information"]',
      )!,
    );
    assert.equal(
      document.querySelectorAll(".information-widget-body").length,
      0,
    );
    assert.equal(
      document.querySelectorAll(".user-question-card").length,
      2,
      "real Host question cards remain outside every hidden native widget",
    );
    assert.ok(
      (
        await sidebar.read({ kind: "thread", id: thread.id })
      ).informationLayout!.widgets.every((widget) => !widget.visible),
    );
    assert.equal(firstCard.querySelectorAll("input:checked").length, 0);
    const answerButton =
      firstCard.querySelector<HTMLButtonElement>(".primary-button")!;
    assert.equal(answerButton.disabled, true);
    await act(async () =>
      firstCard.querySelector<HTMLInputElement>('input[type="radio"]')!.click(),
    );
    const freeText = firstCard.querySelector<HTMLTextAreaElement>("textarea")!;
    await setTextareaValue(freeText, "Also preserve keyboard focus");
    await act(async () => freeText.focus());
    let additional!: import("../../../src/user-question-state.js").UserQuestionState;
    await act(async () => {
      additional = await f.publish(thread.id);
    });
    await waitFor(() =>
      document.querySelector(
        `[data-question-call-id="${additional.request.callItemId}"]`,
      ),
    );
    assert.ok(
      document.activeElement === freeText,
      "a new accepted question never steals existing input focus",
    );

    await setTextareaValue(
      secondCard.querySelector<HTMLTextAreaElement>("textarea")!,
      "Independent second draft",
    );
    assert.equal(composer.value, "Ordinary composer draft stays here");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".information-toolbar button")!
        .click(),
    );
    assert.equal(writes.length, 0, "hiding is not cancellation");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".information-toolbar button")!
        .click(),
    );
    const reopened = await waitFor(() =>
      document.querySelector<HTMLElement>(
        `[data-question-call-id="${first.request.callItemId}"]`,
      ),
    );
    assert.equal(
      reopened.querySelector<HTMLTextAreaElement>("textarea")!.value,
      "Also preserve keyboard focus",
    );
    assert.equal(
      document
        .querySelector<HTMLElement>(
          `[data-question-call-id="${second.request.callItemId}"]`,
        )!
        .querySelector<HTMLTextAreaElement>("textarea")!.value,
      "Independent second draft",
    );
    const retainedSend = reactProps<{ onClick(): void }>(
      reopened.querySelector(".primary-button")!,
    ).onClick;
    const retainedCancel = reactProps<{ onClick(): void }>(
      reopened.querySelector(".user-question-actions button")!,
    ).onClick;
    const retainedEdit = reactProps<{
      onChange(event: { target: { value: string } }): void;
    }>(reopened.querySelector("textarea")!).onChange;
    const invokeRetained = async () => {
      await act(async () => {
        retainedEdit({ target: { value: "stale owner edit" } });
        retainedSend();
        retainedCancel();
      });
      assert.equal(writes.length, 0);
      assert.equal(
        reopened.querySelector<HTMLTextAreaElement>("textarea")!.value,
        "Also preserve keyboard focus",
      );
    };
    await act(async () =>
      statusListener?.({ type: "error", message: "synthetic disconnection" }),
    );
    await invokeRetained();
    await act(async () =>
      statusListener?.({ type: "ready", reconnected: true }),
    );
    await waitFor(
      () =>
        !reopened.querySelector<HTMLButtonElement>(".primary-button")!.disabled,
    );
    await act(async () => {
      await f.host.setThreadArchived(thread.id, true);
    });
    await waitFor(
      () =>
        reopened.querySelector<HTMLButtonElement>(".primary-button")!.disabled,
    );
    await invokeRetained();
    await act(async () => {
      await f.host.setThreadArchived(thread.id, false);
    });
    await waitFor(
      () =>
        !reopened.querySelector<HTMLButtonElement>(".primary-button")!.disabled,
    );
    await invokeButtonClick(
      reopened.querySelector<HTMLButtonElement>(".primary-button")!,
      2,
    );
    await waitFor(() => completedWrites === 1);
    const sent = await f.host.readUserQuestion(
      thread.id,
      first.request.callItemId,
      writes[0]!.clientUserMessageId,
    );
    assert.ok(
      sent.response.status === "claimed" || sent.response.status === "pending",
    );
    assert.equal(sent.response.reply?.outcome, "answer");
    if (sent.response.reply?.outcome === "answer")
      assert.deepEqual(sent.response.reply.answers, [
        {
          questionId: "scope",
          optionIds: ["small"],
          text: "Also preserve keyboard focus",
        },
      ]);
    const currentSecond = await waitFor(() =>
      document.querySelector<HTMLElement>(
        `[data-question-call-id="${second.request.callItemId}"]`,
      ),
    );
    const cancel = [
      ...currentSecond.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Cancel request")!;
    await invokeButtonClick(cancel, 2);
    await waitFor(() => completedWrites === 2);
    assert.equal(writes[1]!.outcome, "cancel");
    assert.equal("answers" in writes[1]!, false);
    assert.equal(composer.value, "Ordinary composer draft stays here");
    const snapshot = await f.host.readThread(thread.id);
    const bound = snapshot.items.filter(
      (item) =>
        (item.type === "user_message" || item.type === "user_message_queued") &&
        item.questionReply !== undefined,
    );
    assert.equal(
      bound.length,
      2,
      "only two explicit human response intents were admitted",
    );
  } finally {
    if (harness) await unmountApp(harness);
    await sidebar.close();
    await f.close();
  }
});

for (const outcome of [
  "restored",
  "newer-question-draft",
  "navigation",
  "disconnect",
  "archive",
] as const) {
  test(`real Host full App atomic mixed recall returns to original inputs: ${outcome}`, async () => {
    const { questionNativeFixture } =
      await import("./user-question-native-fixture.js");
    const { ToolEnvironment } = await import("../../../src/tool.js");
    const entered = deferred<void>(),
      release = deferred<void>();
    const environment = new ToolEnvironment({
      runtimes: [
        {
          name: "synthetic_hold",
          enforcesSandbox: true,
          specification: {
            name: "synthetic_hold",
            description: "Hold synthetic test work",
            inputSchema: { type: "object", properties: {} },
          },
          execute: async () => {
            entered.resolve();
            await release.promise;
            return { exitCode: 0, output: "Synthetic hold released" };
          },
        },
      ],
    });
    const f = await questionNativeFixture(environment);
    let harness: AppHarness | undefined;
    let held: import("../../../src/app-server.js").TurnHandle | undefined;
    let statusListener: ((status: AppServerHostStatus) => void) | undefined;
    const readGate = deferred<void>();
    try {
      const thread = await f.host.startThread();
      const question = await f.publish(thread.id);
      held = await f.host.startTurn(thread.id, "!tool synthetic_hold {}");
      await entered.promise;
      let answers = 0,
        sends = 0,
        recalls = 0,
        restoreReads = 0;
      let deferRestoreRead = false;
      let originalClient = "";
      harness = await mountApp(
        {
          projects: [
            {
              key: f.directory,
              workspace: f.directory,
              configured: true,
              isDefault: true,
              threadIds: [thread.id],
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: f.directory,
        },
        {
          composerSendMode: "soft",
          onStatus: (listener) => {
            statusListener = listener;
            return () => {
              statusListener = undefined;
            };
          },
          threads: (archived) => f.host.listThreadSummaries({ archived }),
          plugins: {
            get: async () => ({
              ...workspaceLauncherSnapshot,
              plugins: [],
              panels: [],
              information: [],
              commands: [],
            }),
          },
          onNotification: (listener) =>
            f.onNotification((method, params) =>
              listener(method as never, params as never),
            ),
          request: async (method, params) => {
            const result = await f.request(method, params);
            if (method === "zen/thread/questions/respond") {
              answers++;
              originalClient = (params as { clientUserMessageId: string })
                .clientUserMessageId;
            }
            if (method === "zen/turn/send") sends++;
            if (method === "zen/thread/steer/recall") recalls++;
            if (method === "zen/thread/questions/read" && deferRestoreRead) {
              restoreReads++;
              await readGate.promise;
            }
            return result;
          },
        },
      );
      const composer = await selectedComposer();
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(".information-toolbar button")!
          .click(),
      );
      const card = () =>
        document.querySelector<HTMLElement>(
          `[data-question-call-id="${question.request.callItemId}"]`,
        )!;
      await waitFor(card);
      await act(async () =>
        card().querySelector<HTMLInputElement>('input[type="radio"]')!.click(),
      );
      await setTextareaValue(
        card().querySelector<HTMLTextAreaElement>("textarea")!,
        "Original question free text",
      );
      await invokeButtonClick(
        card().querySelector<HTMLButtonElement>(".primary-button")!,
      );
      await waitFor(() => answers === 1);
      await setTextareaValue(composer, "Original ordinary message");
      await invokePrimarySubmit(
        document.querySelector<HTMLButtonElement>(
          ".composer-send-control > button.action-orb",
        )!,
      );
      await waitFor(() => sends === 1);
      await setTextareaValue(composer, "New ordinary draft");
      const { pendingSteerMessages } =
        await import("../../../src/steer-recall.js");
      assert.equal(
        pendingSteerMessages((await f.host.readThread(thread.id)).items).length,
        2,
      );
      deferRestoreRead = outcome !== "restored";
      const recall = await waitFor(() =>
        document.querySelector<HTMLButtonElement>(
          ".pending-steer-heading .queue-header-action",
        ),
      );
      await invokeButtonClick(recall, 2);
      await waitFor(() => recalls === 1);
      if (outcome === "disconnect" || outcome === "archive") {
        await waitFor(() => restoreReads > 0);
        if (outcome === "disconnect") {
          await act(async () =>
            statusListener?.({
              type: "error",
              message: "Synthetic disconnect during origin preflight",
            }),
          );
        } else {
          await act(async () => {
            release.resolve();
            await held!.done;
            await f.host.setThreadArchived(thread.id, true);
          });
          await waitFor(
            () =>
              card()?.querySelector<HTMLButtonElement>(".primary-button")
                ?.disabled,
          );
        }
        await act(async () => readGate.resolve());
        if (outcome === "disconnect")
          await act(async () =>
            statusListener?.({ type: "ready", reconnected: true }),
          );
        await waitFor(() =>
          document.body.textContent?.includes(
            "Recoverable recalled batches: 1",
          ),
        );
        assert.equal(
          composer.value,
          "New ordinary draft",
          "unwritable owner leaves the whole batch unapplied",
        );
        assert.equal(
          card().querySelector<HTMLTextAreaElement>("textarea")!.value,
          "Original question free text",
        );
      } else if (outcome === "navigation") {
        await waitFor(() => restoreReads > 0);
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(".new-thread-action")!
            .click(),
        );
        const newComposer = await waitFor(() =>
          document.querySelector<HTMLTextAreaElement>("#thread-composer"),
        );
        await setTextareaValue(newComposer, "New navigation draft");
        await act(async () => readGate.resolve());
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        assert.equal(newComposer.value, "New navigation draft");
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              `[data-thread-id="${thread.id}"] .thread-row`,
            )!
            .click(),
        );
        const originalComposer = await waitFor(() => {
          const input =
            document.querySelector<HTMLTextAreaElement>("#thread-composer");
          return input?.value === "New ordinary draft" ? input : null;
        });
        await waitFor(() =>
          document.body.textContent?.includes(
            "Recoverable recalled batches: 1",
          ),
        );
        assert.equal(
          originalComposer.value,
          "New ordinary draft",
          "navigation blocks the whole original restoration",
        );
      } else if (outcome === "newer-question-draft") {
        await waitFor(() => restoreReads > 0);
        // The receipt is confirmed but one question-origin preflight is still pending.
        if (!card())
          await act(async () =>
            document
              .querySelector<HTMLButtonElement>(".information-toolbar button")!
              .click(),
          );
        await waitFor(
          () =>
            card()?.querySelector<HTMLFieldSetElement>("fieldset")?.disabled ===
            false,
        );
        await setTextareaValue(
          card().querySelector<HTMLTextAreaElement>("textarea")!,
          "New question draft must win",
        );
        await act(async () => readGate.resolve());
        await waitFor(() =>
          document.body.textContent?.includes(
            "Recoverable recalled batches: 1",
          ),
        );
        assert.equal(
          composer.value,
          "New ordinary draft",
          "no partial ordinary restoration",
        );
        assert.equal(
          card().querySelector<HTMLTextAreaElement>("textarea")!.value,
          "New question draft must win",
        );
      } else {
        await waitFor(
          () =>
            composer.value ===
            "Original ordinary message\n\nNew ordinary draft",
        );
        if (!card())
          await act(async () =>
            document
              .querySelector<HTMLButtonElement>(".information-toolbar button")!
              .click(),
          );
        await waitFor(card);
        assert.equal(
          card().querySelector<HTMLTextAreaElement>("textarea")!.value,
          "Original question free text",
        );
        assert.equal(card().querySelectorAll("input:checked").length, 1);
        assert.doesNotMatch(
          composer.value,
          /Reply to question|Original question free text/,
        );
      }
      const current = await f.host.readThread(thread.id);
      assert.equal(pendingSteerMessages(current.items).length, 0);
      assert.equal(
        current.items.filter(
          (item) => item.type === "user_message_steer_recalled",
        ).length,
        1,
      );
      assert.equal(
        (
          await f.host.readUserQuestion(
            thread.id,
            question.request.callItemId,
            originalClient,
          )
        ).response.status,
        "withdrawn",
      );
      assert.equal(answers, 1, "restoration never sends an answer");
      assert.equal(sends, 1, "restoration never sends an ordinary message");
      assert.equal(
        recalls,
        1,
        "mixed destinations use one atomic native recall",
      );
    } finally {
      readGate.resolve();
      release.resolve();
      if (harness) await unmountApp(harness);
      await held?.done.catch(() => undefined);
      await f.close();
    }
  });
}

test("real App draft, Send and ACK never measure the closed information trigger", async () => {
  const admission = deferred<unknown>();
  let sends = 0;
  const harness = await mountThreadApp({
    request: async (method) => {
      if (method === "zen/thread/resume") return resumed(derivedScanHistory());
      if (method === "zen/turn/send") {
        sends++;
        return admission.promise;
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  let restore = () => {};
  try {
    const composer = await selectedComposer();
    const trigger = document.querySelector<HTMLButtonElement>(
      ".information-toolbar button",
    )!;
    assert.ok(trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    let reads = 0;
    const measure = trigger.getBoundingClientRect;
    trigger.getBoundingClientRect = function () {
      reads++;
      return measure.call(this);
    };
    restore = () => {
      trigger.getBoundingClientRect = measure;
    };
    await setTextareaValue(composer, "Synthetic immediate input");
    assert.equal(
      reads,
      0,
      "typing must not force information geometry during App render",
    );
    const send = document.querySelector<HTMLButtonElement>(
      ".composer-send-control > button.action-orb.send",
    )!;
    await act(async () => send.focus());
    await act(async () => send.click());
    assert.equal(sends, 1);
    assert.equal(composer.value, "");
    assert.ok(document.querySelector('[data-send-state="sending"]'));
    assert.equal(document.querySelectorAll(".turn").length, 40);
    assert.equal(
      reads,
      0,
      "local pending feedback commits without closed-popover geometry",
    );
    await act(async () => admission.resolve({ turnId: "next-turn" }));
    assert.ok(document.querySelector('[data-send-state="admitted"]'));
    assert.equal(
      reads,
      0,
      "ACK rerenders do not measure the closed trigger either",
    );
  } finally {
    restore();
    admission.resolve({});
    await unmountApp(harness);
  }
});

test("unsubscribed private Thread question edges discover and remove Asking without navigation, coalesce bursts, and unsubscribe", async () => {
  const { questionNativeFixture } =
    await import("./user-question-native-fixture.js");
  const f = await questionNativeFixture();
  const selected = await f.host.startThread();
  const background = await f.host.startThread();
  await f.host.setThreadName(selected.id, "Selected private conversation");
  await f.host.setThreadName(background.id, "Unselected private conversation");
  for (let index = 0; index < 33; index++) await f.publish(selected.id);
  const projects = {
    projects: [
      {
        key: f.directory,
        workspace: f.directory,
        configured: true,
        isDefault: true,
        threadIds: [selected.id, background.id],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: f.directory,
  };
  let summaries = 0,
    projectReads = 0,
    sourceDisposals = 0,
    selectedQuestionReads = 0;
  let listener: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const resumedIds: string[] = [];
  let harness: AppHarness | undefined;
  const backgroundRow = () =>
    [...document.querySelectorAll<HTMLButtonElement>(".thread-row")].find(
      (row) => row.textContent?.includes("Unselected private conversation"),
    );
  try {
    harness = await mountApp(projects, {
      plugins: {
        get: async () => ({
          ...workspaceLauncherSnapshot,
          plugins: [],
          panels: [],
          information: [],
          commands: [],
        }),
      },
      threadQuestionAttention: {
        onChanged(callback) {
          listener = callback;
          const end = f.host.subscribe((event) => {
            if (event.type === "user_question_attention_invalidated")
              callback();
          });
          return () => {
            sourceDisposals++;
            listener = undefined;
            end();
          };
        },
      },
      threads: async (archived) => {
        summaries++;
        await gate;
        return f.host.listThreadSummaries({ archived });
      },
      projectsGet: async () => {
        projectReads++;
        await gate;
        return projects;
      },
      request: async (method, params) => {
        if (method === "zen/thread/resume")
          resumedIds.push((params as { threadId: string }).threadId);
        if (
          method === "zen/thread/questions/list" &&
          (params as { threadId: string }).threadId === selected.id
        )
          selectedQuestionReads++;
        return f.request(method, params);
      },
    });
    const row = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>(".thread-row")].find(
        (value) => value.textContent?.includes("Selected private conversation"),
      ),
    );
    await act(async () => row.click());
    await waitFor(() => document.querySelector("#thread-composer"));
    const informationToggle = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(".information-toolbar button"),
    );
    await act(async () => informationToggle.click());
    assert.ok(backgroundRow());
    assert.equal(backgroundRow()!.querySelector(".thread-asking-badge"), null);
    assert.equal(resumedIds.includes(background.id), false);
    await waitFor(
      () => document.querySelectorAll(".user-question-card").length === 32,
    );
    const more = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        ".user-question-attention > .quiet-button",
      ),
    );
    await act(async () => more.click());
    await waitFor(
      () => document.querySelectorAll(".user-question-card").length === 33,
    );
    const pageTwoCard = [
      ...document.querySelectorAll<HTMLElement>(".user-question-card"),
    ].at(-1)!;
    const pageTwoEditor =
      pageTwoCard.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(pageTwoEditor, "Keep the page-two answer draft");
      pageTwoEditor.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => pageTwoEditor.focus());
    const readsBeforeBackground = selectedQuestionReads;
    const composer =
      document.querySelector<HTMLTextAreaElement>("#thread-composer")!;
    let question!: Awaited<ReturnType<typeof f.publish>>;
    await act(async () => {
      question = await f.publish(background.id);
    });
    await waitFor(() => backgroundRow()?.querySelector(".thread-asking-badge"));
    assert.equal(
      document.activeElement,
      pageTwoEditor,
      "background Asking discovery preserves the page-two answer editor focus",
    );
    assert.equal(document.querySelectorAll(".user-question-card").length, 33);
    assert.equal(pageTwoCard.isConnected, true);
    assert.equal(pageTwoEditor.value, "Keep the page-two answer draft");
    assert.equal(
      selectedQuestionReads,
      readsBeforeBackground,
      "unrelated background question does not reset the selected Thread's pagination",
    );
    assert.equal(
      resumedIds.includes(background.id),
      false,
      "discovery never subscribes or navigates to the background Thread",
    );
    assert.match(
      document.querySelector(".thread-header")?.textContent ??
        document.body.textContent!,
      /Selected private conversation/,
    );
    // Returning to Composer deliberately dismisses the information popover.
    await act(async () => composer.focus());
    await act(async () => {
      const result = await f.host.respondToUserQuestion(background.id, {
        questionCallItemId: question.request.callItemId,
        clientId: "external-background-cancel",
        outcome: "cancel",
      });
      await result.turn.done;
    });
    await waitFor(
      () => backgroundRow()?.querySelector(".thread-asking-badge") === null,
    );
    assert.equal(
      document.activeElement,
      composer,
      "background resolution does not steal Composer focus",
    );
    assert.equal(selectedQuestionReads, readsBeforeBackground);
    const baseline = { summaries, projectReads };
    const held = deferred<void>();
    gate = held.promise;
    await act(async () => {
      for (let i = 0; i < 50; i++) listener?.();
    });
    assert.equal(
      summaries - baseline.summaries,
      2,
      "one active+archived summary pair per in-flight burst",
    );
    assert.equal(projectReads - baseline.projectReads, 1);
    await act(async () => {
      for (let i = 0; i < 50; i++) listener?.();
    });
    assert.equal(summaries - baseline.summaries, 2);
    await act(async () => {
      gate = undefined;
      held.resolve();
    });
    await waitFor(() => summaries - baseline.summaries === 4);
    assert.equal(
      projectReads - baseline.projectReads,
      2,
      "one dirty follow-up, not one read per event",
    );
    const stale = listener!;
    await unmountApp(harness);
    harness = undefined;
    assert.equal(sourceDisposals, 1);
    const stopped = { summaries, projectReads };
    await act(async () => {
      stale();
    });
    assert.deepEqual(
      { summaries, projectReads },
      stopped,
      "retained disposed source callback starts no new reads",
    );
  } finally {
    if (harness) await unmountApp(harness);
    await f.close();
  }
});

for (const mode of ["dock", "popover"] as const) {
  test(`real App ${mode} pending Send keeps historical rows in one stable grid`, async () => {
    const admission = deferred<unknown>();
    const priorResizeObserver = globalThis.ResizeObserver;
    const measurements = new Set<{ target: Element; deliver(): void }>();
    globalThis.ResizeObserver = class {
      constructor(readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        measurements.add({
          target,
          deliver: () => this.callback([], this as unknown as ResizeObserver),
        });
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    let harness: AppHarness | undefined;
    try {
      harness = await mountThreadApp({
        plugins: {
          get: async () => ({
            ...workspaceLauncherSnapshot,
            plugins: [],
            panels: [],
            information: [],
            commands: [],
          }),
        },
        request: async (method) => {
          if (method === "zen/thread/resume")
            return resumed(derivedScanHistory());
          if (method === "zen/turn/send") return admission.promise;
          throw new Error(`Unexpected ${method}`);
        },
      });
      const composer = await selectedComposer();
      const workspace = document.querySelector<HTMLElement>(".workspace")!;
      workspace.getBoundingClientRect = () =>
        ({ top: 44, width: mode === "dock" ? 1600 : 856 }) as DOMRect;
      await act(async () => {
        for (const measurement of measurements) {
          if (measurement.target === workspace) measurement.deliver();
        }
      });
      const information = document.querySelector<HTMLButtonElement>(
        ".information-toolbar button",
      )!;
      await act(async () => information.click());
      assert.equal(
        Boolean(document.querySelector(`.information-${mode}`)),
        true,
        "exercise the measured information layout rather than infer its mode",
      );
      await act(async () => information.click());
      const inner = document.querySelector<HTMLElement>(".messages-inner")!;
      const history = inner.querySelector<HTMLElement>(
        ":scope > .transcript-history",
      );
      assert.equal(
        Boolean(history),
        true,
        "history has one separate grid owner",
      );
      const rows = Array.from(history!.children);
      assert.equal(rows.length, 40);
      assert.equal(
        rows.every((row) => row.matches(".turn")),
        true,
      );
      assert.equal(inner.querySelectorAll(":scope > .turn").length, 0);
      const firstUser = rows[0]!.querySelector(".user-bubble");
      assert.equal(Boolean(firstUser), true);
      await setTextareaValue(composer, "Synthetic isolated pending input");
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            ".composer-send-control > button.action-orb.send",
          )!
          .click(),
      );
      const pending = inner.querySelector<HTMLElement>(
        '[data-send-state="sending"]',
      );
      assert.equal(Boolean(pending), true);
      assert.equal(pending!.parentElement === inner, true);
      assert.equal(composer.value, "");
      assert.equal(
        inner.querySelector(":scope > .transcript-history") === history,
        true,
      );
      assert.equal(
        rows.every((row, index) => history!.children[index] === row),
        true,
      );
      assert.equal(rows[0]!.querySelector(".user-bubble") === firstUser, true);
      await act(async () => admission.resolve({ turnId: "next-turn" }));
      assert.equal(
        Boolean(inner.querySelector('[data-send-state="admitted"]')),
        true,
      );
      assert.equal(
        inner.querySelector(":scope > .transcript-history") === history,
        true,
      );
      assert.equal(
        rows.every((row, index) => history!.children[index] === row),
        true,
      );
    } finally {
      admission.resolve({});
      try {
        if (harness) await unmountApp(harness);
      } finally {
        globalThis.ResizeObserver = priorResizeObserver;
      }
    }
  });
}

test("historical grid inherits the transcript's responsive 24px and narrow 20px gap", async () => {
  const css = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.messages-inner\s*\{[^}]*gap:\s*24px;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.messages-inner\s*\{\s*gap:\s*20px;/,
  );
  const historyRule = css.match(/\.transcript-history\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(historyRule, /gap:\s*inherit;/);
});

for (const initialQuestionCount of [0, 32]) {
  test(`foreground native question reveals the actual hidden App panel once without taking Composer focus (${initialQuestionCount} initial questions)`, async () => {
    const { questionNativeFixture } =
      await import("./user-question-native-fixture.js");
    const f = await questionNativeFixture();
    const selected = await f.host.startThread();
    const background = await f.host.startThread();
    await f.host.setThreadName(selected.id, "Foreground reveal fixture");
    await f.host.setThreadName(background.id, "Background reveal fixture");
    for (let index = 0; index < initialQuestionCount; index++)
      await f.publish(selected.id);
    let reads = 0;
    let harness: AppHarness | undefined;
    try {
      harness = await mountApp(
        {
          projects: [
            {
              key: f.directory,
              workspace: f.directory,
              configured: true,
              isDefault: true,
              threadIds: [selected.id, background.id],
            },
          ],
          unavailableThreadIds: [],
          lastUsedWorkspace: f.directory,
        },
        {
          plugins: {
            get: async () => ({
              ...workspaceLauncherSnapshot,
              plugins: [],
              panels: [],
              information: [],
              commands: [],
            }),
          },
          threads: (archived) => f.host.listThreadSummaries({ archived }),
          request: async (method, params) => {
            const result = await f.request(method, params);
            if (
              method === "zen/thread/questions/list" &&
              (params as { threadId: string }).threadId === selected.id
            )
              reads++;
            return result;
          },
          onNotification: (listener) =>
            f.onNotification((method, params) =>
              listener(method as never, params as never),
            ),
        },
      );
      const row = (title: string) =>
        [...document.querySelectorAll<HTMLButtonElement>(".thread-row")].find(
          (value) => value.textContent?.includes(title),
        );
      await act(async () =>
        (await waitFor(() => row("Foreground reveal fixture"))).click(),
      );
      const composer = await waitFor(() =>
        document.querySelector<HTMLTextAreaElement>("#thread-composer"),
      );
      await waitFor(() => reads > 0);
      const toggle = () =>
        document.querySelector<HTMLButtonElement>(
          ".information-toolbar button",
        )!;
      assert.equal(toggle().getAttribute("aria-expanded"), "false");
      await setTextareaValue(composer, "Keep the unsent foreground draft");
      await act(async () => composer.focus());
      let question!: Awaited<ReturnType<typeof f.publish>>;
      await act(async () => {
        question = await f.publish(selected.id);
      });
      await waitFor(() =>
        document.querySelector(
          `[data-question-call-id="${question.request.callItemId}"]`,
        ),
      );
      assert.equal(toggle().getAttribute("aria-expanded"), "true");
      assert.ok(
        document.activeElement === composer,
        "native question discovery reveals without moving focus",
      );
      assert.equal(composer.value, "Keep the unsent foreground draft");
      const card = document.querySelector(
        `[data-question-call-id="${question.request.callItemId}"]`,
      )!;
      await act(async () =>
        card.querySelector<HTMLLabelElement>(".user-question-option")!.click(),
      );
      assert.equal(
        card.querySelectorAll("input:checked").length,
        1,
        "a full option label selects its native radio without submitting",
      );
      assert.equal(
        card.querySelectorAll(
          '[data-selected="true"] .user-question-option-mark svg',
        ).length,
        1,
      );
      await act(async () => toggle().click());
      await act(async () => row("Background reveal fixture")!.click());
      await waitFor(() => document.querySelector("#thread-composer"));
      await act(async () => {
        await f.publish(selected.id);
      });
      await act(async () => row("Foreground reveal fixture")!.click());
      await waitFor(
        () =>
          document.querySelector<HTMLTextAreaElement>("#thread-composer")
            ?.value === "Keep the unsent foreground draft",
      );
      assert.equal(
        toggle().getAttribute("aria-expanded"),
        "false",
        "old attention cannot reopen an explicitly closed owner on return",
      );
      await act(async () => {
        await f.publish(background.id);
      });
      assert.equal(
        toggle().getAttribute("aria-expanded"),
        "false",
        "background publication cannot reveal foreground information",
      );
      await act(async () => {
        question = await f.publish(selected.id);
      });
      await waitFor(() =>
        document.querySelector(
          `[data-question-call-id="${question.request.callItemId}"]`,
        ),
      );
      assert.equal(
        toggle().getAttribute("aria-expanded"),
        "true",
        "a later new foreground question can reveal again",
      );
    } finally {
      if (harness) await unmountApp(harness);
      await f.close();
    }
  });
}

test("a page shift caused by cancelling old questions must not reveal hidden information", async () => {
  const { questionNativeFixture } =
    await import("./user-question-native-fixture.js");
  const f = await questionNativeFixture();
  const selected = await f.host.startThread();
  const background = await f.host.startThread();
  await f.host.setThreadName(selected.id, "Foreground reveal fixture");
  await f.host.setThreadName(background.id, "Background reveal fixture");
  for (let index = 0; index < 33; index++) await f.publish(selected.id);
  let reads = 0;
  let harness: AppHarness | undefined;
  try {
    harness = await mountApp(
      {
        projects: [
          {
            key: f.directory,
            workspace: f.directory,
            configured: true,
            isDefault: true,
            threadIds: [selected.id, background.id],
          },
        ],
        unavailableThreadIds: [],
        lastUsedWorkspace: f.directory,
      },
      {
        plugins: {
          get: async () => ({
            ...workspaceLauncherSnapshot,
            plugins: [],
            panels: [],
            information: [],
            commands: [],
          }),
        },
        threads: (archived) => f.host.listThreadSummaries({ archived }),
        request: async (method, params) => {
          const result = await f.request(method, params);
          if (
            method === "zen/thread/questions/list" &&
            (params as { threadId: string }).threadId === selected.id
          )
            reads++;
          return result;
        },
        onNotification: (listener) =>
          f.onNotification((method, params) =>
            listener(method as never, params as never),
          ),
      },
    );
    const row = (title: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(".thread-row")].find(
        (value) => value.textContent?.includes(title),
      );
    await act(async () =>
      (await waitFor(() => row("Foreground reveal fixture"))).click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await waitFor(() => reads > 0);
    const toggle = () =>
      document.querySelector<HTMLButtonElement>(".information-toolbar button")!;
    assert.equal(toggle().getAttribute("aria-expanded"), "false");
    await setTextareaValue(composer, "Keep the unsent foreground draft");
    await act(async () => composer.focus());
    const first = (await f.host.listUserQuestions(selected.id)).questions[0]!;
    const readsBefore = reads;
    await act(async () => {
      await f.transport.respond({
        threadId: selected.id,
        questionCallItemId: first.request.callItemId,
        clientUserMessageId: "review-page-shift-cancel",
        outcome: "cancel",
      });
    });
    await waitFor(() => reads > readsBefore);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    assert.equal(
      toggle().getAttribute("aria-expanded"),
      "false",
      "merely advancing an older question from page 2 must not auto-reveal",
    );
  } finally {
    if (harness) await unmountApp(harness);
    await f.close();
  }
});
