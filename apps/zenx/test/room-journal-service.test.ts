import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AutomationTransactionStore,
  fingerprintOperationBody,
  type AutomationRoomEvent,
  type AutomationMetadata,
} from "../src/main/automation-transaction-store.js";
import {
  ZenXTriggerService,
  type ZenXTriggerStorePort,
} from "../src/main/trigger-service.js";
import { canonicalTriggerSnapshot } from "../src/main/trigger-store.js";
import type { TriggerSnapshot } from "../src/main/trigger-types.js";

/** Minimal test adapter; the production factory owns metadata/body serialization. */
class JournalPort implements ZenXTriggerStorePort {
  failNext = false;
  writes: Array<{
    snapshot: TriggerSnapshot;
    events: readonly AutomationRoomEvent[];
  }> = [];
  constructor(readonly journal: AutomationTransactionStore) {}
  get roomHistory() {
    return this.journal;
  }
  async read(): Promise<TriggerSnapshot> {
    const metadata = this.journal.metadata();
    return {
      ...metadata,
      rooms: await Promise.all(
        metadata.rooms.map(async (room) => {
          let messages: TriggerSnapshot["rooms"][number]["messages"] = [];
          let cursor: number | null = 0;
          while (cursor !== null && messages.length < 50) {
            const page = await this.journal.readRoomPage(room.id, cursor);
            messages = [...page.messages, ...messages];
            cursor = page.nextCursor;
          }
          return {
            ...room,
            messages: messages.slice(-50),
            operations: await Promise.all(
              (room.operations ?? []).map(
                async ({ bodyRef, ...operation }) => ({
                  ...operation,
                  ...(await this.journal.readOperationBody(room.id, bodyRef)),
                }),
              ),
            ),
          };
        }),
      ),
    };
  }
  async write(
    snapshot: TriggerSnapshot,
    events: readonly AutomationRoomEvent[] = [],
  ): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw Error("Synthetic pre-commit failure");
    }
    const previous = this.journal.metadata();
    const roomEvents = structuredClone([...events]);
    const metadata: AutomationMetadata = {
      ...snapshot,
      rooms: snapshot.rooms.map(({ messages, operations, ...room }) => ({
        ...room,
        messageCount: room.messageCount ?? messages.length,
        operations: (operations ?? []).map(
          ({ text, replyTo, ...operation }) => {
            const prior = previous.rooms
              .find((entry) => entry.id === room.id)
              ?.operations?.find((entry) => entry.id === operation.id);
            if (prior) return { ...operation, bodyRef: prior.bodyRef };
            const body = {
              text,
              ...(replyTo === undefined ? {} : { replyTo }),
            };
            roomEvents.push({
              type: "operationBody",
              roomId: room.id,
              operationId: operation.id,
              ...body,
            });
            return {
              ...operation,
              bodyRef: {
                kind: "operation" as const,
                id: operation.id,
                sha256: fingerprintOperationBody(body),
              },
            };
          },
        ),
      })),
    };
    await this.journal.append({ metadata, roomEvents });
    this.writes.push({
      snapshot: structuredClone(snapshot),
      events: structuredClone(events),
    });
  }
}

