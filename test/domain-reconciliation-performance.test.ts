import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileItemListStore } from "../src/item-list-store.js";
import type { CanonicalItem } from "../src/item.js";
import type { ContextItem } from "../src/item-list.js";
import { JsonlThreadMetadataStore } from "../src/thread-metadata.js";
import { FileTraceStore } from "../src/trace.js";

function facts(turns: number): CanonicalItem[] {
  const common = { threadId: "t", createdAt: "2026-11-02T00:00:00.000Z" };
  const items: CanonicalItem[] = [
    {
      ...common,
      id: "metadata",
      type: "thread_metadata",
      cwd: "/synthetic",
      provider: "fake",
      model: "fake",
      sandbox: "read-only",
      approvalPolicy: "always",
    },
  ];
  for (let index = 0; index < turns; index++) {
    const turnId = `turn-${index}`;
    items.push(
      { ...common, id: `start-${index}`, turnId, type: "turn_started" },
      {
        ...common,
        id: `user-${index}`,
        turnId,
        type: "user_message",
        clientId: `client-${index}`,
        text: `Synthetic input ${index}`,
      },
      {
        ...common,
        id: `agent-${index}`,
        turnId,
        type: "agent_message",
        text: `Synthetic output ${index}`,
      },
      {
        ...common,
        id: `end-${index}`,
        turnId,
        type: "turn_completed",
        status: "completed",
      },
    );
  }
  return items;
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-reconcile-copy-"));
  return {
    root,
    directory: path.join(root, "threads"),
    metadata: new JsonlThreadMetadataStore(path.join(root, "metadata.jsonl")),
    trace: new FileTraceStore(path.join(root, "trace")),
  };
}

test("cold Thread snapshot reads and validates Trace once for both projections", async (t) => {
  const options = await setup();
  const writer = new DomainThreadJournal(options);
  await writer.create(facts(8));
  await writer.close();
  const journal = new DomainThreadJournal(options);
  const read = t.mock.method(options.trace, "readSnapshot");
  const publicRead = t.mock.method(options.trace, "read");
  try {
    const snapshot = await journal.readSnapshot("t");
    assert.deepEqual(snapshot.items, facts(8));
    assert.equal(snapshot.itemList?.length, 16);
    assert.equal(read.mock.callCount() + publicRead.mock.callCount(), 1);
    snapshot.items[0]!.id = "caller-owned";
    assert.deepEqual((await journal.readSnapshot("t")).items, facts(8));
  } finally {
    await journal.close();
    await rm(options.root, { recursive: true, force: true });
  }
});

test("Thread snapshot and a concurrent append share the existing serialization boundary", async (t) => {
  const options = await setup();
  const journal = new DomainThreadJournal(options);
  await journal.create(facts(1));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = options.trace.readSnapshot.bind(options.trace);
  let held = false;
  const mocked = t.mock.method(
    options.trace,
    "readSnapshot",
    async (...args: Parameters<FileTraceStore["readSnapshot"]>) => {
      const snapshot = await read(...args);
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      return snapshot;
    },
  );
  try {
    const reading = journal.readSnapshot("t");
    await started;
    const appending = journal.append(nextUser("concurrent"));
    release();
    const before = await reading;
    assert.deepEqual(before.items, facts(1));
    assert.equal(before.itemList.length, 2);
    await appending;
    const after = await journal.readSnapshot("t");
    assert.deepEqual(after.items, [...facts(1), nextUser("concurrent")]);
    assert.equal(after.itemList.length, 3);
  } finally {
    release();
    mocked.mock.restore();
    await journal.close();
    await rm(options.root, { recursive: true, force: true });
  }
});

