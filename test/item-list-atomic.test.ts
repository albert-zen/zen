import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  FileItemListStore,
  type ItemListAppendSnapshot,
} from "../src/item-list-store.js";
import type { ContextItem } from "../src/item-list.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const item = (id: string): ContextItem => ({
  id,
  threadId: "t",
  createdAt: "2026-10-27",
  kind: "message",
  role: "user",
  content: {
    text: "中文 exact",
    parts: [{ type: "text", text: "中文 exact" }],
  },
  source: { kind: "user_message", sequence: 0 },
});
test("semantic append preserves exact prior bytes and rejects duplicate/tail corruption", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-items-"));
  const store = new FileItemListStore(dir);
  await store.create("t", []);
  const original = Buffer.from(" " + JSON.stringify(item("a")) + "\r\n");
  await writeFile(path.join(dir, "t.jsonl"), original);
  await store.append("t", [item("b")]);
  assert.deepEqual(
    (await readFile(path.join(dir, "t.jsonl"))).subarray(0, original.length),
    original,
  );
  await assert.rejects(store.append("t", [item("b")]), /duplicate/);
  await writeFile(path.join(dir, "t.jsonl"), original.subarray(0, -1));
  await assert.rejects(store.append("t", [item("c")]), /tail/);
});
for (const phase of ["temporary", "published", "synced"] as const)
  test(`atomic failure ${phase} exposes complete old or new semantic bytes`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "zen-items-"));
    await new FileItemListStore(dir).create("t", [item("a")]);
    const store = new FileItemListStore(dir, {
      onAppendPhase(p) {
        if (p === phase) throw new Error("injected");
      },
    });
    await assert.rejects(store.append("t", [item("b")]), {
      name: "ThreadJournalAppendOutcomeUnknownError",
    });
    assert.equal(
      (await new FileItemListStore(dir).read("t")).length,
      phase === "temporary" ? 1 : 2,
    );
  });

test("larger history publication preserves every prior byte (write amplification measured, not a latency promise)", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-items-large-"));
  const store = new FileItemListStore(directory);
  const history = Array.from({ length: 1500 }, (_, index) => {
    const value = item(String(index));
    if (value.kind === "message") {
      value.content.text = "文".repeat(1000);
      value.content.parts = [{ type: "text", text: value.content.text }];
    }
    return value;
  });
  await store.create("t", history);
  const before = await readFile(path.join(directory, "t.jsonl"));
  const start = performance.now();
  await store.append("t", [item("last")]);
  const elapsed = performance.now() - start;
  const after = await readFile(path.join(directory, "t.jsonl"));
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.equal((await store.read("t")).length, 1501);
  t.diagnostic(
    `${before.length} prior bytes rewritten atomically in ${elapsed.toFixed(1)}ms on this synthetic cloud run`,
  );
});

test("append snapshot refreshes exact bytes after each publication and expires on return", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-item-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir);
  const filename = path.join(dir, "t.jsonl");
  const original = Buffer.from(" " + JSON.stringify(item("a")) + "\r\n");
  await writeFile(filename, original);
  let escaped: ItemListAppendSnapshot | undefined;
  await store.withAppendSnapshot("t", async (scope) => {
    escaped = scope;
    const observed = await scope.read();
    assert.throws(() => {
      observed[0]!.id = "mutated";
    }, TypeError);
    assert.throws(() => {
      observed[0]!.source.sequence = 99;
    }, TypeError);
    assert.throws(() => {
      (observed[0]!.content as { text: string }).text = "mutated";
    }, TypeError);
    assert.deepEqual(
      (await scope.read()).map((i) => i.id),
      ["a"],
    );
    await scope.append([item("repair")]);
    assert.deepEqual(
      (await scope.read()).map((i) => i.id),
      ["a", "repair"],
    );
    await scope.append([item("new")]);
  });
  const bytes = await readFile(filename);
  assert.deepEqual(bytes.subarray(0, original.length), original);
  assert.deepEqual(
    (await store.read("t")).map((i) => i.id),
    ["a", "repair", "new"],
  );
  await assert.rejects(escaped!.read(), /inactive/);
  await assert.rejects(escaped!.append([item("late")]), /inactive/);
  await writeFile(filename, bytes.subarray(0, -1));
  await assert.rejects(
    store.withAppendSnapshot("t", (scope) => scope.read()),
    /tail/,
  );
});

