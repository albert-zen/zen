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