for (const turns of [32, 128]) {
  test(`compiled ${turns}-turn history does not copy context per lifecycle fact`, async (t) => {
    const options = await setup();
    const journal = new DomainThreadJournal(options);
    try {
      const original = facts(turns);
      await journal.create(original);
      const semantic = await journal.readItemList("t");
      const filename = path.join(options.directory, "items", "t.jsonl");
      const bytes = await readFile(filename);
      const observed = await options.trace.read("t");
      let iteratedEntries = 0;
      const read = FileItemListStore.prototype.read;
      const mocked = t.mock.method(
        FileItemListStore.prototype,
        "read",
        async function (this: FileItemListStore, threadId: string) {
          const items = await read.call(this, threadId);
          Object.defineProperty(items, Symbol.iterator, {
            value: function* () {
              for (let index = 0; index < items.length; index++) {
                iteratedEntries++;
                yield items[index]!;
              }
            },
          });
          // The compiler must only read this operation-local input.
          Object.freeze(items);
          return items;
        },
      );
      try {
        await journal.reconcileCompilation("t");
      } finally {
        mocked.mock.restore();
      }
      assert.ok(
        iteratedEntries <= semantic.length,
        `context iteration must be linear: ${iteratedEntries} for ${semantic.length} items`,
      );
      assert.deepEqual(await journal.read("t"), original);
      assert.deepEqual(await journal.readItemList("t"), semantic);
      assert.deepEqual(await readFile(filename), bytes);
      assert.deepEqual(await options.trace.read("t"), observed);
      t.diagnostic(
        JSON.stringify({
          turns,
          semanticItems: semantic.length,
          iteratedEntries,
        }),
      );
    } finally {
      await journal.close();
      await options.trace.flush();
      await rm(options.root, { recursive: true, force: true });
    }
  });
}