test("append snapshot holds the existing write lane until its callback settles", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-item-lane-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir);
  await store.create("t", [item("a")]);
  const entered = deferred();
  const release = deferred();
  const scoped = store.withAppendSnapshot("t", async (scope) => {
    await scope.read();
    entered.resolve();
    await release.promise;
    await scope.append([item("scoped")]);
  });
  await entered.promise;
  let nextSettled = false;
  const next = store.append("t", [item("following")]).then(() => {
    nextSettled = true;
  });
  assert.equal(nextSettled, false);
  release.resolve();
  await Promise.all([scoped, next]);
  assert.deepEqual(
    (await store.read("t")).map((i) => i.id),
    ["a", "scoped", "following"],
  );
});

for (const phase of ["temporary", "published", "synced"] as const)
  test(`append snapshot cannot reuse an uncertain ${phase} publication`, async (t) => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "zen-item-snapshot-failure-"),
    );
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new FileItemListStore(dir, {
      onAppendPhase(p) {
        if (p === phase) throw new Error("injected");
      },
    });
    await store.create("t", [item("a")]);
    let escaped: ItemListAppendSnapshot | undefined;
    await assert.rejects(
      store.withAppendSnapshot("t", async (scope) => {
        escaped = scope;
        await scope.read();
        await assert.rejects(scope.append([item("b")]), {
          name: "ThreadJournalAppendOutcomeUnknownError",
        });
        await assert.rejects(scope.read(), /inactive/);
        await assert.rejects(scope.append([item("retry")]), /inactive/);
      }),
      { name: "ThreadJournalAppendOutcomeUnknownError" },
    );
    await assert.rejects(escaped!.read(), /inactive/);
    assert.deepEqual(
      (await new FileItemListStore(dir).read("t")).map((i) => i.id),
      phase === "temporary" ? ["a"] : ["a", "b"],
    );
  });

test("append snapshot does not retain absent bytes or survive callback failure", async (t) => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "zen-item-snapshot-absent-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir);
  let escaped: ItemListAppendSnapshot | undefined;
  await store.withAppendSnapshot("t", async (scope) => {
    assert.deepEqual(await scope.read(), []);
    await store.create("t", [item("created")]);
    await scope.append([item("appended")]);
  });
  await assert.rejects(
    store.withAppendSnapshot("t", async (scope) => {
      escaped = scope;
      await scope.read();
      throw new Error("callback failed");
    }),
    /callback failed/,
  );
  await assert.rejects(escaped!.append([item("late")]), /inactive/);
  await assert.rejects(
    store.withAppendSnapshot("t", async (scope) => {
      await scope.read();
      await unlink(path.join(dir, "t.jsonl"));
      await scope.append([item("must-not-recreate")]);
    }),
    { code: "ENOENT" },
  );
  assert.equal(await store.exists("t"), false);
});

test("append snapshot drains an admitted publication before releasing its lane", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-item-snapshot-drain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const publishing = deferred();
  const release = deferred();
  let block = true;
  const store = new FileItemListStore(dir, {
    async onAppendPhase(phase) {
      if (phase === "temporary" && block) {
        block = false;
        publishing.resolve();
        await release.promise;
      }
    },
  });
  await store.create("t", [item("a")]);
  let escaped: ItemListAppendSnapshot | undefined;
  const operation = store.withAppendSnapshot("t", async (scope) => {
    escaped = scope;
    void scope.append([item("admitted")]);
    await publishing.promise;
  });
  await publishing.promise;
  const next = store.append("t", [item("following")]);
  await Promise.resolve();
  await assert.rejects(escaped!.read(), /inactive|busy/);
  release.resolve();
  await Promise.all([operation, next]);
  assert.deepEqual(
    (await store.read("t")).map((i) => i.id),
    ["a", "admitted", "following"],
  );
});

