import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileTraceStore } from "../src/trace.js";

const png = Buffer.alloc(180_002, 0xed);
const webp = Buffer.alloc(70_001, 0x7a);
const pngBase64 = png.toString("base64");
const webpBase64 = webp.toString("base64");
const mediaType = "application/json";
function request(number: number) {
  // Different whitespace, quoting, padding, UTF-8 and several media occurrences.
  return Buffer.from(
    `{ "input": [{"image_url":"data:image/png;base64,${pngBase64}"}, ` +
      `{"image_url":{"url":"data:image/webp;base64,${webpBase64}"}}, ` +
      `{"image_url":"data:image/png;base64,${pngBase64}"}],\r\n"notes":"测试 \\" ${number}" }\n`,
  );
}
function sha(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
function event(threadId: string, bytes: Buffer, type = "model_request") {
  return {
    threadId,
    type,
    artifacts: [{ name: "request_body", bytes, mediaType }],
  };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-trace-request-images-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return new FileTraceStore(path.join(root, "trace"));
}
async function storedBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    bytes += entry.isDirectory()
      ? await storedBytes(filename)
      : (await stat(filename)).size;
  }
  return bytes;
}
test("concurrent new request captures reuse images and preserve the exact request identity and ranges after reopening", async (t) => {
  const store = await fixture(t);
  const other = new FileTraceStore(store.directory);
  const bodies = Array.from({ length: 12 }, (_, index) => request(index));
  await Promise.all(
    bodies.map(async (body, index) => {
      const receipt = await (index % 2 ? store : other).record(
        event(`thread-${index}`, body),
      );
      assert.equal(receipt.durability, "durable", JSON.stringify(receipt));
      assert.equal(receipt.localArtifacts?.length ?? 0, 0);
    }),
  );
  const cold = new FileTraceStore(store.directory);
  for (const [index, body] of bodies.entries()) {
    const result = await cold.read(`thread-${index}`);
    assert.equal(result.completeness, "complete");
    const { ref } = result.records[0]!.artifacts[0]!;
    assert.deepEqual(ref, {
      sha256: sha(body),
      byteLength: body.length,
      mediaType,
    });
    assert.deepEqual(Buffer.from(await cold.readArtifact(ref)), body);
    if (index !== 0) continue;
    const imageStart = body.indexOf(pngBase64);
    for (const offset of [
      0,
      imageStart - 5,
      imageStart + 65535,
      imageStart + pngBase64.length - 5,
      body.length - 1,
      body.length,
      body.length + 5,
    ]) {
      assert.deepEqual(
        Buffer.from(await cold.readArtifactRange(ref, offset, 19)),
        body.subarray(offset, offset + 19),
      );
    }
  }
  const raw = bodies.reduce((size, body) => size + body.length, 0);
  const compact = await storedBytes(path.join(cold.directory, "artifacts"));
  assert.ok(compact < raw * 0.12, `stored ${compact} of ${raw} logical bytes`);
  t.diagnostic(
    `synthetic artifact file bytes: ${raw} raw -> ${compact} compact`,
  );
});
test("legacy request reads and import preserve exact independently owned bytes; ordinary receipts keep raw paths even after compact capture", async (t) => {
  const store = await fixture(t);
  const destination = new FileTraceStore(
    path.join(path.dirname(store.directory), "import"),
  );
  const body = request(1);
  await store.record(event("seed", body, "tool_result_observed"));
  const legacy = {
    ...(await store.read("seed")).records[0]!,
    type: "model_request",
  };
  const ref = legacy.artifacts[0]!.ref;
  assert.deepEqual(await store.readArtifact(ref), body);
  assert.deepEqual(
    await store.readArtifactRange(ref, 5, 10),
    body.subarray(5, 15),
  );
  assert.equal(
    (await destination.importRecords("from-legacy", [legacy], store))[0]!
      .durability,
    "durable",
  );
  const imported = (await destination.read("from-legacy")).records[0]!;
  assert.deepEqual(imported.origin, {
    threadId: "seed",
    recordId: legacy.id,
    sequence: legacy.sequence,
  });
  assert.deepEqual(imported.artifacts, legacy.artifacts);
  const copy = new FileTraceStore(
    path.join(path.dirname(store.directory), "copy"),
  );
  assert.equal(
    (await copy.importRecords("copy", [imported], destination))[0]!.durability,
    "durable",
  );
  await rm(store.directory, { recursive: true });
  await rm(destination.directory, { recursive: true });
  assert.deepEqual(Buffer.from(await copy.readArtifact(ref)), body);
  const ordinary = await copy.record(
    event("tool", body, "tool_result_observed"),
  );
  assert.equal(ordinary.durability, "durable");
  assert.deepEqual(await readFile(ordinary.localArtifacts![0]!.path), body);
  assert.deepEqual(await copy.readArtifact(ref), body);
});
test("missing and corrupt image blocks fail verification even for ranges outside the image, and block new request publication", async (t) => {
  const store = await fixture(t);
  const body = request(1);
  assert.equal(
    (await store.record(event("first", body))).durability,
    "durable",
  );
  const ref = (await store.read("first")).records[0]!.artifacts[0]!.ref;
  const image = path.join(
    store.directory,
    "artifacts",
    `${sha(png)}.image-v1`,
    "data",
  );
  await writeFile(image, Buffer.alloc(png.length, 0xba));
  await assert.rejects(store.readArtifact(ref), /integrity/u);
  await assert.rejects(
    store.readArtifactRange(ref, ref.byteLength, 1),
    /integrity/u,
  );
  assert.equal((await store.read("first")).completeness, "incomplete");
  assert.equal(
    (await store.read("first", { verifyArtifacts: false })).completeness,
    "complete",
  );
  assert.equal(
    (await store.record(event("blocked", request(2)))).durability,
    "degraded",
  );
  assert.deepEqual((await store.read("blocked")).records, []);
  await rm(image);
  await assert.rejects(store.readArtifactRange(ref, 0, 8), /ENOENT/u);
});

