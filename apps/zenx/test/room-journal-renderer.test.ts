import assert from "node:assert/strict";
import test from "node:test";
import {
  readRoomHistory,
  mergeRoomHistoryReactions,
  type RoomHistoryPage,
  type RoomHistorySnapshot,
} from "../src/renderer/src/room-history.js";
const message = (id: number) => ({
  id: `m${id}`,
  roomId: "room",
  kind: "agent" as const,
  author: "Synthetic",
  text: `Message ${id}`,
  createdAt: id % 3,
  originThreadId: null,
  originTurnId: null,
});
const snapshot: RoomHistorySnapshot = {
  generation: "11111111-1111-4111-8111-111111111111",
  revision: 500,
  hash: "a".repeat(64),
  roomId: "room",
  messageCount: 320,
};
const options = {
  isCurrent: () => true,
  invalidCursorMessage: "Invalid cursor",
  changedHistoryMessage: "Changed history",
};
function page(cursor: number, selected = snapshot): RoomHistoryPage {
  const end = selected.messageCount - cursor,
    start = Math.max(0, end - 4),
    messages = Array.from({ length: end - start }, (_, i) =>
      message(start + i),
    );
  return {
    messages,
    nextCursor: start ? cursor + messages.length : null,
    snapshot: { ...selected },
    reactionRevisions: Object.fromEntries(
      messages.map((message) => [message.id, 0]),
    ),
  };
}
test("stable320 history pins every page across arrivals without legacy tail rescans", async () => {
  const calls: Array<[number, RoomHistorySnapshot | undefined]> = [];
  const result = await readRoomHistory(
    async (cursor, selected) => {
      calls.push([cursor, selected]);
      return page(
        cursor,
        selected ?? {
          ...snapshot,
          messageCount: calls.length === 1 ? 320 : 332,
        },
      );
    },
    { ...options, oldestMessageId: "m0" },
  );
  assert.deepEqual(
    result!.messages,
    Array.from({ length: 320 }, (_, i) => message(i)),
  );
  assert.equal(calls.length, 80);
  assert.equal(calls.filter(([cursor]) => cursor === 0).length, 1);
  for (const [, selected] of calls.slice(1))
    assert.deepEqual(selected, snapshot);
  assert.equal(
    new Set(result!.messages.map((message) => message.id)).size,
    320,
  );
});
test("stable initial4 and earlier16 stay lazy; changed coordinates, duplicate IDs and invalid reactions reject", async () => {
  let calls = 0;
  const read = async (cursor: number) => {
    calls++;
    return page(cursor);
  };
  assert.equal((await readRoomHistory(read, options))!.messages.length, 4);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(
    (await readRoomHistory(read, {
      ...options,
      oldestMessageId: "m316",
      earlierMessages: 16,
    }))!.messages.length,
    20,
  );
  assert.equal(calls, 5);
  await assert.rejects(
    readRoomHistory(
      async (cursor) =>
        page(cursor, cursor ? { ...snapshot, hash: "b".repeat(64) } : snapshot),
      { ...options, oldestMessageId: "m0" },
    ),
    /Changed history/,
  );
  await assert.rejects(
    readRoomHistory(
      async (cursor) => ({ ...page(cursor), reactionRevisions: {} }),
      options,
    ),
    /Changed history/,
  );
  await assert.rejects(
    readRoomHistory(
      async (cursor) => ({ ...page(cursor), nextCursor: null }),
      options,
    ),
    /Invalid cursor/,
  );
  await assert.rejects(
    readRoomHistory(
      async (cursor) => ({ ...page(cursor), messages: page(0).messages }),
      { ...options, oldestMessageId: "m316", earlierMessages: 16 },
    ),
    /Changed history/,
  );
});
test("stale snapshot reads abort and older reactions cannot overwrite newer revisions or receipts", async () => {
  assert.equal(
    await readRoomHistory(async (cursor) => page(cursor), {
      ...options,
      isCurrent: () => false,
    }),
    null,
  );
  const old = page(0),
    current = {
      ...old,
      messages: old.messages.map((message) => ({
        ...message,
        reactions: [{ actorId: "user", label: "You", emoji: "👍" }],
      })),
      reactionRevisions: { m316: 501, m317: 501, m318: 501, m319: 501 },
    };
  assert.equal(
    mergeRoomHistoryReactions(old, current).messages[0]!.reactions![0]!.emoji,
    "👍",
  );
  const legacy = { messages: old.messages, nextCursor: 0 };
  const receipt = { messages: current.messages, nextCursor: 0 };
  assert.equal(
    mergeRoomHistoryReactions(legacy, receipt, new Set(["m319"])).messages.at(
      -1,
    )!.reactions![0]!.emoji,
    "👍",
  );
  assert.equal(
    mergeRoomHistoryReactions(legacy, receipt).messages.at(-1)!.reactions,
    undefined,
  );
  assert.equal(
    mergeRoomHistoryReactions(old, {
      ...current,
      snapshot: {
        ...snapshot,
        generation: "22222222-2222-4222-8222-222222222222",
      },
    }),
    old,
  );
});
