import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import test from "node:test";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { ZenXCapabilityRegistry } from "../src/main/capabilities/registry.js";
import { ZenXWorkbenchFixturePackage } from "../src/main/capabilities/workbench-fixture-package.js";
import {
  GenericPluginUiHost,
  createPluginUiRegistry,
  type PluginUiModule,
} from "../src/renderer/src/plugin-ui-host.js";
import { PluginProductPage } from "../src/renderer/src/PluginProductPage.js";

const snapshot: ZenXPluginSnapshot = {
  plugins: [
    {
      id: "workbench",
      displayName: "Workbench",
      version: "1.0.0",
      source: "bundled",
      lifecycle: "enabled",
      enabled: true,
      available: true,
      contributionCount: 7,
    },
  ],
  bundles: [
    {
      key: "workbench:main",
      pluginId: "workbench",
      id: "main",
      apiVersion: 1,
      kind: "trusted",
      entry: "zenx/fixtures/workbench",
    },
  ],
  surfaces: [
    {
      key: "workbench:overview",
      pluginId: "workbench",
      id: "overview",
      bundleId: "main",
      exportName: "overview",
    },
    {
      key: "workbench:preferences",
      pluginId: "workbench",
      id: "preferences",
      bundleId: "main",
      exportName: "preferences",
    },
    {
      key: "workbench:status",
      pluginId: "workbench",
      id: "status",
      bundleId: "main",
      exportName: "status",
    },
  ],
  pages: [
    {
      key: "workbench:home",
      pluginId: "workbench",
      id: "home",
      title: "Workbench",
      route: "/plugins/workbench/home",
      surfaceId: "overview",
    },
  ],
  subroutes: [
    {
      key: "workbench:details",
      pluginId: "workbench",
      id: "details",
      title: "Workbench details",
      route: "/plugins/workbench/home/details",
      pageId: "home",
      surfaceId: "overview",
    },
  ],
  sidebar: [
    {
      key: "workbench:home",
      pluginId: "workbench",
      id: "home",
      label: "Workbench",
      icon: "plug",
      pageId: "home",
    },
  ],
  settings: [
    {
      key: "workbench:preferences",
      pluginId: "workbench",
      id: "preferences",
      title: "Workbench preferences",
      surfaceId: "preferences",
    },
  ],
  panels: [
    {
      key: "workbench:status",
      pluginId: "workbench",
      id: "status",
      title: "Workbench status",
      surfaceId: "status",
    },
  ],
  commands: [
    {
      key: "workbench:refresh",
      pluginId: "workbench",
      id: "refresh",
      title: "Refresh workbench",
      tool: "workbench_refresh",
    },
  ],
  menus: [
    {
      key: "workbench:refresh-page",
      pluginId: "workbench",
      id: "refresh-page",
      label: "Refresh",
      commandId: "refresh",
      location: "page",
    },
  ],
};

test("generic trusted host renders an owned route and dispatches one bounded command", async () => {
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
  const calls: Array<[string, string]> = [];
  let observedTheme: string | undefined;
  const module: PluginUiModule = {
    overview: ({ sdk }) => {
      observedTheme = sdk.theme;
      return React.createElement(
        "button",
        {
          type: "button",
          onClick: () => void sdk.commands.execute("refresh"),
        },
        "Refresh workbench",
      );
    },
  };
  const registry = createPluginUiRegistry();
  registry.registerTrusted("zenx/fixtures/workbench", module);
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(GenericPluginUiHost, {
        registry,
        snapshot,
        surfaceId: "overview",
        pluginId: "workbench",
        context: { route: "/plugins/workbench/home" },
        theme: "dark",
        executeCommand: async (pluginId: string, commandId: string) => {
          calls.push([pluginId, commandId]);
          return { ok: true, summary: "refreshed" };
        },
        readHandle: async () => ({ kind: "context" }),
      }),
    );
  });
  assert.equal(
    dom.window.document.querySelector("button")?.textContent,
    "Refresh workbench",
  );
  assert.equal(observedTheme, "dark");
  await act(async () => {
    (dom.window.document.querySelector("button") as HTMLButtonElement).click();
    await Promise.resolve();
  });
  assert.deepEqual(calls, [["workbench", "refresh"]]);
  await act(async () => root.unmount());
});

