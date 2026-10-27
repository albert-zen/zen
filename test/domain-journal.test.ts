import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
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

test("original accepted result log survives real child crash before projection; native restart recompiles without effect replay", async () => {
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
    [...process.execArgv, fixture, options.root],
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
  assert.doesNotMatch(before, /accepted exact effect/);
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
