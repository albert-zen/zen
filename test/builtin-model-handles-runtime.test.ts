import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import { CodeRuntime, RunCodeToolRuntime } from "../src/code-runtime.js";
import { DomainThreadJournal } from "../src/domain-journal.js";
import { compileItemList, type ContextItem } from "../src/item-list.js";
import type { CanonicalItem } from "../src/item.js";
import { InMemoryThreadJournal, type ThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import {
  validateModelReferenceBindings,
  type ModelReferenceBinding,
} from "../src/model-references.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { FileTraceStore } from "../src/trace.js";
import { ToolEnvironment, type ToolExecutionResult } from "../src/tool.js";
import { testToolRuntime } from "./tool-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function server(
  model: ModelAdapter,
  tools: ToolEnvironment,
  options: {
    journal?: ThreadJournal;
    metadata?: InMemoryThreadMetadataStore;
    trace?: FileTraceStore;
    agentic?: boolean;
  } = {},
) {
  return new ZenAppServer({
    journal: options.journal ?? new InMemoryThreadJournal(),
    threadMetadata: options.metadata ?? new InMemoryThreadMetadataStore(),
    runtime: new AgentRuntime({
      toolEnvironment: tools,
      ...(options.trace ? { trace: options.trace } : {}),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "model", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    contextCompaction: { agenticEnabled: options.agentic ?? false },
  });
}
function references(items: readonly ContextItem[]): ModelReferenceBinding[] {
  return items.flatMap((item) =>
    item.source.metadata?.referenceBindings === undefined
      ? []
      : validateModelReferenceBindings(item.source.metadata.referenceBindings),
  );
}
const wire = (request: ModelRequest) =>
  JSON.stringify({ messages: request.messages, tools: request.tools });
const taskRefs = (request: ModelRequest) => [
  ...new Set(
    [...wire(request).matchAll(/task_id: (t[1-9][0-9]*)/gu)].map(
      (match) => match[1]!,
    ),
  ),
];

test("actual ModelRequest uses coarse retention without an index and preserves cold ItemList/log readback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-builtin-retention-"));
  const trace = new FileTraceStore(path.join(root, "trace"));
  const metadata = new InMemoryThreadMetadataStore();
  const journalOptions = {
    directory: path.join(root, "threads"),
    trace,
    metadata,
  };
  const journal = new DomainThreadJournal(journalOptions);
  const tools = new ToolEnvironment();
  const requests: Array<{
    messages: ModelRequest["messages"];
    tools: ModelRequest["tools"];
  }> = [];
  let samples = 0;
  const model: ModelAdapter = {
    provider: "builtin-retention",
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push({
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
      });
      assert.doesNotMatch(
        JSON.stringify(request.messages),
        /compact_context (?:optional )?retention references|c[1-9][0-9]* user message/u,
      );
      const accepted = await journal.readItemList(request.sessionId!);
      assert.equal(
        references(accepted).some(
          (entry) => entry.namespace === "builtin-compaction",
        ),
        false,
      );
      if (++samples === 2) {
        yield {
          type: "tool_call",
          callId: "provider-required-reset-id",
          name: "compact_context",
          arguments: {
            text: "Continue the exact task.",
            retention: { recentUserMessageCount: 2 },
          },
        };
      } else yield { type: "text_delta", delta: "done" };
    },
  };
  const app = server(model, tools, { journal, metadata, trace, agentic: true });
  try {
    const thread = await app.startThread();
    const literal =
      'Keep literal 12345678-1234-1234-1234-123456789abc and const path = "/tmp/raw-code.ts";';
    await (
      await app.startTurn(thread.id, literal)
    ).done;
    const before = await app.readThread(thread.id);
    const first = before.items.find((item) => item.type === "user_message")!;
    await (
      await app.startTurn(thread.id, "Compact but keep the first exact input.")
    ).done;
    const snapshot = await app.readThread(thread.id);
    const compaction = snapshot.items.find(
      (item) => item.type === "context_compaction",
    );
    assert.ok(compaction?.type === "context_compaction");
    assert.deepEqual(
      compaction.retainedItemIds,
      snapshot.items
        .filter((item) => item.type === "user_message")
        .map((item) => item.id),
    );
    assert.equal(
      compaction.coveredThroughItemId,
      snapshot.items.findLast((item) => item.type === "user_message")!.id,
    );
    assert.ok(
      JSON.stringify(requests[2]!.messages).includes(
        literal.replaceAll('"', '\\"'),
      ),
    );
    assert.ok(!JSON.stringify(requests[2]!.messages).includes(first.id));
    const resetCall = snapshot.items.find(
      (item) => item.type === "tool_call" && item.name === "compact_context",
    );
    assert.ok(resetCall?.type === "tool_call");
    assert.equal(
      resetCall.callId,
      "provider-required-reset-id",
      "API-required call IDs are not renamed",
    );
    assert.deepEqual(
      resetCall.arguments.retention,
      { recentUserMessageCount: 2 },
      "accepted model arguments are never rewritten",
    );
    const stored = await journal.readItemList(thread.id);
    assert.deepEqual(stored, snapshot.itemList);
    assert.equal(
      references(stored).some(
        (entry) => entry.namespace === "builtin-compaction",
      ),
      false,
    );
    const log = await trace.read(thread.id);
    assert.ok(
      log.records.some(
        (record) =>
          record.type === "runtime_item" &&
          (record.data as { item: CanonicalItem }).item.id === first.id &&
          JSON.stringify(record.data).includes(
            "12345678-1234-1234-1234-123456789abc",
          ),
      ),
    );
    const compiled = compileItemList(stored);
    await journal.close();
    const cold = new DomainThreadJournal(journalOptions);
    try {
      assert.deepEqual(
        compileItemList(await cold.readItemList(thread.id)),
        compiled,
      );
      assert.equal(
        samples,
        3,
        "cold read neither samples nor replays compaction",
      );
    } finally {
      await cold.close();
    }
  } finally {
    await tools.close();
    await journal.close();
    await app.closeRuntimeConfiguration();
    await rm(root, { recursive: true, force: true });
  }
});

