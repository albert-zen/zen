import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile, rename, link, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileItemListStore } from "../src/item-list-store.js";
import { type ContextItem } from "../src/item-list.js";
import { ThreadJournalAppendOutcomeUnknownError } from "../src/journal.js";
import { openOwnedItemListAppend } from "../src/owned-item-list-append.js";
import { StorageWriterOwnership } from "../src/storage-writer-ownership.js";

const item = (index: number): ContextItem => ({
  id: `item-${index}`, threadId: "thread", turnId: "turn",
  createdAt: "2026-01-01T00:00:00.000Z", kind: "message", role: "user",
  content: { text: `synthetic ${index}`, parts: [{ type: "text", text: `synthetic ${index}` }] },
  source: { kind: "user_message", sequence: index },
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
async function fixture(t: TestContext, count = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-owned-append-synthetic-"));
  const owner = new StorageWriterOwnership(root);
  const store = new FileItemListStore(path.join(root, "items"));
  await store.create("thread", Array.from({ length: count }, (_, i) => item(i)));
  const filename = path.join(root, "items", "thread.jsonl");
  const file = await open(filename, "r");
  const prototype = Object.getPrototypeOf(file) as FileHandle;
  await file.close();
  t.after(async () => { owner.close(); await rm(root, { recursive: true, force: true }); });
  return { root, owner, store, filename, prototype };
}

test("owned warm append reads no historical payload and writes only new bytes", async (t) => {
  const { root, owner, store, filename, prototype } = await fixture(t, 1000);
  const prefix = await readFile(filename);
  const handle = await openOwnedItemListAppend(owner, root, "thread");
  t.after(() => handle.close());
  handle.initialItems[0]!.id = "caller-mutation";
  let reads = 0, writes = 0, syncs = 0;
  const read = prototype.readFile, write = prototype.write, sync = prototype.sync;
  t.mock.method(prototype, "readFile", async function (this: FileHandle, ...args: unknown[]) {
    reads++;
    return await Reflect.apply(read, this, args);
  });
  t.mock.method(prototype, "write", async function (this: FileHandle, ...args: unknown[]) {
    const result = await Reflect.apply(write, this, args);
    writes += result.bytesWritten;
    return result;
  });
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    syncs++;
    await sync.call(this);
  });
  for (const index of [1000, 1001]) assert.deepEqual(await handle.append([item(index)]), [item(index)]);
  assert.equal(reads, 0);
  const suffix = Buffer.from([item(1000), item(1001)].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.equal(writes, suffix.length);
  assert.equal(syncs, 2);
  assert.deepEqual(await readFile(filename), Buffer.concat([prefix, suffix]));
  await assert.rejects(handle.append([item(0)]), /duplicate/);
  assert.equal((await store.read("thread")).length, 1002);
});

test("capability requires exact real owner namespace and exclusive per-owner file claim", async (t) => {
  const { root, owner } = await fixture(t);
  await assert.rejects(openOwnedItemListAppend({} as StorageWriterOwnership, root, "thread"));
  await assert.rejects(openOwnedItemListAppend(owner, path.join(root, "other"), "thread"), /namespace/);
  const handle = await openOwnedItemListAppend(owner, root, "thread");
  await assert.rejects(openOwnedItemListAppend(owner, root, "thread"), /already open/);
  await handle.close();
  const reopened = await openOwnedItemListAppend(owner, root, "thread");
  owner.close();
  await assert.rejects(reopened.append([item(2)]), /closed/);
  await reopened.close();
});

test("same-size mutation, replacement and hard link invalidate private prefix proof", async (t) => {
  for (const mutation of ["bytes", "replacement", "hardlink"]) {
    const { root, owner, filename } = await fixture(t);
    const handle = await openOwnedItemListAppend(owner, root, "thread");
    const original = await readFile(filename);
    if (mutation === "bytes") {
      await writeFile(filename, original.toString().replace("synthetic 0", "synthetic X"));
    } else if (mutation === "replacement") {
      await rename(filename, filename + ".old");
      await writeFile(filename, original);
    } else {
      await link(filename, filename + ".alias");
    }
    const before = await readFile(filename);
    await assert.rejects(handle.append([item(2)]), ThreadJournalAppendOutcomeUnknownError);
    assert.deepEqual(await readFile(filename), before);
    await assert.rejects(handle.append([item(3)]), /explicit recovery/);
    await handle.close();
  }
});

test("partial append is unknown, preserves old prefix, poisons handle and never repairs on readonly open", async (t) => {
  const { root, owner, store, filename, prototype } = await fixture(t);
  const prefix = await readFile(filename);
  const handle = await openOwnedItemListAppend(owner, root, "thread");
  const write = prototype.write;
  let calls = 0;
  t.mock.method(prototype, "write", async function (this: FileHandle, bytes: Uint8Array, offset: number) {
    calls++;
    await Reflect.apply(write, this, [bytes, offset, 7]);
    throw new Error("synthetic partial write");
  });
  await assert.rejects(handle.append([item(2)]), ThreadJournalAppendOutcomeUnknownError);
  const damaged = await readFile(filename);
  assert.deepEqual(damaged.subarray(0, prefix.length), prefix);
  assert.equal(damaged.length, prefix.length + 7);
  await assert.rejects(handle.append([item(3)]), /explicit recovery/);
  assert.equal(calls, 1);
  await handle.close();
  await assert.rejects(store.read("thread"), /Incomplete semantic/);
  await assert.rejects(openOwnedItemListAppend(owner, root, "thread"), /Incomplete semantic/);
  assert.deepEqual(await readFile(filename), damaged);
});

test("sync failure cannot acknowledge readable complete bytes and never retries", async (t) => {
  const { root, owner, filename, prototype } = await fixture(t);
  const handle = await openOwnedItemListAppend(owner, root, "thread");
  t.mock.method(prototype, "sync", async function () { throw new Error("synthetic sync failure"); });
  await assert.rejects(handle.append([item(2)]), ThreadJournalAppendOutcomeUnknownError);
  const after = await readFile(filename);
  await assert.rejects(handle.append([item(3)]), /explicit recovery/);
  assert.deepEqual(await readFile(filename), after);
  await handle.close();
});

test("receipt and close both wait for fsync, close rejects new work and drains accepted snapshot", async (t) => {
  const { root, owner, store, prototype } = await fixture(t);
  const handle = await openOwnedItemListAppend(owner, root, "thread");
  const entered = deferred(), release = deferred();
  const sync = prototype.sync;
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    entered.resolve();
    await release.promise;
    await sync.call(this);
  });
  const batch = [item(2)];
  let admitted = false, closed = false;
  const pending = handle.append(batch).then((receipt) => { admitted = true; return receipt; });
  batch[0]!.id = "caller-mutation";
  await entered.promise;
  const closing = handle.close().then(() => { closed = true; });
  await assert.rejects(handle.append([item(3)]), /closed/);
  assert.equal(admitted, false);
  assert.equal(closed, false);
  release.resolve();
  assert.deepEqual(await pending, [item(2)]);
  await closing;
  assert.equal((await store.read("thread")).at(-1)!.id, "item-2");
});

test("close failure is unknown even after successful fsync and poisons later append", async (t) => {
  const { root, owner, filename, prototype } = await fixture(t);
  const handle = await openOwnedItemListAppend(owner, root, "thread");
  const close = prototype.close;
  let calls = 0;
  t.mock.method(prototype, "close", async function (this: FileHandle) {
    await close.call(this);
    if (calls === 0) {
      calls++;
      throw new Error("synthetic close failure");
    }
  });
  await assert.rejects(handle.append([item(2)]), ThreadJournalAppendOutcomeUnknownError);
  const bytes = await readFile(filename);
  await assert.rejects(handle.append([item(3)]), /explicit recovery/);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(filename), bytes);
  await handle.close();
});
