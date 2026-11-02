import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../src/item.js";
import { Thread } from "../src/thread.js";
import { ThreadRecencyProjection } from "../src/thread-recency.js";

const at = (seconds: number) => new Date(seconds * 1_000).toISOString();
function fact(type: string, seconds: number, extra = {}): CanonicalItem {
  return {
    id: `${type}-${seconds}`,
    threadId: "thread",
    turnId: "turn",
    type,
    createdAt: at(seconds),
    ...extra,
  } as CanonicalItem;
}

test("Recent bumps for receipt and accepted final, never commentary/tools/status", () => {
  const projection = new ThreadRecencyProjection();
  const items: CanonicalItem[] = [fact("thread_metadata", 1)];
  const append = (item: CanonicalItem, expected: number) => {
    items.push(item);
    assert.equal(projection.read(items), at(expected));
    assert.equal(new ThreadRecencyProjection().read(items), at(expected));
  };
  append(fact("turn_started", 2), 1);
  append(fact("user_message", 3, { text: "hello" }), 3);
  append(fact("agent_message", 4, { text: "Checking" }), 3);
  append(fact("tool_call", 5), 3);
  append(fact("tool_result", 6), 3);
  append(fact("thread_configuration_changed", 7), 3);
  append(fact("model_usage", 8), 3);
  append(fact("agent_message", 9, { text: "final" }), 3);
  append(fact("turn_completed", 10, { status: "completed" }), 9);
  append(fact("thread_permissions_changed", 11), 9);
  append(fact("turn_started", 12, { turnId: "next" }), 9);
  append(fact("agent_message", 13, { turnId: "next", incomplete: true }), 9);
  append(fact("turn_completed", 14, { turnId: "next", status: "failed" }), 9);
  append(fact("turn_aborted", 15), 9);
});

test("queue, edited queue, steer and replacement preserve first human receipt", () => {
  const projection = new ThreadRecencyProjection();
  const items: CanonicalItem[] = [fact("thread_metadata", 1)];
  const append = (item: CanonicalItem, expected: number) => {
    items.push(item);
    assert.equal(projection.read(items), at(expected));
    assert.equal(new ThreadRecencyProjection().read(items), at(expected));
  };
  append(fact("user_message_queued", 3, { clientId: "queued" }), 3);
  append(fact("user_message_queue_edited", 4, { clientId: "queued" }), 3);
  append(fact("user_message", 8, { clientId: "queued" }), 3);
  append(fact("agent_message", 9, { text: "not accepted due to steer" }), 3);
  append(fact("user_message", 10, { clientId: "steer" }), 10);
  append(fact("user_message_queue_cancelled", 11), 10);
  append(
    fact("turn_replacement_requested", 12, { clientId: "replacement" }),
    12,
  );
  append(fact("turn_aborted", 13), 12);
  append(fact("user_message", 15, { clientId: "replacement" }), 12);
  append(
    fact("turn_replacement_requested", 16, {
      clientId: "agent-control",
      sender: { threadId: "other" },
    }),
    12,
  );
  append(fact("host_message", 17), 12);
  append(fact("thread_message", 18), 12);
  append(fact("agent_message", 19), 12);
  append(fact("turn_completed", 20, { status: "completed" }), 19);
});

test("fork resets inherited activity and keeps unknown import receipts unknown", () => {
  const items = [
    fact("thread_metadata", 1, {
      importedFrom: {
        historyItemCount: 100,
        contextBasis: { kind: "replacement-history" },
      },
    }),
    fact("user_message", 50, { clientId: "unknown-import" }),
    fact("thread_forked", 5),
    fact("user_message", 6, { clientId: "local" }),
  ];
  const projection = new ThreadRecencyProjection();
  assert.equal(projection.read(items.slice(0, 2)), at(1));
  assert.equal(projection.read(items), at(6));
  assert.equal(new ThreadRecencyProjection().read(items), at(6));
});

test("refresh only reads the appended suffix rather than rescanning history", () => {
  const projection = new ThreadRecencyProjection();
  const items = [fact("thread_metadata", 1), fact("user_message", 2)];
  assert.equal(projection.read(items), at(2));
  Object.defineProperty(items, 1, {
    get() {
      throw new Error("old history was rescanned");
    },
  });
  items.push(fact("thread_configuration_changed", 3));
  assert.equal(projection.read(items), at(2));
});

test("successful control closure without a complete final answer cannot bump Recent", () => {
  for (const tail of [
    [fact("turn_completed", 30, { status: "completed" })],
    [
      fact("agent_message", 10),
      fact("tool_call", 20),
      fact("turn_completed", 30, { status: "completed" }),
    ],
    [
      fact("agent_message", 10, { incomplete: true }),
      fact("turn_completed", 30, { status: "completed" }),
    ],
  ]) {
    assert.equal(
      new ThreadRecencyProjection().read([
        fact("thread_metadata", 1),
        fact("user_message", 2),
        ...tail,
      ]),
      at(2),
    );
  }
});

test("actual Thread snapshot replacement preserves suffix-only recency work", () => {
  const thread = new Thread(
    "thread",
    [
      fact("thread_metadata", 1),
      ...Array.from({ length: 10_000 }, (_, index) =>
        fact("user_message", index + 2),
      ),
    ],
    [],
  );
  const projection = new ThreadRecencyProjection();
  assert.equal(projection.read(thread.items), at(10_001));
  thread.append(fact("agent_message", 20_000), []);
  const snapshot = thread.items;
  let reads = 0;
  const observed = new Proxy(snapshot, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/u.test(key) && key !== "0") {
        assert.equal(
          Number(key),
          snapshot.length - 1,
          "old items must not be visited",
        );
        reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(projection.read(observed), at(10_001));
  assert.equal(reads, 1);
});
