import assert from "node:assert/strict";
import test from "node:test";

import { ZenXTriggerGenerationQuiescence } from "../src/main/trigger-generation-quiescence.js";

test("retirement aborts immediately and detaches unresolved work at the deadline", async () => {
  const held = deferred<void>();
  const owner = new ZenXTriggerGenerationQuiescence({ deadlineMs: 10 });
  owner.track(held.promise);

  const startedAt = Date.now();
  await owner.retire();
  assert.equal(owner.signal.aborted, true);
  assert.equal(owner.isCurrent(), false);
  assert(Date.now() - startedAt < 250);
  held.resolve();
});

test("retirement cleanup and deadline timer faults are reported after fencing", async () => {
  const owner = new ZenXTriggerGenerationQuiescence({
    deadlineMs: 10,
    schedule: (callback) => {
      const handle = { callback };
      return handle;
    },
    cancelScheduled: () => {
      throw new Error("deadline cancellation failed");
    },
  });
  owner.track(Promise.resolve());
  owner.onRetire(() => {
    throw new Error("retirement hook failed");
  });

  await assert.rejects(
    async () => await owner.retire(),
    /retirement hook failed.*deadline cancellation failed/u,
  );
  assert.equal(owner.isCurrent(), false);
});

test("a throwing deadline scheduler detaches work and fails deterministically", async () => {
  const held = deferred<void>();
  const owner = new ZenXTriggerGenerationQuiescence({
    deadlineMs: 10,
    schedule: () => {
      throw new Error("deadline scheduling failed");
    },
  });
  owner.track(held.promise);
  await assert.rejects(async () => await owner.retire(), /scheduling failed/u);
  assert.equal(owner.isCurrent(), false);
  held.resolve();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
