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
  ChildThreadSidebarContext,
  SubagentCreationModelsContext,
  PluginThreadHeaders,
  ThreadBreadcrumbAncestors,
  registerSubagentsUi,
} from "../src/renderer/src/subagents-ui.js";

import type { ModelSummary } from "../src/protocol-client/index.js";
import { encodeModelKey } from "../../../src/protocol/model-key.js";

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
  sidebar?: React.ContextType<typeof ChildThreadSidebarContext>,
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
  const modelCatalog: { models: ModelSummary[]; error: string | null } = {
    models: [],
    error: null,
  };
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
    surface: "header" | "panel" | "breadcrumb" | "quick-create" = "panel",
    threads: readonly NativeThreadSummary[] = [],
    snapshot: ZenXPluginSnapshot = catalog.pluginSnapshot(),
    active?: boolean,
  ) => {
    await act(async () => {
      root.render(
        React.createElement(
          ChildThreadSidebarContext.Provider,
          { value: sidebar ?? null },
          React.createElement(
            SubagentCreationModelsContext.Provider,
            { value: { ...modelCatalog } },
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
                      quickCreate: surface === "quick-create",
                      threads,
                      ...(active === undefined ? {} : { active }),
                    },
                    theme: "light",
                    navigate,
                    executeCommand,
                    readHandle,
                  }),
          ),
        ),
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
    modelCatalog,
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

test("chooser quick-create reuses side-chat creation without loading the tree", async () => {
  const f = await fixture(async () => ({ threadId: "quick-child" }));
  try {
    await f.render("parent", "quick-create");
    assert.deepEqual(f.calls, []);
    assert.equal(
      f.dom.window.document.querySelector(".subagent-create-button span"),
      null,
    );
    await f.click(f.button("New side chat"));
    assert.deepEqual(f.calls, [
      {
        pluginId: "zenx-subagents",
        commandId: "create",
        input: { parentThreadId: "parent", mode: "side-chat" },
      },
    ]);
    assert.deepEqual(f.routes, ["/threads/quick-child?view=panel"]);
  } finally {
    await f.close();
  }
});

function creationModel(
  profile: string,
  id: string,
  efforts: string[],
): ModelSummary {
  return {
    id: encodeModelKey({ providerProfileId: profile, modelId: id }),
    model: id,
    displayName: "Shared model",
    description: "",
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: efforts[0] ?? null,
    inputModalities: ["text"],
    isDefault: false,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
  };
}

async function chooseCreationOption(
  f: Awaited<ReturnType<typeof fixture>>,
  label: string,
  value: string,
) {
  const trigger = f.button(label);
  await act(async () =>
    trigger.dispatchEvent(
      new f.dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
      }),
    ),
  );
  const option = [
    ...f.dom.window.document.querySelectorAll<HTMLElement>("[role='option']"),
  ].find((entry) => entry.dataset.value === value);
  assert.ok(option, `Missing option ${value}`);
  await f.click(option);
}

test("side chat model and effort are exact creation arguments; no task starts", async () => {
  const f = await fixture(async (call) =>
    call.commandId === "create"
      ? { threadId: "configured-child" }
      : { threads: [] },
  );
  const first = creationModel("provider-a", "shared", ["low", "high"]);
  const second = creationModel("provider-b", "shared", ["medium", "xhigh"]);
  f.modelCatalog.models = [first, second];
  try {
    await f.render("parent", "panel");
    await f.click(f.button("Side chat model settings"));
    await chooseCreationOption(f, "Child model", second.id);
    await chooseCreationOption(f, "Reasoning effort", "xhigh");
    await f.click(f.button("Side chat model settings"));
    await f.click(f.button("New side chat"));
    assert.deepEqual(
      f.calls
        .filter((call) => call.commandId === "create")
        .map((call) => call.input),
      [
        {
          parentThreadId: "parent",
          mode: "side-chat",
          model: second.id,
          effort: "xhigh",
        },
      ],
    );
    assert.equal(
      f.calls.some((call) => call.commandId === "send"),
      false,
    );
    assert.deepEqual(f.routes, ["/threads/configured-child?view=panel"]);
  } finally {
    await f.close();
  }
});

