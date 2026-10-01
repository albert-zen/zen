import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installZenXBundledPluginsAtStartup } from "../src/main/bundled-plugin-startup.js";
import type { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZENX_ROOMS_CAPABILITY_ID } from "../src/main/capabilities/automation-control-package.js";
import { ZENX_ROOMS_TARBALL } from "../src/main/rooms-profile-loader.js";

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
