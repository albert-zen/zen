import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installZenXBundledPluginsAtStartup } from "../src/main/bundled-plugin-startup.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZENX_ROOMS_CAPABILITY_ID } from "../src/main/capabilities/automation-control-package.js";
import { ZenXFleetCapabilityPackage } from "../src/main/capabilities/fleet-package.js";
import type { ZenXSelfControlCapabilityPackage } from "../src/main/capabilities/self-control-package.js";
import type { FleetSettingsService } from "../src/main/fleet-settings.js";
import {
  createDelegatingFirstPartyProfileLoader,
  FIRST_PARTY_PLUGIN_PACKAGES,
} from "../src/main/first-party-profile-loader.js";
import { ZENX_ROOMS_TARBALL } from "../src/main/rooms-profile-loader.js";

test("clean startup installs Fleet through the ordinary bundled profile installer", async () => {
  const calls: unknown[][] = [];
  const capabilities = {
    pluginCatalogAvailable: () => true,
    pluginSnapshot: () => ({ plugins: [] }),
    installBundledPluginPackage: async (...args: unknown[]) => {
      calls.push(args);
    },
    browserProfilePackage: () => {
      throw new Error("unavailable");
    },
    computerProfilePackage: () => {
      throw new Error("unavailable");
    },
    recordBundledPluginStartupError: (_id: string, error: unknown) => {
      throw error;
    },
  } as unknown as ZenXCapabilityService;

  await installZenXBundledPluginsAtStartup(capabilities, "/resources");

  assert.deepEqual(
    calls.find(
      (call) => (call[1] as { pluginId: string }).pluginId === "zenx-fleet",
    ),
    [
      "/resources/plugins/zenx-fleet-plugin-1.0.0.tgz",
      { pluginId: "zenx-fleet", packageName: "@zenx/fleet-plugin" },
      { allowSameVersionBundledVariant: false },
    ],
  );
});

