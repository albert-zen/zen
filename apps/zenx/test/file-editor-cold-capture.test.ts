import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const { observeColdCapture } = createRequire(import.meta.url)(
  "../scripts/file-editor-cold-capture.cjs",
);

test("cold follow-up preserves original evidence and observes both sides of two frames in order", async () => {
  const original = Object.freeze({ status: "failed", png: "original.png" });
  const calls: string[] = [];
  let count = 0;
  const result = await observeColdCapture(
    async () => {
      calls.push(`read-${++count}`);
      return { url: "file:///owned-fixture", markerVisible: count === 1 };
    },
    async () => {
      calls.push("two-frames");
    },
    async () => {
      calls.push("second-png");
    },
  );
  assert.deepEqual(calls, ["read-1", "two-frames", "read-2", "second-png"]);
  assert.equal(result.status, "complete");
  assert.equal(result.immediatelyAfterOriginal.markerVisible, true);
  assert.equal(
    result.afterTwoFrames.markerVisible,
    false,
    "Rollback is retained",
  );
  assert.deepEqual(original, { status: "failed", png: "original.png" });
});

test("diagnostic failures retain their own phase evidence without replacing the original verdict", async () => {
  for (const failAt of [1, 2, 3, 4]) {
    const original = Object.freeze({ status: "passed", png: "original.png" });
    let step = 0;
    const operation = async () => {
      if (++step === failAt) throw new Error(`diagnostic step ${step}`);
      return { markerVisible: true };
    };
    const result = await observeColdCapture(operation, operation, operation);
    assert.equal(result.status, "failed");
    assert.match(result.failure, new RegExp(`diagnostic step ${failAt}`, "u"));
    assert.equal(step, failAt, "No later diagnostic action after failure");
    assert.equal(!!result.immediatelyAfterOriginal, failAt > 1);
    assert.equal(!!result.afterTwoFrames, failAt > 3);
    assert.deepEqual(original, { status: "passed", png: "original.png" });
  }
});
