import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import { ZenXCapabilityRegistry } from "../src/main/capabilities/registry.js";
import type {
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
