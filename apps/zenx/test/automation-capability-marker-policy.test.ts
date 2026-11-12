import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type { ZenXCapabilityPackage } from "../src/main/capabilities/types.js";
import {
  JsonPluginStorage,
  type ZenXPluginHostSdkV1,
} from "../src/main/plugin-host-sdk.js";
import { openAutomationTransactionStorage } from "../src/main/automation-transaction-migration.js";

async function fixture(t: test.TestContext, disabled: string[] = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-marker-policy-"));
  const root = path.join(directory, "plugin-data");
  const service = new ZenXCapabilityService({
    userDataDirectory: directory,
    catalogStore: {
      load: async () => ({ disabled, uninstalled: [], packages: {} }),
      save: async () => {},
    },
    bundledProvidersOnly: true,
    providerCatalogOptions: { platform: "darwin", environment: {} },
  });
  let catalog!: ZenXPluginCatalog;
  const original = ZenXPluginCatalog.prototype.initialize;
  ZenXPluginCatalog.prototype.initialize = async function () {
    catalog = this;
    await original.call(this);
  };
  try {
    await service.initialize();
  } finally {
    ZenXPluginCatalog.prototype.initialize = original;
  }
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { root, service, catalog };
}

function candidate(
  id: string,
  version = 2,
  starts: ZenXPluginHostSdkV1[] = [],
  packageVersion = "1.0.0",
): ZenXCapabilityPackage {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: "Synthetic marker policy",
      version: packageVersion,
      storageVersion: version,
      description: "Synthetic",
      compatibility: { zenx: ">=0.1.0 <0.2.0" },
      runtime: { type: "bundled", entry: "synthetic" },
      mainDocument: "Synthetic.",
      provider: {
        id: id + "-provider",
        platforms: ["*"],
        interactionModes: ["background_safe"],
        capabilities: ["synthetic.echo"],
      },
      permissions: [],
      tools: [
        {
          name: id.replaceAll("-", "_") + "_echo",
          description: "Synthetic",
          inputSchema: { type: "object" },
          permissions: [],
          interactionMode: "background_safe",
          capabilities: ["synthetic.echo"],
        },
      ],
    },
    storage: {
      version,
      initialValue: { injected: true },
      migrations: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: () => {
            throw Error("Package migration must not run");
          },
        },
      ],
    },
    start: (sdk) => {
      starts.push(sdk);
    },
    invoke: async () => null,
  };
}
async function migrated(root: string) {
  const storage = await openAutomationTransactionStorage({
    storageRoot: root,
    loadLegacy: async () => ({ rooms: [], triggers: [], history: [] }),
  });
  await storage.close();
}
async function raw(root: string, id: string) {
  return await readFile(path.join(root, id, "storage.json"), "utf8");
}
async function put(root: string, id: string, value: string) {
  await mkdir(path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, "storage.json"), value);
}

