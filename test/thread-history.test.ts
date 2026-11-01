import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSnapshot } from "../src/app-server.js";
import type { CanonicalItem } from "../src/item.js";
import {
  readThreadHistory,
  type HistoryOptions,
} from "../src/thread-history.js";

const base = { threadId: "synthetic", createdAt: "2026-10-31T00:00:00Z" };
const options: HistoryOptions = {
  granularity: "turns",
  maxTurns: 20,
  maxItemsPerTurn: 20,
};
function fixture(size: number): ThreadSnapshot & { items: CanonicalItem[] } {
  const items = Array.from({ length: size }, (_, i) => ({
    ...base,
    id: `item-${i}`,
    turnId: `turn-${Math.floor(i / 5)}`,
    ...(i % 5 === 0
      ? { type: "turn_started" }
      : i % 5 === 4
        ? { type: "turn_completed", status: "completed" }
        : {
            type: "agent_message",
            text: "Synthetic message",
            phase: "final_answer",
          }),
  })) as CanonicalItem[];
  return {
    id: "synthetic",
    cwd: "/synthetic",
    items,
  } as unknown as ThreadSnapshot & { items: CanonicalItem[] };
}

// Independent, deliberately repeated filtering models the original turn page.
// Item views provide the unchanged public preview contract (including opaque data).
function expectedTurns(
  thread: ThreadSnapshot,
  selected: CanonicalItem[],
  limit: number,
  throughItemId?: string,
) {
  const boundary =
    throughItemId === undefined
      ? thread.items.length
      : thread.items.findIndex((item) => item.id === throughItemId) + 1;
  return selected.map((started) => {
    const items = thread.items
      .slice(0, boundary)
      .filter(
        (item) =>
          item.turnId === started.turnId &&
          item.type !== "thread_deleted" &&
          item.type !== "thread_restored",
      );
    const terminal = items.findLast(
      (item) => item.type === "turn_completed" || item.type === "turn_aborted",
    );
    const page = readThreadHistory(thread, {
      ...options,
      granularity: "items",
      turnId: started.turnId!,
      maxItemsPerTurn: limit,
      ...(throughItemId === undefined ? {} : { throughItemId }),
    });
    return {
      turnId: started.turnId,
      status:
        terminal?.type === "turn_completed"
          ? terminal.status
          : terminal?.type === "turn_aborted"
            ? "interrupted"
            : "inProgress",
      items: page.items,
      itemsTruncated: items.length > limit,
      readItems: {
        target: thread.id,
        granularity: "items",
        turnId: started.turnId,
        ...(throughItemId === undefined ? {} : { throughItemId }),
      },
    };
  });
}

for (const size of [100, 1000, 5000]) {
  test(`turn history matches per-turn views and linear work budget: ${size} items`, () => {
    const thread = fixture(size);
    let turnIdReads = 0;
    const tracked = {
      ...thread,
      items: thread.items.map(
        (item) =>
          new Proxy(item, {
            get(target, key, receiver) {
              if (key === "turnId") turnIdReads++;
              return Reflect.get(target, key, receiver);
            },
          }),
      ),
    };
    const result = readThreadHistory(tracked, options);
    assert(
      turnIdReads <= 4 * size + 1000,
      `${turnIdReads} turnId reads exceeds linear budget`,
    );
    assert.deepEqual(
      result.turns,
      expectedTurns(
        thread,
        thread.items.filter((item) => item.type === "turn_started").slice(-20),
        5,
      ),
    );
    assert.equal(result.maxItemsPerTurn, 5);
    assert.equal(result.turnsTruncated, size > 100);
  });
}

test("turn cursors keep the canonical snapshot across appends and paginate without loss", () => {
  const thread = fixture(125);
  const first = readThreadHistory(thread, options);
  assert.equal(first.snapshotThroughItemId, "item-124");
  assert.equal(typeof first.nextCursor, "string");
  const appended = fixture(150);
  const second = readThreadHistory(appended, {
    ...options,
    cursor: first.nextCursor as string,
  });
  assert.equal(second.snapshotThroughItemId, "item-124");
  assert.deepEqual(
    second.turns,
    expectedTurns(
      thread,
      thread.items.filter((item) => item.type === "turn_started").slice(0, 5),
      5,
    ),
  );
  assert.equal(second.nextCursor, null);
  assert.equal(second.turnsTruncated, false);
  assert.deepEqual(readThreadHistory(fixture(0), options).turns, []);
});

