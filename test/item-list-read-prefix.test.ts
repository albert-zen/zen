import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileItemListStore } from "../src/item-list-store.js";
import { contextItemsFromLegacy } from "../src/item-list.js";

test("append scopes read current bytes and reuse only an exact immutable decoded prefix", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-item-prefix-"));
  const store = new FileItemListStore(root);
  const item = (id: string) =>
    contextItemsFromLegacy({
      id,
      threadId: "t",
      turnId: "turn",
      createdAt: "2026-11-03T00:00:00.000Z",
      type: "user_message",
      text: `Synthetic ${id}`,
    })[0]!;
  const original = Array.from({ length: 128 }, (_, index) =>
    item(String(index)),
  );
  try {
    await store.create("t", original);
    await store.withAppendSnapshot("t", (scope) => scope.read());
    let decoded = 0;
    const parse = JSON.parse;
    const mock = t.mock.method(
      JSON,
      "parse",
      (...args: Parameters<typeof JSON.parse>) => {
        const value: unknown = parse(...args);
        if (
          value &&
          typeof value === "object" &&
          "kind" in value &&
          "source" in value
        )
          decoded++;
        return value;
      },
    );
    try {
      await store.withAppendSnapshot("t", async (scope) => {
        const items = await scope.read();
        assert.deepEqual(items, original);
        assert.equal(
          decoded,
          0,
          "scope reuses only the byte-equal validated prefix",
        );
        assert.throws(() => {
          items[0]!.id = "mutated";
        }, TypeError);
        await scope.append([item("new")]);
      });
      await store.withAppendSnapshot("t", async (scope) => {
        assert.equal((await scope.read()).length, 129);
        assert.equal(
          decoded,
          0,
          "successful publication carries its exact private decoded suffix",
        );
      });
    } finally {
      mock.mock.restore();
    }
    const filename = path.join(root, "t.jsonl");
    const exact = await readFile(filename);
    const corrupt = Buffer.from(exact);
    const offset = corrupt.indexOf('"sequence":0');
    assert(offset >= 0);
    corrupt.write('"sequence":-1', offset);
    await writeFile(filename, corrupt);
    await assert.rejects(
      store.withAppendSnapshot("t", (scope) => scope.read()),
    );
    await writeFile(filename, exact);
    assert.equal((await store.read("t")).length, 129);
    await store.withAppendSnapshot("t", async (scope) =>
      assert.equal((await scope.read()).length, 129),
    );
    await rm(filename);
    await assert.rejects(
      store.withAppendSnapshot("t", async (scope) => {
        assert.deepEqual(await scope.read(), []);
        await scope.append([item("must-not-recreate")]);
      }),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic byte reuse retires on absence and on switching Threads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-item-prefix-retire-"));
  const store = new FileItemListStore(root);
  const item = (threadId: string) =>
    contextItemsFromLegacy({
      id: "item",
      threadId,
      turnId: "turn",
      createdAt: "2026-11-03T00:00:00.000Z",
      type: "user_message",
      text: "Synthetic",
    })[0]!;
  try {
    await store.create("t", [item("t")]);
    await store.create("other", [item("other")]);
    await store.withAppendSnapshot("t", (scope) => scope.read());
    let parses = 0;
    const parse = JSON.parse;
    const mocked = t.mock.method(
      JSON,
      "parse",
      (...args: Parameters<typeof JSON.parse>) => {
        parses++;
        return parse(...args);
      },
    );
    try {
      await store.withAppendSnapshot("other", (scope) => scope.read());
      parses = 0;
      await store.withAppendSnapshot("t", (scope) => scope.read());
      assert.equal(parses, 1, "only the most recently used Thread is retained");
      const file = path.join(root, "t.jsonl");
      const bytes = await readFile(file);
      await rm(file);
      await store.withAppendSnapshot("t", async (scope) =>
        assert.deepEqual(await scope.read(), []),
      );
      await writeFile(file, bytes);
      parses = 0;
      await store.withAppendSnapshot("t", (scope) => scope.read());
      assert.equal(
        parses,
        1,
        "source absence retires the private decoded prefix",
      );
    } finally {
      mocked.mock.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic prefixes above the source-byte budget are revalidated", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-item-prefix-budget-"));
  const store = new FileItemListStore(root);
  try {
    const item = contextItemsFromLegacy({
      id: "item",
      threadId: "t",
      turnId: "turn",
      createdAt: "2026-11-03T00:00:00.000Z",
      type: "user_message",
      text: "Synthetic",
    })[0]!;
    await store.create("t", [item]);
    const file = path.join(root, "t.jsonl");
    await writeFile(
      file,
      Buffer.concat([Buffer.alloc(32 * 1024 * 1024, 32), await readFile(file)]),
    );
    await store.withAppendSnapshot("t", (scope) => scope.read());
    let parses = 0;
    const parse = JSON.parse;
    const mocked = t.mock.method(
      JSON,
      "parse",
      (...args: Parameters<typeof JSON.parse>) => {
        parses++;
        return parse(...args);
      },
    );
    try {
      await store.withAppendSnapshot("t", async (scope) =>
        assert.deepEqual(await scope.read(), [item]),
      );
      assert.equal(
        parses,
        1,
        "an oversized source is decoded again instead of retained",
      );
    } finally {
      mocked.mock.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
