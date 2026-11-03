import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { BoardSurface } from "../src/renderer/src/board-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type { BoardSnapshot } from "../../../packages/zenx-board-plugin/src/board.js";

test("actual Board surface retires the iframe and late action receipt when only independent address changes", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const owner = {
    kind: "thread" as const,
    threadId: "synthetic-equal-body-owner",
  };
  const snapshots = new Map<string, BoardSnapshot>();
  for (const address of ["first", "second"])
    snapshots.set(address, {
      instanceKey: address,
      revision: 7,
      draftRevision: 0,
      pinned: false,
      values: { answer: address },
      document: {
        id: "equal-authored-id",
        title: `Synthetic ${address}`,
        summary: "Equal revision and authored IDs",
        owner,
        html: "<button>Identical isolated HTML</button>",
        blocks: [
          { id: "field", kind: "field", field: "answer", label: "Answer" },
          {
            id: "action",
            kind: "action",
            label: "Run synthetic action",
            event: "event",
          },
        ],
        events: [
          {
            id: "event",
            label: "Event",
            actions: [{ kind: "set", values: { answer: "action" } }],
          },
        ],
      },
    });
  const calls: { port: string; input: Record<string, unknown> }[] = [];
  let resolve!: (value: unknown) => void;
  const late = new Promise((yes) => {
    resolve = yes;
  });
  const sdk = (address: string): PluginUiSdkV1 => ({
    version: 1,
    pluginId: "zenx-board",
    theme: "light",
    context: {
      owner,
      instanceKey: address,
      admissionId: "equal-body-renderer",
    },
    handles: { read: async () => null },
    navigation: { navigate: () => {} },
    commands: {
      execute: async (_command, value) => {
        const input = value as Record<string, unknown>;
        calls.push({ port: address, input: structuredClone(input) });
        assert.equal(
          input.instanceKey,
          address,
          "a cached surface must retain its own command port and address",
        );
        if (input.operation === "read")
          return structuredClone(snapshots.get(address));
        if (input.operation === "event" && address === "first") return late;
        throw Error("No other synthetic effects");
      },
    },
  });
  const render = (address: string) =>
    act(async () =>
      root.render(React.createElement(BoardSurface, { sdk: sdk(address) })),
    );
  try {
    await render("first");
    const firstFrame = document.querySelector("iframe")!;
    assert.ok(firstFrame);
    assert.equal(
      document.querySelector<HTMLInputElement>(".board-field input")!.value,
      "first",
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".board-action")!.click(),
    );
    await render("second");
    const secondFrame = document.querySelector("iframe")!;
    assert.ok(secondFrame);
    assert.notEqual(
      secondFrame,
      firstFrame,
      "same HTML, owner, body ID and revision cannot keep another address's frame alive",
    );
    assert.equal(firstFrame.isConnected, false);
    assert.equal(
      document.querySelector<HTMLInputElement>(".board-field input")!.value,
      "second",
    );
    await act(async () =>
      resolve({
        snapshot: snapshots.get("first"),
        outcomes: [],
        navigation: [],
        error: "Only first Board sees this late receipt",
      }),
    );
    assert.doesNotMatch(document.body.textContent!, /Only first Board/);
    assert.equal(
      document.querySelector<HTMLInputElement>(".board-field input")!.value,
      "second",
    );
    await render("first");
    assert.equal(
      document.querySelector<HTMLInputElement>(".board-field input")!.value,
      "first",
    );
    assert.match(
      document.body.textContent!,
      /Only first Board sees this late receipt/,
    );
    assert.equal(
      calls.filter((entry) => entry.input.operation === "event").length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
