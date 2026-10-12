import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function fixture(execute: (input: unknown) => Promise<unknown>) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: unknown[] = [];
  const routes: string[] = [];
  Object.assign(dom.window, {
    zenx: {
      plugins: {
        executeCommand: async (
          pluginId: string,
          commandId: string,
          input: unknown,
        ) => {
          calls.push({ pluginId, commandId, input });
          return await execute(input);
        },
        readHandle: async () => null,
      },
    },
  });
  const snapshot: ZenXPluginSnapshot = {
    plugins: [],
    settings: [],
    commands: [],
    sidebar: [],
    pages: [],
    subroutes: [],
    menus: [],
    surfaces: [],
    bundles: [],
    panels: [
      {
        key: "zenx-subagents:subagents",
        id: "subagents",
        pluginId: "zenx-subagents",
        surfaceId: "subagents-panel",
        title: "Subagents",
      },
    ],
  };
  const root = createRoot(document.getElementById("root")!);
  const render = async (
    threadId = "parent",
    open = true,
    selectedTab = "",
    enabled = true,
  ) => {
    await act(async () =>
      root.render(
        React.createElement(AuxiliaryPanel, {
          threadId,
          open,
          title: threadId,
          snapshot: enabled ? snapshot : { ...snapshot, panels: [] },
          onOpenChange: () => {},
          selectedTab,
          onSelectTab: () => {},
          navigate: (route) => routes.push(route),
        }),
      ),
    );
  };
  const button = () => {
    const value = document.querySelector<HTMLButtonElement>(
      '[aria-label="New side chat"]',
    );
    assert.ok(value);
    return value;
  };
  return {
    render,
    button,
    calls,
    routes,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test("workspace chooser places an independent side-chat shortcut beside Subagents and guards duplicate clicks", async () => {
  const creation = deferred();
  const f = await fixture(async () => creation.promise);
  try {
    await f.render();
    const button = f.button();
    const group = button.closest(".workspace-subagents-actions");
    assert.equal(
      group?.querySelector(":scope > button")?.textContent,
      "Subagents",
    );
    assert.equal(group?.querySelectorAll("button").length, 2);
    button.focus();
    assert.equal(document.activeElement, button);
    await act(async () => {
      button.click();
      button.click();
    });
    assert.equal(button.disabled, true);
    assert.deepEqual(f.calls, [
      {
        pluginId: "zenx-subagents",
        commandId: "create",
        input: { parentThreadId: "parent", mode: "side-chat" },
      },
    ]);
    await act(async () => creation.resolve({ threadId: "created" }));
    assert.deepEqual(f.routes, ["/threads/created?view=panel"]);
  } finally {
    await f.close();
  }
});

test("shortcut reports creation failure and permits a deliberate retry", async () => {
  let attempts = 0;
  const f = await fixture(async () => {
    if (++attempts === 1) throw new Error("Creation failed");
    return { thread: { id: "retried" } };
  });
  try {
    await f.render();
    await act(async () => f.button().click());
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Creation failed/,
    );
    assert.equal(f.button().disabled, false);
    assert.deepEqual(f.routes, []);
    await act(async () => f.button().click());
    assert.equal(attempts, 2);
    assert.deepEqual(f.routes, ["/threads/retried?view=panel"]);
  } finally {
    await f.close();
  }
});

test("late shortcut completion cannot steal navigation after close, parent change, another tab or plugin removal", async () => {
  for (const transition of [
    "hide",
    "reopen",
    "parent",
    "tab",
    "disabled",
  ] as const) {
    const creation = deferred();
    const f = await fixture(async () => creation.promise);
    try {
      await f.render();
      await act(async () => f.button().click());
      if (transition === "hide" || transition === "reopen") {
        await f.render("parent", false);
        if (transition === "reopen") await f.render("parent");
      } else if (transition === "parent") await f.render("other");
      else if (transition === "tab")
        await f.render("parent", true, "plugin:zenx-subagents:subagents");
      else await f.render("parent", true, "", false);
      await act(async () => creation.resolve({ threadId: "late" }));
      assert.deepEqual(f.routes, [], transition);
      assert.equal(f.calls.length, 1);
    } finally {
      await f.close();
    }
  }
});

test("quick creation is unavailable when the Subagents contribution is disabled", async () => {
  const f = await fixture(async () => ({}));
  try {
    await f.render("parent", true, "", false);
    assert.equal(document.querySelector('[aria-label="New side chat"]'), null);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});
