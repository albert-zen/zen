import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";

test("corrupt optional automation state does not block service construction", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-automation-service-"),
  );
  try {
    await writeFile(
      path.join(userDataDirectory, "trigger-registry.json"),
      "not-json",
    );
    const service = await createBundledAutomationPluginService({
      userDataDirectory,
      appServer: {
        request: async () => ({}) as never,
        onNotification: () => () => {},
      },
    });
    assert.ok(service);
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
