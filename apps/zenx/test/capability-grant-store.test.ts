import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";

test("persists only explicit capability permission grants", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-grants-"));
  const filePath = path.join(directory, "grants.json");
  const store = new JsonZenXCapabilityGrantStore(filePath);
  try {
    assert.deepEqual(await store.load(), {});
    await store.save({
      browser: [
        { permissionId: "browser.tabs.read", scope: "browser-session" },
      ],
    });
    assert.deepEqual(await store.load(), {
      browser: [
        { permissionId: "browser.tabs.read", scope: "browser-session" },
      ],
    });
    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /cookie|credential|token/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
