import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { BoardSurface } from "../src/renderer/src/board-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("review: current Room selection must be used after same-key Board remount", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const owner = { kind: "room", roomId: "review-room" };
  const snapshot = {
    revision: 1,
    draftRevision: 0,
    values: {},
    pinned: false,
    document: {
      id: "review",
      title: "Review Board",
      summary: "Synthetic",
      owner,
      blocks: [{ kind: "action", id: "run", event: "event", label: "Run" }],
      events: [{ id: "event", label: "Run", actions: [] }],
    },
  };
  const events: Record<string, unknown>[] = [];
  const sdk: PluginUiSdkV1 = {
    version: 1,
    pluginId: "zenx-board",
    theme: "light",
    context: {
      owner,
      admissionId: "review-remount",
      members: [
        { threadId: "member-A", name: "Member A" },
        { threadId: "member-B", name: "Member B" },
      ],
    },
    handles: { read: async () => null },
    navigation: { navigate: () => {} },
    commands: {
      execute: async (_id, v) => {
        const input = v as Record<string, unknown>;
        if (input.operation === "read") return structuredClone(snapshot);
        if (input.operation === "event") {
          events.push(structuredClone(input));
          return {
            snapshot: structuredClone(snapshot),
            navigation: [],
            outcomes: [],
          };
        }
        throw Error("Unexpected " + input.operation);
      },
    },
  };
  const render = () =>
    act(async () => root.render(React.createElement(BoardSurface, { sdk })));
  const select = async (name: string, scope: ParentNode = document) => {
    const trigger =
      scope.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((x) => x.textContent === name)!;
    assert.ok(option, "Missing option " + name);
    await act(async () => {
      option.focus();
      option.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
  };
  const run = (scope: ParentNode = document) =>
    act(async () =>
      scope.querySelector<HTMLButtonElement>(".board-action")!.click(),
    );
  try {
    await render();
    await select("Member A");
    await run();
    assert.equal(events.at(-1)!.executionThreadId, "member-A");
    await act(async () => root.render(null));
    await render();
    await select("Member B");
    assert.equal(
      document.querySelector<HTMLElement>('[role="combobox"]')!.dataset.value,
      "member-B",
    );
    await run();
    assert.equal(
      events.at(-1)!.executionThreadId,
      "member-B",
      "event must use current visible explicit selection, never the old unmounted executor ref",
    );
    await act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "div",
            { id: "surface-a" },
            React.createElement(BoardSurface, { sdk }),
          ),
          React.createElement(
            "div",
            { id: "surface-b" },
            React.createElement(BoardSurface, { sdk }),
          ),
        ),
      ),
    );
    const surfaceA = document.getElementById("surface-a")!;
    const surfaceB = document.getElementById("surface-b")!;
    await select("Member A", surfaceA);
    await select("Member B", surfaceB);
    await run(surfaceA);
    await run(surfaceB);
    assert.deepEqual(
      events.slice(-2).map((event) => event.executionThreadId),
      ["member-A", "member-B"],
      "Concurrent surfaces keep separate explicit execution choices",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
