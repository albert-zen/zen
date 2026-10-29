import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore, type TraceEvent } from "../src/trace.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { JsonlThreadJournal } from "../src/journal.js";
import type { CanonicalItem } from "../src/item.js";
const metadata: CanonicalItem = {
  id: "meta",
  threadId: "t",
  createdAt: "2026-10-27",
  type: "thread_metadata",
  cwd: "/synthetic",
  provider: "p",
  model: "m",
  sandbox: "read-only",
  approvalPolicy: "always",
};
const user: CanonicalItem = {
  id: "u",
  threadId: "t",
  turnId: "turn",
  createdAt: "2026-10-27",
  type: "user_message",
  text: "中文 original UUID 12345678-1234-1234-1234-123456789abc",
};
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-domain-"));
  const directory = path.join(root, "threads");
  const trace = new FileTraceStore(path.join(root, "trace"));
  const product = new InMemoryThreadMetadataStore();
  return { root, directory, trace, metadata: product };
}
test("new writes route semantic-only ItemList and durable operational Trace; restart without snapshot", async () => {
  const options = await setup();
  const journal = new DomainThreadJournal(options);
  await journal.append(metadata);
  await journal.append(user);
  const semantic = await journal.readItemList("t");
  assert.equal(semantic.length, 1);
  assert.equal(semantic[0]?.source.kind, "user_message");
  assert.match(
    (semantic[0]?.content as { text: string }).text,
    /中文 original/,
  );
  assert.equal(
    (await options.trace.read("t")).records.filter(
      (r) => r.type === "runtime_item",
    ).length,
    2,
  );
  await journal.close();
  const cold = new DomainThreadJournal(options);
  assert.deepEqual(await cold.read("t"), [metadata, user]);
  await cold.assertRecoverySafe("t");
  await cold.close();
  assert.rejects(new JsonlThreadJournal(options.directory).read("t"));
});
test("critical Trace failure never ACKs or silently reuses stale current state; ordinary observation may degrade", async () => {
  const options = await setup();
  let failing = "";
  const trace = {
    read: options.trace.read.bind(options.trace),
    readArtifact: options.trace.readArtifact.bind(options.trace),
    record: async (event: TraceEvent) =>
      event.type === "runtime_item" &&
      (event.data as { item: { type: string } }).item.type === failing
        ? { durability: "degraded" as const, error: "injected" }
        : options.trace.record(event),
  };
  const journal = new DomainThreadJournal({ ...options, trace });
  await journal.append(metadata);
  failing = "model_usage";
  await journal.append({
    id: "usage",
    threadId: "t",
    turnId: "turn",
    createdAt: "2026-10-27",
    type: "model_usage",
    modelResponseId: "r",
    inputTokens: 1,
    outputTokens: 1,
  });
  failing = "user_message_queued";
  await assert.rejects(
    journal.append({
      id: "q",
      threadId: "t",
      createdAt: "2026-10-27",
      type: "user_message_queued",
      clientId: "c",
      input: [{ type: "text", text: "queued" }],
      deliveryMode: "batch-next",
    }),
    { name: "ThreadJournalAppendOutcomeUnknownError" },
  );
  await assert.rejects(journal.assertRecoverySafe("t"), /unknown/);
  await journal.close();
});
for (const phase of ["archived", "traced", "fenced", "published"] as const)
  test(`legacy migration resumes after ${phase} without rewriting original bytes`, async () => {
    const options = await setup();
    await mkdir(options.directory, { recursive: true });
    const bytes = Buffer.from(
      [metadata, user].map((item) => " " + JSON.stringify(item)).join("\r\n") +
        "\r\n",
    );
    await writeFile(path.join(options.directory, "t.jsonl"), bytes);
    let failed = false;
    const journal = new DomainThreadJournal({
      ...options,
      onMigrationPhase(p) {
        if (p === phase && !failed) {
          failed = true;
          throw new Error("injected");
        }
      },
    });
    await assert.rejects(journal.migrate("t"), /injected/);
    await journal.close();
    const cold = new DomainThreadJournal(options);
    await cold.migrate("t");
    await cold.migrate("t");
    assert.deepEqual(await cold.read("t"), [metadata, user]);
    assert.deepEqual(
      await readFile(path.join(options.directory, "legacy", "t.jsonl")),
      bytes,
    );
    const archive = (await options.trace.read("t")).records.find(
      (r) => r.type === "legacy_archive",
    )!;
    assert.equal(
      (archive.data as { actualHistoricalWire: string }).actualHistoricalWire,
      "unavailable",
    );
    await cold.close();
  });