test("isolated host uses sandboxed iframe without same-origin parent access", async () => {
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
  const isolated = structuredClone(snapshot);
  isolated.bundles[0] = {
    ...isolated.bundles[0]!,
    kind: "isolated",
    entry: "<main>isolated</main>",
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(GenericPluginUiHost, {
        registry: createPluginUiRegistry(),
        snapshot: isolated,
        surfaceId: "overview",
        pluginId: "workbench",
        context: { route: "/plugins/workbench/home" },
        theme: "light",
        executeCommand: async () => null,
        readHandle: async () => null,
      }),
    );
  });
  const iframe = dom.window.document.querySelector("iframe")!;
  assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
  assert.doesNotMatch(iframe.getAttribute("sandbox")!, /allow-same-origin/u);
  assert.match(iframe.srcdoc, /zenx-plugin-ui:init/u);
  await act(async () => root.unmount());
});

test("product composition renders page, panel, menu and keyboard-operable subroute action", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://zenx.local/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  let commands = 0;
  const routes: string[] = [];
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      plugins: {
        executeCommand: async () => {
          commands += 1;
          return { result: { ok: true } };
        },
        readHandle: async () => ({ pluginId: "workbench" }),
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(PluginProductPage, {
        snapshot,
        route: "/plugins/workbench/home",
        navigate: (route: string) => routes.push(route),
        onOpenSidebar: () => {},
      }),
    );
  });
  assert.equal(
    dom.window.document.querySelector("[aria-label='Workbench status']")
      ?.textContent,
    "Workbench is connected through the generic panel surface.",
  );
  const buttons = [...dom.window.document.querySelectorAll("button")];
  const menu = buttons.find((button) => button.textContent === "Refresh")!;
  const details = buttons.find(
    (button) => button.textContent === "Open details",
  )!;
  assert.equal(
    menu.closest("[role='toolbar']")?.getAttribute("aria-label"),
    "Workbench commands",
  );
  await act(async () => {
    menu.click();
    details.focus();
    assert.equal(dom.window.document.activeElement, details);
    assert.equal(details.tagName, "BUTTON");
    details.click();
    await Promise.resolve();
  });
  assert.equal(commands, 1);
  assert.deepEqual(routes, ["/plugins/workbench/home/details"]);
  await act(async () => root.unmount());
});

test("product fixture projects every UI surface and revokes command admission across lifecycle", async () => {
  let calls = 0;
  const fixture = new ZenXWorkbenchFixturePackage();
  fixture.invoke = async (_tool, invocation) => {
    invocation.signal.throwIfAborted();
    calls += 1;
    return { ok: true, calls };
  };
  const registry = new ZenXCapabilityRegistry({
    load: async () => ({
      grants: {},
      disabled: [],
      uninstalled: [],
      packages: {},
    }),
    save: async () => {},
  });
  await registry.initialize();
  await registry.install(fixture, "bundled");
  const enabled = registry.pluginSnapshot();
  assert.deepEqual(
    [
      enabled.sidebar.length,
      enabled.pages.length,
      enabled.subroutes.length,
      enabled.settings.length,
      enabled.panels.length,
      enabled.commands.length,
      enabled.menus.length,
    ],
    [1, 1, 1, 1, 1, 1, 1],
  );
  const reply = (await registry.executePluginCommand(
    "workbench",
    "refresh",
  )) as { result: { ok: boolean; calls: number } };
  assert.deepEqual(reply.result, { ok: true, calls: 1 });
  assert.equal(calls, 1);

  await registry.setEnabled("workbench", false);
  assert.deepEqual(registry.pluginSnapshot().surfaces, []);
  await assert.rejects(
    registry.executePluginCommand("workbench", "refresh"),
    /not enabled/u,
  );
  await registry.setEnabled("workbench", true);
  await registry.uninstall("workbench");
  assert.deepEqual(registry.pluginSnapshot().commands, []);
  await registry.reinstall("workbench");
  await registry.executePluginCommand("workbench", "refresh");
  assert.equal(calls, 2);
});

test("manifest validation rejects dangling surfaces and commands deterministically", async () => {
  const registry = new ZenXCapabilityRegistry({
    load: async () => ({
      grants: {},
      disabled: [],
      uninstalled: [],
      packages: {},
    }),
    save: async () => {},
  });
  await registry.initialize();
  const danglingSurface = new ZenXWorkbenchFixturePackage();
  danglingSurface.manifest.contributions!.settings![0]!.surfaceId = "missing";
  await assert.rejects(
    registry.install(danglingSurface, "bundled"),
    /dangling settings contribution preferences/u,
  );

  const duplicateCommand = new ZenXWorkbenchFixturePackage();
  duplicateCommand.manifest.contributions!.commands!.push({
    ...duplicateCommand.manifest.contributions!.commands![0]!,
  });
  await assert.rejects(
    registry.install(duplicateCommand, "bundled"),
    /dangling command refresh/u,
  );
});
