import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import { subagentsManifest } from "../../../packages/zenx-subagents-plugin/src/manifest.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import {
  GenericPluginUiHost,
  createPluginUiRegistry,
} from "../src/renderer/src/plugin-ui-host.js";
import {
  PluginThreadHeaders,
  registerSubagentsUi,
} from "../src/renderer/src/subagents-ui.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function summary(
  threadId: string,
  parentThreadId?: string,
  options: {
    archived?: boolean;
    status?: "idle" | "active";
    name?: string;
  } = {},
): NativeThreadSummary {
  return {
    threadId,
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    name: options.name ?? threadId,
    archived: options.archived ?? false,
    status: options.status ?? "idle",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    preview: "",
    currentMetadata: {
      cwd: "/workspace",
      provider: "fake",
      model: "fake",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  };
}

interface CommandCall {
  pluginId: string;
  commandId: string;
  input: unknown;
}

async function fixture(
  execute: (call: CommandCall) => Promise<unknown> = async () => ({
    threads: [],
  }),
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  const calls: CommandCall[] = [];
  const routes: string[] = [];
  const executeCommand = async (
    pluginId: string,
    commandId: string,
    input?: unknown,
  ) => {
    const call = { pluginId, commandId, input };
    calls.push(call);
    return await execute(call);
  };
  const readHandle = async () => null;
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: { plugins: { executeCommand, readHandle } },
  });
  const registry = createPluginUiRegistry();
  registerSubagentsUi(registry);
  const catalog = new ZenXPluginCatalog({
    load: async () => ({ disabled: [], uninstalled: [], packages: {} }),
    save: async () => {},
  });
  await catalog.initialize();
  await catalog.install(
    { manifest: subagentsManifest, invoke: async () => null },
    "bundled",
  );
  const root = createRoot(dom.window.document.getElementById("root")!);
  const navigate = (route: string) => routes.push(route);
  const render = async (
    parent: string,
    surface: "header" | "panel" = "header",
    threads: readonly NativeThreadSummary[] = [],
    snapshot: ZenXPluginSnapshot = catalog.pluginSnapshot(),
  ) => {
    await act(async () => {
      root.render(
        surface === "header"
          ? React.createElement(PluginThreadHeaders, {
              snapshot,
              threadId: parent,
              threads,
              navigate,
              registry,
            })
          : React.createElement(GenericPluginUiHost, {
              registry,
              snapshot,
              pluginId: "zenx-subagents",
              surfaceId: "subagents-panel",
              context: { threadId: parent, threads },
              theme: "light",
              navigate,
              executeCommand,
              readHandle,
            }),
      );
    });
  };
  const button = (label: string) => {
    const match = [...dom.window.document.querySelectorAll("button")].find(
      (element) =>
        element.getAttribute("aria-label") === label ||
        element.textContent?.trim() === label,
    );
    assert.ok(match, `Missing button: ${label}`);
    return match;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
  };
  return {
    dom,
    calls,
    routes,
    catalog,
    render,
    button,
    click,
    close: async () => {
      await act(async () => root.unmount());
      await catalog.close();
      dom.window.close();
    },
  };
}

test("fresh and fork UI creation submit the explicit parent and no automatic task", async () => {
  for (const [mode, label] of [
    ["fresh", "Start fresh"],
    ["fork", "Fork context"],
  ] as const) {
    const creation = deferred<unknown>();
    const f = await fixture(async (call) =>
      call.commandId === "create" ? creation.promise : { threads: [] },
    );
    try {
      await f.render("selected-parent");
      await f.click(f.button("New subagent"));
      await f.click(f.button(label));
      const creates = f.calls.filter((call) => call.commandId === "create");
      assert.deepEqual(creates, [
        {
          pluginId: "zenx-subagents",
          commandId: "create",
          input: { parentThreadId: "selected-parent", mode },
        },
      ]);
      assert.equal(
        f.calls.some((call) => call.commandId === "send"),
        false,
      );
      assert.deepEqual(f.routes, []);
      await act(async () => creation.resolve({ threadId: `child-${mode}` }));
      assert.deepEqual(f.routes, [`/threads/child-${mode}?view=panel`]);
    } finally {
      await f.close();
    }
  }
});

test("two creation clicks before a render dispatch only one command", async () => {
  const creation = deferred<unknown>();
  const f = await fixture(async (call) =>
    call.commandId === "create" ? creation.promise : { threads: [] },
  );
  try {
    await f.render("parent", "panel");
    await f.click(f.button("New subagent"));
    const fresh = f.button("Start fresh");
    await act(async () => {
      fresh.click();
      fresh.click();
    });
    assert.equal(
      f.calls.filter((call) => call.commandId === "create").length,
      1,
    );
    assert.equal(f.button("Start fresh").disabled, true);
    assert.equal(f.button("Fork context").disabled, true);
    await act(async () => creation.resolve({ thread: { id: "created" } }));
    assert.deepEqual(f.routes, ["/threads/created?view=panel"]);
  } finally {
    await f.close();
  }
});

