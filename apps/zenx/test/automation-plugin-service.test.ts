import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import {
  ZENX_ROOMS_CAPABILITY_ID,
  ZENX_TRIGGERS_CAPABILITY_ID,
  zenXBundledAutomationPackages,
} from "../src/main/capabilities/automation-control-package.js";
import { MemoryZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import type { ZenXTriggerAppServerPort } from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";

test("production bundled packages migrate legacy data and human CRUD creates no Turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-zp9-"));
  const legacyFile = path.join(directory, "trigger-registry.json");
  const legacyStore = new ZenXTriggerStore(legacyFile);
  await legacyStore.write({
    triggers: [
      {
        id: "legacy-trigger",
        threadId: "thread-1",
        kind: "timer",
        label: "Legacy timer",
        prompt: "legacy prompt",
        createdAt: 1,
        active: false,
        timer: { nextRunAt: 10, intervalMinutes: null },
      },
    ],
    history: [],
    rooms: [
      {
        id: "legacy-room",
        name: "legacy",
        members: [{ name: "Reviewer", threadId: "thread-1" }],
        messages: [],
        createdAt: 1,
      },
    ],
  });
  const legacyBytes = await readFile(legacyFile, "utf8");
  let turnStarts = 0;
  const appServer = {
    request: async () => {
      turnStarts += 1;
      throw new Error("Human CRUD must not start a Turn");
    },
    onNotification: () => () => {},
  } as ZenXTriggerAppServerPort;
  const domain = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer,
  });
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: directory,
    grantStore: new MemoryZenXCapabilityGrantStore(),
    localDirectory: path.join(directory, "no-local-packages"),
    bundledProvidersOnly: true,
  });
  try {
    await capabilities.initialize();
    for (const plugin of zenXBundledAutomationPackages(domain))
      await capabilities.install(plugin, "bundled");

    const snapshot = capabilities.pluginSnapshot();
    assert.deepEqual(snapshot.plugins.map((plugin) => plugin.id).sort(), [
      ZENX_ROOMS_CAPABILITY_ID,
      ZENX_TRIGGERS_CAPABILITY_ID,
    ]);
    assert.equal(
      snapshot.pages.every((page) => page.surfaceId !== undefined),
      true,
    );

    const migratedTriggers = (await capabilities.executePluginCommand(
      ZENX_TRIGGERS_CAPABILITY_ID,
      "list",
    )) as { result: { triggers: Array<{ id: string }> } };
    const migratedRooms = (await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "list",
    )) as { result: { rooms: Array<{ id: string }> } };
    assert.deepEqual(
      migratedTriggers.result.triggers.map((item) => item.id),
      ["legacy-trigger"],
    );
    assert.deepEqual(
      migratedRooms.result.rooms.map((item) => item.id),
      ["legacy-room"],
    );
    const directTool = await capabilities.execute({
      callId: "direct-room-list",
      name: "zenx_rooms_list",
      arguments: {},
      cwd: directory,
      signal: new AbortController().signal,
    });
    assert.equal(directTool.exitCode, 0);
    assert.equal(directTool.contentType, undefined);
    assert.deepEqual(
      (
        JSON.parse(directTool.output) as { rooms: Array<{ id: string }> }
      ).rooms.map((room) => room.id),
      ["legacy-room"],
    );

    await capabilities.executePluginCommand(
      ZENX_TRIGGERS_CAPABILITY_ID,
      "create",
      {
        threadId: "thread-2",
        kind: "timer",
        label: "Human timer",
        prompt: "later",
        runAt: Date.now() + 60_000,
      },
    );
    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "create",
      {
        name: "human-room",
        members: [{ name: "Human", threadId: "thread-2" }],
      },
    );
    assert.equal(turnStarts, 0);

    await capabilities.setEnabled(ZENX_TRIGGERS_CAPABILITY_ID, false);
    await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "create",
      {
        name: "while-triggers-disabled",
        members: [{ name: "Human", threadId: "thread-2" }],
      },
    );
    assert.equal(turnStarts, 0);
    await capabilities.uninstall(ZENX_ROOMS_CAPABILITY_ID);
    await assert.rejects(
      capabilities.executePluginCommand(ZENX_ROOMS_CAPABILITY_ID, "list"),
      /not enabled/u,
    );
    await capabilities.reinstall(ZENX_ROOMS_CAPABILITY_ID);
    const restored = (await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "list",
    )) as { result: { rooms: Array<{ name: string }> } };
    assert.equal(
      restored.result.rooms.some(
        (room) => room.name === "while-triggers-disabled",
      ),
      true,
    );

    await capabilities.uninstall(ZENX_ROOMS_CAPABILITY_ID);
    await capabilities.deletePluginData(ZENX_ROOMS_CAPABILITY_ID);
    await capabilities.reinstall(ZENX_ROOMS_CAPABILITY_ID);
    const clearedRooms = (await capabilities.executePluginCommand(
      ZENX_ROOMS_CAPABILITY_ID,
      "list",
    )) as { result: { rooms: unknown[] } };
    assert.deepEqual(clearedRooms.result.rooms, []);
    await capabilities.deletePluginData(ZENX_TRIGGERS_CAPABILITY_ID);
    await capabilities.setEnabled(ZENX_TRIGGERS_CAPABILITY_ID, true);
    const clearedTriggers = (await capabilities.executePluginCommand(
      ZENX_TRIGGERS_CAPABILITY_ID,
      "list",
    )) as { result: { triggers: unknown[] } };
    assert.deepEqual(clearedTriggers.result.triggers, []);

    assert.equal(await readFile(legacyFile, "utf8"), legacyBytes);
    const triggerStorage = JSON.parse(
      await readFile(
        path.join(
          directory,
          "plugin-data",
          ZENX_TRIGGERS_CAPABILITY_ID,
          "storage.json",
        ),
        "utf8",
      ),
    ) as { version: number; value: Record<string, unknown> };
    const roomStorage = JSON.parse(
      await readFile(
        path.join(
          directory,
          "plugin-data",
          ZENX_ROOMS_CAPABILITY_ID,
          "storage.json",
        ),
        "utf8",
      ),
    ) as { version: number; value: Record<string, unknown> };
    assert.equal(triggerStorage.version, 1);
    assert.deepEqual(Object.keys(triggerStorage.value).sort(), [
      "history",
      "triggers",
    ]);
    assert.equal(roomStorage.version, 1);
    assert.deepEqual(Object.keys(roomStorage.value), ["rooms"]);
  } finally {
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
});
