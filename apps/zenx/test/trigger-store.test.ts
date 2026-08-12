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
    {
      ...validState(),
      history: Array.from({ length: 257 }, (_, index) => ({
        ...validState().history[0]!,
        id: `history-${String(index)}`,
      })),
    },
    {
      ...validState(),
      rooms: [
        {
          ...validState().rooms[0]!,
          messages: Array.from({ length: 257 }, (_, index) => ({
            ...validState().rooms[0]!.messages[0]!,
            id: `message-${String(index)}`,
          })),
        },
      ],
    },
    {
      ...validState(),
      triggers: [{ ...validState().triggers[0]!, prompt: "x".repeat(5_000) }],
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
      replyRoomId: _replyRoomId,
      replyAuthor: _replyAuthor,
      programInvocationId: _programInvocationId,
      programOutcome: _programOutcome,
      programOutcomes: _programOutcomes,
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
    await store.write(migrated);
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unknown legacy and current fields before migration or safe projection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-store-extra-"));
  const file = path.join(directory, "triggers.json");
  const base = validState();
  const corruptions = [
    {
      ...base,
      version: 1,
      history: [{ ...base.history[0], secret: "x" }],
    },
    {
      ...base,
      version: 2,
      history: [{ ...base.history[0], programOutput: "x" }],
    },
    {
      ...base,
      version: 3,
      history: [{ ...base.history[0], diagnostic: "x" }],
    },
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

test("rejects an oversized timeout at the legacy store boundary", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-store-timeout-"),
  );
  const file = path.join(directory, "triggers.json");
  const state = validState();
  state.triggers[0]!.program = {
    action: { command: "fixture", timeoutMs: 120_001 },
  };
  try {
    await writeFile(file, JSON.stringify({ ...state, version: 1 }), "utf8");
    await assert.rejects(
      async () => await new ZenXTriggerStore(file).read(),
      /unsupported version or invalid entry shape/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enforces version-specific and per-kind Trigger schemas", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-store-schema-"));
  const file = path.join(directory, "triggers.json");
  const state = validState();
  const signal = {
    id: "signal-trigger",
    threadId: "thread-a",
    kind: "signal" as const,
    label: "Signal",
    prompt: "Signal",
    createdAt: 1,
    active: true,
    signal: { name: "deploy" },
  };
  const history = state.history.map(
    ({
      replyRoomId: _replyRoomId,
      replyAuthor: _replyAuthor,
      programInvocationId: _programInvocationId,
      programOutcome: _programOutcome,
      programOutcomes: _programOutcomes,
      ...entry
    }) => entry,
  );
  const invalid = [
    {
      version: 1,
      triggers: [{ ...signal, program: { action: { command: "fixture" } } }],
      history,
      rooms: state.rooms,
    },
    {
      version: 2,
      triggers: [{ ...signal, program: { action: { command: "fixture" } } }],
      history: state.history.map(
        ({
          replyRoomId: _replyRoomId,
          replyAuthor: _replyAuthor,
          programInvocationId: _programInvocationId,
          programOutcome: _programOutcome,
          programOutcomes: _programOutcomes,
          ...entry
        }) => entry,
      ),
      rooms: state.rooms,
    },
    {
      version: 3,
      triggers: [
        {
          ...signal,
          watch: { threadId: "thread-b", event: "turn_completed" },
        },
      ],
      history: state.history,
      rooms: state.rooms,
    },
  ];
  try {
    for (const value of invalid) {
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
        programInvocationId: null,
        programOutcome: null,
        programOutcomes: [],
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
