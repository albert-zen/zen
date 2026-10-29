import assert from "node:assert/strict";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  link,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileTraceStore, type TraceEvent } from "../src/trace.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-trace-batch-synthetic-"),
  );
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
const event = (index: number): TraceEvent => ({
  threadId: "thread",
  turnId: "turn",
  sampleId: "sample",
  type: "synthetic",
  data: { index, text: "exact synthetic text\n中文" },
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("batch preserves independent frames, input snapshots and cold readable identities with bounded fsync groups", async (t) => {
  const { store, prototype } = await fixture(t);
  let fileSyncs = 0;
  const sync = prototype.sync;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if ((await this.stat()).isFile()) fileSyncs++;
    await sync.call(this);
  });
  const events = Array.from({ length: 600 }, (_, index) => event(index));
  const pending = store.recordBatch(events);
  (events[0]!.data as { text: string }).text = "changed after enqueue";
  const receipts = await pending;
  assert.equal(receipts.length, events.length);
  assert(receipts.every((receipt) => receipt.durability === "durable"));
  assert.equal(fileSyncs, 3, "256-record bound uses three durable flushes");
  const read = await new FileTraceStore(store.directory).read("thread");
  assert.equal(read.completeness, "complete");
  assert.equal(read.records.length, events.length);
  assert.equal(
    (read.records[0]!.data as { text: string }).text,
    "exact synthetic text\n中文",
  );
  assert.deepEqual(
    read.records.map((record) => record.sequence),
    Array.from({ length: 600 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    read.records.map((record) => record.id),
    receipts.map((receipt) => receipt.recordId),
  );
  assert.equal(new Set(read.records.map((record) => record.id)).size, 600);
  assert(
    read.records.every(
      (record) => record.clock.domain === read.records[0]!.clock.domain,
    ),
  );
  for (let index = 1; index < read.records.length; index++)
    assert(
      BigInt(read.records[index]!.clock.monotonicNs) >=
        BigInt(read.records[index - 1]!.clock.monotonicNs),
    );
});

test("batch byte bound splits large frames and permits one oversized frame without truncating text", async (t) => {
  const { store, prototype } = await fixture(t);
  let fileSyncs = 0;
  const sync = prototype.sync;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if ((await this.stat()).isFile()) fileSyncs++;
    await sync.call(this);
  });
  const texts = [
    "a".repeat(700_000),
    "b".repeat(700_000),
    "c".repeat(1_100_000),
    "tail",
  ];
  const receipts = await store.recordBatch(
    texts.map((text) => ({
      threadId: "thread",
      type: "large",
      data: { text },
    })),
  );
  assert(receipts.every((receipt) => receipt.durability === "durable"));
  assert.equal(fileSyncs, 4);
  assert.deepEqual(
    (await new FileTraceStore(store.directory).read("thread")).records.map(
      (record) => (record.data as { text: string }).text,
    ),
    texts,
  );
});

test("single and batch requests share the same ordered per-Thread publication queue", async (t) => {
  const { store } = await fixture(t);
  const first = store.record({ threadId: "thread", type: "first" });
  const middle = store.recordBatch([event(1), event(2)]);
  const last = store.record({ threadId: "thread", type: "last" });
  await Promise.all([first, middle, last]);
  const read = await new FileTraceStore(store.directory).read("thread");
  assert.deepEqual(
    read.records.map((record) => record.type),
    ["first", "synthetic", "synthetic", "last"],
  );
  assert.deepEqual(
    read.records.map((record) => record.sequence),
    [1, 2, 3, 4],
  );
});

test("malformed, mixed-Thread and artifact batch requests publish no data and never acknowledge success", async (t) => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const invalid of [
    { ...event(1), threadId: "different" },
    { ...event(1), type: "" },
    { ...event(1), artifacts: [{ name: "unsupported", bytes: "bytes" }] },
    { ...event(1), data: cycle },
  ]) {
    const { store } = await fixture(t);
    const receipts = await store.recordBatch([event(0), invalid]);
    assert.equal(receipts.length, 2);
    assert(receipts.every((receipt) => receipt.durability === "degraded"));
    assert.equal(
      (await new FileTraceStore(store.directory).read("thread")).records.length,
      0,
    );
  }
});

test("batch cannot resolve durable before the actual file sync finishes", async (t) => {
  const { store, prototype } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  const sync = prototype.sync;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if ((await this.stat()).isFile()) {
      entered.resolve();
      await release.promise;
    }
    await sync.call(this);
  });
  let settled = false;
  const pending = store.recordBatch([event(0), event(1)]).finally(() => {
    settled = true;
  });
  await entered.promise;
  assert.equal(settled, false);
  release.resolve();
  assert((await pending).every((receipt) => receipt.durability === "durable"));
});

test("file-sync failure leaves every batch receipt degraded even when complete frames are readable", async (t) => {
  const { store, prototype } = await fixture(t);
  const sync = prototype.sync;
  let fail = true;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if (fail && (await this.stat()).isFile())
      throw new Error("synthetic fsync failure");
    await sync.call(this);
  });
  const receipts = await store.recordBatch([event(0), event(1)]);
  assert(receipts.every((receipt) => receipt.durability === "degraded"));
  assert.equal(store.status().failedRecords, 2);
  fail = false;
  assert.equal(
    (await store.record({ threadId: "thread", type: "after-failure" }))
      .durability,
    "durable",
  );
  const read = await new FileTraceStore(store.directory).read("thread");
  assert(read.records.some((record) => record.type === "trace_capture_gap"));
  assert.equal(read.completeness, "incomplete");
});

