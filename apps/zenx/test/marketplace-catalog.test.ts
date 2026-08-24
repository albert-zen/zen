import assert from "node:assert/strict";
import test from "node:test";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import {
  MarketplaceCatalogService,
  marketplaceCatalogView,
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

test("read-only Marketplace loads fixture metadata and maps an explicit version to the canonical npm source", async () => {
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
