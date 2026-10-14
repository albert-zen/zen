import assert from "node:assert/strict";
import test from "node:test";
import { readRoomHistory } from "../src/renderer/src/room-history.js";
import type { ZenXRoom } from "../src/main/trigger-types.js";

const message = (id: number): ZenXRoom["messages"][number] => ({
  id: `m${id}`,
  roomId: "room",
  kind: "agent",
  author: "Bot",
  text: `Message ${id}`,
  createdAt: id,
  originThreadId: null,
  originTurnId: null,
});
const options = {
  isCurrent: () => true,
  invalidCursorMessage: "Invalid cursor",
  changedHistoryMessage: "History changed. Try again.",
};

for (const count of [40, 256])
  test(`history reconciles shifted tail offsets at ${count} retained messages`, async () => {
    let all = Array.from({ length: count }, (_, id) => message(id));
    let requests = 0;
    const read = async (cursor: number) => {
      requests += 1;
      // Two arrivals between pages overlap previously read IDs. At capacity,
      // messageCount cannot reveal that shift.
      if (requests === 2)
        all = [...all, message(count), message(count + 1)].slice(-256);
      const end = Math.max(0, all.length - cursor);
      const start = Math.max(0, end - 4);
      return {
        messages: all.slice(start, end),
        nextCursor: start > 0 ? cursor + end - start : null,
      };
    };
    const expanded = await readRoomHistory(read, {
      ...options,
      oldestMessageId: `m${count - 4}`,
      earlierMessages: 16,
    });
    assert.deepEqual(
      expanded!.messages.map((entry) => entry.id),
      Array.from({ length: 24 }, (_, id) => `m${count - 22 + id}`),
    );
    const refreshed = await readRoomHistory(read, {
      ...options,
      oldestMessageId: expanded!.messages[0]!.id,
    });
    assert.deepEqual(
      refreshed!.messages.map((entry) => entry.id),
      Array.from({ length: 24 }, (_, id) => `m${count - 22 + id}`),
    );
  });

test("evicted oldest identity resolves at the retained boundary without caching beyond 256", async () => {
  const all = Array.from({ length: 256 }, (_, id) => message(id + 10));
  let requests = 0;
  const page = await readRoomHistory(
    async (cursor) => {
      requests += 1;
      // The byte-size limit may make every page contain only one message.
      return {
        messages: all.slice(255 - cursor, 256 - cursor),
        nextCursor: cursor === 255 ? null : cursor + 1,
      };
    },
    { ...options, oldestMessageId: "m0", earlierMessages: 16 },
  );
  assert.equal(requests, 257);
  assert.deepEqual(page!.messages, all);
  assert.equal(page!.nextCursor, null);
});

test("history aborts stale reads and rejects nonadvancing cursors", async () => {
  let requests = 0;
  assert.equal(
    await readRoomHistory(
      async () => {
        requests += 1;
        return { messages: [message(1)], nextCursor: 1 };
      },
      { ...options, isCurrent: () => false },
    ),
    null,
  );
  assert.equal(requests, 1);
  for (const cursor of [0, -1, 256, Number.NaN])
    await assert.rejects(
      readRoomHistory(
        async () => ({ messages: [message(1)], nextCursor: cursor }),
        options,
      ),
      /Invalid cursor/,
    );
});

for (const count of [40, 256])
  for (const pageSize of [1, 4])
    for (const arrivals of [5, 12])
      test(`${arrivals} arrivals between ${pageSize}-message pages preserve canonical order at ${count} retained messages`, async () => {
        // Deliberately nonmonotonic timestamps: ordering belongs to Host pages.
        let all = Array.from({ length: count }, (_, id) => ({
          ...message(id),
          createdAt: id % 3,
        }));
        let requests = 0;
        const page = await readRoomHistory(
          async (cursor) => {
            requests += 1;
            if (requests === 2)
              all = [
                ...all,
                ...Array.from({ length: arrivals }, (_, id) => ({
                  ...message(count + id),
                  createdAt: 0,
                })),
              ].slice(-256);
            const end = Math.max(0, all.length - cursor);
            const start = Math.max(0, end - pageSize);
            return {
              messages: all.slice(start, end),
              nextCursor: start > 0 ? cursor + end - start : null,
            };
          },
          { ...options, oldestMessageId: `m${count - 4}`, earlierMessages: 16 },
        );
        const ids = page!.messages.map((entry) => entry.id);
        const oldest = all.findIndex((entry) => entry.id === ids[0]);
        assert.deepEqual(page!.messages, all.slice(oldest));
        assert.equal(ids.at(-1), `m${count + arrivals - 1}`);
        assert.equal(new Set(ids).size, ids.length);
        assert(
          oldest <= all.findIndex((entry) => entry.id === `m${count - 20}`),
        );
        assert(requests <= 3 * 257);
      });

test("continuous arrivals fail after bounded retries instead of publishing reordered history", async () => {
  let all = Array.from({ length: 256 }, (_, id) => message(id));
  let serial = 256;
  let requests = 0;
  await assert.rejects(
    readRoomHistory(
      async (cursor) => {
        requests += 1;
        if (cursor > 0)
          all = [
            ...all,
            ...Array.from({ length: 5 }, () => message(serial++)),
          ].slice(-256);
        const end = Math.max(0, all.length - cursor);
        const start = Math.max(0, end - 4);
        return {
          messages: all.slice(start, end),
          nextCursor: start > 0 ? cursor + end - start : null,
        };
      },
      { ...options, oldestMessageId: "m252", earlierMessages: 16 },
    ),
    /History changed. Try again./,
  );
  assert(requests <= 3 * 257);
});

test("an evicted oldest anchor restarts a changed snapshot and returns exactly the retained sequence", async () => {
  let all = Array.from({ length: 256 }, (_, id) => message(id));
  let requests = 0;
  const page = await readRoomHistory(
    async (cursor) => {
      requests += 1;
      if (requests === 2)
        all = [
          ...all,
          ...Array.from({ length: 12 }, (_, id) => message(256 + id)),
        ].slice(-256);
      const end = Math.max(0, all.length - cursor);
      const start = Math.max(0, end - 4);
      return {
        messages: all.slice(start, end),
        nextCursor: start > 0 ? cursor + end - start : null,
      };
    },
    { ...options, oldestMessageId: "m0", earlierMessages: 16 },
  );
  assert.deepEqual(page!.messages, all);
  assert.equal(page!.messages.length, 256);
  assert.equal(page!.nextCursor, null);
});

test("snapshot verification is stale-safe and network failure is never retried automatically", async () => {
  let requests = 0;
  let current = true;
  assert.equal(
    await readRoomHistory(
      async (cursor) => {
        requests += 1;
        if (requests === 3) current = false;
        return cursor === 0
          ? {
              messages: [message(4), message(5), message(6), message(7)],
              nextCursor: 4,
            }
          : {
              messages: [message(0), message(1), message(2), message(3)],
              nextCursor: null,
            };
      },
      { ...options, oldestMessageId: "m0", isCurrent: () => current },
    ),
    null,
  );
  assert.equal(requests, 3);
  requests = 0;
  await assert.rejects(
    readRoomHistory(async () => {
      requests += 1;
      throw Error("Network unavailable");
    }, options),
    /Network unavailable/,
  );
  assert.equal(requests, 1);
});
