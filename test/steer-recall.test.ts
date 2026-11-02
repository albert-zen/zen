import assert from "node:assert/strict";
import test from "node:test";
import { pendingQueuedMessages } from "../src/input-queue.js";
import { contextItemsFromLegacy } from "../src/item-list.js";
import { projectCompletedItem } from "../src/protocol/codex/mapper.js";
import {
  decodeCanonicalItem,
  type CanonicalItem,
  type QueuedUserMessageItem,
  type SteerRecalledItem,
} from "../src/item.js";
import {
  pendingSteerMessages as pending,
  recoverSteerRecall as recover,
  sameSteerRecallTargets as same,
} from "../src/steer-recall.js";

const createdAt = "2026-11-02T00:00:00.000Z";
function queued(id: string, text = id): QueuedUserMessageItem {
  return {
    id,
    type: "user_message_queued",
    threadId: "thread",
    createdAt,
    clientId: `client-${id}`,
    input: [{ type: "text", text }],
    deliveryMode: "steer",
    expectedTurnId: "turn",
  };
}
function recalled(items: readonly QueuedUserMessageItem[]): SteerRecalledItem {
  return {
    id: "recall-item",
    type: "user_message_steer_recalled",
    threadId: "thread",
    createdAt,
    recallId: "recall-op",
    targets: items.map((item) => ({
      queuedItemId: item.id,
      clientId: item.clientId,
      expectedRevision: 0,
    })),
  };
}

test("staged steer and recall are control facts, never model context", () => {
  const input = queued("one");
  const receipt = recalled([input]);
  for (const item of [input, receipt]) {
    assert.deepEqual(decodeCanonicalItem(item), item);
    assert.deepEqual(contextItemsFromLegacy(item), []);
    assert.equal(projectCompletedItem(item), null);
  }
  assert.throws(() =>
    decodeCanonicalItem({ ...input, expectedTurnId: undefined }),
  );
  assert.throws(() => decodeCanonicalItem({ ...input, turnId: "turn" }));
  assert.throws(() =>
    decodeCanonicalItem({ ...input, deliveryMode: "batch-next" }),
  );
  assert.throws(() => decodeCanonicalItem({ ...receipt, turnId: "turn" }));
});

test("recall decoder rejects empty, duplicate and invalid snapshots", () => {
  const receipt = recalled([queued("one")]);
  for (const targets of [
    [],
    [receipt.targets[0], receipt.targets[0]],
    [{ ...receipt.targets[0], expectedRevision: -1 }],
    [{ ...receipt.targets[0], expectedRevision: 0.5 }],
    [{ ...receipt.targets[0], clientId: "" }],
  ])
    assert.throws(() => decodeCanonicalItem({ ...receipt, targets }));
});

test("atomic projection removes exact snapshot and retains later arrivals", () => {
  const first = queued("first");
  const second = queued("second");
  const late = queued("late");
  const receipt = recalled([second, first]);
  const items = [first, second, receipt, late];
  assert.deepEqual(pending(items).map((item) => item.id), ["late"]);
  const result = recover(items, "thread", receipt.recallId);
  const ids = result?.messages.map((item) => item.id);
  assert.deepEqual(ids, ["first", "second"]);
  assert.equal(recover(items, "other-thread", receipt.recallId), undefined);
  assert.equal(recover(items, "thread", "unknown"), undefined);
  assert.equal(first.input[0]?.type, "text");
  assert.equal(items.length, 4);
});

test("one stale, wrong-source or claimed target never partially cancels a batch", () => {
  const first = queued("first");
  const second = queued("second");
  const receipt = recalled([first, second]);
  const changed = {
    ...receipt,
    targets: receipt.targets.map((target, index) => ({
      ...target,
      expectedRevision: index,
    })),
  };
  assert.equal(pending([first, second, changed]).length, 2);
  assert.equal(
    recover([first, second, changed], "thread", "recall-op"),
    undefined,
  );
  const { expectedTurnId: _boundTurn, ...unbound } = second;
  const ordinary: QueuedUserMessageItem = {
    ...unbound,
    deliveryMode: "batch-next",
  };
  assert.equal(pendingQueuedMessages([first, ordinary, receipt]).length, 2);
  const delivered: CanonicalItem = {
    id: "delivered",
    type: "user_message",
    threadId: "thread",
    turnId: "turn",
    createdAt,
    clientId: second.clientId,
    content: second.input,
  };
  assert.deepEqual(
    pending([first, second, delivered, receipt]).map((item) => item.id),
    ["first"],
  );
  assert.equal(
    recover([first, second, delivered, receipt], "thread", "recall-op"),
    undefined,
  );
});

test("recovery uses the pre-recall edit, not original or later hostile edits", () => {
  const first = queued("first", "original");
  const edited: CanonicalItem = {
    id: "edited",
    type: "user_message_queue_edited",
    threadId: "thread",
    createdAt,
    queuedItemId: first.id,
    clientId: first.clientId,
    editId: "edit",
    revision: 1,
    input: [{ type: "text", text: "latest structured input" }],
  };
  const receipt = recalled([first]);
  receipt.targets = receipt.targets.map((target) => ({
    ...target,
    expectedRevision: 1,
  }));
  const later = { ...edited, id: "later", revision: 2, input: first.input };
  const items = [first, edited, receipt, later];
  assert.deepEqual(
    recover(items, "thread", "recall-op")?.messages[0]?.input,
    edited.input,
  );
  assert.deepEqual(pending(items), []);
});

test("held projection never invents delivery after a terminal Turn", () => {
  const input = queued("one");
  const stopped: CanonicalItem = {
    id: "stopped",
    type: "turn_aborted",
    threadId: "thread",
    turnId: "turn",
    createdAt,
    reason: "stopped",
  };
  assert.deepEqual(pending([input, stopped]).map((item) => item.id), ["one"]);
  assert.deepEqual(contextItemsFromLegacy(input), []);
});

test("recall identity is order independent but exact and duplicate-safe", () => {
  const targets = recalled([queued("one"), queued("two")]).targets;
  assert.equal(same(targets, [...targets].reverse()), true);
  assert.equal(same(targets, [targets[0]!, targets[0]!]), false);
  assert.equal(
    same(
      targets,
      targets.map((target) => ({
        ...target,
        expectedRevision: target.expectedRevision + 1,
      })),
    ),
    false,
  );
});

test("all pending recall has no arbitrary row-count cap or chunked outcome", () => {
  const batch = Array.from({ length: 300 }, (_, index) =>
    queued(`many-${index}`),
  );
  const receipt = recalled(batch);
  assert.deepEqual(decodeCanonicalItem(receipt), receipt);
  const items = [...batch, receipt];
  assert.deepEqual(pending(items), []);
  const recovered = recover(items, "thread", receipt.recallId);
  assert.equal(recovered?.messages.length, 300);
});
