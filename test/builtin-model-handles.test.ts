import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateBuiltinTaskBinding,
  resolveBuiltinTaskReference,
} from "../src/builtin-model-handles.js";
import {
  ModelReferenceRegistry,
  validateModelReferenceBindings,
  type ModelReferenceBinding,
} from "../src/model-references.js";

const ownerThreadId = "synthetic-thread";
const task = (
  overrides: Partial<Parameters<typeof allocateBuiltinTaskBinding>[0]> = {},
) =>
  allocateBuiltinTaskBinding({
    ownerThreadId,
    sourceToolCallId: "accepted-child-call",
    taskId: "native-task-uuid",
    history: [],
    occupied: [],
    ...overrides,
  });

test("task refs allocate synchronously above accepted and live bindings, even for the same source call", () => {
  const first = task();
  const second = task({ taskId: "another-native-task", occupied: [first] });
  assert.equal(first.ref, "t1");
  assert.equal(second.ref, "t2");
  assert.equal(
    resolveBuiltinTaskReference(ownerThreadId, "t1", [first, second]),
    "native-task-uuid",
  );
  assert.equal(
    resolveBuiltinTaskReference(ownerThreadId, "t2", [first, second]),
    "another-native-task",
  );
  assert.deepEqual(task({ history: [first], occupied: [second] }), first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.value), true);
  const fork = task({
    ownerThreadId: "fork",
    taskId: "new-host-task",
    history: [first, second],
  });
  assert.equal(fork.ref, "t3");
  assert.throws(
    () => resolveBuiltinTaskReference("fork", "t1", [first, fork]),
    /unavailable/u,
  );
});

test("short reference families cannot consume plugin or selected-reference allocation slots", () => {
  // Historic compaction bindings remain readable but are never published anew.
  const c: ModelReferenceBinding = {
    ref: "c1",
    ownerThreadId,
    namespace: "builtin-compaction",
    kind: "item",
    value: { itemId: "archived-item" },
  };
  const t = task();
  const s: ModelReferenceBinding = {
    ref: "s99",
    ownerThreadId,
    namespace: "selected-reference",
    kind: "thread",
    value: { id: "selected-id" },
  };
  const scope = new ModelReferenceRegistry().scope(ownerThreadId, [c, t, s]);
  assert.equal(scope.bind("plugin", "page", { id: "native-page" }), "r1");
  assert.equal(
    task({ taskId: "next", history: [c, t, s, ...scope.newBindings] }).ref,
    "t2",
  );
  for (const ref of ["c0", "t01", "c9007199254740992", "t-1", "z1"])
    assert.throws(
      () => validateModelReferenceBindings([{ ...t, ref }]),
      /Invalid/u,
    );
});

test("conflicting provenance, wrong typed task identity and missing accepted sources never retarget", () => {
  const first = task();
  assert.throws(
    () =>
      task({
        history: [
          first,
          {
            ...first,
            value: {
              taskId: "replacement",
              sourceToolCallId: "accepted-child-call",
            },
          },
        ],
      }),
    /Conflicting/u,
  );
  for (const altered of [
    { ...first, namespace: "plugin" },
    { ...first, kind: "page" },
    { ...first, epoch: "different" },
    { ...first, value: { taskId: "native-task-uuid" } },
    {
      ...first,
      value: {
        taskId: "native-task-uuid",
        sourceToolCallId: "accepted",
        extra: true,
      },
    },
  ])
    assert.throws(
      () => resolveBuiltinTaskReference(ownerThreadId, "t1", [altered]),
      /unavailable/u,
    );
  assert.throws(
    () => resolveBuiltinTaskReference(ownerThreadId, "t1", []),
    /unavailable/u,
  );
  assert.throws(() => task({ sourceToolCallId: "" }), /unavailable/u);
});
