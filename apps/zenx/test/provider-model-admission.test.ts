import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MODELS_PER_PROVIDER,
  appendProviderModelRows,
  remainingProviderModelSlots,
} from "../src/renderer/src/provider-model-admission.js";

test("Provider model admission keeps the real Host limit of 1,024", () => {
  assert.equal(MAX_MODELS_PER_PROVIDER, 1_024);
  for (const [count, remaining] of [
    [0, 1_024],
    [1_023, 1],
    [1_024, 0],
    [1_025, 0],
  ] as const) {
    assert.equal(remainingProviderModelSlots(count), remaining);
  }
});

test("discovered additions preserve existing rows and stop at the last available slot", () => {
  const current = Array.from({ length: 1_023 }, (_, index) => ({
    key: `existing-${index}`,
  }));
  const additions = [{ key: "first" }, { key: "second" }];
  const result = appendProviderModelRows(current, additions);
  assert.equal(result.length, 1_024);
  assert.deepEqual(result.slice(0, -1), current);
  assert.equal(result[0], current[0]);
  assert.equal(result.at(-1), additions[0]);
  assert.equal(current.length, 1_023);
  assert.equal(additions.length, 2);
});

test("manual additions cannot overfill an at-limit or already oversized draft", () => {
  for (const count of [1_024, 1_025]) {
    const current = Array.from({ length: count }, (_, index) => index);
    assert.equal(appendProviderModelRows(current, [9_999]), current);
  }
});

test("a stale discovery selection is bounded by the latest draft, including repeated adds", () => {
  const initial = Array.from({ length: 1_022 }, (_, index) => index);
  const afterManualAdd = appendProviderModelRows(initial, [2_000]);
  const afterDiscovery = appendProviderModelRows(
    afterManualAdd,
    [3_000, 4_000],
  );
  assert.equal(afterDiscovery.length, 1_024);
  assert.deepEqual(afterDiscovery.slice(-2), [2_000, 3_000]);
  assert.equal(
    appendProviderModelRows(afterDiscovery, [5_000]),
    afterDiscovery,
  );
});

test("an empty selection preserves the current draft", () => {
  const current = [{ key: "keep" }];
  assert.equal(appendProviderModelRows(current, []), current);
});
