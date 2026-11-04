import assert from "node:assert/strict";
import fs, { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test("public reads warm a private prefix without sharing caller-owned values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-item-public-prefix-"));
  const store = new FileItemListStore(root);
  const original = contextItemsFromLegacy({
    id: "item",
    threadId: "t",
    turnId: "turn",
    createdAt: "2026-11-03T00:00:00.000Z",
    type: "user_message",
    text: "Synthetic original",
  });
  try {
    await store.create("t", original);
    const caller = await store.read("t");
    assert.equal(Object.isFrozen(caller), false);
    caller[0]!.id = "caller-owned";
    assert.equal(caller[0]!.kind, "message");
    if (caller[0]!.kind !== "message") throw new Error("Expected message");
    caller[0]!.content.text = "Caller mutation";
    const part = caller[0]!.content.parts[0]!;
    assert.equal(part.type, "text");
    if (part.type !== "text") throw new Error("Expected text");
    part.text = "Nested mutation";
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
      await store.withAppendSnapshot("t", async (scope) => {
        const retained = await scope.read();
        assert.deepEqual(retained, original);
        assert.equal(
          parses,
          0,
          "first admission reuses the fresh public-read prefix",
        );
        assert.equal(Object.isFrozen(retained[0]), true);
        assert.equal(retained[0]!.kind, "message");
        if (retained[0]!.kind !== "message")
          throw new Error("Expected message");
        assert.equal(Object.isFrozen(retained[0]!.content.parts), true);
      });
      const again = await store.read("t");
      assert.deepEqual(again, original);
      assert.equal(Object.isFrozen(again[0]), false);
      assert.equal(
        parses,
        0,
        "public rereads reuse decoding but return defensive copies",
      );
      again[0]!.source.sequence = 77;
      assert.deepEqual(await store.read("t"), original);
    } finally {
      mocked.mock.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function publicPrefixItem(threadId: string, id = "first") {
  return contextItemsFromLegacy({
    id,
    threadId,
    turnId: "turn",
    createdAt: "2026-11-03T00:00:00.000Z",
    type: "user_message",
    text: "Synthetic before",
  })[0]!;
}

test("public prefixes recheck current bytes and retire damaged or missing sources", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-item-public-damage-"));
  const store = new FileItemListStore(root);
  const original = [publicPrefixItem("t"), publicPrefixItem("t", "other")];
  const filename = path.join(root, "t.jsonl");
  try {
    await store.create("t", original);
    const exact = await readFile(filename);
    await store.read("t");
    const changed = Buffer.from(
      exact.toString().replaceAll("before", "latter"),
    );
    assert.equal(changed.length, exact.length);
    await writeFile(filename, changed);
    const fresh = await store.read("t");
    assert.equal(fresh[0]!.kind, "message");
    if (fresh[0]!.kind !== "message") throw new Error("Expected message");
    assert.equal(fresh[0]!.content.text.includes("latter"), true);
    await writeFile(filename, exact);
    await store.read("t");
    const invalidUtf8 = Buffer.from(exact);
    invalidUtf8[invalidUtf8.indexOf("before")] = 255;
    const damaged = [
      Buffer.from(exact.toString().replace('"role":"user"', '"role":"xxxx"')),
      Buffer.from(exact.toString().replace('"id":"other"', '"id":"first"')),
      Buffer.from(exact.toString().replace('"sequence":0', '"sequence":x')),
      invalidUtf8,
    ];
    let parses = 0;
    let sourceReads = 0;
    const parse = JSON.parse;
    const nativeRead = fs.readFile;
    const parseMock = t.mock.method(
      JSON,
      "parse",
      (...args: Parameters<typeof JSON.parse>) => {
        parses++;
        return parse(...args);
      },
    );
    const readMock = t.mock.method(
      fs,
      "readFile",
      async (...args: Parameters<typeof nativeRead>) => {
        if (args[0] === filename) sourceReads++;
        return nativeRead(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      for (const bytes of damaged) {
        assert.equal(bytes.length, exact.length);
        await writeFile(filename, bytes);
        await assert.rejects(store.read("t"));
        await writeFile(filename, exact);
        parses = 0;
        sourceReads = 0;
        await store.withAppendSnapshot("t", async (scope) => {
          assert.deepEqual(await scope.read(), original);
        });
        assert.equal(
          parses,
          2,
          "failed public read retires the prior valid prefix",
        );
        assert.equal(sourceReads, 1, "admission always reads the current file");
      }
      await rm(filename);
      assert.deepEqual(await store.read("t"), []);
      await writeFile(filename, exact);
      parses = 0;
      await store.withAppendSnapshot("t", (scope) => scope.read());
      assert.equal(parses, 2, "missing source retires the prefix");
      const alias = path.join(root, "alias.jsonl");
      await link(filename, alias);
      await assert.rejects(store.read("t"), /unaliased regular file/);
      await rm(alias);
      parses = 0;
      await store.withAppendSnapshot("t", (scope) => scope.read());
      assert.equal(parses, 2, "ownership failure retires the prefix");
    } finally {
      parseMock.mock.restore();
      readMock.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public reads keep the same source-byte budget and one-Thread bound", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-item-public-budget-"));
  const store = new FileItemListStore(root);
  try {
    await store.create("t", [publicPrefixItem("t")]);
    await store.create("other", [publicPrefixItem("other")]);
    await store.read("t");
    await store.read("other");
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
      await store.withAppendSnapshot("t", (scope) => scope.read());
      assert.equal(
        parses,
        1,
        "a public Thread switch retires the older prefix",
      );
      const filename = path.join(root, "t.jsonl");
      await writeFile(
        filename,
        Buffer.concat([
          Buffer.alloc(32 * 1024 * 1024, 32),
          await readFile(filename),
        ]),
      );
      await store.read("t");
      parses = 0;
      await store.withAppendSnapshot("t", (scope) => scope.read());
      assert.equal(parses, 1, "oversized public read does not retain a prefix");
      await store.withAppendSnapshot("other", async (scope) => {
        assert.deepEqual(await store.read("other"), [
          publicPrefixItem("other"),
        ]);
        assert.deepEqual(await scope.read(), [publicPrefixItem("other")]);
      });
    } finally {
      mocked.mock.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const interleaving of [
  "newer-read",
  "append",
  "failed-append",
  "no-op-append",
  "missing-read",
  "older-error",
] as const) {
  test(`older public read cannot replace newer prefix ownership: ${interleaving}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-item-public-race-"));
    const store = new FileItemListStore(root, {
      onAppendPhase(phase) {
        if (interleaving === "failed-append" && phase === "temporary")
          throw new Error("Synthetic publication failure");
      },
    });
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const filename = path.join(root, "t.jsonl");
    let held = false;
    let pending: Promise<unknown> | undefined;
    try {
      await store.create("t", [publicPrefixItem("t")]);
      await store.create("other", [publicPrefixItem("other")]);
      const nativeRead = fs.readFile;
      const mocked = t.mock.method(
        fs,
        "readFile",
        async (...args: Parameters<typeof nativeRead>) => {
          const bytes = await nativeRead(...args);
          if (args[0] === filename && !held) {
            held = true;
            reached();
            await gate;
            if (interleaving === "older-error")
              throw new Error("Synthetic delayed read failure");
          }
          return bytes;
        },
      );
      syncBuiltinESMExports();
      try {
        const reading = store.read("t");
        pending = reading.catch(() => undefined);
        await captured;
        let target = "t";
        let expectedParses = 0;
        let expectedLength = 1;
        if (interleaving === "newer-read" || interleaving === "older-error") {
          target = "other";
          await store.read(target);
        } else if (interleaving === "append") {
          await store.append("t", [publicPrefixItem("t", "added")]);
          expectedLength = 2;
        } else if (interleaving === "failed-append") {
          await assert.rejects(
            store.append("t", [publicPrefixItem("t", "added")]),
            {
              name: "ThreadJournalAppendOutcomeUnknownError",
            },
          );
          expectedParses = 1;
        } else if (interleaving === "no-op-append") {
          await store.withAppendSnapshot("t", async () => {});
          expectedParses = 1;
        } else {
          assert.deepEqual(await store.read("absent"), []);
          expectedParses = 1;
        }
        release();
        if (interleaving === "older-error")
          await assert.rejects(reading, /delayed read failure/);
        else assert.deepEqual(await reading, [publicPrefixItem("t")]);
        let parses = 0;
        const parse = JSON.parse;
        const parseMock = t.mock.method(
          JSON,
          "parse",
          (...args: Parameters<typeof JSON.parse>) => {
            parses++;
            return parse(...args);
          },
        );
        try {
          await store.withAppendSnapshot(target, async (scope) => {
            assert.equal((await scope.read()).length, expectedLength);
          });
          assert.equal(
            parses,
            expectedParses,
            "older completion cannot publish or retire a newer cache",
          );
        } finally {
          parseMock.mock.restore();
        }
      } finally {
        release();
        await pending;
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    } finally {
      release();
      await pending;
      await rm(root, { recursive: true, force: true });
    }
  });
}
