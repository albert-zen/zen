import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../../../src/item.js";
import { cancellationResultsFromItems } from "../src/renderer/src/queue-cancel-state.js";

const stamp = new Date(10_000).toISOString();
const queued = (id: string, clientId: string): CanonicalItem => ({
  id,
  clientId,
  type: "user_message_queued",
  threadId: "thread-1",
  createdAt: stamp,
  input: [{ type: "text", text: "same text" }],
});

test("uncertain cancellation reads only stable journal IDs, never guesses pending", () => {
  const original = [
    queued("queued-1", "client-1"),
    queued("queued-2", "client-2"),
  ];
  const targets = [
    { queuedItemId: "queued-1", clientId: "client-1" },
    { queuedItemId: "queued-2", clientId: "client-2" },
  ];
  assert.equal(cancellationResultsFromItems(original, targets), null);
  const canceled: CanonicalItem = {
    id: "cancel-1",
    type: "user_message_queue_cancelled",
    threadId: "thread-1",
    createdAt: stamp,
    queuedItemId: "queued-1",
    clientId: "client-1",
  };
  assert.deepEqual(
    cancellationResultsFromItems([...original, canceled], [targets[0]!]),
    [{ ...targets[0], status: "already_cancelled" }],
  );
  assert.equal(
    cancellationResultsFromItems([...original, canceled], targets),
    null,
  );
  const accepted: CanonicalItem = {
    id: "user-2",
    type: "user_message",
    threadId: "thread-1",
    turnId: "turn-2",
    createdAt: stamp,
    clientId: "client-2",
    content: [{ type: "text", text: "same text" }],
  };
  assert.deepEqual(
    cancellationResultsFromItems([...original, canceled, accepted], targets),
    [
      { ...targets[0], status: "already_cancelled" },
      { ...targets[1], status: "already_started" },
    ],
  );
  assert.deepEqual(
    cancellationResultsFromItems(original, [
      { queuedItemId: "absent", clientId: "unknown" },
    ]),
    [{ queuedItemId: "absent", clientId: "unknown", status: "not_found" }],
  );
});
