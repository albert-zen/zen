import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  JsonPluginStorage,
  createZenXPluginHostSdk,
} from "../src/main/plugin-host-sdk.js";
import { openAutomationTransactionStorage } from "../src/main/automation-transaction-migration.js";

test("a real prepared candidate owns its marker but raw journal writes remain blocked during replacement", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "room-candidate-lease-"),
  );
  const root = path.join(directory, "plugin-data");
  const migrated = await openAutomationTransactionStorage({
    storageRoot: root,
  });
  const candidate = await JsonPluginStorage.prepare({
    root,
    pluginId: "zenx-rooms",
    version: 2,
    syncWrites: true,
  });
  try {
    const sdk = await createZenXPluginHostSdk({
      pluginId: "zenx-rooms",
      storageRoot: root,
      storageVersion: 2,
      storage: candidate.storage,
      storageReadOnly: true,
      queryProjects: async () => [],
      appServer: {
        request: async () => ({}) as never,
        onNotification: () => () => {},
        completeTurn: async (): Promise<never> => {
          throw Error("Unexpected model call");
        },
      },
    });
    assert.equal(
      (await sdk.storage.get()).generation,
      migrated.journal.generation,
    );
    await assert.rejects(migrated.rooms.get(), /replacement/);
    await assert.rejects(
      migrated.journal.append({
        metadata: migrated.journal.metadata(),
        roomEvents: [],
      }),
      /replacement/,
    );
    await candidate.rollback();
    await migrated.journal.append({
      metadata: migrated.journal.metadata(),
      roomEvents: [],
    });
  } finally {
    await candidate.rollback();
    await migrated.close();
    await rm(directory, { recursive: true, force: true });
  }
});
