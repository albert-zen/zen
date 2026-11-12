import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ConversationInformationCards } from "../src/renderer/src/ConversationInformationCards.js";
import { createPluginUiRegistry } from "../src/renderer/src/plugin-ui-host.js";
import { workspaceLauncherSnapshot } from "./workspace-launcher-snapshot.js";
import { i18n } from "../src/renderer/src/i18n.js";

test("information reads bounded current-owner facts and edits the exact trigger without executing it", async () => {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: unknown[] = [],
    routes: string[] = [];
  Object.assign(dom.window, {
    zenx: {
      plugins: {
        executeCommand: async (
          plugin: string,
          command: string,
          input?: unknown,
        ) => {
          calls.push([plugin, command, input]);
          if (command !== "sidebar-facts") return {};
          return {
            triggers: [
              {
                id: "exact/id",
                threadId: "owner",
                kind: "timer",
                active: true,
                label: "Daily review",
              },
              {
                id: "paused",
                threadId: "owner",
                kind: "timer",
                active: false,
                label: "Paused check",
                definitionRevision: 7,
              },
              {
                id: "foreign",
                threadId: "other",
                kind: "timer",
                active: true,
                label: "Other private trigger",
              },
            ],
          };
        },
        readHandle: async () => null,
      },
      shellPanel: {
        request: async (input: unknown) => {
          calls.push(input);
          return {
            host: "local",
            sessions: [],
            cwd: "/synthetic",
            canCreate: false,
          };
        },
      },
    },
  });
  const snapshot = {
    ...workspaceLauncherSnapshot,
    panels: [],
    plugins: workspaceLauncherSnapshot.plugins.map((p) => ({
      ...p,
      admissionId: "current",
    })),
    commands: [
      {
        key: "zenx-triggers:sidebar-facts",
        pluginId: "zenx-triggers",
        id: "sidebar-facts",
        title: "Facts",
        tool: "zenx_triggers_sidebar_facts",
      },
    ],
  };
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        React.createElement(ConversationInformationCards, {
          threadId: "owner",
          threads: [],
          snapshot,
          registry: createPluginUiRegistry(),
          theme: "light",
          navigate: (route) => routes.push(route),
        }),
      ),
    );
    assert.match(document.body.textContent!, /Daily reviewEnabled/);
    assert.match(document.body.textContent!, /Paused checkPaused/);
    assert.doesNotMatch(document.body.textContent!, /Other private trigger/);
    assert.doesNotMatch(document.body.textContent!, /No background commands/);
    const edit = document.querySelector<HTMLButtonElement>(
      '[aria-label="Edit · Daily review"]',
    )!;
    await act(async () => edit.click());
    assert.deepEqual(routes, [
      "/plugins/zenx-triggers/triggers?triggerId=exact%2Fid",
    ]);
    assert.deepEqual(calls.filter(Array.isArray), [
      ["zenx-triggers", "sidebar-facts", undefined],
    ]);
    const resume = document.querySelector<HTMLButtonElement>(
      '[aria-label="Enable trigger · Paused check"]',
    )!;
    assert.equal(resume.getAttribute("aria-checked"), "false");
    await act(async () => resume.click());
    assert.deepEqual(
      calls.filter((call) => Array.isArray(call) && call[1] === "resume"),
      [
        [
          "zenx-triggers",
          "resume",
          { triggerId: "paused", expectedRevision: 7 },
        ],
      ],
      "resume carries the exact definition revision read with these facts",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("streaming a long conversation does not clone or redraw the information catalog; real facts still update", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let active = true;
  let sessions: import("../../../src/shell-session.js").ShellSessionSummary[] =
    [];
  Object.assign(dom.window, {
    zenx: {
      plugins: {
        executeCommand: async () => ({
          triggers: [
            {
              id: "timer",
              threadId: "owner",
              kind: "timer",
              label: "Live trigger",
              active,
            },
          ],
        }),
        readHandle: async () => null,
      },
      shellPanel: {
        request: async () => ({
          sessions,
          host: "local",
          cwd: "/synthetic",
          canCreate: false,
        }),
      },
    },
  });
  const snapshot = {
    ...workspaceLauncherSnapshot,
    plugins: workspaceLauncherSnapshot.plugins.map((p) => ({
      ...p,
      admissionId: "current",
    })),
    commands: [
      {
        key: "zenx-triggers:sidebar-facts",
        pluginId: "zenx-triggers",
        id: "sidebar-facts",
        title: "Facts",
        tool: "zenx_triggers_sidebar_facts",
      },
    ],
  };
  let threads: import("../../../src/thread-summary.js").NativeThreadSummary[] =
    Array.from({ length: 4000 }, (_, index) => ({
      threadId: `child-${index}`,
      parentThreadId: "owner",
      name: `Child ${index}`,
      status: "idle",
      archived: false,
      preview: "Synthetic bounded summary. ".repeat(16),
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      currentMetadata: {
        model: "fake",
        provider: "fake",
        cwd: "/synthetic",
        sandbox: "read-only",
        approvalPolicy: "never",
      },
    }));
  let lineageRenders = 0,
    clones = 0;
  const routes: string[] = [];
  const registry = createPluginUiRegistry();
  registry.registerTrusted("zenx/bundled/subagents-ui", {
    "subagents-panel": ({ sdk }) => {
      lineageRenders++;
      const rows = sdk.context.threads as typeof threads;
      assert.ok(
        Object.isFrozen(rows) && Object.isFrozen(rows[0]),
        "plugin context isolation is retained",
      );
      return React.createElement(
        "button",
        {
          id: "lineage-probe",
          onClick: () => sdk.navigation.navigate("/threads/child-1"),
        },
        `${rows[1]!.name} ${rows[1]!.status}`,
      );
    },
  });
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = ((
    value: unknown,
    options?: StructuredSerializeOptions,
  ) => {
    if (value && typeof value === "object" && "threads" in value) clones++;
    return clone(value, options);
  }) as typeof structuredClone;
  const root = createRoot(document.getElementById("root")!);
  const history = "Synthetic long conversation transcript.\n".repeat(5000);
  const render = (delta: number) =>
    act(async () =>
      root.render(
        React.createElement(
          "div",
          null,
          React.createElement("pre", null, history + delta),
          React.createElement(ConversationInformationCards, {
            threadId: "owner",
            threads,
            snapshot,
            registry,
            theme: "light",
            navigate: (route) => routes.push(`${delta}:${route}`),
          }),
        ),
      ),
    );
  try {
    await render(0);
    assert.equal(clones, 1);
    const initialRenders = lineageRenders;
    for (let delta = 1; delta <= 30; delta++) await render(delta);
    assert.equal(
      clones,
      1,
      "30 transcript deltas cannot clone the 4,000-thread catalog again",
    );
    assert.equal(
      lineageRenders,
      initialRenders,
      "unrelated deltas do not redraw lineage",
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("#lineage-probe")!.click(),
    );
    assert.deepEqual(
      routes,
      ["30:/threads/child-1"],
      "memoized surface still uses latest navigation closure",
    );
    threads = threads.map((row, index) =>
      index === 1 && row.status !== "systemError"
        ? { ...row, name: "Updated child", status: "active" as const }
        : row,
    );
    await render(31);
    assert.equal(clones, 2, "canonical summary change refreshes exactly once");
    assert.match(
      document.querySelector("#lineage-probe")!.textContent!,
      /Updated child active/,
    );
    active = false;
    threads = [
      ...threads,
      {
        ...threads[0]!,
        threadId: "owner",
        status: "idle",
        lastTurnEnd: {
          id: "completed-change",
          turnId: "synthetic-turn",
          position: 1,
          createdAt: "2026-11-03T00:00:00Z",
        },
      } as (typeof threads)[number],
    ];
    await render(32);
    assert.match(
      document.querySelector(".information-trigger-list")!.textContent!,
      /Live triggerPaused/,
      "completed owner Turn refreshes facts without waiting for focus",
    );
    active = true;
    // Returning focus re-reads bounded trigger facts; there is no manual
    // refresh control in the always-visible card header.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.match(
      document.querySelector(".information-trigger-list")!.textContent!,
      /Live triggerEnabled/,
    );
    sessions = [
      {
        taskId: "native-command",
        threadId: "owner",
        origin: "agent",
        kind: "command",
        command: "synthetic live command",
        cwd: "/synthetic",
        createdAt: "2026-11-01T00:00:00Z",
        status: "running",
        exitCode: null,
        lifecycle: { foreground: "running", stdio: "open" },
        inputAvailable: false,
        retained: false,
      },
    ];
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    assert.match(
      document.querySelector(".background-shell-list")!.textContent!,
      /synthetic live commandRunning/,
    );
    const app = await (
      await import("node:fs/promises")
    ).readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
    assert.match(
      app,
      /const activeSummaries = useMemo\([\s\S]*?\[threadSummaries, titleSnapshot\]/,
    );
    assert.match(
      app,
      /const archivedSummaries = useMemo\([\s\S]*?\[archivedThreadSummaries, titleSnapshot\]/,
    );
    assert.match(
      app,
      /const informationThreads = useMemo\([\s\S]*?\[activeSummaries, archivedSummaries\]/,
    );
    assert.match(
      app,
      /<(?:ConversationInformationCards|EditableInformationPanel)[\s\S]*?threads=\{informationThreads\}/,
    );
  } finally {
    await act(async () => root.unmount());
    globalThis.structuredClone = clone;
    dom.window.close();
  }
});

test("trigger retry is failure-only and switches fence repeated, failed, and retired-owner intents", async () => {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let readFails = true,
    reads = 0;
  const writes: unknown[] = [];
  let failWrite!: (error: Error) => void;
  Object.assign(dom.window, {
    zenx: {
      plugins: {
        executeCommand: async (
          _plugin: string,
          command: string,
          input?: unknown,
        ) => {
          if (command === "sidebar-facts") {
            reads++;
            if (readFails) throw new Error("Synthetic unavailable facts");
            return {
              triggers: [
                {
                  id: "active",
                  threadId: "owner",
                  kind: "timer",
                  active: true,
                  label: "Synthetic active",
                  definitionRevision: 8,
                },
                {
                  id: "legacy",
                  threadId: "owner",
                  kind: "timer",
                  active: false,
                  label: "Unknown revision",
                },
              ],
            };
          }
          writes.push([command, input]);
          return new Promise((_resolve, reject) => {
            failWrite = reject;
          });
        },
      },
    },
  });
  const snapshot = {
    ...workspaceLauncherSnapshot,
    plugins: workspaceLauncherSnapshot.plugins.map((p) => ({
      ...p,
      admissionId: "current",
    })),
    commands: [
      {
        key: "zenx-triggers:sidebar-facts",
        pluginId: "zenx-triggers",
        id: "sidebar-facts",
        title: "Facts",
        tool: "zenx_triggers_sidebar_facts",
      },
    ],
  };
  const root = createRoot(document.getElementById("root")!);
  const render = (threadId: string) =>
    act(async () =>
      root.render(
        React.createElement(ConversationInformationCards, {
          threadId,
          threads: [],
          snapshot,
          registry: createPluginUiRegistry(),
          theme: "light",
          navigate: () => {},
          types: ["triggers"],
          manageMode: false,
        }),
      ),
    );
  try {
    await render("owner");
    const retry = document.querySelector<HTMLButtonElement>("header button");
    assert.ok(retry, "cold read failure stays reachable outside Customize");
    assert.equal(retry.textContent, "Retry");
    readFails = false;
    await act(async () => retry.click());
    assert.equal(document.querySelector("header button"), null);
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Enable trigger · Unknown revision"]',
      )!.disabled,
      true,
    );
    assert.equal(
      document
        .querySelector('[aria-label="Enable trigger · Unknown revision"]')!
        .getAttribute("aria-disabled"),
      "true",
    );
    const pause = document.querySelector<HTMLButtonElement>(
      '[aria-label="Pause trigger · Synthetic active"]',
    )!;
    const propsKey = Object.keys(pause).find((key) =>
      key.startsWith("__reactProps$"),
    )!;
    const retainedClick = (
      pause as unknown as Record<string, { onClick(): void }>
    )[propsKey]!.onClick;
    await act(async () => {
      retainedClick();
      retainedClick();
    });
    assert.deepEqual(writes, [["cancel", { triggerId: "active" }]]);
    assert.equal(pause.getAttribute("aria-disabled"), "true");
    assert.equal(
      pause.disabled,
      false,
      "busy controls retain native keyboard focus",
    );
    const beforeFailureReads = reads;
    await act(async () => failWrite(new Error("Synthetic revision conflict")));
    assert.ok(
      reads > beforeFailureReads,
      "failure reconciles authoritative facts",
    );
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Synthetic revision conflict/,
    );
    assert.equal(
      pause.getAttribute("aria-checked"),
      "true",
      "failure cannot optimistically change Host state",
    );
    assert.equal(pause.disabled, false);
    assert.equal(pause.getAttribute("aria-disabled"), "false");
    readFails = true;
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.ok(
      document.querySelector("header button"),
      "failed refresh exposes Retry",
    );
    assert.equal(
      document.querySelector('[aria-label="Pause trigger · Synthetic active"]'),
      pause,
      "failed refresh retains the current owner's published content",
    );
    readFails = false;
    await render("other");
    assert.equal(
      document.querySelector('[role="alert"]'),
      null,
      "errors belong to the previous owner",
    );
    await act(async () => retainedClick());
    assert.equal(
      writes.length,
      1,
      "retained old-owner callback cannot mutate a trigger",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("empty facts hide cards while mounted providers automatically reveal new content", async () => {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let triggers: unknown[] = [];
  const visibility: boolean[] = [];
  Object.assign(dom.window, {
    zenx: {
      plugins: {
        executeCommand: async () => ({ triggers }),
        readHandle: async () => null,
      },
    },
  });
  const snapshot = {
    ...workspaceLauncherSnapshot,
    plugins: workspaceLauncherSnapshot.plugins.map((p) => ({
      ...p,
      admissionId: "live",
    })),
    commands: [
      {
        key: "zenx-triggers:sidebar-facts",
        pluginId: "zenx-triggers",
        id: "sidebar-facts",
        title: "Facts",
        tool: "zenx_triggers_sidebar_facts",
      },
    ],
  };
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        React.createElement(ConversationInformationCards, {
          threadId: "owner",
          threads: [],
          snapshot,
          registry: createPluginUiRegistry(),
          theme: "light",
          navigate() {},
          types: ["triggers"],
          onVisibilityChange: (value) => visibility.push(value),
        }),
      ),
    );
    assert.equal(visibility.at(-1), false);
    assert.equal(
      document.querySelector(".conversation-information-section"),
      null,
    );
    triggers = [
      {
        id: "new",
        threadId: "owner",
        kind: "timer",
        active: true,
        label: "Automatically appeared",
      },
    ];
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5100));
    });
    assert.equal(visibility.at(-1), true);
    assert.match(document.body.textContent!, /Automatically appeared/);
    assert.equal(
      document
        .querySelector(".information-trigger-list strong")!
        .getAttribute("title"),
      "Automatically appeared",
    );
    assert.equal(
      document.querySelector(".information-trigger-list small")!.className,
      "sr-only",
    );
    triggers = [];
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.equal(visibility.at(-1), false);
    assert.equal(
      document.querySelector(".conversation-information-section"),
      null,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("lineage visibility follows the provider's loaded descendants, not only global summaries", async () => {
  await i18n.changeLanguage("en");
  const { registerSubagentsUi } =
    await import("../src/renderer/src/subagents-ui.js");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let loaded: unknown[] = [];
  const visibility: boolean[] = [];
  Object.assign(dom.window, {
    zenx: {
      plugins: {
        executeCommand: async (_plugin: string, command: string) =>
          command === "list" ? { threads: loaded } : {},
        readHandle: async () => null,
      },
    },
  });
  const registry = createPluginUiRegistry();
  registerSubagentsUi(registry);
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        React.createElement(ConversationInformationCards, {
          threadId: "owner",
          threads: [],
          snapshot: workspaceLauncherSnapshot,
          registry,
          theme: "light",
          navigate() {},
          types: ["lineage"],
          onVisibilityChange: (value) => visibility.push(value),
        }),
      ),
    );
    assert.equal(visibility.at(-1), false);
    assert.equal(document.querySelector(".subagents-panel"), null);
    loaded = [
      {
        threadId: "provider-child",
        parentThreadId: "owner",
        name: "Provider-only child",
        status: "idle",
        archived: false,
      },
    ];
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5100));
    });
    assert.equal(visibility.at(-1), true);
    assert.match(document.body.textContent!, /Provider-only child/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("ordinary Trigger information returns to quiet after empty recovery and fences late owner failures", async () => {
  await i18n.changeLanguage("en");
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let mode: "fail" | "empty" | "pending" = "fail";
  let rejectOld!: (cause: Error) => void;
  const calls: string[] = [],
    visibility: boolean[] = [];
  Object.assign(dom.window, {
    zenx: {
      plugins: {
        executeCommand: async (_plugin: string, command: string) => {
          calls.push(command);
          if (mode === "fail") throw new Error("Synthetic cold failure");
          if (mode === "pending")
            return new Promise((_resolve, reject) => {
              rejectOld = reject;
            });
          return { triggers: [] };
        },
      },
    },
  });
  const snapshot = {
    ...workspaceLauncherSnapshot,
    plugins: workspaceLauncherSnapshot.plugins.map((plugin) => ({
      ...plugin,
      admissionId: "current",
    })),
    commands: [
      {
        key: "zenx-triggers:sidebar-facts",
        pluginId: "zenx-triggers",
        id: "sidebar-facts",
        title: "Facts",
        tool: "zenx_triggers_sidebar_facts",
      },
    ],
  };
  const root = createRoot(document.getElementById("root")!);
  const render = (threadId: string) =>
    act(async () =>
      root.render(
        React.createElement(ConversationInformationCards, {
          threadId,
          threads: [],
          snapshot,
          registry: createPluginUiRegistry(),
          theme: "light",
          navigate() {},
          types: ["triggers"],
          onVisibilityChange: (value) => visibility.push(value),
        }),
      ),
    );
  try {
    await render("failed");
    assert.equal(visibility.at(-1), true);
    const retry = document.querySelector<HTMLButtonElement>("header button");
    assert.ok(retry);
    mode = "empty";
    await act(async () => retry.click());
    assert.equal(visibility.at(-1), false);
    assert.equal(
      document.querySelector(".conversation-information-section"),
      null,
    );
    mode = "pending";
    await render("pending");
    mode = "empty";
    await render("current");
    await act(async () =>
      rejectOld(new Error("Synthetic retired owner failure")),
    );
    assert.equal(visibility.at(-1), false);
    assert.equal(
      document.querySelector(".conversation-information-section"),
      null,
    );
    assert.ok(
      calls.every((command) => command === "sidebar-facts"),
      "recovery only reads",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
