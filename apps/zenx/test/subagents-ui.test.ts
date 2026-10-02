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
  ThreadBreadcrumbAncestors,
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
    surface: "header" | "panel" | "breadcrumb" = "panel",
    threads: readonly NativeThreadSummary[] = [],
    snapshot: ZenXPluginSnapshot = catalog.pluginSnapshot(),
    active?: boolean,
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
          : surface === "breadcrumb"
            ? React.createElement(ThreadBreadcrumbAncestors, {
                threadId: parent,
                threads,
                navigate,
              })
            : React.createElement(GenericPluginUiHost, {
                registry,
                snapshot,
                pluginId: "zenx-subagents",
                surfaceId: "subagents-panel",
                context: {
                  threadId: parent,
                  threads,
                  ...(active === undefined ? {} : { active }),
                },
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

test("Side chat creation always forks full context without starting a task", async () => {
  const creation = deferred<unknown>();
  const f = await fixture(async (call) =>
    call.commandId === "create" ? creation.promise : { threads: [] },
  );
  try {
    await f.render("selected-parent", "panel");
    await f.click(f.button("New side chat"));
    assert.deepEqual(
      f.calls.filter((call) => call.commandId === "create"),
      [
        {
          pluginId: "zenx-subagents",
          commandId: "create",
          input: { parentThreadId: "selected-parent", mode: "side-chat" },
        },
      ],
    );
    assert.equal(
      f.calls.some((call) => call.commandId === "send"),
      false,
    );
    assert.deepEqual(f.routes, []);
    await act(async () => creation.resolve({ threadId: "side-chat" }));
    assert.deepEqual(f.routes, ["/threads/side-chat?view=panel"]);
  } finally {
    await f.close();
  }
});

test("two creation clicks before a render dispatch only one command", async () => {
  const creation = deferred<unknown>();
  const f = await fixture(async (call) =>
    call.commandId === "create" ? creation.promise : { threads: [] },
  );
  try {
    await f.render("parent", "panel");
    const fresh = f.button("New side chat");
    await act(async () => {
      fresh.click();
      fresh.click();
    });
    assert.equal(
      f.calls.filter((call) => call.commandId === "create").length,
      1,
    );
    assert.equal(f.button("New side chat").disabled, true);
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

test("a late create reply from the old panel parent does not navigate or refresh the new parent", async () => {
  const creation = deferred<unknown>();
  const f = await fixture(async (call) =>
    call.commandId === "create" ? creation.promise : { threads: [] },
  );
  try {
    await f.render("parent-a");
    await f.click(f.button("New side chat"));
    await f.render("parent-b");
    const callsBeforeReply = f.calls.length;
    await act(async () => creation.resolve({ threadId: "child-of-parent-a" }));
    assert.deepEqual(f.routes, []);
    assert.equal(f.calls.length, callsBeforeReply);
    assert.equal(f.button("New side chat").disabled, false);
    assert.deepEqual(
      f.calls.filter((call) => call.commandId === "create")[0]?.input,
      { parentThreadId: "parent-a", mode: "side-chat" },
    );
  } finally {
    await f.close();
  }
});

test("disabling the plugin withdraws the panel and ignores its pending creation", async () => {
  const creation = deferred<unknown>();
  const f = await fixture(async (call) =>
    call.commandId === "create" ? creation.promise : { threads: [] },
  );
  try {
    await f.render("parent");
    assert.ok(
      f.dom.window.document.querySelector(
        "section[aria-label='Subagent conversations']",
      ),
    );
    await f.click(f.button("New side chat"));
    await f.catalog.setEnabled("zenx-subagents", false);
    assert.deepEqual(f.catalog.pluginSnapshot().threadHeaders, []);
    await f.render("parent");
    assert.equal(
      f.dom.window.document.querySelector(
        "section[aria-label='Subagent conversations']",
      ),
      null,
    );
    assert.equal(
      f.dom.window.document.querySelector("[aria-label='New side chat']"),
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

test("the plugin provides only the Subagents panel, with no under-title directory strip", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.catalog.pluginSnapshot().threadHeaders, []);
    assert.deepEqual(
      subagentsManifest.ui.surfaces.map((surface) => surface.id),
      ["subagents-panel"],
    );
    await f.render("parent", "header", [summary("direct", "parent")]);
    assert.equal(f.dom.window.document.body.textContent, "");
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

test("topbar ancestors navigate full-screen without duplicating the current editable title", async () => {
  const f = await fixture();
  try {
    const threads = [
      summary("root", undefined, { name: "Main conversation" }),
      summary("parent", "root", { name: "Planning side chat" }),
      summary("current", "parent", { name: "Current title" }),
    ];
    await f.render("current", "breadcrumb", threads);
    assert.equal(
      f.dom.window.document.querySelector("nav")?.getAttribute("aria-label"),
      "Parent conversations",
    );
    assert.doesNotMatch(
      f.dom.window.document.body.textContent!,
      /Current title/,
    );
    await f.click(f.button("Main conversation"));
    await f.click(f.button("Planning side chat"));
    assert.deepEqual(f.routes, ["/threads/root", "/threads/parent"]);
    await f.render("root", "breadcrumb", threads);
    assert.equal(f.dom.window.document.body.textContent, "");
  } finally {
    await f.close();
  }
});

test("breadcrumb handles an unavailable parent and malformed cycles without looping", async () => {
  const f = await fixture();
  try {
    await f.render("child", "breadcrumb", [summary("child", "missing")]);
    await f.click(f.button("Parent conversation"));
    assert.deepEqual(f.routes, ["/threads/missing"]);
    await f.render("child", "breadcrumb", [
      summary("child", "parent"),
      summary("parent", "child"),
    ]);
    assert.equal(f.dom.window.document.querySelectorAll("button").length, 1);
  } finally {
    await f.close();
  }
});

test("a pending Side chat creation cannot navigate after its panel hides, even if it reopens", async () => {
  for (const reopen of [false, true]) {
    const creation = deferred<unknown>();
    const f = await fixture(async (call) =>
      call.commandId === "create" ? creation.promise : { threads: [] },
    );
    try {
      await f.render("parent", "panel", [], undefined, true);
      await f.click(f.button("New side chat"));
      await f.render("parent", "panel", [], undefined, false);
      if (reopen) await f.render("parent", "panel", [], undefined, true);
      const calls = f.calls.length;
      await act(async () =>
        creation.resolve({ threadId: "created-after-hide" }),
      );
      assert.deepEqual(f.routes, []);
      assert.equal(f.calls.length, calls);
    } finally {
      await f.close();
    }
  }
});
