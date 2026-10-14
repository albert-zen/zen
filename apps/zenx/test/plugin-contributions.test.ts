import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type {
  ZenXPluginManifestV2,
  ZenXPluginSnapshot,
} from "../src/main/capabilities/types.js";
import { Icon } from "../src/renderer/src/icons.js";
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
  assert.equal(
    dom.window.document.querySelector(".plugin-spaces-toggle"),
    null,
  );
  const links = dom.window.document.querySelector("nav.plugin-spaces");
  assert.ok(links);
  assert.equal(links.hasAttribute("hidden"), false);
  assert.equal(
    links.querySelector("button[aria-current='page']")?.textContent,
    "Notebook",
  );
  await act(async () => root.unmount());
});

test("renders the real Triggers package sidebar icon through the Catalog projection", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-triggers-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ZenXPluginManifestV2;
  const catalog = new ZenXPluginCatalog({
    load: async () => ({ disabled: [], uninstalled: [], packages: {} }),
    save: async () => {},
  });
  await catalog.initialize();
  await catalog.install(
    {
      manifest,
      invoke: async () => {
        throw new Error("Opening navigation must not invoke Trigger tools");
      },
    },
    "bundled",
  );
  const contributions = loadedPluginContributions(catalog.pluginSnapshot());
  const declared = manifest.contributions?.sidebar?.find(
    (entry) => entry.id === "triggers",
  );
  assert.ok(declared);
  assert.equal(contributions.length, 1);
  const contribution = contributions[0]!;
  assert.equal(contribution.icon, declared.icon);
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
  };
  const previousActEnvironment = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { PluginSpaces } = await import("../src/renderer/src/Sidebar.js");
  const opened: string[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => {
      root.render(
        React.createElement(PluginSpaces, {
          contributions,
          onOpen: (route) => opened.push(route),
          selectedPage: contribution.page.route,
        }),
      );
    });
    const button = dom.window.document.querySelector<HTMLButtonElement>(
      "button[aria-current='page']",
    );
    assert.ok(button);
    assert.equal(button.textContent, declared.label);
    assert.equal(button.title, declared.label);
    const svg = button.querySelector("svg");
    assert.ok(svg, "The Trigger entry must have a sidebar icon");
    assert.equal(svg.getAttribute("data-icon"), declared.icon);
    assert.equal(svg.getAttribute("aria-hidden"), "true");
    assert.ok(
      svg.querySelector("path[d], circle[r], rect[width]"),
      "The Trigger icon must contain drawable SVG geometry",
    );
    await act(async () => button.click());
    assert.deepEqual(opened, [contribution.page.route]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    if (previousActEnvironment === undefined)
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    else
      Object.defineProperty(
        globalThis,
        "IS_REACT_ACT_ENVIRONMENT",
        previousActEnvironment,
      );
    dom.window.close();
    await catalog.unregister(manifest.id);
  }
});

test("renders an external-link icon as decorative drawable SVG", () => {
  const dom = new JSDOM(
    renderToStaticMarkup(React.createElement(Icon, { name: "external-link" })),
  );
  try {
    const svg = dom.window.document.querySelector("svg");
    assert.ok(svg);
    assert.equal(svg.getAttribute("data-icon"), "external-link");
    assert.equal(svg.getAttribute("aria-hidden"), "true");
    assert.equal(svg.getAttribute("viewBox"), "0 0 16 16");
    assert.ok(svg.querySelector("path[d]"));
  } finally {
    dom.window.close();
  }
});