test("a late list reply cannot repopulate the panel after its parent changes", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const f = await fixture(async (call) => {
    assert.equal(call.commandId, "list");
    const input = call.input as { parentThreadId: string };
    return input.parentThreadId === "parent-a" ? first.promise : second.promise;
  });
  try {
    await f.render("parent-a", "panel");
    await f.render("parent-b", "panel");
    assert.deepEqual(
      f.calls.map((call) => call.input),
      [{ parentThreadId: "parent-a" }, { parentThreadId: "parent-b" }],
    );
    await act(async () =>
      second.resolve({ threads: [summary("child-b", "parent-b")] }),
    );
    assert.match(f.dom.window.document.body.textContent!, /child-b/);
    await act(async () =>
      first.resolve({
        threads: [
          summary("parent-b", "parent-a"),
          summary("stale-child", "parent-b"),
        ],
      }),
    );
    assert.doesNotMatch(f.dom.window.document.body.textContent!, /stale-child/);
    assert.match(f.dom.window.document.body.textContent!, /child-b/);
    assert.deepEqual(f.routes, []);
  } finally {
    await f.close();
  }
});

test("a late create reply from the old header parent does not navigate or refresh the new parent", async () => {
  const creation = deferred<unknown>();
  const f = await fixture(async (call) =>
    call.commandId === "create" ? creation.promise : { threads: [] },
  );
  try {
    await f.render("parent-a");
    await f.click(f.button("New subagent"));
    await f.click(f.button("Fork context"));
    await f.render("parent-b");
    const callsBeforeReply = f.calls.length;
    await act(async () => creation.resolve({ threadId: "child-of-parent-a" }));
    assert.deepEqual(f.routes, []);
    assert.equal(f.calls.length, callsBeforeReply);
    assert.equal(f.button("New subagent").disabled, false);
    assert.deepEqual(
      f.calls.filter((call) => call.commandId === "create")[0]?.input,
      { parentThreadId: "parent-a", mode: "fork" },
    );
  } finally {
    await f.close();
  }
});

test("disabling the plugin withdraws the header and ignores its pending creation", async () => {
  const creation = deferred<unknown>();
  const f = await fixture(async (call) =>
    call.commandId === "create" ? creation.promise : { threads: [] },
  );
  try {
    await f.render("parent");
    assert.ok(
      f.dom.window.document.querySelector("nav[aria-label='Subagents']"),
    );
    await f.click(f.button("New subagent"));
    await f.click(f.button("Start fresh"));
    await f.catalog.setEnabled("zenx-subagents", false);
    assert.deepEqual(f.catalog.pluginSnapshot().threadHeaders, []);
    await f.render("parent");
    assert.equal(
      f.dom.window.document.querySelector("nav[aria-label='Subagents']"),
      null,
    );
    assert.equal(
      f.dom.window.document.querySelector("[aria-label='New subagent']"),
      null,
    );
    await act(async () => creation.resolve({ threadId: "already-created" }));
    assert.deepEqual(f.routes, []);
  } finally {
    await f.close();
  }
});

test("the panel renders direct and nested descendants and explicitly reveals archived navigation", async () => {
  const threads = [
    summary("direct", "parent", { status: "active" }),
    summary("nested", "direct"),
    summary("archived", "parent", { archived: true }),
    summary("unrelated", "elsewhere"),
  ];
  const f = await fixture();
  try {
    await f.render("parent", "panel", threads);
    const rows = () => [
      ...f.dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".subagent-tree-row",
      ),
    ];
    assert.deepEqual(
      rows().map(
        (row) => row.querySelector(".subagent-tree-title")?.textContent,
      ),
      ["direct", "nested"],
    );
    assert.equal(
      rows()[0]?.querySelector(".subagent-tree-status")?.textContent,
      "Working",
    );
    assert.equal(
      rows()[1]?.closest("li")?.parentElement?.closest("li"),
      rows()[0]?.closest("li"),
    );
    await f.click(rows()[0]!);
    await f.click(rows()[1]!);
    await f.click(
      f.dom.window.document.querySelector<HTMLInputElement>(
        "input[type='checkbox']",
      )!,
    );
    assert.deepEqual(
      rows().map(
        (row) => row.querySelector(".subagent-tree-title")?.textContent,
      ),
      ["direct", "nested", "archived"],
    );
    assert.equal(
      rows()[2]?.querySelector(".subagent-tree-status")?.textContent,
      "Archived",
    );
    await f.click(rows()[2]!);
    assert.deepEqual(f.routes, [
      "/threads/direct?view=panel",
      "/threads/nested?view=panel",
      "/threads/archived?view=panel",
    ]);
    assert.doesNotMatch(f.dom.window.document.body.textContent!, /unrelated/);
  } finally {
    await f.close();
  }
});

test("the header navigates to the parent, directory and unarchived direct children", async () => {
  const f = await fixture();
  try {
    await f.render("parent", "header", [
      summary("parent", "ancestor"),
      summary("direct", "parent"),
      summary("nested", "direct"),
      summary("archived", "parent", { archived: true }),
    ]);
    assert.equal(
      f.dom.window.document.querySelector(".subagent-count")?.textContent,
      "1",
    );
    assert.deepEqual(
      [
        ...f.dom.window.document.querySelectorAll(".subagent-shortcuts button"),
      ].map((button) => button.textContent?.trim()),
      ["direct"],
    );
    await f.click(f.button("Parent"));
    await f.click(
      f.dom.window.document.querySelector<HTMLButtonElement>(
        ".subagents-directory",
      )!,
    );
    await f.click(f.button("direct"));
    assert.deepEqual(f.routes, [
      "/threads/ancestor",
      "/threads/parent?panel=zenx-subagents%3Asubagents",
      "/threads/direct?view=panel",
    ]);
  } finally {
    await f.close();
  }
});
