import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncDirectory } from "../../../src/storage-files.js";
import {
  openAutomationTransactionStorage,
  type AutomationMigrationOptions,
  type MigratedAutomationStorage,
} from "../src/main/automation-transaction-migration.js";
import {
  JsonPluginStorage,
  type PluginStorageFileSystem,
} from "../src/main/plugin-host-sdk.js";
import type {
  RoomMessage,
  TriggerSnapshot,
} from "../src/main/trigger-types.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function snapshot(count = 12): TriggerSnapshot {
  return {
    triggers: [],
    history: [],
    rooms: [
      {
        id: "room",
        name: "Synthetic migration",
        members: [{ name: "Bot", threadId: "thread" }],
        createdAt: 0,
        messages: Array.from({ length: count }, (_, i) => ({
          id: `m${i}`,
          roomId: "room",
          kind: "agent" as const,
          author: "Bot",
          text: `${i}:` + "x".repeat(1900),
          createdAt: i % 3,
          originThreadId: "thread",
          originTurnId: `turn-${i}`,
          ...(i === 0
            ? {
                replyTo: {
                  messageId: "old-truncated",
                  author: "You",
                  text: "Copied quote",
                },
                reactions: [{ actorId: "human", label: "You", emoji: "👀" }],
              }
            : {}),
        })),
        operations: [
          {
            id: "prepared",
            text: "original prepared",
            messageId: null,
            createdAt: 0,
            acknowledged: false,
            mentions: [],
          },
          {
            id: "dangling",
            text: "original committed receipt",
            messageId: "already-truncated",
            createdAt: 1,
            acknowledged: true,
            mentions: [],
            replyTo: {
              messageId: "absent",
              author: "You",
              text: "Original copied quote",
            },
          },
        ],
      },
    ],
  };
}
interface Fixture {
  root: string;
  sharedFile: string;
  roomFile: string;
  directory: string;
  source: TriggerSnapshot;
  shared: JsonPluginStorage;
  rooms: JsonPluginStorage;
  sharedRaw: string;
  roomRaw: string;
  options: AutomationMigrationOptions;
  keep(result: MigratedAutomationStorage): MigratedAutomationStorage;
}
async function fixture(
  run: (f: Fixture) => Promise<void>,
  count = 12,
  fileSystem?: PluginStorageFileSystem,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-rebuilt-migration-"));
  const results: MigratedAutomationStorage[] = [];
  try {
    const source = snapshot(count);
    const shared = await JsonPluginStorage.open({
      pluginId: "zenx-triggers",
      root,
      version: 1,
      initialValue: source,
      fileSystem,
    });
    const rooms = await JsonPluginStorage.open({
      pluginId: "zenx-rooms",
      root,
      version: 1,
      initialValue: { rooms: source.rooms },
      fileSystem,
    });
    const sharedFile = path.join(root, "zenx-triggers", "storage.json"),
      roomFile = path.join(root, "zenx-rooms", "storage.json");
    await run({
      root,
      source,
      shared,
      rooms,
      sharedFile,
      roomFile,
      directory: path.join(root, "zenx-triggers", "automation-history"),
      sharedRaw: await readFile(sharedFile, "utf8"),
      roomRaw: await readFile(roomFile, "utf8"),
      options: { storageRoot: root, fileSystem },
      keep(result) {
        results.push(result);
        return result;
      },
    });
  } finally {
    for (const result of results) await result.close();
    await rm(root, { recursive: true, force: true });
  }
}
const check = (name: string, run: (f: Fixture) => Promise<void>, count = 12) =>
  test(name, { timeout: 30_000 }, () => fixture(run, count));
