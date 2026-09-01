import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type {
  ZenXCapabilityPackage,
  ZenXPluginManifestV2,
} from "../src/main/capabilities/types.js";

test("persists profile catalog state without legacy permission grants", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-catalog-"));
  const filePath = path.join(directory, "catalog.json");
  const store = new JsonZenXPluginCatalogStore(filePath);
  try {
    assert.deepEqual(await store.load(), {
      disabled: [],
      uninstalled: [],
      packages: {},
    });
    await store.save({
      disabled: ["zenx-rooms"],
      uninstalled: ["browser"],
      packages: {},
    });
    assert.deepEqual(await store.load(), {
      disabled: ["zenx-rooms"],
      uninstalled: ["browser"],
      packages: {},
    });
    assert.doesNotMatch(await readFile(filePath, "utf8"), /grants/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adopts durable lifecycle facts from the historical catalog file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-catalog-v4-"));
  const filePath = path.join(directory, "capability-grants.json");
  const generation = "12345678-1234-1234-1234-123456789abc";
  try {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 4,
        grants: {
          browser: [
            { permissionId: "browser.tabs.read", scope: "browser-session" },
          ],
        },
        disabled: ["zenx-rooms"],
        uninstalled: ["browser"],
        packages: {},
        profileGeneration: generation,
      }),
    );
    const store = new JsonZenXPluginCatalogStore(filePath);
    assert.deepEqual(await store.load(), {
      disabled: ["zenx-rooms"],
      uninstalled: ["browser"],
      packages: {},
      profileGeneration: generation,
    });
    const catalog = new ZenXPluginCatalog(store);
    await catalog.initialize();
    await catalog.install(foregroundFixture(), "bundled");
    assert.deepEqual(
      catalog.hostSnapshot().definitions.map((definition) => definition.name),
      ["computer_inspect"],
    );
    assert.doesNotMatch(await readFile(filePath, "utf8"), /grants/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function foregroundFixture(): ZenXCapabilityPackage {
  const manifest: ZenXPluginManifestV2 = {
    schemaVersion: 2,
    id: "computer",
    name: "Computer",
    version: "1.0.0",
    description: "Legacy grant migration fixture",
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: { type: "bundled", entry: "fixtures/computer" },
    mainDocument: "Use background-safe Computer tools by default.",
    provider: {
      id: "fixture-computer",
      platforms: ["*"],
      interactionModes: ["background_safe", "foreground_required"],
      capabilities: ["computer.inspect", "foreground.pointer"],
    },
    permissions: [],
    tools: [
      {
        name: "computer_inspect",
        description: "Inspect one app without global input",
        inputSchema: { type: "object" },
        permissions: [],
        interactionMode: "background_safe",
        capabilities: ["computer.inspect"],
      },
      {
        name: "computer_foreground_click",
        description: "Take over the global pointer",
        inputSchema: { type: "object" },
        permissions: [],
        interactionMode: "foreground_required",
        capabilities: ["foreground.pointer"],
      },
    ],
  };
  return { manifest, invoke: async () => ({ ok: true }) };
}