test("startup repairs a bundled plugin profile that points at an old worktree", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-bundled-startup-"),
  );
  const resourcesDirectory = path.join(directory, "resources");
  const tarballPath = path.join(
    resourcesDirectory,
    "plugins",
    ZENX_ROOMS_TARBALL,
  );
  await mkdir(path.dirname(tarballPath), { recursive: true });
  await writeFile(tarballPath, "fixture");

  const installCalls: unknown[][] = [];
  const plugins = [
    {
      id: ZENX_ROOMS_CAPABILITY_ID,
      lifecycle: "installed",
      profileSource: {
        mode: "bundled",
        packageSpec: "/Users/xbjt/.codex/worktrees/old/zen/rooms.tgz",
      },
    },
    {
      id: "zenx-subagents",
      lifecycle: "installed",
      profileSource: { mode: "npm", packageSpec: "@zenx/subagents-plugin" },
    },
    {
      id: "zenx-self-control",
      lifecycle: "installed",
      profileSource: { mode: "npm", packageSpec: "@zenx/self-control-plugin" },
    },
    {
      id: "zenx-triggers",
      lifecycle: "installed",
      profileSource: { mode: "npm", packageSpec: "@zenx/triggers-plugin" },
    },
    {
      id: "zenx-fleet",
      lifecycle: "installed",
      profileSource: { mode: "npm", packageSpec: "@zenx/fleet-plugin" },
    },
  ];
  const capabilities = {
    pluginSnapshot: () => ({ plugins }),
    installBundledPluginPackage: async (...args: unknown[]) => {
      installCalls.push(args);
    },
    browserProfilePackage: () => {
      throw new Error("browser provider unavailable");
    },
    computerProfilePackage: () => {
      throw new Error("computer provider unavailable");
    },
    recordBundledPluginStartupError: (pluginId: string, error: unknown) => {
      throw new Error(
        `unexpected startup error for ${pluginId}: ${String(error)}`,
      );
    },
    pluginCatalogAvailable: () => true,
  } as unknown as ZenXCapabilityService;

  try {
    await installZenXBundledPluginsAtStartup(capabilities, resourcesDirectory);
    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0]?.[0], tarballPath);
    assert.deepEqual(installCalls[0]?.[2], {
      allowSameVersionBundledVariant: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup does not resurrect bundled plugins while the catalog is unreadable", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-bundled-startup-unreadable-"),
  );
  const installCalls: unknown[][] = [];
  const capabilities = {
    pluginCatalogAvailable: () => false,
    pluginSnapshot: () => ({ plugins: [] }),
    installBundledPluginPackage: async (...args: unknown[]) => {
      installCalls.push(args);
    },
    recordBundledPluginStartupError: (pluginId: string, error: unknown) => {
      throw new Error(
        `unexpected startup error for ${pluginId}: ${String(error)}`,
      );
    },
  } as unknown as ZenXCapabilityService;

  try {
    await installZenXBundledPluginsAtStartup(
      capabilities,
      path.join(directory, "resources"),
    );
    assert.deepEqual(installCalls, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup refreshes changed bytes at the same bundled path and preserves inactive choices", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-bundled-bytes-"),
  );
  const resourcesDirectory = path.join(directory, "resources");
  const tarballPath = path.join(
    resourcesDirectory,
    "plugins",
    ZENX_ROOMS_TARBALL,
  );
  await mkdir(path.dirname(tarballPath), { recursive: true });
  await writeFile(tarballPath, "changed resource bytes");
  const canonicalTarball = await realpath(tarballPath);
  let lifecycle = "enabled";
  let current = false;
  const installCalls: unknown[][] = [];
  const capabilities = {
    pluginCatalogAvailable: () => true,
    pluginSnapshot: () => ({
      plugins: [
        {
          id: ZENX_ROOMS_CAPABILITY_ID,
          lifecycle,
          profileSource: { mode: "bundled", packageSpec: canonicalTarball },
        },
        { id: "zenx-self-control", lifecycle: "uninstalled" },
        { id: "zenx-triggers", lifecycle: "uninstalled" },
        { id: "zenx-subagents", lifecycle: "uninstalled" },
        { id: "zenx-fleet", lifecycle: "uninstalled" },
      ],
    }),
    bundledPluginPackageCurrent: async () => current,
    installBundledPluginPackage: async (...args: unknown[]) => {
      installCalls.push(args);
    },
    browserProfilePackage: () => {
      throw new Error("unavailable");
    },
    computerProfilePackage: () => {
      throw new Error("unavailable");
    },
    recordBundledPluginStartupError: (_pluginId: string, error: unknown) => {
      throw error;
    },
  } as unknown as ZenXCapabilityService;
  try {
    await installZenXBundledPluginsAtStartup(capabilities, resourcesDirectory);
    assert.equal(installCalls.length, 1);
    assert.deepEqual(installCalls[0]?.[2], {
      allowSameVersionBundledVariant: true,
    });
    current = true;
    await installZenXBundledPluginsAtStartup(capabilities, resourcesDirectory);
    current = false;
    lifecycle = "installed";
    await installZenXBundledPluginsAtStartup(capabilities, resourcesDirectory);
    lifecycle = "uninstalled";
    await installZenXBundledPluginsAtStartup(capabilities, resourcesDirectory);
    assert.equal(installCalls.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Subagents is installed on first startup and explicit uninstall is preserved", async () => {
  const definitions = [
    { id: "zenx-rooms", lifecycle: "uninstalled" },
    { id: "zenx-self-control", lifecycle: "uninstalled" },
    { id: "zenx-triggers", lifecycle: "uninstalled" },
    { id: "zenx-fleet", lifecycle: "uninstalled" },
  ];
  const calls: unknown[][] = [];
  const capabilities = {
    pluginCatalogAvailable: () => true,
    pluginSnapshot: () => ({ plugins: definitions }),
    installBundledPluginPackage: async (...args: unknown[]) => {
      calls.push(args);
    },
    browserProfilePackage: () => {
      throw new Error("unavailable");
    },
    computerProfilePackage: () => {
      throw new Error("unavailable");
    },
    recordBundledPluginStartupError: (_id: string, error: unknown) => {
      throw error;
    },
  } as unknown as ZenXCapabilityService;
  await installZenXBundledPluginsAtStartup(capabilities, "/resources");
  assert.deepEqual(calls[0]?.slice(0, 2), [
    "/resources/plugins/zenx-subagents-plugin-1.0.0.tgz",
    { pluginId: "zenx-subagents", packageName: "@zenx/subagents-plugin" },
  ]);
  definitions.push({ id: "zenx-subagents", lifecycle: "uninstalled" });
  await installZenXBundledPluginsAtStartup(capabilities, "/resources");
  assert.equal(calls.length, 1);
});

