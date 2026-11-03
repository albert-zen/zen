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
        executeCommand: async (plugin: string, command: string) => {
          calls.push([plugin, command]);
          assert.equal(command, "sidebar-facts");
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
    assert.match(document.body.textContent!, /No background commands/);
    const edit = document.querySelector<HTMLButtonElement>(
      '[aria-label="Edit · Daily review"]',
    )!;
    await act(async () => edit.click());
    assert.deepEqual(routes, [
      "/plugins/zenx-triggers/triggers?triggerId=exact%2Fid",
    ]);
    assert.deepEqual(calls.filter(Array.isArray), [
      ["zenx-triggers", "sidebar-facts"],
    ]);
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
    // Returning focus re-reads bounded trigger facts; there is no manual
    // refresh control in the always-visible card header.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.match(
      document.querySelector(".information-trigger-list")!.textContent!,
      /Live triggerPaused/,
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
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".background-shell-heading > button:last-child",
        )!
        .click(),
    );
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
      /<ConversationInformationCards[\s\S]*?threads=\{informationThreads\}/,
    );
  } finally {
    await act(async () => root.unmount());
    globalThis.structuredClone = clone;
    dom.window.close();
  }
});
