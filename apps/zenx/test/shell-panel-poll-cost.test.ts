import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { ZenAppServer } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { InMemoryThreadSummaryProjection } from "../../../src/thread-summary.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { FakeModel } from "../../../src/model.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { Thread } from "../../../src/thread.js";
import { ShellToolRuntime, ToolEnvironment } from "../../../src/tool.js";
import { ShellPanelService } from "../src/main/shell-panel-service.js";
import { shellListing } from "../src/renderer/src/background-shell-state.js";

test("40 list/read cycles over 12000 historical messages do not reconstruct history or write projections", async (context) => {
  const journal = new InMemoryThreadJournal();
  const metadata = new InMemoryThreadMetadataStore();
  const projection = new InMemoryThreadSummaryProjection();
  const tools = new ToolEnvironment({
    runtimes: [new ShellToolRuntime()],
    taskOptions: { yieldTimeMs: 5 },
  });
  const makeApp = () =>
    new ZenAppServer({
      journal,
      threadMetadata: metadata,
      threadSummaryProjection: projection,
      runtime: new AgentRuntime({ toolEnvironment: tools }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: "fake",
          adapter: new FakeModel(),
          modelCatalog: new StaticModelCatalog([
            { id: "fake", isDefault: true, contextWindow: 32768 },
          ]),
        },
      ]),
      defaults: {
        cwd: process.cwd(),
        providerProfileId: "fake",
        modelId: "fake",
        reasoningEffort: null,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
  const bootstrap = makeApp();
  const thread = await bootstrap.startThread();
  const at = "2026-10-29T00:00:00.000Z";
  for (let index = 0; index < 12000; index++)
    await journal.append({
      id: `synthetic-${index}`,
      threadId: thread.id,
      turnId: "past",
      createdAt: at,
      type: "agent_message",
      text: `Synthetic historical message ${index}. ${"Bounded fixture text. ".repeat(10)}`,
    });
  await bootstrap.closeRuntimeConfiguration();
  const app = makeApp();
  const service = new ShellPanelService(app, tools);
  const originals = new Map<string, PropertyDescriptor>();
  const counters: Record<string, number> = {
    journalRead: 0,
    journalList: 0,
    journalWrite: 0,
    metadataRead: 0,
    projectionLoad: 0,
    projectionWrite: 0,
    items: 0,
    itemList: 0,
    deriveTurns: 0,
    configuration: 0,
    fullSnapshot: 0,
  };
  const wrap = (object: any, name: string, key: string) => {
    const original = object[name].bind(object);
    object[name] = (...args: unknown[]) => {
      counters[key] = (counters[key] ?? 0) + 1;
      return original(...args);
    };
  };
  try {
    const result = await tools.execute(
      tools.prepare({
        name: "shell",
        callId: "synthetic-poll-command",
        threadId: thread.id,
        cwd: process.cwd(),
        arguments: {
          command: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},30000)"`,
        },
        signal: new AbortController().signal,
      }),
    );
    const taskId = (result.structuredContent as { task_id: string }).task_id;
    await app.readThreadSummary(thread.id);
    assert.equal(await app.flushThreadSummaryProjection(), true);
    for (const [object, name, key] of [
      [journal, "read", "journalRead"],
      [journal, "listThreadIds", "journalList"],
      [journal, "append", "journalWrite"],
      [metadata, "read", "metadataRead"],
      [projection, "load", "projectionLoad"],
      [projection, "replace", "projectionWrite"],
      [app, "readThread", "fullSnapshot"],
    ] as const)
      wrap(object, name, key);
    for (const name of [
      "items",
      "itemList",
      "deriveTurns",
      "effectiveConfiguration",
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(
        Thread.prototype,
        name,
      )!;
      originals.set(name, descriptor);
      const key = name === "effectiveConfiguration" ? "configuration" : name;
      Object.defineProperty(
        Thread.prototype,
        name,
        descriptor.get
          ? {
              ...descriptor,
              get() {
                counters[key] = (counters[key] ?? 0) + 1;
                return descriptor.get!.call(this);
              },
            }
          : {
              ...descriptor,
              value: function (...args: unknown[]) {
                counters[key] = (counters[key] ?? 0) + 1;
                return descriptor.value.apply(this, args);
              },
            },
      );
    }
    const started = performance.now();
    for (let index = 0; index < 40; index++) {
      const listing = shellListing(
        await service.request({ operation: "list", threadId: thread.id }),
        thread.id,
      );
      assert.equal(listing.sessions[0]?.taskId, taskId);
      await service.request({ operation: "read", threadId: thread.id, taskId });
    }
    const elapsedMs = performance.now() - started;
    assert.deepEqual(
      counters,
      Object.fromEntries(Object.keys(counters).map((key) => [key, 0])),
    );
    context.diagnostic(
      JSON.stringify({
        historicalMessages: 12000,
        cycles: 40,
        operations: 80,
        elapsedMs: Math.round(elapsedMs * 1000) / 1000,
        counters,
      }),
    );
    await app.setThreadPermissions(thread.id, "read-only");
    const changed = shellListing(
      await service.request({ operation: "list", threadId: thread.id }),
      thread.id,
    );
    assert.equal(changed.canCreate, false);
    assert.equal(changed.restriction, "sandbox");
    await assert.rejects(app.readThreadSummary("missing"), /Unknown thread/);
  } finally {
    for (const [name, descriptor] of originals)
      Object.defineProperty(Thread.prototype, name, descriptor);
    await tools.close();
    await app.closeRuntimeConfiguration();
  }
});
