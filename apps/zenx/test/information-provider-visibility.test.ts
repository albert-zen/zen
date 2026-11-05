import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { EditableInformationPanel } from "../src/renderer/src/EditableInformationPanel.js";
import { registerBoardUi } from "../src/renderer/src/board-ui.js";
import { createPluginUiRegistry } from "../src/renderer/src/plugin-ui-host.js";
import { workspaceLauncherSnapshot } from "./workspace-launcher-snapshot.js";
import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";

test("a previously populated Board hides when its provider surface disappears and reappears when restored", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const owner = {
    kind: "thread" as const,
    threadId: "provider-visibility-fixture",
  };
  const registry = createPluginUiRegistry();
  registerBoardUi(registry);
  const snapshot: ZenXPluginSnapshot = {
    ...workspaceLauncherSnapshot,
    plugins: [
      {
        id: "zenx-board",
        displayName: "Board",
        version: "1",
        source: "bundled",
        lifecycle: "enabled",
        enabled: true,
        available: true,
        admissionId: "provider-visibility",
        contributionCount: 1,
      },
    ],
    information: [
      {
        key: "zenx-board:information",
        pluginId: "zenx-board",
        id: "information",
        title: "Board",
        surfaceId: "board",
        order: 0,
      },
    ],
    surfaces: [
      {
        key: "zenx-board:board",
        pluginId: "zenx-board",
        id: "board",
        bundleId: "main",
        exportName: "board",
      },
    ],
    bundles: [
      {
        key: "zenx-board:main",
        pluginId: "zenx-board",
        id: "main",
        apiVersion: 1,
        kind: "trusted",
        entry: "zenx/bundled/board-ui",
      },
    ],
  };
  Object.assign(window, {
    zenx: {
      information: {
        read: async () => ({
          owner: { kind: "thread", id: owner.threadId },
          revision: 0,
          basis: "fixture",
          members: [],
          layout: {
            version: 1,
            widgets: [
              {
                id: "board",
                type: "board",
                binding: { kind: "owner" },
                visible: true,
                collapsed: false,
                config: { instanceKey: "default" },
              },
            ],
          },
        }),
      },
      threadSidebar: { onChanged: () => () => {} },
      plugins: {
        readHandle: async () => null,
        executeCommand: async () => ({
          revision: 1,
          draftRevision: 0,
          pinned: false,
          values: {},
          document: {
            owner,
            id: "board",
            title: "Real Board content",
            summary: "Synthetic data",
            blocks: [],
            events: [],
          },
        }),
      },
    },
  });
  const render = (value: ZenXPluginSnapshot) =>
    act(async () =>
      root.render(
        React.createElement(EditableInformationPanel, {
          owner,
          registry,
          snapshot: value,
          threads: [],
          theme: "light",
          navigate: () => {},
        }),
      ),
    );
  const section = () =>
    document.querySelector<HTMLElement>('[data-widget-id="board"]')!;
  try {
    await render(snapshot);
    assert.equal(section().hidden, false);
    assert.match(section().textContent!, /Real Board content/);
    await render({ ...snapshot, surfaces: [] });
    assert.equal(
      section().hidden,
      true,
      "unavailable GenericPluginUiHost fallback cannot inherit old content visibility",
    );
    await render(snapshot);
    assert.equal(section().hidden, false);
    assert.match(section().textContent!, /Real Board content/);
    await render({ ...snapshot, bundles: [] });
    assert.equal(section().hidden, true);
    await render(snapshot);
    assert.equal(section().hidden, false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
