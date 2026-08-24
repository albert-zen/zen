import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import test from "node:test";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import {
  zenXBundledAutomationPackages,
  type ZenXAutomationControlPort,
} from "../src/main/capabilities/automation-control-package.js";
import {
  GenericPluginUiHost,
  createPluginUiRegistry,
  type PluginUiModule,
} from "../src/renderer/src/plugin-ui-host.js";
import {
  PluginProductPage,
  PluginSettingsSurfaces,
  pluginUiRegistry,
} from "../src/renderer/src/PluginProductPage.js";
import {
  WORKBENCH_UI_ENTRY,
  ZenXWorkbenchFixturePackage,
  workbenchPluginUi,
} from "./fixtures/workbench-plugin.js";

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
      contributionCount: 8,
    },
  ],
  bundles: [
    {
      key: "workbench:main",
      pluginId: "workbench",
      id: "main",
      apiVersion: 1,
      kind: "trusted",
      entry: WORKBENCH_UI_ENTRY,
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
    {
      key: "workbench:refresh-result",
      pluginId: "workbench",
      id: "refresh-result",
      bundleId: "main",
      exportName: "refresh-result",
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
  resultRenderers: [
    {
      key: "workbench:refresh-result",
      pluginId: "workbench",
      id: "refresh-result",
      contentType: "workbench/refresh",
      surfaceId: "refresh-result",
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
  registry.registerTrusted(WORKBENCH_UI_ENTRY, module);
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
  const registry = createPluginUiRegistry();
  registry.registerTrusted(WORKBENCH_UI_ENTRY, workbenchPluginUi);
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(
      React.createElement(PluginProductPage, {
        snapshot,
        route: "/plugins/workbench/home",
        navigate: (route: string) => routes.push(route),
        onOpenSidebar: () => {},
        registry,
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
  await act(async () => {
    root.render(
      React.createElement(PluginSettingsSurfaces, { snapshot, registry }),
    );
  });
  assert.equal(
    dom.window.document.querySelector("[aria-label='Workbench preferences'] h3")
      ?.textContent,
    "Workbench preferences",
  );
  await act(async () => root.unmount());
});

test("normal bundled product composition owns real Trigger and Room generic UI", async () => {
  assert.equal(pluginUiRegistry.resolveTrusted(WORKBENCH_UI_ENTRY), undefined);
  const registry = new ZenXPluginCatalog({
    load: async () => ({
      disabled: [],
      uninstalled: [],
      packages: {},
    }),
    save: async () => {},
  });
  await registry.initialize();
  const port = {} as ZenXAutomationControlPort;
  for (const capabilityPackage of zenXBundledAutomationPackages(port)) {
    await registry.install(capabilityPackage, "bundled");
  }

  const normal = registry.pluginSnapshot();
  assert.deepEqual(normal.plugins.map((plugin) => plugin.id).sort(), [
    "zenx-rooms",
    "zenx-triggers",
  ]);
  assert.deepEqual(normal.bundles.map((bundle) => bundle.pluginId).sort(), [
    "zenx-rooms",
    "zenx-triggers",
  ]);
  assert.deepEqual(normal.surfaces.map((surface) => surface.pluginId).sort(), [
    "zenx-rooms",
    "zenx-triggers",
    "zenx-triggers",
  ]);
  assert.deepEqual(normal.settings, []);
  assert.equal(normal.commands.length, 13);
  assert.deepEqual(
    normal.panels.map((panel) => panel.pluginId),
    ["zenx-triggers"],
  );
  assert.deepEqual(normal.menus, []);
  assert.deepEqual(normal.sidebar.map((item) => item.pluginId).sort(), [
    "zenx-rooms",
    "zenx-triggers",
  ]);
  assert.deepEqual(normal.pages.map((page) => page.pluginId).sort(), [
    "zenx-rooms",
    "zenx-triggers",
  ]);
  assert.equal(JSON.stringify(normal).includes("workbench"), false);
});

test("product shell contains no Trigger or Room ID routing or product IPC", async () => {
  const [app, preload, ipc] = await Promise.all([
    readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/preload/ipc.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(app, /target\?\.id === ["'](?:triggers|rooms)["']/u);
  assert.doesNotMatch(app, /page === ["'](?:triggers|rooms)["']/u);
  assert.doesNotMatch(preload, /\btriggers\s*:/u);
  assert.doesNotMatch(ipc, /zenx:(?:triggers|rooms):/u);
});

test("product fixture projects every UI surface and revokes commands across lifecycle", async () => {
  let calls = 0;
  const fixture = new ZenXWorkbenchFixturePackage();
  fixture.invoke = async (_tool, invocation) => {
    invocation.signal.throwIfAborted();
    calls += 1;
    return { ok: true, calls };
  };
  const registry = new ZenXPluginCatalog({
    load: async () => ({
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
      enabled.resultRenderers?.length,
    ],
    [1, 1, 1, 1, 1, 1, 1, 1],
  );
  const command = enabled.commands.find(
    (candidate) =>
      candidate.pluginId === "workbench" && candidate.id === "refresh",
  );
  assert.ok(command);
  const reply = await fixture.invoke(command.tool, {
    name: command.tool,
    arguments: {},
    cwd: process.cwd(),
    signal: new AbortController().signal,
    callId: "workbench-refresh-1",
  });
  assert.deepEqual(reply, { ok: true, calls: 1 });
  assert.equal(calls, 1);

  await registry.setEnabled("workbench", false);
  assert.deepEqual(registry.pluginSnapshot().surfaces, []);
  assert.deepEqual(registry.pluginSnapshot().resultRenderers, []);
  assert.equal(
    registry
      .pluginSnapshot()
      .commands.some((candidate) => candidate.pluginId === "workbench"),
    false,
  );
  await registry.setEnabled("workbench", true);
  await registry.uninstall("workbench");
  assert.deepEqual(registry.pluginSnapshot().commands, []);
  await registry.reinstall("workbench");
  const reinstalled = registry
    .pluginSnapshot()
    .commands.find((candidate) => candidate.id === "refresh");
  assert.ok(reinstalled);
  await fixture.invoke(reinstalled.tool, {
    name: reinstalled.tool,
    arguments: {},
    cwd: process.cwd(),
    signal: new AbortController().signal,
    callId: "workbench-refresh-2",
  });
  assert.equal(calls, 2);
});

test("manifest validation rejects dangling surfaces and commands deterministically", async () => {
  const registry = new ZenXPluginCatalog({
    load: async () => ({
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
    /dangling settings contribution/u,
  );

  const duplicateCommand = new ZenXWorkbenchFixturePackage();
  duplicateCommand.manifest.contributions!.commands!.push({
    ...duplicateCommand.manifest.contributions!.commands![0]!,
  });
  await assert.rejects(
    registry.install(duplicateCommand, "bundled"),
    /dangling command refresh/u,
  );

  const invalidIcon = new ZenXWorkbenchFixturePackage();
  invalidIcon.manifest.contributions!.sidebar![0]!.icon = "sparkles" as never;
  await assert.rejects(
    registry.install(invalidIcon, "bundled"),
    /invalid sidebar contribution/u,
  );

  const foreignRenderer = new ZenXWorkbenchFixturePackage();
  foreignRenderer.manifest.contributions!.resultRenderers![0]!.contentType =
    "other/refresh";
  await assert.rejects(
    registry.install(foreignRenderer, "bundled"),
    /invalid result renderer/u,
  );

  const duplicateRenderer = new ZenXWorkbenchFixturePackage();
  duplicateRenderer.manifest.contributions!.resultRenderers!.push({
    id: "refresh-result-two",
    contentType: "workbench/refresh",
    surfaceId: "refresh-result",
  });
  await assert.rejects(
    registry.install(duplicateRenderer, "bundled"),
    /invalid result renderer/u,
  );
});
