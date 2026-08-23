import assert from "node:assert/strict";
import test from "node:test";

import { ZenXHostLifecycle } from "../src/main/host-lifecycle.js";

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
