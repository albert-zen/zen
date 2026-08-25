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