test("changing model clears effort and changing parent resets creation choices", async () => {
  const f = await fixture(async (call) =>
    call.commandId === "create" ? { threadId: "child" } : { threads: [] },
  );
  const first = creationModel("a", "reasoning", ["high"]);
  const second = creationModel("b", "text-only", []);
  f.modelCatalog.models = [first, second];
  try {
    await f.render("parent", "panel");
    await f.click(f.button("Side chat model settings"));
    await chooseCreationOption(f, "Child model", first.id);
    await chooseCreationOption(f, "Reasoning effort", "high");
    await chooseCreationOption(f, "Child model", second.id);
    assert.equal(f.button("Reasoning effort").dataset.value, "");
    assert.equal(f.button("Reasoning effort").disabled, true);
    await f.click(f.button("Side chat model settings"));
    await f.click(f.button("New side chat"));
    assert.deepEqual(
      f.calls.find((call) => call.commandId === "create")?.input,
      { parentThreadId: "parent", mode: "side-chat", model: second.id },
    );
    await f.render("other", "panel");
    await f.click(f.button("Side chat model settings"));
    assert.equal(f.button("Child model").dataset.value, "");
    assert.equal(f.button("Reasoning effort").dataset.value, "");
  } finally {
    await f.close();
  }
});

test("removed models and unsupported efforts block creation until the user chooses again", async () => {
  const f = await fixture();
  const first = creationModel("a", "reasoning", ["high"]);
  f.modelCatalog.models = [first];
  try {
    await f.render("parent", "panel");
    await f.click(f.button("Side chat model settings"));
    await chooseCreationOption(f, "Child model", first.id);
    await chooseCreationOption(f, "Reasoning effort", "high");
    f.modelCatalog.models = [];
    await f.render("parent", "panel");
    assert.equal(f.button("New side chat").disabled, true);
    assert.match(
      f.dom.window.document.body.textContent!,
      /selected model or effort is unavailable/,
    );
    assert.equal(
      f.calls.some((call) => call.commandId === "create"),
      false,
    );
    await chooseCreationOption(f, "Child model", "");
    assert.equal(f.button("New side chat").disabled, false);
  } finally {
    await f.close();
  }
});

