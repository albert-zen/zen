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

test("a real prepared candidate can append through marker leases while old and raw writers stay fenced", async () => {
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
      /marker leases/,
    );
    const transaction = {
      metadata: migrated.journal.metadata(),
      roomEvents: [],
    };
    await assert.rejects(migrated.append(transaction), /replacement/);
    const before = migrated.journal.position.revision;
    await migrated.append(transaction, { rooms: sdk.storage });
    assert.equal(migrated.journal.position.revision, before + 1);
    await candidate.rollback();
    await assert.rejects(
      migrated.append(transaction, { rooms: sdk.storage }),
      /retired|superseded|generation/i,
    );
    await migrated.append({
      metadata: migrated.journal.metadata(),
      roomEvents: [],
    });
  } finally {
    await candidate.rollback();
    await migrated.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("correct-generation marker facades from another root and mismatched generation candidates cannot write", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "room-lease-owner-"));
  const root = path.join(directory, "owner");
  const migrated = await openAutomationTransactionStorage({
    storageRoot: root,
  });
  let candidate:
    Awaited<ReturnType<typeof JsonPluginStorage.prepare>> | undefined;
  try {
    const foreignRoot = path.join(directory, "foreign");
    const marker = await migrated.rooms.get();
    const foreign = await JsonPluginStorage.open({
      root: foreignRoot,
      pluginId: "zenx-rooms",
      version: 2,
      initialValue: marker,
      migrations: [
        { fromVersion: 1, toVersion: 2, migrate: async (value) => value },
      ],
    });
    const foreignSdk = await createZenXPluginHostSdk({
      pluginId: "zenx-rooms",
      storageRoot: foreignRoot,
      storageVersion: 2,
      storage: foreign,
      storageReadOnly: true,
      queryProjects: async () => [],
      appServer: {
        completeTurn: async (): Promise<never> => {
          throw Error("Unexpected model call");
        },
      },
    });
    const tx = { metadata: migrated.journal.metadata(), roomEvents: [] };
    const before = migrated.journal.position;
    await assert.rejects(
      migrated.append(tx, { rooms: foreignSdk.storage }),
      /different namespace/,
    );
    await assert.rejects(
      migrated.append(tx, {
        rooms: { version: 2, get: async () => marker, set: async () => {} },
      }),
      /Host|registered|storage handle/i,
    );
    candidate = await JsonPluginStorage.prepare({
      root,
      pluginId: "zenx-rooms",
      version: 2,
      syncWrites: true,
    });
    await candidate.storage.set({
      ...marker,
      generation: "11111111-1111-4111-8111-111111111111",
    });
    await assert.rejects(
      migrated.append(tx, { rooms: candidate.storage }),
      /different generation/,
    );
    assert.deepEqual(migrated.journal.position, before);
  } finally {
    await candidate?.rollback();
    await migrated.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "a replacement arriving after append admission waits for both marker leases",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "room-lease-order-"),
    );
    const root = path.join(directory, "plugin-data");
    const migrated = await openAutomationTransactionStorage({
      storageRoot: root,
    });
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = migrated.journal.append.bind(migrated.journal);
    migrated.journal.append = async (transaction) => {
      entered();
      await releaseGate;
      return original(transaction);
    };
    let preparation:
      | Promise<Awaited<ReturnType<typeof JsonPluginStorage.prepare>>>
      | undefined;
    let append: ReturnType<typeof migrated.append> | undefined;
    let candidate:
      Awaited<ReturnType<typeof JsonPluginStorage.prepare>> | undefined;
    const deadline = async <T>(work: Promise<T>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Marker lease gate deadline")),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      append = migrated.append({
        metadata: migrated.journal.metadata(),
        roomEvents: [],
      });
      await deadline(enteredGate);
      let prepared = false;
      preparation = JsonPluginStorage.prepare({
        root,
        pluginId: "zenx-rooms",
        version: 2,
        syncWrites: true,
      }).then((value) => {
        prepared = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(prepared, false);
      release();
      await deadline(append);
      candidate = await deadline(preparation);
      assert.equal(migrated.journal.position.revision, 1);
    } finally {
      release();
      await append?.catch(() => {});
      candidate ??= await preparation?.catch(() => undefined);
      await candidate?.rollback();
      await migrated.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
