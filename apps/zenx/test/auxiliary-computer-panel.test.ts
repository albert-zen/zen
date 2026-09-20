import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AuxiliaryPanel } from "../src/renderer/src/auxiliary-panel.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

test("Computer shares the workspace tabs and captures only while selected and open", async () => {
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
  const requests: string[] = [];
  let stopped = 0;
  (dom.window as any).zenx = {
    browserObservation: { subscribe: () => () => undefined },
    computerObservation: {
      subscribe: (request: { threadId: string }) => {
        requests.push(request.threadId);
        return () => {
          stopped++;
        };
      },
    },
    plugins: {},
  };
  const snapshot = {
    plugins: [{ id: "computer", enabled: true, available: true }],
    panels: [],
  } as unknown as ZenXPluginSnapshot;
  function Harness({ threadId }: { threadId: string }) {
    const [selectedTab, onSelectTab] = useState("browser");
    const [open, onOpenChange] = useState(true);
    return React.createElement(AuxiliaryPanel, {
      threadId,
      title: "Task",
      open,
      onOpenChange,
      selectedTab,
      onSelectTab,
      snapshot,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const tab = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (e) => e.textContent === name,
    )!;
  try {
    await act(async () =>
      root.render(React.createElement(Harness, { threadId: "a" })),
    );
    assert.deepEqual(requests, []);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          ".workspace-tab-types button:last-child",
        )!
        .click(),
    );
    assert.deepEqual(requests, ["a"]);
    assert.equal(
      document
        .querySelector('[aria-label="Computer workspace"]')
        ?.closest('[role="tabpanel"]')
        ?.getAttribute("hidden"),
      null,
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="New workspace tab"]')!
        .click(),
    );
    assert.equal(stopped, 1);
    await act(async () => tab("Computer").click());
    await act(async () =>
      root.render(React.createElement(Harness, { threadId: "b" })),
    );
    assert.deepEqual(requests, ["a", "a", "b"]);
    assert.equal(stopped, 2);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close side panel"]')!
        .click(),
    );
    assert.equal(stopped, 3);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
