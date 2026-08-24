import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";

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
        disabled: ["computer"],
        uninstalled: ["browser"],
        packages: {},
        profileGeneration: generation,
      }),
    );
    assert.deepEqual(await new JsonZenXPluginCatalogStore(filePath).load(), {
      disabled: ["computer"],
      uninstalled: ["browser"],
      packages: {},
      profileGeneration: generation,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
