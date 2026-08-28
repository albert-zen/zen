/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type { AppServerHostStatus } from "../src/main/app-server-manager.js";
import type { ZenXProjectProjectionSnapshot } from "../src/main/project-projection.js";
import type { ModelSummary, Thread } from "../src/protocol-client/index.js";
import { encodeModelKey } from "../../../src/protocol/codex/model-key.js";
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
  const startedWorkspaces: string[] = [];
  const harness = await mountApp(
    {
      projects: [],
      unavailableThreadIds: [],
      lastUsedWorkspace: null,
    },
    {
      startProjectThread: async (workspace) => {
        startedWorkspaces.push(workspace);
        return started(liveThread(), workspace);
      },
    },
  );
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
    await waitFor(() => startedWorkspaces.length === 1);
    assert.deepEqual(startedWorkspaces, ["/"]);
  } finally {
    await unmountApp(harness);
  }
});

test("Project quick-create keeps the clicked workspace authoritative and fences duplicate starts", async () => {
  const selectedWorkspace = "/work/documents";
  const startResponse = deferred<ReturnType<typeof started>>();
  const scopedStarts: string[] = [];
  const genericStarts: unknown[] = [];
  const projects: ZenXProjectProjectionSnapshot = {
    projects: [
      {
        key: "/work/documents",
        workspace: selectedWorkspace,
        configured: true,
        isDefault: false,
        threadIds: [],
      },
      {
        key: "/work",
        workspace: "/work",
        configured: true,
        isDefault: true,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: "/work",
  };
  const harness = await mountApp(projects, {
    startProjectThread: async (workspace) => {
      scopedStarts.push(workspace);
      return await startResponse.promise;
    },
    request: async (method, params) => {
      if (method === "thread/start") {
        genericStarts.push(params);
        return await startResponse.promise;
      }
      throw new Error(`Unexpected protocol request: ${method}`);
    },
  });
  try {
    const createInDocuments = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="New thread in documents"]',
      ),
    );
    await act(async () => {
      createInDocuments.click();
      createInDocuments.click();
      await Promise.resolve();
    });

    await waitFor(() => scopedStarts.length + genericStarts.length === 1);
    assert.deepEqual(scopedStarts, [selectedWorkspace]);
    assert.deepEqual(genericStarts, []);
    assert.equal(createInDocuments.disabled, true);
    assert.equal(
      document.querySelector<HTMLButtonElement>(".new-thread-action")?.disabled,
      true,
    );

    await act(async () => {
      startResponse.resolve(started(liveThread(), selectedWorkspace));
      await Promise.resolve();
      await Promise.resolve();
    });
  } finally {
    await unmountApp(harness);
  }
});

test("successful Project quick-create commits profile, summaries, and projection before settling", async () => {
  const workspace = "/work/zen";
  const profileCommit = deferred<ReturnType<typeof publicSettings>>();
  let committed = false;
  let starts = 0;
  const emptyProjects: ZenXProjectProjectionSnapshot = {
    projects: [
      {
        key: workspace,
        workspace,
        configured: true,
        isDefault: true,
        threadIds: [],
      },
    ],
    unavailableThreadIds: [],
    lastUsedWorkspace: workspace,
  };
  const populatedProjects: ZenXProjectProjectionSnapshot = {
    ...emptyProjects,
    projects: [{ ...emptyProjects.projects[0]!, threadIds: ["thread-1"] }],
  };
  const harness = await mountApp(emptyProjects, {
    markWorkspaceUsed: async () => {
      const result = await profileCommit.promise;
      committed = true;
      return result;
    },
    projectsGet: async () => (committed ? populatedProjects : emptyProjects),
    startProjectThread: async () => {
      starts += 1;
      return started(liveThread(), workspace);
    },
    threads: async (archived) =>
      !archived && committed ? [summary(false)] : [],
  });
  try {
    const create = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="New thread in zen"]',
      ),
    );
    await act(async () => create.click());
    await waitFor(() => starts === 1);
    assert.equal(
      document.querySelector(".project-group .thread-row-shell"),
      null,
    );

    await act(async () => {
      profileCommit.resolve(publicSettings([]));
      await Promise.resolve();
    });
    await waitFor(() =>
      document.querySelector(".project-group .thread-row-shell"),
    );
  } finally {
    await unmountApp(harness);
  }
});

