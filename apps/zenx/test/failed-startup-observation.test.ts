import assert from "node:assert/strict";
import test from "node:test";
import { createFailedStartupObserver } from "./fixtures/failed-startup-observation.js";

test("successful or disabled acceptance performs no diagnostic observation", async () => {
  const observe = () => {
    throw new Error("must not observe");
  };
  const enabled = createFailedStartupObserver({ enabled: true });
  assert.equal(await enabled("success", async () => 7, observe), 7);
  const failure = new Error("original five-second failure");
  const disabled = createFailedStartupObserver({ enabled: false });
  await assert.rejects(
    disabled(
      "disabled",
      async () => {
        throw failure;
      },
      observe,
    ),
    (e) => e === failure,
  );
});

test("late readiness preserves the original failure and reports elapsed time", async () => {
  let now = 0;
  const logs: string[] = [];
  const run = createFailedStartupObserver({
    enabled: true,
    budgetMs: 10000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: (line) => logs.push(line),
  });
  const failure = new Error("original timeout");
  await assert.rejects(
    run(
      "prompt",
      async () => {
        now = 5000;
        throw failure;
      },
      () => ({ ready: now >= 7000, status: "running" }),
    ),
    (e) => e === failure,
  );
  assert.equal(now, 7000);
  assert.match(logs.at(-1)!, /"elapsedMs":7000/);
  assert.match(logs.at(-1)!, /ready_after_failure/);
});

test("diagnostic allowance is shared and read failure cannot replace acceptance failure", async () => {
  let now = 0;
  const logs: string[] = [];
  const run = createFailedStartupObserver({
    enabled: true,
    budgetMs: 2000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: (line) => logs.push(line),
  });
  const failure = new Error("original timeout");
  const fail = async () => {
    now += 5000;
    throw failure;
  };
  await assert.rejects(
    run("first", fail, () => ({ ready: false })),
    (e) => e === failure,
  );
  assert.equal(now, 7000);
  await assert.rejects(
    run("second", fail, () => ({ ready: false })),
    (e) => e === failure,
  );
  assert.equal(now, 12000);
  assert.match(logs.at(-1)!, /observation_deadline/);
  await assert.rejects(
    run("read error", fail, () => {
      throw new Error("read failed");
    }),
    (e) => e === failure,
  );
  assert.match(logs.at(-1)!, /observationError/);
});

test("diagnostic logging failure cannot replace the original acceptance error", async () => {
  const failure = new Error("original failure");
  const run = createFailedStartupObserver({
    enabled: true,
    budgetMs: 0,
    log: () => {
      throw new Error("log failed");
    },
  });
  await assert.rejects(
    run(
      "log error",
      async () => {
        throw failure;
      },
      () => ({ ready: false }),
    ),
    (e) => e === failure,
  );
});