test("unsupported image encodings stay raw and an invalid recipe is not accepted", async (t) => {
  const store = await fixture(t);
  const nonCanonical = "A".repeat(1026) + "B="; // Nonzero pad bits.
  const escaped = "A".repeat(1026) + "\\u0041=";
  const original = Buffer.from(
    `{"urls":["data:image/png;base64,${nonCanonical}","data:image/png;base64,${escaped}","data:image/png;base64,AA=="]}`,
  );
  const receipt = await store.record(event("unsupported", original));
  assert.equal(receipt.durability, "durable");
  assert.deepEqual(await readFile(receipt.localArtifacts![0]!.path), original);

  const body = request(4);
  const other = new FileTraceStore(store.directory);
  const concurrent = await Promise.all([
    store.record(event("repeat-a", body)),
    other.record(event("repeat-b", body)),
  ]);
  assert.ok(concurrent.every((receipt) => receipt.durability === "durable"));
  const { ref } = (await other.read("repeat-b")).records[0]!.artifacts[0]!;
  const recipe = path.join(
    store.directory,
    "artifacts",
    `${sha(body)}.request-v1`,
    "data",
  );
  await writeFile(recipe, Buffer.alloc(4, 0xff));
  await assert.rejects(
    store.readArtifactRange(ref, 0, 10),
    /Invalid Trace request image index/u,
  );
  assert.equal((await other.read("repeat-a")).completeness, "incomplete");
});

test("a failed image sync cannot publish a recipe, frame or durable receipt", async (t) => {
  const store = await fixture(t);
  const probe = await open(
    path.join(path.dirname(store.directory), "probe"),
    "wx",
  );
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalSync = prototype.sync;
  await probe.close();
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    const metadata = await this.stat();
    if (metadata.isFile() && metadata.size === png.length)
      throw new Error("synthetic image sync failure");
    await originalSync.call(this);
  });
  const receipt = await store.record(event("failed-sync", request(1)));
  assert.equal(receipt.durability, "degraded");
  assert.match(receipt.error, /synthetic image sync failure/u);
  const cold = new FileTraceStore(store.directory);
  assert.deepEqual((await cold.read("failed-sync")).records, []);
  assert.deepEqual(await readdir(path.join(store.directory, "artifacts")), []);
});
