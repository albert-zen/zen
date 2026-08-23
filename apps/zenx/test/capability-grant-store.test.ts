import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";

test("persists permission grants and distinct plugin enablement atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-grants-"));
  const filePath = path.join(directory, "grants.json");
  const store = new JsonZenXCapabilityGrantStore(filePath);
  try {
    assert.deepEqual(await store.load(), {
      grants: {},
      disabled: [],
      uninstalled: [],
      packages: {},
    });
    await store.save({
      grants: {
        browser: [
          { permissionId: "browser.tabs.read", scope: "browser-session" },
        ],
      },
      disabled: ["zenx-rooms"],
      uninstalled: [],
      packages: {},
    });
    assert.deepEqual(await store.load(), {
      grants: {
        browser: [
          { permissionId: "browser.tabs.read", scope: "browser-session" },
        ],
      },
      disabled: ["zenx-rooms"],
      uninstalled: [],
      packages: {},
    });
    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /cookie|credential|token/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates the version 1 grants document with every plugin enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-grants-v1-"));
  const filePath = path.join(directory, "grants.json");
  try {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        grants: {
          browser: [
            { permissionId: "browser.tabs.read", scope: "browser-session" },
          ],
        },
      }),
    );
    const store = new JsonZenXCapabilityGrantStore(filePath);
    assert.deepEqual(await store.load(), {
      grants: {
        browser: [
          { permissionId: "browser.tabs.read", scope: "browser-session" },
        ],
      },
      disabled: [],
      uninstalled: [],
      packages: {},
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
