import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileTraceStore } from "../src/trace.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-dirs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = await open(path.join(root, "prototype"), "wx");
  const prototype = Object.getPrototypeOf(file) as FileHandle;
  await file.close();
  return {
    root,
    prototype,
    store: new FileTraceStore(path.join(root, "trace")),
  };
}

const event = (threadId = "thread") => ({ threadId, type: "synthetic" });

test("warm Trace keeps data and thread syncs without repeating ancestor syncs", async (t) => {
  const { store, prototype } = await fixture(t);
  const sync = prototype.sync;
  const calls: string[] = [];
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    calls.push((await this.stat()).isDirectory() ? "directory" : "file");
    await sync.call(this);
  });
  const initial =
    process.platform === "win32"
      ? ["file"]
      : ["directory", "directory", "directory", "file", "directory"];
  const warm = process.platform === "win32" ? ["file"] : ["file", "directory"];
  assert.equal((await store.record(event())).durability, "durable");
  assert.deepEqual(calls.splice(0), initial);
  assert.equal((await store.record(event())).durability, "durable");
  assert.deepEqual(calls.splice(0), warm);
  assert.equal((await store.record(event("another"))).durability, "durable");
  assert.deepEqual(calls.splice(0), initial);
  const cold = new FileTraceStore(store.directory);
  assert.equal((await cold.record(event())).durability, "durable");
  assert.deepEqual(calls.splice(0), initial);
  const read = await cold.read("thread");
  assert.equal(read.completeness, "complete");
  assert.deepEqual(
    read.records.map((record) => record.sequence),
    [1, 2, 3],
  );
  t.diagnostic(JSON.stringify({ initial, warm }));
});

for (const mutation of ["rename", "delete"] as const) {
  test(`directory ${mutation}/recreation cannot reuse old initialization`, async (t) => {
    const { root, store, prototype } = await fixture(t);
    await store.record(event());
    const artifacts = path.join(store.directory, "artifacts");
    if (mutation === "rename") await rename(artifacts, path.join(root, "old"));
    else await rm(artifacts, { recursive: true });
    // Leave creation to the real initialization path, including the inode-reuse case.
    let directories = 0;
    let files = 0;
    const sync = prototype.sync;
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      if ((await this.stat()).isDirectory()) directories++;
      else files++;
      await sync.call(this);
    });
    assert.equal((await store.record(event())).durability, "durable");
    assert.equal(directories, process.platform === "win32" ? 0 : 4);
    assert.equal(files, 1);
    assert.equal((await store.read("thread")).records.length, 2);
  });
}

test("a preexisting replacement directory also requires initialization sync", async (t) => {
  const { root, store, prototype } = await fixture(t);
  await store.record(event());
  const artifacts = path.join(store.directory, "artifacts");
  await rename(artifacts, path.join(root, "old"));
  await mkdir(artifacts);
  let directories = 0;
  const sync = prototype.sync;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if ((await this.stat()).isDirectory()) directories++;
    await sync.call(this);
  });
  assert.equal((await store.record(event())).durability, "durable");
  assert.equal(directories, process.platform === "win32" ? 0 : 4);
});

test(
  "a warmed writer still rejects a directory alias",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, store } = await fixture(t);
    await store.record(event());
    const artifacts = path.join(store.directory, "artifacts");
    const outside = path.join(root, "outside");
    await rename(artifacts, outside);
    await symlink(outside, artifacts, "dir");
    assert.equal((await store.record(event())).durability, "degraded");
  },
);

test(
  "failed ancestor sync never installs successful initialization",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, prototype } = await fixture(t);
    const sync = prototype.sync;
    let fail = true;
    const calls: string[] = [];
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      const directory = (await this.stat()).isDirectory();
      calls.push(directory ? "directory" : "file");
      if (fail && directory) throw new Error("Synthetic ancestor sync failure");
      await sync.call(this);
    });
    assert.equal((await store.record(event())).durability, "degraded");
    calls.length = 0;
    fail = false;
    assert.equal((await store.record(event())).durability, "durable");
    assert.deepEqual(calls.slice(0, 3), [
      "directory",
      "directory",
      "directory",
    ]);
    assert.equal(calls.filter((kind) => kind === "file").length, 2);
    assert.equal(calls.filter((kind) => kind === "directory").length, 5);
    const read = await store.read("thread");
    assert.deepEqual(
      read.records.map((record) => record.type),
      ["trace_capture_gap", "synthetic"],
    );
  },
);