test("reconciliation restores a missing semantic suffix with exact source output", async () => {
  const options = await setup();
  let journal = new DomainThreadJournal(options);
  try {
    const original = facts(4);
    await journal.create(original);
    const semantic = await journal.readItemList("t");
    const filename = path.join(options.directory, "items", "t.jsonl");
    const bytes = await readFile(filename);
    const observed = await options.trace.read("t");
    await journal.close();
    await writeFile(
      filename,
      semantic
        .slice(0, -3)
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
    );
    journal = new DomainThreadJournal(options);
    await journal.reconcileCompilation("t");
    assert.deepEqual(await journal.read("t"), original);
    assert.deepEqual(await journal.readItemList("t"), semantic);
    assert.deepEqual(await readFile(filename), bytes);
    assert.deepEqual(await options.trace.read("t"), observed);
  } finally {
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});

test("frozen imported semantic sources remain exact and conflicts still fail closed", async () => {
  const options = await setup();
  let journal = new DomainThreadJournal(options);
  try {
    const original = facts(2);
    await journal.create(original);
    const semantic = await journal.readItemList("t");
    await journal.close();
    const directory = path.join(options.root, "frozen-threads");
    const trace = new FileTraceStore(path.join(options.root, "frozen-trace"));
    const frozen = structuredClone(semantic);
    const first = frozen[0]!;
    assert.equal(first.kind, "message");
    if (first.kind !== "message") throw new Error("Expected message fixture");
    first.content = {
      text: "Frozen imported model input",
      parts: [{ type: "text", text: "Frozen imported model input" }],
    };
    journal = new DomainThreadJournal({ ...options, directory, trace });
    await journal.create(original, frozen);
    await journal.reconcileCompilation("t");
    assert.deepEqual(await journal.readItemList("t"), frozen);
    const filename = path.join(directory, "items", "t.jsonl");
    const before = await readFile(filename);
    await trace.record({
      threadId: "t",
      type: "context_source",
      data: {
        item: { ...first, createdAt: "2026-11-01" },
        origin: "synthetic-conflict",
      },
    });
    await assert.rejects(
      journal.reconcileCompilation("t"),
      /Conflicting immutable context source/,
    );
    assert.deepEqual(await readFile(filename), before);
    await trace.flush();
  } finally {
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});

function nextUser(id: string): CanonicalItem {
  return {
    id,
    threadId: "t",
    turnId: `turn-${id}`,
    createdAt: "2026-11-02T01:00:00.000Z",
    type: "user_message",
    clientId: id,
    text: `Synthetic appended input ${id}`,
  };
}

test("append reuses only its own reconciliation reads and keeps exact receipts", async (t) => {
  const options = await setup();
  const journal = new DomainThreadJournal(options);
  try {
    const original = facts(32);
    await journal.create(original);
    let traceReads = 0;
    let semanticReads = 0;
    const readTrace = FileTraceStore.prototype.readSnapshot;
    const readItems = fs.readFile;
    const filename = path.join(options.directory, "items", "t.jsonl");
    const traceMock = t.mock.method(
      FileTraceStore.prototype,
      "readSnapshot",
      function (
        this: FileTraceStore,
        ...args: Parameters<FileTraceStore["readSnapshot"]>
      ) {
        traceReads++;
        return readTrace.apply(this, args);
      },
    );
    const itemsMock = t.mock.method(
      fs,
      "readFile",
      async (...args: Parameters<typeof readItems>) => {
        const bytes = await readItems(...args);
        if (args[0] === filename) semanticReads++;
        return bytes;
      },
    );
    syncBuiltinESMExports();
    let first: ContextItem[] = [];
    let second: ContextItem[] = [];
    try {
      first = await journal.append(nextUser("first"));
      assert.equal(traceReads, 1);
      assert.equal(semanticReads, 1);
      second = await journal.append(nextUser("second"));
      assert.equal(
        traceReads,
        2,
        "a new admission must read current Trace again",
      );
      assert.equal(
        semanticReads,
        2,
        "no semantic snapshot survives the operation",
      );
    } finally {
      traceMock.mock.restore();
      itemsMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(second, await journal.readItemList("t"));
    assert.deepEqual(second.slice(0, -1), first);
    assert.deepEqual(await journal.read("t"), [
      ...original,
      nextUser("first"),
      nextUser("second"),
    ]);
    const bytes = await readFile(
      path.join(options.directory, "items", "t.jsonl"),
    );
    const observed = await options.trace.read("t");
    await assert.rejects(
      journal.append(nextUser("second")),
      /Duplicate canonical/,
    );
    assert.deepEqual(await options.trace.read("t"), observed);
    assert.deepEqual(
      await readFile(path.join(options.directory, "items", "t.jsonl")),
      bytes,
    );
  } finally {
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});

test("append includes a repaired suffix and preserves exact frozen source bytes", async () => {
  const options = await setup();
  let journal = new DomainThreadJournal(options);
  try {
    const original = facts(3);
    await journal.create(original);
    const semantic = await journal.readItemList("t");
    await journal.close();
    const directory = path.join(options.root, "frozen-append");
    const trace = new FileTraceStore(
      path.join(options.root, "frozen-append-trace"),
    );
    const frozen = structuredClone(semantic);
    const first = frozen[0]!;
    if (first.kind !== "message") throw new Error("Expected message fixture");
    first.content = {
      text: "Exact frozen import",
      parts: [{ type: "text", text: "Exact frozen import" }],
    };
    journal = new DomainThreadJournal({ ...options, directory, trace });
    await journal.create(original, frozen);
    const filename = path.join(directory, "items", "t.jsonl");
    const bytes = await readFile(filename);
    await journal.close();
    await writeFile(
      filename,
      frozen
        .slice(0, -2)
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
    );
    journal = new DomainThreadJournal({ ...options, directory, trace });
    const receipt = await journal.append(nextUser("after-repair"));
    assert.deepEqual(receipt.slice(0, -1), frozen);
    assert.deepEqual(receipt, await journal.readItemList("t"));
    assert.deepEqual(
      (await readFile(filename)).subarray(0, bytes.length),
      bytes,
    );
    assert.equal(receipt.at(-1)?.id, "after-repair");
    await trace.flush();
  } finally {
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});

test("operation-local reads do not escape an unknown write or let close release early", async () => {
  const options = await setup();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const journal = new DomainThreadJournal({
    ...options,
    async onItemListAppendPhase(phase) {
      if (phase !== "published") return;
      entered();
      await gate;
      throw new Error("Synthetic unknown publication");
    },
  });
  try {
    await journal.create(facts(1));
    const pending = journal.append(nextUser("unknown"));
    const rejected = assert.rejects(pending, {
      name: "ThreadJournalAppendOutcomeUnknownError",
    });
    await reached;
    let closed = false;
    const closing = journal.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    release();
    await rejected;
    await closing;
    await assert.rejects(journal.append(nextUser("not-admitted")), /closed/);
    const cold = new DomainThreadJournal(options);
    try {
      await cold.assertRecoverySafe("t");
      const recovered = await cold.readItemList("t");
      assert.equal(recovered.filter((item) => item.id === "unknown").length, 1);
      assert.equal(
        recovered.some((item) => item.id === "not-admitted"),
        false,
      );
    } finally {
      await cold.close();
    }
  } finally {
    release();
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});

test("absent reconciliation keeps the public void contract and initial publication", async () => {
  const options = await setup();
  const journal = new DomainThreadJournal(options);
  try {
    assert.equal(await journal.reconcileCompilation("t"), undefined);
    assert.deepEqual(await journal.append(facts(0)[0]!), []);
    assert.deepEqual(
      await journal.append(nextUser("initial")),
      await journal.readItemList("t"),
    );
  } finally {
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});

test("cold append and recovery reuse their own verified Trace without retaining it", async (t) => {
  const options = await setup();
  let journal = new DomainThreadJournal(options);
  try {
    const original = facts(32);
    await journal.create(original);
    await journal.close();
    journal = new DomainThreadJournal(options);
    // The production Host reads a Thread before its first send. Such reads do
    // not populate the journal's live append projection.
    assert.deepEqual(await journal.read("t"), original);
    await journal.readItemList("t");
    let traceReads = 0;
    const read = options.trace.readSnapshot.bind(options.trace);
    const mocked = t.mock.method(
      options.trace,
      "readSnapshot",
      (...args: Parameters<FileTraceStore["readSnapshot"]>) => {
        traceReads++;
        return read(...args);
      },
    );
    try {
      await journal.assertRecoverySafe("t");
      assert.equal(
        traceReads,
        1,
        "cold admission validates one exact Trace observation",
      );
      await journal.assertRecoverySafe("t");
      assert.equal(
        traceReads,
        2,
        "the next admission must observe Trace again",
      );
      const first = await journal.append(nextUser("cold"));
      assert.equal(
        traceReads,
        3,
        "cold append reuses only its own reconciliation observation",
      );
      assert.equal(first.at(-1)?.id, "cold");
      await journal.append(nextUser("warm"));
      assert.equal(
        traceReads,
        4,
        "warm append must still read the current source",
      );
    } finally {
      mocked.mock.restore();
    }
    await journal.close();
    journal = new DomainThreadJournal(options);
    assert.deepEqual(await journal.read("t"), [
      ...original,
      nextUser("cold"),
      nextUser("warm"),
    ]);
    await journal.assertRecoverySafe("t");
  } finally {
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});

test("private append facts cannot be changed through caller or public read aliases", async () => {
  const options = await setup();
  const journal = new DomainThreadJournal(options);
  try {
    const original = facts(4);
    await journal.create(original);
    const input = nextUser("owned");
    const exact = structuredClone(input);
    await journal.append(input);
    input.id = "caller-mutated";
    const exposed = await journal.read("t");
    assert.deepEqual(exposed.at(-1), exact);
    exposed[0]!.id = "read-mutated";
    await journal.append(nextUser("after"));
    assert.deepEqual(await journal.read("t"), [
      ...original,
      exact,
      nextUser("after"),
    ]);
  } finally {
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});

test("recovery never treats a warm projection as proof of missing original configuration", async () => {
  const options = await setup();
  const journal = new DomainThreadJournal(options);
  try {
    await journal.create(facts(4));
    await journal.assertRecoverySafe("t");
    const directory = path.join(options.trace.directory, "threads", "t");
    for (const name of await fs.readdir(directory))
      if (name.endsWith(".jsonl"))
        await writeFile(path.join(directory, name), "");
    await assert.rejects(
      journal.assertRecoverySafe("t"),
      /Original runtime configuration unavailable/,
    );
  } finally {
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});

test("cold append preserves original fact sequence order while reusing decoded reconciliation", async () => {
  const options = await setup();
  let journal = new DomainThreadJournal(options);
  try {
    const original = facts(0);
    await journal.create(original);
    const later = nextUser("later");
    const earlier = nextUser("earlier");
    for (const [item, sequence] of [
      [later, 2],
      [earlier, 1],
    ] as const)
      await options.trace.record({
        threadId: "t",
        type: "runtime_item",
        data: { item, sequence },
      });
    await journal.close();
    journal = new DomainThreadJournal(options);
    await journal.append(nextUser("after"));
    assert.deepEqual(await journal.read("t"), [
      ...original,
      earlier,
      later,
      nextUser("after"),
    ]);
    await journal.close();
    journal = new DomainThreadJournal(options);
    assert.deepEqual(await journal.read("t"), [
      ...original,
      earlier,
      later,
      nextUser("after"),
    ]);
  } finally {
    await journal.close();
    await options.trace.flush();
    await rm(options.root, { recursive: true, force: true });
  }
});
