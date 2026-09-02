import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type {
  ZenXCapabilityPackage,
  ZenXPluginCatalogState,
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
  const store = new JsonZenXPluginCatalogStore(
    path.join(userData, "plugin-catalog.json"),
  );
  const dataDirectory = path.join(userData, "plugin-data");
  try {
    const registry = new ZenXPluginCatalog(store, {
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
    assert.deepEqual(registry.pluginSnapshot().commands, []);

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

    const restarted = new ZenXPluginCatalog(store, {
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
  const registry = new ZenXPluginCatalog({
    load: async () => ({
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

test("an unreadable optional plugin catalog does not stop the core host", async () => {
  const registry = new ZenXPluginCatalog({
    load: async () => {
      throw new Error("catalog file is unreadable");
    },
    save: async () => {},
  });

  await registry.initialize();

  assert.deepEqual(registry.hostSnapshot().definitions, []);
  assert.equal(registry.pluginCatalogAvailable(), false);
  assert.match(
    registry.diagnostics().discoveryErrors.join("\n"),
    /catalog could not be loaded: catalog file is unreadable/u,
  );
});

test("a malformed plugin descriptor is quarantined without hiding valid plugins", async () => {
  const registry = new ZenXPluginCatalog({
    load: async () => ({
      disabled: [],
      uninstalled: [],
      packages: {
        valid: {
          manifest: manifest("valid", "valid_run"),
          source: "local",
        },
        broken: {
          manifest: { schemaVersion: 1 },
          source: "local",
        },
      } as unknown as ZenXPluginCatalogState["packages"],
    }),
    save: async () => {},
  });

  await registry.initialize();

  assert.deepEqual(
    registry.pluginSnapshot().plugins.map((plugin) => plugin.id),
    ["valid"],
  );
  assert.match(
    registry.diagnostics().discoveryErrors.join("\n"),
    /descriptor broken was quarantined/u,
  );
});

test("foreground-required tools are hidden by default and follow explicit host opt-in", async () => {
  const foreground = manifest("computer", "computer_inspect");
  foreground.provider.interactionModes = [
    "background_safe",
    "foreground_required",
  ];
  foreground.tools.push({
    name: "computer_foreground_click",
    description: "Take over the global pointer",
    inputSchema: { type: "object" },
    permissions: [],
    interactionMode: "foreground_required",
    capabilities: ["computer.run"],
  });
  const registry = new ZenXPluginCatalog({
    load: async () => ({ disabled: [], uninstalled: [], packages: {} }),
    save: async () => {},
  });
  await registry.initialize();
  await registry.install(plugin(foreground), "bundled");

  assert.deepEqual(
    registry.hostSnapshot().definitions.map((definition) => definition.name),
    ["computer_inspect"],
  );
  assert.deepEqual(
    registry.availablePlugins()[0]?.tools.map((tool) => tool.name),
    ["computer_inspect"],
  );

  registry.setForegroundRequiredAllowed(true);
  assert.deepEqual(
    registry.hostSnapshot().definitions.map((definition) => definition.name),
    ["computer_inspect", "computer_foreground_click"],
  );

  registry.setForegroundRequiredAllowed(false);
  assert.deepEqual(
    registry.hostSnapshot().definitions.map((definition) => definition.name),
    ["computer_inspect"],
  );
});

test("registration and persistence failures leave lifecycle and projections unchanged", async () => {
  let failSave = false;
  const store = {
    load: async () => ({
      disabled: [],
      uninstalled: [],
      packages: {},
    }),
    save: async () => {
      if (failSave) throw new Error("catalog unavailable");
    },
  };
  const registry = new ZenXPluginCatalog(store);
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
});

test("concurrent lifecycle mutations converge in invocation order", async () => {
  const registry = new ZenXPluginCatalog({
    load: async () => ({
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
    disabled: [] as string[],
    uninstalled: [] as string[],
    packages: {},
  };
  const registry = new ZenXPluginCatalog({
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