test(
  "warm receipt still waits for the final thread directory sync",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, prototype } = await fixture(t);
    await store.record(event());
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sync = prototype.sync;
    let dataSynced = false;
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      const directory = (await this.stat()).isDirectory();
      if (directory) {
        assert.equal(dataSynced, true);
        entered();
        await gate;
      }
      await sync.call(this);
      if (!directory) dataSynced = true;
    });
    let settled = false;
    const pending = store.record(event()).finally(() => {
      settled = true;
    });
    try {
      await reached;
      assert.equal(settled, false);
      release();
      const receipt = await pending;
      assert.equal(receipt.durability, "durable");
      if (receipt.durability === "durable")
        assert.equal(receipt.sync, "file-and-directory");
    } finally {
      release();
      await pending;
    }
  },
);

test(
  "restored private permissions repeat initialization durability",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, prototype } = await fixture(t);
    await store.record(event());
    await chmod(store.directory, 0o755);
    let directories = 0;
    const sync = prototype.sync;
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      if ((await this.stat()).isDirectory()) directories++;
      await sync.call(this);
    });
    assert.equal((await store.record(event())).durability, "durable");
    assert.equal(directories, 4);
  },
);

test(
  "failed warm permission restoration retires the prior initialization proof",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, prototype } = await fixture(t);
    await store.record(event());
    await chmod(store.directory, 0o755);
    const sync = prototype.sync;
    let fail = true;
    const calls: string[] = [];
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      const directory = (await this.stat()).isDirectory();
      calls.push(directory ? "directory" : "file");
      if (fail && directory)
        throw new Error("Synthetic warm ancestor sync failure");
      await sync.call(this);
    });
    assert.equal((await store.record(event())).durability, "degraded");
    calls.length = 0;
    fail = false;
    assert.equal((await store.record(event())).durability, "durable");
    assert.deepEqual(calls.slice(0, 3), [
      "directory",
      "directory",
      "directory",
    ]);
    assert.equal(calls.filter((kind) => kind === "file").length, 2);
    assert.equal(calls.filter((kind) => kind === "directory").length, 5);
  },
);

test(
  "shared ancestor repair failure invalidates other warm threads",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, prototype } = await fixture(t);
    await store.record(event("a"));
    await store.record(event("b"));
    await store.record(event("a"));
    await store.record(event("b"));
    await chmod(store.directory, 0o755);
    const sync = prototype.sync;
    let fail = true;
    const calls: string[] = [];
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      const directory = (await this.stat()).isDirectory();
      calls.push(directory ? "directory" : "file");
      if (fail && directory) throw new Error("Shared ancestor failure");
      await sync.call(this);
    });
    assert.equal((await store.record(event("a"))).durability, "degraded");
    fail = false;
    calls.length = 0;
    assert.equal((await store.record(event("b"))).durability, "durable");
    assert.deepEqual(calls, [
      "directory",
      "directory",
      "directory",
      "file",
      "directory",
    ]);
  },
);

test(
  "an overlapping initializer cannot retain a proof across another thread's failed repair",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, prototype } = await fixture(t);
    await store.record(event("a"));
    await store.record(event("b"));
    await store.record(event("a"));
    await store.record(event("b"));
    await chmod(store.directory, 0o755);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sync = prototype.sync;
    const calls: string[] = [];
    let failFirst = true;
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      const directory = (await this.stat()).isDirectory();
      calls.push(directory ? "directory" : "file");
      if (directory && failFirst) {
        failFirst = false;
        entered();
        await gate;
        throw new Error("Shared gated ancestor failure");
      }
      await sync.call(this);
    });
    const first = store.record(event("a"));
    await reached;
    const second = store.record(event("b"));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ["directory"]);
      release();
      assert.equal((await first).durability, "degraded");
      assert.equal((await second).durability, "durable");
      assert.deepEqual(calls, [
        "directory",
        "directory",
        "directory",
        "directory",
        "file",
        "directory",
      ]);
    } finally {
      release();
      await Promise.all([first, second]);
    }
  },
);
