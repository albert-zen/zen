import assert from "node:assert/strict";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileTraceStore, type TraceEvent, type OwnedTraceSourceSession, type OwnedTraceSourceScope } from "../src/trace.js";
import { StorageWriterOwnership } from "../src/storage-writer-ownership.js";
import { ThreadJournalAppendOutcomeUnknownError } from "../src/journal.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const event = (id: string, type = "runtime_item"): TraceEvent => ({
  threadId: "thread", type, data: { id, text: "exact synthetic source" },
});
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-source-fence-synthetic-"));
  const journal = path.join(root, "journal");
  const owner = new StorageWriterOwnership(journal);
  const trace = new FileTraceStore(path.join(root, "trace"));
  await trace.record(event("initial", "observation"));
  const other = new FileTraceStore(trace.directory);
  const file = await open(path.join(root, "prototype"), "wx");
  const prototype = Object.getPrototypeOf(file) as FileHandle;
  await file.close();
  const sessions: OwnedTraceSourceSession[] = [];
  const session = async () => {
    const value = await trace.openOwnedSources(owner, journal, "thread");
    sessions.push(value);
    return value;
  };
  t.after(async () => {
    await Promise.all(sessions.map((value) => value.close()));
    await Promise.all([trace.flush(), other.flush()]);
    owner.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, owner, journal, trace, other, prototype, session };
}

test("owned source scope serializes public cross-instance sources but not observations", async (t) => {
  const { trace, other, session } = await fixture(t);
  const owned = await session();
  const entered = deferred(), release = deferred();
  const pending = owned.run(async (scope) => {
    entered.resolve();
    await release.promise;
    assert.equal((await scope.appendSource(event("inside"))).durability, "durable");
  });
  await entered.promise;
  let publicDone = false;
  const input = event("public");
  const outside = other.record(input).then((value) => { publicDone = true; return value; });
  (input.data as { text: string }).text = "caller mutation";
  try {
    assert.equal((await trace.record(event("observation", "observation"))).durability, "durable");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(publicDone, false);
  } finally { release.resolve(); }
  await pending;
  assert.equal((await outside).durability, "durable");
  const records = (await trace.read("thread")).records;
  const publicRecord = records.find((record) => (record.data as { id?: string })?.id === "public");
  assert.equal((publicRecord!.data as { text: string }).text, "exact synthetic source");
});

test("public source already occupying Trace queue settles before owned registration without deadlock", async (t) => {
  const { other, prototype, session } = await fixture(t);
  const entered = deferred(), release = deferred();
  const sync = prototype.sync;
  let first = true;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if (first && (await this.stat()).isFile()) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    await sync.call(this);
  });
  const source = other.record(event("earlier"));
  await entered.promise;
  let registered = false;
  const registering = session().then((value) => { registered = true; return value; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(registered, false);
  } finally { release.resolve(); }
  assert.equal((await source).durability, "durable");
  const owned = await registering;
  await owned.run(async (scope) => {
    assert.equal((await scope.appendSource(event("later"))).durability, "durable");
  });
});

test("scope expiry, exact owner, Thread and source type are enforced", async (t) => {
  const { root, owner, journal, trace, session } = await fixture(t);
  await assert.rejects(trace.openOwnedSources({} as StorageWriterOwnership, journal, "thread"));
  await assert.rejects(trace.openOwnedSources(owner, root, "thread"), /namespace/);
  const owned = await session();
  let escaped!: OwnedTraceSourceScope;
  await owned.run(async (scope) => {
    escaped = scope;
    assert.throws(() => scope.appendSource({ ...event("wrong"), threadId: "other" }), /exact Thread/);
    assert.throws(() => scope.appendSource(event("wrong", "observation")), /source facts/);
  });
  assert.throws(() => escaped.appendSource(event("late")), /expired/);
  assert.throws(() => escaped.generation, /expired/);
  await owned.close();
  await assert.rejects(owned.run(async () => undefined), /closed/);
});

test("owned close joins unawaited accepted source I/O before releasing registration", async (t) => {
  const { prototype, session } = await fixture(t);
  const owned = await session();
  const entered = deferred(), release = deferred();
  const sync = prototype.sync;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if ((await this.stat()).isFile()) {
      entered.resolve();
      await release.promise;
    }
    await sync.call(this);
  });
  let finished = false, closed = false;
  const pending = owned.run(async (scope) => { void scope.appendSource(event("accepted")); }).then(() => { finished = true; });
  await entered.promise;
  const closing = owned.close().then(() => { closed = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(closed, false);
    await assert.rejects(owned.run(async () => undefined), /closed/);
  } finally { release.resolve(); }
  await Promise.all([pending, closing]);
});

test("failed observation invalidates generation without permanently disabling strict source work", async (t) => {
  const { trace, other, session } = await fixture(t);
  const owned = await session();
  await owned.run(async (scope) => {
    const before = scope.generation;
    const failed = await other.record({ threadId: "thread", type: "" });
    assert.equal(failed.durability, "degraded");
    assert(scope.generation > before);
    assert.equal((await scope.appendSource(event("after-gap"))).durability, "durable");
  });
  assert((await trace.read("thread")).records.some((record) => record.type === "runtime_item"));
});

test("warm source-lane runs do not silently reread historical payload", async (t) => {
  const { trace, session } = await fixture(t);
  const owned = await session();
  let reads = 0;
  const read = trace.read.bind(trace);
  t.mock.method(trace, "read", async (...args: Parameters<FileTraceStore["read"]>) => {
    reads++;
    return read(...args);
  });
  for (let index = 0; index < 3; index++) await owned.run(async (scope) => {
    assert.equal((await scope.appendSource(event("new-" + index))).durability, "durable");
  });
  assert.equal(reads, 0, "coordination itself does not claim verified source state");
});

test("batch snapshots and whole authoritative import wait outside Trace queue", async (t) => {
  const { trace, other, session } = await fixture(t);
  const source = new FileTraceStore(path.join(trace.directory, "..", "import-source"));
  await source.record(event("imported", "context_source"));
  const imported = (await source.read("thread")).records;
  const owned = await session();
  const entered = deferred(), release = deferred();
  const active = owned.run(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const batchInput = [event("batch", "context_source")];
  let batchDone = false, importDone = false;
  const batch = other.recordBatch(batchInput).then((value) => { batchDone = true; return value; });
  const importWork = trace.importRecords("thread", imported, source).then((value) => { importDone = true; return value; });
  (batchInput[0]!.data as { text: string }).text = "mutated";
  (imported[0]!.data as { id: string }).id = "mutated-import";
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(batchDone, false);
    assert.equal(importDone, false);
    assert.equal((await trace.record(event("visible-observation", "observation"))).durability, "durable");
  } finally { release.resolve(); }
  await active;
  assert((await batch).every((receipt) => receipt.durability === "durable"));
  assert((await importWork).every((receipt) => receipt.durability === "durable"));
  const records = (await trace.read("thread")).records;
  assert(records.some((record) => (record.data as { id?: string })?.id === "imported"));
  assert.equal((records.find((record) => (record.data as { id?: string })?.id === "batch")!.data as { text: string }).text, "exact synthetic source");
});

test("source failure and owner loss cannot turn ignored writes into successful scope completion", async (t) => {
  const { owner, prototype, session } = await fixture(t);
  const owned = await session();
  const sync = prototype.sync;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    await sync.call(this);
    if ((await this.stat()).isFile()) owner.close();
  });
  await assert.rejects(owned.run(async (scope) => { void scope.appendSource(event("unknown")); }), ThreadJournalAppendOutcomeUnknownError);
});
