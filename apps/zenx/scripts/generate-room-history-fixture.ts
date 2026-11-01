/** Synthetic facts through the production factory; never opens a user profile. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBundledAutomationPluginService } from "../src/main/automation-plugin-service.js";
import { JsonPluginStorage } from "../src/main/plugin-host-sdk.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-rooms-plugin/src/runtime.js";
import { MAX_ROOM_OPERATIONS } from "../src/main/trigger-limits.js";

const output = path.resolve(process.argv[2] ?? ".room-history-preview");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(
  path.join(tmpdir(), "zenx-room-history-synthetic-"),
);
let dispatches = 0;
const appServer = {
  onNotification: () => () => {},
  request: async () => {
    dispatches++;
    throw Error("Synthetic history must not dispatch");
  },
};
const open = async () => {
  const service = await createBundledAutomationPluginService({
    userDataDirectory: directory,
    appServer,
  });
  await service.startPlugin("zenx-rooms", {
    storage: await JsonPluginStorage.open({
      pluginId: "zenx-rooms",
      root: path.join(directory, "plugin-data"),
      version: 2,
    }),
  } as never);
  return service;
};
let service = await open();
try {
  let notifications = 0;
  let notificationViolation = false;
  service.onChange((snapshot) => {
    for (const room of snapshot.rooms) {
      notificationViolation ||=
        room.messages.length !== 0 || room.operations !== undefined;
    }
    notifications++;
  });
  const room = await service.createRoom({
    name: "Synthetic history · 320 retained messages",
    members: [{ name: "Observer", threadId: "synthetic-observer" }],
  });
  const texts = Array.from(
    { length: 320 },
    (_, i) =>
      `Synthetic message ${String(i + 1).padStart(3, "0")} — durable history\n` +
      (i === 319
        ? "Synthetic latest-message boundary."
        : "Synthetic body. ".repeat(260).trim()),
  );
  const ids: string[] = [];
  for (const text of texts) {
    const id = `${service.snapshot().rooms[0]!.operationEpoch}:${randomUUID()}`;
    await service.prepareRoomMessage(room.id, id, text);
    const receipt = await service.postPreparedRoomMessage(room.id, id, text);
    assert(receipt.messageId);
    ids.push(receipt.messageId);
    await service.acknowledgeRoomOperation(room.id, id);
  }
  assert.equal(
    service.snapshot().rooms[0]!.operations!.length,
    MAX_ROOM_OPERATIONS,
  );
  assert.equal(service.snapshot().rooms[0]!.messages.length, 50);
  assert(Buffer.byteLength(texts.join("")) > 1024 * 1024);
  assert(notifications > 320);
  assert.equal(notificationViolation, false);
  await service.close();
  service = await open();
  const runtime = createZenXTrustedPlugin(service);
  const invoke = (command: string, input: Record<string, unknown>) =>
    runtime.invoke(`zenx_rooms_${command}`, {
      callId: "synthetic-history-acceptance",
      trustedPluginUi: true,
      arguments: { input },
      cwd: ".",
      signal: new AbortController().signal,
    });
  const list = (await invoke("list", {})) as {
    rooms: Array<{
      id: string;
      messageCount: number;
      pendingCount: number;
      operations: unknown[];
    }>;
    nextCursor: number | null;
  };
  assert.equal(list.rooms[0]!.id, room.id);
  assert.equal(list.rooms[0]!.messageCount, 320);
  assert.equal(list.rooms[0]!.pendingCount, 0);
  assert.deepEqual(list.rooms[0]!.operations, []);
  const operations = (await invoke("operations", { roomId: room.id })) as {
    operations: unknown[];
    nextCursor: number | null;
  };
  assert.deepEqual(operations, { operations: [], nextCursor: null });
  const pages: Record<
    number,
    Awaited<ReturnType<typeof service.readRoomPage>>
  > = {};
  const all: (typeof pages)[number]["messages"] = [];
  let cursor: number | null = 0;
  let snapshot;
  while (cursor !== null) {
    const page = (await invoke("messages", {
      roomId: room.id,
      cursor,
      ...(snapshot ? { snapshot } : {}),
    })) as Awaited<ReturnType<typeof service.readRoomPage>>;
    assert(page.messages.length <= 4);
    assert(Buffer.byteLength(JSON.stringify(page)) < 60 * 1024);
    snapshot = page.snapshot;
    pages[cursor] = page;
    all.unshift(...page.messages);
    cursor = page.nextCursor;
  }
  assert.deepEqual(
    all.map((message) => message.id),
    ids,
  );
  assert.deepEqual(
    all.map((message) => message.text),
    texts,
  );
  assert.equal(new Set(ids).size, 320);
  assert.equal(dispatches, 0);
  const marker = JSON.parse(
    await readFile(
      path.join(directory, "plugin-data/zenx-triggers/storage.json"),
      "utf8",
    ),
  );
  assert.equal(marker.version, 2);
  const fixture = {
    roomId: room.id,
    ids,
    texts,
    list,
    operations,
    pages,
  };
  const bytes = JSON.stringify(fixture);
  await writeFile(path.join(output, "fixture.json"), bytes);
  await writeFile(
    path.join(output, "fixture-source.json"),
    JSON.stringify(
      {
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
        count: ids.length,
        finalCount: all.length,
        bodyBytes: Buffer.byteLength(texts.join("")),
        dispatches,
        notifications,
        receiptLimit: MAX_ROOM_OPERATIONS,
        restartVerified: true,
        node: process.version,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
