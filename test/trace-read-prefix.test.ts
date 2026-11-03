import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileTraceStore } from "../src/trace.js";

test("Trace rereads real bytes but does not revalidate an identical verified frame prefix", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-trace-prefix-"));
  const store = new FileTraceStore(root);
  try {
    await store.recordBatch(
      Array.from({ length: 128 }, (_, index) => ({
        threadId: "t",
        type: "synthetic",
        data: { index, text: "original" },
      })),
    );
    const initial = await store.read("t");
    assert.equal(initial.records.length, 128);
    let frames = 0;
    const parse = JSON.parse;
    const mocked = t.mock.method(
      JSON,
      "parse",
      (...args: Parameters<typeof JSON.parse>) => {
        const value: unknown = parse(...args);
        if (
          value &&
          typeof value === "object" &&
          "record" in value &&
          "sha256" in value
        )
          frames++;
        return value;
      },
    );
    try {
      initial.records[0]!.type = "caller-mutated";
      const unchanged = await store.read("t");
      assert.equal(unchanged.records[0]!.type, "synthetic");
      assert.equal(
        frames,
        0,
        "byte-identical prefixes need no repeated frame validation",
      );
      await store.record({ threadId: "t", type: "suffix" });
      const grown = await store.read("t");
      assert.equal(grown.records.at(-1)!.type, "suffix");
      assert.equal(frames, 1, "only the new frame is decoded and validated");
    } finally {
      mocked.mock.restore();
    }
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
    const damaged = await store.read("t");
    assert.equal(damaged.completeness, "incomplete");
    assert(damaged.issues.some((issue) => issue.kind === "invalid_frame"));
    await writeFile(file, bytes);
    assert.equal((await store.read("t")).completeness, "complete");
    await appendFile(file, "partial");
    const partial = await store.read("t");
    assert(partial.issues.some((issue) => issue.kind === "partial_frame"));
    assert.equal(partial.records.length, 129);
  } finally {
    await store.flush();
    await rm(root, { recursive: true, force: true });
  }
});
