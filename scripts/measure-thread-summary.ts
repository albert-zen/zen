/** Synthetic Host-only sidebar benchmark. No Provider/tools, user files or UI paint claims.
 * Prepare once: node --import tsx scripts/measure-thread-summary.ts prepare /tmp/fixture 32 256
 * Measure fresh processes: node --expose-gc --import tsx scripts/measure-thread-summary.ts measure /tmp/fixture
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ZenAppServer } from "../src/app-server.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import type { CanonicalItem } from "../src/item.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { FakeModel } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { JsonlThreadMetadataStore } from "../src/thread-metadata.js";
import { JsonThreadSummaryProjection } from "../src/thread-summary.js";
import { FileTraceStore } from "../src/trace.js";
import { ToolEnvironment } from "../src/tool.js";

const [mode, root, countArgument = "32", turnsArgument = "256"] =
  process.argv.slice(2);
if (!root || !["prepare", "measure"].includes(mode ?? ""))
  throw new Error("Use prepare|measure PATH [THREADS TURNS]");
const count = Number(countArgument),
  turnCount = Number(turnsArgument);
assert(Number.isSafeInteger(count) && count > 0 && count <= 256);
assert(Number.isSafeInteger(turnCount) && turnCount > 0 && turnCount <= 1200);
const metadata = new JsonlThreadMetadataStore(
  path.join(root, "metadata.jsonl"),
);
const trace = new FileTraceStore(path.join(root, "trace"));
const journal = new DomainThreadJournal({
  directory: path.join(root, "threads"),
  metadata,
  trace,
  ...(mode === "measure" ? { access: "read-only" as const } : {}),
});
const projection = new JsonThreadSummaryProjection(
  path.join(root, "summaries.json"),
);
if (mode === "prepare") {
  await mkdir(root, { recursive: true });
  for (let index = 0; index < count; index++) {
    const threadId = `synthetic-${index}`;
    const createdAt = "2026-11-05T00:00:00.000Z";
    const items: CanonicalItem[] = [
      {
        id: `${threadId}-metadata`,
        threadId,
        createdAt,
        type: "thread_metadata",
        cwd: root,
        provider: "fake",
        model: "fake",
        sandbox: "read-only",
        approvalPolicy: "always",
      },
    ];
    for (let turn = 0; turn < turnCount; turn++) {
      const turnId = `${threadId}-turn-${turn}`;
      const base = {
        threadId,
        turnId,
        createdAt: new Date(Date.parse(createdAt) + turn * 1000).toISOString(),
      };
      items.push(
        { ...base, id: `${turnId}-start`, type: "turn_started" },
        {
          ...base,
          id: `${turnId}-user`,
          type: "user_message",
          text: "u".repeat(1024),
        },
        {
          ...base,
          id: `${turnId}-agent`,
          type: "agent_message",
          text: "a".repeat(1024),
          modelResponseId: `${turnId}-response`,
        },
        {
          ...base,
          id: `${turnId}-end`,
          type: "turn_completed",
          status: "completed",
        },
      );
    }
    await journal.create(items);
    if (index >= Math.ceil(count / 4))
      await metadata.setArchived(threadId, true);
  }
}
let journalReads = 0,
  itemListReads = 0;
const observed = {
  append: journal.append.bind(journal),
  listThreadIds: journal.listThreadIds.bind(journal),
  summarySourceRevision: journal.summarySourceRevision?.bind(journal),
  read: async (id: string) => {
    journalReads++;
    return journal.read(id);
  },
  readItemList: async (id: string) => {
    itemListReads++;
    return journal.readItemList(id);
  },
};
const started = performance.now();
const server = new ZenAppServer({
  journal: observed,
  runtime: new AgentRuntime({
    toolEnvironment: new ToolEnvironment({ runtimes: [] }),
  }),
  providerRegistry: new ProviderRegistry([
    {
      providerProfileId: "fake",
      adapter: new FakeModel(),
      modelCatalog: new StaticModelCatalog([
        { id: "fake", isDefault: true, contextWindow: 32768 },
      ]),
    },
  ]),
  threadMetadata: metadata,
  threadSummaryProjection: projection,
  defaults: {
    cwd: root,
    providerProfileId: "fake",
    modelId: "fake",
    sandbox: "read-only",
    approvalPolicy: "always",
  },
});
const hostReadyMs = performance.now() - started;
global.gc?.();
const before = process.memoryUsage();
const queryStart = performance.now();
const summaries = await server.listThreadSummaries();
const sidebarMs = performance.now() - queryStart;
const counts = { journalReads, itemListReads };
assert.equal(await server.flushThreadSummaryProjection(10000), true);
global.gc?.();
const idle = process.memoryUsage();
const openStart = performance.now();
if (summaries[0]) await server.readThread(summaries[0].threadId);
const firstContentMs = performance.now() - openStart;
console.log(
  JSON.stringify({
    mode,
    hostReadyMs,
    sidebarMs,
    firstContentMs,
    summaries: summaries.length,
    jsonBytes: Buffer.byteLength(JSON.stringify(summaries)),
    ...counts,
    explicitOpenJournalReads: journalReads - counts.journalReads,
    heapDelta: idle.heapUsed - before.heapUsed,
    rss: idle.rss,
    maxRssKiB: process.resourceUsage().maxRSS,
    node: process.version,
    platform: process.platform,
    firstWindow: "not measured; Host-only benchmark",
  }),
);
await journal.close();