test("effort-only choices retain the inherited model and survive a failed creation", async () => {
  let attempts = 0;
  const f = await fixture(async (call) => {
    if (call.commandId !== "create") return { threads: [] };
    if (++attempts === 1) throw new Error("Host unavailable");
    return { threadId: "retried-child" };
  });
  f.modelCatalog.models = [creationModel("fake", "fake", ["low", "high"])];
  try {
    await f.render("parent", "panel", [summary("parent")]);
    await f.click(f.button("Side chat model settings"));
    await chooseCreationOption(f, "Reasoning effort", "high");
    await act(async () =>
      f.dom.window.document.activeElement?.dispatchEvent(
        new f.dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    await f.click(f.button("New side chat"));
    assert.match(f.dom.window.document.body.textContent!, /Host unavailable/);
    await f.click(f.button("New side chat"));
    assert.deepEqual(
      f.calls
        .filter((call) => call.commandId === "create")
        .map((call) => call.input),
      [
        { parentThreadId: "parent", mode: "side-chat", effort: "high" },
        { parentThreadId: "parent", mode: "side-chat", effort: "high" },
      ],
    );
    assert.deepEqual(f.routes, ["/threads/retried-child?view=panel"]);
  } finally {
    await f.close();
  }
});

test("an inherited effort invalidated by a catalog refresh cannot silently fall back", async () => {
  const f = await fixture();
  f.modelCatalog.models = [creationModel("fake", "fake", ["low", "high"])];
  try {
    await f.render("parent", "panel", [summary("parent")]);
    await f.click(f.button("Side chat model settings"));
    await chooseCreationOption(f, "Reasoning effort", "high");
    f.modelCatalog.models = [creationModel("fake", "fake", ["low"])];
    await f.render("parent", "panel", [summary("parent")]);
    assert.equal(f.button("New side chat").disabled, true);
    await chooseCreationOption(f, "Reasoning effort", "");
    assert.equal(f.button("New side chat").disabled, false);
    f.modelCatalog.error = "Catalog is unavailable";
    await f.render("parent", "panel", [summary("parent")]);
    assert.equal(
      f.button("New side chat").disabled,
      false,
      "omitted overrides keep native inheritance available",
    );
    assert.match(
      f.dom.window.document.body.textContent!,
      /Catalog is unavailable/,
    );
  } finally {
    await f.close();
  }
});

test("clear an effort-only override after its model loses selectable efforts", async () => {
  const f = await fixture();
  f.modelCatalog.models = [
    { ...creationModel("fake", "fake", ["low", "high"]), isDefault: true },
  ];
  try {
    await f.render("parent", "panel", [summary("parent")]);
    await f.click(f.button("Side chat model settings"));
    await chooseCreationOption(f, "Reasoning effort", "high");
    f.modelCatalog.models = [
      { ...creationModel("fake", "fake", []), isDefault: true },
    ];
    await f.render("parent", "panel", [summary("parent")]);
    assert.equal(f.button("New side chat").disabled, true);
    assert.equal(f.button("Reasoning effort").dataset.value, "high");
    assert.equal(
      f.button("Reasoning effort").disabled,
      false,
      "the stale effort must remain clearable to inheritance",
    );
    await chooseCreationOption(f, "Reasoning effort", "");
    assert.equal(f.button("New side chat").disabled, false);
  } finally {
    await f.close();
  }
});

test("each child has its own accessible Sidebar switch without changing navigation or siblings", async () => {
  const changes: Array<[string, boolean]> = [];
  const sidebar = {
    visibleSubagentThreadIds: [] as string[],
    setVisible: async (id: string, visible: boolean) => {
      changes.push([id, visible]);
      sidebar.visibleSubagentThreadIds = visible
        ? [...sidebar.visibleSubagentThreadIds, id]
        : sidebar.visibleSubagentThreadIds.filter((entry) => entry !== id);
    },
  };
  const f = await fixture(undefined, sidebar);
  const children = [
    summary("child-a", "parent", { name: "Research" }),
    summary("child-b", "parent"),
    summary("nested", "child-a"),
  ];
  const switchFor = (title: string) => f.button(`Show in sidebar: ${title}`);
  try {
    await f.render("parent", "panel", children);
    assert.equal(document.querySelectorAll('[role="switch"]').length, 3);
    const toggle = switchFor("Research");
    assert.equal(toggle.closest(".subagent-tree-row"), null);
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    toggle.focus();
    assert.equal(document.activeElement, toggle);
    await f.click(toggle);
    await f.render("parent", "panel", children);
    assert.equal(switchFor("Research").getAttribute("aria-checked"), "true");
    assert.equal(switchFor("child-b").getAttribute("aria-checked"), "false");
    assert.equal(switchFor("nested").getAttribute("aria-checked"), "false");
    assert.equal(
      document.activeElement,
      toggle,
      "switch retains keyboard focus",
    );
    await f.click(switchFor("nested"));
    await f.render("parent", "panel", children);
    await f.click(switchFor("Research"));
    await f.render("parent", "panel", children);
    assert.deepEqual(sidebar.visibleSubagentThreadIds, ["nested"]);
    assert.deepEqual(changes, [
      ["child-a", true],
      ["nested", true],
      ["child-a", false],
    ]);
    assert.deepEqual(
      f.routes,
      [],
      "visibility does not open or select a conversation",
    );
    await f.click(
      document.querySelector<HTMLButtonElement>(".subagent-tree-row")!,
    );
    assert.deepEqual(
      f.routes,
      ["/threads/child-a?view=panel"],
      "hidden child stays accessible",
    );
    assert.equal(children[0]!.parentThreadId, "parent");
  } finally {
    await f.close();
  }
});

test("failed visibility save keeps the switch unchanged and retryable without duplicate requests", async () => {
  let reject!: (reason: Error) => void;
  let attempts = 0;
  const sidebar = {
    visibleSubagentThreadIds: [] as string[],
    setVisible: async (_id: string, visible: boolean) => {
      attempts++;
      assert.equal(visible, true);
      if (attempts === 1)
        await new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
      else sidebar.visibleSubagentThreadIds = ["child"];
    },
  };
  const f = await fixture(undefined, sidebar);
  try {
    await f.render("parent", "panel", [summary("child", "parent")]);
    const toggle = f.button("Show in sidebar: child");
    toggle.focus();
    await act(async () => {
      toggle.click();
      toggle.click();
    });
    assert.equal(attempts, 1);
    assert.equal(
      toggle.disabled,
      false,
      "pending save must not disable DOM focus",
    );
    assert.equal(toggle.getAttribute("aria-disabled"), "true");
    assert.equal(document.activeElement, toggle);
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await act(async () => reject(new Error("Could not save visibility")));
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Could not save visibility/,
    );
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.getAttribute("aria-disabled"), "false");
    assert.equal(
      document.activeElement,
      toggle,
      "failed save retains focus for retry",
    );
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await f.click(toggle);
    await f.render("parent", "panel", [summary("child", "parent")]);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(
      document.activeElement,
      toggle,
      "successful save retains focus",
    );
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(attempts, 2);
    assert.deepEqual(f.routes, []);
  } finally {
    await f.close();
  }
});