test("torn batch writes preserve evidence, acknowledge no record and retire the damaged segment", async (t) => {
  const { store, prototype } = await fixture(t);
  const write = prototype.write;
  let fail = true;
  t.mock.method(
    prototype,
    "write",
    async function (
      this: FileHandle,
      bytes: Uint8Array,
      offset: number,
      length: number,
    ) {
      if (fail) {
        fail = false;
        const frame = Buffer.from(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        await Reflect.apply(write, this, [
          bytes,
          offset,
          Math.min(length, frame.indexOf(10) + 9),
        ]);
        throw new Error("synthetic partial batch write");
      }
      return await Reflect.apply(write, this, [bytes, offset, length]);
    },
  );
  const receipts = await store.recordBatch([event(0), event(1)]);
  assert(receipts.every((receipt) => receipt.durability === "degraded"));
  const directory = path.join(store.directory, "threads", "thread");
  const damaged = path.join(directory, (await readdir(directory))[0]!);
  const before = await readFile(damaged);
  assert.equal(
    (await store.record({ threadId: "thread", type: "after-torn-write" }))
      .durability,
    "durable",
  );
  assert.deepEqual(await readFile(damaged), before);
  assert.equal((await readdir(directory)).length, 2);
  const read = await new FileTraceStore(store.directory).read("thread");
  assert(read.issues.some((issue) => issue.kind === "partial_frame"));
  assert.equal(read.completeness, "incomplete");
  assert.equal(read.records.at(-1)!.type, "after-torn-write");
});

test("batch retains segment hard-link rejection after initialization", async (t) => {
  const { store, root } = await fixture(t);
  await store.record(event(0));
  const directory = path.join(store.directory, "threads", "thread");
  const segment = path.join(directory, (await readdir(directory))[0]!);
  await link(segment, path.join(root, "outside-alias"));
  const before = await readFile(segment);
  const receipts = await store.recordBatch([event(1), event(2)]);
  assert(receipts.every((receipt) => receipt.durability === "degraded"));
  assert.deepEqual(await readFile(segment), before);
});

test(
  "directory sync is part of the batch acknowledgement boundary",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, prototype } = await fixture(t);
    const entered = deferred(),
      release = deferred();
    let fileFlushed = false;
    const sync = prototype.sync;
    t.mock.method(prototype, "sync", async function (this: FileHandle) {
      const stat = await this.stat();
      if (stat.isDirectory() && fileFlushed) {
        entered.resolve();
        await release.promise;
      }
      await sync.call(this);
      if (stat.isFile()) fileFlushed = true;
    });
    let settled = false;
    const pending = store.recordBatch([event(0), event(1)]).finally(() => {
      settled = true;
    });
    await entered.promise;
    assert.equal(settled, false);
    release.resolve();
    const receipts = await pending;
    assert(
      receipts.every(
        (receipt) =>
          receipt.durability === "durable" &&
          receipt.sync === "file-and-directory",
      ),
    );
  },
);

test("failure in a later flush group never reports a partially successful batch", async (t) => {
  const { store, prototype } = await fixture(t);
  let fileSyncs = 0;
  const sync = prototype.sync;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if ((await this.stat()).isFile() && ++fileSyncs === 2)
      throw new Error("synthetic second-group fsync failure");
    await sync.call(this);
  });
  const receipts = await store.recordBatch(
    Array.from({ length: 300 }, (_, i) => event(i)),
  );
  assert.equal(receipts.length, 300);
  assert(receipts.every((receipt) => receipt.durability === "degraded"));
  assert.equal(fileSyncs, 2);
  assert.equal(store.status().failedRecords, 300);
});

test("batch failure accounting retains enqueue-time Thread identity after caller mutation", async (t) => {
  const { store, prototype } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  const sync = prototype.sync;
  let fail = true;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if (fail && (await this.stat()).isFile()) {
      entered.resolve();
      await release.promise;
      throw new Error("synthetic mutation-window fsync failure");
    }
    await sync.call(this);
  });
  const inputs = [event(0), event(1)];
  const pending = store.recordBatch(inputs);
  await entered.promise;
  for (const input of inputs) input.threadId = "unrelated";
  release.resolve();
  const receipts = await pending;
  assert(receipts.every((receipt) => receipt.durability === "degraded"));
  fail = false;
  await store.record({ threadId: "thread", type: "after-failure" });
  await store.record({ threadId: "unrelated", type: "independent" });
  const cold = new FileTraceStore(store.directory);
  const original = await cold.read("thread");
  const gap = original.records.find(
    (record) => record.type === "trace_capture_gap",
  );
  assert.ok(
    gap,
    "the original Thread must retain its failed publication evidence",
  );
  assert.equal((gap.data as { failedRecords: number }).failedRecords, 2);
  assert.equal(original.completeness, "incomplete");
  const unrelated = await cold.read("unrelated");
  assert.deepEqual(
    unrelated.records.map((record) => record.type),
    ["independent"],
  );
  assert.equal(unrelated.completeness, "complete");
});
