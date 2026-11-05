import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileTraceStore } from "../src/trace.js";

function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function message(index: number): string {
  // Deterministic, varied ASCII: the saving must come from cross-request reuse.
  let result = "";
  for (let part = 0; result.length < 2048; part++)
    result += createHash("sha256").update(`${index}:${part}`).digest("hex");
  return result.slice(0, 2048);
}
function event(threadId: string, bytes: Buffer) {
  return {
    threadId,
    type: "model_request",
    artifacts: [{ name: "request_body", bytes, mediaType: "application/json" }],
  };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-request-text-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new FileTraceStore(path.join(root, "trace"));
}
function longBody(tail = "尾部\r\n\\u1234") {
  return Buffer.from(
    Array.from({ length: 66 }, (_, index) => message(index)).join("") + tail,
  );
}
function blockPath(store: FileTraceStore, body: Buffer) {
  return path.join(
    store.directory,
    "artifacts",
    `${sha(body.subarray(0, 65536))}.text-v1`,
    "data",
  );
}
function recipePath(store: FileTraceStore, body: Buffer) {
  return path.join(
    store.directory,
    "artifacts",
    `${sha(body)}.request-text-v1`,
    "data",
  );
}
async function storage(
  directory: string,
): Promise<{ logical: number; allocated: number }> {
  const total = { logical: 0, allocated: 0 };
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const bytes = entry.isDirectory()
      ? await storage(filename)
      : await stat(filename).then((metadata) => ({
          logical: metadata.size,
          allocated: metadata.blocks * 512,
        }));
    total.logical += bytes.logical;
    total.allocated += bytes.allocated;
  }
  return total;
}

test("growing text requests share exact prefixes while cold full and range reads preserve every byte", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-request-text-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileTraceStore(root);
  const bodies: Buffer[] = [];
  const messages: unknown[] = [];
  let baseline = 0;
  for (let index = 0; index < 128; index++) {
    messages.push({ role: "user", content: message(index) });
    const body = Buffer.from(JSON.stringify({ messages }));
    bodies.push(body);
    baseline += body.length;
    const receipt = await store.record(event(`request-${index}`, body));
    assert.equal(receipt.durability, "durable", JSON.stringify(receipt));
    if ([31, 63, 127].includes(index))
      t.diagnostic(
        JSON.stringify({
          requests: index + 1,
          baseline,
          ...(await storage(path.join(root, "artifacts"))),
        }),
      );
  }
  const stored = await storage(path.join(root, "artifacts"));
  assert.ok(
    stored.logical < baseline * 0.5,
    `stored ${stored.logical} of ${baseline} bytes`,
  );
  const cold = new FileTraceStore(root);
  for (const [index, body] of bodies.entries()) {
    const result = await cold.read(`request-${index}`);
    assert.equal(result.completeness, "complete");
    const ref = result.records[0]!.artifacts[0]!.ref;
    assert.deepEqual(ref, {
      sha256: sha(body),
      byteLength: body.length,
      mediaType: "application/json",
    });
    assert.deepEqual(Buffer.from(await cold.readArtifact(ref)), body);
    for (const offset of [0, 65533, 131069, body.length - 3, body.length + 1])
      assert.deepEqual(
        Buffer.from(await cold.readArtifactRange(ref, offset, 19)),
        body.subarray(offset, offset + 19),
      );
  }
  assert.equal(
    (await cold.record(event("duplicate", bodies.at(-1)!))).durability,
    "durable",
  );
  assert.deepEqual(await storage(path.join(root, "artifacts")), stored);
});

test("short, boundary, non-UTF8 and changing-prefix requests retain exact bytes without depending on other recipes", async (t) => {
  const store = await fixture(t);
  const original = longBody();
  const bodies = [
    Buffer.from("short\r\n"),
    original.subarray(0, 65535),
    original.subarray(0, 65536),
    original.subarray(0, 65537),
    Buffer.concat([Buffer.from([0xff, 0x00, 0xc3]), original]),
    Buffer.concat([Buffer.from("different prefix"), original]),
  ];
  for (const [index, body] of bodies.entries()) {
    const receipt = await store.record(event(`edge-${index}`, body));
    assert.equal(receipt.durability, "durable");
    if (body.length < 65536)
      assert.deepEqual(await readFile(receipt.localArtifacts![0]!.path), body);
    else assert.equal(receipt.localArtifacts?.length ?? 0, 0);
    const ref = (await store.read(`edge-${index}`)).records[0]!.artifacts[0]!
      .ref;
    assert.deepEqual(await store.readArtifact(ref), body);
    assert.deepEqual(
      await store.readArtifactRange(ref, Math.max(0, body.length - 8), 16),
      body.subarray(Math.max(0, body.length - 8)),
    );
  }
  // Published recipes do not reference earlier requests, only independent blocks.
  await rm(path.dirname(recipePath(store, bodies[2]!)), { recursive: true });
  const cold = new FileTraceStore(store.directory);
  const remaining = await cold.read("edge-3");
  assert.equal(remaining.completeness, "complete");
  assert.deepEqual(
    await cold.readArtifact(remaining.records[0]!.artifacts[0]!.ref),
    bodies[3],
  );
});

