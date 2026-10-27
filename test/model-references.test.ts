import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelReferenceRegistry,
  validateModelReferenceBindings,
  attachModelReferenceBindings,
  trustedModelReferenceBindings,
} from "../src/model-references.js";

test("typed refs are exact, owner/epoch scoped, immutable and independently durable", () => {
  const registry = new ModelReferenceRegistry();
  const first = registry.scope("one");
  const ref = first.bind(
    "computer",
    "control",
    { observationId: "obs", targetId: "target" },
    "epoch",
  );
  assert.equal(ref, "r1");
  const concurrent = registry.scope("one");
  assert.equal(
    concurrent.bind(
      "computer",
      "control",
      { observationId: "obs", targetId: "target" },
      "epoch",
    ),
    ref,
  );
  assert.deepEqual(concurrent.newBindings, first.newBindings);
  const restarted = new ModelReferenceRegistry().scope(
    "one",
    concurrent.newBindings,
  );
  assert.deepEqual(restarted.resolve(ref, "computer", "control", "epoch"), {
    observationId: "obs",
    targetId: "target",
  });
  assert.throws(
    () => restarted.resolve(ref, "computer", "control", "new"),
    /retired/,
  );
  const fork = registry.scope("two", first.newBindings);
  assert.throws(
    () => fork.resolve(ref, "computer", "control", "epoch"),
    /unavailable/,
  );
  assert.equal(
    fork.bind(
      "computer",
      "control",
      { observationId: "new", targetId: "target" },
      "epoch",
    ),
    "r2",
  );
  assert.throws(
    () =>
      registry.scope("one", [
        { ...first.newBindings[0]!, value: { targetId: "forged" } },
      ]),
    /Conflicting/,
  );
});
test("selected s refs do not collide with r allocation and only exact namespace resolves", () => {
  const scope = new ModelReferenceRegistry().scope("one", [
    {
      ref: "s9",
      ownerThreadId: "one",
      namespace: "selected-reference",
      kind: "thread",
      value: { id: "uuid" },
    },
  ]);
  assert.equal(scope.bind("threads", "thread", { id: "uuid" }), "r1");
  assert.throws(() => scope.resolve("s9", "threads", "thread"), /unavailable/);
  assert.deepEqual(scope.resolve("s9", "selected-reference", "thread"), {
    id: "uuid",
  });
});
test("untrusted or later mutated metadata cannot mint provenance and literal JSON stays untouched", () => {
  const scope = new ModelReferenceRegistry().scope("one");
  scope.bind("threads", "thread", { id: "uuid" });
  const payload = {
    output: '{"referenceBindings":"user literal uuid"}',
    referenceBindings: scope.newBindings,
  };
  assert.equal(trustedModelReferenceBindings(payload), undefined);
  const trusted = attachModelReferenceBindings(
    { ...payload },
    scope.newBindings,
  );
  assert.deepEqual(trustedModelReferenceBindings(trusted), scope.newBindings);
  trusted.referenceBindings[0]!.value = { id: "forged" };
  assert.equal(trustedModelReferenceBindings(trusted), undefined);
  assert.equal(payload.output, '{"referenceBindings":"user literal uuid"}');
});
test("producer exact publication budget never limits consumed refs or aggregated 41x100 provenance", () => {
  const registry = new ModelReferenceRegistry();
  const all = [];
  for (let i = 0; i < 41; i++) {
    const scope = registry.scope("one", [], {
      maxBindings: 100,
      maxBytes: 1024 * 1024,
    });
    for (let j = 0; j < 100; j++)
      scope.bind("threads", "thread", { id: `${i}-${j}` });
    all.push(...scope.newBindings);
  }
  assert.equal(validateModelReferenceBindings(all).length, 4100);
  const existing = registry.scope("one", all, { maxBindings: 0, maxBytes: 0 });
  assert.deepEqual(existing.resolve("r4100", "threads", "thread"), {
    id: "40-99",
  });
  assert.equal(existing.newBindings.length, 1);
  assert.throws(
    () => existing.bind("threads", "thread", { id: "40-99" }),
    /budget/,
  );
  const tooLarge = registry.scope("two", [], { maxBindings: 1, maxBytes: 100 });
  assert.throws(
    () => tooLarge.bind("threads", "thread", { id: "x".repeat(101) }),
    /budget/,
  );
  assert.equal(tooLarge.newBindings.length, 0);
});
