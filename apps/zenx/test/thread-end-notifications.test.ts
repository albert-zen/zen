import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  NativeProjectedThreadEvent,
  NativeThreadRecoverySnapshot,
} from "../../../src/protocol/native/recovery.js";
import { createConversationReadStore } from "../src/renderer/src/conversation-read-state.js";
import { createThreadEndNotificationObserver } from "../src/renderer/src/thread-end-notifications.js";

function disk() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function ended(
  position: number,
  epoch = "current",
  watermark = position + 1,
): NativeProjectedThreadEvent {
  return {
    processEpoch: epoch,
    threadId: "thread",
    watermark,
    event: {
      type: "item_completed",
      turnEndPosition: position,
      item: {
        type: "turn_completed",
        id: `end-${position}`,
        threadId: "thread",
        turnId: `turn-${position}`,
        status: "completed",
        createdAt: new Date(150 - position).toISOString(),
      },
    },
  };
}

test("only current-epoch live ends bypass the installation clock, pending is canonical and read clearing is bounded", async () => {
  const storage = disk();
  const store = createConversationReadStore(storage, 200);
  store.advance("rooms", "room", { id: "room-read", createdAt: 20 });
  let ready!: (value: { processEpoch: string }) => void;
  const handshake = new Promise<{ processEpoch: string }>((resolve) => {
    ready = resolve;
  });
  const observer = createThreadEndNotificationObserver(store, () => handshake);
  const connected = observer.connect();
  observer.observe(ended(50, "retired"));
  observer.observe(ended(0));
  assert.deepEqual(
    store.getSnapshot().pendingThreadEnds,
    {},
    "unverified epochs cannot create unread",
  );
  ready({ processEpoch: "current" });
  await connected;
  assert.equal(store.getSnapshot().pendingThreadEnds.thread?.id, "end-0");
  observer.observe(ended(1));
  observer.observe(ended(0, "current", 100));
  observer.observe(ended(80, "retired", 1000));
  assert.equal(
    store.getSnapshot().pendingThreadEnds.thread?.id,
    "end-1",
    "old ordinal/epoch cannot replace a newer end",
  );
  store.advance("threads", "thread", {
    id: "end-0",
    createdAt: 150,
    position: 0,
  });
  assert.equal(
    store.getSnapshot().pendingThreadEnds.thread?.id,
    "end-1",
    "reading an older tail cannot clear a newer pending end",
  );
  const reloaded = createConversationReadStore(storage, 1000);
  assert.equal(reloaded.getSnapshot().pendingThreadEnds.thread?.id, "end-1");
  reloaded.advance("threads", "thread", {
    id: "end-1",
    createdAt: 149,
    position: 1,
  });
  assert.equal(reloaded.getSnapshot().pendingThreadEnds.thread, undefined);
  observer.observe(ended(1, "current", 101));
  store.reload();
  assert.equal(
    store.getSnapshot().pendingThreadEnds.thread,
    undefined,
    "duplicate live end does not revive a persisted read",
  );
  assert.deepEqual(store.getSnapshot().rooms.room, {
    id: "room-read",
    createdAt: 20,
  });
  observer.disconnect();
});

test("disconnect retires pending handshakes; new epochs reject historical notifications and missing evidence", async () => {
  const store = createConversationReadStore(disk(), 200);
  const resolutions: Array<(value: { processEpoch: string }) => void> = [];
  const observer = createThreadEndNotificationObserver(
    store,
    () =>
      new Promise((resolve) => {
        resolutions.push(resolve);
      }),
  );
  const first = observer.connect();
  await Promise.resolve();
  observer.observe(ended(0, "old"));
  observer.disconnect();
  const second = observer.connect();
  await Promise.resolve();
  observer.observe(ended(5, "old"));
  observer.observe(ended(1, "new"));
  resolutions[0]!({ processEpoch: "old" });
  await first;
  assert.deepEqual(store.getSnapshot().pendingThreadEnds, {});
  resolutions[1]!({ processEpoch: "new" });
  await second;
  assert.equal(store.getSnapshot().pendingThreadEnds.thread?.id, "end-1");
  observer.observe(ended(6, "old"));
  const legacy = ended(7, "new");
  assert(legacy.event.type === "item_completed");
  delete legacy.event.turnEndPosition;
  observer.observe(legacy);
  assert.equal(store.getSnapshot().pendingThreadEnds.thread?.id, "end-1");
  observer.disconnect();
  observer.observe(ended(8, "new"));
  assert.equal(store.getSnapshot().pendingThreadEnds.thread?.id, "end-1");
});

test("resume barrier envelopes fence epoch, requested Thread and watermark without scanning history", async () => {
  const store = createConversationReadStore(disk(), 200);
  const observer = createThreadEndNotificationObserver(store, async () => ({
    processEpoch: "current",
  }));
  await observer.connect();
  const snapshot = (event = ended(0)): NativeThreadRecoverySnapshot => ({
    processEpoch: event.processEpoch,
    threadId: "thread",
    watermark: event.watermark,
    thread: {
      id: "thread",
      items: [],
    } as unknown as NativeThreadRecoverySnapshot["thread"],
    events: [event],
  });
  observer.recover("other", snapshot());
  observer.recover("thread", snapshot(ended(0, "retired")));
  observer.recover("thread", { ...snapshot(), watermark: 0 });
  observer.recover("thread", { ...snapshot(), processEpoch: "retired" });
  observer.recover("thread", {
    ...snapshot(),
    thread: { ...snapshot().thread, id: "other" },
  });
  const historical = ended(0).event;
  assert(historical.type === "item_completed");
  observer.recover("thread", {
    ...snapshot(),
    events: [],
    thread: { ...snapshot().thread, items: [historical.item] },
  });
  assert.deepEqual(store.getSnapshot().pendingThreadEnds, {});
  observer.recover("thread", snapshot());
  assert.equal(store.getSnapshot().pendingThreadEnds.thread?.id, "end-0");
  observer.disconnect();
});

test("ready during a pending failed handshake is consumed once without a retry loop", async () => {
  const store = createConversationReadStore(disk(), 200);
  const attempts: Array<{
    resolve(value: { processEpoch: string }): void;
    reject(error: Error): void;
  }> = [];
  const observer = createThreadEndNotificationObserver(
    store,
    () =>
      new Promise((resolve, reject) => {
        attempts.push({ resolve, reject });
      }),
  );
  const first = observer.connect();
  await Promise.resolve();
  void observer.connect();
  observer.observe(ended(0));
  attempts[0]!.reject(new Error("Earlier IPC not ready"));
  for (let index = 0; index < 10 && attempts.length < 2; index++)
    await Promise.resolve();
  assert.equal(attempts.length, 2);
  attempts[1]!.resolve({ processEpoch: "current" });
  await first;
  assert.equal(store.getSnapshot().pendingThreadEnds.thread?.id, "end-0");
  observer.disconnect();
  const failure = observer.connect();
  await Promise.resolve();
  const warn = console.warn;
  console.warn = () => {};
  try {
    attempts[2]!.reject(new Error("No successor ready signal"));
    await failure;
    assert.equal(attempts.length, 3, "failure alone cannot retry");
  } finally {
    console.warn = warn;
    observer.disconnect();
  }
});