test("child visibility retry preserves same-panel model and effort creation choices", async () => {
  let reject!: (reason: Error) => void;
  let attempts = 0;
  const sidebar = {
    visibleSubagentThreadIds: [] as string[],
    setVisible: async (id: string, visible: boolean) => {
      attempts++;
      assert.equal(id, "child-a");
      assert.equal(visible, true);
      if (attempts === 1)
        await new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
      else sidebar.visibleSubagentThreadIds = [id];
    },
  };
  const f = await fixture(
    async (call) =>
      call.commandId === "create"
        ? { threadId: "configured-child" }
        : { threads: [] },
    sidebar,
  );
  const model = creationModel("provider-b", "reasoning", ["low", "high"]);
  f.modelCatalog.models = [model];
  const children = [summary("child-a", "parent"), summary("child-b", "parent")];
  try {
    await f.render("parent", "panel", children);
    await f.click(f.button("Side chat model settings"));
    await chooseCreationOption(f, "Child model", model.id);
    await chooseCreationOption(f, "Reasoning effort", "high");
    await f.click(f.button("Side chat model settings"));
    const toggle = f.button("Show in sidebar: child-a");
    toggle.focus();
    await act(async () => {
      toggle.click();
      toggle.click();
    });
    assert.equal(attempts, 1);
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.getAttribute("aria-disabled"), "true");
    assert.equal(document.activeElement, toggle);
    await act(async () => reject(new Error("Visibility save failed")));
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Visibility save failed/,
    );
    assert.equal(document.activeElement, toggle);
    await f.click(toggle);
    await f.render("parent", "panel", children);
    assert.deepEqual(sidebar.visibleSubagentThreadIds, ["child-a"]);
    assert.equal(
      f.button("Show in sidebar: child-b").getAttribute("aria-checked"),
      "false",
    );
    assert.equal(document.activeElement, toggle);
    await f.click(f.button("Side chat model settings"));
    assert.equal(f.button("Child model").dataset.value, model.id);
    assert.equal(f.button("Reasoning effort").dataset.value, "high");
    await f.click(f.button("Side chat model settings"));
    await f.click(f.button("New side chat"));
    assert.deepEqual(
      f.calls
        .filter((call) => call.commandId === "create")
        .map((call) => call.input),
      [
        {
          parentThreadId: "parent",
          mode: "side-chat",
          model: model.id,
          effort: "high",
        },
      ],
    );
    assert.equal(
      f.calls.some((call) => /send|pin/i.test(call.commandId)),
      false,
    );
    assert.deepEqual(f.routes, ["/threads/configured-child?view=panel"]);
    assert.deepEqual(sidebar.visibleSubagentThreadIds, ["child-a"]);
    assert.equal(attempts, 2);
  } finally {
    await f.close();
  }
});
