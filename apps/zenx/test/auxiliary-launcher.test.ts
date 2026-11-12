import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { SideChatDraftContext } from "../src/renderer/src/subagents-ui.js";
import { i18n } from "../src/renderer/src/i18n.js";
import { workspaceLauncherSnapshot } from "./workspace-launcher-snapshot.js";

for (const language of ["en", "zh-CN"]) {
  test(`${language}: plugin launch rows describe their purpose and keep quick-create independent`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "https://zenx.local/",
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
      React,
    });
    const calls: unknown[][] = [];
    const routes: string[] = [];
    const draftRequests: unknown[] = [];
    dom.window.zenx = {
      plugins: {
        executeCommand: async (...args: unknown[]) => {
          calls.push(args);
          return { threadId: "new-child" };
        },
        readHandle: async () => null,
      },
    } as any;
    await i18n.changeLanguage(language);
    function Harness() {
      const [selectedTab, onSelectTab] = useState("");
      return React.createElement(AuxiliaryPanel, {
        threadId: "parent",
        title: "Synthetic parent",
        open: true,
        onOpenChange() {},
        selectedTab,
        onSelectTab,
        snapshot: workspaceLauncherSnapshot,
        navigate: (route) => routes.push(route),
      });
    }
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () =>
        root.render(
          React.createElement(
            SideChatDraftContext.Provider,
            {
              value: async (input) => {
                draftRequests.push(input);
              },
            },
            React.createElement(Harness),
          ),
        ),
      );
      const rows = [
        ...document.querySelectorAll<HTMLElement>(".workspace-plugin-choice"),
      ];
      assert.equal(rows.length, 2);
      const descriptions = rows.map(
        (row) => row.querySelector("small")?.textContent,
      );
      assert.deepEqual(
        descriptions,
        language === "en"
          ? [
              "View delegated work and side chats",
              "Set up and inspect conversation triggers",
            ]
          : ["查看委派任务与旁支会话", "设置和查看此会话的触发器"],
      );
      assert.equal(rows[0]!.querySelectorAll("button").length, 2);
      assert.equal(rows[1]!.querySelectorAll("button").length, 1);
      assert.equal(
        rows[1]!.querySelector("strong")?.textContent,
        language === "en" ? "Triggers" : "触发器",
      );
      assert.ok(
        rows[1]!.querySelector('svg[data-icon="trigger"] circle'),
        "Triggers launcher uses clock artwork",
      );
      const quickCreate = rows[0]!.querySelector<HTMLButtonElement>(
        ".subagent-create-button",
      )!;
      assert.ok(
        quickCreate.classList.contains("subagent-create-button-compact"),
      );
      assert.notEqual(
        rows[0]!.querySelector("svg")?.innerHTML,
        rows[1]!.querySelector("svg")?.innerHTML,
      );
      await act(async () => {
        quickCreate.click();
        quickCreate.click();
      });
      assert.deepEqual(calls, []);
      assert.deepEqual(draftRequests, [{ parentThreadId: "parent" }]);
      assert.deepEqual(routes, []);
      assert.equal(document.querySelectorAll('[role="tab"]').length, 0);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      await i18n.changeLanguage("en");
    }
  });
}

test("launcher sizing applies only to primary rows and the compact action is circular", () => {
  const css = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    css,
    /\.workspace-tab-types button\s*\{\s*min-height: 64px/,
  );
  assert.match(
    css,
    /\.workspace-plugin-choice \.subagent-create-button-compact\s*\{[^}]*width: 32px;[^}]*height: 32px;[^}]*min-height: 32px;[^}]*border-radius: 50%;/,
  );
});
