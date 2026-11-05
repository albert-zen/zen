import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  BoardInformationVisibilityContext,
  BoardSurface,
} from "../src/renderer/src/board-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type { BoardSnapshot } from "../../../packages/zenx-board-plugin/src/board.js";

test("empty Boards stay mounted, recover automatically, retain real content on errors and isolate visibility by owner", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const visibility: Record<string, boolean[]> = { first: [], second: [] };
  const callbacks = Object.fromEntries(
    Object.keys(visibility).map((key) => [
      key,
      (visible: boolean) => visibility[key]!.push(visible),
    ]),
  );
  let snapshot: BoardSnapshot | null = null;
  let failure = false;
  let poll: (() => void) | undefined;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((callback: () => void) => {
    poll = callback;
    return 1;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  const sdk = (threadId: string): PluginUiSdkV1 => ({
    version: 1,
    pluginId: "zenx-board",
    theme: "light",
    context: {
      owner: { kind: "thread", threadId },
      admissionId: "empty-visibility",
    },
    navigation: { navigate: () => {} },
    handles: { read: async () => null },
    commands: {
      execute: async () => {
        if (failure) throw new Error("Synthetic read failure");
        return snapshot;
      },
    },
  });
  const render = (owner: string, manage = false) =>
    act(async () =>
      root.render(
        React.createElement(
          BoardInformationVisibilityContext.Provider,
          {
            value: { manageMode: manage, onVisibilityChange: callbacks[owner] },
          },
          React.createElement(BoardSurface, { sdk: sdk(owner) }),
        ),
      ),
    );
  try {
    await render("first");
    assert.equal(document.getElementById("root")!.textContent, "");
    assert.equal(visibility.first!.at(-1), false);
    snapshot = {
      revision: 1,
      draftRevision: 0,
      pinned: false,
      values: {},
      document: {
        id: "synthetic",
        title: "Meaningful title without blocks",
        summary: "Content",
        owner: { kind: "thread", threadId: "first" },
        blocks: [],
        events: [],
      },
    };
    await act(async () => window.dispatchEvent(new dom.window.Event("focus")));
    assert.match(document.body.textContent!, /Meaningful title/);
    assert.equal(visibility.first!.at(-1), true);
    assert.equal(document.querySelector(".board-footer button"), null);
    failure = true;
    await act(async () => poll!());
    assert.match(document.body.textContent!, /Meaningful title/);
    assert.match(
      document.querySelector(".board-error")!.textContent!,
      /Synthetic read failure/,
    );
    assert.equal(visibility.first!.at(-1), true);
    await render("second");
    assert.equal(document.getElementById("root")!.textContent, "");
    assert.equal(visibility.second!.at(-1), false);
    await render("second", true);
    assert.match(
      document.querySelector(".board-error")!.textContent!,
      /Synthetic read failure/,
    );
    assert.equal(visibility.second!.at(-1), true);
    failure = false;
    snapshot = null;
    await act(async () =>
      document.dispatchEvent(new dom.window.Event("visibilitychange")),
    );
    assert.equal(visibility.second!.at(-1), false);
    snapshot = {
      revision: 1,
      draftRevision: 0,
      pinned: false,
      values: {},
      document: {
        id: "second",
        title: "Poll-discovered content",
        summary: "Content",
        owner: { kind: "thread", threadId: "second" },
        blocks: [],
        events: [],
      },
    };
    await act(async () => poll!());
    assert.match(document.body.textContent!, /Poll-discovered content/);
    assert.equal(visibility.second!.at(-1), true);
    assert.deepEqual(
      visibility.first,
      [false, true],
      "other owners cannot rewrite the old visibility callback",
    );
  } finally {
    await act(async () => root.unmount());
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    dom.window.close();
  }
});