test("legacy raw, text and image recipes coexist, import independently, and tools still receive raw paths", async (t) => {
  const store = await fixture(t);
  const legacyBody = longBody("legacy");
  const legacyReceipt = await store.record({
    ...event("legacy", legacyBody),
    type: "tool_result_observed",
  });
  assert.equal(legacyReceipt.durability, "durable");
  const existing = await store.record(event("legacy-model", legacyBody));
  assert.equal(existing.durability, "durable");
  assert.equal(
    existing.localArtifacts![0]!.path,
    legacyReceipt.localArtifacts![0]!.path,
  );
  const textBody = longBody("new text");
  const imageBody = Buffer.from(
    JSON.stringify({
      image: `data:image/png;base64,${Buffer.alloc(2048, 0x3e).toString("base64")}`,
      text: message(1),
    }),
  );
  for (const [id, body] of [
    ["text", textBody],
    ["image", imageBody],
  ] as const)
    assert.equal((await store.record(event(id, body))).durability, "durable");
  const destination = new FileTraceStore(
    path.join(path.dirname(store.directory), "import"),
  );
  for (const id of ["legacy-model", "text", "image"]) {
    const source = await store.read(id);
    assert.equal(source.completeness, "complete");
    const receipts = await destination.importRecords(id, source.records, store);
    assert.equal(receipts[0]!.durability, "durable");
  }
  await rm(store.directory, { recursive: true });
  const cold = new FileTraceStore(destination.directory);
  for (const [id, body] of [
    ["legacy-model", legacyBody],
    ["text", textBody],
    ["image", imageBody],
  ] as const) {
    const imported = await cold.read(id);
    assert.equal(imported.completeness, "complete");
    assert.deepEqual(
      await cold.readArtifact(imported.records[0]!.artifacts[0]!.ref),
      body,
    );
  }
  const tool = await cold.record({
    ...event("tool", textBody),
    type: "tool_result_observed",
  });
  assert.equal(tool.durability, "durable");
  assert.deepEqual(await readFile(tool.localArtifacts![0]!.path), textBody);
});

test("corrupt or missing text blocks fail every read and do not publish new frames", async (t) => {
  const store = await fixture(t);
  const body = longBody();
  assert.equal(
    (await store.record(event("first", body))).durability,
    "durable",
  );
  const ref = (await store.read("first")).records[0]!.artifacts[0]!.ref;
  const block = blockPath(store, body);
  await writeFile(block, Buffer.alloc(65536, 0));
  for (const offset of [0, 65540, body.length + 1])
    await assert.rejects(store.readArtifactRange(ref, offset, 8), /integrity/u);
  await assert.rejects(store.readArtifact(ref), /integrity/u);
  assert.equal((await store.read("first")).completeness, "incomplete");
  assert.equal(
    (await store.read("first", { verifyArtifacts: false })).completeness,
    "complete",
  );
  assert.equal(
    (await store.record(event("blocked", longBody("changed")))).durability,
    "degraded",
  );
  assert.deepEqual((await store.read("blocked")).records, []);
  await rm(block);
  await assert.rejects(
    store.readArtifactRange(ref, body.length + 1, 8),
    /ENOENT/u,
  );
  assert.equal(
    (await store.record(event("same-blocked", body))).durability,
    "degraded",
  );
});