test("unsupported intermediate journal preflight leaves original bytes and Trace unchanged", async () => {
  const options = await setup();
  await mkdir(options.directory, { recursive: true });
  const bytes = Buffer.from('{"type":"model_operation","threadId":"t"}\n');
  await writeFile(path.join(options.directory, "t.jsonl"), bytes);
  const journal = new DomainThreadJournal(options);
  await assert.rejects(journal.migrate("t"));
  assert.deepEqual(
    await readFile(path.join(options.directory, "t.jsonl")),
    bytes,
  );
  assert.equal((await options.trace.read("t")).records.length, 0);
  await journal.close();
});

test("writer ownership is released only after accepted in-flight I/O drains", async () => {
  const options = await setup();
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    unblock = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const trace = {
    read: options.trace.read.bind(options.trace),
    readArtifact: options.trace.readArtifact.bind(options.trace),
    record: async (event: TraceEvent) => {
      entered();
      await gate;
      return options.trace.record(event);
    },
  };
  const owner = new DomainThreadJournal({ ...options, trace });
  const pending = owner.append(metadata);
  await started;
  const closing = owner.close();
  assert.throws(() => new DomainThreadJournal(options), /already owned/);
  unblock();
  await pending;
  await closing;
  const next = new DomainThreadJournal(options);
  assert.deepEqual(await next.read("t"), [metadata]);
  await next.close();
});

for (const phase of ["temporary", "published", "synced"] as const)
  test(`original accepted result survives child crash ${phase}; restart never replays effect`, async () => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const options = await setup();
    const fixture = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./domain-accepted-crash-child.ts"
          : "./domain-accepted-crash-child.js",
        import.meta.url,
      ),
    );
    const child = spawn(
      process.execPath,
      [...process.execArgv, fixture, options.root, phase],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 91, stderr);
    const cold = new DomainThreadJournal(options);
    const original = await cold.read("t");
    assert.equal(original.at(-1)?.type, "tool_result");
    const before = await readFile(
      path.join(options.directory, "items", "t.jsonl"),
      "utf8",
    );
    if (phase === "temporary")
      assert.doesNotMatch(before, /accepted exact effect/);
    else assert.match(before, /accepted exact effect/);
    const compiled = await cold.readItemList("t");
    assert.equal(compiled.at(-1)?.source.kind, "tool_result");
    assert.match(
      JSON.stringify(compiled.at(-1)?.content),
      /accepted exact effect result 中文/,
    );
    assert.equal(
      await readFile(path.join(options.root, "effect-count"), "utf8"),
      "1",
    );
    await cold.reconcileCompilation("t");
    assert.deepEqual(await cold.readItemList("t"), compiled);
    await cold.close();
  });
test("accepted semantic source failure does not publish a fabricated ItemList input", async () => {
  const options = await setup();
  const journal = new DomainThreadJournal({
    ...options,
    trace: {
      read: options.trace.read.bind(options.trace),
      readArtifact: options.trace.readArtifact.bind(options.trace),
      record: async (event) =>
        event.type === "runtime_item" &&
        (event.data as { item: { id: string } }).item.id === "u"
          ? { durability: "degraded", error: "source not durable" }
          : options.trace.record(event),
    },
  });
  await journal.append(metadata);
  await assert.rejects(journal.append(user), {
    name: "ThreadJournalAppendOutcomeUnknownError",
  });
  assert.deepEqual(await journal.readItemList("t"), []);
  await journal.close();
});

test("append receipt is the exact durable semantic snapshot, including separately appended sources", async () => {
  const options = await setup();
  const journal = new DomainThreadJournal(options);
  try {
    assert.deepEqual(await journal.append(metadata), []);
    const first = await journal.append(user);
    assert.deepEqual(first, await journal.readItemList("t"));
    const initialMessage = first[0]!;
    assert.ok(initialMessage.kind === "message");
    const source = {
      ...initialMessage,
      id: "host-source",
      content: {
        text: "Synthetic separately persisted model input",
        parts: [
          {
            type: "text" as const,
            text: "Synthetic separately persisted model input",
          },
        ],
      },
    };
    await journal.appendContext(source);
    const next = await journal.append({
      ...user,
      id: "u-next",
      text: "Next original input",
    });
    assert.deepEqual(next, await journal.readItemList("t"));
    assert.deepEqual(
      next.map((item) => item.id),
      ["u", "host-source", "u-next"],
    );
    first.splice(0);
    assert.equal(
      (await journal.readItemList("t")).length,
      3,
      "receipt is not a retained authority/cache",
    );
  } finally {
    await journal.close();
  }
});