test("Fleet startup preserves an npm override and explicit uninstall, and repairs disabled bundled content", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-fleet-startup-"),
  );
  const definition = FIRST_PARTY_PLUGIN_PACKAGES.fleet;
  const tarballPath = path.join(directory, "plugins", definition.tarball);
  await mkdir(path.dirname(tarballPath), { recursive: true });
  await writeFile(tarballPath, "fixture");
  const canonicalTarball = await realpath(tarballPath);
  let lifecycle = "installed";
  let mode = "npm";
  let packageSpec = definition.packageName;
  let current = false;
  const calls: unknown[][] = [];
  const capabilities = {
    pluginCatalogAvailable: () => true,
    pluginSnapshot: () => ({
      plugins: [
        { id: "zenx-rooms", lifecycle: "uninstalled" },
        { id: "zenx-self-control", lifecycle: "uninstalled" },
        { id: "zenx-triggers", lifecycle: "uninstalled" },
        { id: "zenx-subagents", lifecycle: "uninstalled" },
        {
          id: definition.pluginId,
          lifecycle,
          profileSource: { mode, packageSpec },
        },
      ],
    }),
    bundledPluginPackageCurrent: async () => current,
    installBundledPluginPackage: async (...args: unknown[]) => {
      calls.push(args);
    },
    browserProfilePackage: () => {
      throw new Error("unavailable");
    },
    computerProfilePackage: () => {
      throw new Error("unavailable");
    },
    recordBundledPluginStartupError: (_id: string, error: unknown) => {
      throw error;
    },
  } as unknown as ZenXCapabilityService;

  try {
    await installZenXBundledPluginsAtStartup(capabilities, directory);
    assert.deepEqual(calls, []);

    mode = "bundled";
    packageSpec = canonicalTarball;
    lifecycle = "uninstalled";
    await installZenXBundledPluginsAtStartup(capabilities, directory);
    assert.deepEqual(calls, []);

    lifecycle = "installed";
    await installZenXBundledPluginsAtStartup(capabilities, directory);
    assert.deepEqual(calls, [
      [
        tarballPath,
        { pluginId: definition.pluginId, packageName: definition.packageName },
        { allowSameVersionBundledVariant: true },
      ],
    ]);

    current = true;
    await installZenXBundledPluginsAtStartup(capabilities, directory);
    assert.equal(calls.length, 1);

    packageSpec = path.join(directory, "old-worktree", definition.tarball);
    await installZenXBundledPluginsAtStartup(capabilities, directory);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]?.[2], { allowSameVersionBundledVariant: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Fleet startup commits the normal package without grants and keeps disabled/uninstalled choices across restart", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-fleet-profile-"),
  );
  const userData = path.join(directory, "profile");
  let resourcesDirectory = path.join(directory, "resources");
  const definition = FIRST_PARTY_PLUGIN_PACKAGES.fleet;
  await mkdir(path.join(resourcesDirectory, "plugins"), { recursive: true });
  await copyFile(
    fileURLToPath(
      new URL(`../resources/plugins/${definition.tarball}`, import.meta.url),
    ),
    path.join(resourcesDirectory, "plugins", definition.tarball),
  );
  let invocations = 0;
  const unexpectedInvocation = async () => {
    invocations += 1;
    throw new Error("Startup must not invoke Fleet tools");
  };
  const fleetPackage = new ZenXFleetCapabilityPackage({
    threads: {
      invoke: unexpectedInvocation,
    } as unknown as ZenXSelfControlCapabilityPackage,
    fleet: { devices: unexpectedInvocation } as unknown as FleetSettingsService,
  });
  const create = () =>
    new ZenXCapabilityService({
      userDataDirectory: userData,
      resourcesDirectory,
      bundledProvidersOnly: true,
      pnpmCliPath: fileURLToPath(
        new URL("../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
      ),
      trustedProfileLoaders: {
        [definition.pluginId]: createDelegatingFirstPartyProfileLoader(
          () => fleetPackage,
        ),
      },
    });
  let service = create();
  const startup = () =>
    installZenXBundledPluginsAtStartup(
      {
        pluginCatalogAvailable: () => service.pluginCatalogAvailable(),
        pluginSnapshot: () => ({
          plugins: [
            ...service.pluginSnapshot().plugins,
            { id: "zenx-rooms", lifecycle: "uninstalled" },
            { id: "zenx-self-control", lifecycle: "uninstalled" },
            { id: "zenx-triggers", lifecycle: "uninstalled" },
            { id: "zenx-subagents", lifecycle: "uninstalled" },
          ],
        }),
        bundledPluginPackageCurrent: (
          ...args: Parameters<
            ZenXCapabilityService["bundledPluginPackageCurrent"]
          >
        ) => service.bundledPluginPackageCurrent(...args),
        installBundledPluginPackage: (
          ...args: Parameters<
            ZenXCapabilityService["installBundledPluginPackage"]
          >
        ) => service.installBundledPluginPackage(...args),
        browserProfilePackage: () => {
          throw new Error("unavailable");
        },
        computerProfilePackage: () => {
          throw new Error("unavailable");
        },
        recordBundledPluginStartupError: (_id: string, error: unknown) => {
          throw error;
        },
      } as unknown as ZenXCapabilityService,
      resourcesDirectory,
    );
  const catalogFile = path.join(userData, "capability-grants.json");

  try {
    await service.initialize();
    await startup();
    const installed = service
      .pluginSnapshot()
      .plugins.find((plugin) => plugin.id === definition.pluginId);
    assert.equal(installed?.available, true);
    assert.equal(installed?.lifecycle, "enabled");
    assert.equal(installed?.source, "bundled");
    assert.equal(installed?.profileSource?.packageName, definition.packageName);
    assert.deepEqual(installed?.permissions, fleetPackage.manifest.permissions);
    assert.deepEqual(
      service
        .hostSnapshot()
        .definitions.map((tool) => tool.name)
        .sort(),
      fleetPackage.manifest.tools.map((tool) => tool.name).sort(),
    );
    const cleanCatalog = JSON.parse(await readFile(catalogFile, "utf8"));
    assert.equal("grants" in cleanCatalog, false);
    assert.deepEqual(cleanCatalog.disabled, []);
    assert.deepEqual(cleanCatalog.uninstalled, []);

    await service.setEnabled(definition.pluginId, false);
    await service.close();
    const movedResources = path.join(directory, "moved-resources");
    await rename(resourcesDirectory, movedResources);
    resourcesDirectory = movedResources;
    service = create();
    await service.initialize();
    await startup();
    const disabled = service
      .pluginSnapshot()
      .plugins.find((plugin) => plugin.id === definition.pluginId);
    assert.equal(disabled?.available, true);
    assert.equal(disabled?.lifecycle, "installed");
    assert.equal(disabled?.enabled, false);
    assert.equal(
      disabled?.profileSource?.packageSpec,
      await realpath(
        path.join(resourcesDirectory, "plugins", definition.tarball),
      ),
    );
    assert.deepEqual(service.hostSnapshot().definitions, []);
    const repairedCatalog = JSON.parse(await readFile(catalogFile, "utf8"));
    assert.deepEqual(repairedCatalog.disabled, [definition.pluginId]);
    assert.equal("grants" in repairedCatalog, false);

    await service.uninstall(definition.pluginId);
    const uninstalledCatalog = await readFile(catalogFile, "utf8");
    await service.close();
    service = create();
    await service.initialize();
    await startup();
    assert.equal(
      service
        .pluginSnapshot()
        .plugins.find((plugin) => plugin.id === definition.pluginId)?.lifecycle,
      "uninstalled",
    );
    assert.deepEqual(service.hostSnapshot().definitions, []);
    assert.equal(await readFile(catalogFile, "utf8"), uninstalledCatalog);
    assert.equal(invocations, 0);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
