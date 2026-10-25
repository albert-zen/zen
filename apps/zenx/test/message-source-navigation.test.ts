import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  TriggersPage,
  TriggersPanel,
} from "../src/renderer/src/bundled-automation-ui.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";

test("source trigger route opens the exact definition, including same-name definitions, without executing it", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.local" });
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: string[] = [];
  const sdk = {
    context: { route: "/plugins/zenx-triggers/triggers?triggerId=exact%2Fid" },
    commands: {
      execute: async (name: string) => {
        calls.push(name);
        if (name === "list")
          return {
            triggers: ["other", "exact/id"].map((id) => ({
              id,
              label: "Same name",
              threadId: "thread",
              kind: "signal",
              signal: { name: id },
              prompt: id,
              active: false,
              createdAt: 1,
            })),
            history: [],
          };
        if (name === "threads") return { threads: [] };
        if (name === "workspaces") return { workspaces: [] };
        throw new Error(name);
      },
    },
    navigation: { navigate() {} },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(React.createElement(TriggersPage, { sdk })),
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("form textarea")?.value,
      "exact/id",
    );
    assert.deepEqual(calls.sort(), ["list", "threads", "workspaces"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

for (const scenario of ["missing", "denied", "program"] as const) {
  test(`trigger source ${scenario} stays exact and performs no writes`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "https://zenx.local",
    });
    const prior = { window: globalThis.window, document: globalThis.document };
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const calls: string[] = [];
    const sdk = {
      context: { route: "/plugins/zenx-triggers/triggers?triggerId=source" },
      commands: {
        execute: async (name: string) => {
          calls.push(name);
          if (name === "list") {
            if (scenario === "denied") throw new Error("Access denied");
            return {
              triggers: [
                {
                  id: scenario === "missing" ? "same-name-other" : "source",
                  label: "Same name",
                  threadId: "thread",
                  kind: "signal",
                  signal: { name: "go" },
                  prompt: "Exact settings",
                  active: false,
                  createdAt: 1,
                  ...(scenario === "program"
                    ? { program: { version: 1, steps: [] } }
                    : {}),
                },
              ],
              history: [],
            };
          }
          if (name === "threads") return { threads: [] };
          if (name === "workspaces") return { workspaces: [] };
          throw new Error(name);
        },
      },
      navigation: { navigate() {} },
    } as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(React.createElement(TriggersPage, { sdk })),
      );
      assert.equal(document.querySelector("form"), null);
      if (scenario === "program")
        assert.equal(
          document.activeElement,
          document.querySelector('[data-source-trigger="selected"]'),
        );
      else
        assert.match(
          document.body.textContent!,
          scenario === "missing"
            ? /unavailable or has been deleted/
            : /Access denied/,
        );
      assert.deepEqual(calls.sort(), ["list", "threads", "workspaces"]);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, prior);
    }
  });
}
test("delayed source definition cannot replace a newer New Trigger editor", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.local" });
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let resolveList!: (value: unknown) => void;
  const listed = new Promise((resolve) => {
    resolveList = resolve;
  });
  const sdk = {
    context: { route: "/plugins/zenx-triggers/triggers?triggerId=old-source" },
    commands: {
      execute: async (name: string) => {
        if (name === "list") return listed;
        if (name === "threads") return { threads: [] };
        if (name === "workspaces") return { workspaces: [] };
        throw new Error(name);
      },
    },
    navigation: { navigate() {} },
  } as unknown as PluginUiSdkV1;
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(React.createElement(TriggersPage, { sdk })),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".trigger-manager-header .primary-button",
        )!
        .click(),
    );
    assert.match(
      document.querySelector("form h3")!.textContent!,
      /New trigger/i,
    );
    await act(async () =>
      resolveList({
        triggers: [
          {
            id: "old-source",
            label: "Old source",
            threadId: "thread",
            kind: "signal",
            signal: { name: "go" },
            prompt: "old source prompt",
            active: false,
            createdAt: 1,
          },
        ],
        history: [],
      }),
    );
    assert.match(
      document.querySelector("form h3")!.textContent!,
      /New trigger/i,
      "late source load must not turn a newer create action into editing an existing trigger",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});

for (const wrongThread of [false, true]) {
  test(`scoped trigger source opens exact ID and rejects cross-thread definition (${wrongThread})`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "https://zenx.local",
    });
    const prior = { window: globalThis.window, document: globalThis.document };
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const calls: string[] = [];
    const sdk = {
      context: {
        threadId: "outer-thread",
        triggerSourceRequest: {
          threadId: "source-thread",
          triggerId: "exact/id",
          requestId: 1,
        },
      },
      commands: {
        execute: async (name: string) => {
          calls.push(name);
          if (name === "list")
            return {
              triggers: [
                {
                  id: "exact/id",
                  label: "Exact definition",
                  threadId: wrongThread ? "wrong-thread" : "source-thread",
                  kind: "signal",
                  signal: { name: "example" },
                  prompt: "Exact prompt",
                  active: false,
                  createdAt: 1,
                },
              ],
              history: [],
            };
          if (name === "threads") return { threads: [] };
          if (name === "workspaces") return { workspaces: [] };
          throw Error(name);
        },
      },
      navigation: {
        navigate() {
          assert.fail("No navigation from scoped source selection");
        },
      },
    } as unknown as PluginUiSdkV1;
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(React.createElement(TriggersPanel, { sdk })),
      );
      if (wrongThread) {
        assert.equal(document.querySelector("form textarea"), null);
        assert.match(document.body.textContent!, /unavailable|deleted/i);
      } else
        assert.equal(
          document.querySelector<HTMLTextAreaElement>("form textarea")?.value,
          "Exact prompt",
        );
      assert.deepEqual(calls.sort(), ["list", "threads", "workspaces"]);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, prior);
    }
  });
}