test("append never publishes a receipt before semantic durability and never returns one on unknown write outcome", async () => {
  const options = await setup();
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const journal = new DomainThreadJournal({
    ...options,
    onItemListAppendPhase: async (phase) => {
      if (phase !== "published") return;
      entered();
      await gate;
      throw new Error("Synthetic uncertain semantic sync");
    },
  });
  try {
    await journal.append(metadata);
    let receiptReturned = false;
    const append = journal.append(user).then((receipt) => {
      receiptReturned = true;
      return receipt;
    });
    const rejected = assert.rejects(append, {
      name: "ThreadJournalAppendOutcomeUnknownError",
    });
    await writing;
    assert.equal(receiptReturned, false);
    release();
    await rejected;
    assert.equal(receiptReturned, false);
    await assert.rejects(
      journal.append({ ...user, id: "must-not-dispatch" }),
      /unknown|injected|Synthetic/u,
    );
  } finally {
    release();
    await journal.close();
  }
});

test("initial creation batches existing Trace records and waits for durability before publication", async () => {
  const options = await setup();
  const facts: CanonicalItem[] = [
    metadata,
    ...Array.from({ length: 260 }, (_, index) => ({
      ...user,
      id: `u-${index}`,
    })),
  ];
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batches: number[] = [];
  let acknowledged = false;
  const journal = new DomainThreadJournal({
    ...options,
    trace: {
      read: options.trace.read.bind(options.trace),
      readArtifact: options.trace.readArtifact.bind(options.trace),
      record: options.trace.record.bind(options.trace),
      recordBatch: async (events: readonly TraceEvent[]) => {
        batches.push(events.length);
        entered();
        await gate;
        return await Promise.all(
          events.map((event) => options.trace.record(event)),
        );
      },
    },
  });
  const creation = journal.create(facts).then(() => {
    acknowledged = true;
  });
  try {
    await Promise.race([reached, creation]);
    assert.ok(
      batches.length > 0,
      "initial creation must use the batch observation port",
    );
    assert.equal(acknowledged, false);
    assert.deepEqual(await journal.listThreadIds(), []);
    await assert.rejects(readFile(path.join(options.directory, "t.jsonl")), {
      code: "ENOENT",
    });
    release();
    await creation;
    assert.ok(batches.every((count) => count <= 256));
    assert.ok(batches.length >= 2);
    assert.deepEqual(await journal.read("t"), facts);
    await journal.close();
    const cold = new DomainThreadJournal(options);
    assert.deepEqual(await cold.read("t"), facts);
    assert.equal((await cold.readItemList("t")).length, 260);
    await cold.close();
  } finally {
    release();
    await creation.catch(() => undefined);
    await journal.close();
  }
});

test("partial initial Trace publication never becomes a cold Thread and cannot be overwritten by retry", async () => {
  const options = await setup();
  const facts = [metadata, user];
  const journal = new DomainThreadJournal({
    ...options,
    trace: {
      read: options.trace.read.bind(options.trace),
      readArtifact: options.trace.readArtifact.bind(options.trace),
      record: options.trace.record.bind(options.trace),
      recordBatch: async (events: readonly TraceEvent[]) => {
        await options.trace.record(events[0]!);
        return events.map(() => ({
          durability: "degraded" as const,
          error: "Synthetic partial initial batch",
        }));
      },
    },
  });
  try {
    await assert.rejects(journal.create(facts), {
      name: "ThreadJournalAppendOutcomeUnknownError",
    });
    assert.deepEqual(await journal.listThreadIds(), []);
    assert.deepEqual(await journal.read("t"), []);
    await assert.rejects(
      journal.create(facts),
      /unknown|incomplete|reconcile/i,
    );
  } finally {
    await journal.close();
  }
  const cold = new DomainThreadJournal({
    ...options,
    trace: new FileTraceStore(options.trace.directory),
  });
  try {
    assert.deepEqual(await cold.listThreadIds(), []);
    assert.deepEqual(await cold.read("t"), []);
    await assert.rejects(
      cold.readItemList("t"),
      /publication|incomplete|unknown/i,
    );
    await assert.rejects(
      cold.assertRecoverySafe("t"),
      /publication|incomplete|unknown/i,
    );
    await assert.rejects(cold.create(facts), /publication|incomplete|unknown/i);
    await assert.rejects(
      cold.append(metadata),
      /publication|incomplete|unknown/i,
    );
    assert.deepEqual(await cold.listThreadIds(), []);
    assert.equal(
      (await options.trace.read("t")).records.length,
      1,
      "retry must not append to an uncertain initial identity",
    );
  } finally {
    await cold.close();
  }
});

