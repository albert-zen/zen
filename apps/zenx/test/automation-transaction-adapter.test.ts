import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AutomationTransactionStore,
  fingerprintOperationBody,
} from "../src/main/automation-transaction-store.js";
import {
  automationTransactionForSnapshot,
  readAutomationProjection,
} from "../src/main/automation-transaction-adapter.js";
import { MAX_ROOM_OPERATIONS } from "../src/main/trigger-limits.js";
import type {
  TriggerSnapshot,
  RoomSendOperation,
  RoomMessage,
} from "../src/main/trigger-types.js";
const room = {
  id: "room",
  name: "Synthetic adapter",
  members: [{ name: "Bot", threadId: "thread" }],
  createdAt: 0,
};
const operation = (id: string, text: string): RoomSendOperation => ({
  id,
  text,
  messageId: null,
  createdAt: 0,
  acknowledged: false,
  mentions: [],
});
const message = (id: string, text: string): RoomMessage => ({
  id,
  text,
  roomId: room.id,
  author: "You",
  kind: "human",
  createdAt: 0,
  originThreadId: null,
  originTurnId: null,
});

test(
  "storage-only receipt refs exceed 1 MiB history without per-mutation body reads and hydrate public receipts on restart",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "room-adapter-"));
    const options = { directory, assertWriterLease() {} };
    let journal = await AutomationTransactionStore.create(options, {
      triggers: [],
      history: [],
      rooms: [{ ...room, messageCount: 0, operations: [] }],
    });
    try {
      const snapshot: TriggerSnapshot = {
        triggers: [],
        history: [],
        rooms: [{ ...room, messages: [], operations: [], messageCount: 0 }],
      };
      const projected = snapshot.rooms[0]!;
      // Serialization must use immutable references, never rehydrate old receipts.
      journal.readOperationBody = async () => {
        throw Error("Unexpected mutation-time body read");
      };
      const text = "Synthetic receipt ".padEnd(8000, "x");
      const count = MAX_ROOM_OPERATIONS + 12;
      for (let i = 0; i < count; i++) {
        const op = operation(`op-${i}`, text);
        projected.operations!.push(op);
        projected.operations =
          projected.operations!.slice(-MAX_ROOM_OPERATIONS);
        await journal.append(
          automationTransactionForSnapshot(journal, snapshot, []),
        );
        const saved = message(`m-${i}`, text);
        op.messageId = saved.id;
        projected.messageCount!++;
        projected.messages = [...projected.messages, saved].slice(-50);
        await journal.append(
          automationTransactionForSnapshot(journal, snapshot, [
            { type: "message", message: saved },
          ]),
        );
        op.acknowledged = true;
        await journal.append(
          automationTransactionForSnapshot(journal, snapshot, []),
        );
      }
      assert(count * Buffer.byteLength(text) > 1024 * 1024);
      const generation = journal.generation;
      await journal.close();
      journal = await AutomationTransactionStore.open(options, generation);
      const restored = await readAutomationProjection(journal);
      assert.equal(restored.rooms[0]!.messageCount, count);
      assert.equal(restored.rooms[0]!.messages.length, 50);
      assert.equal(restored.rooms[0]!.operations!.length, MAX_ROOM_OPERATIONS);
      assert.equal(restored.rooms[0]!.operations!.at(-1)!.text, text);
      assert.equal(
        restored.rooms[0]!.operations!.at(-1)!.messageId,
        `m-${count - 1}`,
      );
      assert.equal(
        (await journal.readRoomMessage(room.id, "m-0"))!.message.text,
        text,
      );
      assert.equal(JSON.stringify(journal.metadata()).includes(text), false);
      assert.equal("bodyRef" in restored.rooms[0]!.operations![0]!, false);
    } finally {
      await journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("fresh committed refs require a real same-frame human body; public hydration retains quotes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "room-adapter-ref-"));
  const journal = await AutomationTransactionStore.create(
    { directory, assertWriterLease() {} },
    { triggers: [], history: [], rooms: [{ ...room, messageCount: 0 }] },
  );
  try {
    const saved = {
      ...message("m", "Synthetic quoted reply"),
      replyTo: { messageId: "old", author: "Bot", text: "Original quote" },
    };
    const op = {
      ...operation("op", saved.text),
      messageId: saved.id,
      replyTo: saved.replyTo,
    };
    const snapshot: TriggerSnapshot = {
      triggers: [],
      history: [],
      rooms: [
        { ...room, messages: [saved], messageCount: 1, operations: [op] },
      ],
    };
    const tx = automationTransactionForSnapshot(journal, snapshot, [
      { type: "message", message: saved },
    ]);
    assert.equal(tx.roomEvents.length, 1);
    assert.equal(tx.metadata.rooms[0]!.operations![0]!.bodyRef.kind, "message");
    await journal.append(tx);
    assert.deepEqual(
      (await readAutomationProjection(journal)).rooms[0]!.operations![0],
      op,
    );
    const bad = structuredClone(snapshot);
    bad.rooms[0]!.operations!.push({
      ...operation("bad", "Missing body"),
      messageId: "absent",
    });
    await assert.rejects(
      journal.append(automationTransactionForSnapshot(journal, bad, [])),
      /missing|incompatible/,
    );
    assert.equal(journal.metadata().rooms[0]!.operations!.length, 1);
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy committed body refs remain original facts across ordinary metadata updates", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "room-adapter-legacy-"),
  );
  const journal = await AutomationTransactionStore.create(
    { directory, assertWriterLease() {}, allowLegacyReceiptImport: true },
    { triggers: [], history: [], rooms: [{ ...room, messageCount: 0 }] },
  );
  try {
    const op = {
      ...operation("legacy", "Saved original receipt"),
      messageId: "truncated",
    };
    const { text, ...metadata } = op;
    await journal.append({
      metadata: {
        triggers: [],
        history: [],
        rooms: [
          {
            ...room,
            messageCount: 0,
            operations: [
              {
                ...metadata,
                bodyRef: {
                  kind: "operation",
                  id: op.id,
                  sha256: fingerprintOperationBody(op),
                },
              },
            ],
          },
        ],
      },
      roomEvents: [
        {
          type: "operationBody",
          roomId: room.id,
          operationId: op.id,
          origin: "legacy-receipt",
          text,
        },
      ],
    });
    const snapshot = await readAutomationProjection(journal);
    snapshot.rooms[0]!.operations![0]!.acknowledged = true;
    const tx = automationTransactionForSnapshot(journal, snapshot, []);
    assert.equal(tx.roomEvents.length, 0);
    await journal.append(tx);
    assert.equal(
      (await readAutomationProjection(journal)).rooms[0]!.operations![0]!.text,
      text,
    );
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