test("New thread failure stays visible on Settings and retries in place", async () => {
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
  let starts = 0;
  const populatedProjects: ZenXProjectProjectionSnapshot = {
    ...projects,
    projects: [{ ...projects.projects[0]!, threadIds: ["thread-1"] }],
  };
  const harness = await mountApp(projects, {
    projectsGet: async () => (starts >= 2 ? populatedProjects : projects),
    startProjectThread: async (workspace) => {
      starts += 1;
      if (starts === 1) throw new Error("runtime offline");
      return started(liveThread(), workspace);
    },
    threads: async (archived) =>
      !archived && starts >= 2 ? [summary(false)] : [],
  });
  try {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".settings-nav-row")?.click(),
    );
    await waitFor(() => /Settings/u.test(document.body.textContent ?? ""));
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="New thread in zen"]')
        ?.click(),
    );

    const retry = await waitFor(() => exactButton("Try again"));
    assert.match(document.body.textContent ?? "", /New thread failed/u);
    assert.match(document.body.textContent ?? "", /runtime offline/u);
    assert.match(document.body.textContent ?? "", /Settings/u);

    await act(async () => retry.click());
    await waitFor(() => starts === 2);
    await waitFor(() => /Thread one/u.test(document.body.textContent ?? ""));
  } finally {
    await unmountApp(harness);
  }
});

test("Project quick-create releases its loading fence after selection epoch changes and failure", async () => {
  const firstStart = deferred<ReturnType<typeof started>>();
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
      if (method === "thread/resume") return resumed(liveThread());
      throw new Error(`Unexpected protocol request: ${method}`);
    },
    startProjectThread: async (workspace) => {
      starts += 1;
      if (starts === 1) return await firstStart.promise;
      return started(liveThread(), workspace);
    },
    threads: async (archived) => (archived ? [] : [summary(false)]),
  });
  try {
    const create = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="New thread in zen"]',
      ),
    );
    await act(async () => create.click());
    await waitFor(() => starts === 1);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".thread-row")?.click(),
    );
    await waitFor(() => /Thread one/u.test(document.body.textContent ?? ""));
    await act(async () => {
      firstStart.reject(new Error("first start failed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    const retryCreate = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="New thread in zen"]',
      );
      return button !== null && !button.disabled ? button : null;
    });
    assert.match(document.body.textContent ?? "", /first start failed/u);
    await act(async () => retryCreate.click());
    await waitFor(() => starts === 2);
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
    assert.match(document.body.textContent ?? "", /ZenX could not load data/u);
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
    assert.match(document.body.textContent ?? "", /No thread selected/u);

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

test("macOS title-bar toggle controls the compact sidebar without changing desktop collapse preference", async () => {
  const harness = await mountApp({
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  try {
    Object.defineProperty(harness.dom.window, "innerWidth", {
      configurable: true,
      value: 480,
    });
    await act(async () =>
      harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize")),
    );

    const toggle = document.querySelector<HTMLButtonElement>(
      ".window-sidebar-toggle",
    );
    assert.ok(toggle);
    assert.equal(toggle.getAttribute("aria-label"), "Expand sidebar");
    assert.equal(document.querySelector(".sidebar.open"), null);

    await act(async () => toggle.click());
    assert.ok(document.querySelector(".sidebar.open"));
    assert.equal(toggle.getAttribute("aria-label"), "Collapse sidebar");

    await act(async () => toggle.click());
    assert.equal(document.querySelector(".sidebar.open"), null);

    Object.defineProperty(harness.dom.window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    await act(async () =>
      harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize")),
    );
    assert.equal(toggle.getAttribute("aria-label"), "Collapse sidebar");
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
    getStatus?(): Promise<AppServerHostStatus>;
    initialPinnedThreadIds?: string[];
    onStatus?(listener: (status: AppServerHostStatus) => void): () => void;
    onPinnedThreadIds?(threadIds: readonly string[]): void;
    models?: ModelSummary[];
    markWorkspaceUsed?(
      workspace: string,
    ): Promise<ReturnType<typeof publicSettings>>;
    projectsGet?(): Promise<ZenXProjectProjectionSnapshot>;
    startProjectThread?(workspace: string): Promise<unknown>;
    setPinnedThreadIds?(
      threadIds: readonly string[],
    ): Promise<ReturnType<typeof publicSettings>>;
    request?(method: string, params?: unknown): Promise<unknown>;
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
      pick: async () => [],
      import: async () => [],
      read: async () => new Uint8Array(),
      forThread: async () => ({}),
    },
    modelUsage: {
      forThread: async () => ({
        thread: { responseCount: 0, inputTokens: 0, outputTokens: 0 },
        turns: {},
      }),
    },
    projects: {
      get: async () =>
        options.projectsGet === undefined
          ? projects
          : await options.projectsGet(),
      startThread: async (workspace: string) => {
        if (options.startProjectThread === undefined) {
          throw new Error(`Unexpected Project Thread start: ${workspace}`);
        }
        return await options.startProjectThread(workspace);
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
