import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import {
  PluginSettings,
  pluginSpacesForSettings,
} from "../src/renderer/src/PluginSettings.js";

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
      marketplace: { get: async () => ({ entries: [] }) },
      plugins: {
        get: async () => emptyPluginSnapshot,
        onChange: () => () => {},
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
    root.render(React.createElement(PluginSettings));
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

test("Plugin Settings exposes typed package sources and reports post-commit update refresh failures", async () => {
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
  const installed = pluginSnapshot("enabled");
  installed.plugins[0]!.profileSource = {
    mode: "npm",
    packageSpec: "@zenx-test/fixture",
    resolvedSpec: "1.0.0",
    packageName: "@zenx-test/fixture",
    packageVersion: "1.0.0",
  };
  const sources: unknown[] = [];
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      marketplace: { get: async () => ({ entries: [] }) },
      plugins: {
        get: async () => installed,
        onChange: () => () => {},
        selectTarball: async () => ({ canceled: true }),
        installSource: async (source: unknown) => {
          sources.push(source);
          return {
            snapshot: installed,
            capabilityRefresh: { status: "refreshed" },
          };
        },
        update: async () => ({
          snapshot: installed,
          capabilityRefresh: {
            status: "failed",
            message: "refresh after update failed",
          },
        }),
        setEnabled: async () => ({
          snapshot: installed,
          capabilityRefresh: { status: "refreshed" },
        }),
        uninstall: async () => ({
          snapshot: installed,
          capabilityRefresh: { status: "refreshed" },
        }),
        reinstall: async () => ({
          snapshot: installed,
          capabilityRefresh: { status: "refreshed" },
        }),
        deleteData: async () => {},
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(React.createElement(PluginSettings));
    await Promise.resolve();
  });
  const select = dom.window.document.querySelector("select")!;
  const input = dom.window.document.querySelector("input")!;
  const button = (label: string) =>
    [...dom.window.document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    ) as HTMLButtonElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLSelectElement.prototype,
      "value",
    )!.set!.call(select, "git");
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(
      input,
      "git+file:///fixture#1111111111111111111111111111111111111111",
    );
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.equal(
    [...select.options].some((option) => option.value === "git"),
    true,
  );
  assert.deepEqual(sources, []);
  await act(async () => {
    button("Update…").click();
    await Promise.resolve();
  });
  assert.match(
    dom.window.document.body.textContent ?? "",
    /updated successfully\. Agent capability refresh failed: refresh after update failed/u,
  );
  await act(async () => root.unmount());
});

