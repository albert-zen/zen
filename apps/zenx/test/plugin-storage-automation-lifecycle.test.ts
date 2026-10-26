import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { ZenXTriggersCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import {
  createDelegatingFirstPartyProfileLoader,
  FIRST_PARTY_PLUGIN_PACKAGES,
} from "../src/main/first-party-profile-loader.js";
import {
  createZenXRoomsProfileLoader,
  ZENX_ROOMS_PACKAGE_NAME,
} from "../src/main/rooms-profile-loader.js";
import { ZENX_ROOMS_TARBALL } from "../scripts/pack-first-party-plugins.mjs";

for (const order of [
  ["zenx-triggers", "zenx-rooms"],
  ["zenx-rooms", "zenx-triggers"],
]) {
  test(`candidate-owned lifecycle storage admits real ${order.join(" then ")} and rollback preserves the running service`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-storage-automation-"),
    );
    const resourcesDirectory = fileURLToPath(
      new URL("../resources", import.meta.url),
    );
    const domain = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer: {
        request: async () => {
          throw new Error("fixture must not start work");
        },
        onNotification: () => () => {},
      },
    });
    const sharedPackage = new ZenXTriggersCapabilityPackage(domain);
    const catalog = new JsonZenXPluginCatalogStore(
      path.join(directory, "capability-grants.json"),
    );
    let failSave = false;
    const capabilities = new ZenXCapabilityService({
      userDataDirectory: directory,
      resourcesDirectory,
      pnpmCliPath: fileURLToPath(
        new URL("../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
      ),
      bundledProvidersOnly: true,
      catalogStore: {
        load: () => catalog.load(),
        save: async (state) => {
          if (failSave) throw new Error("candidate catalog failure");
          await catalog.save(state);
        },
      },
      trustedProfileLoaders: {
        "zenx-triggers": createDelegatingFirstPartyProfileLoader(
          () => sharedPackage,
        ),
        "zenx-rooms": createZenXRoomsProfileLoader(() => domain),
      },
    });
    const install = async (id: string) => {
      const definition =
        id === "zenx-triggers"
          ? FIRST_PARTY_PLUGIN_PACKAGES.triggers
          : {
              pluginId: "zenx-rooms",
              packageName: ZENX_ROOMS_PACKAGE_NAME,
              tarball: ZENX_ROOMS_TARBALL,
            };
      return capabilities.installBundledPluginPackage(
        path.join(resourcesDirectory, "plugins", definition.tarball),
        definition,
      );
    };
    try {
      await capabilities.initialize();
      for (const id of order) {
        await install(id);
        assert.equal(
          capabilities.pluginSnapshot().plugins.find((p) => p.id === id)
            ?.available,
          true,
        );
      }
      assert.equal(domain.triggersAvailable(), true);
      assert.equal(domain.roomsAvailable(), true);
      await domain.createRoom({
        name: "preserved room",
        members: [{ name: "Member", threadId: "fixture-thread" }],
      });
      await capabilities.setEnabled("zenx-triggers", false);
      await capabilities.setEnabled("zenx-triggers", true);
      assert.equal(domain.triggersAvailable(), true);
      assert.equal(domain.snapshot().rooms[0]?.name, "preserved room");
      await capabilities.setEnabled("zenx-triggers", false);
      failSave = true;
      await assert.rejects(
        capabilities.setEnabled("zenx-triggers", true),
        /candidate catalog failure/u,
      );
      failSave = false;
      assert.equal(domain.triggersAvailable(), false);
      await domain.createRoom({
        name: "after rollback",
        members: [{ name: "Member", threadId: "fixture-thread" }],
      });
      assert.equal(domain.snapshot().rooms.length, 2);
      await capabilities.setEnabled("zenx-triggers", true);
      assert.equal(domain.triggersAvailable(), true);
      await capabilities.setEnabled("zenx-triggers", false);
      assert.equal(domain.triggersAvailable(), false);
      await capabilities.setEnabled("zenx-triggers", true);
      assert.equal(domain.triggersAvailable(), true);
    } finally {
      failSave = false;
      await capabilities.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
