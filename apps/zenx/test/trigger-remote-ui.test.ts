import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type {
  TriggerHistoryEntry,
  ZenXTrigger,
} from "../src/main/trigger-types.js";

const bootstrap = new JSDOM('<div id="root"></div>', {
  url: "https://zenx.local/",
});
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { TriggersPage, TriggersPanel } =
  await import("../src/renderer/src/bundled-automation-ui.js");

test("new remote watch sends an explicit Fleet source and Cancel clears the source draft", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  const created: unknown[] = [];
  const sdk = {
    context: { threadId: "local-target" },
    commands: {
      execute: async (name: string, input: unknown) => {
        if (name === "list") return { triggers: [], history: [] };
        if (name === "threads") return { threads: [] };
        if (name === "workspaces") return { workspaces: [] };
        if (name === "create") {
          created.push(input);
          return { id: "new-watch" };
        }
        throw new Error(name);
      },
    },
    navigation: { navigate() {} },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  const click = async (label: string) =>
    act(async () => {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((node) => node.textContent?.trim() === label);
      assert.ok(button, label);
      button.click();
      await Promise.resolve();
    });
  const field = (label: string) => {
    const node = [...document.querySelectorAll("label")]
      .find(
        (entry) => entry.querySelector("span")?.textContent?.trim() === label,
      )
      ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
    assert.ok(node, label);
    return node;
  };
  const fill = async (label: string, value: string) =>
    act(async () => {
      const node = field(label);
      const proto =
        node.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
      node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  const watchType = async () => {
    const trigger = [...document.querySelectorAll("label")]
      .find((entry) => entry.querySelector("span")?.textContent === "Type")!
      .querySelector<HTMLButtonElement>("button.ui-select")!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((node) => node.dataset.value === "thread")!;
    await act(async () => {
      option.focus();
      option.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
    });
  };
  try {
    await act(async () =>
      root.render(React.createElement(TriggersPanel, { sdk })),
    );
    await click("New trigger");
    await watchType();
    await fill("Name", "Watch remote task");
    await fill("Source device ID (blank = this Host)", "desktop");
    await fill("Source workspace (optional)", "workspace-remote");
    await fill("Remote Thread ID or exact title", "Remote task title");
    await fill("Instructions for target Thread", "Read its result");
    await click("Save");
    assert.deepEqual(created, [
      {
        threadId: "local-target",
        kind: "thread",
        label: "Watch remote task",
        prompt: "Read its result",
        watchedThreadId: "Remote task title",
        sourceDevice: "desktop",
        sourceWorkspace: "workspace-remote",
        once: true,
        includeLatest: false,
      },
    ]);
    await click("New trigger");
    await watchType();
    await fill("Source device ID (blank = this Host)", "different-device");
    await click("Cancel");
    await click("New trigger");
    await watchType();
    assert.equal(field("Source device ID (blank = this Host)").value, "");
    assert.equal(created.length, 1);
    assert.equal(
      [...document.querySelectorAll("label")].some((node) =>
        node.textContent?.startsWith("Source workspace"),
      ),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("remote watch UI displays source identity/error and keeps remote history separate from same-ID local Threads", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  let trigger: ZenXTrigger = {
    id: "remote-watch",
    threadId: "target",
    kind: "thread",
    label: "Remote watch",
    prompt: "Read remote results",
    createdAt: 1,
    active: true,
    sourceError: "Remote source disconnected; reconnect this device",
    watch: {
      threadId: "same-id",
      sourceDevice: "desktop",
      sourceWorkspace: "workspace-remote",
      event: "turn_completed",
      once: true,
    },
  };
  const entry = {
    id: "history",
    triggerId: trigger.id,
    threadId: "target",
    kind: "thread",
    reason: "Remote work ended",
    startedAt: 1,
    completedAt: 2,
    status: "completed",
    delivery: "queued",
    sourceThreadId: "same-id",
    sourceDevice: "desktop",
    sourceWorkspace: "workspace-remote",
    sourceTurnId: "remote-turn",
    error: null,
    programOutcome: null,
  } as TriggerHistoryEntry;
  const updates: unknown[] = [];
  const navigated: string[] = [];
  const results: unknown[] = [];
  const sdk = {
    context: {},
    commands: {
      execute: async (name: string, input: unknown) => {
        if (name === "list") return { triggers: [trigger], history: [entry] };
        if (name === "threads")
          return {
            threads: [
              {
                threadId: "target",
                shortId: "target",
                name: "Target",
                status: "idle",
                archived: false,
              },
              {
                threadId: "same-id",
                shortId: "same-id",
                name: "Unrelated local task",
                status: "idle",
                archived: false,
              },
            ],
          };
        if (name === "workspaces") return { workspaces: [] };
        if (name === "update") {
          updates.push(input);
          trigger = { ...trigger, label: (input as { label: string }).label };
          return { id: trigger.id };
        }
        if (name === "result") {
          results.push(input);
          return {
            sourceDevice: "desktop",
            threadId: "same-id",
            turnId: "remote-turn",
            preview: "Actual remote source reply",
          };
        }
        throw new Error(name);
      },
    },
    navigation: { navigate: (path: string) => navigated.push(path) },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  const button = (label: string) => {
    const value = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((node) => node.textContent?.trim() === label);
    assert.ok(value, label);
    return value;
  };
  const click = async (label: string) =>
    act(async () => {
      button(label).click();
      await Promise.resolve();
    });
  try {
    await act(async () =>
      root.render(React.createElement(TriggersPage, { sdk })),
    );
    const definition = document.querySelector(
      '[aria-label="Trigger definitions"]',
    )!;
    assert.match(
      definition.textContent ?? "",
      /desktop.*workspace-remote.*same-id/su,
    );
    assert.doesNotMatch(
      definition.textContent ?? "",
      /After Unrelated local task/u,
    );
    assert.match(
      definition.querySelector('[role="status"]')?.textContent ?? "",
      /source disconnected/u,
    );
    const history = document.querySelector('[aria-label="Trigger history"]')!;
    assert.match(
      history.textContent ?? "",
      /desktop.*workspace-remote.*same-id/su,
    );
    assert.equal(
      [...history.querySelectorAll("button")].some(
        (node) => node.textContent?.trim() === "Source Thread",
      ),
      false,
    );
    await click("Source result");
    assert.deepEqual(results, [{ historyId: "history" }]);
    assert.match(history.textContent ?? "", /Actual remote source reply/u);
    assert.deepEqual(navigated, []);
    await click("Edit");
    const form = document.querySelector<HTMLFormElement>(
      "form.trigger-editor",
    )!;
    assert.match(
      form.textContent ?? "",
      /desktop.*workspace-remote.*same-id/su,
    );
    const input = [...form.querySelectorAll("label")]
      .find((label) => label.querySelector("span")?.textContent === "Name")!
      .querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Edited remote watch");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("Save");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], {
      id: "remote-watch",
      threadId: "target",
      kind: "thread",
      label: "Edited remote watch",
      prompt: "Read remote results",
      watchedThreadId: "same-id",
      sourceDevice: "desktop",
      sourceWorkspace: "workspace-remote",
      once: true,
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
