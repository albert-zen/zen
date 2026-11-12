import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createZenXPluginHostSdk,
  JsonPluginStorage,
  withPluginStorageLease,
  type PluginStorageLease,
} from "../src/main/plugin-host-sdk.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-host-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    root,
    pluginId: "lease-test",
    version: 1,
    bindGeneration: true,
  };
  const storage = await JsonPluginStorage.open({
    ...options,
    initialValue: { marker: "original" },
  });
  const sdk = await createZenXPluginHostSdk({
    pluginId: options.pluginId,
    storageRoot: root,
    storageVersion: 1,
    storage,
    queryProjects: async () => [],
    appServer: {
      completeTurn: async () => {
        throw Error("unused");
      },
    },
  });
  return { options, storage, sdk };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("lease gate timed out")), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("Host facade maps to real storage, immutable lease expires and cannot mutate authority", async (t) => {
  const { options, storage, sdk } = await fixture(t);
  let captured!: PluginStorageLease;
  assert.equal("withLease" in sdk.storage, false);
  const result = await withPluginStorageLease(sdk.storage, async (lease) => {
    captured = lease;
    lease.assertCurrent();
    assert.equal(
      lease.filename,
      path.join(options.root, options.pluginId, "storage.json"),
    );
    assert.equal(lease.version, 1);
    assert.deepEqual(lease.value, { marker: "original" });
    (lease.value as Record<string, unknown>).marker = "not authority";
    return 42;
  });
  assert.equal(result, 42);
  assert.throws(() => captured.assertCurrent(), /expired/);
  assert.deepEqual(await storage.get(), { marker: "original" });
  await assert.rejects(
    withPluginStorageLease(
      {
        version: 1,
        get: async () => ({}),
        set: async () => {},
      },
      async () => undefined,
    ),
    /Host-created/,
  );
});

test("candidate lease survives its publish; old Host is rejected during and after replacement", async (t) => {
  const { options, sdk } = await fixture(t);
  const candidate = await JsonPluginStorage.prepare(options);
  await assert.rejects(
    withPluginStorageLease(sdk.storage, async () => undefined),
    /replacement/,
  );
  await withPluginStorageLease(candidate.storage, async (lease) => {
    lease.assertCurrent();
    candidate.publish();
    lease.assertCurrent();
  });
  await assert.rejects(
    withPluginStorageLease(sdk.storage, async () => undefined),
    /generation/,
  );
  await withPluginStorageLease(candidate.storage, async (lease) =>
    lease.assertCurrent(),
  );
});

test("throw and cooperative abort expire leases and release queue", async (t) => {
  const { storage } = await fixture(t);
  for (const abort of [false, true]) {
    let captured!: PluginStorageLease;
    const controller = new AbortController();
    await assert.rejects(
      withPluginStorageLease(storage, async (lease) => {
        captured = lease;
        if (abort) {
          controller.abort(Error("synthetic abort"));
          controller.signal.throwIfAborted();
        }
        throw Error("synthetic failure");
      }),
      /synthetic/,
    );
    assert.throws(() => captured.assertCurrent(), /expired/);
    await bounded(storage.set({ after: abort }));
  }
});

test("same-namespace callback reentry rejects promptly rather than deadlocking", async (t) => {
  const { options, storage, sdk } = await fixture(t);
  await bounded(
    withPluginStorageLease(storage, async () => {
      for (const operation of [
        () => sdk.storage.get(),
        () => sdk.storage.set({ changed: true }),
        () => storage.reload(),
        () => withPluginStorageLease(sdk.storage, async () => undefined),
        () => JsonPluginStorage.open(options),
        () => JsonPluginStorage.prepare(options),
      ])
        await assert.rejects(bounded<unknown>(operation()), /cannot reenter/);
    }),
  );
  assert.deepEqual(await storage.get(), { marker: "original" });
});

test("independent prepare queues behind active lease without invalidating it", async (t) => {
  const { options, storage } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  let captured!: PluginStorageLease;
  const running = withPluginStorageLease(storage, async (lease) => {
    captured = lease;
    entered.resolve();
    await bounded(release.promise);
    lease.assertCurrent();
  });
  await bounded(entered.promise);
  let prepared = false;
  const preparing = JsonPluginStorage.prepare(options).then((value) => {
    prepared = true;
    return value;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prepared, false);
    captured.assertCurrent();
  } finally {
    release.resolve();
  }
  await bounded(running);
  const candidate = await bounded(preparing);
  assert.equal(prepared, true);
  await candidate.rollback();
  assert.deepEqual(await storage.get(), { marker: "original" });
});

test("different namespaces nest normally while inherited outer namespace stays guarded", async (t) => {
  const { options, storage } = await fixture(t);
  const other = await JsonPluginStorage.open({
    ...options,
    pluginId: "other-lease",
  });
  await bounded(
    withPluginStorageLease(storage, async (outer) => {
      await withPluginStorageLease(other, async (inner) => {
        inner.assertCurrent();
        outer.assertCurrent();
        await assert.rejects(storage.get(), /cannot reenter/);
        await assert.rejects(other.get(), /cannot reenter/);
      });
      await other.set({ independent: true });
      outer.assertCurrent();
    }),
  );
  assert.deepEqual(await other.get(), { independent: true });
});

test("unbound Host storage lease still captures generation and expires across rollback", async (t) => {
  const { options, storage } = await fixture(t);
  const unbound = await JsonPluginStorage.open({
    ...options,
    bindGeneration: false,
  });
  let captured!: PluginStorageLease;
  await withPluginStorageLease(unbound, async (lease) => {
    captured = lease;
    lease.assertCurrent();
  });
  const candidate = await JsonPluginStorage.prepare(options);
  await candidate.rollback();
  assert.throws(() => captured.assertCurrent(), /expired/);
  await withPluginStorageLease(storage, async (lease) => lease.assertCurrent());
});

test("independent reads and writes queue, not globally reject during another task's lease", async (t) => {
  const { storage } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  const running = withPluginStorageLease(storage, async () => {
    entered.resolve();
    await bounded(release.promise);
  });
  await bounded(entered.promise);
  let written = false;
  const write = storage.set({ later: true }).then(() => {
    written = true;
  });
  const read = storage.get();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written, false);
  } finally {
    release.resolve();
  }
  await bounded(Promise.all([running, write]));
  assert.deepEqual(await bounded(read), { later: true });
});
