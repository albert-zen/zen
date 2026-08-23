import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZenXCapabilityRegistry } from "../src/main/capabilities/registry.js";
import type {
  ZenXCapabilityConfiguration,
  ZenXCapabilityPackage,
  ZenXPluginManifestV2,
} from "../src/main/capabilities/types.js";

function manifest(id = "fixture", tool = "fixture_run"): ZenXPluginManifestV2 {
  return {
    schemaVersion: 2,
    id,
    name: id === "fixture" ? "Fixture" : id,
    version: "1.0.0",
    description: "Plugin package v2 fixture",
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: { type: "bundled", entry: `fixtures/${id}` },
    mainDocument: `Use ${id} through its declared tools.`,
    provider: {
      id: `${id}-provider`,
      platforms: ["*"],
      interactionModes: ["background_safe"],
      capabilities: [`${id}.run`],
    },
    permissions: [],
    tools: [
      {
        name: tool,
        description: `Run ${id}`,
        inputSchema: { type: "object" },
        permissions: [],
        interactionMode: "background_safe",
        capabilities: [`${id}.run`],
      },
    ],
    resources: [],
    contributions: {
      pages: [
        {
          id: "home",
          title: id,
          route: `/plugins/${id}/home`,
        },
      ],
      sidebar: [{ id: "home", label: id, icon: "plug", pageId: "home" }],
    },
  };
}

function plugin(pluginManifest: ZenXPluginManifestV2): ZenXCapabilityPackage {
  return {
    manifest: pluginManifest,
    invoke: async () => ({ ok: true }),
  };
}

