import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanonicalItem,
  type CanonicalItem,
  type QueuedUserMessageItem,
  type QueuedUserMessagePromotedItem,
  type QueuedMessagesReorderedItem,
} from "../src/item.js";
import { contextItemsFromLegacy } from "../src/item-list.js";
import { projectCompletedItem } from "../src/protocol/codex/mapper.js";
import { pendingQueuedMessages } from "../src/input-queue.js";
import {
  pendingSteerMessages,
  pendingNextTurnMessages,
  recoverSteerRecall,
} from "../src/steer-recall.js";

const base = { threadId: "thread", createdAt: "2026-11-08T00:00:00.000Z" };
const queued = (id: string): QueuedUserMessageItem => ({
  ...base,
  id,
  type: "user_message_queued",
  clientId: `client-${id}`,
  input: [{ type: "text", text: id }],
  deliveryMode: "batch-next",
});
const promotion = (id: string): QueuedUserMessagePromotedItem => ({
  ...base,
  id: `promote-${id}`,
  type: "user_message_queue_promoted",
  queuedItemId: id,
  clientId: `client-${id}`,
  expectedRevision: 0,
  expectedTurnId: "turn",
});
const reorder = (
  ids: readonly string[],
  order: readonly string[],
): QueuedMessagesReorderedItem => ({
  ...base,
  id: "reorder",
  type: "user_message_queue_reordered",
  reorderId: "op",
  expectedTargets: ids.map((id) => ({
    queuedItemId: id,
    clientId: `client-${id}`,
    expectedRevision: 0,
  })),
  orderedQueuedItemIds: order,
});

test("promotion and reorder are durable control facts, never semantic context or conversation items", () => {
  for (const item of [promotion("a"), reorder(["a", "b"], ["b", "a"])]) {
    assert.deepEqual(decodeCanonicalItem(item), item);
    assert.deepEqual(contextItemsFromLegacy(item), []);
    assert.equal(projectCompletedItem(item), null);
    assert.throws(() => decodeCanonicalItem({ ...item, turnId: "turn" }));
  }
});

test("control decoder rejects invalid identities, revisions, duplicate targets and incomplete permutations", () => {
  const promoted = promotion("a"),
    ordered = reorder(["a", "b"], ["b", "a"]);
  for (const patch of [
    { queuedItemId: "" },
    { clientId: "" },
    { expectedTurnId: "" },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => decodeCanonicalItem({ ...promoted, ...patch }));
  for (const patch of [
    { reorderId: "" },
    { expectedTargets: [] },
    {
      expectedTargets: [ordered.expectedTargets[0], ordered.expectedTargets[0]],
    },
    {
      expectedTargets: ordered.expectedTargets.map((target) => ({
        ...target,
        expectedRevision: -1,
      })),
    },
    { orderedQueuedItemIds: ["a"] },
    { orderedQueuedItemIds: ["a", "a"] },
    { orderedQueuedItemIds: ["a", "foreign"] },
  ])
    assert.throws(() => decodeCanonicalItem({ ...ordered, ...patch }));
});

test("promotion is ordered by admission into Steer, not the earlier Queue anchor", () => {
  const a = queued("a"),
    b = queued("b"),
    early: QueuedUserMessageItem = {
      ...queued("early"),
      deliveryMode: "steer",
      expectedTurnId: "turn",
    };
  const facts = [a, b, early, promotion("b"), promotion("a")];
  assert.deepEqual(
    pendingSteerMessages(facts).map((item) => item.id),
    ["early", "b", "a"],
  );
  assert.deepEqual(pendingNextTurnMessages(facts), []);
  assert.deepEqual(
    pendingSteerMessages(facts).map((item) => item.revision),
    [0, 1, 1],
  );
  const receipt: CanonicalItem = {
    ...base,
    id: "recall",
    type: "user_message_steer_recalled",
    recallId: "recall-op",
    targets: pendingSteerMessages(facts)
      .map((item) => ({
        queuedItemId: item.id,
        clientId: item.clientId,
        expectedRevision: item.revision,
      }))
      .reverse(),
  };
  assert.deepEqual(
    recoverSteerRecall(
      [...facts, receipt],
      "thread",
      "recall-op",
    )?.messages.map((item) => item.id),
    ["early", "b", "a"],
  );
  assert.deepEqual(pendingQueuedMessages([...facts, receipt]), []);
});

test("malformed or stale promotion cannot change input, resurrect settlement or skip revisions", () => {
  const a = queued("a"),
    promoted = promotion("a");
  for (const patch of [
    { threadId: "other" },
    { clientId: "other" },
    { expectedRevision: 1 },
  ])
    assert.deepEqual(pendingQueuedMessages([a, { ...promoted, ...patch }]), [
      { ...a, revision: 0 },
    ]);
  const delivered: CanonicalItem = {
    ...base,
    id: "delivery",
    type: "user_message",
    turnId: "turn",
    clientId: a.clientId,
    content: a.input,
  };
  assert.deepEqual(pendingQueuedMessages([a, delivered, promoted]), []);
  const cancelled: CanonicalItem = {
    ...base,
    id: "cancel",
    type: "user_message_queue_cancelled",
    queuedItemId: a.id,
    clientId: a.clientId,
  };
  assert.deepEqual(pendingQueuedMessages([a, cancelled, promoted]), []);
  assert.equal(pendingQueuedMessages([a, promoted, promoted])[0]?.revision, 1);
});

test("reorder applies one exact complete Queue snapshot and excludes pending Steer", () => {
  const a = queued("a"),
    b = queued("b"),
    steer: QueuedUserMessageItem = {
      ...queued("steer"),
      deliveryMode: "steer",
      expectedTurnId: "turn",
    };
  const order = reorder(["a", "b"], ["b", "a"]);
  const facts = [a, steer, b, order];
  assert.deepEqual(
    pendingNextTurnMessages(facts).map((item) => item.id),
    ["b", "a"],
  );
  assert.deepEqual(
    pendingSteerMessages(facts).map((item) => item.id),
    ["steer"],
  );
  for (const invalid of [
    { ...order, threadId: "other" },
    { ...order, expectedTargets: [...order.expectedTargets].reverse() },
    {
      ...order,
      expectedTargets: order.expectedTargets.map((target) => ({
        ...target,
        expectedRevision: 1,
      })),
    },
    { ...order, orderedQueuedItemIds: ["a", "a"] },
    reorder(["a", "b", "steer"], ["steer", "b", "a"]),
  ])
    assert.deepEqual(
      pendingQueuedMessages([a, steer, b, invalid]),
      pendingQueuedMessages([a, steer, b]),
    );
});
