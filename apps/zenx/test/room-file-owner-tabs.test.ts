import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import { i18n } from "../src/renderer/src/i18n.js";
import {
  emptySidebarState,
  sidebarTabId,
  type ThreadSidebarTab,
} from "../src/thread-sidebar-state.js";

for (const language of ["en", "zh-CN"]) {
  test(`${language}: same-path Room labels preserve exact pointer/keyboard file routing and close identity`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "https://zenx.local/",
      pretendToBeVisual: true,
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      React,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const reads: string[] = [];
    const removed: string[] = [];
    const tabs: ThreadSidebarTab[] = [
      { kind: "file", path: "README.md", resourceThreadId: "private-a" },
      { kind: "file", path: "README.md", resourceThreadId: "private-b" },
    ];
    const ids = tabs.map(sidebarTabId);
    (window as any).zenx = {
      workspaceBrowser: { command: async () => [], onChanged: () => () => {} },
      workspaceFiles: {
        applications: async () => ({ platform: "linux", applications: {} }),
        list: async () => ({ path: ".", entries: [], truncated: false }),
        read: async (threadId: string, path: string) => {
          reads.push(threadId);
          return {
            path,
            text: `# Exact owner ${threadId === "private-a" ? "Alpha" : "Beta"}`,
            revision: "synthetic",
          };
        },
      },
    };
    await i18n.changeLanguage(language);
    const root = createRoot(document.getElementById("root")!);
    function Harness() {
      const [selectedTab, onSelectTab] = useState(ids[1]!);
      return React.createElement(AuxiliaryPanel, {
        conversationContext: {
          kind: "room",
          roomId: "synthetic-room",
          resourceThreads: [
            {
              threadId: "private-a",
              title: "成员 A",
              workspacePath: "/not-for-display/a",
            },
            {
              threadId: "private-b",
              title: "成员 B",
              workspacePath: "/not-for-display/b",
            },
          ],
        },
        presentationState: {
          ...emptySidebarState({ kind: "room", id: "synthetic-room" }),
          open: true,
          tabs,
          selectedTab,
        },
        title: "Room",
        snapshot: null,
        open: true,
        onOpenChange: () => {},
        selectedTab,
        onSelectTab,
        openedTabs: ids,
        onRemoveTab: (id) => removed.push(id),
      });
    }
    try {
      await act(async () => root.render(React.createElement(Harness)));
      const tab = (index: number) =>
        document.getElementById(`aux-tab-${ids[index]}`) as HTMLButtonElement;
      for (const [index, owner] of ["成员 A", "成员 B"].entries()) {
        assert.equal(
          tab(index).getAttribute("data-canonical-title"),
          "README.md",
        );
        assert.match(tab(index).getAttribute("aria-label")!, new RegExp(owner));
        assert.match(tab(index).title, new RegExp(owner));
        assert(
          tab(index)
            .querySelector(".workspace-room-file-label")
            ?.textContent?.includes(owner),
        );
        assert(!tab(index).getAttribute("aria-label")!.includes("private-"));
        assert(!tab(index).title.includes("not-for-display"));
        assert.match(
          tab(index)
            .parentElement!.querySelector(".workspace-tab-close")!
            .getAttribute("aria-label")!,
          new RegExp(owner),
        );
      }
      assert.equal(reads.at(-1), "private-b");
      await act(async () => tab(0).click());
      assert.equal(tab(0).getAttribute("aria-selected"), "true");
      assert.equal(reads.at(-1), "private-a");
      assert.match(
        document.querySelector('[role="tabpanel"]:not([hidden])')!.textContent!,
        /Exact owner Alpha/,
      );
      tab(0).focus();
      await act(async () =>
        tab(0).dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      assert.equal(document.activeElement, tab(1));
      assert.equal(tab(1).getAttribute("aria-selected"), "true");
      assert.match(
        document.querySelector('[role="tabpanel"]:not([hidden])')!.textContent!,
        /Exact owner Beta/,
      );
      await act(async () =>
        tab(1).dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "ArrowLeft",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      assert.equal(document.activeElement, tab(0));
      assert.match(
        document.querySelector('[role="tabpanel"]:not([hidden])')!.textContent!,
        /Exact owner Alpha/,
      );
      assert.deepEqual(
        [...document.querySelectorAll(".workspace-content-tab")].map((el) =>
          el.getAttribute("data-tab-id"),
        ),
        ids,
      );
      await act(async () =>
        (
          tab(0).parentElement!.querySelector(
            ".workspace-tab-close",
          ) as HTMLButtonElement
        ).click(),
      );
      assert.deepEqual(removed, [ids[0]]);
      assert(
        reads.every((owner) => owner === "private-a" || owner === "private-b"),
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      await i18n.changeLanguage("en");
    }
  });
}