test("invalid text indexes, altered tails and aliased storage fail closed", async (t) => {
  const store = await fixture(t);
  const body = longBody();
  await store.record(event("first", body));
  const ref = (await store.read("first")).records[0]!.artifacts[0]!.ref;
  const recipe = recipePath(store, body);
  const original = await readFile(recipe);
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(4, 0xff),
    Buffer.from(original).fill(0, 0, 4),
    Buffer.from(original).fill(0, original.length - 1),
  ]) {
    await writeFile(recipe, bytes);
    await assert.rejects(
      store.readArtifactRange(ref, 0, 8),
      /integrity|index/u,
    );
  }
  await writeFile(recipe, original);
  const alias = path.join(path.dirname(store.directory), "alias");
  await link(blockPath(store, body), alias);
  await assert.rejects(store.readArtifact(ref), /alias/u);
  await rm(alias);
  const block = blockPath(store, body);
  const bytes = await readFile(block);
  await writeFile(alias, bytes);
  await rm(block);
  await symlink(alias, block);
  await assert.rejects(store.readArtifact(ref), /alias/u);
});

test("concurrent stores publish complete owned blocks and recipes, never replace existing evidence", async (t) => {
  const store = await fixture(t);
  const other = new FileTraceStore(store.directory);
  const bodies = Array.from({ length: 10 }, (_, index) =>
    longBody(`tail-${index}`),
  );
  await Promise.all(
    bodies.map(async (body, index) => {
      assert.equal(
        (
          await (index % 2 ? other : store).record(
            event(`parallel-${index}`, body),
          )
        ).durability,
        "durable",
      );
    }),
  );
  const entries = await readdir(path.join(store.directory, "artifacts"));
  assert.equal(entries.filter((entry) => entry.endsWith(".text-v1")).length, 2);
  assert.equal(
    entries.filter((entry) => entry.endsWith(".request-text-v1")).length,
    10,
  );
  assert.equal(entries.filter((entry) => entry.endsWith(".tmp")).length, 0);
  const cold = new FileTraceStore(store.directory);
  for (const [index, body] of bodies.entries()) {
    const result = await cold.read(`parallel-${index}`);
    assert.equal(result.completeness, "complete");
    assert.deepEqual(
      await cold.readArtifact(result.records[0]!.artifacts[0]!.ref),
      body,
    );
  }
});

test("failed block and recipe syncs publish no frame; reopened writers safely reuse orphan blocks", async (t) => {
  for (const failure of ["block", "recipe"] as const) {
    const store = await fixture(t);
    const body = longBody();
    const probe = await open(
      path.join(path.dirname(store.directory), "probe"),
      "wx",
    );
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalSync = prototype.sync;
    await probe.close();
    const mock = t.mock.method(
      prototype,
      "sync",
      async function (this: FileHandle) {
        const metadata = await this.stat();
        if (
          metadata.isFile() &&
          (failure === "block"
            ? metadata.size === 65536
            : metadata.size === 4 + 2 * 32 + (body.length % 65536))
        )
          throw new Error(`synthetic ${failure} sync failure`);
        await originalSync.call(this);
      },
    );
    const receipt = await store.record(event("failed", body));
    assert.equal(receipt.durability, "degraded");
    assert.match(receipt.error, /synthetic .* sync failure/u);
    const cold = new FileTraceStore(store.directory);
    assert.deepEqual((await cold.read("failed")).records, []);
    const entries = await readdir(path.join(store.directory, "artifacts"));
    assert.equal(
      entries.filter(
        (entry) => entry.endsWith(".request-text-v1") || entry.endsWith(".tmp"),
      ).length,
      0,
    );
    mock.mock.restore();
    assert.equal(
      (await cold.record(event("retried", body))).durability,
      "durable",
    );
    assert.equal((await cold.read("retried")).completeness, "complete");
  }
});

test("abandoned staging entries are ignored and incomplete published entries are reported without repair", async (t) => {
  const store = await fixture(t);
  await store.record(event("seed", Buffer.from("seed")));
  const artifacts = path.join(store.directory, "artifacts");
  const stage = path.join(artifacts, ".interrupted.tmp");
  await mkdir(stage);
  await writeFile(path.join(stage, "data"), "partial");
  const body = longBody();
  assert.equal(
    (await store.record(event("normal", body))).durability,
    "durable",
  );
  assert.equal(await readFile(path.join(stage, "data"), "utf8"), "partial");
  const incomplete = longBody("incomplete");
  await mkdir(path.dirname(recipePath(store, incomplete)));
  const failed = await store.record(event("incomplete", incomplete));
  assert.equal(failed.durability, "degraded");
  assert.deepEqual((await store.read("incomplete")).records, []);
});