test("persists v2 install/enable/uninstall/reinstall and keeps plugin data", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "zenx-catalog-"));
  const store = new JsonZenXCapabilityGrantStore(
    path.join(userData, "plugin-catalog.json"),
  );
  const dataDirectory = path.join(userData, "plugin-data");
  try {
    const registry = new ZenXCapabilityRegistry(store, {
      pluginDataDirectory: dataDirectory,
    });
    await registry.initialize();
    await registry.install(plugin(manifest()), "local");
    assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
    assert.equal(registry.hostSnapshot().definitions[0]?.name, "fixture_run");

    await registry.setEnabled("fixture", false);
    assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "installed");
    assert.deepEqual(registry.hostSnapshot().definitions, []);
    assert.deepEqual(registry.pluginSnapshot().pages, []);
    assert.deepEqual(registry.snapshot().capabilities, []);

    await registry.setEnabled("fixture", true);
    await mkdir(path.join(dataDirectory, "fixture"), { recursive: true });
    await writeFile(
      path.join(dataDirectory, "fixture", "state.json"),
      "preserved",
    );
    await mkdir(path.join(dataDirectory, "other"), { recursive: true });
    await writeFile(
      path.join(dataDirectory, "other", "state.json"),
      "untouched",
    );
    const journal = path.join(userData, "zen-data", "threads", "trace.jsonl");
    await mkdir(path.dirname(journal), { recursive: true });
    const trace =
      '{"type":"reasoning","text":"exact"}\n{"type":"tool_result","output":"raw"}\n';
    await writeFile(journal, trace);
    await registry.uninstall("fixture");
    assert.equal(
      registry.pluginSnapshot().plugins[0]?.lifecycle,
      "uninstalled",
    );
    assert.deepEqual(registry.hostSnapshot().definitions, []);
    assert.deepEqual(registry.pluginSnapshot().sidebar, []);
    assert.equal(
      await readFile(path.join(dataDirectory, "fixture", "state.json"), "utf8"),
      "preserved",
    );

    const restarted = new ZenXCapabilityRegistry(store, {
      pluginDataDirectory: dataDirectory,
    });
    await restarted.initialize();
    assert.equal(restarted.pluginSnapshot().plugins[0]?.available, false);
    assert.equal(
      restarted.pluginSnapshot().plugins[0]?.lifecycle,
      "uninstalled",
    );
    await restarted.install(plugin(manifest()), "local");
    assert.equal(restarted.pluginSnapshot().plugins[0]?.available, true);
    assert.equal(
      restarted.pluginSnapshot().plugins[0]?.lifecycle,
      "uninstalled",
    );
    assert.deepEqual(restarted.hostSnapshot().definitions, []);

    await restarted.reinstall("fixture");
    assert.equal(restarted.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
    assert.equal(restarted.hostSnapshot().definitions[0]?.name, "fixture_run");
    assert.equal(
      await readFile(path.join(dataDirectory, "fixture", "state.json"), "utf8"),
      "preserved",
    );

    await restarted.setEnabled("fixture", false);
    await restarted.deleteData("fixture");
    await assert.rejects(
      readFile(path.join(dataDirectory, "fixture", "state.json"), "utf8"),
      /ENOENT/u,
    );
    assert.equal(
      await readFile(path.join(dataDirectory, "other", "state.json"), "utf8"),
      "untouched",
    );
    assert.equal(await readFile(journal, "utf8"), trace);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("bundled packages use the same lifecycle and reinstall from the supplied package", async () => {
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
  await registry.install(
    plugin(manifest("zenx-triggers", "zenx_triggers_list")),
    "bundled",
  );
  await registry.uninstall("zenx-triggers");
  assert.deepEqual(registry.hostSnapshot().definitions, []);
  await registry.reinstall("zenx-triggers");
  assert.equal(
    registry.hostSnapshot().definitions[0]?.name,
    "zenx_triggers_list",
  );
});

test("registration and persistence failures leave lifecycle and projections unchanged", async () => {
  let failSave = false;
  const store = {
    load: async () => ({
      grants: {},
      disabled: [],
      uninstalled: [],
      packages: {},
    }),
    save: async () => {
      if (failSave) throw new Error("catalog unavailable");
    },
  };
  const registry = new ZenXCapabilityRegistry(store);
  await registry.initialize();
  await registry.install(plugin(manifest()), "local");
  const before = registry.pluginSnapshot();
  failSave = true;
  await assert.rejects(registry.uninstall("fixture"), /catalog unavailable/u);
  assert.deepEqual(registry.pluginSnapshot(), before);
  assert.equal(registry.hostSnapshot().definitions[0]?.name, "fixture_run");

  failSave = false;
  await registry.uninstall("fixture");
  const uninstalled = registry.pluginSnapshot();
  await assert.rejects(
    registry.install(plugin(manifest("other", "fixture_run")), "local"),
    /must be namespaced with other_/u,
  );
  assert.deepEqual(registry.pluginSnapshot(), uninstalled);

  const closeFailure = new ZenXCapabilityRegistry({
    load: async () => ({
      grants: {},
      disabled: [],
      uninstalled: [],
      packages: {},
    }),
    save: async () => {},
  });
  await closeFailure.initialize();
  const failingPackage = plugin(manifest("close-failure", "close_failure_run"));
  failingPackage.close = async () => {
    throw new Error("runtime unregister failed");
  };
  await closeFailure.install(failingPackage, "bundled");
  const beforeCloseFailure = closeFailure.pluginSnapshot();
  await assert.rejects(
    closeFailure.uninstall("close-failure"),
    /runtime unregister failed/u,
  );
  assert.deepEqual(closeFailure.pluginSnapshot(), beforeCloseFailure);
  assert.equal(
    closeFailure.hostSnapshot().definitions[0]?.name,
    "close_failure_run",
  );
});

test("concurrent lifecycle mutations converge in invocation order", async () => {
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
  await registry.install(plugin(manifest()), "local");
  await Promise.all([
    registry.uninstall("fixture"),
    registry.reinstall("fixture"),
  ]);
  assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
  assert.equal(registry.hostSnapshot().definitions[0]?.name, "fixture_run");
});

test("update swaps version and contributions atomically while preserving lifecycle", async () => {
  let failSave = false;
  let durable = {
    grants: {},
    disabled: [] as string[],
    uninstalled: [] as string[],
    packages: {},
  };
  const registry = new ZenXCapabilityRegistry({
    load: async () => structuredClone(durable),
    save: async (configuration) => {
      if (failSave) throw new Error("update catalog unavailable");
      durable = structuredClone(configuration) as typeof durable;
    },
  });
  await registry.initialize();
  await registry.install(plugin(manifest()), "local");
  const v2 = manifest();
  v2.version = "2.0.0";
  v2.description = "Updated package";
  v2.contributions!.pages![0]!.title = "Fixture v2";
  await registry.update(plugin(v2), "local");
  assert.equal(registry.pluginSnapshot().plugins[0]?.version, "2.0.0");
  assert.equal(registry.pluginSnapshot().pages[0]?.title, "Fixture v2");
  assert.equal(registry.hostSnapshot().definitions[0]?.name, "fixture_run");

  const v3 = structuredClone(v2);
  v3.version = "3.0.0";
  failSave = true;
  await assert.rejects(
    registry.update(plugin(v3), "local"),
    /update catalog unavailable/u,
  );
  assert.equal(registry.pluginSnapshot().plugins[0]?.version, "2.0.0");
  assert.equal(registry.pluginSnapshot().pages[0]?.title, "Fixture v2");
  assert.equal(registry.hostSnapshot().definitions[0]?.name, "fixture_run");
});

test("service update runs Host SDK storage migration exactly once before publishing v2", async () => {
  const userData = await mkdtemp(
    path.join(os.tmpdir(), "zenx-update-migration-"),
  );
  let migrations = 0;
  let failCatalogSave = false;
  let catalog: ZenXCapabilityConfiguration = {
    grants: {},
    disabled: [],
    uninstalled: [],
    packages: {},
  };
  const service = new ZenXCapabilityService({
    userDataDirectory: userData,
    grantStore: {
      load: async () => structuredClone(catalog),
      save: async (configuration) => {
        if (failCatalogSave) throw new Error("fixture catalog save failed");
        catalog = structuredClone(configuration);
      },
    },
    localDirectory: path.join(userData, "none"),
    bundledProvidersOnly: true,
  });
  const v1 = plugin(manifest());
  v1.storage = { version: 1, initialValue: { count: 1 } };
  const v2Manifest = manifest();
  v2Manifest.version = "2.0.0";
  v2Manifest.storageVersion = 2;
  const v2 = plugin(v2Manifest);
  v2.storage = {
    version: 2,
    migrations: [
      {
        fromVersion: 1,
        toVersion: 2,
        migrate: (value) => {
          migrations += 1;
          return { ...(value as object), migrated: true };
        },
      },
    ],
  };
  try {
    await service.initialize();
    await service.install(v1, "local");
    await service.update(v2, "local");
    assert.equal(migrations, 1);
    assert.equal(service.pluginSnapshot().plugins[0]?.version, "2.0.0");
    await service.setEnabled("fixture", false);
    await service.setEnabled("fixture", true);
    assert.equal(migrations, 1);
    const stored = JSON.parse(
      await readFile(
        path.join(userData, "plugin-data", "fixture", "storage.json"),
        "utf8",
      ),
    ) as { version: number; value: unknown };
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.value, { count: 1, migrated: true });
    const v3Manifest = manifest();
    v3Manifest.version = "3.0.0";
    v3Manifest.storageVersion = 3;
    const v3 = plugin(v3Manifest);
    v3.storage = {
      version: 3,
      migrations: [
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: () => {
            throw new Error("fixture migration failed");
          },
        },
      ],
    };
    await assert.rejects(
      service.update(v3, "local"),
      /fixture migration failed/u,
    );
    assert.equal(service.pluginSnapshot().plugins[0]?.version, "2.0.0");
    assert.equal(service.hostSnapshot().definitions[0]?.name, "fixture_run");
    const saveFailure = plugin(v3Manifest);
    saveFailure.storage = {
      version: 3,
      migrations: [
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: (value) => ({ ...(value as object), shouldRollback: true }),
        },
      ],
    };
    failCatalogSave = true;
    await assert.rejects(
      service.update(saveFailure, "local"),
      /fixture catalog save failed/u,
    );
    const afterFailedSave = JSON.parse(
      await readFile(
        path.join(userData, "plugin-data", "fixture", "storage.json"),
        "utf8",
      ),
    ) as { version: number; value: unknown };
    assert.equal(afterFailedSave.version, 2);
    assert.deepEqual(afterFailedSave.value, { count: 1, migrated: true });
    assert.equal(service.pluginSnapshot().plugins[0]?.version, "2.0.0");
  } finally {
    await service.close();
    await rm(userData, { recursive: true, force: true });
  }
});