async function history(result: MigratedAutomationStorage) {
  let cursor: number | null = 0;
  const messages: RoomMessage[] = [];
  do {
    const page = await result.journal.readRoomPage("room", cursor);
    messages.unshift(...page.messages);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return messages;
}
check(
  "320-message migration preserves order/quotes/receipts, durable exact sources, small frames and reopen",
  async (f) => {
    let backupSeen = false;
    let result = f.keep(
      await openAutomationTransactionStorage({
        ...f.options,
        onPhase: async (phase) => {
          if (phase === "both-gated") {
            await assert.rejects(f.shared.set(f.source), /replacement/);
            await assert.rejects(f.rooms.set({ rooms: [] }), /replacement/);
          }
          if (phase === "backup-durable") {
            assert.equal(await readFile(f.sharedFile, "utf8"), f.sharedRaw);
            assert.equal(await readFile(f.roomFile, "utf8"), f.roomRaw);
            const names = (await readdir(f.directory)).filter((name) =>
              name.startsWith("legacy-"),
            );
            assert.equal(names.length, 1);
            const backup = JSON.parse(
              await readFile(path.join(f.directory, names[0]!), "utf8"),
            );
            assert.equal(backup.sharedRaw, f.sharedRaw);
            assert.equal(backup.roomRaw, f.roomRaw);
            assert.equal(backup.legacyRoomRaw, f.roomRaw);
            backupSeen = true;
          }
          if (phase === "forward-written") assert(backupSeen);
        },
      }),
    );
    assert(backupSeen);
    assert.deepEqual(await history(result), f.source.rooms[0]!.messages);
    const marker = JSON.parse(await readFile(f.sharedFile, "utf8")).value;
    const backup = await readFile(
      path.join(f.directory, marker.backup),
      "utf8",
    );
    assert.equal(sha(backup), marker.backupSha256);
    const logFile = path.join(
      f.directory,
      `automation-${result.journal.generation}.jsonl`,
    );
    const frames = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const frame of frames) {
      assert(frame.record.roomEvents.length <= 4);
      assert(
        Buffer.byteLength(JSON.stringify(frame.record.roomEvents)) < 61 * 1024,
      );
      assert(!("messages" in frame.record.metadata.rooms[0]));
    }
    for (const op of result.journal.metadata().rooms[0]!.operations!) {
      const original = f.source.rooms[0]!.operations!.find(
        (entry) => entry.id === op.id,
      )!;
      assert.deepEqual(
        await result.journal.readOperationBody("room", op.bodyRef),
        {
          text: original.text,
          ...(original.replyTo ? { replyTo: original.replyTo } : {}),
        },
      );
    }
    const saved = await readFile(f.sharedFile, "utf8");
    await assert.rejects(
      JsonPluginStorage.open({
        pluginId: "zenx-triggers",
        root: f.root,
        version: 1,
      }),
      /downgrade/,
    );
    await assert.rejects(f.shared.set(f.source), /version|generation/);
    const meta = result.journal.metadata();
    for (let i = 320; i < 400; i++) {
      meta.rooms[0]!.messageCount++;
      await result.journal.append({
        metadata: meta,
        roomEvents: [
          {
            type: "message",
            message: {
              id: `m${i}`,
              roomId: "room",
              kind: "human",
              author: "You",
              text: "z".repeat(8000),
              createdAt: i,
              originThreadId: null,
              originTurnId: null,
            },
          },
        ],
      });
    }
    assert((await stat(logFile)).size > 1024 * 1024);
    assert.equal(await readFile(f.sharedFile, "utf8"), saved);
    await result.close();
    result = f.keep(await openAutomationTransactionStorage(f.options));
    assert.equal((await history(result)).length, 400);
    assert.equal(result.journal.metadata().rooms[0]!.operations!.length, 2);
  },
  320,
);
check(
  "fresh bootstrap invokes legacy loader once and selects both namespaces",
  async (f) => {
    // This fixture intentionally removes only the unconverted synthetic v1 sources.
    await unlink(f.sharedFile);
    await unlink(f.roomFile);
    let loads = 0;
    const result = f.keep(
      await openAutomationTransactionStorage({
        ...f.options,
        loadLegacy: async () => {
          loads++;
          return snapshot(0);
        },
      }),
    );
    assert.equal(loads, 1);
    assert.equal(result.journal.metadata().rooms[0]!.messageCount, 0);
    assert.equal(JSON.parse(await readFile(f.sharedFile, "utf8")).version, 2);
    assert.equal(JSON.parse(await readFile(f.roomFile, "utf8")).version, 2);
  },
);
