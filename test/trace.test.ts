import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  appendFile,
  symlink,
  link,
  mkdir,
  rename,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileTraceStore, InMemoryTraceStore } from "../src/trace.js";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-synthetic-"));
  return { root, store: new FileTraceStore(path.join(root, "trace")) };
}
test("actual bytes and repeated occurrences survive restart without a prior reader", async () => {
  const { root, store } = await fixture();
  try {
    const bytes = Uint8Array.from([0, 255, 128, 13, 10]);
    const pending = store.record({
      threadId: "thread",
      type: "raw",
      data: { password: "keep", token: "keep" },
      artifacts: [{ name: "response", bytes }],
    });
    bytes.fill(3);
    assert.equal((await pending).durability, "durable");
    await store.record({
      threadId: "thread",
      type: "raw",
      artifacts: [
        { name: "response", bytes: Uint8Array.from([0, 255, 128, 13, 10]) },
      ],
    });
    const reader = new FileTraceStore(store.directory),
      read = await reader.read("thread");
    assert.equal(read.completeness, "complete");
    assert.equal(read.records.length, 2);
    assert.notEqual(read.records[0]!.id, read.records[1]!.id);
    assert.equal(
      read.records[0]!.artifacts[0]!.ref.sha256,
      read.records[1]!.artifacts[0]!.ref.sha256,
    );
    assert.deepEqual(
      [...(await reader.readArtifact(read.records[0]!.artifacts[0]!.ref))],
      [0, 255, 128, 13, 10],
    );
    assert.deepEqual(read.records[0]!.data, {
      password: "keep",
      token: "keep",
    });
    assert.equal(
      (await readdir(path.join(store.directory, "artifacts"))).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("torn UTF8/frame stays intact and fresh writer never appends behind the crash tail", async () => {
  const { root, store } = await fixture();
  try {
    await store.record({ threadId: "thread", type: "first" });
    const dir = path.join(store.directory, "threads", "thread"),
      segment = (await readdir(dir))[0]!,
      file = path.join(dir, segment);
    await appendFile(file, Buffer.from([0x7b, 0xe4, 0xbd]));
    const before = await readFile(file);
    const restart = new FileTraceStore(store.directory);
    assert.equal(
      (await restart.record({ threadId: "thread", type: "second" })).durability,
      "durable",
    );
    assert.deepEqual(await readFile(file), before);
    assert.equal((await readdir(dir)).length, 2);
    const read = await restart.read("thread");
    assert.equal(read.completeness, "incomplete");
    assert.ok(read.issues.some((issue) => issue.kind === "partial_frame"));
    assert.deepEqual(
      read.records.map((record) => record.type),
      ["first", "second"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("corrupt artifact/checksum is explicit, and metadata reads never pretend artifact verification", async () => {
  const { root, store } = await fixture();
  try {
    await store.record({
      threadId: "thread",
      type: "raw",
      artifacts: [{ name: "body", bytes: "original" }],
    });
    const record = (await store.read("thread")).records[0]!,
      artifact = record.artifacts[0]!.ref;
    await writeFile(
      path.join(store.directory, "artifacts", artifact.sha256),
      "corrupt!",
    );
    const metadata = await store.read("thread", { verifyArtifacts: false });
    assert.equal(metadata.artifactVerification, "not-checked");
    assert.equal(metadata.completeness, "complete");
    assert.equal((await store.read("thread")).completeness, "incomplete");
    await assert.rejects(store.readArtifact(artifact), /hash/u);
    assert.equal(
      (
        await store.record({
          threadId: "thread",
          type: "reuse",
          artifacts: [{ name: "body", bytes: "original" }],
        })
      ).durability,
      "degraded",
    );
    const dir = path.join(store.directory, "threads", "thread"),
      file = path.join(dir, (await readdir(dir))[0]!);
    await appendFile(
      file,
      JSON.stringify({
        record: { ...record, id: "changed" },
        sha256: "0".repeat(64),
      }) + "\n",
    );
    assert.ok(
      (await store.read("thread")).issues.some(
        (issue) => issue.kind === "invalid_frame",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("write failure is nonthrowing degradation and next successful append records the gap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-failure-"));
  try {
    const dir = path.join(root, "trace");
    await writeFile(dir, "not-directory");
    const store = new FileTraceStore(dir);
    assert.equal(
      (await store.record({ threadId: "thread", type: "lost" })).durability,
      "degraded",
    );
    await rm(dir);
    assert.equal(
      (await store.record({ threadId: "thread", type: "next" })).durability,
      "durable",
    );
    const read = await store.read("thread");
    assert.deepEqual(
      read.records.map((r) => r.type),
      ["trace_capture_gap", "next"],
    );
    assert.equal(read.completeness, "incomplete");
    assert.equal(store.status().failedRecords, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("fork/import owns bytes independently and preserves evidence origin/clock, never execution authority", async () => {
  const { root, store } = await fixture();
  try {
    await store.record({
      threadId: "source",
      type: "tool_result_observed",
      artifacts: [{ name: "body", bytes: "complete result" }],
    });
    const original = (await store.read("source")).records[0]!,
      target = new FileTraceStore(path.join(root, "fork"));
    assert.equal(
      (await target.importRecords("target", [original], store))[0]!.durability,
      "durable",
    );
    await rm(store.directory, { recursive: true });
    const read = await new FileTraceStore(target.directory).read("target");
    assert.equal(read.completeness, "complete");
    assert.equal(read.records[0]!.origin?.recordId, original.id);
    assert.deepEqual(read.records[0]!.clock, original.clock);
    assert.equal(
      Buffer.from(
        await target.readArtifact(original.artifacts[0]!.ref),
      ).toString(),
      "complete result",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const kind of ["symbolic", "hard"] as const)
  test(`preseeded ${kind} artifact alias never receives a durable import/dedup ACK`, async () => {
    const { root, store } = await fixture();
    try {
      await store.record({
        threadId: "source",
        type: "raw",
        artifacts: [{ name: "body", bytes: "same bytes" }],
      });
      const record = (await store.read("source")).records[0]!,
        ref = record.artifacts[0]!.ref,
        target = new FileTraceStore(path.join(root, "destination"));
      await mkdir(path.join(target.directory, "artifacts"), {
        recursive: true,
      });
      const sourceFile = path.join(store.directory, "artifacts", ref.sha256),
        destination = path.join(target.directory, "artifacts", ref.sha256);
      if (kind === "symbolic") await symlink(sourceFile, destination);
      else await link(sourceFile, destination);
      await assert.rejects(target.readArtifact(ref), /owned regular file/u);
      assert.equal(
        (await target.importRecords("target", [record], store))[0]!.durability,
        "degraded",
      );
      assert.equal(
        (
          await target.record({
            threadId: "direct",
            type: "raw",
            artifacts: [{ name: "body", bytes: "same bytes" }],
          })
        ).durability,
        "degraded",
      );
      assert.equal(
        (await target.read("target")).records.filter((r) => r.type === "raw")
          .length,
        0,
      );
      await rm(destination);
      assert.equal(
        (await target.importRecords("target", [record], store))[0]!.durability,
        "durable",
      );
      await rm(store.directory, { recursive: true });
      assert.equal(
        Buffer.from(await target.readArtifact(ref)).toString(),
        "same bytes",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
test("directory and segment aliases remain untrusted after store initialization", async () => {
  const { root, store } = await fixture();
  try {
    await store.record({
      threadId: "thread",
      type: "raw",
      artifacts: [{ name: "body", bytes: "bytes" }],
    });
    const ref = (await store.read("thread")).records[0]!.artifacts[0]!.ref;
    const out = path.join(root, "outside");
    await rename(path.join(store.directory, "artifacts"), out);
    await symlink(out, path.join(store.directory, "artifacts"), "dir");
    await assert.rejects(store.readArtifact(ref), /owned real directory/u);
    assert.equal(
      (await store.record({ threadId: "thread", type: "new" })).durability,
      "degraded",
    );
    await rm(path.join(store.directory, "artifacts"));
    await rename(out, path.join(store.directory, "artifacts"));
    const dir = path.join(store.directory, "threads", "thread"),
      segment = (await readdir(dir))[0]!,
      file = path.join(dir, segment),
      outside = path.join(root, "foreign.jsonl");
    await writeFile(outside, await readFile(file));
    await rm(file);
    await symlink(outside, file);
    const read = await store.read("thread");
    assert.equal(read.records.length, 0);
    assert.equal(read.completeness, "incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("concurrent per-thread writes keep occurrences and shared content dedup independent", async () => {
  const { root, store } = await fixture();
  try {
    const receipts = await Promise.all(
      Array.from({ length: 80 }, (_, n) =>
        store.record({
          threadId: n % 2 ? "left" : "right",
          type: "chunk",
          data: { n },
          artifacts: [{ name: "body", bytes: "shared identical bytes" }],
        }),
      ),
    );
    assert.ok(receipts.every((r) => r.durability === "durable"));
    for (const id of ["left", "right"]) {
      const read = await store.read(id);
      assert.equal(read.completeness, "complete");
      assert.equal(read.records.length, 40);
      assert.deepEqual(
        read.records.map((r) => r.sequence),
        Array.from({ length: 40 }, (_, i) => i + 1),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("acknowledged evidence survives abrupt process exit with explicit separate clock domains", async () => {
  const { root, store } = await fixture();
  try {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const moduleUrl = new URL(`../src/trace.${extension}`, import.meta.url)
      .href;
    const script = `import{FileTraceStore}from ${JSON.stringify(moduleUrl)};const store=new FileTraceStore(${JSON.stringify(store.directory)});const ack=await store.record({threadId:'thread',type:'child',artifacts:[{name:'body',bytes:'acknowledged'}]});if(ack.durability!=='durable')process.exit(2);process.exit(0);`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    assert.equal(
      await new Promise((resolve) => child.once("exit", resolve)),
      0,
      errors,
    );
    const before = (await store.read("thread")).records[0]!;
    assert.equal(
      (await store.record({ threadId: "thread", type: "parent" })).durability,
      "durable",
    );
    const after = (await store.read("thread")).records[1]!;
    assert.notEqual(before.clock.domain, after.clock.domain);
    assert.equal(
      Buffer.from(
        await store.readArtifact(before.artifacts[0]!.ref),
      ).toString(),
      "acknowledged",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("memory fixtures never claim durability", async () => {
  const store = new InMemoryTraceStore();
  assert.equal(
    (await store.record({ threadId: "test", type: "fixture" })).durability,
    "degraded",
  );
  assert.equal((await store.read("test")).completeness, "incomplete");
  assert.equal(store.status().durability, "degraded");
});
