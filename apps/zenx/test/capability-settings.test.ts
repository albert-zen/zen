import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";

import type {
  ZenXCapabilitySnapshot,
  ZenXPluginSnapshot,
} from "../src/main/capabilities/types.js";
import {
  CapabilitySettings,
  pluginSpacesForSettings,
} from "../src/renderer/src/CapabilitySettings.js";

test("Plugin Settings does not offer enable for an uninstalled catalog package", () => {
  const plugins: ZenXPluginSnapshot = {
    bundles: [],
    surfaces: [],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
    plugins: [
      {
        id: "uninstalled-fixture",
        displayName: "Uninstalled fixture",
        version: "1.0.0",
        source: "local",
        lifecycle: "uninstalled",
        enabled: false,
        available: true,
        contributionCount: 1,
      },
      {
        id: "installed-fixture",
        displayName: "Installed fixture",
        version: "1.0.0",
        source: "local",
        lifecycle: "installed",
        enabled: false,
        available: true,
        contributionCount: 1,
      },
    ],
    sidebar: [],
    pages: [],
  };

  assert.deepEqual(
    pluginSpacesForSettings(plugins).map((plugin) => plugin.id),
    ["installed-fixture"],
  );
});

test("Plugin Settings exposes the typed tarball installer entry", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.local" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  let selected = 0;
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      capabilities: {
        get: async () => emptyCapabilities,
        grant: async () => emptyCapabilities,
        revoke: async () => emptyCapabilities,
        onChange: () => () => {},
      },
      plugins: {
        get: async () => emptyPluginSnapshot,
        onChange: () => () => {},
        selectPackage: async () => ({ canceled: true }),
        selectTarball: async () => {
          selected += 1;
          return {
            canceled: false,
            snapshot: emptyPluginSnapshot,
            capabilityRefresh: {
              status: "failed",
              message: "refresh fixture failure",
            },
          };
        },
        setEnabled: async () => emptyPluginSnapshot,
        uninstall: async () => emptyPluginSnapshot,
        reinstall: async () => emptyPluginSnapshot,
        deleteData: async () => {},
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(React.createElement(CapabilitySettings));
    await Promise.resolve();
  });
  const button = [...dom.window.document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Install tarball",
  ) as HTMLButtonElement | undefined;
  assert.ok(button);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  assert.equal(selected, 1);
  assert.match(
    dom.window.document.body.textContent ?? "",
    /installed and enabled, but Agent capability refresh failed: refresh fixture failure/u,
  );
  await act(async () => root.unmount());
});

test("real Plugin Settings DOM confirms uninstall and keeps delete-data separate", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://zenx.local" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  const enabled = pluginSnapshot("enabled");
  const uninstalled = pluginSnapshot("uninstalled");
  const calls: string[] = [];
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      capabilities: {
        get: async () => emptyCapabilities,
        grant: async () => emptyCapabilities,
        revoke: async () => emptyCapabilities,
        onChange: () => () => {},
      },
      plugins: {
        get: async () => enabled,
        onChange: () => () => {},
        selectPackage: async () => ({ canceled: true }),
        setEnabled: async () => enabled,
        uninstall: async () => {
          calls.push("uninstall");
          return uninstalled;
        },
        reinstall: async () => enabled,
        deleteData: async () => {
          calls.push("delete-data");
        },
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(React.createElement(CapabilitySettings));
    await Promise.resolve();
  });
  assert.match(dom.window.document.body.textContent ?? "", /enabled/u);
  const button = (label: string) =>
    [...dom.window.document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    ) as HTMLButtonElement;
  assert.equal(button("Delete data").disabled, true);
  await act(async () => button("Uninstall").click());
  assert.match(
    dom.window.document.body.textContent ?? "",
    /Its data stays on this device/u,
  );
  assert.equal(dom.window.document.activeElement, button("Confirm uninstall"));
  await act(async () => {
    button("Confirm uninstall").click();
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["uninstall"]);
  assert.match(dom.window.document.body.textContent ?? "", /data was kept/u);
  assert.equal(button("Delete data").disabled, false);
  await act(async () => button("Delete data").click());
  assert.match(
    dom.window.document.body.textContent ?? "",
    /historical Threads are not changed/u,
  );
  await act(async () => {
    button("Confirm delete data").click();
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["uninstall", "delete-data"]);
  await act(async () => root.unmount());
});

const emptyCapabilities: ZenXCapabilitySnapshot = {
  capabilities: [],
  recentInvocations: [],
  providerDiagnostics: [],
  discoveryErrors: [],
};

const emptyPluginSnapshot: ZenXPluginSnapshot = {
  plugins: [],
  bundles: [],
  surfaces: [],
  sidebar: [],
  pages: [],
  subroutes: [],
  settings: [],
  panels: [],
  commands: [],
  menus: [],
  resultRenderers: [],
};

function pluginSnapshot(
  lifecycle: "enabled" | "uninstalled",
): ZenXPluginSnapshot {
  return {
    bundles: [],
    surfaces: [],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
    sidebar: [],
    pages: [],
    plugins: [
      {
        id: "fixture",
        displayName: "Fixture",
        version: "1.0.0",
        description: "Fixture lifecycle plugin",
        compatibility: ">=0.1.0 <0.2.0",
        source: "local",
        lifecycle,
        enabled: lifecycle === "enabled",
        available: true,
        contributionCount: 2,
      },
    ],
  };
}
