import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalItem,
  FailureItem,
  TurnRecovery,
} from "../../../src/item.js";
import { indexTurnOutcomeItems } from "../src/renderer/src/turn-outcome-index.js";

const recovery: TurnRecovery = {
  attempt: 1,
  sampleAttempt: 1,
  phase: "model",
  contextBoundaryItemId: "boundary",
  fingerprint: "synthetic",
  consecutiveFailures: 1,
  withheldMedia: [],
};
function failure(
  id: string,
  turnId: string,
  extra: Partial<FailureItem> = {},
): FailureItem {
  return {
    id,
    threadId: "synthetic-thread",
    turnId,
    type: "failure",
    createdAt: "2026-01-01T00:00:00.000Z",
    code: "runtime_error",
    message: id,
    ...extra,
  };
}

test("outcome lookup exactly preserves some/findLast semantics and item identity", () => {
  const first = failure("first", "one", {
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  const last = failure("last-in-array", "one", {
    createdAt: "2025-01-01T00:00:00.000Z",
    diagnosticId: "synthetic-detail",
    retried: 2,
  });
  const items: readonly CanonicalItem[] = Object.freeze([
    Object.freeze(first),
    Object.freeze(failure("other", "two")),
    Object.freeze(last),
    Object.freeze(failure("recovering-after-last", "one", { recovery })),
    Object.freeze(failure("recovery-only", "three", { recovery })),
    Object.freeze({
      id: "aborted",
      threadId: "synthetic-thread",
      turnId: "two",
      type: "turn_aborted" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      reason: "user",
    }),
    Object.freeze({
      id: "completed",
      threadId: "synthetic-thread",
      turnId: "two",
      type: "turn_completed" as const,
      createdAt: "2026-01-01T00:00:01.000Z",
      status: "completed" as const,
    }),
  ]);
  // Every prefix covers absent entries, recovery-only and repeated terminal facts.
  for (let length = 0; length <= items.length; length++) {
    const prefix = Object.freeze(items.slice(0, length));
    const actual = indexTurnOutcomeItems(prefix);
    for (const turnId of ["one", "two", "three", "missing"]) {
      assert.equal(
        actual.abortedTurnIds.has(turnId),
        prefix.some(
          (item) => item.type === "turn_aborted" && item.turnId === turnId,
        ),
      );
      assert.equal(
        actual.latestFailureByTurn.get(turnId),
        prefix.findLast(
          (item) =>
            item.type === "failure" &&
            item.recovery === undefined &&
            item.turnId === turnId,
        ),
      );
    }
  }
  assert.equal(
    indexTurnOutcomeItems(items).latestFailureByTurn.get("one"),
    last,
  );
  assert.equal(indexTurnOutcomeItems(undefined).abortedTurnIds.size, 0);
  assert.equal(indexTurnOutcomeItems(undefined).latestFailureByTurn.size, 0);
});

test("outcome indexing visits each item once and per-turn lookups never rescan history", () => {
  for (const size of [100, 1000, 5000]) {
    let visits = 0;
    const source = Array.from({ length: size }, (_, i) =>
      failure(String(i), String(i)),
    );
    const counted = new Proxy(source, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) visits++;
        return Reflect.get(target, key, receiver);
      },
    });
    const index = indexTurnOutcomeItems(counted);
    assert.equal(visits, size);
    for (let i = 0; i < size; i++) {
      assert.equal(index.abortedTurnIds.has(String(i)), false);
      assert.equal(index.latestFailureByTurn.get(String(i)), source[i]);
    }
    assert.equal(visits, size);
  }
});
