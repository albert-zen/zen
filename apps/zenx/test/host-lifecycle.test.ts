import assert from "node:assert/strict";
import test from "node:test";

import {
  ZenXBootstrapFence,
  ZenXHostLifecycle,
} from "../src/main/host-lifecycle.js";

for (const platform of ["darwin", "win32", "linux"] as const) {
  test(`${platform}: closing all windows preserves Host and activate recreates UI`, async () => {
    let windows = 1;
    let created = 0;
    let stopped = 0;
    let finished = 0;
    const lifecycle = new ZenXHostLifecycle({
      platform,
      windowCount: () => windows,
      createWindow: () => {
        windows += 1;
        created += 1;
      },
      stopHost: async () => {
        stopped += 1;
      },
      finishQuit: () => {
        finished += 1;
      },
    });

    windows = 0;
    lifecycle.windowAllClosed();
    assert.equal(stopped, 0);
    assert.equal(lifecycle.quitting, false);

    lifecycle.activate();
    assert.equal(created, 1);
    assert.equal(windows, 1);
    assert.equal(stopped, 0);

    let prevented = 0;
    lifecycle.beforeQuit(() => {
      prevented += 1;
    });
    await lifecycle.quitCompletion;
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
    assert.equal(finished, 1);

    lifecycle.beforeQuit(() => {
      prevented += 1;
    });
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
  });
}

test("activate does not recreate a window once explicit Quit begins", async () => {
  let created = 0;
  const release = deferred<void>();
  const lifecycle = new ZenXHostLifecycle({
    platform: "linux",
    windowCount: () => 0,
    createWindow: () => {
      created += 1;
    },
    stopHost: async () => await release.promise,
    finishQuit: () => undefined,
  });

  lifecycle.beforeQuit(() => undefined);
  lifecycle.activate();
  assert.equal(created, 0);
  release.resolve();
  await lifecycle.quitCompletion;
});

test("explicit Quit cancels and joins bootstrap before Host cleanup", async () => {
  const acquired = deferred<void>();
  const release = deferred<void>();
  const events: string[] = [];
  const bootstrapFence = new ZenXBootstrapFence();
  const lifecycle = new ZenXHostLifecycle({
    platform: "linux",
    windowCount: () => 0,
    createWindow: () => events.push("window"),
    cancelBootstrap: () => bootstrapFence.cancelAndJoin(),
    stopHost: async () => {
      events.push("stop");
    },
    finishQuit: () => events.push("quit"),
  });
  const bootstrap = bootstrapFence.run(async () => {
    events.push("acquire");
    acquired.resolve();
    await release.promise;
    bootstrapFence.throwIfCancelled();
    events.push("publish");
  });
  await acquired.promise;

  lifecycle.beforeQuit(() => undefined);
  release.resolve();
  await Promise.all([bootstrap, lifecycle.quitCompletion]);

  assert.deepEqual(events, ["acquire", "stop", "quit"]);
});

test("bootstrap cancelled before readiness never starts acquisition", async () => {
  const bootstrapFence = new ZenXBootstrapFence();
  await bootstrapFence.cancelAndJoin();
  let started = false;
  await bootstrapFence.run(async () => {
    started = true;
  });
  assert.equal(started, false);
});

test("a rejected bootstrap join cannot skip Host cleanup or finishing Quit", async () => {
  const bootstrapStarted = deferred<void>();
  const releaseBootstrap = deferred<void>();
  const bootstrapFailure = new Error("bootstrap cleanup rejected");
  const hostFailure = new Error("Host cleanup rejected");
  const reported: unknown[] = [];
  const events: string[] = [];
  const bootstrapFence = new ZenXBootstrapFence();
  const bootstrap = bootstrapFence.run(async () => {
    bootstrapStarted.resolve();
    await releaseBootstrap.promise;
    throw bootstrapFailure;
  });
  void bootstrap.catch(() => undefined);
  await bootstrapStarted.promise;
  const lifecycle = new ZenXHostLifecycle({
    platform: "linux",
    windowCount: () => 0,
    createWindow: () => events.push("window"),
    cancelBootstrap: () => bootstrapFence.cancelAndJoin(),
    stopHost: async () => {
      events.push("stop");
      throw hostFailure;
    },
    finishQuit: () => events.push("quit"),
    reportStopFailure: (error) => reported.push(error),
  });

  lifecycle.beforeQuit(() => events.push("prevent"));
  releaseBootstrap.resolve();
  await lifecycle.quitCompletion;

  assert.deepEqual(events, ["prevent", "stop", "quit"]);
  assert.equal(reported.length, 1);
  assert.ok(reported[0] instanceof AggregateError);
  assert.deepEqual(reported[0].errors, [bootstrapFailure, hostFailure]);
});

test("repeated Quit while bootstrap is running shares one join and one cleanup", async () => {
  const bootstrapStarted = deferred<void>();
  const releaseBootstrap = deferred<void>();
  const bootstrapFence = new ZenXBootstrapFence();
  const bootstrap = bootstrapFence.run(async () => {
    bootstrapStarted.resolve();
    await releaseBootstrap.promise;
    bootstrapFence.throwIfCancelled();
  });
  await bootstrapStarted.promise;
  let prevented = 0;
  let stopped = 0;
  let finished = 0;
  const lifecycle = new ZenXHostLifecycle({
    platform: "linux",
    windowCount: () => 0,
    createWindow: () => undefined,
    cancelBootstrap: () => bootstrapFence.cancelAndJoin(),
    stopHost: async () => {
      stopped += 1;
    },
    finishQuit: () => {
      finished += 1;
    },
  });

  lifecycle.beforeQuit(() => {
    prevented += 1;
  });
  lifecycle.beforeQuit(() => {
    prevented += 1;
  });
  releaseBootstrap.resolve();
  await Promise.all([bootstrap, lifecycle.quitCompletion]);

  assert.equal(prevented, 2);
  assert.equal(stopped, 1);
  assert.equal(finished, 1);
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
