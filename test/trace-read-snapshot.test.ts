import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileTraceStore } from "../src/trace.js";

test("immutable Trace reads reuse only exact current bytes without copying historical records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-snapshot-"));
  const store = new FileTraceStore(root);
  t.after(async () => {
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });
  await store.recordBatch(
    Array.from({ length: 128 }, (_, index) => ({
      threadId: "t",
      type: "synthetic",
      data: { index, nested: [{ text: "original" }] },
    })),
  );
  const first = await store.readSnapshot("t");
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(first.records));
  assert(Object.isFrozen(first.records[0]));
  assert(Object.isFrozen(first.records[0]!.clock));
  assert.throws(() => {
    (first.records[0]!.data as { nested: { text: string }[] }).nested[0]!.text =
      "poisoned";
  }, TypeError);
  assert.throws(() => {
    (first.records as unknown as unknown[]).pop();
  }, TypeError);
  const publicRead = await store.read("t");
  publicRead.records[0]!.type = "changed";
  (
    publicRead.records[0]!.data as { nested: { text: string }[] }
  ).nested[0]!.text = "changed";
  let copies = 0;
  const clone = globalThis.structuredClone;
  const mocked = t.mock.method(globalThis, "structuredClone", <T>(value: T) => {
    copies++;
    return clone(value);
  });
  try {
    const second = await store.readSnapshot("t");
    assert.strictEqual(second.records[0], first.records[0]);
    assert.equal(second.records[0]!.type, "synthetic");
    assert.equal(
      copies,
      0,
      "fresh byte verification needs no historical object copies",
    );
  } finally {
    mocked.mock.restore();
  }
  await store.record({
    threadId: "t",
    type: "suffix",
    data: { nested: ["suffix"] },
  });
  const grown = await store.readSnapshot("t");
  assert.strictEqual(grown.records[0], first.records[0]);
  assert.equal(grown.records.length, 129);
  assert(Object.isFrozen(grown.records.at(-1)!.data));
  const directory = path.join(root, "threads", "t");
  const file = path.join(
    directory,
    (await readdir(directory)).find((name) => name.endsWith(".jsonl"))!,
  );
  const bytes = await readFile(file);
  const corrupt = Buffer.from(bytes);
  const offset = corrupt.indexOf("original");
  assert(offset >= 0);
  corrupt.write("modified", offset);
  await writeFile(file, corrupt);
  const damaged = await store.readSnapshot("t");
  assert.equal(damaged.completeness, "incomplete");
  assert(damaged.issues.some((issue) => issue.kind === "invalid_frame"));
  await writeFile(file, bytes);
  const restored = await store.readSnapshot("t");
  assert.equal(restored.completeness, "complete");
  assert.notStrictEqual(
    restored.records[0],
    first.records[0],
    "damage retires the retained decoded source",
  );
});

test("immutable Trace reads verify artifacts on every requested read", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-trace-snapshot-artifact-"),
  );
  const store = new FileTraceStore(root);
  t.after(async () => {
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });
  await store.record({
    threadId: "t",
    type: "synthetic",
    artifacts: [{ name: "fixture", bytes: "Synthetic artifact" }],
  });
  const first = await store.readSnapshot("t");
  assert.equal(first.completeness, "complete");
  assert.equal(first.artifactVerification, "verified");
  const artifacts = await readdir(path.join(root, "artifacts"), {
    recursive: true,
  });
  const file = artifacts.find((name) =>
    String(name).endsWith(first.records[0]!.artifacts[0]!.ref.sha256),
  );
  assert(file);
  await rm(path.join(root, "artifacts", String(file)));
  const damaged = await store.readSnapshot("t");
  assert(damaged.issues.some((issue) => issue.kind === "artifact_unavailable"));
  const unchecked = await store.readSnapshot("t", { verifyArtifacts: false });
  assert.equal(unchecked.artifactVerification, "not-checked");
  assert.equal(unchecked.completeness, "complete");
});