async function setup() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-journal-service-"),
  );
  const options = { directory, assertWriterLease: () => {} };
  const journal = await AutomationTransactionStore.create(options, {
    triggers: [],
    history: [],
    rooms: [],
  });
  const store = new JournalPort(journal);
  let listener: ((method: any, params: any) => void) | undefined;
  let sends = 0;
  let onDispatch: (() => void) | undefined;
  const manager: any = {
    onNotification: (callback: typeof listener) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    request: async (method: string) => {
      if (method !== "zen/turn/wake")
        throw Error("Synthetic thread is not recoverable");
      sends++;
      onDispatch?.();
      return { mode: "start", turnId: "same-turn" };
    },
  };
  const service = new ZenXTriggerService(manager, store);
  await service.start();
  return {
    directory,
    options,
    journal,
    store,
    service,
    manager,
    get sends() {
      return sends;
    },
    onDispatch(callback: () => void) {
      onDispatch = callback;
    },
    complete() {
      listener?.("turn/completed", {
        threadId: "worker",
        turn: {
          id: "same-turn",
          status: "completed",
          error: null,
          itemsView: "full",
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          items: [
            {
              type: "agentMessage",
              id: "answer",
              text: "Synthetic reply",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      });
    },
    async cleanup() {
      await service.close();
      await journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw Error("Synthetic completion did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("journal service preserves 320 messages, exact old reactions/replies/receipts and counts across reload with cache50", async () => {
  const f = await setup();
  try {
    const room = await f.service.createRoom({
      name: "Synthetic",
      members: [{ name: "Worker", threadId: "worker" }],
    });
    for (let i = 0; i < 320; i++)
      await f.service.postAgentRoomMessage(room.id, `Message ${i}`);
    assert.equal(f.service.snapshot().rooms[0]!.messageCount, 320);
    assert.equal(f.service.snapshot().rooms[0]!.messages.length, 50);
    const all = [];
    let cursor: number | null = 0;
    let snapshot;
    do {
      const page = await f.service.readRoomPage(room.id, cursor, snapshot);
      snapshot = page.snapshot;
      assert(page.messages.length <= 4);
      all.unshift(...page.messages);
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(
      all.map((message) => message.text),
      Array.from({ length: 320 }, (_, i) => `Message ${i}`),
    );
    assert.equal(new Set(all.map((message) => message.id)).size, 320);
    const oldest = all[0]!;
    await f.service.setRoomReaction(room.id, oldest.id, null, "👀");
    assert.equal(
      (await f.service.readRoomMessage(room.id, oldest.id))!.message
        .reactions?.[0]?.emoji,
      "👀",
    );
    await f.service.postAgentRoomMessage(room.id, "Reply", oldest.id);
    assert.equal(
      f.service.snapshot().rooms[0]!.messages.at(-1)!.replyTo?.messageId,
      oldest.id,
    );
    const key = `${room.operationEpoch}:${randomUUID()}`;
    await f.service.prepareRoomMessage(room.id, key, "Human quote", oldest.id);
    const saved = await f.service.postPreparedRoomMessage(
      room.id,
      key,
      "Human quote",
    );
    const write = f.store.writes.findLast((entry) =>
      entry.events.some(
        (event) =>
          event.type === "message" && event.message.id === saved.messageId,
      ),
    )!;
    assert.equal(
      write.snapshot.rooms[0]!.operations!.find(
        (operation) => operation.id === key,
      )!.messageId,
      saved.messageId,
    );
    assert.equal(write.events.length, 1);
    await f.service.postPreparedRoomMessage(room.id, key, "Human quote");
    assert.equal(f.service.snapshot().rooms[0]!.messageCount, 322);
    assert.equal(
      (await f.service.roomMessageReceipt(room.id, oldest.id)).receipt,
      "delivered",
    );
    assert.equal(f.sends, 0);
    await f.service.close();
    const generation = f.journal.generation;
    await f.journal.close();
    const reopened = await AutomationTransactionStore.open(
      f.options,
      generation,
    );
    const service = new ZenXTriggerService(
      f.manager,
      new JournalPort(reopened),
    );
    try {
      await service.start();
      assert.equal(service.snapshot().rooms[0]!.messageCount, 322);
      assert.equal(service.snapshot().rooms[0]!.messages.length, 50);
      assert.equal(
        (await service.readRoomMessage(room.id, oldest.id))!.message
          .reactions?.[0]?.emoji,
        "👀",
      );
      assert.equal(
        service.roomOperation(room.id, key).messageId,
        saved.messageId,
      );
    } finally {
      await service.close();
      await reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("failed journal write installs no candidate snapshot and dispatch observes message+receipt+wakeup commit", async () => {
  const f = await setup();
  try {
    const room = await f.service.createRoom({
      name: "Atomic",
      members: [{ name: "Worker", threadId: "worker" }],
    });
    await f.service.create({
      kind: "roomMention",
      threadId: "worker",
      roomId: room.id,
      mention: "Worker",
      label: "Reply",
      prompt: "Synthetic reply",
    });
    const key = `${room.operationEpoch}:${randomUUID()}`;
    await f.service.prepareRoomMessage(room.id, key, "@Worker task");
    f.store.failNext = true;
    await assert.rejects(
      f.service.postPreparedRoomMessage(room.id, key, "@Worker task"),
      /pre-commit/,
    );
    assert.equal(f.service.snapshot().rooms[0]!.messageCount, 0);
    assert.equal(f.service.roomOperation(room.id, key).messageId, null);
    assert.equal(f.sends, 0);
    f.onDispatch(() => {
      const write = f.store.writes.findLast((entry) =>
        entry.events.some((event) => event.type === "message"),
      )!;
      const operation = write.snapshot.rooms[0]!.operations!.find(
        (entry) => entry.id === key,
      )!;
      assert(operation.messageId);
      assert(
        write.snapshot.history.some(
          (entry) => entry.sourceRoomMessageId === operation.messageId,
        ),
      );
      assert(
        write.events.some(
          (event) =>
            event.type === "message" &&
            event.message.id === operation.messageId,
        ),
      );
    });
    await f.service.postPreparedRoomMessage(room.id, key, "@Worker task");
    await eventually(() => f.sends === 1);
    assert.equal(f.service.snapshot().rooms[0]!.messageCount, 1);
  } finally {
    await f.cleanup();
  }
});

test("messageCount validator accepts bounded journal projection but rejects invalid counts", () => {
  const room = {
    id: "room",
    name: "Synthetic",
    members: [],
    messages: [],
    createdAt: 1,
    messageCount: 320,
  };
  assert.equal(
    canonicalTriggerSnapshot({ triggers: [], history: [], rooms: [room] })
      .rooms[0]!.messageCount,
    320,
  );
  for (const messageCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      canonicalTriggerSnapshot({
        triggers: [],
        history: [],
        rooms: [{ ...room, messageCount }],
      }),
    );
});

test("journal notifications are body-free invalidations; explicit previews trim codepoints before cloning", async () => {
  const f = await setup();
  try {
    const room = await f.service.createRoom({
      name: "Preview",
      members: [{ name: "Worker", threadId: "worker" }],
    });
    let notified: TriggerSnapshot | undefined;
    f.service.onChange((snapshot) => {
      notified = snapshot;
    });
    await f.service.postAgentRoomMessage(room.id, "Original quote");
    const first = f.service.snapshot().rooms[0]!.messages[0]!;
    await f.service.postAgentRoomMessage(room.id, "🙂".repeat(140), first.id);
    const last = f.service.snapshot().rooms[0]!.messages.at(-1)!;
    await f.service.setRoomReaction(room.id, last.id, null, "👀");
    await f.service.prepareRoomMessage(
      room.id,
      `${room.operationEpoch}:${randomUUID()}`,
      "PRIVATE OPERATION ".repeat(30),
      first.id,
    );
    assert.deepEqual(notified, {
      triggers: [],
      history: [],
      rooms: [
        {
          id: room.id,
          name: "Preview",
          createdAt: room.createdAt,
          members: [],
          messages: [],
          messageCount: 2,
        },
      ],
    });
    const preview = f.service.snapshotPreviews().rooms[0]!;
    assert.equal(preview.messages.length, 1);
    assert.equal(preview.messages[0]!.text, "🙂".repeat(120));
    assert.equal(preview.messages[0]!.replyTo, undefined);
    assert.equal(preview.messages[0]!.reactions, undefined);
    assert.equal(preview.operations.length, 1);
    assert.equal(preview.operations[0]!.text, "");
    assert.equal("replyTo" in preview.operations[0]!, false);
    assert.equal("assistantWorkspace" in preview, false);
    const operationPreview = f.service.roomOperations(room.id)[0]!;
    assert.equal(
      operationPreview.text,
      "PRIVATE OPERATION ".repeat(30).slice(0, 120),
    );
    assert.equal(operationPreview.replyTo, undefined);
    assert.equal(
      f.service.snapshot().rooms[0]!.operations![0]!.text,
      "PRIVATE OPERATION ".repeat(30).trim(),
    );
    preview.messages[0]!.text = "consumer mutation";
    preview.members[0]!.name = "consumer mutation";
    assert.equal(
      f.service.snapshot().rooms[0]!.messages.at(-1)!.text,
      "🙂".repeat(140),
    );
    assert.equal(f.service.snapshot().rooms[0]!.members[0]!.name, "Worker");
  } finally {
    await f.cleanup();
  }
});

test("legacy storage retains full history and unchanged full notifications", async () => {
  let persisted: TriggerSnapshot = { triggers: [], history: [], rooms: [] };
  const service = new ZenXTriggerService(
    { onNotification: () => () => {} } as any,
    {
      read: async () => structuredClone(persisted),
      write: async (value) => {
        persisted = structuredClone(value);
      },
    },
  );
  try {
    await service.start();
    const room = await service.createRoom({
      name: "Legacy",
      members: [{ name: "Worker", threadId: "worker" }],
    });
    let notified: TriggerSnapshot | undefined;
    service.onChange((snapshot) => {
      notified = snapshot;
    });
    for (let i = 0; i < 260; i++)
      await service.postAgentRoomMessage(room.id, `Legacy ${i}`);
    assert.equal(persisted.rooms[0]!.messages.length, 260);
    assert.equal(persisted.rooms[0]!.messageCount, undefined);
    assert.deepEqual(notified, service.snapshot());
    assert.equal(service.snapshotPreviews().rooms[0]!.messageCount, 260);
    const page = await service.readRoomPage(room.id, 256);
    assert.deepEqual(
      page.messages.map((message) => message.text),
      ["Legacy 0", "Legacy 1", "Legacy 2", "Legacy 3"],
    );
  } finally {
    await service.close();
  }
});

test("completed-turn origin index suppresses duplicate reply after original leaves recent cache", async () => {
  const f = await setup();
  try {
    const room = await f.service.createRoom({
      name: "Origin",
      members: [{ name: "Worker", threadId: "worker" }],
    });
    await f.service.create({
      kind: "roomMention",
      threadId: "worker",
      roomId: room.id,
      mention: "Worker",
      label: "Reply",
      prompt: "Synthetic reply",
    });
    await f.service.postRoomMessage(room.id, "You", "@Worker first");
    f.complete();
    await eventually(() => f.service.snapshot().rooms[0]!.messageCount === 2);
    for (let i = 0; i < 60; i++)
      await f.service.postAgentRoomMessage(room.id, `Filler ${i}`);
    assert.equal(
      f.service
        .snapshot()
        .rooms[0]!.messages.some(
          (message) => message.originTurnId === "same-turn",
        ),
      false,
    );
    await f.service.postRoomMessage(room.id, "You", "@Worker again");
    f.complete();
    await eventually(() =>
      f.service
        .snapshot()
        .history.every((entry) => entry.status === "completed"),
    );
    assert.equal(f.service.snapshot().rooms[0]!.messageCount, 63);
  } finally {
    await f.cleanup();
  }
});

test("assistant invalidations carry only bounded identity and changing total count for remote readers", async () => {
  const f = await setup();
  try {
    const room = await f.service.createAssistantRoom({
      name: "Synthetic assistant",
      members: [{ name: "Bot", threadId: "assistant-thread" }],
    });
    const counts: number[] = [];
    f.service.onChange((snapshot) => {
      const invalidation = snapshot.rooms.find(
        (candidate) => candidate.id === room.id,
      )!;
      assert.equal(invalidation.assistant?.threadId, "assistant-thread");
      assert.equal(
        invalidation.assistant?.triggerId,
        room.assistant?.triggerId,
      );
      assert.equal(invalidation.assistantWorkspace, undefined);
      assert.deepEqual(invalidation.messages, []);
      assert.equal(invalidation.operations, undefined);
      assert.equal(JSON.stringify(snapshot).includes("PRIVATE BODY"), false);
      counts.push(invalidation.messageCount!);
    });
    await f.service.postAgentRoomMessage(room.id, "PRIVATE BODY one");
    await f.service.postAgentRoomMessage(room.id, "PRIVATE BODY two");
    assert.deepEqual(counts, [1, 2]);
  } finally {
    await f.cleanup();
  }
});

test(
  "Host invalidations advance for same-count mutations and restart publishes a fresh snapshot, not a remote watermark",
  { timeout: 10000 },
  async () => {
    const f = await setup();
    let restarted: ZenXTriggerService | undefined;
    try {
      const room = await f.service.createAssistantRoom({
        name: "Synthetic assistant",
        members: [{ name: "Bot", threadId: "assistant-thread" }],
      });
      const seen: Array<{ snapshot: TriggerSnapshot; revision: number }> = [];
      f.service.onChange((snapshot, revision) =>
        seen.push({ snapshot, revision }),
      );
      await f.service.postAgentRoomMessage(room.id, "PRIVATE BODY");
      const message = (await f.service.readRoomPage(room.id, 0)).messages[0]!;
      const beforeReaction = seen.at(-1)!.revision;
      await f.service.setRoomReaction(room.id, message.id, null, "👀");
      assert(seen.at(-1)!.revision > beforeReaction);
      assert.equal(seen.at(-1)!.snapshot.rooms[0]!.messageCount, 1);
      const beforeMode = seen.at(-1)!.revision;
      await f.service.setAssistantDeliveryMode(room.id, "queue");
      assert(seen.at(-1)!.revision > beforeMode);
      assert.equal(
        seen.at(-1)!.snapshot.rooms[0]!.assistant?.deliveryMode,
        "queue",
      );
      const operationId = `${room.operationEpoch}:${randomUUID()}`;
      await f.service.prepareRoomMessage(
        room.id,
        operationId,
        "PRIVATE BODY human",
      );
      await f.service.postPreparedRoomMessage(
        room.id,
        operationId,
        "PRIVATE BODY human",
      );
      const beforeAck = seen.at(-1)!.revision;
      await f.service.acknowledgeRoomOperation(room.id, operationId);
      assert(seen.at(-1)!.revision > beforeAck);
      assert.equal(seen.at(-1)!.snapshot.rooms[0]!.messageCount, 2);
      assert.equal(
        f.service
          .snapshot()
          .rooms[0]!.operations!.find(
            (operation) => operation.id === operationId,
          )!.acknowledged,
        true,
      );
      const beforeRead = seen.length;
      await f.service.readRoomPage(room.id, 0);
      f.service.snapshotSummaries();
      assert.equal(
        seen.length,
        beforeRead,
        "reads must not cause notification loops",
      );
      for (let i = 1; i < seen.length; i++)
        assert(seen[i]!.revision > seen[i - 1]!.revision);
      for (const { snapshot } of seen) {
        assert.equal(JSON.stringify(snapshot).includes("PRIVATE BODY"), false);
        assert.deepEqual(snapshot.rooms[0]!.messages, []);
        assert.equal(snapshot.rooms[0]!.operations, undefined);
      }
      await f.service.close();
      restarted = new ZenXTriggerService(f.manager, f.store);
      const initial: Array<{ snapshot: TriggerSnapshot; revision: number }> =
        [];
      restarted.onChange((snapshot, revision) =>
        initial.push({ snapshot, revision }),
      );
      await restarted.start();
      assert.equal(
        initial[0]!.revision,
        1,
        "new Host starts a new local notification lifetime",
      );
      assert.equal(initial[0]!.snapshot.rooms[0]!.messageCount, 2);
      assert.equal(
        initial[0]!.snapshot.rooms[0]!.assistant?.deliveryMode,
        "queue",
      );
      assert.equal(
        restarted
          .snapshot()
          .rooms[0]!.operations!.find(
            (operation) => operation.id === operationId,
          )!.acknowledged,
        true,
      );
    } finally {
      await restarted?.close();
      await f.cleanup();
    }
  },
);