test("actual yielded task ref is owner scoped and stale after restart without retargeting a new task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-builtin-task-"));
  const trace = new FileTraceStore(path.join(root, "trace"));
  const metadata = new InMemoryThreadMetadataStore();
  const journalOptions = {
    directory: path.join(root, "threads"),
    trace,
    metadata,
  };
  const journal = new DomainThreadJournal(journalOptions);
  const firstDone = deferred<ToolExecutionResult>();
  let executions = 0,
    firstRef = "",
    firstWire = "",
    samples = 0;
  const slow = testToolRuntime({
    name: "hold",
    executionMode: "parallel_safe",
    execute: async () => {
      executions++;
      return await firstDone.promise;
    },
  });
  const tools = new ToolEnvironment({
    runtimes: [slow],
    taskOptions: { yieldTimeMs: 1 },
  });
  const model: ModelAdapter = {
    provider: "builtin-task",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (++samples === 1)
        yield {
          type: "tool_call",
          callId: "initial-hold",
          name: "hold",
          arguments: {},
        };
      else {
        firstRef = taskRefs(request)[0] ?? "";
        firstWire = wire(request);
        assert.ok(
          references(await journal.readItemList(request.sessionId!)).some(
            (entry) => entry.ref === firstRef,
          ),
        );
        yield {
          type: "text_delta",
          delta: "leave the original task observable",
        };
      }
    },
  };
  const app = server(model, tools, { journal, metadata, trace });
  let cold: DomainThreadJournal | undefined;
  let freshTools: ToolEnvironment | undefined;
  try {
    const thread = await app.startThread();
    await (
      await app.startTurn(thread.id, "Start one task.")
    ).done;
    assert.equal(firstRef, "t1");
    const snapshot = await app.readThread(thread.id);
    const binding = references(snapshot.itemList!).find(
      (entry) => entry.ref === firstRef,
    )!;
    assert.ok(binding);
    const native = (binding.value as { taskId: string }).taskId;
    assert.notEqual(native, firstRef);
    assert.ok(
      !firstWire.includes(native),
      "native task UUID is not serialized into ModelRequest",
    );
    assert.ok(
      (await trace.read(thread.id)).records.some(
        (record) =>
          record.type === "runtime_item" &&
          (record.data as { item: CanonicalItem }).item.type ===
            "tool_result" &&
          JSON.stringify(record.data).includes(native),
      ),
      "native task identity remains exact in its accepted source fact",
    );
    assert.equal(
      (
        tools.taskManager.status(thread.id, native).structuredContent as {
          status: string;
        }
      ).status,
      "running",
    );
    const foreign = tools.prepare({
      callId: "foreign-wait",
      canonicalToolCallId: "foreign-source",
      name: "wait",
      arguments: { task_id: firstRef, yield_time_ms: 1 },
      cwd: os.tmpdir(),
      threadId: "foreign-thread",
      modelReferences: [binding],
      signal: new AbortController().signal,
    });
    await assert.rejects(tools.execute(foreign), /unavailable|not found/u);
    firstDone.resolve({ output: "original exact output", exitCode: 0 });
    await tools.close();
    await journal.close();
    cold = new DomainThreadJournal(journalOptions);
    const nextDone = deferred<ToolExecutionResult>();
    freshTools = new ToolEnvironment({
      runtimes: [
        testToolRuntime({
          name: "hold",
          executionMode: "parallel_safe",
          execute: async () => {
            executions++;
            return await nextDone.promise;
          },
        }),
      ],
      taskOptions: { yieldTimeMs: 1 },
    });
    let coldSamples = 0,
      nextRef = "";
    const coldModel: ModelAdapter = {
      provider: "builtin-task",
      async *stream(request): AsyncIterable<ModelEvent> {
        if (++coldSamples === 1)
          yield {
            type: "tool_call",
            callId: "new-hold",
            name: "hold",
            arguments: {},
          };
        else if (coldSamples === 2) {
          nextRef = taskRefs(request).at(-1) ?? "";
          nextDone.resolve({ output: "new exact output", exitCode: 0 });
          yield {
            type: "tool_call",
            callId: "stale-wait",
            name: "wait",
            arguments: { task_id: firstRef, yield_time_ms: 1 },
          };
          yield {
            type: "tool_call",
            callId: "new-wait",
            name: "wait",
            arguments: { task_id: nextRef, yield_time_ms: 100 },
          };
        } else yield { type: "text_delta", delta: "done" };
      },
    };
    const resumed = server(coldModel, freshTools, {
      journal: cold,
      metadata,
      trace,
    });
    await (
      await resumed.startTurn(
        thread.id,
        "Check old and new tasks without repeating either.",
      )
    ).done;
    const final = await resumed.readThread(thread.id);
    assert.equal(nextRef, "t2");
    const stale = final.items.find(
      (item) => item.type === "tool_result" && item.callId === "stale-wait",
    );
    const current = final.items.find(
      (item) => item.type === "tool_result" && item.callId === "new-wait",
    );
    assert.ok(stale?.type === "tool_result" && stale.exitCode !== 0);
    assert.ok(
      current?.type === "tool_result" &&
        current.exitCode === 0 &&
        current.output.includes("new exact output"),
    );
    assert.equal(
      executions,
      2,
      "neither stale wait nor restart replays task execution",
    );
    await resumed.closeRuntimeConfiguration();
  } finally {
    firstDone.resolve({ output: "cleanup", exitCode: 0 });
    await freshTools?.close();
    await tools.close();
    await cold?.close();
    await journal.close();
    await app.closeRuntimeConfiguration();
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled Worker parallel children retain distinct observable t refs in the next actual ModelRequest", async () => {
  const releases = [
    deferred<ToolExecutionResult>(),
    deferred<ToolExecutionResult>(),
  ];
  const started: number[] = [];
  const tools = new ToolEnvironment({
    runtimes: [
      new RunCodeToolRuntime(new CodeRuntime({ wallTimeMs: 1000 })),
      testToolRuntime({
        name: "hold",
        executionMode: "parallel_safe",
        execute: async (invocation) => {
          const index = Number(invocation.arguments.index);
          started.push(index);
          return await releases[index]!.promise;
        },
      }),
    ],
    taskOptions: { yieldTimeMs: 10000 },
  });
  let samples = 0;
  const observed: string[] = [];
  let secondWire = "";
  const model: ModelAdapter = {
    provider: "builtin-worker",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (++samples === 1)
        yield {
          type: "tool_call",
          callId: "outer-code-call",
          name: "run_code",
          arguments: {
            code: "await Promise.all([tools.hold({index:0}), tools.hold({index:1})]);",
          },
        };
      else if (samples === 2) {
        observed.push(...taskRefs(request));
        secondWire = wire(request);
        for (const [index, release] of releases.entries())
          release.resolve({ output: `exact child ${index}`, exitCode: 0 });
        for (const [index, ref] of observed.entries())
          yield {
            type: "tool_call",
            callId: `observe-child-${index}`,
            name: "wait",
            arguments: { task_id: ref, yield_time_ms: 100 },
          };
      } else yield { type: "text_delta", delta: "done" };
    },
  };
  const app = server(model, tools);
  try {
    const thread = await app.startThread();
    await (
      await app.startTurn(thread.id, "Run two independent children.")
    ).done;
    assert.deepEqual(started.sort(), [0, 1]);
    assert.equal(
      observed.length,
      2,
      "both live nested handles must reach the sole semantic compiler",
    );
    assert.equal(new Set(observed).size, 2);
    assert.ok(observed.every((ref) => /^t[1-9][0-9]*$/u.test(ref)));
    const snapshot = await app.readThread(thread.id);
    const children = snapshot.items.filter(
      (item) =>
        item.type === "tool_call" && item.parentCallId === "outer-code-call",
    );
    assert.equal(children.length, 2);
    for (const child of children) {
      assert.ok(child.type === "tool_call");
      assert.ok(
        !secondWire.includes(child.callId),
        "nested call IDs are not model handle labels",
      );
    }
    for (const binding of references(snapshot.itemList!)) {
      if (!observed.includes(binding.ref)) continue;
      assert.ok(
        !secondWire.includes((binding.value as { taskId: string }).taskId),
      );
    }
    assert.equal(new Set(children.map((item) => item.id)).size, 2);
    assert.ok(
      children.every(
        (item) =>
          !snapshot.itemList!.some((semantic) => semantic.id === item.id),
      ),
      "nested calls remain facts, not fake model-context Items",
    );
    const results = snapshot.items.filter(
      (item) =>
        item.type === "tool_result" && item.callId.startsWith("observe-child-"),
    );
    assert.equal(results.length, 2);
    assert.ok(
      results.every(
        (item) => item.type === "tool_result" && item.exitCode === 0,
      ),
    );
    assert.equal(started.length, 2);
  } finally {
    for (const release of releases)
      release.resolve({ output: "cleanup", exitCode: 0 });
    await tools.close();
    await app.closeRuntimeConfiguration();
  }
});