test("initial serial fallback also requires every observation to be durable", async () => {
  const options = await setup();
  const journal = new DomainThreadJournal({
    ...options,
    trace: {
      read: options.trace.read.bind(options.trace),
      readArtifact: options.trace.readArtifact.bind(options.trace),
      record: async (event: TraceEvent) =>
        (event.data as { item?: { type: string } }).item?.type === "model_usage"
          ? {
              durability: "degraded" as const,
              error: "Synthetic initial usage write failure",
            }
          : options.trace.record(event),
    },
  });
  try {
    await assert.rejects(
      journal.create([
        metadata,
        user,
        {
          ...user,
          id: "usage",
          type: "model_usage",
          modelResponseId: "response",
          inputTokens: 1,
          outputTokens: 1,
        },
      ]),
      { name: "ThreadJournalAppendOutcomeUnknownError" },
    );
    assert.deepEqual(await journal.listThreadIds(), []);
  } finally {
    await journal.close();
  }
});

test("real later-batch fsync failure leaves a completed-looking initial copy unpublished after cold restart", async (t) => {
  const options = await setup();
  const probe = await open(path.join(options.root, "prototype"), "wx");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const sync = prototype.sync;
  let fileSyncs = 0;
  const injected = t.mock.method(
    prototype,
    "sync",
    async function (this: FileHandle) {
      if ((await this.stat()).isFile() && ++fileSyncs === 2)
        throw Error("Synthetic second initial batch fsync failure");
      await sync.call(this);
    },
  );
  const journal = new DomainThreadJournal(options);
  const facts: CanonicalItem[] = [
    metadata,
    ...Array.from({ length: 260 }, (_, index) => ({
      ...user,
      id: `u-${index}`,
    })),
    {
      ...user,
      id: "final",
      type: "agent_message",
      text: "Completed-looking copied answer",
    },
    { ...user, id: "end", type: "turn_completed", status: "completed" },
  ];
  try {
    await assert.rejects(
      journal.create(facts),
      /second initial batch fsync failure/,
    );
    assert.deepEqual(await journal.listThreadIds(), []);
  } finally {
    injected.mock.restore();
    await journal.close();
  }
  const observed = await new FileTraceStore(options.trace.directory).read("t");
  assert.equal(
    observed.completeness,
    "complete",
    "all JSONL frames may be readable even though fsync was not confirmed",
  );
  assert.equal(
    (observed.records.at(-1)?.data as { item: CanonicalItem }).item.type,
    "turn_completed",
  );
  const cold = new DomainThreadJournal({
    ...options,
    trace: new FileTraceStore(options.trace.directory),
  });
  try {
    assert.deepEqual(await cold.listThreadIds(), []);
    assert.deepEqual(await cold.read("t"), []);
    await assert.rejects(cold.readItemList("t"), /no publication fence/);
    await assert.rejects(cold.create(facts), /incomplete/);
    assert.deepEqual(await cold.listThreadIds(), []);
  } finally {
    await cold.close();
  }
});

test("an exact frozen ItemList does not bypass original canonical relational validation", async () => {
  const options = await setup();
  const journal = new DomainThreadJournal(options);
  try {
    await assert.rejects(
      journal.create(
        [
          metadata,
          user,
          {
            threadId: user.threadId,
            createdAt: user.createdAt,
            id: "invalid-compaction",
            type: "context_compaction",
            providerProfileId: "p",
            modelId: "m",
            reasoningEffort: "medium",
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
            initiator: "human",
            algorithmVersion: "zen.context-compaction.v3",
            coveredThroughItemId: user.id,
            retainedItemIds: ["missing-original-item"],
            summary: "Exact supplied summary",
          },
        ],
        [],
      ),
      /missing|unavailable|retained|Unknown|Unknown retained/i,
    );
    assert.deepEqual(await journal.listThreadIds(), []);
    assert.equal((await options.trace.read("t")).records.length, 0);
  } finally {
    await journal.close();
  }
});
