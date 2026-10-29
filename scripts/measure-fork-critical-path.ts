/** Synthetic local durability benchmark. No Provider/tool dispatch or real user files.
 * Run: node --import tsx scripts/measure-fork-critical-path.ts [--side-chat]
 * Output: JSONL phase timings; not a claim about IPC, DOM paint or another device.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { FileTraceStore } from "../src/trace.js";
import { JsonlThreadMetadataStore } from "../src/thread-metadata.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import { projectNativeRecovery } from "../apps/zenx/src/renderer/src/thread-view-state.js";
import type { CanonicalItem } from "../src/item.js";

const sideChat = process.argv.includes("--side-chat");
const root = await mkdtemp(
  path.join(os.tmpdir(), "zen-synthetic-fork-timing-"),
);
const allResults: any[] = [];
type Span = { name: string; start: number; end: number; args: unknown[] };
let spans: Span[] = [];
function observe(object: any, name: string, label: string = name) {
  const original = object[name].bind(object);
  object[name] = async (...args: any[]) => {
    const start = performance.now();
    try {
      return await original(...args);
    } finally {
      spans.push({
        name: label,
        start,
        end: performance.now(),
        args: args.map((a) =>
          typeof a === "string"
            ? a
            : Array.isArray(a)
              ? `array:${a.length}`
              : (a?.threadId ?? "object"),
        ),
      });
    }
  };
}
function summary(from: number, to: number) {
  const selected = spans.filter((s) => s.start >= from && s.end <= to);
  const aggregate: any = {};
  for (const s of selected) {
    const a = (aggregate[s.name] ??= { count: 0, ms: 0 });
    a.count++;
    a.ms += s.end - s.start;
    aggregate[s.name] = a;
  }
  for (const a of Object.values(aggregate) as any[]) a.ms = +a.ms.toFixed(2);
  return { wallMs: +(to - from).toFixed(2), aggregate };
}
function fixture(count: number): CanonicalItem[] {
  const threadId = "synthetic-source",
    turnId = "synthetic-turn",
    createdAt = "2026-10-29T00:00:00.000Z";
  const base = { threadId, createdAt };
  const turn = { ...base, turnId };
  const items: CanonicalItem[] = [
    {
      ...base,
      id: "metadata",
      type: "thread_metadata",
      cwd: root,
      providerProfileId: "synthetic",
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    { ...turn, id: "start", type: "turn_started" },
    {
      ...turn,
      id: "user",
      type: "user_message",
      text: "Synthetic benchmark question",
    },
  ];
  let i = 0;
  while (items.length < count - 2) {
    i++;
    if (items.length < count - 3) {
      items.push(
        {
          ...turn,
          id: `call-${i}`,
          type: "tool_call",
          name: "synthetic_observe",
          callId: `call-${i}`,
          arguments: { index: i },
        },
        {
          ...turn,
          id: `result-${i}`,
          type: "tool_result",
          callId: `call-${i}`,
          output: `Synthetic output ${i}: ` + "x".repeat(1024),
          exitCode: 0,
        },
      );
    } else {
      items.push({
        ...turn,
        id: `reasoning-${i}`,
        type: "reasoning",
        text: "Synthetic reasoning",
        summary: "Synthetic reasoning",
      });
    }
  }
  items.push(
    {
      ...turn,
      id: "final",
      type: "agent_message",
      text: "Synthetic completed final response.",
    },
    { ...turn, id: "complete", type: "turn_completed", status: "completed" },
  );
  assert.equal(items.length, count);
  return items;
}
try {
  for (const count of [50, 500, 2000]) {
    const dir = path.join(root, String(count));
    const trace = new FileTraceStore(path.join(dir, "trace"));
    const metadata = new JsonlThreadMetadataStore(
      path.join(dir, "metadata.jsonl"),
    );
    const journal = new DomainThreadJournal({
      directory: path.join(dir, "threads"),
      trace,
      metadata,
    });
    for (const method of ["record", "recordBatch", "read", "listThreadIds"])
      observe(trace, method, `trace.${method}`);
    for (const method of [
      "create",
      "read",
      "readItemList",
      "listThreadIds",
      "assertRecoverySafe",
    ])
      observe(journal, method, `journal.${method}`);
    for (const method of ["read", "setName"])
      observe(metadata, method, `metadata.${method}`);
    let id = 0;
    const server = new ZenAppServer({
      journal,
      attachments: new InMemoryAttachmentStore(),
      threadMetadata: metadata,
      runtime: new AgentRuntime({
        toolEnvironment: new ToolEnvironment({
          runtimes: [],
          approvedTools: new Set(),
        }),
      }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "synthetic",
          adapter: {
            provider: "synthetic",
            async *stream() {
              throw Error("Model dispatch forbidden in benchmark");
            },
          },
          modelCatalog: new StaticModelCatalog([
            {
              id: "model",
              isDefault: true,
              contextWindow: 100000,
              inputModalities: ["text"],
            },
          ]),
        },
      ]),
      defaults: {
        cwd: root,
        providerProfileId: "synthetic",
        modelId: "model",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
      idFactory: () => `new-${++id}`,
    });
    const fixtureItems = fixture(count);
    const setupStart = performance.now();
    await journal.create(fixtureItems);
    await metadata.setName("synthetic-source", "Synthetic timing");
    const setupEnd = performance.now();
    const projection = new NativeRecoveryProjection(server);
    const sourceReadStart = performance.now();
    await server.readThread("synthetic-source");
    const sourceReadEnd = performance.now();
    const summariesStart = performance.now();
    await server.listThreadSummaries();
    const summariesEnd = performance.now();
    const sourceSnapshot = await server.readThread("synthetic-source");
    const forkStart = performance.now();
    const fork = sideChat
      ? await server.createChildThread({
          parentThreadId: "synthetic-source",
          mode: "side-chat",
          snapshot: {
            itemId: "complete",
            contextItemId: sourceSnapshot.itemList?.at(-1)?.id ?? null,
          },
        })
      : await server.forkThread({
          sourceThreadId: "synthetic-source",
          through: { type: "item", itemId: "final" },
          workspace: { type: "same-directory" },
        });
    const forkEnd = performance.now();
    const resumeStart = performance.now();
    const recovery = await projection.resume(fork.id);
    const resumed = recovery.thread;
    const resumeEnd = performance.now();
    assert.equal(
      resumed.items.filter((i) => i.type === "agent_message").at(-1)?.text,
      "Synthetic completed final response.",
    );
    const rendererStart = performance.now();
    const rendered = projectNativeRecovery(recovery);
    const rendererEnd = performance.now();
    assert.equal(rendered.id, fork.id);
    const serializedStart = performance.now();
    const forkJson = JSON.stringify({ thread: fork });
    const serializedEnd = performance.now();
    const result = {
      mode: sideChat ? "side-chat" : "exact-message-fork",
      count,
      canonicalBytes: Buffer.byteLength(JSON.stringify(fixtureItems)),
      setup: summary(setupStart, setupEnd),
      sourceServerColdJournalWarmLoad: summary(sourceReadStart, sourceReadEnd),
      summaryWarm: summary(summariesStart, summariesEnd),
      forkWarm: summary(forkStart, forkEnd),
      nativeResumeForkWarm: summary(resumeStart, resumeEnd),
      rendererProjectionMs: +(rendererEnd - rendererStart).toFixed(2),
      forkSerializationMs: +(serializedEnd - serializedStart).toFixed(2),
      forkResponseBytes: Buffer.byteLength(forkJson),
    };
    allResults.push(result);
    console.log(JSON.stringify(result));
    projection.close();
    await server.flushThreadSummaryProjection();
    await journal.close();
    spans = [];
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