test("unawaited scoped publication failure is still an unknown operation result", async (t) => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "zen-item-snapshot-unawaited-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir, {
    onAppendPhase(phase) {
      if (phase === "published") throw new Error("injected");
    },
  });
  await store.create("t", [item("a")]);
  await assert.rejects(
    store.withAppendSnapshot("t", async (scope) => {
      void scope.append([item("b")]);
    }),
    { name: "ThreadJournalAppendOutcomeUnknownError" },
  );
  assert.deepEqual(
    (await store.read("t")).map((i) => i.id),
    ["a", "b"],
  );
});

test("semantic decode clones each stored item once per fresh read", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-item-decode-count-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir);
  await store.create(
    "t",
    Array.from({ length: 40 }, (_, i) => item(`old-${i}`)),
  );
  const clone = globalThis.structuredClone;
  const parse = JSON.parse;
  let clones = 0;
  let parses = 0;
  const countedClone = t.mock.method(
    globalThis,
    "structuredClone",
    (...args: Parameters<typeof clone>) => {
      clones++;
      return clone(...args);
    },
  );
  const countedParse = t.mock.method(
    JSON,
    "parse",
    (...args: Parameters<typeof parse>) => {
      parses++;
      return parse(...args);
    },
  );
  const counts: { clones: number; parses: number }[] = [];
  const capture = () => {
    counts.push({ clones, parses });
    clones = 0;
    parses = 0;
  };
  try {
    await store.read("t");
    capture();
    await store.withAppendSnapshot("t", async (scope) => {
      await scope.read();
      capture();
      await scope.read();
      capture();
    });
    await store.withAppendSnapshot("t", (scope) => scope.read());
    capture();
  } finally {
    countedClone.mock.restore();
    countedParse.mock.restore();
  }
  t.diagnostic(JSON.stringify({ counts }));
  assert.deepEqual(counts, [
    { clones: 40, parses: 40 },
    { clones: 40, parses: 40 },
    { clones: 0, parses: 0 },
    { clones: 40, parses: 40 },
  ]);
});

test("append snapshot validates new suffixes without decoding its immutable prefix again", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-item-prefix-count-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir);
  const filename = path.join(dir, "t.jsonl");
  const original = Buffer.from(
    Array.from(
      { length: 40 },
      (_, i) => " " + JSON.stringify(item(`old-${i}`)) + "\r\n",
    ).join(""),
  );
  await writeFile(filename, original);
  const clones = new Map<string, number>();
  const clone = globalThis.structuredClone;
  const parse = JSON.parse;
  let parses = 0;
  await store.withAppendSnapshot("t", async (scope) => {
    await scope.read();
    const countedClone = t.mock.method(
      globalThis,
      "structuredClone",
      (...args: Parameters<typeof clone>) => {
        const value = args[0] as { id: string };
        clones.set(value.id, (clones.get(value.id) ?? 0) + 1);
        return clone(...args);
      },
    );
    const countedParse = t.mock.method(
      JSON,
      "parse",
      (...args: Parameters<typeof parse>) => {
        parses++;
        return parse(...args);
      },
    );
    try {
      await scope.append([item("repair")]);
      assert.equal((await scope.read()).at(-1)?.id, "repair");
      await scope.append([item("new")]);
    } finally {
      countedClone.mock.restore();
      countedParse.mock.restore();
    }
  });
  const oldClones = [...clones]
    .filter(([id]) => id.startsWith("old-"))
    .reduce((total, [, count]) => total + count, 0);
  const counted = {
    oldClones,
    repairClones: clones.get("repair"),
    newClones: clones.get("new"),
    parses,
  };
  t.diagnostic(JSON.stringify(counted));
  assert.deepEqual(counted, {
    oldClones: 0,
    repairClones: 2,
    newClones: 2,
    parses: 0,
  });
  assert.deepEqual(
    (await readFile(filename)).subarray(0, original.length),
    original,
  );
  assert.equal((await store.read("t")).length, 42);
});

