import assert from "node:assert/strict";
import test from "node:test";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import {
  MarketplaceCatalogService,
  marketplaceCatalogView,
  marketplaceInventoryView,
  marketplacePackageSource,
} from "../src/main/marketplace-catalog.js";

const fixtureCatalog = {
  entries: [
    {
      packageSpec: "@fixtures/notes-plugin",
      name: "Notes",
      description: "Capture durable notes from a thread.",
      icon: "layers",
      recommendedVersion: "2.0.0",
      curated: true,
      versions: [
        { version: "2.0.0", packageSpec: "@fixtures/notes-plugin@2.0.0" },
        { version: "1.0.0", packageSpec: "@fixtures/notes-plugin@1.0.0" },
      ],
    },
    {
      packageSpec: "@fixtures/calendar-plugin",
      name: "Calendar",
      description: "Read upcoming calendar events.",
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
};

test("external Marketplace metadata maps an explicit version to the canonical npm source", async () => {
  const service = new MarketplaceCatalogService({
    load: async () => fixtureCatalog,
  });

  const catalog = await service.load();
  assert.deepEqual(catalog, fixtureCatalog);
  assert.deepEqual(marketplacePackageSource(catalog.entries[0]!, "1.0.0"), {
    mode: "npm",
    packageSpec: "@fixtures/notes-plugin@1.0.0",
  });
  assert.throws(
    () => marketplacePackageSource(catalog.entries[0]!, "3.0.0"),
    /is not listed/u,
  );
});

test("Marketplace search and installed/update state are joined from the canonical plugin snapshot", async () => {
  const service = new MarketplaceCatalogService({
    load: async () => structuredClone(fixtureCatalog),
  });
  const catalog = await service.load();
  const plugins = pluginSnapshot("1.0.0");

  assert.deepEqual(
    marketplaceCatalogView(catalog, plugins, "durable").map((entry) => ({
      packageSpec: entry.packageSpec,
      installedPluginId: entry.installed?.pluginId,
      installedVersion: entry.installed?.version,
      updateAvailable: entry.updateAvailable,
    })),
    [
      {
        packageSpec: "@fixtures/notes-plugin",
        installedPluginId: "notes",
        installedVersion: "1.0.0",
        updateAvailable: true,
      },
    ],
  );

  plugins.plugins[0]!.version = "2.0.0";
  assert.equal(
    marketplaceCatalogView(catalog, plugins, "notes")[0]?.updateAvailable,
    false,
  );
  plugins.plugins[0]!.version = "2.0.0-beta.1";
  assert.equal(
    marketplaceCatalogView(catalog, plugins, "notes")[0]?.updateAvailable,
    true,
  );
  plugins.plugins[0]!.version = "3.0.0";
  assert.equal(
    marketplaceCatalogView(catalog, plugins, "notes")[0]?.updateAvailable,
    false,
  );
});

test("Marketplace update comparison follows SemVer ASCII and arbitrary-precision numeric precedence", () => {
  assert.equal(updateAvailable("1.0.0-a", "1.0.0-B"), false);
  assert.equal(updateAvailable("1.0.0-B", "1.0.0-a"), true);
  assert.equal(
    updateAvailable("1.0.0-9007199254740992", "1.0.0-9007199254740993"),
    true,
  );
  assert.equal(
    updateAvailable("9007199254740992.0.0", "9007199254740993.0.0"),
    true,
  );
});

test("catalog load and validation failures do not mutate the caller's plugin snapshot", async () => {
  const plugins = pluginSnapshot("1.0.0");
  const before = structuredClone(plugins);
  const failed = new MarketplaceCatalogService({
    load: async () => {
      throw new Error("fixture catalog unavailable");
    },
  });
  await assert.rejects(failed.load(), /fixture catalog unavailable/u);
  assert.deepEqual(plugins, before);

  const invalid = new MarketplaceCatalogService({
    load: async () => ({
      entries: [
        {
          ...fixtureCatalog.entries[0],
          recommendedVersion: "9.0.0",
        },
      ],
    }),
  });
  await assert.rejects(invalid.load(), /recommended version.*is not listed/u);
  assert.deepEqual(plugins, before);
});

test("Marketplace inventory keeps built-ins and installed non-catalog plugins when the external catalog is unavailable", () => {
  const plugins = pluginSnapshot("1.0.0");
  plugins.plugins.push({
    id: "local-clock",
    displayName: "Local clock",
    version: "0.4.0",
    description: "A locally installed clock.",
    source: "local",
    profileSource: {
      mode: "local-copy",
      packageSpec: "/fixtures/local-clock",
      resolvedSpec: "file:local-clock",
      packageName: "local-clock",
      packageVersion: "0.4.0",
    },
    lifecycle: "installed",
    enabled: false,
    available: true,
    contributionCount: 0,
  });
  plugins.plugins.push({
    id: "browser",
    displayName: "Browser",
    version: "1.0.0",
    description: "Browse pages in an isolated session.",
    source: "bundled",
    profileSource: {
      mode: "bundled",
      packageSpec: "/app/plugins/browser.tgz",
      resolvedSpec: "file:browser.tgz",
      packageName: "@zenx/browser-plugin",
      packageVersion: "1.0.0",
    },
    lifecycle: "uninstalled",
    enabled: false,
    available: true,
    contributionCount: 0,
  });
  plugins.plugins.push({
    id: "computer",
    displayName: "Computer",
    version: "1.0.0",
    description: "Inspect and control desktop applications.",
    source: "bundled",
    profileSource: {
      mode: "bundled",
      packageSpec: "/app/plugins/computer.tgz",
      resolvedSpec: "file:computer.tgz",
      packageName: "@zenx/computer-plugin",
      packageVersion: "1.0.0",
    },
    lifecycle: "installed",
    enabled: false,
    available: false,
    contributionCount: 0,
  });

  const inventory = marketplaceInventoryView(
    {
      entries: fixtureCatalog.entries,
      error: "catalog offline",
      builtIns: [
        {
          pluginId: "browser",
          packageName: "@zenx/browser-plugin",
          name: "Browser",
          description: "Browse and act on web pages.",
          icon: "search",
          available: true,
        },
        {
          pluginId: "computer",
          packageName: "@zenx/computer-plugin",
          name: "Computer",
          description: "Inspect and control desktop applications.",
          icon: "panel-right",
          available: false,
          unavailableReason: "Computer control is not available on Linux.",
        },
      ],
    },
    plugins,
  );

  assert.deepEqual(
    inventory.map((entry) => ({
      key: entry.key,
      source: entry.source,
      lifecycle: entry.lifecycle,
      reason: entry.unavailableReason,
    })),
    [
      {
        key: "builtin:browser",
        source: "built-in",
        lifecycle: "uninstalled",
        reason: undefined,
      },
      {
        key: "catalog:@fixtures/calendar-plugin",
        source: "catalog",
        lifecycle: "available",
        reason: undefined,
      },
      {
        key: "builtin:computer",
        source: "built-in",
        lifecycle: "installed",
        reason: "Computer control is not available on Linux.",
      },
      {
        key: "installed:local-clock",
        source: "source",
        lifecycle: "installed",
        reason: undefined,
      },
      {
        key: "catalog:@fixtures/notes-plugin",
        source: "catalog",
        lifecycle: "enabled",
        reason: undefined,
      },
    ],
  );
  assert.equal(
    inventory.filter((entry) => entry.pluginId === "browser").length,
    1,
  );
});

test("Marketplace admits only canonical npm identities with matching exact version specs", async () => {
  const validUnscoped = new MarketplaceCatalogService({
    load: async () => ({
      entries: [
        {
          packageSpec: "notes-plugin",
          name: "Notes",
          description: "Unscoped canonical fixture.",
          icon: "layers",
          recommendedVersion: "1.2.3-beta.1",
          curated: true,
          versions: [
            {
              version: "1.2.3-beta.1",
              packageSpec: "notes-plugin@1.2.3-beta.1",
            },
          ],
        },
      ],
    }),
  });
  assert.equal(
    (await validUnscoped.load()).entries[0]?.packageSpec,
    "notes-plugin",
  );

  const invalidRoots = [
    "file:../notes-plugin",
    "link:../notes-plugin",
    "git+https://example.test/notes-plugin.git#deadbeef",
    "/tmp/notes-plugin",
    "../notes-plugin",
    "https://example.test/notes-plugin.tgz",
    "npm:@fixtures/notes-plugin@1.0.0",
    "@fixtures/notes-plugin@latest",
    "notes-plugin@^1.0.0",
    "Notes-Plugin",
    " notes-plugin",
    "notes-plugin ",
    "@fixtures//notes-plugin",
  ];
  for (const packageSpec of invalidRoots) {
    const service = new MarketplaceCatalogService({
      load: async () => ({
        entries: [{ ...fixtureCatalog.entries[0], packageSpec }],
      }),
    });
    await assert.rejects(
      service.load(),
      /canonical npm package identity/u,
      packageSpec,
    );
  }

  const invalidVersions = [
    "@fixtures/other-plugin@2.0.0",
    "@fixtures/notes-plugin@latest",
    "@fixtures/notes-plugin@^2.0.0",
    "@fixtures/notes-plugin@2.x",
    "npm:@fixtures/notes-plugin@2.0.0",
    "file:../notes-plugin",
    "link:../notes-plugin",
    "git+https://example.test/notes-plugin.git#deadbeef",
    "/tmp/notes-plugin.tgz",
    "../notes-plugin.tgz",
    "https://example.test/notes-plugin.tgz",
    " @fixtures/notes-plugin@2.0.0",
    "@fixtures/notes-plugin@2.0.0 ",
  ];
  for (const packageSpec of invalidVersions) {
    const service = new MarketplaceCatalogService({
      load: async () => ({
        entries: [
          {
            ...fixtureCatalog.entries[0],
            versions: [
              {
                version: "2.0.0",
                packageSpec,
              },
            ],
          },
        ],
      }),
    });
    await assert.rejects(
      service.load(),
      /exact canonical package version/u,
      packageSpec,
    );
  }
});

function pluginSnapshot(version: string): ZenXPluginSnapshot {
  return {
    plugins: [
      {
        id: "notes",
        displayName: "Installed Notes",
        version,
        source: "local",
        profileSource: {
          mode: "npm",
          packageSpec: "@fixtures/notes-plugin@1.0.0",
          resolvedSpec: version,
          packageName: "@fixtures/notes-plugin",
          packageVersion: version,
        },
        lifecycle: "enabled",
        enabled: true,
        available: true,
        contributionCount: 1,
      },
    ],
    bundles: [],
    surfaces: [],
    sidebar: [],
    pages: [],
    subroutes: [],
    settings: [],
    panels: [],
    commands: [],
    menus: [],
  };
}

function updateAvailable(installed: string, recommended: string): boolean {
  return marketplaceCatalogView(
    {
      entries: [
        {
          ...fixtureCatalog.entries[0]!,
          recommendedVersion: recommended,
          versions: [
            {
              version: recommended,
              packageSpec: `@fixtures/notes-plugin@${recommended}`,
            },
          ],
        },
      ],
    },
    pluginSnapshot(installed),
  )[0]!.updateAvailable;
}
