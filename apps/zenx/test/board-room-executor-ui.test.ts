import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { BoardSurface } from "../src/renderer/src/board-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type { BoardSnapshot } from "../../../packages/zenx-board-plugin/src/board.js";

test("Room Board execution has an explicit current member and never revives an old selection", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  let roomId = "executor-room-a";
  let members = [
    { threadId: "member-a", name: "A" },
    { threadId: "member-b", name: "B" },
  ];
  const current = (): BoardSnapshot => ({
    revision: 1,
    draftRevision: 0,
    values: {},
    pinned: false,
    document: {
      id: "same-body-id",
      title: "Workspace Board",
      summary: "Synthetic UI",
      owner: { kind: "room", roomId },
      blocks: [
        {
          kind: "action",
          id: "run",
          label: "Run explicit action",
          event: "run",
        },
      ],
      events: [
        {
          id: "run",
          label: "Run",
          actions: [{ kind: "script", command: "echo synthetic" }],
        },
      ],
    },
  });
  const calls: Record<string, unknown>[] = [];
  const sdk = (): PluginUiSdkV1 => ({
    version: 1,
    pluginId: "zenx-board",
    theme: "light",
    context: {
      owner: { kind: "room", roomId },
      admissionId: "workspace-executor-test",
      members,
    },
    navigation: { navigate: () => assert.fail("No App navigation") },
    handles: { read: async () => null },
    commands: {
      execute: async (_id, input) => {
        const value = input as Record<string, unknown>;
        if (value.operation === "read") return structuredClone(current());
        calls.push(structuredClone(value));
        return { snapshot: current(), outcomes: [], navigation: [] };
      },
    },
  });
  const render = () =>
    act(async () =>
      root.render(React.createElement(BoardSurface, { sdk: sdk() })),
    );
  const run = () =>
    act(async () =>
      document.querySelector<HTMLButtonElement>(".board-action")!.click(),
    );
  const choose = async (value: string) => {
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"]',
    )!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
    });
    const option = document.querySelector<HTMLElement>(
      `[role="option"][data-value="${value}"]`,
    );
    assert(option, "Explicit member option is present");
    await act(async () => {
      option.focus();
      option.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
  };
  try {
    await render();
    await run();
    assert.equal(
      calls.length,
      0,
      "No creator/foreground/first-member executor is implied",
    );
    await choose("member-b");
    await run();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.executionThreadId, "member-b");
    assert.deepEqual(calls[0]!.owner, { kind: "room", roomId });
    members = [{ threadId: "member-a", name: "A" }];
    await render();
    await run();
    assert.equal(calls.length, 1, "Removed member selection cannot execute");
    members = [
      { threadId: "member-a", name: "A" },
      { threadId: "member-b", name: "B" },
    ];
    await render();
    await run();
    assert.equal(
      calls.length,
      1,
      "Rejoining does not silently revive the old selection",
    );
    await choose("member-a");
    await run();
    assert.equal(calls.length, 2);
    roomId = "executor-room-b";
    await render();
    await run();
    assert.equal(
      calls.length,
      2,
      "A new workspace requires its own explicit choice",
    );
    roomId = "executor-room-a";
    await render();
    await run();
    assert.equal(
      calls.length,
      2,
      "Returning to a workspace does not revive an old choice",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