test("interleaved imported, opaque, duplicate-turn and lifecycle items preserve ordering and terminal selection", () => {
  const thread = fixture(15);
  thread.items.splice(6, 0, {
    ...base,
    id: "imported",
    turnId: "turn-0",
    type: "tool_result",
    output: "Imported output",
    exitCode: null,
    contentType: "zen.imported-tool-result.v1",
  } as CanonicalItem);
  thread.items.push(
    {
      ...base,
      id: "opaque",
      turnId: "turn-0",
      type: "reasoning",
      contentVisibility: "opaque",
      reasoningContent: "NEVER EXPOSE",
      summary: "Public summary",
    } as CanonicalItem,
    {
      ...base,
      id: "abort",
      turnId: "turn-0",
      type: "turn_aborted",
    } as CanonicalItem,
    {
      ...base,
      id: "duplicate-start",
      turnId: "turn-0",
      type: "turn_started",
    } as CanonicalItem,
    {
      ...base,
      id: "no-terminal",
      turnId: "pending",
      type: "turn_started",
    } as CanonicalItem,
    {
      ...base,
      id: "delete",
      turnId: "turn-0",
      type: "thread_deleted",
    } as CanonicalItem,
    {
      ...base,
      id: "restore",
      turnId: "turn-0",
      type: "thread_restored",
    } as CanonicalItem,
  );
  const saved = JSON.stringify(thread);
  const result = readThreadHistory(thread, { ...options, maxTurns: 5 });
  assert.deepEqual(
    result.turns,
    expectedTurns(
      thread,
      thread.items.filter((item) => item.type === "turn_started"),
      20,
    ),
  );
  assert.equal(result.snapshotThroughItemId, "restore");
  assert(!JSON.stringify(result).includes("NEVER EXPOSE"));
  assert.equal(JSON.stringify(thread), saved);
});

test("enabled original boundary excludes later terminals and preserves cursor/filter errors", () => {
  const thread = fixture(125);
  thread.items.push({
    ...base,
    id: "compaction",
    type: "context_compaction",
    coveredThroughItemId: "item-121",
    includeOriginalReference: true,
  } as CanonicalItem);
  const bounded = { ...options, throughItemId: "item-121" };
  const page = readThreadHistory(thread, bounded);
  const selected = thread.items
    .slice(0, 122)
    .filter((item) => item.type === "turn_started")
    .slice(-20);
  assert.deepEqual(page.turns, expectedTurns(thread, selected, 5, "item-121"));
  const continuation = readThreadHistory(thread, {
    ...bounded,
    cursor: page.nextCursor as string,
  });
  assert.equal(continuation.snapshotThroughItemId, "item-121");
  assert.equal(continuation.nextCursor, null);
  assert.throws(
    () =>
      readThreadHistory(thread, {
        ...options,
        cursor: page.nextCursor as string,
      }),
    /Invalid history cursor/,
  );
  assert.throws(
    () => readThreadHistory(thread, { ...options, turnId: "missing" }),
    /Unknown turnId/,
  );
  assert.throws(
    () => readThreadHistory(thread, { ...options, cursor: "invalid" }),
    /Invalid history cursor/,
  );
  assert.throws(
    () => readThreadHistory(thread, { ...options, throughItemId: "item-120" }),
    /not enabled/,
  );
  const cursor = JSON.parse(
    Buffer.from(page.nextCursor as string, "base64url").toString(),
  );
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.throws(
    () =>
      readThreadHistory(thread, {
        ...bounded,
        cursor: encode({ ...cursor, before: "missing" }),
      }),
    /page boundary does not exist/,
  );
  assert.throws(
    () =>
      readThreadHistory(thread, {
        ...bounded,
        cursor: encode({ ...cursor, boundary: "item-120" }),
      }),
    /does not match the original/,
  );
  const unbounded = readThreadHistory(thread, options);
  const unboundedCursor = JSON.parse(
    Buffer.from(unbounded.nextCursor as string, "base64url").toString(),
  );
  assert.throws(
    () =>
      readThreadHistory(thread, {
        ...options,
        cursor: encode({ ...unboundedCursor, boundary: "missing" }),
      }),
    /boundary no longer exists/,
  );
});

test("duplicate item IDs retain first-match canonical boundary semantics", () => {
  const thread = fixture(15);
  // A duplicate final ID must not extend the snapshot past the first match.
  thread.items.push({ ...thread.items[4]!, turnId: "turn-2" } as CanonicalItem);
  const result = readThreadHistory(thread, options);
  assert.equal(result.snapshotThroughItemId, "item-4");
  assert.deepEqual(
    result.turns,
    expectedTurns(
      { ...thread, items: thread.items.slice(0, 5) },
      [thread.items[0]!],
      5,
    ),
  );
  assert.equal(result.nextCursor, null);
});
