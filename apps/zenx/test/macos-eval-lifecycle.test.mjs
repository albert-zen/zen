import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluationDuration, pause } from "../scripts/macos-eval-lifecycle.mjs";
test("public evaluation duration rejects unbounded or invalid values", () => {
  for (const value of [
    "NaN",
    "Infinity",
    "-1",
    "300001",
    "1.5",
    "",
    " 1000",
    "999999999999999999999",
  ])
    assert.throws(() => evaluationDuration("duration", value, 300000));
  assert.equal(evaluationDuration("duration", "300000", 1), 300000);
  assert.equal(evaluationDuration("hold", "0", 1, true), 0);
  assert.throws(() => evaluationDuration("watch", "0", 1));
});
test("cancelled hold settles promptly rather than retaining a long timer", async () => {
  const controller = new AbortController();
  const waiting = pause(300000, controller.signal);
  controller.abort(new Error("deadline"));
  await assert.rejects(waiting, /deadline/);
});
