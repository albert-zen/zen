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

test("Trace prefix retention is bounded to one Thread and retires read failures and truncation", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-trace-prefix-retire-"),
  );
  const store = new FileTraceStore(root);
  try {
    await store.recordBatch(
      Array.from({ length: 8 }, (_, index) => ({
        threadId: "t",
        type: "synthetic",
        data: { index },
      })),
    );
    await store.record({ threadId: "other", type: "other" });
    await store.read("t");
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
      await store.read("other");
      frames = 0;
      await store.read("t");
      assert.equal(
        frames,
        8,
        "reading a different Thread retires the old retained source",
      );
      const directory = path.join(root, "threads", "t");
      const file = path.join(
        directory,
        (await readdir(directory)).find((name) => name.endsWith(".jsonl"))!,
      );
      const bytes = await readFile(file);
      await rm(file);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(file);
      const failed = await store.read("t");
      assert(failed.issues.some((issue) => issue.kind === "read_failure"));
      assert.equal(failed.records.length, 0);
      await rm(file, { recursive: true });
      await writeFile(file, bytes);
      frames = 0;
      assert.equal((await store.read("t")).records.length, 8);
      assert.equal(
        frames,
        8,
        "a failed source read cannot retain its parse result",
      );
      const end = bytes.lastIndexOf(10, bytes.length - 2) + 1;
      await writeFile(file, bytes.subarray(0, end));
      frames = 0;
      const truncated = await store.read("t");
      assert.equal(truncated.completeness, "complete");
      assert.equal(
        truncated.records.length,
        7,
        "truncated source cannot resurrect an old occurrence",
      );
      assert.equal(frames, 7);
    } finally {
      mocked.mock.restore();
    }
  } finally {
    await store.flush();
    await rm(root, { recursive: true, force: true });
  }
});

test("Trace retention bounds combined source bytes and segment count", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zen-trace-prefix-budget-"),
  );
  const store = new FileTraceStore(root);
  try {
    await store.recordBatch(
      Array.from({ length: 65 }, (_, index) => ({
        threadId: "t",
        type: "synthetic",
        data: { index },
      })),
    );
    const directory = path.join(root, "threads", "t");
    const original = path.join(
      directory,
      (await readdir(directory)).find((name) => name.endsWith(".jsonl"))!,
    );
    const lines = (await readFile(original, "utf8")).trimEnd().split("\n");
    await rm(original);
    for (const [index, line] of lines.entries())
      await writeFile(
        path.join(directory, `segment-${String(index).padStart(2, "0")}.jsonl`),
        `${line}\n`,
      );
    await store.read("t");
    let frames = 0;
    const parse = JSON.parse;
    const mocked = t.mock.method(
      JSON,
      "parse",
      (...args: Parameters<typeof JSON.parse>) => {
        frames++;
        return parse(...args);
      },
    );
    try {
      assert.equal((await store.read("t")).records.length, 65);
      assert.equal(frames, 1, "the sixty-fifth segment is not retained");
      for (const name of await readdir(directory))
        await rm(path.join(directory, name));
      const padding = Buffer.alloc(17 * 1024 * 1024, 32);
      for (let index = 0; index < 2; index++)
        await writeFile(
          path.join(directory, `large-${index}.jsonl`),
          Buffer.concat([padding, Buffer.from(`${lines[index]}\n`)]),
        );
      assert.equal((await store.read("t")).records.length, 2);
      frames = 0;
      const reread = await store.read("t");
      assert.equal(reread.completeness, "complete");
      assert.equal(reread.records.length, 2);
      assert.equal(
        frames,
        1,
        "two individually small segments cannot exceed the combined 32 MiB budget",
      );
    } finally {
      mocked.mock.restore();
    }
  } finally {
    await store.flush();
    await rm(root, { recursive: true, force: true });
  }
});