test("Marketplace exposes loading, search, detail, version install, and canonical update state", async () => {
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
  let resolveCatalog!: (value: unknown) => void;
  const catalog = new Promise((resolve) => {
    resolveCatalog = resolve;
  });
  const sources: unknown[] = [];
  const updates: unknown[] = [];
  const installed = pluginSnapshot("enabled");
  installed.plugins[0] = {
    ...installed.plugins[0]!,
    id: "notes",
    displayName: "Installed Notes",
    version: "1.0.0",
    profileSource: {
      mode: "npm",
      packageSpec: "@fixtures/notes-plugin@1.0.0",
      resolvedSpec: "1.0.0",
      packageName: "@fixtures/notes-plugin",
      packageVersion: "1.0.0",
    },
  };
  const updated = structuredClone(installed);
  updated.plugins[0]!.version = "2.0.0";
  updated.plugins[0]!.profileSource = {
    ...updated.plugins[0]!.profileSource!,
    packageSpec: "@fixtures/notes-plugin@2.0.0",
    resolvedSpec: "2.0.0",
    packageVersion: "2.0.0",
  };
  Object.defineProperty(dom.window, "zenx", {
    configurable: true,
    value: {
      marketplace: { get: async () => await catalog },
      plugins: {
        get: async () => emptyPluginSnapshot,
        onChange: () => () => {},
        selectTarball: async () => ({ canceled: true }),
        installSource: async (source: unknown) => {
          sources.push(source);
          return {
            snapshot: installed,
            capabilityRefresh: {
              status: "failed",
              message: "fixture refresh failed",
            },
          };
        },
        update: async (pluginId: string, source: unknown) => {
          updates.push({ pluginId, source });
          return {
            snapshot: updated,
            capabilityRefresh: { status: "refreshed" },
          };
        },
        setEnabled: async () => ({
          snapshot: installed,
          capabilityRefresh: { status: "refreshed" },
        }),
        uninstall: async () => ({
          snapshot: installed,
          capabilityRefresh: { status: "refreshed" },
        }),
        reinstall: async () => ({
          snapshot: installed,
          capabilityRefresh: { status: "refreshed" },
        }),
        deleteData: async () => {},
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(React.createElement(PluginSettings));
    await Promise.resolve();
  });
  assert.match(
    dom.window.document.body.textContent ?? "",
    /Loading Marketplace/u,
  );

  await act(async () => {
    resolveCatalog({
      entries: [
        {
          packageSpec: "@fixtures/notes-plugin",
          name: "Notes",
          description: "Capture durable notes from a thread.",
          icon: "layers",
          recommendedVersion: "2.0.0",
          curated: true,
          versions: [
            {
              version: "2.0.0",
              packageSpec: "@fixtures/notes-plugin@2.0.0",
            },
            {
              version: "1.0.0",
              packageSpec: "@fixtures/notes-plugin@1.0.0",
            },
          ],
        },
        {
          packageSpec: "@fixtures/calendar-plugin",
          name: "Calendar",
          description: "Upcoming events.",
          icon: "trigger",
          recommendedVersion: "1.0.0",
          curated: false,
          versions: [
            {
              version: "1.0.0",
              packageSpec: "@fixtures/calendar-plugin@1.0.0",
            },
          ],
        },
      ],
    });
    await catalog;
  });
  const search = dom.window.document.querySelector<HTMLInputElement>(
    'input[aria-label="Search Marketplace"]',
  );
  assert.ok(search);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(search, "durable");
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    search.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.match(dom.window.document.body.textContent ?? "", /Notes/u);
  assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Calendar/u);

  const button = (label: string) =>
    [...dom.window.document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    ) as HTMLButtonElement;
  await act(async () => button("View details").click());
  assert.match(
    dom.window.document.body.textContent ?? "",
    /@fixtures\/notes-plugin/u,
  );
  const version = dom.window.document.querySelector<HTMLSelectElement>(
    'select[aria-label="Notes version"]',
  );
  assert.ok(version);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLSelectElement.prototype,
      "value",
    )!.set!.call(version, "1.0.0");
    version.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await act(async () => {
    button("Install v1.0.0").click();
    await Promise.resolve();
  });
  assert.deepEqual(sources, [
    { mode: "npm", packageSpec: "@fixtures/notes-plugin@1.0.0" },
  ]);
  assert.match(
    dom.window.document.body.textContent ?? "",
    /installed and enabled.*Agent capability refresh failed: fixture refresh failed/u,
  );
  assert.match(dom.window.document.body.textContent ?? "", /Update available/u);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLSelectElement.prototype,
      "value",
    )!.set!.call(version, "2.0.0");
    version.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await act(async () => {
    button("Update to v2.0.0").click();
    await Promise.resolve();
  });
  assert.deepEqual(updates, [
    {
      pluginId: "notes",
      source: {
        mode: "npm",
        packageSpec: "@fixtures/notes-plugin@2.0.0",
      },
    },
  ]);
  assert.doesNotMatch(
    dom.window.document.body.textContent ?? "",
    /Update available/u,
  );
  assert.match(
    dom.window.document.body.textContent ?? "",
    /updated to v2.0.0/u,
  );
  await act(async () => root.unmount());
});

test("Marketplace has explicit empty and retryable error states", async () => {
  // The pure catalog seam owns validation; the renderer owns honest transport states.
  for (const fixture of [
    { load: async () => ({ entries: [] }), expected: /No plugins found/u },
    {
      load: async () => {
        throw new Error("catalog offline");
      },
      expected: /Marketplace unavailable.*catalog offline/u,
    },
  ]) {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "https://zenx.local",
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
    Object.defineProperty(dom.window, "zenx", {
      configurable: true,
      value: {
        marketplace: { get: fixture.load },
        plugins: {
          get: async () => emptyPluginSnapshot,
          onChange: () => () => {},
        },
      },
    });
    const root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => {
      root.render(React.createElement(PluginSettings));
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent ?? "", fixture.expected);
    await act(async () => root.unmount());
  }
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
      marketplace: { get: async () => ({ entries: [] }) },
      plugins: {
        get: async () => enabled,
        onChange: () => () => {},
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
    root.render(React.createElement(PluginSettings));
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