test("append snapshot rejects old, new-batch and successfully repaired identity collisions", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-item-prefix-ids-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir);
  await store.create("t", [item("old")]);
  for (const suffix of [
    [item("old")],
    [item("same"), item("same")],
    [{ ...item("other"), threadId: "other" }],
  ]) {
    await assert.rejects(
      store.withAppendSnapshot("t", async (scope) => {
        await scope.read();
        await scope.append(suffix);
      }),
      /Mixed Thread or duplicate semantic identity/,
    );
    assert.deepEqual(
      (await store.read("t")).map((value) => value.id),
      ["old"],
    );
  }
  await assert.rejects(
    store.withAppendSnapshot("t", async (scope) => {
      await scope.read();
      await scope.append([item("repair")]);
      await assert.rejects(scope.append([item("repair")]), /duplicate/);
      await assert.rejects(scope.append([item("after-failure")]), /inactive/);
    }),
    /duplicate/,
  );
  assert.deepEqual(
    (await store.read("t")).map((value) => value.id),
    ["old", "repair"],
  );
  const parse = JSON.parse;
  let parses = 0;
  const countedParse = t.mock.method(
    JSON,
    "parse",
    (...args: Parameters<typeof parse>) => {
      parses++;
      return parse(...args);
    },
  );
  try {
    await store.withAppendSnapshot("t", async (scope) => {
      assert.deepEqual(
        (await scope.read()).map((value) => value.id),
        ["old", "repair"],
      );
      await scope.append([item("following")]);
    });
    assert.equal(
      parses,
      2,
      "the next scope parses its complete durable prefix",
    );
  } finally {
    countedParse.mock.restore();
  }
  assert.deepEqual(
    (await store.read("t")).map((value) => value.id),
    ["old", "repair", "following"],
  );
});

test("semantic decoding completes schema parsing before identity rejection", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-item-decode-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir);
  const filename = path.join(dir, "t.jsonl");
  const prefix =
    [item("same"), item("same")]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n";
  await writeFile(filename, prefix + "not-json\n");
  await assert.rejects(store.read("t"), SyntaxError);
  await writeFile(
    filename,
    prefix + JSON.stringify({ ...item("invalid"), role: "invalid" }) + "\n",
  );
  await assert.rejects(store.read("t"), /Invalid message role/);
  await writeFile(filename, prefix);
  await assert.rejects(store.read("t"), /duplicate/);
  await writeFile(
    filename,
    JSON.stringify({ ...item("other"), threadId: "other" }) + "\n",
  );
  await assert.rejects(store.read("t"), /Mixed Thread/);
});

test("append snapshot validates the detached suffix after accessor capture", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-item-suffix-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir);
  await store.create("t", []);
  const value = item("getter");
  let reads = 0;
  Object.defineProperty(value, "content", {
    enumerable: true,
    get() {
      reads++;
      return {
        text: reads === 1 ? "valid" : "invalid",
        parts: [{ type: "text", text: "valid" }],
      };
    },
  });
  await assert.rejects(
    store.withAppendSnapshot("t", (scope) => scope.append([value])),
    /content.text must exactly match/,
  );
  assert.equal(reads, 2);
  assert.deepEqual(await store.read("t"), []);
});

test("public semantic append captures caller objects before waiting for the write lane", async (t) => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "zen-item-prequeue-capture-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileItemListStore(dir);
  await store.create("t", []);
  const entered = deferred();
  const release = deferred();
  const holding = store.withAppendSnapshot("t", async (scope) => {
    await scope.read();
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const value = item("captured");
  const expected = structuredClone(value);
  const queued = store.append("t", [value]);
  value.id = "mutated";
  value.source.sequence = 999;
  if (value.kind !== "message") throw new Error("Expected message");
  value.content.text = "mutated";
  release.resolve();
  await Promise.all([holding, queued]);
  assert.deepEqual(await store.read("t"), [expected]);
});