for (const id of ["zenx-triggers", "zenx-rooms"]) {
  test(
    id +
      " install/update/enable preserve Host markers and expose only readonly storage",
    async (t) => {
      const { root, service, catalog } = await fixture(t);
      await migrated(root);
      const before = await raw(root, id);
      const starts: ZenXPluginHostSdkV1[] = [];
      const prepared: Parameters<typeof JsonPluginStorage.prepare>[0][] = [];
      const originalPrepare = JsonPluginStorage.prepare;
      JsonPluginStorage.prepare = async function (options) {
        if (options.pluginId === id) prepared.push(options);
        return await originalPrepare.call(this, options);
      };
      t.after(() => {
        JsonPluginStorage.prepare = originalPrepare;
      });
      await catalog.install(candidate(id, 2, starts), "bundled");
      await service.setEnabled(id, false);
      await service.setEnabled(id, true);
      await catalog.update(candidate(id, 2, starts, "1.0.1"), "bundled");
      assert.equal(starts.length, 3);
      assert.equal(prepared.length, 3);
      for (const options of prepared) {
        assert.equal(options.version, 2);
        assert.equal(options.syncWrites, true);
        assert.equal(options.migrations, undefined);
        assert.equal(options.initialValue, undefined);
      }
      assert.deepEqual(
        await starts.at(-1)!.storage.get(),
        JSON.parse(before).value,
      );
      await assert.rejects(
        starts.at(-1)!.storage.set({ injected: true }),
        /read-only/,
      );
      assert.equal(await raw(root, id), before);
      await service.setEnabled(id, false);
      await assert.rejects(
        service.deletePluginData(id),
        /share history|shared automation data/i,
      );
      assert.equal(await raw(root, id), before);
    },
  );

  test(
    id +
      " refuses missing marker bootstrap and version 1 downgrade before package migration",
    async (t) => {
      const { root, catalog } = await fixture(t);
      await assert.rejects(
        catalog.install(candidate(id), "bundled"),
        /Host-managed|marker/i,
      );
      await assert.rejects(raw(root, id), /ENOENT/);
      await migrated(root);
      const before = await raw(root, id);
      await assert.rejects(
        catalog.install(candidate(id, 1), "bundled"),
        /version 2/,
      );
      assert.equal(await raw(root, id), before);
    },
  );

  test(id + " rejects future peer format without any rewriting", async (t) => {
    const { root, catalog } = await fixture(t);
    await migrated(root);
    const peer = id === "zenx-rooms" ? "zenx-triggers" : "zenx-rooms";
    const future = '{ "version" : 3, "value": {"future":"preserve"} }\n';
    await put(root, peer, future);
    const before = await raw(root, id);
    await assert.rejects(
      catalog.install(candidate(id), "bundled"),
      /Future|future|requires version 2/,
    );
    assert.equal(await raw(root, id), before);
    assert.equal(await raw(root, peer), future);
  });
}

test("Delete data refuses orphan/unknown automation artifacts and malformed peer marker before rm", async (t) => {
  const { root, service } = await fixture(t);
  const target = path.join(root, "zenx-rooms", "sentinel");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "preserve");
  const history = path.join(root, "zenx-rooms", "automation-history");
  await mkdir(history);
  await writeFile(path.join(history, "unknown-partial"), "unknown");
  await assert.rejects(
    service.deletePluginData("zenx-rooms"),
    /share history|shared automation data/i,
  );
  assert.equal(await readFile(target, "utf8"), "preserve");
  await rm(history, { recursive: true });
  await put(root, "zenx-triggers", "{broken");
  await assert.rejects(
    service.deletePluginData("zenx-rooms"),
    /share history|shared automation data/i,
  );
  assert.equal(await readFile(target, "utf8"), "preserve");
});

test("unrelated plugin legacy storage keeps ordinary writable SDK and delete behavior", async (t) => {
  const { root, service, catalog } = await fixture(t);
  const starts: ZenXPluginHostSdkV1[] = [];
  await catalog.install(candidate("synthetic-ordinary", 1, starts), "bundled");
  await starts[0]!.storage.set({ ordinary: true });
  await service.setEnabled("synthetic-ordinary", false);
  await service.deletePluginData("synthetic-ordinary");
  await assert.rejects(raw(root, "synthetic-ordinary"), /ENOENT/);
});

test("legacy disabled Room delete still clears v1 room data without removing peer triggers", async (t) => {
  const { root, service, catalog } = await fixture(t, ["zenx-rooms"]);
  await catalog.install(candidate("zenx-rooms", 1), "bundled");
  await put(
    root,
    "zenx-rooms",
    JSON.stringify({ version: 1, value: { legacy: true } }),
  );
  await put(
    root,
    "zenx-triggers",
    JSON.stringify({
      version: 1,
      value: {
        triggers: [{ id: "preserve-trigger" }],
        rooms: [{ id: "old-room" }],
        history: [],
      },
    }),
  );
  await service.deletePluginData("zenx-rooms");
  await assert.rejects(raw(root, "zenx-rooms"), /ENOENT/);
  const peer = JSON.parse(await raw(root, "zenx-triggers"));
  assert.deepEqual(peer.value.triggers, [{ id: "preserve-trigger" }]);
  assert.deepEqual(peer.value.rooms, []);
});
