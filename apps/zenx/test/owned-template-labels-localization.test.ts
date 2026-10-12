import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as ts from "typescript";
import { chooseValue } from "./choice-interaction.js";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { BrowserThreadPanel } from "../src/renderer/src/browser-thread-panel.js";
import { ComputerThreadPanel } from "../src/renderer/src/computer-thread-panel.js";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type { ComputerThreadEvent } from "../src/main/capabilities/computer-thread-observation.js";
import type { BrowserThreadEvent } from "../src/main/capabilities/browser-thread-observation.js";

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.test/",
    pretendToBeVisual: true,
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
  Object.defineProperty(document, "visibilityState", { get: () => "visible" });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const root = createRoot(document.getElementById("root")!);
  return {
    dom,
    root,
    async close() {
      await act(async () => {
        root.unmount();
        await i18n.changeLanguage("en");
      });
      dom.window.close();
    },
  };
}

test("side-panel and tab-close names translate live while raw titles, child state and tab IDs stay intact", async () => {
  const { dom, root, close } = fixture();
  Object.assign(window, { zenx: {} });
  const title = '保留 <parent & "title">';
  const childTitle = 'Child <b> & "原文"';
  const childId = "child/id";
  const selections: string[] = [];
  const tabChanges: string[][] = [];
  let mounts = 0;
  function Conversation() {
    const [draft, setDraft] = useState("Raw draft <&>");
    useEffect(() => {
      mounts += 1;
    }, []);
    return React.createElement("input", {
      value: draft,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        setDraft(event.target.value),
    });
  }
  try {
    await act(async () => {
      await i18n.changeLanguage("en");
      root.render(
        React.createElement(AuxiliaryPanel, {
          threadId: "parent-id",
          title,
          open: true,
          onOpenChange: () =>
            assert.fail("language switch must not close the panel"),
          snapshot: null,
          selectedTab: `thread:${childId}`,
          onSelectTab: (value) => selections.push(value),
          openedTabs: [`thread:${childId}`],
          onTabsChange: (value) => tabChanges.push(value),
          conversation: {
            threadId: childId,
            title: childTitle,
            render: () => React.createElement(Conversation),
          },
        }),
      );
    });
    const panel = document.querySelector("aside")!;
    const button = document.querySelector<HTMLButtonElement>(
      ".workspace-tab-close",
    )!;
    const tab = document.querySelector('[role="tab"]')!;
    const input = document.querySelector("input")!;
    assert.equal(panel.getAttribute("aria-label"), `Side panel for ${title}`);
    assert.equal(button.getAttribute("aria-label"), `Close tab ${childTitle}`);
    assert.equal(button.title, `Close tab ${childTitle}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Edited unsent draft <&>");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      document
        .querySelector<HTMLButtonElement>('[aria-label="Expand side panel"]')!
        .click();
      panel.querySelector('[role="separator"]')!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
        }),
      );
    });
    const width = panel.style.getPropertyValue("--auxiliary-width");
    const selectedBefore = [...selections];
    const tabsBefore = structuredClone(tabChanges);
    await act(async () => i18n.changeLanguage("zh-CN"));
    assert.equal(panel.getAttribute("aria-label"), `${title} 的侧边面板`);
    assert.equal(button.getAttribute("aria-label"), `关闭标签页 ${childTitle}`);
    assert.equal(button.title, `关闭标签页 ${childTitle}`);
    assert.equal(document.querySelector("aside"), panel);
    assert.equal(document.querySelector(".workspace-tab-close"), button);
    assert.equal(document.querySelector("input"), input);
    assert.equal(input.value, "Edited unsent draft <&>");
    assert.equal(mounts, 1);
    assert.equal(panel.dataset.expanded, "true");
    assert.equal(panel.style.getPropertyValue("--auxiliary-width"), width);
    assert.equal(tab.getAttribute("aria-selected"), "true");
    assert.equal(tab.getAttribute("title"), childTitle);
    assert.deepEqual(selections, selectedBefore);
    assert.deepEqual(tabChanges, tabsBefore);
    assert.equal(
      document.querySelector("b"),
      null,
      "raw title is escaped by React",
    );
    await act(async () => i18n.changeLanguage("en"));
    assert.equal(button.title, `Close tab ${childTitle}`);
    assert.equal(document.querySelector("input"), input);
    await act(async () => button.click());
    assert.deepEqual(tabChanges.at(-1), []);
    assert.equal(selections.at(-1), "");
  } finally {
    await close();
  }
});

test("Browser name and Computer action tooltip translate without resetting pinned targets, frames or subscriptions", async () => {
  const { root, close } = fixture();
  const title = 'Keep <Browser & "title">';
  const invocationId = 'raw-invocation/<&"中文';
  const requests: Record<string, unknown[]> = { browser: [], computer: [] };
  let browserListener: ((event: BrowserThreadEvent) => void) | undefined;
  let computerListener: ((event: ComputerThreadEvent) => void) | undefined;
  let stops = 0;
  const browserTargets: BrowserThreadEvent = {
    type: "targets",
    targets: [
      {
        id: "raw-page/id",
        sessionId: "session-id",
        tabId: "tab-id",
        title,
        url: "https://example.test/raw",
        loading: false,
        mode: "live",
      },
    ],
    selectedId: "raw-page/id",
  };
  const computerTargets: ComputerThreadEvent = {
    type: "targets",
    targets: [
      {
        id: "raw-window/id",
        invocationId,
        mode: "live",
        target: { pid: 101, windowTitle: "Raw window <&>" },
      },
    ],
    selectedId: "raw-window/id",
  };
  const targetsBefore = structuredClone({ browserTargets, computerTargets });
  Object.assign(window, {
    zenx: {
      browserObservation: {
        subscribe(request: unknown, next: (event: BrowserThreadEvent) => void) {
          requests.browser!.push(request);
          browserListener = next;
          next(browserTargets);
          next({
            type: "status",
            status: "live",
            message: "Raw provider status",
          });
          return () => {
            stops += 1;
          };
        },
      },
      computerObservation: {
        subscribe(
          request: unknown,
          next: (event: ComputerThreadEvent) => void,
        ) {
          requests.computer!.push(request);
          computerListener = next;
          next(computerTargets);
          next({
            type: "status",
            status: "live",
            message: "Raw provider status",
          });
          return () => {
            stops += 1;
          };
        },
      },
    },
  });
  try {
    await act(async () => {
      await i18n.changeLanguage("en");
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(BrowserThreadPanel, {
            threadId: "raw-browser-thread",
            title,
            open: true,
            onOpenChange: () =>
              assert.fail("locale switch must not close Browser"),
            providerRevision: 1,
          }),
          React.createElement(ComputerThreadPanel, {
            threadId: "raw-computer-thread",
            active: true,
          }),
        ),
      );
    });
    const browser = document.querySelector<HTMLElement>(
      ".browser-thread-panel",
    )!;
    const computer = document.querySelector<HTMLButtonElement>(
      ".computer-thread-panel .ui-select",
    )!;
    assert.equal(browser.getAttribute("aria-label"), `Browser for ${title}`);
    assert.equal(computer.title, `Latest Computer action ${invocationId}`);
    await chooseValue(
      document.querySelector<HTMLButtonElement>("#thread-browser-target")!,
      "raw-page/id",
    );
    await chooseValue(computer, "raw-window/id");
    assert.deepEqual(requests.browser!.at(-1), {
      threadId: "raw-browser-thread",
      frames: true,
      targetId: "raw-page/id",
    });
    assert.deepEqual(requests.computer!.at(-1), {
      threadId: "raw-computer-thread",
      frames: true,
      targetId: "raw-window/id",
    });
    await act(async () => {
      browserListener?.({
        type: "frame",
        frame: {
          sequence: 1,
          mimeType: "image/jpeg",
          data: "YQ==",
          width: 100,
          height: 80,
        },
      });
      computerListener?.({
        type: "frame",
        frame: {
          sequence: 1,
          mimeType: "image/jpeg",
          data: "Yg==",
          width: 100,
          height: 80,
          capturedAt: new Date().toISOString(),
        },
      });
    });
    const requestsBefore = structuredClone(requests);
    const stopsBefore = stops;
    const images = [...document.querySelectorAll("img")];
    assert.equal(images.length, 2, "both pinned previews must have a frame");
    const sources = images.map((image) => image.src);
    assert.ok(
      sources.every((source) => source.startsWith("data:image/jpeg;base64,")),
    );
    for (const language of ["zh-CN", "en", "zh-CN"]) {
      await act(async () => i18n.changeLanguage(language));
      assert.equal(
        browser.getAttribute("aria-label"),
        language === "en" ? `Browser for ${title}` : `${title} 的浏览器`,
      );
      assert.equal(
        computer.title,
        language === "en"
          ? `Latest Computer action ${invocationId}`
          : `最新计算机操作 ${invocationId}`,
      );
      assert.equal(document.querySelector(".browser-thread-panel"), browser);
      assert.equal(
        document.querySelector(".computer-thread-panel .ui-select"),
        computer,
      );
      assert.equal(computer.dataset.value, "raw-window/id");
      assert.equal(
        document.querySelector<HTMLElement>("#thread-browser-target")!.dataset
          .value,
        "raw-page/id",
      );
      const currentImages = [...document.querySelectorAll("img")];
      assert.equal(currentImages.length, images.length);
      images.forEach((image, index) =>
        assert.equal(currentImages[index], image),
      );
      assert.deepEqual(
        images.map((image) => image.src),
        sources,
      );
      assert.deepEqual(requests, requestsBefore);
      assert.equal(stops, stopsBefore);
      assert.deepEqual({ browserTargets, computerTargets }, targetsBefore);
    }
  } finally {
    await close();
  }
});

test("Room message-role names use the existing translated roles while preserving messages, draft and command payloads", async () => {
  const { dom, root, close } = fixture();
  Object.assign(window, { zenx: { threads: { list: async () => [] } } });
  const messages = (["human", "agent", "system"] as const).map((kind) => ({
    id: `raw-${kind}/id`,
    roomId: "raw-room/id",
    author: `Raw ${kind} author <&>`,
    text: `Raw ${kind} body <&>`,
    kind,
    createdAt: 0,
    originThreadId: null,
    originTurnId: null,
  }));
  const originalMessages = structuredClone(messages);
  const calls: Array<{ id: string; input: unknown }> = [];
  const sdk = {
    commands: {
      execute: async (id: string, input: unknown) => {
        calls.push({ id, input });
        assert.equal(
          id,
          "list",
          "locale switch must not send or modify messages",
        );
        return {
          rooms: [
            {
              id: "raw-room/id",
              name: "Raw room <&>",
              members: [],
              messages,
              createdAt: 0,
            },
          ],
        };
      },
    },
  } as unknown as PluginUiSdkV1;
  try {
    await act(async () => {
      await i18n.changeLanguage("en");
      root.render(React.createElement(RoomsPage, { sdk }));
    });
    const roles = [...document.querySelectorAll(".room-role")];
    assert.deepEqual(
      roles.map((role) => role.getAttribute("aria-label")),
      ["Message role: You", "Message role: Agent", "Message role: System"],
    );
    const articles = [...document.querySelectorAll(".room-message")];
    const input =
      document.querySelector<HTMLTextAreaElement>("#room-chat-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "Raw unsent draft <&> 中文");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(input.value, "Raw unsent draft <&> 中文");
    const callsBefore = structuredClone(calls);
    for (const language of ["zh-CN", "en", "zh-CN"]) {
      await act(async () => i18n.changeLanguage(language));
      assert.deepEqual(
        roles.map((role) => role.getAttribute("aria-label")),
        language === "en"
          ? ["Message role: You", "Message role: Agent", "Message role: System"]
          : ["消息角色：你", "消息角色：Agent", "消息角色：系统"],
      );
      assert.deepEqual(
        roles.map((role) => role.textContent),
        language === "en"
          ? ["You", "Agent", "System"]
          : ["你", "Agent", "系统"],
      );
      const currentRoles = [...document.querySelectorAll(".room-role")];
      const currentArticles = [...document.querySelectorAll(".room-message")];
      assert.equal(currentRoles.length, roles.length);
      assert.equal(currentArticles.length, articles.length);
      roles.forEach((role, index) => assert.equal(currentRoles[index], role));
      articles.forEach((article, index) =>
        assert.equal(currentArticles[index], article),
      );
      assert.equal(document.querySelector("#room-chat-input"), input);
      assert.equal(input.value, "Raw unsent draft <&> 中文");
      assert.deepEqual(calls, callsBefore);
      assert.deepEqual(messages, originalMessages);
      for (const message of messages) {
        assert.ok(document.body.textContent?.includes(message.author));
        assert.ok(document.body.textContent?.includes(message.text));
      }
    }
  } finally {
    await close();
  }
});

test("the five owned label wrappers cannot regress to English template-expression attributes", async () => {
  const files = [
    "auxiliary-panel.tsx",
    "browser-thread-panel.tsx",
    "computer-thread-panel.tsx",
    "bundled-automation-ui.tsx",
  ];
  const untranslated: string[] = [];
  for (const name of files) {
    const source = await readFile(
      new URL(`../src/renderer/src/${name}`, import.meta.url),
      "utf8",
    );
    const file = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    function visit(node: ts.Node, attribute?: string): void {
      if (ts.isJsxAttribute(node)) attribute = node.name.getText(file);
      if (
        (attribute === "aria-label" || attribute === "title") &&
        ts.isTemplateExpression(node) &&
        /^(?:Side panel for |Close tab |Browser for |Latest Computer action |Message role: )/u.test(
          node.head.text,
        )
      ) {
        untranslated.push(
          `${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${attribute}`,
        );
      }
      ts.forEachChild(node, (child) => visit(child, attribute));
    }
    visit(file);
  }
  assert.deepEqual(untranslated, []);
});
