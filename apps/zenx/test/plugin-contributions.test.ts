import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { loadedPluginContributions } from "../src/renderer/src/plugin-contributions.js";

test("mounts arbitrary plugin pages projected by the typed plugin snapshot", () => {
  const snapshot: ZenXPluginSnapshot = {
    plugins: [],
    bundles: [],
    surfaces: [],
    pages: [
      {
        id: "rooms",
        key: "zenx-rooms:rooms",
        pluginId: "zenx-rooms",
        title: "Rooms",
        route: "/plugins/zenx-rooms/rooms",
      },
      {
        id: "unknown",
        key: "fixture:unknown",
        pluginId: "fixture",
        title: "Unknown",
        route: "/plugins/fixture/unknown",
        surfaceId: "home",
      },
      {
        id: "tools",
        key: "toolbox:tools",
        pluginId: "toolbox",
        title: "Tools",
        route: "/plugins/toolbox/tools",
        surfaceId: "home",
      },
      {
        id: "triggers",
        key: "zenx-triggers:triggers",
        pluginId: "zenx-triggers",
        title: "Triggers",
        route: "/plugins/zenx-triggers/triggers",
      },
    ],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
    sidebar: [
      {
        id: "rooms",
        key: "zenx-rooms:rooms",
        pluginId: "zenx-rooms",
        label: "Rooms",
        icon: "users",
        pageId: "rooms",
        order: 20,
      },
      {
        id: "unknown",
        key: "fixture:unknown",
        pluginId: "fixture",
        label: "Unknown",
        icon: "layers",
        pageId: "unknown",
        order: 5,
      },
      {
        id: "tools",
        key: "toolbox:tools",
        pluginId: "toolbox",
        label: "Tools",
        icon: "terminal",
        pageId: "tools",
        order: 6,
      },
      {
        id: "triggers",
        key: "zenx-triggers:triggers",
        pluginId: "zenx-triggers",
        label: "Triggers",
        icon: "clock",
        pageId: "triggers",
        order: 10,
      },
    ],
  };

  assert.deepEqual(
    loadedPluginContributions(snapshot).map(({ key, page }) => [key, page.id]),
    [
      ["fixture:unknown", "unknown"],
      ["toolbox:tools", "tools"],
      ["zenx-triggers:triggers", "triggers"],
      ["zenx-rooms:rooms", "rooms"],
    ],
  );
  assert.deepEqual(loadedPluginContributions(null), []);
});

test("renders each arbitrary plugin sidebar icon declared by its manifest", async () => {
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
  const { PluginSpaces } = await import("../src/renderer/src/Sidebar.js");
  const contributions = loadedPluginContributions({
    plugins: [],
    bundles: [],
    surfaces: [],
    pages: [
      {
        id: "home",
        key: "notebook:home",
        pluginId: "notebook",
        title: "Notebook",
        route: "/plugins/notebook/home",
      },
      {
        id: "console",
        key: "console-kit:console",
        pluginId: "console-kit",
        title: "Console kit",
        route: "/plugins/console-kit/console",
      },
    ],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
    sidebar: [
      {
        id: "home",
        key: "notebook:home",
        pluginId: "notebook",
        label: "Notebook",
        icon: "layers",
        pageId: "home",
      },
      {
        id: "console",
        key: "console-kit:console",
        pluginId: "console-kit",
        label: "Console kit",
        icon: "terminal",
        pageId: "console",
      },
    ],
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(PluginSpaces, {
        contributions,
        onOpen: () => {},
        selectedPage: "/plugins/notebook/home",
      }),
    );
  });
  assert.equal(
    dom.window.document
      .querySelector("button[aria-current='page'] svg")
      ?.getAttribute("data-icon"),
    "layers",
  );
  assert.equal(
    [...dom.window.document.querySelectorAll("button")]
      .find((button) => button.textContent === "Console kit")
      ?.querySelector("svg")
      ?.getAttribute("data-icon"),
    "terminal",
  );
  assert.equal(
    dom.window.document.querySelector("svg[data-icon='trigger']"),
    null,
  );
  await act(async () => root.unmount());
});
