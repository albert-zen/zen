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
import { encodeModelKey } from "../../../src/protocol/codex/model-key.js";
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
    started(liveThread(), "/work/zen"),
    "preview",
  );
  assert.equal(value.createdAt, new Date(1_000).toISOString());
  assert.equal(value.updatedAt, new Date(2_000).toISOString());
  assert.equal(value.threadId, "thread-1");
  assert.equal(value.status, "idle");
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
      if (method === "turn/start") {
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

test("New thread sends its selected model and reasoning effort to Project start", async () => {
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
      if (method === "turn/start") return {};
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
        selection: { model: advanced.id, effort: "low" },
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
      if (method === "turn/start") return {};
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
      if (method === "thread/resume") return await resumeResponse.promise;
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
      if (method === "turn/start") {
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
      if (method === "turn/start") {
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
      if (method === "turn/start") {
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
      if (method === "turn/start") {
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
      if (method === "turn/start") return {};
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
        if (method === "thread/resume") return resumed(liveThread());
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

test("New thread without a last-used Project opens an unselected draft menu", async () => {
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
      /What should we build in Choose a Project/u,
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

test("adding a Project from the central switcher preserves the local draft", async () => {
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
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.click(),
    );
    const composer = await waitFor(() =>
      document.querySelector<HTMLTextAreaElement>("#thread-composer"),
    );
    await setTextareaValue(composer, "Keep this draft");
    await act(async () => projectSwitcher()?.click());
    const addProject = await waitFor(() => exactButton("Add project"));
    await act(async () => addProject.click());
    const addFolder = await waitFor(() => exactButton("Add folder"));
    await waitFor(() => addFolder.disabled === false);
    await act(async () => addFolder.click());
    await waitFor(() => projectSwitcher()?.textContent?.trim() === "/");
    assert.equal(composer.value, "Keep this draft");
    assert.equal(addWorkspaceCalls, 1);
    assert.equal(starts, 0);
  } finally {
    await unmountApp(harness);
  }
});

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
        if (method === "turn/start") {
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
        if (method === "turn/start") {
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
      if (method === "turn/start") {
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
    assert.match(newThread.textContent ?? "", /Add project first/u);
    await act(async () => newThread.click());
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
      if (method === "thread/resume") return resumed(liveThread());
      if (method === "turn/start") {
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
  const oldModel = encodeModelKey({
    providerProfileId: "deleted-provider",
    modelId: "old-model",
  });
  const replacement = encodeModelKey({
    providerProfileId: "fake",
    modelId: "gpt-5.6-luna",
  });
  const turnRequests: unknown[] = [];
  const settingsRequests: unknown[] = [];
  const harness = await mountThreadApp({
    models: [wireModel(replacement, true, "Replacement model")],
    request: async (method, params) => {
      if (method === "thread/resume")
        return {
          ...resumed(liveThread()),
          model: oldModel,
          modelProvider: "deleted-provider",
          reasoningEffort: "medium",
        };
      if (method === "turn/start") {
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
      if (method === "thread/resume") return resumed(liveThread());
      if (method === "turn/start") {
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

test("running Steer and Interrupt and send each own one pending admission", async () => {
  const steerResponse = deferred<unknown>();
  const replaceResponse = deferred<unknown>();
  let steerCalls = 0;
  let replaceCalls = 0;
  const harness = await mountThreadApp({
    request: async (method) => {
      if (method === "thread/resume") return resumed(runningThread());
      if (method === "turn/steer") {
        steerCalls += 1;
        return await steerResponse.promise;
      }
      if (method === "turn/replace") {
        replaceCalls += 1;
        return await replaceResponse.promise;
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Guide this turn");
    const steer = await waitFor(() => exactButton("Steer"));
    await invokeButtonClick(steer, 2);
    assert.equal(steerCalls, 1);
    await act(async () => {
      steerResponse.resolve({ turnId: "turn-1" });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => composer.value === "");

    await setTextareaValue(composer, "Replace this turn");
    const replace = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Interrupt and send"]',
      ),
    );
    await invokePrimarySubmit(replace, 2);
    assert.equal(replaceCalls, 1);
    await act(async () => {
      replaceResponse.resolve({
        interruptedTurnId: "turn-1",
        turnId: "turn-2",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
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
      if (method === "thread/resume") return resumed(liveThread());
      if (method === "turn/start") {
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
  let resumeCalls = 0;
  const harness = await mountThreadApp({
    onStatus: (listener) => {
      statusListener = listener;
      return () => {
        statusListener = undefined;
      };
    },
    request: async (method) => {
      if (method === "thread/resume") {
        resumeCalls += 1;
        return resumed(liveThread());
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const composer = await selectedComposer();
    await setTextareaValue(composer, "Keep this local draft");
    const openWorkspace = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Open workspace panel"]',
      ),
    );
    await act(async () => openWorkspace.click());
    await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Close workspace"]',
      ),
    );
    assert.ok(statusListener);

    await act(async () => {
      statusListener?.({ type: "reconnecting", attempt: 1, delayMs: 10 });
      statusListener?.({ type: "ready", reconnected: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => resumeCalls === 2);
    assert.ok(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Close workspace"]',
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

test("conversation header owns thread cache telemetry and only retains workspace action", async () => {
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
        if (method === "thread/resume")
          return { thread: liveThread(), model: "fake", modelProvider: "fake" };
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
    assert.match(
      document.querySelector(".workspace-header .thread-usage")?.textContent ??
        "",
      /Context 50% · 200 \/ 400 · Thread cache unknown · 200 in · 25 out/u,
    );
    assert.equal(
      document.querySelector(".messages-inner > .thread-usage"),
      null,
    );
    const workspaceAction = document.querySelector(
      '.workspace-header [aria-label="Open workspace panel"]',
    );
    assert.equal(
      workspaceAction?.previousElementSibling?.className,
      "thread-usage",
    );
    assert.equal(
      document
        .querySelector('.workspace-header [aria-label="Open workspace panel"]')
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
    addWorkspace?(workspace: string): Promise<void>;
    getStatus?(): Promise<AppServerHostStatus>;
    initialPinnedThreadIds?: string[];
    onStatus?(listener: (status: AppServerHostStatus) => void): () => void;
    onPinnedThreadIds?(threadIds: readonly string[]): void;
    models?: ModelSummary[];
    modelUsage?(): Promise<ModelUsageProjection>;
    markWorkspaceUsed?(
      workspace: string,
    ): Promise<ReturnType<typeof publicSettings>>;
    projectsGet?(): Promise<ZenXProjectProjectionSnapshot>;
    startProjectThread?(
      workspace: string,
      selection?: { model?: string; effort?: string },
    ): Promise<unknown>;
    setPinnedThreadIds?(
      threadIds: readonly string[],
    ): Promise<ReturnType<typeof publicSettings>>;
    request?(method: string, params?: unknown): Promise<unknown>;
    observeTitle?(): Promise<undefined>;
    pickImages?(): Promise<ZenXImageDraft[]>;
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
  Object.defineProperties(dom.window.HTMLInputElement.prototype, {
    attachEvent: { value: () => undefined },
    detachEvent: { value: () => undefined },
  });
  let currentSettings = publicSettings(options.initialPinnedThreadIds ?? []);
  const zenx = {
    platform: "darwin",
    protocol: {
      getStatus: async () =>
        options.getStatus === undefined
          ? { type: "ready", reconnected: false }
          : await options.getStatus(),
      getPendingApprovals: async () => [],
      request: async (method: string, params?: unknown) => {
        if (method === "model/list")
          return {
            data: options.models ?? [wireModel("fake", true)],
            nextCursor: null,
          };
        if (options.request !== undefined)
          return await options.request(method, params);
        throw new Error(`Unexpected protocol request: ${method}`);
      },
      respondToApproval: async () => undefined,
      onApprovalRequest: () => () => undefined,
      onApprovalResolved: () => () => undefined,
      onStatus: (listener: (status: AppServerHostStatus) => void) =>
        options.onStatus?.(listener) ?? (() => undefined),
      onNotification: () => () => undefined,
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
        return await options.startProjectThread(workspace, selection);
      },
    },
    settings: {
      get: async () => currentSettings,
      setPinnedThreadIds: async (threadIds: readonly string[]) => {
        if (options.setPinnedThreadIds !== undefined)
          return await options.setPinnedThreadIds(threadIds);
        options.onPinnedThreadIds?.(threadIds);
        currentSettings = publicSettings([...threadIds]);
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
      version: 3 as const,
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
  return {
    id,
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
  return { thread, model: "fake", modelProvider: "fake" };
}

function started(thread: Thread, cwd: string) {
  return {
    ...resumed({ ...thread, cwd }),
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
