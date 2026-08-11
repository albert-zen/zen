import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXTriggerStore } from "../src/main/trigger-store.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";

test("rejects nested trigger registry corruption instead of admitting runtime objects", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-store-bad-"));
  const file = path.join(directory, "triggers.json");
  const corruptions: unknown[] = [
    { ...validState(), triggers: [{ id: 42 }] },
    {
      ...validState(),
      history: [{ ...validState().history[0], sourceTurnId: { bad: true } }],
    },
    {
      ...validState(),
      rooms: [
        {
          ...validState().rooms[0],
          members: [
            { name: "Monitor", threadId: "thread-a" },
            { name: "monitor", threadId: "thread-b" },
          ],
        },
      ],
    },
    { ...validState(), version: 999 },
  ];
  try {
    for (const value of corruptions) {
      await writeFile(file, JSON.stringify(value), "utf8");
      await assert.rejects(
        async () => await new ZenXTriggerStore(file).read(),
        /unsupported version or invalid entry shape/u,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates fully validated version 1 history to nullable source metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-store-v1-"));
  const file = path.join(directory, "triggers.json");
  const state = validState();
  const legacyHistory = state.history.map(
    ({
      sourceThreadId: _sourceThreadId,
      sourceTurnId: _sourceTurnId,
      sourceRoomId: _sourceRoomId,
      sourceRoomMessageId: _sourceRoomMessageId,
      ...entry
    }) => entry,
  );
  try {
    await writeFile(
      file,
      JSON.stringify({ ...state, version: 1, history: legacyHistory }),
      "utf8",
    );
    const store = new ZenXTriggerStore(file);
    const migrated = await store.read();
    assert.equal(migrated.history[0]?.sourceThreadId, null);
    assert.equal(migrated.history[0]?.sourceTurnId, null);
    assert.equal(migrated.history[0]?.replyRoomId, null);
    assert.equal(migrated.history[0]?.replyAuthor, null);
    await store.write(migrated);
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function validState(): TriggerSnapshot & { version: 2 } {
  return {
    version: 2,
    triggers: [
      {
        id: "trigger-a",
        threadId: "thread-a",
        kind: "thread",
        label: "Relay",
        prompt: "Review it",
        createdAt: 1,
        active: true,
        watch: { threadId: "thread-b", event: "turn_completed" },
      },
    ],
    history: [
      {
        id: "history-a",
        triggerId: "trigger-a",
        threadId: "thread-a",
        kind: "thread",
        reason: "relay",
        prompt: "Review it",
        clientUserMessageId: "zenx-wakeup:trigger-a:key",
        startedAt: 2,
        completedAt: 3,
        status: "completed",
        turnId: "turn-a",
        error: null,
        sourceThreadId: "thread-b",
        sourceTurnId: "turn-b",
        sourceRoomId: null,
        sourceRoomMessageId: null,
        replyRoomId: null,
        replyAuthor: null,
      },
    ],
    rooms: [
      {
        id: "room-a",
        name: "release",
        members: [{ name: "Monitor", threadId: "thread-a" }],
        messages: [
          {
            id: "message-a",
            roomId: "room-a",
            author: "You",
            text: "status?",
            createdAt: 4,
            kind: "human",
            originThreadId: null,
            originTurnId: null,
          },
        ],
        createdAt: 1,
      },
    ],
  };
}
