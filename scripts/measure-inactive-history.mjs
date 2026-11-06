// Run with: node --expose-gc --import tsx scripts/measure-inactive-history.mjs
//   <checkout> <fixture-directory> prepare|read|trace|write [thread-count=32] [idle-ms=300000]
// Fixture creation is a separate process and excluded from all read measurements.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
const [checkout, root, mode, countArg = "32", idleArg = "300000"] =
  process.argv.slice(2);
if (
  !checkout ||
  !root ||
  !["prepare", "read", "trace", "write"].includes(mode) ||
  !global.gc
)
  throw new Error(
    "Expected checkout, isolated fixture directory, mode, and --expose-gc",
  );
const source = (name) =>
  import(pathToFileURL(path.resolve(checkout, name)).href);
const [
  { DomainThreadJournal },
  { FileTraceStore },
  { InMemoryThreadMetadataStore },
] = await Promise.all([
  source("src/domain-journal.ts"),
  source("src/trace.ts"),
  source("src/thread-metadata.ts"),
]);
const count = Number(countArg),
  turns = 256,
  idleMs = Number(idleArg);
const trace = new FileTraceStore(path.join(root, "trace"));
let traceReads = 0;
for (const method of ["read", "readSnapshot"]) {
  if (!trace[method]) continue;
  const read = trace[method].bind(trace);
  trace[method] = async (...args) => {
    traceReads++;
    return read(...args);
  };
}
const journal = new DomainThreadJournal({
  directory: path.join(root, "threads"),
  trace,
  metadata: new InMemoryThreadMetadataStore(),
});
function facts(threadId) {
  const common = { threadId, createdAt: "2026-11-05T00:00:00.000Z" };
  const items = [
    {
      ...common,
      id: `${threadId}-metadata`,
      type: "thread_metadata",
      cwd: "/synthetic",
      provider: "fake",
      model: "fake",
      sandbox: "read-only",
      approvalPolicy: "never",
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
        text: `Input ${threadId} ${index}: ${"u".repeat(512)}`,
      },
      {
        ...common,
        id: `agent-${index}`,
        turnId,
        type: "agent_message",
        text: `Output ${threadId} ${index}: ${"a".repeat(1536)}`,
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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function collect() {
  for (let i = 0; i < 4; i++) {
    await pause(0);
    global.gc();
  }
}
function memory(stage, more = {}) {
  console.log(
    JSON.stringify({
      stage,
      mode,
      count,
      turns,
      node: process.version,
      platform: process.platform,
      ...process.memoryUsage(),
      peakRssKiB: process.resourceUsage().maxRSS,
      traceReads,
      ...more,
    }),
  );
}
if (mode === "prepare" || mode === "write") {
  await mkdir(root, { recursive: true });
  await collect();
  memory("before-write");
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    await journal.create(facts(`t-${i}`));
    if (mode === "write")
      await journal.append({
        id: "usage",
        threadId: `t-${i}`,
        turnId: "turn-255",
        createdAt: "2026-11-05T00:00:00.000Z",
        type: "model_usage",
        modelResponseId: "r",
        inputTokens: 1,
        outputTokens: 1,
      });
  }
  await collect();
  memory("after-write", { elapsedMs: performance.now() - started });
  if (mode === "prepare") {
    await journal.create(facts("diagnostics"));
    for (let offset = 0; offset < 12000; offset += 256)
      await trace.recordBatch(
        Array.from({ length: Math.min(256, 12000 - offset) }, (_, index) => ({
          threadId: "diagnostics",
          type: "passive-diagnostic",
          data: { text: `${offset + index}:${"x".repeat(512)}` },
        })),
      );
  }
  await journal.close();
} else {
  const { createHostedAppServer } = await source("apps/cli/src/host.ts");
  const host = createHostedAppServer({
    cwd: root,
    dataDirectory: root,
    provider: { type: "fake" },
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    toolPresentation: "direct",
    journal,
  });
  await collect();
  memory("before-open");
  const latencies = [];
  let readCpu;
  async function read(id) {
    const started = performance.now();
    const cpu = process.cpuUsage();
    const snapshot = await host.readThread(id);
    readCpu = process.cpuUsage(cpu);
    latencies.push(performance.now() - started);
    assert.equal(snapshot.turns.length, turns);
    return JSON.stringify(snapshot).length;
  }
  const bytes = await read(
    mode === "trace" && process.env.DIAGNOSTICS !== "0" ? "diagnostics" : "t-0",
  );
  await collect();
  memory("first-open", {
    latencyMs: latencies.at(-1),
    responseBytes: bytes,
    cpuUserMs: readCpu.user / 1000,
    cpuSystemMs: readCpu.system / 1000,
  });
  if (mode === "read") {
    for (let i = 1; i < count; i++) await read(`t-${i}`);
    await collect();
    memory("after-unique", {
      meanOpenMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    });
    latencies.length = 0;
    for (let i = 0; i < count * 5; i++) await read(`t-${i % count}`);
    await collect();
    memory("after-revisit", {
      meanRevisitMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    });
  }
  await pause(idleMs);
  await collect();
  memory("after-idle", { idleMs });
  if (process.env.HEAP_SNAPSHOT) {
    const { writeHeapSnapshot } = await import("node:v8");
    writeHeapSnapshot(process.env.HEAP_SNAPSHOT);
  }
  await host.closeProviderTransport();
}
