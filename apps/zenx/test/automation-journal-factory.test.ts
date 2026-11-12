import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import {
  JsonPluginStorage,
  createZenXPluginHostSdk,
} from "../src/main/plugin-host-sdk.js";
import type { RoomMessage } from "../src/main/trigger-types.js";

const appServer = {
  onNotification: () => () => {},
  request: async () => {
    throw Error("Synthetic history must not dispatch an Agent");
  },
};

async function roomSdk(directory: string) {
  return {
    storage: await JsonPluginStorage.open({
      pluginId: "zenx-rooms",
      root: path.join(directory, "plugin-data"),
      version: 2,
    }),
  } as never;
}

test("real automation factory retains more than 1 MiB and 256 Room messages across restart with bounded pages", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-journal-factory-"),
  );
  const root = path.join(directory, "plugin-data");
  let service = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer,
  });
  try {
    await service.startPlugin("zenx-rooms", await roomSdk(directory));
    const room = await service.createRoom({
      name: "Synthetic large history",
      members: [{ name: "Observer", threadId: "synthetic-observer" }],
    });
    const texts = Array.from(
      { length: 320 },
      (_, i) => `${i}:` + "x".repeat(5000),
    );
    for (const text of texts) await service.postAgentRoomMessage(room.id, text);
    let page = await service.readRoomPage(room.id);
    assert(page.snapshot);
    assert.equal(page.snapshot.messageCount, 320);
    assert.equal(page.messages.length, 4);
    const all: RoomMessage[] = [];
    for (;;) {
      assert(page.messages.length <= 4);
      assert(Buffer.byteLength(JSON.stringify(page)) < 60 * 1024);
      all.unshift(...page.messages);
      if (page.nextCursor === null) break;
      page = await service.readRoomPage(
        room.id,
        page.nextCursor,
        page.snapshot,
      );
    }
    assert.deepEqual(
      all.map((message) => message.text),
      texts,
    );
    assert.equal(new Set(all.map((message) => message.id)).size, 320);
    assert(Buffer.byteLength(JSON.stringify(all)) > 1024 * 1024);
    const first = all[0]!;
    await service.setRoomReaction(room.id, first.id, null, "👀");
    await service.postAgentRoomMessage(room.id, "Oldest reply", first.id);
    const latest = await service.readRoomPage(room.id);
    const reply = latest.messages.at(-1)!;
    assert.equal(reply.replyTo?.messageId, first.id);
    const expectedOldest = (await service.readRoomMessage(room.id, first.id))!
      .message;
    assert.equal(expectedOldest.reactions?.[0]?.emoji, "👀");
    const shared = await readFile(
      path.join(root, "zenx-triggers", "storage.json"),
      "utf8",
    );
    const forward = await readFile(
      path.join(root, "zenx-rooms", "storage.json"),
      "utf8",
    );
    assert.equal(JSON.parse(shared).version, 2);
    assert.equal(JSON.parse(forward).version, 2);
    assert(
      Buffer.byteLength(shared) < 4096,
      "shared selector does not embed history",
    );
    assert(
      Buffer.byteLength(forward) < 4096,
      "forward marker does not embed history",
    );
    await service.close();
    service = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer,
    });
    await service.startPlugin("zenx-rooms", await roomSdk(directory));
    assert.deepEqual(
      (await service.readRoomMessage(room.id, first.id))!.message,
      expectedOldest,
    );
    assert.deepEqual(
      (await service.readRoomMessage(room.id, reply.id))!.message,
      reply,
    );
    const restored: RoomMessage[] = [];
    page = await service.readRoomPage(room.id);
    assert(page.snapshot);
    assert.equal(page.snapshot.messageCount, 321);
    assert.equal(page.messages.length, 4);
    for (;;) {
      restored.unshift(...page.messages);
      if (page.nextCursor === null) break;
      page = await service.readRoomPage(
        room.id,
        page.nextCursor,
        page.snapshot,
      );
    }
    assert.deepEqual(
      restored.map((message) => message.id),
      [...all.map((message) => message.id), reply.id],
    );
    assert.equal(new Set(restored.map((message) => message.id)).size, 321);
    assert.deepEqual(restored[0], expectedOldest);
    assert.deepEqual(restored.slice(1, -1), all.slice(1));
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("factory refuses missing shared authority with v2 Room forward marker before legacy fallback", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-journal-missing-marker-"),
  );
  const service = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer,
  });
  try {
    await service.startPlugin("zenx-rooms", await roomSdk(directory));
    await service.createRoom({
      name: "Never silently replace",
      members: [{ name: "Observer", threadId: "observer" }],
    });
    await service.close();
    const sharedDirectory = path.join(
      directory,
      "plugin-data",
      "zenx-triggers",
    );
    const shared = path.join(sharedDirectory, "storage.json");
    const forward = path.join(
      directory,
      "plugin-data",
      "zenx-rooms",
      "storage.json",
    );
    const originalForward = await readFile(forward, "utf8");
    await unlink(shared);
    await writeFile(
      path.join(directory, "trigger-registry.json"),
      JSON.stringify({ version: 3, triggers: [], history: [], rooms: [] }),
    );
    const files = await readdir(sharedDirectory);
    await assert.rejects(
      createBundledAutomationPluginService({
        userDataDirectory: directory,
        appServer,
      }),
      /Shared automation marker is missing/,
    );
    await assert.rejects(readFile(shared), { code: "ENOENT" });
    assert.equal(await readFile(forward, "utf8"), originalForward);
    assert.deepEqual(await readdir(sharedDirectory), files);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1 runtime storage cannot open or start against migrated factory authority", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-journal-old-runtime-"),
  );
  const service = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer,
  });
  try {
    for (const pluginId of ["zenx-triggers", "zenx-rooms"]) {
      await assert.rejects(
        JsonPluginStorage.open({
          pluginId,
          root: path.join(directory, "plugin-data"),
          version: 1,
        }),
        /version|migration/i,
      );
    }
    await assert.rejects(
      service.startPlugin("zenx-rooms", {
        storage: { get: async () => ({ rooms: [] }) },
      } as never),
      /lifecycle marker does not select/,
    );
    assert.equal(service.roomsAvailable(), false);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("factory fences cached snapshots and operation receipts after identical journal replacement", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-journal-unknown-fence-"),
  );
  let dispatches = 0;
  const service = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer: {
      ...appServer,
      request: async () => {
        dispatches++;
        throw Error("Synthetic history must not dispatch an Agent");
      },
    },
  });
  try {
    await service.startPlugin("zenx-rooms", await roomSdk(directory));
    const room = await service.createRoom({
      name: "Unknown outcome",
      members: [{ name: "Observer", threadId: "observer" }],
    });
    const operationId = `${room.operationEpoch}:${randomUUID()}`;
    await service.prepareRoomMessage(
      room.id,
      operationId,
      "Known prior message",
    );
    await service.postPreparedRoomMessage(
      room.id,
      operationId,
      "Known prior message",
    );
    assert.equal(service.roomOperation(room.id, operationId).state, "saved");
    assert.equal(service.snapshot().rooms[0]!.id, room.id);
    const sharedDirectory = path.join(
      directory,
      "plugin-data",
      "zenx-triggers",
    );
    const marker = JSON.parse(
      await readFile(path.join(sharedDirectory, "storage.json"), "utf8"),
    );
    const journal = path.join(
      sharedDirectory,
      "automation-history",
      `automation-${marker.value.generation}.jsonl`,
    );
    const bytes = await readFile(journal);
    await rename(journal, journal + ".detached");
    await writeFile(journal, bytes, { mode: 0o600 });
    await assert.rejects(
      service.postAgentRoomMessage(room.id, "Cannot acknowledge orphan write"),
      /outcome is unknown/,
    );
    assert.throws(() => service.snapshot(), /outcome is unknown/);
    assert.throws(
      () => service.roomOperation(room.id, operationId),
      /outcome is unknown/,
    );
    await assert.rejects(
      service.postAgentRoomMessage(room.id, "Cannot retry automatically"),
      /outcome is unknown/,
    );
    assert.deepEqual(await readFile(journal), bytes);
    assert.deepEqual(await readFile(journal + ".detached"), bytes);
    assert.equal(dispatches, 0);
  } finally {
    await service
      .close()
      .catch((error) => assert.match(String(error), /outcome is unknown/));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const legacyFallback of [false, true])
  test(`factory refuses both missing markers with retained facts (legacy fallback ${legacyFallback})`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-journal-both-markers-"),
    );
    const service = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer,
    });
    try {
      await service.startPlugin("zenx-rooms", await roomSdk(directory));
      const room = await service.createRoom({
        name: "Retained facts",
        members: [{ name: "Observer", threadId: "observer" }],
      });
      await service.postAgentRoomMessage(
        room.id,
        "Never replace this history with an empty legacy fallback",
      );
      await service.close();
      const sharedDirectory = path.join(
        directory,
        "plugin-data",
        "zenx-triggers",
      );
      const roomDirectory = path.join(directory, "plugin-data", "zenx-rooms");
      const sharedMarker = path.join(sharedDirectory, "storage.json");
      const roomMarker = path.join(roomDirectory, "storage.json");
      await unlink(sharedMarker);
      await unlink(roomMarker);
      const historyDirectory = path.join(sharedDirectory, "automation-history");
      const retained = await readdir(historyDirectory);
      assert(retained.some((name) => /^automation-.*\.jsonl$/u.test(name)));
      assert(retained.some((name) => /^legacy-.*\.json$/u.test(name)));
      const bytes = await Promise.all(
        retained.map((name) => readFile(path.join(historyDirectory, name))),
      );
      const legacyFile = path.join(directory, "trigger-registry.json");
      const legacyBytes = JSON.stringify({
        version: 3,
        triggers: [],
        history: [],
        rooms: [],
      });
      if (legacyFallback) await writeFile(legacyFile, legacyBytes);
      await assert.rejects(
        createBundledAutomationPluginService({
          userDataDirectory: directory,
          appServer,
        }),
        /Shared automation marker is missing; refusing empty legacy bootstrap/,
      );
      await assert.rejects(readFile(sharedMarker), { code: "ENOENT" });
      await assert.rejects(readFile(roomMarker), { code: "ENOENT" });
      assert.deepEqual(await readdir(historyDirectory), retained);
      assert.deepEqual(await readdir(sharedDirectory), ["automation-history"]);
      assert.deepEqual(await readdir(roomDirectory), []);
      assert.deepEqual(
        await Promise.all(
          retained.map((name) => readFile(path.join(historyDirectory, name))),
        ),
        bytes,
      );
      if (legacyFallback)
        assert.equal(await readFile(legacyFile, "utf8"), legacyBytes);
      else await assert.rejects(readFile(legacyFile), { code: "ENOENT" });
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("real readonly candidate SDKs preserve both namespaces and peer disable leaves shared journal open", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-journal-peer-lifecycle-"),
  );
  const service = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer,
  });
  const prepare = async (pluginId: "zenx-triggers" | "zenx-rooms") => {
    const stage = await JsonPluginStorage.prepare({
      pluginId,
      root: path.join(directory, "plugin-data"),
      version: 2,
    });
    const sdk = await createZenXPluginHostSdk({
      pluginId,
      storageRoot: path.join(directory, "plugin-data"),
      storageVersion: 2,
      storage: stage.storage,
      storageReadOnly: true,
      queryProjects: async () => [],
      appServer: appServer as never,
    });
    return { ...stage, sdk };
  };
  try {
    const triggers = await prepare("zenx-triggers");
    await service.startPlugin("zenx-triggers", triggers.sdk);
    triggers.publish();
    const rooms = await prepare("zenx-rooms");
    await service.startPlugin("zenx-rooms", rooms.sdk);
    rooms.publish();
    await assert.rejects(
      rooms.sdk.storage.set({ rooms: [] }),
      /read.only|Host.owned/i,
    );
    await assert.rejects(
      triggers.sdk.storage.set({ triggers: [] }),
      /read.only|Host.owned/i,
    );
    const trigger = await service.create({
      kind: "timer",
      threadId: "synthetic-observer",
      label: "Preserved timer",
      prompt: "Not due",
      runAt: Date.now() + 600_000,
    });
    const room = await service.createRoom({
      name: "Preserved room",
      members: [{ name: "Observer", threadId: "synthetic-observer" }],
    });
    await service.postAgentRoomMessage(room.id, "Before replacement");
    const original = (await service.readRoomPage(room.id)).messages[0]!;
    const replacement = await prepare("zenx-rooms");
    await service.startPlugin("zenx-rooms", replacement.sdk);
    replacement.publish();
    await service.stopPlugin("zenx-rooms", rooms.sdk);
    await assert.rejects(rooms.sdk.storage.get(), /generation was replaced/);
    await service.postAgentRoomMessage(room.id, "After replacement");
    assert.equal(
      service.snapshot().triggers.find((entry) => entry.id === trigger.id)
        ?.active,
      true,
    );
    await service.stopPlugin("zenx-triggers", triggers.sdk);
    assert.equal(service.triggersAvailable(), false);
    assert.equal(service.roomsAvailable(), true);
    await service.postAgentRoomMessage(room.id, "While Triggers disabled");
    assert.equal(
      (await service.readRoomPage(room.id)).snapshot?.messageCount,
      3,
    );
    const nextTriggers = await prepare("zenx-triggers");
    await service.startPlugin("zenx-triggers", nextTriggers.sdk);
    nextTriggers.publish();
    assert.equal(
      service.snapshot().triggers.find((entry) => entry.id === trigger.id)
        ?.active,
      true,
    );
    await service.stopPlugin("zenx-rooms", replacement.sdk);
    assert.equal(service.roomsAvailable(), false);
    assert.equal(service.triggersAvailable(), true);
    await service.cancel(trigger.id);
    assert.equal(
      service.snapshot().triggers.find((entry) => entry.id === trigger.id)
        ?.active,
      false,
    );
    assert.deepEqual(
      (await service.readRoomMessage(room.id, original.id))?.message,
      original,
    );
    await service.close();
    const restarted = await createBundledAutomationPluginService({
      userDataDirectory: directory,
      appServer,
    });
    try {
      await restarted.startPlugin("zenx-rooms", await roomSdk(directory));
      assert.equal(
        (await restarted.readRoomPage(room.id)).snapshot?.messageCount,
        3,
      );
      assert.deepEqual(
        (await restarted.readRoomMessage(room.id, original.id))?.message,
        original,
      );
      assert.equal(
        restarted.snapshot().triggers.find((entry) => entry.id === trigger.id)
          ?.active,
        false,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
