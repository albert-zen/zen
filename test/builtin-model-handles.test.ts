import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateBuiltinTaskBinding,
  builtinCompactionReferences,
  resolveBuiltinCompactionReference,
  resolveBuiltinTaskReference,
} from "../src/builtin-model-handles.js";
import { contextItemsFromLegacy, type ContextItem } from "../src/item-list.js";
import type { CanonicalItem } from "../src/item.js";
import {
  ModelReferenceRegistry,
  validateModelReferenceBindings,
  type ModelReferenceBinding,
} from "../src/model-references.js";

const ownerThreadId = "synthetic-thread";
function message(id: string, sequence = 2): ContextItem {
  return contextItemsFromLegacy(
    {
      id,
      threadId: ownerThreadId,
      turnId: "turn",
      createdAt: "2026-10-27T00:00:00Z",
      type: "user_message",
      text: "Literal 12345678-1234-1234-1234-123456789abc /tmp/code.ts c1 t1; never rewrite.",
    },
    [],
    sequence,
  )[0]!;
}
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

test("compaction refs are dense exact-source projections, including multiple eligible Items with one source ordinal", () => {
  const sources = [message("source-one"), message("source-two")];
  const original = structuredClone(sources);
  const first = builtinCompactionReferences({
    ownerThreadId,
    sources,
    history: [],
  });
  assert.deepEqual(
    first.referenceBindings.map((entry) => entry.ref),
    ["c1", "c2"],
  );
  assert.match(first.text, /c1 user message; c2 user message/u);
  assert.match(first.text, /optional retention references/u);
  assert.match(
    first.text,
    /not a compaction event; no context was changed by this list/u,
  );
  assert.doesNotMatch(
    first.text,
    /source-one|source-two|12345678|synthetic-thread/u,
  );
  assert.deepEqual(
    sources,
    original,
    "literal text, code, paths and API identities remain exact",
  );
  for (const [index, ref] of ["c1", "c2"].entries())
    assert.equal(
      resolveBuiltinCompactionReference({
        ownerThreadId,
        ref,
        history: first.referenceBindings,
        sources,
      }),
      sources[index]!.id,
    );
  assert.deepEqual(
    builtinCompactionReferences({
      ownerThreadId,
      sources: [...sources].reverse(),
      history: first.referenceBindings,
    }).referenceBindings.map((entry) => entry.ref),
    ["c2", "c1"],
  );
  assert.equal(Object.isFrozen(first.referenceBindings[0]), true);
  assert.equal(Object.isFrozen(first.referenceBindings[0]!.value), true);
});

test("real canonical bridge selects only actual eligible context, not supplemental, nested, imported or hidden sources", () => {
  const base = {
    id: "call-item",
    threadId: ownerThreadId,
    turnId: "turn",
    createdAt: "2026-10-27T00:00:00Z",
  };
  const call: CanonicalItem = {
    ...base,
    type: "tool_call",
    callId: "required-provider-call-id",
    name: "shell",
    arguments: { command: "echo unchanged" },
  };
  const visible = contextItemsFromLegacy(call, [], 4);
  const nested = contextItemsFromLegacy(
    { ...call, id: "nested", parentCallId: call.callId },
    [call],
    5,
  );
  assert.equal(
    nested.length,
    0,
    "nested execution facts do not acquire fake semantic Items",
  );
  const supplemental: ContextItem = {
    ...message("notice"),
    source: { kind: "context_notice", sequence: 4 },
  };
  const imported: ContextItem = {
    ...visible[0]!,
    id: "imported",
    source: { kind: "tool_call", sequence: 4, metadata: { imported: {} } },
  };
  const hidden: ContextItem = {
    ...message("reasoning"),
    kind: "reasoning",
    role: "assistant",
    source: { kind: "reasoning", sequence: 4 },
    content: { text: "hidden", visibility: "opaque" },
  };
  const result = builtinCompactionReferences({
    ownerThreadId,
    sources: [...visible, supplemental, imported, hidden],
    history: [],
  });
  assert.equal(result.referenceBindings.length, 1);
  assert.match(result.text, /c1 tool call/u);
  assert.equal(
    visible[0]!.kind === "tool_call" && visible[0]!.content.callId,
    "required-provider-call-id",
  );
});

test("compaction resolves only disclosed exact current sources; removed, foreign and wrong-kind refs fail closed", () => {
  const source = message("accepted-item");
  const { referenceBindings: history } = builtinCompactionReferences({
    ownerThreadId,
    sources: [source],
    history: [],
  });
  for (const options of [
    { ownerThreadId, ref: "c1", sources: [] },
    { ownerThreadId, ref: "c1", sources: [message("different-item")] },
    {
      ownerThreadId: "fork",
      ref: "c1",
      sources: [{ ...source, threadId: "fork" }],
    },
    { ownerThreadId, ref: "accepted-item", sources: [source] },
    { ownerThreadId, ref: "t1", sources: [source] },
  ])
    assert.throws(
      () => resolveBuiltinCompactionReference({ ...options, history }),
      /unavailable/u,
    );
  const fork = builtinCompactionReferences({
    ownerThreadId: "fork",
    sources: [{ ...source, threadId: "fork" }],
    history,
  });
  assert.equal(fork.referenceBindings[0]!.ref, "c2");
  assert.equal(
    resolveBuiltinCompactionReference({
      ownerThreadId: "fork",
      ref: "c2",
      sources: [{ ...source, threadId: "fork" }],
      history: fork.referenceBindings,
    }),
    source.id,
  );
});

test("producer publication budget does not become an aggregate history cap", () => {
  const source = message("one");
  const prior = builtinCompactionReferences({
    ownerThreadId,
    sources: [source],
    history: [],
  }).referenceBindings;
  const history = Array.from({ length: 5000 }, () => prior[0]!);
  assert.equal(
    builtinCompactionReferences({ ownerThreadId, sources: [source], history })
      .referenceBindings.length,
    1,
  );
  assert.throws(
    () =>
      builtinCompactionReferences({
        ownerThreadId,
        sources: [source, message("two")],
        history,
        budget: { maxBindings: 1, maxBytes: 1024 * 1024 },
      }),
    /publication budget/u,
  );
  assert.throws(
    () =>
      builtinCompactionReferences({
        ownerThreadId,
        sources: [source],
        history,
        budget: { maxBindings: 4096, maxBytes: 1 },
      }),
    /publication budget/u,
  );
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
  const c = builtinCompactionReferences({
    ownerThreadId,
    sources: [message("item")],
    history: [],
  }).referenceBindings[0]!;
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
  assert.equal(
    builtinCompactionReferences({
      ownerThreadId,
      sources: [message("next")],
      history: [c, t, s, ...scope.newBindings],
    }).referenceBindings[0]!.ref,
    "c2",
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
